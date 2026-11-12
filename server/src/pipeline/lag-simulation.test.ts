/**
 * Retard borné sans rien sauter (D42, audit F-05) : une salle simulée — le vrai pipeline, des
 * moteurs simulés, un téléphone qui joue les voix dans l'ordre et envoie ses accusés — et une
 * parole dense, minute après minute. Rien n'est sauté : chaque voix est jouée.
 *
 * Cas d'effort : chaque segment (3 s de parole, 150 ms de blanc) donne une voix 25 % plus longue
 * que la parole à ×1. Même à ×1,1, la voix dure plus que la parole : sans resserrage, la file
 * grandit sans fin. La voix simulée resserrée retire 2 mots sur 8 — une hypothèse, pas une
 * mesure : ce que Claude retire vraiment reste à mesurer sur une séance réelle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keptPauseMs } from "../../../shared/playback";
import { slope } from "../latency-report";
import { Metrics } from "../metrics";
import type { MtProvider, SttEvents, SttProvider, TtsProvider } from "../providers/types";
import { Pipeline } from "./pipeline";

const T0 = 1_000_000;
/** 100 ms de parole : un ton à −24 dBFS, 16 kHz, PCM 16 bits mono. */
const LOUD = (() => {
  const b = new Uint8Array(3200);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 1600; i++) v.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
  return b;
})();

class FakeStt implements SttProvider {
  readonly name = "fake-stt";
  readonly finalWords = true;
  ev?: SttEvents;
  async start(_o: unknown, ev: SttEvents) {
    this.ev = ev;
    return { sendAudio: () => {}, close: async () => {} };
  }
  async transcribeOnce() {
    return "";
  }
}

const SEG_MS = 3000;
const GAP_MS = 150;
const WORDS = 8;
/** Caractères par seconde de la voix à ×1 : « fr:» + 8 mots de 9 lettres (83 car.) en 3,94 s, 25 % de plus que 3,15 s de parole. */
const CPS = 83 / 3.94;
/** Le texte reconnu arrive 300 ms après la fin de la parole. */
const STT_LAG_MS = 300;

interface Run {
  /** Écoutes : instant, décalage par mot moyen et maximal. */
  heard: { t: number; mean: number; max: number }[];
  tiers: number[];
  maxTier: number;
  maxRetardMs: number;
  tightenCalls: number;
  tightened: number;
  pausesAfterLate: number;
  speeds: number[];
}

async function simulate(minutes: number, o: { tightenWhenLate: boolean; tightenOk?: boolean }): Promise<Run> {
  const stt = new FakeStt();
  const metrics = new Metrics();
  let tightenCalls = 0;
  const mt: MtProvider = {
    name: "fake-mt",
    translate: async (r) => `fr:${r.text}`,
    tighten: async (r) => {
      tightenCalls++;
      // Hésitations et redites retirées : 2 mots sur 8 (hypothèse, voir l'en-tête).
      const w = `fr:${r.text}`.split(" ");
      return o.tightenOk === false ? "x" : [...w.slice(0, 3), ...w.slice(5)].join(" ");
    },
  };
  const speeds: number[] = [];
  const tts: TtsProvider = {
    name: "fake-tts",
    synthesize: async (r) => {
      speeds.push(r.speed ?? 1);
      return { audio: new Uint8Array(1), mime: "audio/mpeg", durMs: Math.round((r.text.length / CPS / (r.speed ?? 1)) * 1000) };
    },
  };
  const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo: true, speechThresholdDb: -35, quickStart: false, joinShort: false, wholeSentences: false, tightenWhenLate: o.tightenWhenLate });
  const pipeline = new Pipeline({ stt, mt, tts }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000, tuning }, metrics);

  const run: Run = { heard: [], tiers: [], maxTier: 0, maxRetardMs: 0, tightenCalls: 0, tightened: 0, pausesAfterLate: 0, speeds };
  pipeline.on("lag", (e) => {
    run.tiers.push(e.tier);
    run.maxTier = Math.max(run.maxTier, e.tier);
  });
  // Le téléphone : il joue chaque voix à la suite de la précédente, pause gardée comprise, et
  // envoie son accusé au début de chacune, avec sa file (D40 : la voix en cours comprise).
  let free = 0;
  let late = false;
  pipeline.on("audio", (e) => {
    const now = Date.now();
    if (late && e.pauseMs != null) run.pausesAfterLate++;
    const pause = keptPauseMs(e.pauseMs, Math.max(0, now - free), Math.max(0, free - now));
    const start = Math.max(now, free) + pause;
    free = start + e.durMs;
    setTimeout(() => {
      const r = metrics.ack("p1", e.seq, e.tOrigin, Math.max(0, free - Date.now()), "fr");
      if (r.wordLag) run.heard.push({ t: Date.now(), mean: r.wordLag.mean, max: r.wordLag.max });
    }, start - now);
  });
  pipeline.on("status", (s) => {
    const l = s.lag?.fr;
    if (l) {
      run.maxRetardMs = Math.max(run.maxRetardMs, l.retardMs);
      late = l.tier >= 1;
    }
  });
  pipeline.on("tr.segment", () => {});

  await pipeline.start();
  const period = SEG_MS + GAP_MS;
  const steps = (minutes * 60_000) / 100;
  let next = 0; // prochain segment à livrer
  for (let i = 1; i <= steps; i++) {
    await vi.advanceTimersByTimeAsync(100);
    pipeline.pushAudio(LOUD);
    const pos = i * 100;
    // Le STT livre le segment k, mots datés, 300 ms après la fin de sa parole.
    while (next * period + SEG_MS + STT_LAG_MS <= pos) {
      const at = next * period;
      const words = Array.from({ length: WORDS }, (_, j) => ({
        text: j === WORDS - 1 ? "abcdefghi." : "abcdefghi",
        startMs: at + (j * SEG_MS) / WORDS,
        endMs: at + ((j + 1) * SEG_MS) / WORDS - 20,
        isFinal: true,
      }));
      stt.ev!.onPartial({ words, isFinal: true });
      next++;
    }
  }
  run.tightenCalls = tightenCalls;
  await pipeline.stop({ drain: false });
  return run;
}

