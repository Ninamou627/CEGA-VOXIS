import { describe, expect, it } from "vitest";
import { analyze, outages, segmentRows, slope, voiceRatio, wordLags, type LogEvent } from "./latency-report";

/** Un segment tel que le journal le raconte : commit, voix prête, première écoute. */
function seg(seq: number, o: { tStart: number; tEnd: number; commit: number; mt: number; tts: number; ready: number; play?: number; dur?: number; turnStart?: boolean }): LogEvent[] {
  const out: LogEvent[] = [
    { t: o.commit, type: "commit", seq, tOrigin: o.tStart + 800, tEnd: o.tEnd, tStart: o.tStart, turnStart: o.turnStart, sttLagMs: 500, words: 5, reason: "final" },
    { t: o.ready, type: "segment", seq, tOrigin: o.tStart + 800, mtMs: o.mt, ttsMs: o.tts, durMs: o.dur ?? 1000, speed: 1 },
  ];
  if (o.play != null) out.push({ t: o.play, type: "ack", seq, e2eMs: 0 });
  return out;
}

describe("rapport de latence", () => {
  it("décompose chaque segment du début de parole au premier son", () => {
    const ev = seg(1, { tStart: 1000, tEnd: 3000, commit: 3300, mt: 300, tts: 300, ready: 4000, play: 4100, turnStart: true });
    const [r] = segmentRows(ev).rows;
    expect(r).toMatchObject({ speech: 2000, reco: 300, chain: 100, mt: 300, tts: 300, wait: 100, total: 3100, end: 1100, turnStart: true, approx: false });
  });

  it("sépare les séries quand le serveur redémarre (numéros qui repartent de 1)", () => {
    const ev = [
      ...seg(1, { tStart: 0, tEnd: 1000, commit: 1300, mt: 200, tts: 200, ready: 1700, play: 1800 }),
      ...seg(1, { tStart: 60_000, tEnd: 61_000, commit: 61_300, mt: 200, tts: 200, ready: 61_700, play: 61_900 }),
    ];
    const { rows } = segmentRows(ev);
    expect(rows.map((r) => [r.run, r.wait])).toEqual([
      [0, 100],
      [1, 200],
    ]);
  });

  it("compte ce qui n'a jamais été traduit ou joué", () => {
    const ev = [
      { t: 100, type: "commit", seq: 1, tOrigin: 0, tEnd: 50, tStart: 0, words: 1, reason: "final" },
      ...seg(2, { tStart: 200, tEnd: 900, commit: 1200, mt: 100, tts: 100, ready: 1400 }),
    ];
    expect(segmentRows(ev)).toMatchObject({ committed: 2, untranslated: 1, unplayed: 1, rows: [] });
  });

  it("estime le début du premier mot dans les journaux d'avant l'étape A", () => {
    const ev: LogEvent[] = [
      { t: 3300, type: "commit", seq: 1, tOrigin: 2000, tEnd: 3000, sttLagMs: 700, words: 5, reason: "final" },
      { t: 4000, type: "segment", seq: 1, mtMs: 300, ttsMs: 300, durMs: 1000 },
      { t: 4100, type: "ack", seq: 1 },
    ];
    const [r] = segmentRows(ev).rows;
    expect(r.approx).toBe(true);
    expect(r.total).toBe(4100 - (2000 - 700 - 300)); // fin du premier mot − 300 ms
    expect(r.turnStart).toBe(true);
  });

  it("voit le retard grandir quand la voix dure plus que la parole", () => {
    const ev: LogEvent[] = [];
    let play = 0;
    for (let i = 0; i < 6; i++) {
      const tStart = i * 2000;
      const tEnd = tStart + 1900;
      const ready = tEnd + 800;
      play = Math.max(ready, play + 2600); // chaque voix dure 2,6 s pour 2 s de parole
      ev.push(...seg(i + 1, { tStart, tEnd, commit: tEnd + 300, mt: 250, tts: 250, ready, play, dur: 2600 }));
    }
    const rep = analyze(ev);
    expect(rep.voiceRatio).toBeCloseTo(1.3, 1);
    expect(rep.driftMsPerMin).toBeGreaterThan(10_000); // +0,6 s tous les 2 s
    expect(voiceRatio(segmentRows(ev).rows)).toBe(rep.voiceRatio);
  });
});

