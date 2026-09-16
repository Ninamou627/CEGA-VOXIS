/**
 * STT simulé. Aucune clé, aucun réseau.
 *
 * Il « transcrit » un cours canné à 150 mots/minute, en émettant des hypothèses
 * partielles toutes les 250 ms comme un vrai moteur streaming — y compris avec
 * des révisions du dernier mot, pour que le commit verrouillé soit réellement
 * exercé. Entre deux phrases, il signale une fin d'énoncé.
 *
 * Horloge :
 *   - "audio" : avance au rythme de l'audio reçu (rien ne se passe sans micro) ;
 *   - "timer" : avance toute seule (démo sans micro).
 */
import type { Lang } from "../../../../shared/protocol";
import type { SttEvents, SttPartial, SttProvider, SttStream, Word } from "../types";

const SCRIPT = [
  "Today we're going to discuss how the pipeline handles partial transcripts, and why that matters for latency.",
  "The key idea is simple: we never speak a word until it has appeared twice in a row.",
  "That sounds slow, but in practice it costs about four hundred milliseconds.",
  "Okay.",
  "Now, the second problem is drift, which nobody talks about, and which will absolutely ruin your demo.",
  "French is roughly eighteen percent longer than English, so the queue grows whenever I don't pause.",
  "So we condense, we speed up the voice a little, and we drop the oldest segment when the queue gets too deep.",
  "Any questions so far?",
];

const WORD_MS = 400; // 150 mots / minute
const PAUSE_MS = 700; // silence entre deux phrases
const PARTIAL_EVERY_MS = 250;

/** Générateur pseudo-aléatoire déterministe (mulberry32). Les tests sont reproductibles. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function garble(w: string): string {
  const core = w.replace(/[^\p{L}']/gu, "");
  if (core.length < 4) return w;
  return core.slice(0, -1); // « discuss » → « discus » : révisé au partiel suivant
}

export class MockStt implements SttProvider {
  readonly name = "mock-stt";
  constructor(private opts: { clock: "audio" | "timer"; seed?: number } = { clock: "audio" }) {}

  async start(opts: { lang: Lang; sampleRate: number }, ev: SttEvents): Promise<SttStream> {
    const rand = rng(this.opts.seed ?? 42);
    const bytesPerMs = (opts.sampleRate * 2) / 1000;
    let clockMs = 0;
    let lastEmitMs = 0;
    let sentence = 0;
    let sentenceStartMs = 0;
    let inPause = false;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;

    const words = () => SCRIPT[sentence % SCRIPT.length].split(" ");

    const advance = (ms: number) => {
      if (closed) return;
      clockMs += ms;
      if (clockMs - lastEmitMs < PARTIAL_EVERY_MS) return;
      lastEmitMs = clockMs;

      const elapsed = clockMs - sentenceStartMs;
      const ws = words();
      const total = ws.length * WORD_MS;

      if (inPause) {
        if (elapsed >= total + PAUSE_MS) {
          inPause = false;
          sentence++;
          sentenceStartMs = clockMs;
        }
        return;
      }

      const spoken = Math.min(ws.length, Math.floor(elapsed / WORD_MS) + 1);
      const hyp: Word[] = ws.slice(0, spoken).map((text, i) => ({ text, startMs: i * WORD_MS, endMs: (i + 1) * WORD_MS }));

      if (elapsed >= total) {
        // Fin de phrase : transcription finale, puis fin d'énoncé.
        ev.onPartial({ words: hyp, isFinal: true });
        ev.onUtteranceEnd();
        inPause = true;
        return;
      }

      // Instabilité réaliste : le dernier mot est parfois mal entendu, corrigé au partiel suivant.
      const partial: SttPartial = { words: hyp.map((w) => ({ ...w })), isFinal: false };
      if (spoken > 1 && rand() < 0.35) {
        const last = partial.words[partial.words.length - 1];
        last.text = garble(last.text);
      }
      ev.onPartial(partial);
    };

    if (this.opts.clock === "timer") {
      timer = setInterval(() => advance(100), 100);
    }

    return {
      sendAudio: (pcm) => {
        if (this.opts.clock === "audio") advance(pcm.byteLength / bytesPerMs);
      },
      close: async () => {
        closed = true;
        if (timer) clearInterval(timer);
      },
    };
  }

  async transcribeOnce(_audio: Uint8Array, _mime: string, lang: Lang): Promise<string> {
    return lang === "fr"
      ? "Est-ce que vous pouvez répéter la partie sur la dérive, s'il vous plaît ?"
      : "Could you repeat the part about drift, please?";
  }
}
