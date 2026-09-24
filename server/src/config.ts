import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LangSchema } from "../../shared/protocol";

// Le .env vit à la racine du dépôt, quel que soit le cwd de lancement.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

/** Chemin relatif à la racine du dépôt (npm lance le serveur depuis server/). */
export function repoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(fileURLToPath(new URL("../../", import.meta.url)), p);
}

const csvLangs = z
  .string()
  .default("fr")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(LangSchema).min(1));

const optional = z.string().trim().optional().transform((s) => (s ? s : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SESSION_ID: z.string().default("TRAINING-01"),
  SESSION_TOKEN: z.string().default("change-me"),
  SRC_LANG: LangSchema.default("en"),
  TARGET_LANGS: csvLangs,
  PUBLIC_URL: optional,
  TLS_CERT: optional,
  TLS_KEY: optional,
  METRICS_FILE: z.string().default("metrics.jsonl"),
  /** Réglages enregistrés depuis l'administration (remplacent ceux du .env). */
  SETTINGS_FILE: z.string().default("data/settings.json"),
  /** Compteurs de long terme : voix traduite, disponibilité, signalements, par jour. */
  TOTALS_FILE: z.string().default("data/totals.json"),

  STT_PROVIDER: z.enum(["mock", "assemblyai", "deepgram"]).default("mock"),
  MT_PROVIDER: z.enum(["mock", "anthropic", "deepl"]).default("mock"),
  /** Traduction de secours : prend le relais 60 s si le primaire échoue. */
  MT_BACKUP: z.enum(["none", "mock", "anthropic", "deepl"]).default("none"),
  DEEPL_API_KEY: optional,
  TTS_PROVIDER: z.enum(["mock", "elevenlabs", "azure"]).default("mock"),
  /** TTS de secours : prend le relais segment par segment si le primaire échoue. */
  TTS_BACKUP: z.enum(["none", "mock", "elevenlabs", "azure"]).default("none"),
  MOCK_STT_CLOCK: z.enum(["audio", "timer"]).default("audio"),

  ANTHROPIC_API_KEY: optional,
  MT_MODEL: z.string().default("claude-opus-5"),
  /** Glossaire imposé au traducteur : « terme source=rendu cible », séparés par des « ; ». */
  MT_GLOSSARY: z
    .string()
    .default("")
    .transform((s) =>
      Object.fromEntries(
        s
          .split(";")
          .map((pair) => pair.split("=").map((x) => x.trim()))
          .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0]) && Boolean(kv[1])),
      ),
    ),
  ASSEMBLYAI_API_KEY: optional,
  ASSEMBLYAI_MODEL: z.string().default("universal-3-5-pro"),
  ASSEMBLYAI_REGION: z.enum(["eu", "us", "edge"]).default("eu"),
  ASSEMBLYAI_MODE: z.enum(["min_latency", "balanced", "max_accuracy"]).default("balanced"),
  ASSEMBLYAI_VOICE_FOCUS: z.enum(["none", "near-field", "far-field"]).default("none"),
  /** Ignorer les tours reconnus dans une autre langue que la source (anti-boucle, anti-intrus). */
  ASSEMBLYAI_LANGUAGE_GATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Description de la séance, en anglais, pour le STT (≤ 1500 caractères). */
  STT_PROMPT: optional,
  /** Vocabulaire de la formation, séparé par des virgules : termes, acronymes, noms. */
  STT_KEYTERMS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
  DEEPGRAM_API_KEY: optional,
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_VOICE_ID: optional,
  ELEVENLABS_VOICE_ID_EN: optional,
  ELEVENLABS_MODEL: z.string().default("eleven_turbo_v2_5"),
  AZURE_SPEECH_KEY: optional,
  AZURE_SPEECH_REGION: optional,
  AZURE_TTS_VOICE: z.string().default("fr-FR-DeniseNeural"),
  AZURE_TTS_VOICE_EN: z.string().default("en-US-JennyNeural"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  return parsed.data;
}
