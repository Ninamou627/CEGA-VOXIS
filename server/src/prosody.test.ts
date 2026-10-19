import { describe, expect, it } from "vitest";
import { wavHeader } from "./providers/tts/mock";
import { analyzeFrames, pearson, readWav, spanFeatures, speechThreshold, syllables, wordErrorRate, type Pcm } from "./prosody";

const SR = 16000;

/** Une « voix » synthétique : un son périodique dont la hauteur suit `hz(t)`, avec des silences. */
function voice(parts: { ms: number; hz?: (t: number) => number }[]): Pcm {
  const total = parts.reduce((a, p) => a + p.ms, 0);
  const samples = new Float32Array(Math.round((total / 1000) * SR));
  let i = 0;
  let phase = 0;
  for (const p of parts) {
    const n = Math.round((p.ms / 1000) * SR);
    for (let k = 0; k < n; k++, i++) {
      if (!p.hz) continue;
      phase += (2 * Math.PI * p.hz(k / SR)) / SR;
      // Fondamentale + deux harmoniques, comme une voix voisée.
      samples[i] = 0.3 * Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase);
    }
  }
  return { samples, sampleRate: SR };
}

describe("prosodie mesurée sur l'audio", () => {
  it("retrouve la hauteur d'un son voisé", () => {
    const frames = analyzeFrames(voice([{ ms: 1000, hz: () => 200 }]));
    const f0s = frames.map((f) => f.f0).filter((f): f is number => f != null);
    expect(f0s.length).toBeGreaterThan(40);
    const median = [...f0s].sort((a, b) => a - b)[Math.floor(f0s.length / 2)];
    expect(median).toBeGreaterThan(195);
    expect(median).toBeLessThan(205);
  });

  it("distingue une fin qui monte (question) d'une fin qui descend", () => {
    const rising = analyzeFrames(voice([{ ms: 700, hz: () => 150 }, { ms: 300, hz: (t) => 150 + 300 * t }]));
    const falling = analyzeFrames(voice([{ ms: 700, hz: () => 150 }, { ms: 300, hz: (t) => 150 - 150 * t }]));
    const up = spanFeatures(rising, 0, 1000, speechThreshold(rising)).finalMoveSt!;
    const down = spanFeatures(falling, 0, 1000, speechThreshold(falling)).finalMoveSt!;
    expect(up).toBeGreaterThan(2);
    expect(down).toBeLessThan(-2);
  });

  it("compte les pauses internes et le temps de parole", () => {
    const frames = analyzeFrames(voice([{ ms: 500, hz: () => 180 }, { ms: 400 }, { ms: 500, hz: () => 180 }, { ms: 100 }, { ms: 300, hz: () => 180 }]));
    const f = spanFeatures(frames, 0, 1800, speechThreshold(frames));
    expect(f.pauses).toHaveLength(1); // 400 ms ; 100 ms n'est pas une pause
    expect(f.pauses[0]).toBeGreaterThanOrEqual(380);
    expect(f.speechMs).toBeGreaterThan(1200);
    expect(f.speechMs).toBeLessThan(1400);
  });

  it("une voix plate a moins d'étendue de hauteur qu'une voix animée", () => {
    const flat = analyzeFrames(voice([{ ms: 1000, hz: () => 160 }]));
    const lively = analyzeFrames(voice([{ ms: 1000, hz: (t) => 160 + 60 * Math.sin(2 * Math.PI * 2 * t) }]));
    const a = spanFeatures(flat, 0, 1000, speechThreshold(flat)).f0RangeSt!;
    const b = spanFeatures(lively, 0, 1000, speechThreshold(lively)).f0RangeSt!;
    expect(b).toBeGreaterThan(a + 3);
  });

  it("lit un WAV PCM 16 bits", () => {
    const pcm = new Int16Array([0, 16384, -16384]);
    const buf = new Uint8Array(44 + 6);
    buf.set(wavHeader(3, 22050));
    buf.set(new Uint8Array(pcm.buffer), 44);
    const w = readWav(buf);
    expect(w.sampleRate).toBe(22050);
    expect([...w.samples]).toEqual([0, 0.5, -0.5]);
  });
});

describe("débit, corrélation, intelligibilité", () => {
  it("compte les syllabes écrites, e muet compris", () => {
    expect(syllables("The pipeline handles partial transcripts", "en")).toBe(9);
    expect(syllables("Le principe est simple", "fr")).toBe(5);
    expect(syllables("Aujourd'hui, nous allons voir", "fr")).toBe(7);
  });

  it("corrélation : 1 quand deux séries varient ensemble, null sans variation", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("taux d'erreur sur les mots, insensible à la casse et à la ponctuation", () => {
    expect(wordErrorRate("Le principe est simple.", "le principe est simple")).toBe(0);
    expect(wordErrorRate("Le principe est simple.", "le principe simple")).toBe(0.25);
    expect(wordErrorRate("Le principe est simple.", "le principe est très simple")).toBe(0.25);
  });
});
