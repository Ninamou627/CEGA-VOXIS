/**
 * Enregistrement d'une séance, pour la rejouer et la mesurer : la voix du formateur telle que
 * le STT l'a reçue, chaque segment reconnu avec ses mots datés, sa traduction, sa voix, et
 * l'instant où la salle a commencé à l'entendre. C'est la matière des comparaisons avant /
 * après : `npm run replay` rejoue `source.wav`, `npm run prosody` compare les deux voix.
 *
 * Désactivé par défaut (RECORD_DIR vide) : enregistrer la voix d'une personne demande son
 * accord. Un dossier par démarrage du micro :
 *
 *   source.wav       PCM 16 bits mono, exactement l'audio transmis au STT (sourdine exclue)
 *   segments.jsonl   une ligne par événement :
 *                      src  — segment reconnu, ses mots datés dans source.wav
 *                      tgt  — traduction, fichier de sa voix, durée
 *                      play — premier téléphone qui commence à le jouer
 *   0001-fr.mp3 …    la voix de chaque segment, telle que diffusée
 *   session.json     repères de temps, écrit à l'arrêt
 *
 * Tous les instants sont en ms depuis le début de source.wav. Les mots du STT y sont placés
 * exactement (position du flux + début du flux dans l'enregistrement) ; les écoutes, datées à
 * l'horloge du serveur, le sont à ±100 ms (une trame).
 */
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Lang } from "../../shared/protocol";
import type { Word } from "./providers/types";
import { wavHeader } from "./providers/tts/mock";

/** Un repère heure serveur → position dans l'enregistrement par seconde suffit à dater une écoute. */
const MARK_EVERY_MS = 1000;

export interface RecordedSegment {
  seq: number;
  text: string;
  reason: string;
  turnStart: boolean;
  stream: number;
  words: Word[];
  /** La voix du formateur sur le segment (D28), telle que le serveur l'a décrite. */
  prosody?: unknown;
}

export interface RecordedVoice {
  seq: number;
  lang: Lang;
  text: string;
  mime: string;
  durMs: number;
  bytes: Uint8Array;
}

export class SessionRecorder {
  private dir?: string;
  private fd?: number;
  private bytes = 0;
  private startedAt = 0;
  /** Position (ms) de l'enregistrement au début de chaque flux STT. */
  private streams = new Map<number, number>();
  /** [heure serveur, position ms] */
  private marks: [number, number][] = [];

  constructor(
    private readonly root: string,
    private readonly sampleRate: number,
    private readonly log?: { info: (o: object, msg: string) => void },
  ) {}

  get recording(): string | undefined {
    return this.dir;
  }

  /** Position courante dans l'enregistrement (ms). */
  get ms(): number {
    return (this.bytes / 2 / this.sampleRate) * 1000;
  }

  start(now = Date.now()): void {
    if (this.dir) this.stop();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.dir = path.join(this.root, stamp);
    mkdirSync(this.dir, { recursive: true });
    this.fd = openSync(path.join(this.dir, "source.wav"), "w");
    writeSync(this.fd, wavHeader(0, this.sampleRate)); // tailles corrigées à l'arrêt
    this.bytes = 0;
    this.startedAt = now;
    this.streams.clear();
    this.marks = [];
    this.log?.info({ dir: this.dir }, "enregistrement de la séance");
  }

  /** Une trame transmise au STT. */
  audio(pcm: Uint8Array, at = Date.now()): void {
    if (this.fd == null) return;
    writeSync(this.fd, pcm);
    this.bytes += pcm.byteLength & ~1;
    // Une trame reçue à `at` couvre la parole jusqu'à `at` (comme AudioClock) : le repère est sa fin.
    const last = this.marks[this.marks.length - 1];
    if (!last || at - last[0] >= MARK_EVERY_MS) this.marks.push([at, Math.round(this.ms)]);
  }

  /** Un flux STT s'ouvre : ses horodatages partent de la position courante. */
  stream(n: number): void {
    if (this.fd == null) return;
    this.streams.set(n, this.ms);
  }

  segment(s: RecordedSegment): void {
    const offset = this.streams.get(s.stream);
    if (offset == null) return;
    const words = s.words
      .filter((w) => w.startMs != null && w.endMs != null)
      .map((w) => ({ text: w.text, startMs: Math.round(offset + w.startMs!), endMs: Math.round(offset + w.endMs!) }));
    this.line({
      kind: "src",
      seq: s.seq,
      text: s.text,
      reason: s.reason,
      turnStart: s.turnStart,
      startMs: words[0]?.startMs ?? null,
      endMs: words[words.length - 1]?.endMs ?? null,
      words,
      prosody: s.prosody ?? null,
    });
  }

  voice(v: RecordedVoice, at = Date.now()): void {
    if (!this.dir) return;
    const ext = v.mime.includes("wav") ? "wav" : v.mime.includes("ogg") ? "ogg" : "mp3";
    const file = `${String(v.seq).padStart(4, "0")}-${v.lang}.${ext}`;
    writeFileSync(path.join(this.dir, file), v.bytes);
    this.line({ kind: "tgt", seq: v.seq, lang: v.lang, text: v.text, file, durMs: v.durMs, readyMs: this.toMs(at) });
  }

  /** Le premier téléphone commence à jouer le segment. */
  played(seq: number, at = Date.now()): void {
    this.line({ kind: "play", seq, atMs: this.toMs(at) });
  }

  stop(): void {
    if (this.fd == null || !this.dir) return;
    // En-tête WAV avec les vraies tailles, maintenant qu'on les connaît.
    writeSync(this.fd, wavHeader(this.bytes >> 1, this.sampleRate), 0, 44, 0);
    closeSync(this.fd);
    writeFileSync(
      path.join(this.dir, "session.json"),
      JSON.stringify({ startedAt: this.startedAt, sampleRate: this.sampleRate, durationMs: Math.round(this.ms), streams: [...this.streams], marks: this.marks }, null, 1),
    );
    this.log?.info({ dir: this.dir, durationS: Math.round(this.ms / 1000) }, "enregistrement terminé");
    this.fd = undefined;
    this.dir = undefined;
  }

  /** Heure serveur → position dans l'enregistrement, par le repère qui la précède. */
  private toMs(at: number): number {
    let mark: [number, number] | undefined;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.marks[i][0] <= at) {
        mark = this.marks[i];
        break;
      }
    }
    mark ??= this.marks[0] ?? [this.startedAt, 0];
    return Math.round(mark[1] + (at - mark[0]));
  }

  private line(o: object): void {
    if (!this.dir) return;
    appendFileSync(path.join(this.dir, "segments.jsonl"), JSON.stringify(o) + "\n");
  }
}
