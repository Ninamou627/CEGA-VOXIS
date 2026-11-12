import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "./metrics";

/** Un segment de 4 mots dit en 2 s, sa voix de 3 s en français, écoutée à `play`. */
function heard(m: Metrics, seq: number, tStart: number, play: number, who = "a", lang: "fr" | "es" = "fr") {
  vi.setSystemTime(tStart + 2300);
  m.segmentEnd(seq, { tOrigin: tStart + 800, tEnd: tStart + 2000, tStart, turnStart: false, words: 4, wordStarts: null });
  m.voice(seq, lang, 3000);
  vi.setSystemTime(play);
  return m.ack(who, seq, tStart + 800, 3000, lang);
}

describe("indicateurs de premier rang en direct (D41)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("calcule le décalage de chaque mot à l'ack, dans la langue écoutée", () => {
    const m = new Metrics();
    const t0 = 1_000_000;
    const r = heard(m, 1, t0, t0 + 3500);
    // mot k : 3500 + k/4·3000 − k/4·2000
    expect(r.wordLag).toMatchObject({ mean: 3875, max: 4250, n: 4, outage: false, lags: [3500, 3750, 4000, 4250] });
    const s = m.snapshot();
    expect(s.wordLagP50).toBe(3750);
    expect(s.lagMaxMs).toBe(4250);
    // Une langue dont la voix n'est pas connue ne fabrique pas de mesure.
    vi.setSystemTime(t0 + 3600);
    expect(m.ack("b", 1, t0 + 800, 0, "es").wordLag).toBeNull();
  });

  it("écarte les écoutes d'un segment qui a traversé une panne", () => {
    const m = new Metrics();
    const t0 = 1_000_000;
    vi.setSystemTime(t0 + 1000);
    m.degraded("stt-lost", "flux coupé");
    vi.setSystemTime(t0 + 15_000);
    m.degraded("none", "flux rouvert");
    const late = heard(m, 1, t0, t0 + 20_000);
    expect(late.wordLag?.outage).toBe(true);
    heard(m, 2, t0 + 30_000, t0 + 33_500);
    const s = m.snapshot();
    expect(s.lagMaxMs).toBe(4250); // le segment 2, pas les 20 s du segment 1
  });

  it("ne donne la pente qu'au-delà de 3 minutes de mesures", () => {
    const m = new Metrics();
    const t0 = 1_000_000;
    // Un segment toutes les 10 s, chacun écouté 100 ms plus tard que le précédent : ≈ +0,6 s/min.
    for (let i = 0; i < 12; i++) heard(m, i + 1, t0 + i * 10_000, t0 + i * 10_000 + 3500 + i * 100);
    expect(m.snapshot().lagSlopeMsPerMin).toBeNull(); // 1 min 50 s
    for (let i = 12; i < 24; i++) heard(m, i + 1, t0 + i * 10_000, t0 + i * 10_000 + 3500 + i * 100);
    expect(m.snapshot().lagSlopeMsPerMin).toBe(594); // 100 ms pour 10,1 s entre deux écoutes
  });

});
