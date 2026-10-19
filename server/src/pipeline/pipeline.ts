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
import { AudioClock } from "./audio-clock";
import { PauseDetector } from "./pause";
import { CommitGate, DEFAULT_COMMIT, type CommitConfig, type Segment } from "./commit";

/** Réglages de l'administration relus en cours de séance. */
export interface PipelineTuning {
  commit: Partial<CommitConfig>;
  /** Segments précédents fournis au traducteur pour la continuité. */
  contextSegments: number;
  /** Vitesse de base de la voix ; le rattrapage de la dérive s'y multiplie. */
  baseSpeed: number;
  /** Seuil de parole de l'administration (dBFS) : en dessous, le formateur se tait. */
  speechThresholdDb: number;
}

export interface PipelineConfig {
  srcLang: Lang;
  targetLangs: Lang[];
  sampleRate: number;
  tuning?: () => PipelineTuning;
}

const DEFAULT_TUNING: PipelineTuning = { commit: {}, contextSegments: 2, baseSpeed: 1, speechThresholdDb: -35 };
/**
 * Silence du formateur au-delà duquel on demande au STT de clore le tour en cours (D22) :
 * une phrase longue part en morceaux, chacun livré ~0,3 s après son dernier mot, au lieu
 * d'attendre le délai de coupe (~2 s). Les silences entre deux mots durent moins de 150 ms ;
 * 200 et 300 ms ont donné le même découpage sur la fixture.
 */
const FORCE_PAUSE_MS = 250;
/** Le texte définitif arrive 0,17 à 0,55 s après la commande (mesuré) : le délai de coupe l'attend. */
const FORCE_HOLD_MS = 1000;
/** Parole minimale depuis la dernière coupe avant d'en demander une autre : ~4 mots. */
const MIN_SPEECH_MS = 1200;
/** Cadence à laquelle on demande aux fournisseurs s'ils ont besoin d'être réchauffés (D20). */
const WARM_EVERY_MS = 5000;
/**
 * Silence entre deux segments au-delà duquel le second ouvre une nouvelle prise de parole :
 * la salle n'entend plus rien, et ce qui compte est le temps avant le premier son.
 */
const TURN_GAP_MS = 1500;

export interface PipelineEvents extends Record<string, unknown> {
  "src.partial": { text: string };
  "src.commit": {
    seq: number;
    text: string;
    tOrigin: number;
    tEnd: number;
    /** Début prononcé du premier mot (horloge serveur). */
    tStart: number;
    /** Premier segment d'une prise de parole. */
    turnStart: boolean;
    reason: string;
    confidence?: number;
    /** Flux STT qui a reconnu le segment, et ses mots datés dans ce flux (enregistreur). */
    stream: number;
    words: Word[];
  };
  /** Le micro du formateur démarre ou s'arrête. */
  mic: { on: boolean };
  /** Un flux STT vient de s'ouvrir : ses horodatages partent de la prochaine trame. */
  "stt.stream": { stream: number };
  /** Une trame transmise au STT, telle quelle. */
  "stt.audio": { pcm: Uint8Array };
  "tr.segment": { seq: number; lang: Lang; text: string; srcSeq: number; untranslated?: boolean };
  audio: { seq: number; lang: Lang; mime: string; durMs: number; tOrigin: number; srcSeq: number; text: string; bytes: Uint8Array; voice?: string };
  degraded: { mode: DegradedMode; reason: string };
  status: PipelineStatus;
  error: { stage: "stt" | "mt" | "tts"; error: Error };
}

export class Pipeline extends TypedEmitter<PipelineEvents> {
  private gate: CommitGate;
  /** Relie les horodatages de mots du STT à l'heure où le formateur les a prononcés. */
  private clock: AudioClock;
  /** Silences du formateur : le moment où clore un tour sans couper un mot (D22). */
  private pause: PauseDetector;
  /** La pause en cours a déjà servi à clore un tour. */
  private forcedThisPause = false;
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
  /** Flux STT ouverts depuis le lancement : chacun a ses propres horodatages. */
  private streams = 0;
  /** Fin prononcée du segment précédent, depuis le démarrage du micro. */
  private prevEnd?: number;

