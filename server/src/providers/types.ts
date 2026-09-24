/**
 * Interfaces des trois étages IA. Chaque étage a au moins deux implémentations
 * (un simulateur sans clé + un fournisseur réel) derrière la même interface,
 * pour pouvoir basculer à chaud et comparer sur la fixture.
 */
import type { Lang } from "../../../shared/protocol";

export interface Word {
  text: string;
  /** Position dans l'audio (ms), si le fournisseur la donne. */
  startMs?: number;
  endMs?: number;
  /**
   * Le fournisseur garantit que ce mot ne sera plus révisé (AssemblyAI `word_is_final`).
   * Le commit verrouillé peut alors le figer sans attendre une seconde hypothèse.
   */
  isFinal?: boolean;
  /** Confiance du moteur dans ce mot, 0 à 1, s'il la donne (qualité de la reconnaissance). */
  confidence?: number;
}

export interface SttPartial {
  /** Hypothèse COMPLÈTE de l'énoncé courant, pas seulement le delta. */
  words: Word[];
  /** true = transcription finale de l'énoncé : le fournisseur ne la révisera plus. */
  isFinal: boolean;
}

export interface SttEvents {
  onPartial(p: SttPartial): void;
  /** Endpointing du fournisseur (silence). Vaut pour la fin de l'énoncé courant. */
  onUtteranceEnd(): void;
  /**
   * L'énoncé courant doit être oublié SANS être prononcé (autre langue, bruit) :
   * ce qui n'a pas encore été envoyé à la traduction est abandonné.
   */
  onDiscard(): void;
  onError(err: Error): void;
}

export interface SttStream {
  /** PCM 16 bits little-endian mono. */
  sendAudio(pcm: Uint8Array): void;
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: string;
  start(opts: { lang: Lang; sampleRate: number }, events: SttEvents): Promise<SttStream>;
  /** Transcription en un bloc (questions des apprenants). */
  transcribeOnce(audio: Uint8Array, mime: string, lang: Lang): Promise<string>;
}

export interface MtRequest {
  text: string;
  from: Lang;
  to: Lang;
  /** Segments précédents (source, cible) pour la continuité ; les plus récents en dernier. */
  context: { src: string; tgt: string }[];
  glossary?: Record<string, string>;
  /** Contexte linguistique de la séance : sujet, public, registre. */
  domain?: string;
}

export interface MtProvider {
  readonly name: string;
  translate(req: MtRequest): Promise<string>;
}

export interface TtsRequest {
  text: string;
  lang: Lang;
  /** 1.0 = normal. Levier de rattrapage de la dérive (§09 de la revue). */
  speed?: number;
  /** true = ce segment continue le précédent (prosodie enchaînée, pas de « début de phrase »). */
  continuation?: boolean;
  /** Impose une voix (écoute d'essai depuis l'administration) au lieu de celle par défaut. */
  voice?: string;
}

export interface TtsResult {
  audio: Uint8Array;
  mime: string;
  durMs: number;
  /** Voix qui a réellement parlé : la naturalité perçue se compte par voix. */
  voice?: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export interface Providers {
  stt: SttProvider;
  mt: MtProvider;
  tts: TtsProvider;
}
