/**
 * Orchestration : audio → STT → commit → traduction → TTS, une fois par langue cible.
 *
 * Par langue, les segments sont traités en série (une chaîne de promesses) : l'ordre
 * de diffusion est garanti, et un retard se voit immédiatement dans `backlog` au lieu
 * de se cacher dans de la concurrence. C'est aussi une contre-pression naturelle.
 */
import type { DegradedMode, Lang, PipelineStatus } from "../../../shared/protocol";
import type { Metrics } from "../metrics";
import type { Providers, SttStream, Word } from "../providers/types";
import { TypedEmitter } from "../util/emitter";
import { CommitGate, DEFAULT_COMMIT, type CommitConfig, type Segment } from "./commit";

export interface PipelineConfig {
  srcLang: Lang;
  targetLangs: Lang[];
  sampleRate: number;
  commit?: Partial<CommitConfig>;
  glossary?: Record<string, string>;
  /** Segments précédents fournis au traducteur pour la continuité. */
  contextSegments?: number;
}

export interface PipelineEvents extends Record<string, unknown> {
  "src.partial": { text: string };
  "src.commit": { seq: number; text: string; tOrigin: number; reason: string };
  "tr.segment": { seq: number; lang: Lang; text: string; srcSeq: number; untranslated?: boolean };
  audio: { seq: number; lang: Lang; mime: string; durMs: number; tOrigin: number; srcSeq: number; text: string; bytes: Uint8Array };
  degraded: { mode: DegradedMode; reason: string };
  status: PipelineStatus;
  error: { stage: "stt" | "mt" | "tts"; error: Error };
}

export class Pipeline extends TypedEmitter<PipelineEvents> {
  private gate: CommitGate;
  private stt?: SttStream;
  private seq = 0;
  private muted = false;
  private tickTimer?: NodeJS.Timeout;
  private chains = new Map<Lang, Promise<void>>();
  private context = new Map<Lang, { src: string; tgt: string }[]>();
  private backlog = 0;
  private degraded: DegradedMode = "none";
  private degradedReason = "";
  private started = false;
  private speed = 1;

  constructor(
    private readonly providers: Providers,
    private readonly cfg: PipelineConfig,
    private readonly metrics: Metrics,
  ) {
    super();
    this.gate = new CommitGate({ ...DEFAULT_COMMIT, ...cfg.commit });
  }

  get status(): PipelineStatus {
    return {
      stt: this.providers.stt.name,
      mt: this.providers.mt.name,
      tts: this.providers.tts.name,
      backlog: this.backlog,
      muted: this.muted,
      degraded: this.degraded,
      speed: this.speed,
    };
  }

  /**
   * Rattrapage de la dérive (§09 de la revue). La langue cible est plus longue que la
   * source ; sans parade, la file des clients grandit dès que l'orateur ne fait pas de
   * pause. Quand la file médiane mesurée dans les acks s'allonge, la voix accélère :
   * inaudible sous 1,15, temporaire au-delà. Le plafond dur (8 s, côté client) reste
   * le dernier recours.
   */
  private speedForQueue(queueMs: number | null): number {
    if (queueMs == null || queueMs < 2000) return 1;
    if (queueMs < 4000) return 1.08;
    if (queueMs < 6000) return 1.15;
    return 1.25;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.metrics.micReset();
    await this.openStt();
    this.tickTimer = setInterval(() => this.handle(this.gate.tick()), 100);
    this.emitStatus();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const s = this.stt;
    this.stt = undefined;
    await s?.close();
    this.emitStatus();
  }

  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;

  private async openStt(): Promise<void> {
    const stream = await this.providers.stt.start(
      { lang: this.cfg.srcLang, sampleRate: this.cfg.sampleRate },
      {
        onPartial: (p) => {
          if (this.stt !== stream) return; // session remplacée
          if (p.isFinal) {
            this.handle(this.gate.onFinal(p.words));
          } else {
            const r = this.gate.onPartial(p.words);
            this.emit("src.partial", { text: r.hypothesis });
            this.handle(r.segments);
          }
        },
        onUtteranceEnd: () => {
          if (this.stt === stream) this.handle(this.gate.onUtteranceEnd());
        },
        onDiscard: () => {
          if (this.stt !== stream) return;
          this.gate.discard();
          this.emit("src.partial", { text: "" });
        },
        onError: (error) => {
          this.emit("error", { stage: "stt", error });
          if (this.stt !== stream) return;
          // Session STT perdue : on le dit à la salle, et on rouvre avec un léger recul.
          this.stt = undefined;
          this.handle(this.gate.onUtteranceEnd());
          this.setDegraded("stt-lost", `reconnaissance vocale interrompue — ${error.message.slice(0, 160)}`);
          this.scheduleSttRestart();
        },
      },
    );
    this.stt = stream;
    this.restartAttempts = 0;
    if (this.degraded === "stt-lost") this.setDegraded("none", "reconnaissance vocale rétablie");
  }

