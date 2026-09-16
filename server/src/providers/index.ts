import type { Config } from "../config";
import type { MtProvider, MtRequest, Providers, TtsProvider, TtsRequest, TtsResult } from "./types";
import { Breaker } from "./fallback";
import { MockStt } from "./stt/mock";
import { AssemblyAiStt } from "./stt/assemblyai";
import { DeepgramStt } from "./stt/deepgram";
import { MockMt } from "./mt/mock";
import { AnthropicMt } from "./mt/anthropic";
import { DeepLMt } from "./mt/deepl";
import { MockTts } from "./tts/mock";
import { ElevenLabsTts } from "./tts/elevenlabs";
import { AzureTts } from "./tts/azure";

export interface FallbackHooks {
  /** Le primaire d'un étage vient d'échouer ; le secours prend le relais. */
  onFallback: (stage: "mt" | "tts", err: Error) => void;
  /** Le primaire répond de nouveau. */
  onRecover: (stage: "mt" | "tts") => void;
}

export class FallbackTts implements TtsProvider {
  readonly name: string;
  private breaker: Breaker;
  constructor(
    private primary: TtsProvider,
    private backup: TtsProvider,
    hooks: FallbackHooks,
  ) {
    this.name = `${primary.name}→${backup.name}`;
    this.breaker = new Breaker(
      (e) => hooks.onFallback("tts", e),
      () => hooks.onRecover("tts"),
    );
  }
  synthesize(req: TtsRequest): Promise<TtsResult> {
    return this.breaker.call(
      () => this.primary.synthesize(req),
      () => this.backup.synthesize(req),
    );
  }
}

export class FallbackMt implements MtProvider {
  readonly name: string;
  private breaker: Breaker;
  constructor(
    private primary: MtProvider,
    private backup: MtProvider,
    hooks: FallbackHooks,
  ) {
    this.name = `${primary.name}→${backup.name}`;
    this.breaker = new Breaker(
      (e) => hooks.onFallback("mt", e),
      () => hooks.onRecover("mt"),
    );
  }
  translate(req: MtRequest): Promise<string> {
    return this.breaker.call(
      () => this.primary.translate(req),
      () => this.backup.translate(req),
    );
  }
}

function makeMt(kind: Config["MT_PROVIDER"], cfg: Config): MtProvider {
  switch (kind) {
    case "anthropic":
      return new AnthropicMt({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.MT_MODEL });
    case "deepl":
      return new DeepLMt({ apiKey: cfg.DEEPL_API_KEY ?? "" });
    default:
      return new MockMt();
  }
}

function makeTts(kind: Config["TTS_PROVIDER"], cfg: Config): TtsProvider {
  switch (kind) {
    case "elevenlabs":
      return new ElevenLabsTts({
        apiKey: cfg.ELEVENLABS_API_KEY ?? "",
        voiceId: cfg.ELEVENLABS_VOICE_ID ?? "",
        voiceByLang: cfg.ELEVENLABS_VOICE_ID_EN ? { en: cfg.ELEVENLABS_VOICE_ID_EN } : undefined,
        model: cfg.ELEVENLABS_MODEL,
      });
    case "azure":
      return new AzureTts({
        key: cfg.AZURE_SPEECH_KEY ?? "",
        region: cfg.AZURE_SPEECH_REGION ?? "",
        voice: cfg.AZURE_TTS_VOICE,
        voiceByLang: { en: cfg.AZURE_TTS_VOICE_EN },
      });
    default:
      return new MockTts();
  }
}

const defaultHooks: FallbackHooks = {
  onFallback: (stage, e) => console.warn(`[${stage}] bascule sur le secours :`, e.message),
  onRecover: (stage) => console.info(`[${stage}] primaire rétabli`),
};

export function makeProviders(cfg: Config, hooks: FallbackHooks = defaultHooks): Providers {
  const stt =
    cfg.STT_PROVIDER === "assemblyai"
      ? new AssemblyAiStt({
          apiKey: cfg.ASSEMBLYAI_API_KEY ?? "",
          model: cfg.ASSEMBLYAI_MODEL,
          region: cfg.ASSEMBLYAI_REGION,
          mode: cfg.ASSEMBLYAI_MODE,
          prompt: cfg.STT_PROMPT,
          keyterms: cfg.STT_KEYTERMS,
          voiceFocus: cfg.ASSEMBLYAI_VOICE_FOCUS === "none" ? undefined : cfg.ASSEMBLYAI_VOICE_FOCUS,
          languageGate: cfg.ASSEMBLYAI_LANGUAGE_GATE,
        })
      : cfg.STT_PROVIDER === "deepgram"
        ? new DeepgramStt({ apiKey: cfg.DEEPGRAM_API_KEY ?? "" })
        : new MockStt({ clock: cfg.MOCK_STT_CLOCK });

  // Un primaire mal configuré doit faire échouer le démarrage ; un secours mal
  // configuré ne doit pas empêcher la salle d'ouvrir — il est juste absent, et ça se voit.
  const tryBackup = <T>(label: string, make: () => T): T | undefined => {
    try {
      return make();
    } catch (err) {
      console.warn(`[providers] secours ${label} ignoré : ${(err as Error).message}`);
      return undefined;
    }
  };

  let mt = makeMt(cfg.MT_PROVIDER, cfg);
  const mtBackup = cfg.MT_BACKUP;
  if (mtBackup !== "none" && mtBackup !== cfg.MT_PROVIDER) {
    const backup = tryBackup(mtBackup, () => makeMt(mtBackup, cfg));
    if (backup) mt = new FallbackMt(mt, backup, hooks);
  }

  let tts = makeTts(cfg.TTS_PROVIDER, cfg);
  const ttsBackup = cfg.TTS_BACKUP;
  if (ttsBackup !== "none" && ttsBackup !== cfg.TTS_PROVIDER) {
    const backup = tryBackup(ttsBackup, () => makeTts(ttsBackup, cfg));
    if (backup) tts = new FallbackTts(tts, backup, hooks);
  }

  return { stt, mt, tts };
}
