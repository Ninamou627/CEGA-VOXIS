/**
 * Journal JSONL (une ligne par événement, rejouable) + fenêtres glissantes pour le
 * tableau de bord. La mesure bout-en-bout est prise à la réception de l'ack : le
 * client n'a pas besoin d'horloge synchronisée, et l'erreur est bornée par un aller
 * simple sur le LAN (~10–30 ms), toujours dans le sens d'une surestimation.
 *
 * Deux latences, deux points de départ (D19) :
 *   - `end` : de la fin prononcée du segment au début de son écoute. C'est l'objectif du
 *     projet (moins d'une seconde) : ce que le système ajoute une fois la phrase dite.
 *   - `e2e` : du premier mot reconnu du segment au début de son écoute. Il contient en plus
 *     le temps que le formateur met à dire le segment.
 *   - `start` : du début prononcé du premier mot au début de l'écoute. C'est le décalage que
 *     l'apprenant ressent : `e2e`, plus le retard d'affichage du STT et la durée du premier mot.
 *     Compté à part pour le premier segment d'une prise de parole (`first`) : le formateur
 *     commence à parler, combien de temps avant que la salle entende quelque chose ?
 *
 * Indicateurs de premier rang depuis D41 (audit F-12), calculés à chaque ack : le décalage par
 * mot (début prononcé d'un mot → début de son écoute, estimé — voir `wordLags`), le retard
 * maximal et la pente du retard sur dix minutes. `end` (D19) reste un indicateur d'étage.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import type { Lang } from "../../shared/protocol";
import { OUTAGE_MODES, slope, wordLags } from "./latency-report";

const WINDOW_MS = 60_000;
/** Une prise de parole commence quelques fois par minute : sa fenêtre est plus longue. */
const FIRST_WINDOW_MS = 300_000;
/** Segments dont on garde la fin prononcée, le temps que leurs acks arrivent. */
const KEEP_SEGMENTS = 500;
/** Retard maximal et pente du retard : dix minutes, le temps de voir une dérive (D41). */
const LAG_WINDOW_MS = 600_000;
/** Sous 3 minutes de mesures, la pente ne dit rien (essai 8 rejoué : ± 1 s/min sur 1,5 min). */
const SLOPE_MIN_SPAN_MIN = 3;
/** Files signalées par les téléphones prises en compte par le contrôleur de retard (D42). */
const QUEUE_RECENT_MS = 20_000;

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/**
 * Étages : `commit` va de la première apparition d'un mot au segment figé, `endCommit` de
 * la fin prononcée du segment au segment figé (la part de la reconnaissance dans `end`).
 */
export type StageName = "commit" | "endCommit" | "mt" | "tts" | "sttLag";

export interface AckLatency {
  /** Premier mot reconnu → début d'écoute. */
  e2eMs: number;
  /** Fin prononcée → début d'écoute ; null si le segment n'est plus connu (redémarrage). */
  endMs: number | null;
  /** Début prononcé → début d'écoute ; null si le segment n'est plus connu. */
  startMs: number | null;
  /**
   * Décalage par mot de cette écoute (D41) : moyenne, maximum, somme et nombre de mots ; `outage`
   * si le segment a traversé une panne. Null si le segment ou la durée de sa voix n'est plus connu.
   */
  wordLag: { mean: number; max: number; sum: number; n: number; outage: boolean; lags: number[] } | null;
}

/** Ce qu'on retient d'un segment figé, le temps que ses acks arrivent. */
export interface SegmentTimes {
  tOrigin: number;
  tEnd: number;
  tStart: number;
  /** Premier segment d'une prise de parole (le formateur se taisait avant). */
  turnStart: boolean;
  /** Nombre de mots, et début de chacun depuis le début du segment si le STT les date (D41). */
  words?: number;
  wordStarts?: number[] | null;
}