  private scheduleSttRestart() {
    if (!this.started || this.restartTimer) return;
    const delay = Math.min(10_000, 1000 * 2 ** this.restartAttempts++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.started) return;
      this.openStt().catch((error: Error) => {
        this.emit("error", { stage: "stt", error });
        this.scheduleSttRestart();
      });
    }, delay);
  }

  /** Compteurs de diagnostic : trames reçues du formateur, transmises au STT, dernière réception. */
  readonly audio = { received: 0, forwarded: 0, bytes: 0, lastAt: 0 };

  pushAudio(pcm: Uint8Array): void {
    this.audio.received++;
    this.audio.bytes += pcm.byteLength;
    this.audio.lastAt = Date.now();
    if (this.muted || !this.stt) return;
    this.audio.forwarded++;
    this.metrics.audio(pcm);
    this.stt.sendAudio(pcm);
  }

  get sttOpen(): boolean {
    return Boolean(this.stt);
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.emitStatus();
  }

  /** Signalement externe (ex. bascule du TTS de secours). */
  reportDegraded(mode: DegradedMode, reason: string): void {
    this.setDegraded(mode, reason);
  }

  // ---------------------------------------------------------------------------

  private handle(segments: Segment[]) {
    for (const s of segments) this.dispatch(s);
  }

  private dispatch(seg: Segment) {
    const seq = ++this.seq;
    const tCommit = Date.now();
    this.emit("src.commit", { seq, text: seg.text, tOrigin: seg.tOrigin, reason: seg.reason });
    this.metrics.event("commit", {
      seq,
      tOrigin: seg.tOrigin,
      commitMs: tCommit - seg.tOrigin,
      words: seg.words.length,
      reason: seg.reason,
    });

    for (const lang of this.cfg.targetLangs) {
      this.backlog++;
      const prev = this.chains.get(lang) ?? Promise.resolve();
      const next = prev
        .then(() => this.process(seq, seg, lang))
        .catch((error: Error) => this.emit("error", { stage: "mt", error }))
        .finally(() => {
          this.backlog--;
          this.emitStatus();
        });
      this.chains.set(lang, next);
    }
    this.emitStatus();
  }

  private async process(seq: number, seg: Segment, lang: Lang) {
    const ctx = this.context.get(lang) ?? [];
    const t0 = Date.now();

    let text: string;
    try {
      text = await this.providers.mt.translate({
        text: seg.text,
        from: this.cfg.srcLang,
        to: lang,
        context: ctx,
        glossary: this.cfg.glossary,
      });
    } catch (error) {
      this.emit("error", { stage: "mt", error: error as Error });
      // Mieux vaut le texte source à l'écran que rien : pas de voix pour ce segment.
      this.emit("tr.segment", { seq, lang, text: seg.text, srcSeq: seq, untranslated: true });
      this.setDegraded("text-only", `traduction indisponible — ${(error as Error).message.slice(0, 200)}`);
      return;
    }
    const tMt = Date.now();
    this.emit("tr.segment", { seq, lang, text, srcSeq: seq });

    ctx.push({ src: seg.text, tgt: text });
    const keep = this.cfg.contextSegments ?? 2;
    while (ctx.length > keep) ctx.shift();
    this.context.set(lang, ctx);

    try {
      const queueMs = this.metrics.snapshot().queueP50Ms;
      const speed = this.speedForQueue(queueMs);
      if (speed !== this.speed) {
        this.speed = speed;
        this.metrics.event("speed", { speed, queueMs });
        this.emitStatus();
      }
      const a = await this.providers.tts.synthesize({ text, lang, speed, continuation: true });
      const tTts = Date.now();
      this.emit("audio", { seq, lang, mime: a.mime, durMs: a.durMs, tOrigin: seg.tOrigin, srcSeq: seq, text, bytes: a.audio });
      this.metrics.event("segment", {
        seq,
        lang,
        tOrigin: seg.tOrigin,
        mtMs: tMt - t0,
        ttsMs: tTts - tMt,
        readyMs: tTts - seg.tOrigin,
        durMs: a.durMs,
        chars: text.length,
        speed,
        queueMs,
      });
      if (this.degraded === "text-only") this.setDegraded("none", "synthèse rétablie");
    } catch (error) {
      this.emit("error", { stage: "tts", error: error as Error });
      // Le motif réel doit arriver jusqu'au tableau de bord : un 402 ne se devine pas.
      this.setDegraded("text-only", `synthèse vocale indisponible — ${(error as Error).message.slice(0, 200)}`);
    }
  }

  private setDegraded(mode: DegradedMode, reason: string) {
    if (this.degraded === mode && this.degradedReason === reason) return;
    this.degraded = mode;
    this.degradedReason = reason;
    this.emit("degraded", { mode, reason });
    this.metrics.event("degraded", { mode, reason });
    this.emitStatus();
  }

  private emitStatus() {
    this.emit("status", this.status);
  }
}

export type { Word };
