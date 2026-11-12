/**
 * Contrat des réglages de la salle, partagé par le serveur (validation, stockage) et le
 * tableau de bord (formulaire). Les bornes sont celles que l'interface propose : une
 * valeur hors bornes ne peut venir que d'un appel direct à l'API, et elle est refusée.
 */
import { z } from "zod";
import { LangSchema } from "./protocol";

export const MT_ENGINES = ["anthropic", "deepl", "mock"] as const;
export type MtEngine = (typeof MT_ENGINES)[number];

const TranslationSchema = z.object({
  primary: z.enum(MT_ENGINES),
  secondary: z.enum(["none", ...MT_ENGINES]),
  model: z.string().trim().min(1).max(80),
  /** Profondeur de réflexion des modèles qui l'acceptent. `low` : la latence prime. */
  effort: z.enum(["low", "medium", "high"]),
  /** Seulement pour les modèles qui l'acceptent (voir claude-models.ts). */
  temperature: z.number().min(0).max(1),
  /** Au-delà, l'appel est abandonné et le secours prend le relais. */
  timeoutMs: z.number().int().min(2000).max(15000),
  /** Segments précédents fournis au traducteur pour la continuité. */
  contextSegments: z.number().int().min(0).max(6),
  /** Contexte linguistique : sujet de la formation, public, registre attendu. */
  domain: z.string().max(1500),
  /** Une paire « terme = rendu » par ligne. */
  glossary: z.string().max(4000),
  /**
   * Formulation resserrée quand la salle a 5 s de retard ou plus (D42) : Claude redit le segment
   * plus court — hésitations et redites retirées —, vérifié avant d'être dit (nombres, noms,
   * négations). Change le texte entendu : éteint par défaut, c'est une décision produit.
   */
  tightenWhenLate: z.boolean(),
});

const SpeechSchema = z
  .object({
    /** Gain appliqué au micro du formateur, après le contrôle automatique du navigateur. */
    inputGainDb: z.number().min(-12).max(12),
    /** Au-dessus, le serveur considère qu'il reçoit de la parole (supervision, alertes). */
    speechThresholdDb: z.number().int().min(-60).max(-20),
    silenceAlertS: z.number().int().min(5).max(120),
    /** Détection de fin de phrase du moteur de reconnaissance (AssemblyAI). */
    endpointing: z.enum(["min_latency", "balanced", "max_accuracy"]),
    minWords: z.number().int().min(1).max(10),
    clauseWords: z.number().int().min(4).max(30),
    maxWords: z.number().int().min(8).max(40),
    segmentTimeoutMs: z.number().int().min(800).max(6000),
    /**
     * Premier morceau d'une prise de parole coupé au premier blanc entre deux mots, plutôt qu'à
     * la première pause : la salle entend plus tôt, sur un morceau plus court (D25).
     */
    quickStart: z.boolean(),
    /**
     * Morceau de trois mots ou moins (« Mr. » | « President. ») envoyé avec la suite, sauf vraie
     * pause de l'orateur : la voix dit une phrase au lieu de deux bribes, un peu plus tard (D32).
     */
    joinShort: z.boolean(),
    /**
     * Morceau qui s'arrête au milieu d'une phrase (« It's really an honor to ») envoyé avec la
     * suite tant que l'orateur reprend avant 2,5 s : la voix dit des phrases entières, plus tard (D33).
     */
    wholeSentences: z.boolean(),
    /** Vocabulaire de la formation, séparé par des virgules. */
    keyterms: z.string().max(4000),
    /** Description de la séance pour la reconnaissance (en anglais, ≤ 1500 caractères). */
    prompt: z.string().max(1500),
  })
  .refine((s) => s.minWords <= s.clauseWords && s.clauseWords < s.maxWords, {
    message: "segmentation : il faut minimum ≤ proposition < maximum",
  });

const VoiceSchema = z.object({
  /** Voix par défaut par langue (identifiants ElevenLabs). */
  defaults: z.partialRecord(LangSchema, z.string().max(64)),
  /**
   * Vitesse de la voix. Quand elle suit le débit du formateur, elle multiplie la vitesse
   * calculée pour chaque segment ; sinon, c'est la vitesse de base du rattrapage de la dérive.
   */
  speed: z.number().min(0.8).max(1.2),
  /** Chaque segment dit dans le temps que le formateur a mis à le dire (D26). */
  followTempo: z.boolean(),
  /** Ton : 0 expressif … 1 posé et régulier. */
  stability: z.number().min(0).max(1),
  /** Exagération du style de la voix ; 0 = neutre, le plus sûr pour de l'interprétation. */
  style: z.number().min(0).max(1),
  /** Volume d'écoute de départ des apprenants. */
  listenerVolume: z.number().int().min(0).max(100),
});

export const VoiceEntrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  lang: LangSchema,
  provider: z.literal("elevenlabs"),
  gender: z.string().max(24).optional(),
  accent: z.string().max(40).optional(),
  age: z.string().max(24).optional(),
  description: z.string().max(200).optional(),
  previewUrl: z.string().max(500).optional(),
  addedAt: z.number(),
});
export type VoiceEntry = z.infer<typeof VoiceEntrySchema>;

export const SettingsSchema = z.object({
  translation: TranslationSchema,
  speech: SpeechSchema,
  voice: VoiceSchema,
  voices: z.array(VoiceEntrySchema).max(100),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Réglages lus à l'ouverture du flux de reconnaissance : ils attendent le prochain démarrage du micro. */
const NEXT_MIC = new Set(["speech.endpointing", "speech.keyterms", "speech.prompt"]);
export function appliesAt(key: string): "live" | "next-mic" {
  return NEXT_MIC.has(key) ? "next-mic" : "live";
}
