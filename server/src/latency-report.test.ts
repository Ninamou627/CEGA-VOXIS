import { describe, expect, it } from "vitest";
import { analyze, segmentRows, voiceRatio, type LogEvent } from "./latency-report";

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
