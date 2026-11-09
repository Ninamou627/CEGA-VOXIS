import { describe, expect, it } from "vitest";
import { CaptureMeter } from "../../shared/capture";

/** Trames de 50 ms ; `keep(i)` dit si la trame i arrive (sinon le navigateur l'a jetée). */
function feed(m: CaptureMeter, n: number, keep: (i: number) => boolean = () => true, t0 = 1000) {
  const reports: number[] = [];
  for (let i = 1; i <= n; i++) {
    if (!keep(i)) continue;
    const r = m.frame(t0 + i * 50, 50);
    if (r != null) reports.push(r);
  }
  return reports;
}

describe("captation du micro (D34)", () => {
  it("tout le son livré : 1", () => {
    const m = new CaptureMeter();
    const reports = feed(m, 400);
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) expect(r).toBeCloseTo(1, 2);
  });

  it("une trame sur quatre perdue : 0,75", () => {
    const m = new CaptureMeter();
    const reports = feed(m, 800, (i) => i % 4 !== 0);
    expect(reports.at(-1)).toBeCloseTo(0.75, 2);
  });

  it("pas de relevé avant 5 s de mesure", () => {
    const m = new CaptureMeter();
    expect(feed(m, 90)).toEqual([]);
    expect(m.ratio(1000 + 90 * 50)).toBeNull();
  });

  it("un thread principal bloqué 2 s puis rattrapé ne compte pas comme une perte", () => {
    const m = new CaptureMeter();
    feed(m, 200);
    // Les 40 trames suivantes (2 s de son) arrivent toutes d'un coup à la fin du blocage.
    const t = 1000 + 240 * 50;
    for (let i = 0; i < 40; i++) m.frame(t, 50);
    expect(m.ratio(t)).toBeCloseTo(1, 1);
  });

  it("la fenêtre oublie une perte passée", () => {
    const m = new CaptureMeter();
    feed(m, 400, (i) => i > 200 || i % 2 === 0);
    // 10 s de son complet après la perte : la fenêtre ne voit plus qu'elles.
    expect(m.ratio(1000 + 400 * 50)).toBeCloseTo(1, 2);
  });
});
