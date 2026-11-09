import type { MtEngineInfo } from "../../../shared/admin";
import type { Lang } from "../../../shared/protocol";
import type { Config } from "../config";
import { parseGlossary, parseKeyterms, type MtEngine, type Settings } from "../settings";
import type { MtProvider, MtRequest, Providers, TtsProvider, TtsRequest, TtsResult } from "./types";
import { Breaker, retryTransient } from "./fallback";
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

/**
 * Une voix qui échoue pour une raison passagère est redemandée une fois, au même moteur :
 * la salle garde sa voix. Un refus (crédits épuisés, clé refusée) passe aussitôt au secours (D33).
 */
export class RetryingTts implements TtsProvider {
  constructor(
    private readonly inner: TtsProvider,
    private readonly delayMs = 300,
    private readonly onRetry: (err: Error) => void = (e) => console.warn(`[tts] ${inner.name} : nouvel essai après « ${e.message.slice(0, 120)} »`),
  ) {}
  get name(): string {
    return this.inner.name;
  }
  synthesize(req: TtsRequest): Promise<TtsResult> {
    return retryTransient(() => this.inner.synthesize(req), this.delayMs, this.onRetry);
  }
  warm(force?: boolean): Promise<void> {
    return this.inner.warm?.(force) ?? Promise.resolve();
  }
}

export class FallbackTts implements TtsProvider {
  private breaker: Breaker;
  constructor(
    private primary: TtsProvider,
    private backup: TtsProvider,
    hooks: FallbackHooks,
  ) {
    this.breaker = new Breaker(
      (e) => hooks.onFallback("tts", e),
      () => hooks.onRecover("tts"),
    );
  }
  get name(): string {
    return `${this.primary.name}→${this.backup.name}`;
  }
  synthesize(req: TtsRequest): Promise<TtsResult> {
    return this.breaker.call(
      () => this.primary.synthesize(req),
      () => this.backup.synthesize(req),
    );
  }
  /** Le secours aussi : s'il prend le relais, sa première phrase ne doit pas payer la connexion. */
  async warm(force?: boolean): Promise<void> {
    await Promise.all([this.primary.warm?.(force), this.backup.warm?.(force)]);
  }
}

export class FallbackMt implements MtProvider {
  private breaker: Breaker;
  constructor(
    private primary: MtProvider,
    private backup: MtProvider,
    hooks: FallbackHooks,
  ) {
    this.breaker = new Breaker(
      (e) => hooks.onFallback("mt", e),
      () => hooks.onRecover("mt"),
    );
  }
  get name(): string {
    return `${this.primary.name}→${this.backup.name}`;
  }
  translate(req: MtRequest): Promise<string> {
    return this.breaker.call(
      () => this.primary.translate(req),
      () => this.backup.translate(req),
    );
  }
  async warm(force?: boolean): Promise<void> {
    await Promise.all([this.primary.warm?.(force), this.backup.warm?.(force)]);
  }
}

/**
 * Traduction à moteurs interchangeables à chaud. Tous les moteurs configurés sont
 * construits au démarrage ; choisir un autre primaire ou secours dans l'administration
 * reconstruit seulement la chaîne. Le glossaire et le contexte de séance sont relus à
 * chaque segment.
 *
 * Le glossaire s'écrit dans le sens du formateur (« terme source = rendu imposé ») : pour une
 * question d'apprenant, traduite vers la langue du formateur, il est retourné.
 */
export class SwitchableMt implements MtProvider {
  private chain!: MtProvider;

  constructor(
    private readonly engines: Partial<Record<MtEngine, MtProvider>>,
    private readonly hooks: FallbackHooks,
    private readonly settings: () => Settings,
    private readonly srcLang: Lang,
  ) {
    this.rebuild();
  }

  get name(): string {
    return this.chain.name;
  }

  /** À appeler quand le primaire ou le secours change. */
  rebuild(): void {
    const t = this.settings().translation;
    const primary = this.engines[t.primary] ?? this.engines.mock!;
    const backup = t.secondary !== "none" && t.secondary !== t.primary ? this.engines[t.secondary] : undefined;
    this.chain = backup ? new FallbackMt(primary, backup, this.hooks) : primary;
  }

  translate(req: MtRequest): Promise<string> {
    const t = this.settings().translation;
    const glossary = parseGlossary(t.glossary);
    const oriented = !glossary || req.from === this.srcLang ? glossary : Object.fromEntries(Object.entries(glossary).map(([k, v]) => [v, k]));
    return this.chain.translate({ ...req, glossary: oriented, domain: t.domain.trim() || undefined });
  }

  warm(force?: boolean): Promise<void> {
    return this.chain.warm?.(force) ?? Promise.resolve();
  }
}

