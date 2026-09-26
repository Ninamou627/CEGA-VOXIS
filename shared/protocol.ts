/**
 * Contrat d'événements entre le serveur de salle et les clients.
 *
 * Deux registres, volontairement séparés :
 *   - ce qui est RÉVISABLE   (src.partial)  → affichage seulement, jamais de voix ;
 *   - ce qui est DÉFINITIF   (src.commit, tr.segment, audio) → append-only.
 *
 * Les messages texte transportent du JSON (ServerEvent / ClientEvent).
 * Les messages binaires transportent une trame (voir framing.ts) dont l'en-tête
 * est un AudioHeader, ou de l'audio brut selon le rôle (voir ci-dessous).
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const LangSchema = z.enum(["en", "fr", "es", "ar", "pt"]);
export type Lang = z.infer<typeof LangSchema>;

/** `screen` : l'écran de salle (projecteur) — tout le texte, toutes les langues, jamais d'audio, pas de jeton. */
export const RoleSchema = z.enum(["listener", "lecturer", "dashboard", "screen"]);
export type Role = z.infer<typeof RoleSchema>;

export type DegradedMode = "none" | "text-only" | "backup-mt" | "backup-tts" | "stt-lost" | "s2s";

/** Ce qu'un apprenant peut signaler depuis son téléphone. */
export const ReportKindSchema = z.enum(["transcription", "translation", "slow", "voice", "audio"]);
export type ReportKind = z.infer<typeof ReportKindSchema>;

export interface PipelineStatus {
  stt: string;
  mt: string;
  tts: string;
  /** Segments en attente de traduction/synthèse, toutes langues confondues. */
  backlog: number;
  muted: boolean;
  degraded: DegradedMode;
  /** Vitesse de synthèse courante (1 = normale). > 1 = rattrapage de la dérive en cours. */
  speed: number;
}

export interface StatsPayload {
  listeners: number;
  /** Auditeurs par langue d'écoute (tableau de bord). */
  byLang?: Partial<Record<Lang, number>>;
  /** Bout-en-bout mesuré à la réception des ack (ms), fenêtre glissante 60 s. */
  e2eP50: number | null;
  e2eP95: number | null;
  e2eMean: number | null;
  /**
   * Temps médian de chaque étage sur la même fenêtre (ms) : de la première apparition
   * d'un mot à son commit (reconnaissance), traduction, synthèse.
   */
  stages: { commitP50: number | null; mtP50: number | null; ttsP50: number | null };
  /** Profondeur de file audio côté clients (ms). L'indicateur de dérive. */
  queueP50Ms: number | null;
  queueMaxMs: number | null;
  /** Niveau du micro formateur tel que reçu par le serveur (dBFS, 2 s glissantes). */
  micDb: number | null;
  /** Secondes écoulées depuis le dernier signal de parole. */
  micSilentS: number | null;
  pipeline: PipelineStatus;
  uptimeS: number;
}

export type FloorState = { state: "lecturer" } | { state: "question"; who: string };

/**
 * Réglages de l'administration dont les clients ont besoin, poussés à la connexion
 * (`hello`) et à chaque enregistrement (`settings`) : ils s'appliquent sans recharger.
 */
export interface ClientSettings {
  /** Volume d'écoute de départ des apprenants, 0 à 100. */
  listenerVolume: number;
  /** Gain appliqué au micro du formateur avant l'envoi, en dB. */
  inputGainDb: number;
  /** Au-dessus de ce niveau (dBFS), le serveur considère qu'il reçoit de la parole. */
  speechThresholdDb: number;
  /** Silence du micro, formateur en ligne, au-delà duquel on alerte (s). */
  silenceAlertS: number;
}