/** Pente (ms/min) et maximum du décalage par mot entre deux instants de la simulation (minutes). */
function window(run: Run, fromMin: number, toMin = Infinity) {
  const pts = run.heard.filter((h) => h.t >= T0 + fromMin * 60_000 && h.t <= T0 + toMin * 60_000);
  return { slope: slope(pts.map((h) => ({ t: h.t, v: h.mean })))?.msPerMin ?? null, max: Math.max(...pts.map((h) => h.max)), n: pts.length };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("retard borné en parole dense (D42)", () => {
  it("sans resserrage : pauses retirées et ×1,1 ne suffisent pas, le retard grandit, l'alerte part", async () => {
    const run = await simulate(10, { tightenWhenLate: false });
    const w = window(run, 3);
    expect(run.tightenCalls).toBe(0); // réglage éteint : jamais appelé
    expect(run.maxTier).toBe(3);
    expect(run.pausesAfterLate).toBe(0); // en retard, aucune pause gardée n'est envoyée
    expect(Math.max(...run.speeds)).toBe(1.1);
    expect(w.slope!).toBeGreaterThan(5000); // ≈ +8 s par minute
    console.info(`[sim] sans resserrage, 10 min : pente ${(w.slope! / 1000).toFixed(2)} s/min, retard max par mot ${(w.max / 1000).toFixed(1)} s, file max ${(run.maxRetardMs / 1000).toFixed(1)} s`);
  }, 120_000);

  it("avec resserrage : 30 minutes, pente entre −0,1 et +0,1 s/min, file sous 8 s, alerte jamais déclenchée", async () => {
    const run = await simulate(30, { tightenWhenLate: true });
    const w = window(run, 5);
    expect(run.maxTier).toBe(2);
    expect(run.maxRetardMs).toBeLessThan(8000);
    expect(Math.abs(w.slope!)).toBeLessThanOrEqual(100);
    expect(run.tightenCalls).toBeGreaterThan(0);
    const all = window(run, 0);
    console.info(
      `[sim] avec resserrage, 30 min : pente ${(w.slope! / 1000).toFixed(3)} s/min (min 5 à 30), ${(all.slope! / 1000).toFixed(3)} s/min (min 0 à 30), retard max par mot ${(w.max / 1000).toFixed(1)} s (${(all.max / 1000).toFixed(1)} s dès la minute 0), file max ${(run.maxRetardMs / 1000).toFixed(1)} s, ${run.tightenCalls} resserrages demandés sur ${run.heard.length} segments`,
    );
  }, 300_000);

  it("une version resserrée refusée par le garde-fou laisse partir la traduction normale", async () => {
    const run = await simulate(5, { tightenWhenLate: true, tightenOk: false });
    expect(run.tightenCalls).toBeGreaterThan(0);
    expect(run.maxTier).toBe(3); // rien n'a été raccourci : le retard grandit comme sans resserrage
  }, 120_000);
});
