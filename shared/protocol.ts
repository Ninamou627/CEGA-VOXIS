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

/**
 * Pourquoi un segment n'a pas été joué, nouvel essai compris (D40) : fichier illisible,
 * lecture refusée par le navigateur, ou rien dans « durée + 2 s ».
 */
export const PlayFailReasonSchema = z.enum(["error", "refused", "stalled"]);
export type PlayFailReason = z.infer<typeof PlayFailReasonSchema>;

/** Une ligne de texte figée que l'apprenant a manquée pendant une coupure (D40). */
export interface CatchupLine {
  seq: number;
  src: string;
  tOrigin: number;
  /** Absente : la traduction n'était pas encore arrivée ; elle suivra en direct. */
  tgt?: string;
  untranslated?: boolean;
}

export interface PipelineStatus {
  stt: string;
  mt: string;
  tts: string;
  /** Segments en attente de traduction/synthèse, toutes langues confondues. */
  backlog: number;
  muted: boolean;
  degraded: DegradedMode;
  /**
   * Vitesse de synthèse du dernier segment (1 = normale). Elle suit le débit du formateur
   * (D26) ou, réglage « constant », la vitesse de base et le rattrapage de la dérive.
   */
  speed: number;
}

export interface StatsPayload {
  listeners: number;
  /** Auditeurs par langue d'écoute (tableau de bord). */
  byLang?: Partial<Record<Lang, number>>;
  /**
   * Décalage ressenti, mesuré à la réception des ack (ms), fenêtre glissante 60 s : du
   * premier mot reconnu d'un segment au début de son écoute.
   */
  e2eP50: number | null;
  e2eP95: number | null;
  e2eMean: number | null;
  /**
   * Latence qui valide le projet (D19), même fenêtre : de la fin prononcée d'un segment
   * au début de son écoute. Cible : moins d'une seconde.
   */
  endP50: number | null;
  endP95: number | null;
  /**
   * Ce que l'apprenant ressent, même fenêtre : du début prononcé du premier mot d'un segment
   * au début de son écoute.
   */
  startP50: number | null;
  startP95: number | null;
  /**
   * Le même délai pour le premier segment de chaque prise de parole (le formateur se taisait
   * avant), sur cinq minutes : combien de temps avant que la salle entende quelque chose.
   */
  firstP50: number | null;
  firstN: number;
  /**
   * Temps médian de chaque étage sur la même fenêtre (ms) : de la première apparition
   * d'un mot à son commit (reconnaissance), de la fin prononcée au commit, traduction,
   * synthèse, et retard d'affichage du STT (premier mot prononcé → première apparition).
   */
  stages: { commitP50: number | null; endCommitP50: number | null; mtP50: number | null; ttsP50: number | null; sttLagP50: number | null };
  /** Profondeur de file audio côté clients (ms). L'indicateur de dérive. */
  queueP50Ms: number | null;
  queueMaxMs: number | null;
  /** Niveau du micro formateur tel que reçu par le serveur (dBFS, 2 s glissantes). */
  micDb: number | null;
  /** Secondes écoulées depuis le dernier signal de parole. */
  micSilentS: number | null;
  /**
   * Part du son du micro que le navigateur du formateur livre vraiment, sur 10 s (D34) ;
   * null sans relevé récent. Sous 0,95, la reconnaissance manque des mots.
   */
  micCapture: number | null;
  /**
   * Retard montant : de la captation d'une trame sur le poste du formateur à sa réception par le
   * serveur, médiane sur 60 s (ms) ; null sans trame datée (D37). Son du micro manquant à
   * l'arrivée sur la même fenêtre (ms) : trames jamais reçues, ni en direct ni renvoyées.
   */
  uplinkP50Ms?: number | null;
  audioGapMs?: number;
  /**
   * Dernière trame du micro reçue de la captation en cours ; null sans captation numérotée (D37).
   * La page s'en sert après un redémarrage du serveur, qui ne connaît plus sa captation.
   */
  micSeq?: number | null;
  /** Segments qu'un téléphone n'a pas pu jouer, nouvel essai compris, sur 60 s (D40). */
  playFails?: number;
  /**
   * Indicateurs de premier rang (D41), hors écoutes de segments ayant traversé une panne.
   * Décalage par mot : du début prononcé d'un mot au début de son écoute, tous les mots écoutés
   * sur 60 s (ms). Estimé : la voix traduite est supposée dire les mots dans l'ordre, à débit
   * régulier. Retard maximal : le mot le plus en retard sur 10 min. Pente du retard : variation du
   * décalage moyen par minute sur 10 min (ms/min), null sous 3 min de mesures.
   */
  wordLagP50?: number | null;
  wordLagP95?: number | null;
  lagMaxMs?: number | null;
  lagSlopeMsPerMin?: number | null;
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
      /**
       * Formateur : dernière trame que le serveur a déjà de cette captation (D37). Absent quand il
       * ne la connaît pas : première admission, ou serveur redémarré depuis.
       */
      resumeSeq?: number;
      /**
       * Identifie ce démarrage du serveur (D40) : les numéros de segment repartent de zéro avec
       * lui. Une page qui revient avec un autre `epoch` ne peut pas comparer ses numéros.
       */
      epoch?: string;
    }
  /**
   * Apprenant revenu d'une coupure (D40) : les lignes de texte figées qu'il a manquées, dans
   * l'ordre, cinq minutes au plus. Envoyé juste après `hello`, avant tout le direct. Jamais
   * d'audio : la voix reprend au direct (D35).
   */
  | { t: "catchup"; lines: CatchupLine[] }
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
  /** Silence du formateur avant ce segment (ms) : le téléphone en garde une partie (D26). */
  pauseMs?: number;
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
    /**
     * Formateur : identifiant de la captation en cours (tiré au hasard à l'ouverture de la page).
     * Les numéros de trame repartent de zéro avec une nouvelle captation ; dans la même, une
     * reconnexion renvoie les dernières trames et le serveur écarte celles qu'il a déjà (D37).
     */
    capture: z.string().max(32).optional(),
    /**
     * Apprenant qui revient (D40) : le démarrage du serveur qu'il connaissait (`epoch` de
     * `hello`) et le dernier segment reçu en entier. Le serveur renvoie le texte qui suit.
     */
    resume: z.object({ epoch: z.string().max(32), seq: z.number().int().min(-1) }).optional(),
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
  /**
   * Un segment n'a pas pu être joué sur le téléphone, nouvel essai compris (D40). Avant, la
   * page passait à la suite sans rien dire : un fichier illisible ne se voyait nulle part.
   */
  z.object({
    t: z.literal("play.fail"),
    seq: z.number().int(),
    reason: PlayFailReasonSchema,
    attempts: z.number().int().min(1).max(5),
    player: z.enum(["element", "webaudio"]),
  }),
  /** « Revenir au direct » : le client a vidé sa file. */
  z.object({ t: z.literal("resync"), droppedMs: z.number().optional() }),
  z.object({ t: z.literal("lecturer.mute"), muted: z.boolean() }),
  /**
   * Captation du micro, toutes les 5 s (D34) : part du temps réel que le navigateur du formateur
   * a réellement livrée au worklet (1 = rien de perdu), et l'état de l'onglet à ce moment-là.
   */
  // `mode` : variante de captation (D38, essai F-03) — « 16k », « natif48k brut »… — pour attribuer les pertes après coup.
  z.object({ t: z.literal("lecturer.capture"), ratio: z.number().min(0).max(2), visible: z.boolean(), focused: z.boolean(), mode: z.string().max(40).optional() }),
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;
export type JoinEvent = Extract<ClientEvent, { t: "join" }>;

/*
 * Binaire client → serveur :
 *   - formateur : trames de 50 ms de PCM 16 bits little-endian mono, à `sampleRate`, chacune
 *     précédée de son numéro et de son instant de captation (`encodeMicFrame`, framing.ts) ;
 *     du PCM brut sans en-tête reste accepté (rejeu, test de charge) ;
 *   - apprenant : fichier audio complet de la question (webm/opus ou mp4), après `ask start`.
 */