function makeTts(kind: Config["TTS_PROVIDER"], cfg: Config, settings: () => Settings): TtsProvider {
  switch (kind) {
    case "elevenlabs":
      return new ElevenLabsTts({
        apiKey: cfg.ELEVENLABS_API_KEY ?? "",
        voiceId: cfg.ELEVENLABS_VOICE_ID ?? "",
        voiceByLang: cfg.ELEVENLABS_VOICE_ID_EN ? { en: cfg.ELEVENLABS_VOICE_ID_EN } : undefined,
        model: cfg.ELEVENLABS_MODEL,
        tuning: () => {
          const v = settings().voice;
          return { defaults: v.defaults, stability: v.stability, style: v.style };
        },
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

export interface RoomProviders extends Providers {
  mt: SwitchableMt;
  /** Moteurs de traduction proposés à l'administration. */
  mtEngines: MtEngineInfo[];
  /** Instance ElevenLabs (primaire ou secours) pour les écoutes d'essai, si configurée. */
  elevenlabs?: ElevenLabsTts;
}

export function makeProviders(cfg: Config, settings: () => Settings, hooks: FallbackHooks = defaultHooks): RoomProviders {
  const speech = () => settings().speech;
  const stt =
    cfg.STT_PROVIDER === "assemblyai"
      ? new AssemblyAiStt({
          apiKey: cfg.ASSEMBLYAI_API_KEY ?? "",
          model: cfg.ASSEMBLYAI_MODEL,
          region: cfg.ASSEMBLYAI_REGION,
          voiceFocus: cfg.ASSEMBLYAI_VOICE_FOCUS === "none" ? undefined : cfg.ASSEMBLYAI_VOICE_FOCUS,
          languageGate: cfg.ASSEMBLYAI_LANGUAGE_GATE,
          live: () => ({ mode: speech().endpointing, keyterms: parseKeyterms(speech().keyterms), prompt: speech().prompt.trim() || undefined }),
        })
      : cfg.STT_PROVIDER === "deepgram"
        ? new DeepgramStt({ apiKey: cfg.DEEPGRAM_API_KEY ?? "" })
        : new MockStt({ clock: cfg.MOCK_STT_CLOCK });

  // Un primaire mal configuré doit faire échouer le démarrage ; un secours mal
  // configuré ne doit pas empêcher la salle d'ouvrir — il est juste absent, et ça se voit.
  const tryBuild = <T>(label: string, make: () => T): T | undefined => {
    try {
      return make();
    } catch (err) {
      console.warn(`[providers] ${label} ignoré : ${(err as Error).message}`);
      return undefined;
    }
  };

  // ---- traduction : tous les moteurs disponibles, choisis à chaud ----------------
  const translation = () => settings().translation;
  const engines: Partial<Record<MtEngine, MtProvider>> = { mock: new MockMt() };
  // Sans clé dans le .env, le SDK peut encore trouver des identifiants (profil `ant auth`) :
  // on tente la construction, et c'est la première traduction qui dira si ça répond.
  engines.anthropic = tryBuild("moteur Claude", () => new AnthropicMt({ apiKey: cfg.ANTHROPIC_API_KEY, tuning: translation }));
  if (cfg.DEEPL_API_KEY)
    engines.deepl = tryBuild("moteur DeepL", () => new DeepLMt({ apiKey: cfg.DEEPL_API_KEY!, timeoutMs: () => translation().timeoutMs, mainFrom: cfg.SRC_LANG, log: (m) => console.warn(`[providers] ${m}`) }));
  const mtEngines: MtEngineInfo[] = [
    {
      id: "anthropic",
      label: "Claude",
      available: Boolean(engines.anthropic && (cfg.ANTHROPIC_API_KEY || cfg.MT_PROVIDER === "anthropic" || cfg.MT_BACKUP === "anthropic")),
      reason: cfg.ANTHROPIC_API_KEY ? undefined : "clé d'API Anthropic absente du serveur",
    },
    { id: "deepl", label: "DeepL", available: Boolean(engines.deepl), reason: engines.deepl ? undefined : "clé d'API DeepL absente du serveur" },
    { id: "mock", label: "Simulateur", available: true },
  ];
  // Le primaire du .env doit fonctionner, sinon la salle n'ouvre pas ; un primaire choisi
  // plus tard dans l'administration dont la clé a disparu retombe sur le simulateur, et ça se voit.
  const primary = settings().translation.primary;
  if (!engines[primary]) {
    if (primary === cfg.MT_PROVIDER) throw new Error(`moteur de traduction « ${primary} » indisponible (clé manquante ?)`);
    console.warn(`[providers] moteur de traduction « ${primary} » indisponible : simulateur en attendant`);
  }
  const mt = new SwitchableMt(engines, hooks, settings, cfg.SRC_LANG);

  // ---- voix -----------------------------------------------------------------------
  // Chaque moteur retente une panne passagère ; un refus du primaire passe au secours (D33).
  const primaryTts = makeTts(cfg.TTS_PROVIDER, cfg, settings);
  let elevenlabs = primaryTts instanceof ElevenLabsTts ? primaryTts : undefined;
  let tts: TtsProvider = new RetryingTts(primaryTts);
  const ttsBackup = cfg.TTS_BACKUP;
  if (ttsBackup !== "none" && ttsBackup !== cfg.TTS_PROVIDER) {
    const backup = tryBuild(`secours ${ttsBackup}`, () => makeTts(ttsBackup, cfg, settings));
    if (backup) {
      if (backup instanceof ElevenLabsTts) elevenlabs = backup;
      tts = new FallbackTts(tts, new RetryingTts(backup), hooks);
    }
  }

  return { stt, mt, tts, mtEngines, elevenlabs };
}