  constructor(
    private readonly providers: Providers,
    private readonly cfg: PipelineConfig,
    private readonly metrics: Metrics,
  ) {
    super();
    this.clock = new AudioClock(cfg.sampleRate);
    this.pause = new PauseDetector(cfg.sampleRate);
    this.gate = new CommitGate(this.commitConfig(), undefined, { spokenAt: (ms) => this.clock.spokenAt(ms) });
  }

  private get tuning(): PipelineTuning {
    return this.cfg.tuning?.() ?? DEFAULT_TUNING;
  }

  /** Segmentation de l'administration ; un fournisseur qui marque ses mots définitifs se passe de l'accord. */
  private commitConfig(): CommitConfig {
    return { ...DEFAULT_COMMIT, ...this.tuning.commit, agreement: !this.providers.stt.finalWords };
  }

  /** L'administration a changé la segmentation : prise en compte dès le prochain mot. */
  retune(): void {
    this.gate.configure(this.commitConfig());
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
    this.prevEnd = undefined;
    this.metrics.micReset();
    this.emit("mic", { on: true });
    // Les connexions vers la traduction et la voix s'ouvrent pendant que le STT se connecte,
    // et restent chaudes pendant les pauses du formateur (D20).
    this.warmProviders(true);
    this.warmTimer = setInterval(() => this.warmProviders(false), WARM_EVERY_MS);
    await this.openStt();
    this.tickTimer = setInterval(() => this.handle(this.gate.tick()), 100);
    this.emitStatus();
  }

  private warmTimer?: NodeJS.Timeout;

  /** Chaque fournisseur ne réchauffe que s'il est resté inactif (ou toujours, avec `force`). */
  private warmProviders(force: boolean) {
    void this.providers.mt.warm?.(force).catch(() => {});
    void this.providers.tts.warm?.(force).catch(() => {});
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const s = this.stt;
    this.stt = undefined;
    // Ce qui restait de la dernière phrase part ; le prochain démarrage du micro repart de
    // zéro, sans hériter des mots (ni de leurs instants) de cette prise.
    this.handle(this.gate.onUtteranceEnd());
    await s?.close();
    this.emit("mic", { on: false });
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
          if (this.stt !== stream) return;
          this.handle(this.gate.onUtteranceEnd());
          // Le STT a clos le tour de lui-même : la parole se recompte à partir d'ici.
          this.pause.cut();
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
    // Nouveau flux : ses horodatages repartent de zéro avec la première trame qu'il reçoit.
    this.clock.reset();
    this.pause.reset();
    this.gate.newStream();
    this.stt = stream;
    this.emit("stt.stream", { stream: ++this.streams });
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
    this.emit("stt.audio", { pcm });
    this.clock.push(pcm.byteLength, this.audio.lastAt);
    this.endTurnOnPause(pcm);
  }

  /**
   * Pendant une pause du formateur, après au moins ~4 mots de parole depuis la dernière coupe,
   * on demande au STT de clore le tour : ces mots partent aussitôt, au lieu d'attendre le délai
   * de coupe. Une fois par pause.
   */
  private endTurnOnPause(pcm: Uint8Array) {
    const silentMs = this.pause.push(pcm, this.tuning.speechThresholdDb);
    if (silentMs === 0) {
      this.forcedThisPause = false;
      return;
    }
    if (this.forcedThisPause || silentMs < FORCE_PAUSE_MS || !this.stt?.forceEndpoint) return;
    const speechMs = this.pause.speechSinceCut;
    if (speechMs < MIN_SPEECH_MS) return;
    this.forcedThisPause = true;
    this.pause.cut();
    this.gate.holdTimeout(FORCE_HOLD_MS);
    this.stt.forceEndpoint();
    this.metrics.event("endpoint", { speechMs: Math.round(speechMs), words: this.gate.unsentCount, silentMs: Math.round(silentMs) });
  }

  get sttOpen(): boolean {
    return Boolean(this.stt);
  }