// ---------------------------------------------------------------------------
// Serveur → client (JSON)
// ---------------------------------------------------------------------------
export type ServerEvent =
  | {
      t: "hello";
      v: number;
      sessionId: string;
      role: Role;
      participantId: string;
      langs: Lang[];
      srcLang: Lang;
      /** Horloge serveur à l'envoi : sert au client à estimer son décalage d'horloge. */
      tServer: number;
      floor: FloorState;
      pipeline: PipelineStatus;
      settings: ClientSettings;
    }
  /** Un administrateur a enregistré des réglages : les clients s'y accordent tout de suite. */
  | { t: "settings"; settings: ClientSettings }
  /** Hypothèse STT courante, complète et révisable. Écran uniquement. */
  | { t: "src.partial"; text: string }
  /** Segment source figé. Ne sera jamais réécrit. */
  | { t: "src.commit"; seq: number; text: string; tOrigin: number; reason: string }
  /** Traduction d'un segment figé. `untranslated` = la traduction a échoué, texte source renvoyé. */
  | { t: "tr.segment"; seq: number; lang: Lang; text: string; srcSeq: number; untranslated?: boolean }
  | { t: "floor"; floor: FloorState }
  /**
   * Question d'un apprenant, transcrite et traduite (le son part en trame binaire au
   * formateur). Envoyée au formateur, au tableau de bord et à l'apprenant qui l'a posée.
   * `delivered` = un formateur était connecté pour l'entendre.
   */
  | {
      t: "question";
      who: string;
      srcLang: Lang;
      srcText: string;
      lang: Lang;
      text: string;
      delivered: boolean;
      /** « voice » : parlée au micro ; « text » : écrite sur le téléphone. */
      mode: "voice" | "text";
    }
  /**
   * Signalement d'un apprenant sur la qualité, avec le contexte que le serveur a
   * retrouvé : c'est la matière première de l'amélioration du système (glossaire,
   * segmentation, choix de voix). Envoyé à l'administration seulement : le formateur
   * n'est pas interrompu pendant qu'il parle.
   */
  | {
      t: "report";
      who: string;
      kind: ReportKind;
      lang: Lang;
      at: number;
      /** Segment visé, si l'apprenant en écoutait un. */
      seq?: number;
      srcText?: string;
      text?: string;
      /** Décalage ressenti au moment du signalement (ms). */
      e2eMs?: number | null;
    }
  | { t: "stats"; stats: StatsPayload }
  | { t: "degraded"; mode: DegradedMode; reason: string }
  | { t: "error"; code: string; msg: string };

/** En-tête de la trame binaire serveur → client. Le contenu est l'audio encodé. */
export interface AudioHeader {
  t: "audio";
  seq: number;
  lang: Lang;
  mime: string;
  durMs: number;
  /** Horloge serveur du premier mot du segment source. Voyage jusqu'à l'oreille. */
  tOrigin: number;
  srcSeq: number;
  text: string;
  /** "question" = audio d'une question d'apprenant, destiné au formateur. */
  kind?: "translation" | "question";
  /** Question : faux pour une question écrite, que le formateur lance lui-même. */
  autoplay?: boolean;
}

// ---------------------------------------------------------------------------
// Client → serveur (JSON, validé par zod côté serveur)
// ---------------------------------------------------------------------------
export const ClientEventSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("join"),
    role: RoleSchema,
    session: z.string().max(64).optional(),
    lang: LangSchema.optional(),
    /**
     * Apprenant et écran de salle : le code de séance (D17). Le formateur et
     * l'administration ne présentent rien ici — leur cookie de session voyage avec la
     * poignée de main WebSocket.
     */
    code: z.string().trim().max(32).optional(),
    ua: z.string().max(300).optional(),
    /** Formateur : fréquence d'échantillonnage réelle du micro (PCM 16 bits mono). */
    sampleRate: z.number().int().min(8000).max(48000).optional(),
  }),
  /** Envoyé au démarrage effectif de la lecture d'un segment. Base de la mesure bout-en-bout. */
  z.object({
    t: z.literal("ack"),
    seq: z.number().int(),
    tOrigin: z.number(),
    queueMs: z.number().min(0),
  }),
  /** Push-to-talk. L'audio (un seul message binaire) est envoyé entre start et end. */
  z.object({ t: z.literal("ask"), phase: z.enum(["start", "end"]), mime: z.string().max(100).optional() }),
  /** Question écrite : pas de micro, pas de mutex de parole — elle ne coupe personne. */
  z.object({ t: z.literal("ask.text"), text: z.string().trim().min(1).max(500) }),
  /**
   * Signalement de qualité. Le client dit ce qui n'allait pas et sur quel segment ;
   * le serveur retrouve les textes et horodate — l'apprenant ne ressaisit rien.
   */
  z.object({ t: z.literal("report"), kind: ReportKindSchema, seq: z.number().int().optional(), e2eMs: z.number().nullable().optional() }),
  /** « Revenir au direct » : le client a vidé sa file. */
  z.object({ t: z.literal("resync"), droppedMs: z.number().optional() }),
  z.object({ t: z.literal("lecturer.mute"), muted: z.boolean() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;
export type JoinEvent = Extract<ClientEvent, { t: "join" }>;

/*
 * Binaire client → serveur :
 *   - formateur : PCM 16 bits little-endian mono, à `sampleRate`, par trames de ~100 ms ;
 *   - apprenant : fichier audio complet de la question (webm/opus ou mp4), après `ask start`.
 */
