/**
 * Azure Neural TTS — secours : robuste, prévisible, trois fois moins cher.
 * REST + SSML. La vitesse passe par <prosody rate="+8%">.
 */
import type { Lang } from "../../../../shared/protocol";
import { mp3DurationMs } from "../../util/mp3";
import type { TtsProvider, TtsRequest, TtsResult } from "../types";

export interface AzureTtsOptions {
  key: string;
  region: string;
  /** Voix par défaut, ex. fr-FR-DeniseNeural. */
  voice: string;
  voiceByLang?: Partial<Record<Lang, string>>;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export class AzureTts implements TtsProvider {
  readonly name = "azure-neural";

  constructor(private opts: AzureTtsOptions) {
    if (!opts.key || !opts.region) throw new Error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION manquants");
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const voice = this.opts.voiceByLang?.[req.lang] ?? this.opts.voice;
    const locale = voice.split("-").slice(0, 2).join("-"); // fr-FR-DeniseNeural → fr-FR
    const rate = Math.round(((req.speed ?? 1) - 1) * 100);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
      `<voice name="${voice}"><prosody rate="${rate >= 0 ? "+" : ""}${rate}%">${escapeXml(req.text)}</prosody></voice></speak>`;

    const res = await fetch(`https://${this.opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": this.opts.key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "interprete-salle",
      },
      body: ssml,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Azure TTS ${res.status} : ${(await res.text()).slice(0, 300)}`);

    const audio = new Uint8Array(await res.arrayBuffer());
    return { audio, mime: "audio/mpeg", durMs: mp3DurationMs(audio) };
  }
}