describe("décalage par mot, retard maximal, pente (D41)", () => {
  it("répartit les mots à proportion quand le STT ne les date pas", () => {
    // 4 mots en 2 s de parole, 3 s de voix, premier son 1,5 s après la fin de la parole.
    const lags = wordLags({ tStart: 0, play: 3500, speech: 2000, durMs: 3000, words: 4 });
    // mot k : 3500 + k/4·3000 − k/4·2000
    expect(lags).toEqual([3500, 3750, 4000, 4250]);
  });

  it("prend le début de chaque mot donné par le STT", () => {
    // Le formateur dit vite les trois premiers mots puis traîne sur le dernier.
    const lags = wordLags({ tStart: 0, play: 3500, speech: 2000, durMs: 2000, words: 4, wordStarts: [0, 200, 400, 1500] });
    expect(lags).toEqual([3500, 3800, 4100, 3500]);
    // Une liste qui ne correspond pas au nombre de mots est ignorée.
    expect(wordLags({ tStart: 0, play: 3500, speech: 2000, durMs: 2000, words: 4, wordStarts: [0, 200] })).toEqual([3500, 3500, 3500, 3500]);
  });

  it("donne la pente et son erreur type", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ t: i * 30_000, v: 4000 + i * 500 })); // +1 s par minute
    expect(slope(pts)).toMatchObject({ msPerMin: 1000, seMsPerMin: 0, spanMin: 4.5, n: 10 });
    expect(slope(pts.slice(0, 2))).toBeNull();
    expect(slope([{ t: 0, v: 1 }, { t: 0, v: 2 }, { t: 0, v: 3 }])).toBeNull();
  });

  it("lit les pannes dans les changements de mode", () => {
    const ev: LogEvent[] = [
      { t: 10, type: "degraded", mode: "backup-mt" },
      { t: 20, type: "degraded", mode: "stt-lost" },
      { t: 25, type: "degraded", mode: "text-only" },
      { t: 30, type: "degraded", mode: "none" },
      { t: 40, type: "degraded", mode: "text-only" },
    ];
    expect(outages(ev)).toEqual([
      { from: 20, to: 30 },
      { from: 40, to: Infinity },
    ]);
  });

  it("écarte des indicateurs les segments qui traversent une panne, et le dit", () => {
    const ev: LogEvent[] = [
      ...seg(1, { tStart: 0, tEnd: 2000, commit: 2300, mt: 200, tts: 200, ready: 2800, play: 3000 }),
      // Reconnaissance perdue pendant le segment 2 : il arrive 20 s plus tard.
      { t: 4000, type: "degraded", mode: "stt-lost" },
      { t: 20_000, type: "degraded", mode: "none" },
      ...seg(2, { tStart: 3000, tEnd: 5000, commit: 21_000, mt: 200, tts: 200, ready: 21_500, play: 21_600 }),
      ...seg(3, { tStart: 30_000, tEnd: 32_000, commit: 32_300, mt: 200, tts: 200, ready: 32_800, play: 33_100 }),
    ];
    const { lag } = analyze(ev);
    expect(lag.outageSegments).toBe(1);
    expect(lag.max).toMatchObject({ seq: 3 });
    expect(lag.max!.ms).toBeLessThan(5000);
    expect(lag.maxWithOutages).toBeGreaterThan(18_000);
    expect(lag.words.n).toBe(10); // 5 mots × 2 segments
  });

  it("voit la pente quand la voix dure plus que la parole, et la sépare de la file", () => {
    const ev: LogEvent[] = [];
    let play = 0;
    for (let i = 0; i < 20; i++) {
      const tStart = i * 3000;
      const tEnd = tStart + 2900;
      const ready = tEnd + 600;
      play = Math.max(ready, play + 3300); // 3,3 s de voix pour 3 s de parole : +6 s par minute
      ev.push(...seg(i + 1, { tStart, tEnd, commit: tEnd + 200, mt: 200, tts: 200, ready, play, dur: 3300 }));
    }
    const { lag, minutes } = analyze(ev);
    expect(lag.slope!.msPerMin).toBeGreaterThan(5500);
    expect(lag.slope!.msPerMin).toBeLessThan(6500);
    expect(lag.max!.seq).toBe(20);
    expect(minutes[0].wordLag).not.toBeNull();
  });

  it("rapproche la première écoute de la voix de sa langue", () => {
    const ev: LogEvent[] = [
      { t: 2300, type: "commit", seq: 1, tOrigin: 800, tEnd: 2000, tStart: 0, turnStart: true, words: 2, reason: "final" },
      { t: 2700, type: "segment", seq: 1, lang: "fr", mtMs: 200, ttsMs: 200, durMs: 2000 },
      { t: 2900, type: "segment", seq: 1, lang: "es", mtMs: 300, ttsMs: 300, durMs: 4000 },
      { t: 3000, type: "ack", seq: 1, lang: "es" },
    ];
    const [r] = segmentRows(ev).rows;
    expect(r.durMs).toBe(4000);
    expect(r.wait).toBe(100);
  });
});
