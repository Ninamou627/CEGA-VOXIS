/**
 * Voix du compte ElevenLabs, pour l'administration : la liste « Mes voix » de l'API, et
 * la vérification d'un identifiant collé à la main. La clé ne quitte pas le serveur ; la
 * liste est gardée 10 minutes pour ne pas solliciter l'API à chaque ouverture du panneau.
 */
import type { CatalogVoice } from "../../../shared/admin";

export type { CatalogVoice };

export class VoiceNotFound extends Error {}

const API = "https://api.elevenlabs.io/v1";
const CACHE_MS = 10 * 60_000;
const LANG_NAMES: Record<string, string> = { english: "en", french: "fr", spanish: "es", portuguese: "pt", arabic: "ar" };

function langCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const s = raw.trim().toLowerCase();
  return LANG_NAMES[s] ?? (/^[a-z]{2}([-_].*)?$/.test(s) ? s.slice(0, 2) : undefined);
}

function normalize(v: any): CatalogVoice {
  const labels = (v?.labels ?? {}) as Record<string, string>;
  const langs = new Set<string>();
  for (const l of v?.verified_languages ?? []) {
    const c = langCode(l?.language ?? l?.locale);
    if (c) langs.add(c);
  }
  const declared = langCode(labels.language) ?? langCode(v?.fine_tuning?.language);
  if (declared) langs.add(declared);
  return {
    id: String(v.voice_id),
    name: String(v.name ?? v.voice_id),
    category: v.category ?? undefined,
    gender: labels.gender ?? undefined,
    age: labels.age ?? undefined,
    accent: labels.accent ?? undefined,
    description: labels.description ?? labels.descriptive ?? v.description ?? undefined,
    useCase: labels.use_case ?? labels["use case"] ?? undefined,
    languages: [...langs],
    previewUrl: v.preview_url ?? undefined,
  };
}

export class VoiceCatalog {
  private cache?: { at: number; voices: CatalogVoice[] };

  constructor(private readonly apiKey: string) {}

  async list(force = false): Promise<CatalogVoice[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.voices;
    const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": this.apiKey }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} : ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { voices?: unknown[] };
    const voices = (j.voices ?? []).map(normalize).sort((a, b) => a.name.localeCompare(b.name, "fr"));
    this.cache = { at: Date.now(), voices };
    return voices;
  }

  /** Une voix précise du compte ; `VoiceNotFound` si l'identifiant n'y est pas. */
  async get(id: string): Promise<CatalogVoice> {
    const res = await fetch(`${API}/voices/${encodeURIComponent(id)}`, { headers: { "xi-api-key": this.apiKey }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 400 || res.status === 404) {
      throw new VoiceNotFound(
        "voix introuvable dans votre compte ElevenLabs — une voix de la bibliothèque publique doit d'abord être ajoutée à « My Voices »",
      );
    }
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} : ${(await res.text()).slice(0, 200)}`);
    return normalize(await res.json());
  }
}
