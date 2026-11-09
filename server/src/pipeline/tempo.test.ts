import { describe, expect, it } from "vitest";
import { DEFAULT_CPS, MAX_STEP, Tempo } from "./tempo";

/** 85 caractères : 5 s de voix à 17 car./s. */
const TEXT = 85;
const base = { chars: TEXT, gapMs: 500, aheadMs: 0, preference: 1 };
/** Un segment qui suit le précédent sans pause, dit en `sourceMs` : il demande 5000 / sourceMs. */
const next = (sourceMs: number) => ({ ...base, gapMs: 0, sourceMs });
/** Une prise de parole, après un long silence. */
const turn = (sourceMs: number) => ({ ...base, gapMs: null, sourceMs });

describe("Tempo — chaque segment dans le temps du formateur (D26)", () => {
  it("vise le temps que le formateur a mis à dire le segment, pause comprise", () => {
    const d = new Tempo().speedFor("fr", { ...base, sourceMs: 4500 });
    expect(d.predictedMs).toBe(5000);
    expect(d.budgetMs).toBe(5000);
    expect(d.target).toBe(1);
  });

  it("vise plus vite quand le formateur accélère, plus lentement quand il ralentit, dans les bornes", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", { ...base, sourceMs: 4300, gapMs: 300 }).target).toBe(1.09);
    expect(t.speedFor("fr", { ...base, sourceMs: 3000 }).target).toBe(1.1); // plafond : au-delà, la voix est pressée (D32)
    expect(t.speedFor("fr", { ...base, sourceMs: 8000 }).target).toBe(1); // plancher (D30)
  });

  it("résorbe la moitié de la file des téléphones, sans exiger moins de la moitié du temps", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", { ...base, sourceMs: 5500, aheadMs: 1000 }).budgetMs).toBe(5500);
    expect(t.speedFor("fr", { ...base, sourceMs: 4500, aheadMs: 20_000 }).budgetMs).toBe(2500);
  });

  it("une longue pause ne compte que pour 0,6 s, une prise de parole pour rien", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", { ...base, sourceMs: 4000, gapMs: 3000 }).budgetMs).toBe(4600);
    expect(t.speedFor("fr", { ...base, sourceMs: 4000, gapMs: null }).budgetMs).toBe(4000);
  });

  it("apprend le débit de la voix, à vitesse ramenée à ×1", () => {
    const t = new Tempo();
    expect(t.charsPerSecond("fr")).toBe(DEFAULT_CPS);
    t.learn("fr", 120, 8000, 1.25); // 120 car. en 10 s à ×1 : 12 car./s
    expect(t.charsPerSecond("fr")).toBe(12);
    t.learn("fr", 140, 7000, 1); // 20 car./s : la moyenne glissante s'en rapproche
    expect(t.charsPerSecond("fr")).toBeCloseTo(14.4);
    t.learn("fr", 5, 400, 1); // trop court pour juger
    t.learn("fr", 100, 1000, 1); // 100 car./s : durée mal lue
    expect(t.charsPerSecond("fr")).toBeCloseTo(14.4);
    expect(t.charsPerSecond("en")).toBe(DEFAULT_CPS); // chaque langue a sa voix
  });
});

describe("Tempo — une vitesse qui ne saute plus (D30)", () => {
  it("une prise de parole repart entre ×1,05 et ×1,1, quoi qu'en demande le segment", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", turn(3000)).speed).toBe(1.1); // il demandait plus
    expect(t.speedFor("fr", turn(8000)).speed).toBe(1.05); // il demandait ×1
    expect(t.speedFor("fr", turn(4630)).speed).toBe(1.08); // dans la fenêtre : tel quel
  });

  it("d'un segment au suivant, la vitesse ne bouge que de 0,05", () => {
    const t = new Tempo();
    const speeds = [t.speedFor("fr", turn(4630)).speed];
    // Le formateur alterne passages rapides et lents, comme le discours du 07/11/2026.
    for (const ms of [3000, 3000, 3000, 8000, 8000, 3000]) speeds.push(t.speedFor("fr", next(ms)).speed);
    expect(speeds).toEqual([1.08, 1.1, 1.1, 1.1, 1.05, 1, 1.05]);
    for (let i = 1; i < speeds.length; i++) expect(Math.abs(speeds[i] - speeds[i - 1])).toBeLessThanOrEqual(MAX_STEP + 1e-9);
  });

  it("jamais sous ×1 ni au-dessus de ×1,1, même après une longue série (D32)", () => {
    const t = new Tempo();
    t.speedFor("fr", turn(4545));
    let slow = 0;
    for (let i = 0; i < 10; i++) slow = t.speedFor("fr", next(20_000)).speed;
    expect(slow).toBe(1);
    let fast = 0;
    for (let i = 0; i < 10; i++) fast = t.speedFor("fr", next(1000)).speed;
    expect(fast).toBe(1.1);
  });

  it("le réglage de l'administration déplace la plage : à ×0,9, la voix peut descendre à ×0,9", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", { ...turn(5000), preference: 0.9 }).target).toBe(0.9);
    let s = 0;
    for (let i = 0; i < 5; i++) s = t.speedFor("fr", { ...next(5000), preference: 0.9 }).speed;
    expect(s).toBe(0.9);
  });

  it("chaque langue lisse sa propre voix", () => {
    const t = new Tempo();
    t.speedFor("fr", turn(4545)); // ×1,1
    t.speedFor("fr", next(20_000)); // ×1,05
    expect(t.speedFor("en", next(20_000)).speed).toBe(1.05); // premier segment en anglais : il repart de la fenêtre
    expect(t.speedFor("fr", next(20_000)).speed).toBe(1);
  });
});