export class Metrics {
  private stream?: WriteStream;
  private e2e: { t: number; ms: number }[] = [];
  private end: { t: number; ms: number }[] = [];
  private start: { t: number; ms: number }[] = [];
  private first: { t: number; ms: number }[] = [];
  /** seq → instants du segment et durée de sa voix par langue, pour dater les acks qui le concernent. */
  private segments = new Map<number, SegmentTimes & { played: boolean; durs: Partial<Record<Lang, number>> }>();
  /** Décalage par mot de chaque écoute, sur dix minutes (D41). */
  private lags: { t: number; lags: number[]; mean: number; max: number; outage: boolean }[] = [];
  /** Pannes (reconnaissance perdue, texte seul) des dix dernières minutes ; `to` infini tant qu'elle dure. */
  private outages: { from: number; to: number }[] = [];
  private stages: Record<StageName, { t: number; ms: number }[]> = { commit: [], endCommit: [], mt: [], tts: [], sttLag: [] };
  /** Premier ack d'un segment : le moment où la salle a commencé à l'entendre (enregistreur). */
  onFirstPlay?: (seq: number, at: number) => void;
  /** Seuil de « parole » (dBFS) : en dessous, le micro reçoit du silence. Réglable dans l'administration. */
  speechDb = -35;
  private queues = new Map<string, { t: number; ms: number; lang?: Lang }>();
  private mic: { t: number; db: number }[] = [];
  /** Dernier relevé de captation envoyé par la page formateur (D34). */
  private captureAt: { t: number; ratio: number } | null = null;
  /** Retard montant de chaque trame datée, et son manquant constaté à l'arrivée (D37). */
  private uplinks: { t: number; ms: number }[] = [];
  private gaps: { t: number; ms: number }[] = [];
  /** Segments qu'un téléphone n'a pas pu jouer, nouvel essai compris (D40). */
  private playFails: number[] = [];
  private lastSpeechAt: number | null = null;
  readonly startedAt = Date.now();
  /** Démarrage du micro en cours : le silence se compte à partir de là, pas du lancement du serveur. */
  private micStartedAt = this.startedAt;

  constructor(file?: string) {
    if (file) this.stream = createWriteStream(file, { flags: "a" });
  }

