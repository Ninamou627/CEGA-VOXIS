/**
 * ElevenLabs — TTS primaire (Turbo v2.5 par défaut).
 *
 * Continuité entre segments (§08 de la revue) : « request stitching ». Chaque appel
 * reçoit le texte du segment précédent (`previous_text`) et les `request-id` des
 * trois générations précédentes (`previous_request_ids`), ce qui conditionne la
 * prosodie sur ce qui vient d'être dit. Sans ça, chaque segment attaque sur une
 * intonation de début de phrase et on obtient l'effet « liste de phrases ».
 *
 * Étape suivante (semaine 3) : le WebSocket multi-contexte avec `new_turn`, qui fait
 * la même chose en flux continu et gagne ~100 ms de premier octet.
 */
import type { Lang } from "../../../../shared/protocol";
import { mp3DurationMs } from "../../util/mp3";
import { providerFetch, WarmLink } from "../http";
import type { TtsProvider, TtsRequest, TtsResult } from "../types";

/** Réglages de l'administration, relus à chaque segment. */
export interface ElevenLabsTuning {
  /** Voix par défaut par langue ; l'emporte sur celles du .env. */
  defaults: Partial<Record<Lang, string>>;
  stability: number;
  style: number;
}

export interface ElevenLabsOptions {
  apiKey: string;
  /** Voix par défaut (langue cible principale). */
  voiceId: string;
  tuning?: () => ElevenLabsTuning;
  /** Voix par langue, ex. { en: "…" } pour les questions vers le formateur. */
  voiceByLang?: Partial<Record<Lang, string>>;
  model?: string;
  /** mp3_44100_64 : 64 kbit/s suffisent pour de la parole, et ménagent le Wi-Fi de salle. */
  outputFormat?: string;
}

export class ElevenLabsTts implements TtsProvider {
  readonly name: string;
  private readonly model: string;
  private readonly format: string;
  /** Contexte de continuité par langue. */
  private last = new Map<Lang, { text: string; ids: string[] }>();
  private readonly link: WarmLink;

  constructor(private opts: ElevenLabsOptions) {
    if (!opts.apiKey) throw new Error("ELEVENLABS_API_KEY manquant");
    if (!opts.voiceId) throw new Error("ELEVENLABS_VOICE_ID manquant");
    this.model = opts.model ?? "eleven_turbo_v2_5";
    this.format = opts.outputFormat ?? "mp3_44100_64";
    this.name = `elevenlabs:${this.model}`;
    // La liste des modèles est gratuite : de quoi garder la connexion sans décompter de caractères (D20).
    this.link = new WarmLink(() =>
      providerFetch("https://api.elevenlabs.io/v1/models", { headers: { "xi-api-key": opts.apiKey }, signal: AbortSignal.timeout(5000) }).then((r) => r.arrayBuffer()),
    );
  }

  warm(force?: boolean): Promise<void> {
    return this.link.warm(force);
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    this.link.used();
    const t = this.opts.tuning?.();
    // `||` et non `??` : un identifiant vide ne doit jamais partir dans l'URL.
    const voice = req.voice || t?.defaults[req.lang] || this.opts.voiceByLang?.[req.lang] || this.opts.voiceId;
    // Une écoute d'essai (voix imposée) ne doit ni profiter ni perturber la continuité de la séance.
    const trial = Boolean(req.voice);
    const prev = req.continuation && !trial ? this.last.get(req.lang) : undefined;

    const body: Record<string, unknown> = {
      text: req.text,
      model_id: this.model,
      language_code: req.lang,
      voice_settings: {
        stability: t?.stability ?? 0.5,
        similarity_boost: 0.75,
        style: t?.style ?? 0,
        // Levier de rattrapage de la dérive. ElevenLabs accepte 0,7 → 1,2.
        speed: Math.min(1.2, Math.max(0.7, req.speed ?? 1)),
      },
      apply_text_normalization: "auto",
    };
    if (prev) {
      body.previous_text = prev.text;
      if (prev.ids.length) body.previous_request_ids = prev.ids.slice(-3);
    }

    const res = await providerFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${this.format}`, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status} : ${(await res.text()).slice(0, 300)}`);

    const audio = new Uint8Array(await res.arrayBuffer());
    if (!trial) {
      const requestId = res.headers.get("request-id");
      const entry = this.last.get(req.lang) ?? { text: "", ids: [] };
      entry.text = req.text;
      if (requestId) entry.ids = [...entry.ids, requestId].slice(-3);
      this.last.set(req.lang, entry);
    }

    return { audio, mime: "audio/mpeg", durMs: mp3DurationMs(audio), voice };
  }

  /** À appeler à une vraie fin de tour (question, longue pause) : repart sur une intonation neutre. */
  resetContinuity(lang?: Lang): void {
    if (lang) this.last.delete(lang);
    else this.last.clear();
  }
}