  /**
   * Audio en attente d'envoi vers le STT (ms). Au-delà d'une seconde, la connexion montante
   * du poste ne suit plus : la reconnaissance reçoit la parole en retard, quoi qu'il arrive
   * ensuite chez le fournisseur.
   */
  get sttBacklogMs(): number {
    const bytes = this.stt?.backlogBytes?.() ?? 0;
    return Math.round((bytes / 2 / this.cfg.sampleRate) * 1000);
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
    // Confiance moyenne du moteur de reconnaissance sur les mots du segment, s'il la donne.
    const conf = seg.words.map((w) => w.confidence).filter((c): c is number => typeof c === "number");
    const confidence = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : undefined;
    // Le formateur se taisait avant ce segment : il ouvre une prise de parole.
    const gapMs = this.prevEnd != null ? seg.tStart - this.prevEnd : null;
    const turnStart = gapMs == null || gapMs > TURN_GAP_MS;
    this.prevEnd = Math.max(this.prevEnd ?? 0, seg.tEnd);
    this.emit("src.commit", {
      seq,
      text: seg.text,
      tOrigin: seg.tOrigin,
      tEnd: seg.tEnd,
      tStart: seg.tStart,
      turnStart,
      reason: seg.reason,
      confidence,
      stream: this.streams,
      words: seg.words,
    });
    this.metrics.stage("commit", tCommit - seg.tOrigin);
    // Fin prononcée → segment figé : la part de la reconnaissance dans la latence de D19.
    this.metrics.stage("endCommit", tCommit - seg.tEnd);
    this.metrics.segmentEnd(seq, { tOrigin: seg.tOrigin, tEnd: seg.tEnd, tStart: seg.tStart, turnStart });
    // Retard d'affichage du STT : du premier mot prononcé à sa première apparition.
    const first = seg.words[0]?.endMs;
    const firstSpoken = first != null ? this.clock.spokenAt(first) : undefined;
    const sttLagMs = firstSpoken != null ? seg.tOrigin - firstSpoken : null;
    if (sttLagMs != null) this.metrics.stage("sttLag", sttLagMs);
    this.metrics.event("commit", {
      sttLagMs,
      seq,
      tOrigin: seg.tOrigin,
      commitMs: tCommit - seg.tOrigin,
      tEnd: seg.tEnd,
      endCommitMs: tCommit - seg.tEnd,
      tEndExact: seg.tEndExact,
      tStart: seg.tStart,
      turnStart,
      gapMs,
      words: seg.words.length,
      reason: seg.reason,
      confidence: confidence != null ? Math.round(confidence * 1000) / 1000 : null,
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
      });
    } catch (error) {
      this.emit("error", { stage: "mt", error: error as Error });
      // Mieux vaut le texte source à l'écran que rien : pas de voix pour ce segment.
      this.emit("tr.segment", { seq, lang, text: seg.text, srcSeq: seq, untranslated: true });
      this.setDegraded("text-only", `traduction indisponible — ${(error as Error).message.slice(0, 200)}`);
      return;
    }
    const tMt = Date.now();
    this.metrics.stage("mt", tMt - t0);
    this.emit("tr.segment", { seq, lang, text, srcSeq: seq });

    ctx.push({ src: seg.text, tgt: text });
    const keep = this.tuning.contextSegments;
    while (ctx.length > keep) ctx.shift();
    this.context.set(lang, ctx);

    try {
      const queueMs = this.metrics.snapshot().queueP50Ms;
      const drift = this.speedForQueue(queueMs);
      if (drift !== this.speed) {
        this.speed = drift;
        this.metrics.event("speed", { speed: drift, queueMs });
        this.emitStatus();
      }
      // La vitesse choisie par l'administration, et le rattrapage de la dérive par-dessus.
      const speed = Math.min(1.2, Math.max(0.7, this.tuning.baseSpeed * drift));
      const a = await this.providers.tts.synthesize({ text, lang, speed, continuation: true });
      const tTts = Date.now();
      this.metrics.stage("tts", tTts - tMt);
      this.emit("audio", { seq, lang, mime: a.mime, durMs: a.durMs, tOrigin: seg.tOrigin, srcSeq: seq, text, bytes: a.audio, voice: a.voice });
      this.metrics.event("segment", {
        seq,
        lang,
        tOrigin: seg.tOrigin,
        mtMs: tMt - t0,
        ttsMs: tTts - tMt,
        readyMs: tTts - seg.tOrigin,
        endReadyMs: tTts - seg.tEnd,
        durMs: a.durMs,
        chars: text.length,
        speed,
        voice: a.voice ?? null,
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
