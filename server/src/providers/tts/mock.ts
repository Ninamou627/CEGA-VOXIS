/**
 * TTS simulé : produit un vrai fichier WAV jouable, dont la durée correspond à
 * celle d'une voix réelle (~400 ms par mot). Chaque mot est une brève note dont la
 * hauteur dépend du mot — on entend le rythme, les frontières de segment, et surtout
 * la dérive de la file quand le formateur n'arrête pas de parler.
 *
 * Voulu : la sortie est ~15–20 % plus longue que la parole source (le jeton « [fr] »
 * et les expansions du lexique simulé), comme le vrai français. Sans parade, la file
 * des clients grandit — c'est le comportement à observer, pas un défaut du simulateur.
 */
import type { TtsProvider, TtsRequest, TtsResult } from "../types";

const RATE = 16000;
const WORD_MS = 380;
const GAP_MS = 60;
const FADE = 0.02; // 20 ms de fondu, sinon ça claque

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function wavHeader(samples: number, rate = RATE): Uint8Array {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  return new Uint8Array(b);
}

export function synthesizeBeeps(text: string, speed = 1, baseHz = 220): TtsResult {
  const words = text.split(/\s+/).filter(Boolean);
  const wordMs = WORD_MS / speed;
  const totalMs = words.length * (wordMs + GAP_MS);
  const n = Math.round((totalMs / 1000) * RATE);
  const pcm = new Int16Array(n);
  let cursor = 0;
  for (const w of words) {
    const hz = baseHz + (hash(w) % 220);
    const len = Math.round((wordMs / 1000) * RATE);
    const fade = Math.round(FADE * RATE);
    for (let i = 0; i < len && cursor + i < n; i++) {
      const env = Math.min(1, i / fade, (len - i) / fade);
      pcm[cursor + i] = Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * 0.35 * env * 32767);
    }
    cursor += len + Math.round((GAP_MS / 1000) * RATE);
  }
  const header = wavHeader(n);
  const out = new Uint8Array(header.length + pcm.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(pcm.buffer), header.length);
  return { audio: out, mime: "audio/wav", durMs: Math.round(totalMs) };
}

export class MockTts implements TtsProvider {
  readonly name = "mock-tts";

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    await new Promise((r) => setTimeout(r, 180)); // TTFA plausible
    // Une voix plus grave pour l'anglais (questions vers le formateur), plus claire pour le français.
    return synthesizeBeeps(req.text, req.speed ?? 1, req.lang === "en" ? 160 : 260);
  }
}
