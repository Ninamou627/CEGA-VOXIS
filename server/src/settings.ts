/**
 * Réglages de la salle modifiables depuis l'administration, sans toucher au .env.
 *
 * Le .env donne les valeurs de départ — et les clés, qui ne quittent jamais le serveur ;
 * ce fichier les remplace dès qu'un administrateur enregistre. Chaque réglage dit quand
 * il prend effet : au segment suivant (lu à chaque appel), ou au prochain démarrage du
 * micro (paramètres d'ouverture du flux de reconnaissance vocale).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ClientSettings, Lang } from "../../shared/protocol";
import { SettingsSchema, type Settings } from "../../shared/settings";
import type { Config } from "./config";
import { DEFAULT_COMMIT, type CommitConfig } from "./pipeline/commit";
import { TypedEmitter } from "./util/emitter";

export { appliesAt, MT_ENGINES, SettingsSchema, type MtEngine, type Settings, type VoiceEntry } from "../../shared/settings";

/** Valeurs de départ : celles du .env, et les réglages d'usine pour le reste. */
export function defaultsFrom(cfg: Config): Settings {
  const defaults: Partial<Record<Lang, string>> = {};
  if (cfg.ELEVENLABS_VOICE_ID) for (const l of cfg.TARGET_LANGS) defaults[l] = cfg.ELEVENLABS_VOICE_ID;
  if (cfg.ELEVENLABS_VOICE_ID_EN) defaults.en = cfg.ELEVENLABS_VOICE_ID_EN;
  return {
    translation: {
      primary: cfg.MT_PROVIDER,
      secondary: cfg.MT_BACKUP,
      model: cfg.MT_MODEL,
      effort: "low",
      temperature: 0.3,
      timeoutMs: 6000,
      contextSegments: 2,
      domain: "",
      glossary: Object.entries(cfg.MT_GLOSSARY)
        .map(([k, v]) => `${k} = ${v}`)
        .join("\n"),
    },
    speech: {
      inputGainDb: 0,
      speechThresholdDb: -35,
      silenceAlertS: 20,
      endpointing: cfg.ASSEMBLYAI_MODE,
      minWords: DEFAULT_COMMIT.minWords,
      clauseWords: DEFAULT_COMMIT.clauseWords,
      maxWords: DEFAULT_COMMIT.maxWords,
      segmentTimeoutMs: DEFAULT_COMMIT.timeoutMs,
      quickStart: true,
      joinShort: true,
      keyterms: cfg.STT_KEYTERMS.join(", "),
      prompt: cfg.STT_PROMPT ?? "",
    },
    voice: { defaults, speed: 1, followTempo: true, stability: 0.5, style: 0, listenerVolume: 100 },
    voices: [],
  };
}

/** « terme = rendu » par ligne (ou « ; ») → dictionnaire pour le traducteur. */
export function parseGlossary(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/[\n;]/)) {
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseKeyterms(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function commitConfig(s: Settings): Partial<CommitConfig> {
  return { minWords: s.speech.minWords, clauseWords: s.speech.clauseWords, maxWords: s.speech.maxWords, timeoutMs: s.speech.segmentTimeoutMs };
}

export function clientSettings(s: Settings): ClientSettings {
  return {
    listenerVolume: s.voice.listenerVolume,
    inputGainDb: s.speech.inputGainDb,
    speechThresholdDb: s.speech.speechThresholdDb,
    silenceAlertS: s.speech.silenceAlertS,
  };
}

/** Clés « section.champ » qui diffèrent entre deux réglages. */
function changedKeys(a: Settings, b: Settings): string[] {
  const out: string[] = [];
  for (const section of ["translation", "speech", "voice"] as const) {
    const x = a[section] as Record<string, unknown>;
    const y = b[section] as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(`${section}.${k}`);
    }
  }
  if (JSON.stringify(a.voices) !== JSON.stringify(b.voices)) out.push("voices");
  return out;
}

export interface SettingsChange {
  settings: Settings;
  changed: string[];
}

export class SettingsStore extends TypedEmitter<{ change: SettingsChange }> {
  private current: Settings;

  constructor(
    private readonly file: string,
    readonly defaults: Settings,
  ) {
    super();
    this.current = this.load();
  }

  get(): Settings {
    return this.current;
  }

  /** Valide, enregistre et diffuse. Lève une ZodError si la saisie est invalide. */
  update(next: unknown): SettingsChange {
    const parsed = SettingsSchema.parse(next);
    const changed = changedKeys(this.current, parsed);
    if (!changed.length) return { settings: this.current, changed };
    this.current = parsed;
    this.save();
    const change = { settings: parsed, changed };
    this.emit("change", change);
    return change;
  }

  reset(): SettingsChange {
    // Les voix ajoutées restent : les perdre n'apporterait rien, les retrouver coûte cher.
    return this.update({ ...this.defaults, voices: this.current.voices });
  }

  private load(): Settings {
    if (!existsSync(this.file)) return this.defaults;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>;
      // Fusion section par section : un champ ajouté après coup prend sa valeur par défaut.
      const merged = {
        translation: { ...this.defaults.translation, ...raw.translation },
        speech: { ...this.defaults.speech, ...raw.speech },
        voice: { ...this.defaults.voice, ...raw.voice },
        voices: raw.voices ?? [],
      };
      return SettingsSchema.parse(merged);
    } catch (err) {
      console.warn(`[settings] ${this.file} illisible, valeurs du .env utilisées : ${(err as Error).message}`);
      return this.defaults;
    }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Écriture atomique : un arrêt en plein enregistrement ne laisse pas un fichier tronqué.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2));
    renameSync(tmp, this.file);
  }
}
