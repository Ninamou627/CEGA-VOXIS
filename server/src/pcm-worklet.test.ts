/**
 * Le worklet de captation (client/public/pcm-worklet.js), chargé tel quel dans un bac à sable :
 * en D38 (essai F-03), le contexte audio peut tourner à la fréquence native du micro, et c'est
 * le worklet qui convertit vers 16 kHz — plus le navigateur. Rien ne doit se perdre ni se
 * déformer dans cette conversion, quelle que soit la taille des blocs que le navigateur livre.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../client/public/pcm-worklet.js", import.meta.url)), "utf8");

/** Charge le worklet comme un navigateur le ferait, avec un contexte à `rate` Hz. */
function load(rate: number) {
  const out: number[] = [];
  const frames: number[] = [];
  class AudioWorkletProcessor {
    port = {
      postMessage: (b: ArrayBuffer) => {
        const a = new Int16Array(b);
        frames.push(a.length);
        for (const v of a) out.push(v);
      },
    };
  }
  const sandbox: Record<string, unknown> = {
    sampleRate: rate,
    AudioWorkletProcessor,
    registerProcessor: (_n: string, c: unknown) => {
      sandbox.cls = c;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const Cls = sandbox.cls as new () => { process(i: Float32Array[][]): boolean };
  const p = new Cls();
  return { feed: (ch: Float32Array) => p.process([[ch]]), out, frames };
}

function sine(rate: number, hz: number, seconds: number, amp = 0.5): Float32Array {
  const a = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return a;
}

/** Nourrit le worklet par blocs de `quantum` échantillons, comme le moteur audio du navigateur. */
function feedChunks(w: ReturnType<typeof load>, signal: Float32Array, quantum = 128) {
  for (let i = 0; i < signal.length; i += quantum) w.feed(signal.subarray(i, Math.min(i + quantum, signal.length)));
}

const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const crossings = (a: number[]) => {
  let n = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 !== a[i] < 0) n++;
  return n;
};

describe("pcm-worklet — conversion vers 16 kHz dans la page (D38)", () => {
  it("contexte à 16 kHz : conversion directe, trames de 50 ms, échantillons intacts", () => {
    const w = load(16000);
    const signal = sine(16000, 440, 1);
    feedChunks(w, signal);
    expect(w.out.length).toBe(16000);
    expect(w.frames.every((n) => n === 800)).toBe(true);
    for (let i = 0; i < 100; i++) {
      const s = signal[i];
      expect(Math.abs(w.out[i] - (s < 0 ? s * 0x8000 : s * 0x7fff))).toBeLessThanOrEqual(1);
    }
  });

  it("contexte à 48 kHz : durée conservée, ton préservé (10 s à 1 kHz)", () => {
    const w = load(48000);
    feedChunks(w, sine(48000, 1000, 10));
    // Au plus une trame (50 ms) retenue dans le convertisseur à la fin du signal.
    expect(w.out.length).toBeGreaterThanOrEqual(160000 - 800);
    expect(w.out.length).toBeLessThanOrEqual(160000);
    expect(w.frames.every((n) => n === 800)).toBe(true);
    // Amplitude : 0,5 × 32767 / √2, à 2 % près — le passe-bas ne touche pas 1 kHz.
    expect(rms(w.out)).toBeGreaterThan(0.5 * 0x7fff * Math.SQRT1_2 * 0.98);
    expect(rms(w.out)).toBeLessThan(0.5 * 0x7fff * Math.SQRT1_2 * 1.02);
    // Fréquence : 2 passages à zéro par période, à 0,5 % près.
    const hz = (crossings(w.out) / 2) * (16000 / w.out.length);
    expect(Math.abs(hz - 1000)).toBeLessThan(5);
  });

  it("contexte à 48 kHz : ce qui dépasse le Nyquist de la sortie est filtré, pas replié (11 kHz)", () => {
    const w = load(48000);
    feedChunks(w, sine(48000, 11000, 2));
    // Sans passe-bas, 11 kHz se replierait en un ton à 5 kHz de pleine amplitude.
    expect(rms(w.out) / (0.5 * 0x7fff * Math.SQRT1_2)).toBeLessThan(0.05);
  });

  it("contexte à 44,1 kHz (rapport non entier) : durée et ton conservés", () => {
    const w = load(44100);
    feedChunks(w, sine(44100, 1000, 5));
    expect(w.out.length).toBeGreaterThanOrEqual(80000 - 800);
    expect(w.out.length).toBeLessThanOrEqual(80000);
    const hz = (crossings(w.out) / 2) * (16000 / w.out.length);
    expect(Math.abs(hz - 1000)).toBeLessThan(10);
    expect(rms(w.out)).toBeGreaterThan(0.5 * 0x7fff * Math.SQRT1_2 * 0.98);
  });

  it("le découpage en blocs ne change rien : mêmes échantillons en blocs de 128 et de 997", () => {
    const signal = sine(44100, 731, 2, 0.4);
    const a = load(44100);
    feedChunks(a, signal, 128);
    const b = load(44100);
    feedChunks(b, signal, 997);
    expect(a.out.length).toBe(b.out.length);
    expect(a.out).toEqual(b.out);
  });
});
