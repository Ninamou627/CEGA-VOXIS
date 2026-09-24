/**
 * Journal JSONL (une ligne par événement, rejouable) + fenêtres glissantes pour le
 * tableau de bord. La mesure bout-en-bout est prise à la réception de l'ack : le
 * client n'a pas besoin d'horloge synchronisée, et l'erreur est bornée par un aller
 * simple sur le LAN (~10–30 ms), toujours dans le sens d'une surestimation.
 */
import { createWriteStream, type WriteStream } from "node:fs";

const WINDOW_MS = 60_000;

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export type StageName = "commit" | "mt" | "tts";

export class Metrics {
  private stream?: WriteStream;
  private e2e: { t: number; ms: number }[] = [];
  private stages: Record<StageName, { t: number; ms: number }[]> = { commit: [], mt: [], tts: [] };
  /** Seuil de « parole » (dBFS) : en dessous, le micro reçoit du silence. Réglable dans l'administration. */
  speechDb = -35;
  private queues = new Map<string, { t: number; ms: number }>();
  private mic: { t: number; db: number }[] = [];
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

  /** Ack d'un client : début de lecture effectif d'un segment. */
  ack(participantId: string, seq: number, tOrigin: number, queueMs: number): number {
    const now = Date.now();
    const e2eMs = now - tOrigin;
    this.e2e.push({ t: now, ms: e2eMs });
    this.queues.set(participantId, { t: now, ms: queueMs });
    this.event("ack", { participantId, seq, e2eMs, queueMs });
    return e2eMs;
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

  micReset(): void {
    this.mic = [];
    this.lastSpeechAt = null;
    this.micStartedAt = Date.now();
  }

  snapshot() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    this.e2e = this.e2e.filter((s) => s.t >= cutoff);
    const e2e = this.e2e.map((s) => s.ms);
    const queues = [...this.queues.values()].filter((q) => q.t >= cutoff).map((q) => q.ms);
    const recent = this.mic.filter((m) => m.t >= now - 2000);
    const stage = (name: StageName) => {
      this.stages[name] = this.stages[name].filter((s) => s.t >= cutoff);
      return percentile(
        this.stages[name].map((s) => s.ms),
        50,
      );
    };
    return {
      e2eP50: percentile(e2e, 50),
      e2eP95: percentile(e2e, 95),
      e2eMean: e2e.length ? Math.round(e2e.reduce((a, b) => a + b, 0) / e2e.length) : null,
      stages: { commitP50: stage("commit"), mtP50: stage("mt"), ttsP50: stage("tts") },
      queueP50Ms: percentile(queues, 50),
      queueMaxMs: queues.length ? Math.round(Math.max(...queues)) : null,
      micDb: recent.length ? Math.round(Math.max(...recent.map((m) => m.db))) : null,
      micSilentS: recent.length ? Math.round((now - (this.lastSpeechAt ?? this.micStartedAt)) / 1000) : null,
      uptimeS: Math.round((now - this.startedAt) / 1000),
    };
  }

  close(): void {
    this.stream?.end();
  }
}
