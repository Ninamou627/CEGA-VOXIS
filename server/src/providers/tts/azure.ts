/**
 * Azure Neural TTS — secours : robuste, prévisible, trois fois moins cher.
 * REST + SSML. La vitesse passe par <prosody rate="+8%">, les silences de début et de fin par
 * <mstts:silence> (D34).
 * Palier gratuit F0 : 500 000 caractères par mois (≈ 8 h de voix française). Pour cet abonnement
 * étudiant, seule `germanywestcentral` parmi les régions permises offre les voix neuronales (D33).
 */
import type { Lang } from "../../../../shared/protocol";
import { mp3DurationMs } from "../../util/mp3";
import { providerFetch } from "../http";
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

/**
 * Silence fixé en tête et en fin de voix (D34). Sans réglage, Azure met 100 ms de silence avant la
 * phrase et 840 ms après (mesuré sur le serveur). Au test 7, cela faisait près d'1 s de blanc après
 * chaque phrase entendue, contre 272 ms avec ElevenLabs, soit 70 s de silence sur 276 s de voix ;
 * ce silence s'ajoutait à la pause de l'orateur que l'écoute garde déjà (D26). Avec ces valeurs :
 * environ 50 ms avant et 180 ms après, soit ≈ 0,7 s de gagnée par phrase.
 */
const LEADING_SILENCE = "50ms";
const TAILING_SILENCE = "150ms";

/** Le SSML envoyé à Azure : voix, silences fixés, vitesse. */
export function azureSsml(voice: string, text: string, speed = 1): string {
  const locale = voice.split("-").slice(0, 2).join("-"); // fr-FR-DeniseNeural → fr-FR
  const rate = Math.round((speed - 1) * 100);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${voice}">` +
    `<mstts:silence type="Leading-exact" value="${LEADING_SILENCE}"/><mstts:silence type="Tailing-exact" value="${TAILING_SILENCE}"/>` +
    `<prosody rate="${rate >= 0 ? "+" : ""}${rate}%">${escapeXml(text)}</prosody></voice></speak>`
  );
}

export class AzureTts implements TtsProvider {
  readonly name = "azure-neural";

  constructor(private opts: AzureTtsOptions) {
    if (!opts.key || !opts.region) throw new Error("AZURE_SPEECH_KEY / AZURE_SPEECH_REGION manquants");
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const voice = this.opts.voiceByLang?.[req.lang] ?? this.opts.voice;
    const ssml = azureSsml(voice, req.text, req.speed ?? 1);

    // Connexion gardée ouverte entre deux phrases, comme les autres fournisseurs (D20).
    const res = await providerFetch(`https://${this.opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
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
    return { audio, mime: "audio/mpeg", durMs: mp3DurationMs(audio), voice };
  }
}
