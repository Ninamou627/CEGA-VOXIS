import type { Lang, PipelineStatus } from "../../../shared/protocol";

/** Réponse de GET /api/session. */
export interface SessionInfo {
  sessionId: string;
  srcLang: Lang;
  langs: Lang[];
  providers: { stt: string; mt: string; tts: string };
  certWarning: string | null;
  joinUrl: string;
  joinUrls?: { url: string; iface: string; virtual: boolean }[];
  tls: boolean;
}

/** Réponse de GET /api/health, relevée toutes les 5 s. */
export interface Health {
  ok: boolean;
  uptimeS: number;
  listeners: number;
  lecturer: boolean;
  pipeline: PipelineStatus;
  process: { cpuPercent: number | null; rssMb: number; heapMb: number; loopLagMaxMs: number };
  audio: {
    wsBinaryFrames: number;
    received: number;
    forwarded: number;
    bytes: number;
    lastFrameAgoMs: number | null;
    sttOpen: boolean;
    /** Audio en attente d'envoi vers la reconnaissance (ms) : la connexion montante du poste. */
    sttBacklogMs?: number;
    started: boolean;
    micDb: number | null;
  };
}

export interface Line {
  seq: number;
  src?: string;
  tgt?: string;
  tOrigin?: number;
  reason?: string;
}

export interface QuestionEntry {
  n: number;
  at: number;
  who: string;
  srcLang: Lang;
  srcText: string;
  lang: Lang;
  text: string;
  delivered: boolean;
  /** « voice » : parlée au micro ; « text » : écrite sur le téléphone. */
  mode: "voice" | "text";
}

export type EventKind = "parole" | "question" | "signalement" | "degrade" | "erreur" | "salle" | "liaison" | "reglages";

export interface JournalEntry {
  n: number;
  at: number;
  kind: EventKind;
  text: string;
  /** Le même événement répété d'affilée (reconnexions en rafale) : une ligne, un compteur. */
  count?: number;
}

/** Un relevé de stats toutes les 2 s, gardé 10 minutes pour les courbes. */
export interface Sample {
  t: number;
  e2eP50: number | null;
  e2eP95: number | null;
  /** Latence fin de phrase → voix (D19). */
  endP50: number | null;
  /** Début de parole → voix : le décalage que l'apprenant ressent. */
  startP50: number | null;
  /** Indicateurs de premier rang (D41) : décalage par mot, retard maximal, pente du retard. */
  wordLagP50: number | null;
  lagMaxMs: number | null;
  lagSlopeMsPerMin: number | null;
  queueMaxMs: number | null;
  listeners: number;
  micDb: number | null;
  /**
   * Temps médians de chaque étage, pour l'inspecteur : reconnaissance (fin de phrase →
   * segment figé, D19), traduction, synthèse.
   */
  endCommitP50: number | null;
  mtP50: number | null;
  ttsP50: number | null;
}
