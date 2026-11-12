/**
 * Réponses de l'API d'administration (`/api/admin/*`), partagées par le serveur et le
 * tableau de bord. Voir server/src/admin.ts pour les routes.
 */
import type { Lang, ReportKind } from "./protocol";
import type { MtEngine, Settings } from "./settings";

/** Sommes d'une journée (ou de tout l'historique). */
export interface DayTotals {
  /** Durée cumulée de voix traduite diffusée (ms). */
  translatedMs: number;
  /** Segments dits par la voix. */
  spoken: number;
  /** Segments traduits (avec ou sans voix). */
  translated: number;
  /** Segments dont la traduction a échoué (texte source affiché à la place). */
  untranslated: number;
  /** Temps de séance : formateur en ligne, micro démarré (ms). */
  sessionMs: number;
  /** Part de ce temps où la voix pouvait être servie (ms). */
  availableMs: number;
  e2eSum: number;
  e2eN: number;
  /**
   * Latence fin de phrase → voix (D19), sommée par écoute. Absentes des jours enregistrés
   * avant cette mesure.
   */
  endSum?: number;
  endN?: number;
  /**
   * Décalage par mot (D41), hors segments ayant traversé une panne : somme et nombre de mots
   * écoutés, retard maximal, et la pente du retard la plus forte relevée sur 10 minutes (ms/min).
   * Absents des jours enregistrés avant cette mesure.
   */
  wordLagSum?: number;
  wordLagN?: number;
  lagMaxMs?: number;
  lagSlopeMaxMsPerMin?: number;
  /** Confiance des mots donnée par le moteur de reconnaissance, sommée par segment. */
  confSum: number;
  confN: number;
  reports: Partial<Record<ReportKind, number>>;
  questions: number;
}

export interface RecentReport {
  at: number;
  who: string;
  kind: ReportKind;
  lang: Lang;
  seq?: number;
  srcText?: string;
  text?: string;
  voice?: string;
  e2eMs?: number | null;
}

export type Stage = "stt" | "mt" | "tts";

/** Les quatre piliers de la qualité, chacun avec sa mesure et son échantillon. */
export interface Quality {
  /** Premier mot reconnu → début d'écoute : la mesure de rapidité d'avant D41. */
  speed: { meanMs: number | null; p95Ms: number | null; n: number; reports: number };
  /** Décalage par mot, retard maximal et pente la plus forte (D41) ; `n` : mots écoutés. */
  lag: { meanMs: number | null; p95Ms: number | null; n: number; maxMs: number | null; slopeMaxMsPerMin: number | null };
  transcription: { confidence: number | null; n: number; reports: number; segments: number };
  translation: { ok: number | null; n: number; reports: number; untranslated: number };
  voice: { natural: number | null; n: number; reports: number; audioReports: number };
}

export interface DayRow {
  day: string;
  translatedMs: number;
  sessionMs: number;
  availability: number | null;
  e2eMean: number | null;
  /** Décalage par mot moyen, retard maximal, pente la plus forte sur 10 min (D41). */
  wordLagMean: number | null;
  lagMaxMs: number | null;
  lagSlopeMax: number | null;
  confidence: number | null;
  translationOk: number | null;
  voiceNatural: number | null;
  reports: number;
}

export interface VoiceStats {
  lang?: Lang;
  spoken: number;
  unnatural: number;
  /** Part des segments dits par cette voix sans signalement « voix peu naturelle ». */
  natural: number | null;
}

export interface OverviewResponse {
  since: number;
  all: DayTotals;
  today: DayTotals;
  availability: number | null;
  availabilityToday: number | null;
  e2e: { p50: number | null; p95: number | null };
  /** Latence fin de phrase → voix sur tout l'historique (D19), à la résolution de l'histogramme. */
  end: { p50: number | null; p95: number | null; n: number };
  /** Décalage par mot sur tout l'historique (D41), à la résolution de l'histogramme ; `n` : mots. */
  wordLag: { p50: number | null; p95: number | null; n: number };
  quality: Quality;
  qualityToday: Quality;
  /** 14 derniers jours, du plus ancien au plus récent. */
  days: DayRow[];
  voices: Record<string, VoiceStats>;
  lastErrors: Partial<Record<Stage, { at: number; msg: string; count: number }>>;
  reports: RecentReport[];
}

export interface MtEngineInfo {
  id: MtEngine;
  label: string;
  available: boolean;
  reason?: string;
}

export interface ClaudeModel {
  id: string;
  label: string;
  effort: boolean;
  temperature: boolean;
  fallbacks: boolean;
  note: string;
}

export interface SettingsOptions {
  mtEngines: MtEngineInfo[];
  models: ClaudeModel[];
  stt: string;
  /** Le moteur de reconnaissance accepte les réglages d'ouverture (AssemblyAI). */
  sttTunable: boolean;
  /** Le modèle de reconnaissance lit la description de séance (AssemblyAI U3.5 Pro seulement). */
  sttPrompt: boolean;
  tts: string;
  /** Une clé ElevenLabs est configurée : on peut lister et essayer des voix. */
  voicesEnabled: boolean;
  /** La voix de séance est ElevenLabs ; sinon les voix choisies attendent la bascule. */
  elevenlabsInUse: boolean;
  srcLang: Lang;
  targetLangs: Lang[];
  /** Réglages qui n'agissent qu'au prochain démarrage du micro ; tous les autres, tout de suite. */
  nextMic: string[];
  azure: { fr: string; en: string } | null;
}

export interface SettingsResponse {
  settings: Settings;
  defaults: Settings;
  options: SettingsOptions;
}

export interface SaveResponse {
  settings: Settings;
  changed: string[];
  live: string[];
  nextMic: string[];
}

export interface CatalogVoice {
  id: string;
  name: string;
  category?: string;
  gender?: string;
  age?: string;
  accent?: string;
  description?: string;
  useCase?: string;
  languages: string[];
  previewUrl?: string;
}
