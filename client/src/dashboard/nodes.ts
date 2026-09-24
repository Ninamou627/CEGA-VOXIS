/**
 * Ce que montre chaque étage de la constellation, en plus de son état : une valeur en
 * satellite, une ligne dans l'orbe, des pastilles en orbite. Rien que du mesuré ou du
 * configuré — pas de chiffre de décor.
 */
import type { SettingsResponse } from "../../../shared/admin";
import type { Lang } from "../../../shared/protocol";
import { delay, rate } from "../ui/format";
import { LANGS } from "../ui/langs";
import type { Signals, StageState } from "./signals";
import type { Tone } from "./ui";

export interface NodeView {
  stage: StageState;
  /** Valeur en satellite, en haut à droite de l'orbe. */
  badge?: { text: string; title: string; tone?: Tone };
  /** Une ou deux lignes courtes dans l'orbe, sous l'icône. */
  lines?: string[];
  /** Pastilles qui tournent autour de l'orbe : langues traduites, dernier mot entendu. */
  orbit?: { text: string; title: string }[];
  /** Petits satellites ronds : apprenants à l'écoute, par langue. */
  satellites?: { text: string; title: string }[];
  /** Barres vives dans l'orbe : le niveau du micro, ou la voix qui parle. */
  bars?: "mic" | "voice";
  /** L'orbe central, plus grand, à trois anneaux : le moteur de traduction. */
  core?: boolean;
}

const ENGINE: Record<string, string> = {
  assemblyai: "AssemblyAI",
  deepgram: "Deepgram",
  anthropic: "Claude",
  deepl: "DeepL",
  elevenlabs: "ElevenLabs",
  "azure-neural": "Azure",
};

/** « anthropic:claude-opus-5→deepl:free » → « Claude » (ou « DeepL » pour le secours) ; un simulateur → « Simulateur ». */
export function engineName(raw?: string, which: "primary" | "backup" = "primary"): string | undefined {
  const part = raw?.split("→")[which === "primary" ? 0 : 1];
  if (!part) return undefined;
  const id = part.split(":")[0].trim();
  return id.startsWith("mock") ? "Simulateur" : (ENGINE[id] ?? id);
}

/** Le modèle Claude en service, en court : « Opus 5 ». */
function modelShort(raw: string | undefined, conf?: SettingsResponse): string | undefined {
  const primary = raw?.split("→")[0];
  if (!primary?.startsWith("anthropic:")) return undefined;
  const id = primary.slice("anthropic:".length);
  return (conf?.options.models.find((m) => m.id === id)?.label ?? id).replace(/^Claude\s+/i, "");
}

/** Le prénom de la voix par défaut d'une langue (« Matilda - Knowledgable… » → « Matilda »). */
export function voiceName(conf: SettingsResponse | undefined, lang: Lang): string | undefined {
  const id = conf?.settings.voice.defaults[lang] || conf?.defaults.voice.defaults[lang];
  const v = id ? conf?.settings.voices.find((x) => x.id === id) : undefined;
  return v?.name.split(" - ")[0].trim();
}

/** Dernier mot d'un texte, sans ponctuation, pour l'orbite de la reconnaissance. */
export function lastWord(text?: string): string | undefined {
  const w = text?.trim().split(/\s+/).pop()?.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return w ? (w.length > 14 ? `${w.slice(0, 13)}…` : w) : undefined;
}

export function nodeViews(sig: Signals, stages: StageState[], conf?: SettingsResponse, heard?: string): NodeView[] {
  const st = sig.stats;
  const pl = st?.pipeline ?? sig.health?.pipeline;
  const src: Lang = sig.info?.srcLang ?? conf?.options.srcLang ?? "en";
  const targets: Lang[] = sig.info?.langs ?? conf?.options.targetLangs ?? ["fr"];
  const threshold = sig.room?.speechThresholdDb ?? -35;
  const today = sig.overview?.qualityToday;

  return stages.map((s): NodeView => {
    switch (s.id) {
      case "mic":
        return { stage: s, bars: "mic", badge: { text: LANGS[src].short, title: `Le formateur parle ${LANGS[src].nameFr}` } };

      case "audio": {
        const db = st?.micDb ?? null;
        return {
          stage: s,
          lines: [`seuil ${threshold} dB`],
          badge: db == null ? undefined : { text: `${db} dB`, title: "Niveau reçu par le serveur (2 dernières secondes)", tone: db > -3 ? "crit" : db > threshold ? "ok" : "idle" },
        };
      }

      case "stt": {
        const c = today?.transcription.confidence ?? null;
        return {
          stage: s,
          lines: [engineName(pl?.stt) ?? "—"],
          badge: c == null ? undefined : { text: rate(c), title: "Confiance moyenne de la reconnaissance aujourd'hui" },
          orbit: heard && s.tone !== "idle" ? [{ text: heard, title: "Dernier mot entendu" }] : undefined,
        };
      }

      case "mt": {
        const backup = pl?.degraded === "backup-mt";
        const engine = engineName(pl?.mt, backup ? "backup" : "primary");
        const model = backup ? "secours" : modelShort(pl?.mt, conf);
        const langs = [src, ...targets.filter((l) => l !== src)].slice(0, 4);
        return {
          stage: s,
          core: true,
          lines: [(engine ?? "—").toUpperCase(), ...(model ? [model] : [])],
          badge: st?.stages.mtP50 == null ? undefined : { text: delay(st.stages.mtP50), title: "Temps médian de traduction (dernière minute)" },
          orbit: langs.map((l) => ({ text: LANGS[l].short, title: l === src ? `Langue du formateur : ${LANGS[l].nameFr}` : `Traduit en ${LANGS[l].nameFr}` })),
        };
      }

      case "tts": {
        const engine = engineName(pl?.tts, pl?.degraded === "backup-tts" ? "backup" : "primary");
        const voice = engine === "ElevenLabs" ? voiceName(conf, targets[0]) : undefined;
        const byLang = Object.entries(st?.byLang ?? {}).filter(([, n]) => (n ?? 0) > 0) as [Lang, number][];
        return {
          stage: s,
          bars: "voice",
          lines: [voice ?? engine ?? "—"],
          badge: pl ? { text: `×${pl.speed.toFixed(2).replace(".", ",")}`, title: pl.speed > 1 ? "Vitesse de la voix, rattrapage de la dérive compris" : "Vitesse de la voix" } : undefined,
          satellites: byLang.slice(0, 3).map(([l, n]) => ({ text: String(n), title: `${n} apprenant${n > 1 ? "s" : ""} à l'écoute en ${LANGS[l].nameFr}` })),
        };
      }
    }
  });
}
