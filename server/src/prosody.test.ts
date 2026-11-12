import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wavHeader } from "./providers/tts/mock";
import { analyzeFrames, LiveProsody, pearson, ProsodyFeed, readWav, spanFeatures, speechThreshold, syllables, wordErrorRate, type Pcm } from "./prosody";

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

describe("LiveProsody — la même analyse, au fil de l'audio (D28)", () => {
  it("donne les mêmes fenêtres que l'analyse d'un bloc, trame de 50 ms après trame", async () => {
    const pcm = voice([{ ms: 600, hz: (t) => 140 + 80 * t }, { ms: 300 }, { ms: 900, hz: (t) => 220 - 60 * t }, { ms: 200 }]);
    const whole = analyzeFrames(pcm);
    const live = new LiveProsody(SR);
    const bytes = new Uint8Array(pcm.samples.length * 2);
    const v = new DataView(bytes.buffer);
    pcm.samples.forEach((x, i) => v.setInt16(i * 2, Math.round(x * 32767), true));
    for (let i = 0; i < bytes.length; i += 1600) live.push(bytes.subarray(i, Math.min(bytes.length, i + 1600)));
    const got = live.between(0, 1e9);
    // Les dernières fenêtres attendent l'audio qui suit ; toutes les autres sont identiques.
    expect(got.length).toBeGreaterThan(whole.length - 15);
    for (let i = 0; i < got.length; i++) {
      expect(got[i].t).toBeCloseTo(whole[i].t, 6);
      expect(got[i].db).toBeCloseTo(whole[i].db, 1); // l'audio repasse par des entiers 16 bits
      if (whole[i].f0 == null) expect(got[i].f0).toBeNull();
      else expect(got[i].f0!).toBeCloseTo(whole[i].f0!, 0);
    }
  });
});

/**
 * `ProsodyFeed` (D39) : l'analyse de la hauteur ne fige plus la boucle d'événements. Une
 * rafale (rejeu d'une réouverture STT, D37) s'analyse par tranches bornées, dans l'ordre ;
 * un segment à décrire force l'analyse jusqu'à sa fin ; un nouveau flux remet tout à zéro.
 */
/** Une trame de 100 ms à 16 kHz. Son premier octet la numérote, pour vérifier l'ordre. */
const frame = (n: number) => {
  const b = new Uint8Array(3200);
  b[0] = n % 256;
  return b;
};
describe("ProsodyFeed — l'analyse par tranches bornées (D39)", () => {
  let live: LiveProsody;
  let fed: number[];
  let feed: ProsodyFeed;

  beforeEach(() => {
    vi.useFakeTimers();
    live = new LiveProsody(16000);
    fed = [];
    vi.spyOn(live, "push").mockImplementation((pcm: Uint8Array) => fed.push(pcm[0]));
    feed = new ProsodyFeed(live, 16000, 500);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("au fil de l'eau, chaque trame est analysée tout de suite", () => {
    feed.push(frame(1));
    feed.push(frame(2));
    expect(fed).toEqual([1, 2]);
    expect(feed.fedMs).toBe(200);
    expect(feed.pendingMs).toBe(0);
  });

  it("une rafale s'analyse par tranches de 500 ms d'audio, pas d'un bloc", async () => {
    for (let i = 0; i < 100; i++) feed.push(frame(i)); // 10 s d'un coup
    // Dans ce tour de boucle : le budget (5 trames de 100 ms), pas plus.
    expect(fed.length).toBe(5);
    expect(feed.pendingMs).toBe(9500);
    // Les tours suivants résorbent la file, l'ordre intact.
    await vi.advanceTimersByTimeAsync(0);
    expect(fed.length).toBeGreaterThan(5);
    await vi.runAllTimersAsync();
    expect(fed).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(feed.fedMs).toBe(10_000);
  });

  it("ce qui arrive pendant la résorption passe derrière la file, dans l'ordre", async () => {
    for (let i = 0; i < 20; i++) feed.push(frame(i)); // 2 s en attente
    feed.push(frame(20)); // le direct continue
    expect(fed.length).toBe(5); // rien ne double la file
    await vi.advanceTimersByTimeAsync(10);
    expect(fed).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it("décrire un segment force l'analyse jusqu'à sa fin, sans attendre la résorption", () => {
    for (let i = 0; i < 100; i++) feed.push(frame(i));
    feed.drainTo(3000); // un segment finit à 3 s
    expect(feed.fedMs).toBeGreaterThanOrEqual(3000);
    expect(fed.length).toBe(30);
    expect(feed.pendingMs).toBe(7000);
  });

  it("un nouveau flux STT vide la file et repart de zéro", async () => {
    for (let i = 0; i < 50; i++) feed.push(frame(i));
    feed.reset();
    expect(feed.fedMs).toBe(0);
    expect(feed.pendingMs).toBe(0);
    feed.push(frame(200));
    await vi.advanceTimersByTimeAsync(10);
    // Les 45 trames en attente de l'ancien flux ne sont jamais analysées.
    expect(fed.filter((n) => n === 200)).toHaveLength(1);
    expect(fed.length).toBe(6);
    expect(feed.fedMs).toBe(100);
  });
});
