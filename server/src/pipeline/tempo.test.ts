import { describe, expect, it } from "vitest";
import { DEFAULT_CPS, Tempo } from "./tempo";

/** 85 caractères : 5 s de voix à 17 car./s. */
const TEXT = 85;
const base = { chars: TEXT, gapMs: 500, aheadMs: 0, preference: 1 };

describe("Tempo — chaque segment dans le temps du formateur (D26)", () => {
  it("dit le segment dans le temps que le formateur a mis à le dire, pause comprise", () => {
    const d = new Tempo().speedFor("fr", { ...base, sourceMs: 4500 });
    expect(d.predictedMs).toBe(5000);
    expect(d.budgetMs).toBe(5000);
    expect(d.speed).toBe(1);
  });

  it("accélère quand le formateur accélère, ralentit quand il ralentit, dans les bornes", () => {
    const t = new Tempo();
    expect(t.speedFor("fr", { ...base, sourceMs: 3900, gapMs: 300 }).speed).toBe(1.19);
    expect(t.speedFor("fr", { ...base, sourceMs: 3000 }).speed).toBe(1.2); // plafond d'ElevenLabs
    expect(t.speedFor("fr", { ...base, sourceMs: 5300 }).speed).toBe(0.86);
    expect(t.speedFor("fr", { ...base, sourceMs: 8000 }).speed).toBe(0.85); // plancher
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

  it("le réglage de l'administration multiplie la vitesse calculée", () => {
    expect(new Tempo().speedFor("fr", { ...base, sourceMs: 4500, preference: 0.9 }).speed).toBe(0.9);
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