  event(type: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ t: Date.now(), type, ...data });
    this.stream?.write(line + "\n");
  }

  /** Un segment vient d'être figé : on retient ses instants prononcés jusqu'aux acks. */
  segmentEnd(seq: number, times: SegmentTimes): void {
    this.segments.set(seq, { ...times, played: false, durs: {} });
    if (this.segments.size > KEEP_SEGMENTS) this.segments.delete(this.segments.keys().next().value!);
  }

  /** La voix d'un segment est prête dans une langue : sa durée sert au décalage par mot (D41). */
  voice(seq: number, lang: Lang, durMs: number): void {
    const s = this.segments.get(seq);
    if (s) s.durs[lang] = durMs;
  }

  /** Changement de mode du pipeline : journalisé, et les pannes sont retenues pour les indicateurs de retard. */
  degraded(mode: string, reason: string): void {
    this.event("degraded", { mode, reason });
    const now = Date.now();
    const open = this.outages.at(-1);
    const isOpen = open != null && open.to === Infinity;
    if (OUTAGE_MODES.has(mode)) {
      if (!isOpen) this.outages.push({ from: now, to: Infinity });
    } else if (isOpen) open.to = now;
    this.outages = this.outages.filter((o) => o.to >= now - LAG_WINDOW_MS);
  }

  /**
   * Quand les téléphones d'une langue auront fini la voix qu'ils ont reçue : médiane, sur les
   * acks des 20 dernières secondes, de « instant de l'ack + file du téléphone » (D42). Null sans ack
   * récent. La file d'un téléphone compte le segment qui vient de démarrer.
   */
  phonesFreeAt(lang: Lang): number | null {
    const now = Date.now();
    const v = [...this.queues.values()].filter((q) => q.lang === lang && q.t >= now - QUEUE_RECENT_MS).map((q) => q.t + q.ms);
    return percentile(v, 50);
  }

  /** Ack d'un client : début de lecture effectif d'un segment. `lang` : la langue qu'il écoute. */
  ack(participantId: string, seq: number, tOrigin: number, queueMs: number, lang?: Lang): AckLatency {
    const now = Date.now();
    const e2eMs = now - tOrigin;
    // Le tOrigin renvoyé par le client doit être celui du segment : un seq d'un autre
    // processus (serveur redémarré) ne doit pas fabriquer une mesure.
    const seg = this.segments.get(seq);
    const known = seg && seg.tOrigin === tOrigin ? seg : undefined;
    const endMs = known ? now - known.tEnd : null;
    const startMs = known ? now - known.tStart : null;
    this.e2e.push({ t: now, ms: e2eMs });
    if (endMs != null) this.end.push({ t: now, ms: endMs });
    if (startMs != null) this.start.push({ t: now, ms: startMs });
    // Décalage par mot de cette écoute : il faut la durée de la voix dans la langue écoutée.
    const durMs = known && lang ? known.durs[lang] : undefined;
    let wordLag: AckLatency["wordLag"] = null;
    if (known && durMs != null) {
      const lags = wordLags({ tStart: known.tStart, play: now, speech: known.tEnd - known.tStart, durMs, words: known.words ?? 1, wordStarts: known.wordStarts });
      const sum = lags.reduce((a, b) => a + b, 0);
      const outage = this.outages.some((o) => o.from <= now && o.to >= known.tStart);
      wordLag = { mean: Math.round(sum / lags.length), max: Math.max(...lags), sum, n: lags.length, outage, lags };
      this.lags.push({ t: now, lags, mean: wordLag.mean, max: wordLag.max, outage });
    }
    // Le premier son d'une prise de parole : le premier téléphone qui le joue.
    if (known && !known.played) {
      known.played = true;
      if (known.turnStart) this.first.push({ t: now, ms: startMs! });
      this.onFirstPlay?.(seq, now);
    }
    this.queues.set(participantId, { t: now, ms: queueMs, lang });
    this.event("ack", { participantId, seq, lang: lang ?? null, e2eMs, endMs, startMs, queueMs, wordLagMs: wordLag?.mean ?? null, wordLagMaxMs: wordLag?.max ?? null });
    return { e2eMs, endMs, startMs, wordLag };
  }

  forget(participantId: string): void {
    this.queues.delete(participantId);
  }

  /** Niveau d'une trame PCM 16 bits reçue du formateur, en dBFS. */
  audio(pcm: Uint8Array): void {
    const n = pcm.byteLength >> 1;
    if (!n) return;
    const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = view.getInt16(i * 2, true);
      sum += s * s;
    }
    const rms = Math.sqrt(sum / n);
    const db = rms > 0 ? Math.round(20 * Math.log10(rms / 32768)) : -100;
    const now = Date.now();
    this.mic.push({ t: now, db });
    if (this.mic.length > 40) this.mic.shift();
    if (db > this.speechDb) this.lastSpeechAt = now;
  }

  /** Durée d'un étage pour un segment (reconnaissance jusqu'au commit, traduction, synthèse). */
  stage(name: StageName, ms: number): void {
    this.stages[name].push({ t: Date.now(), ms });
  }

  /** Une trame datée est arrivée `ms` après sa captation (D37). Une trame sur vingt suffit à la médiane. */
  uplink(ms: number): void {
    if (this.uplinkSkip++ % 20) return;
    this.uplinks.push({ t: Date.now(), ms });
  }
  private uplinkSkip = 0;

  /** Des trames numérotées manquent à l'arrivée : `ms` de son jamais reçu (D37). */
  audioGap(ms: number): void {
    this.gaps.push({ t: Date.now(), ms });
  }

  /** Un téléphone n'a pas pu jouer un segment (D40) : compté pour le tableau de bord. */
  playFail(): void {
    this.playFails.push(Date.now());
  }

  micReset(): void {
    this.mic = [];
    this.captureAt = null;
    this.uplinks = [];
    this.gaps = [];
    this.lastSpeechAt = null;
    this.micStartedAt = Date.now();
  }

  /**
   * Relevé de la page formateur : part du son du micro livrée par son navigateur (D34). Au test 7,
   * 74 % seulement, perdus par morceaux de 10 ms avant même l'envoi ; la reconnaissance manquait des mots.
   * `mode` : variante de captation de l'essai F-03 (D38), pour attribuer les pertes à une variante.
   */
  capture(ratio: number, visible: boolean, focused: boolean, mode?: string): void {
    this.captureAt = { t: Date.now(), ratio };
    this.event("capture", { ratio: Math.round(ratio * 1000) / 1000, visible, focused, mode: mode ?? null });
  }

  snapshot() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    this.e2e = this.e2e.filter((s) => s.t >= cutoff);
    const e2e = this.e2e.map((s) => s.ms);
    this.end = this.end.filter((s) => s.t >= cutoff);
    const end = this.end.map((s) => s.ms);
    this.start = this.start.filter((s) => s.t >= cutoff);
    const start = this.start.map((s) => s.ms);
    this.first = this.first.filter((s) => s.t >= now - FIRST_WINDOW_MS);
    const first = this.first.map((s) => s.ms);
    const queues = [...this.queues.values()].filter((q) => q.t >= cutoff).map((q) => q.ms);
    const recent = this.mic.filter((m) => m.t >= now - 2000);
    const stage = (name: StageName) => {
      this.stages[name] = this.stages[name].filter((s) => s.t >= cutoff);
      return percentile(
        this.stages[name].map((s) => s.ms),
        50,
      );
    };
    // Indicateurs de premier rang (D41), hors écoutes de segments ayant traversé une panne.
    this.lags = this.lags.filter((s) => s.t >= now - LAG_WINDOW_MS);
    const lagOk = this.lags.filter((s) => !s.outage);
    const words = lagOk.filter((s) => s.t >= cutoff).flatMap((s) => s.lags);
    const sl = slope(lagOk.map((s) => ({ t: s.t, v: s.mean })));
    return {
      wordLagP50: percentile(words, 50),
      wordLagP95: percentile(words, 95),
      lagMaxMs: lagOk.length ? lagOk.reduce((m, s) => Math.max(m, s.max), -Infinity) : null,
      lagSlopeMsPerMin: sl && sl.spanMin >= SLOPE_MIN_SPAN_MIN ? sl.msPerMin : null,
      e2eP50: percentile(e2e, 50),
      e2eP95: percentile(e2e, 95),
      e2eMean: e2e.length ? Math.round(e2e.reduce((a, b) => a + b, 0) / e2e.length) : null,
      endP50: percentile(end, 50),
      endP95: percentile(end, 95),
      startP50: percentile(start, 50),
      startP95: percentile(start, 95),
      firstP50: percentile(first, 50),
      firstN: first.length,
      stages: { commitP50: stage("commit"), endCommitP50: stage("endCommit"), mtP50: stage("mt"), ttsP50: stage("tts"), sttLagP50: stage("sttLag") },
      queueP50Ms: percentile(queues, 50),
      queueMaxMs: queues.length ? Math.round(Math.max(...queues)) : null,
      micDb: recent.length ? Math.round(Math.max(...recent.map((m) => m.db))) : null,
      micSilentS: recent.length ? Math.round((now - (this.lastSpeechAt ?? this.micStartedAt)) / 1000) : null,
      // Un relevé toutes les 5 s : au-delà de 15 s sans relevé, on ne sait plus.
      micCapture: this.captureAt && now - this.captureAt.t < 15_000 ? Math.round(this.captureAt.ratio * 100) / 100 : null,
      uplinkP50Ms: percentile((this.uplinks = this.uplinks.filter((u) => u.t >= cutoff)).map((u) => u.ms), 50),
      audioGapMs: (this.gaps = this.gaps.filter((g) => g.t >= cutoff)).reduce((a, g) => a + g.ms, 0),
      playFails: (this.playFails = this.playFails.filter((t) => t >= cutoff)).length,
      uptimeS: Math.round((now - this.startedAt) / 1000),
    };
  }

  close(): void {
    this.stream?.end();
  }
}
