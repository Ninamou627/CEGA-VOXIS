import { describe, expect, it } from "vitest";
import { LagControl, nextTier } from "./lagcontrol";
import { checkTightened } from "./tighten";

describe("contrôleur de retard (D42)", () => {
  it("monte d'autant de paliers que le retard en franchit", () => {
    expect(nextTier(0, 2999)).toBe(0);
    expect(nextTier(0, 3000)).toBe(1);
    expect(nextTier(0, 5200)).toBe(2);
    expect(nextTier(0, 9000)).toBe(3);
  });

  it("ne redescend qu'une seconde sous le seuil du palier", () => {
    expect(nextTier(1, 2100)).toBe(1);
    expect(nextTier(1, 1900)).toBe(0);
    expect(nextTier(2, 4100)).toBe(2);
    expect(nextTier(2, 3900)).toBe(1);
    expect(nextTier(3, 7200)).toBe(3);
    expect(nextTier(3, 6000)).toBe(2);
    expect(nextTier(3, 500)).toBe(0); // la file s'est vidée pendant une pause
  });

  it("tient un palier par langue et dit d'où il vient", () => {
    const c = new LagControl();
    expect(c.update("fr", 3500)).toEqual({ tier: 1, from: 0 });
    expect(c.update("es", 500)).toEqual({ tier: 0, from: 0 });
    expect(c.update("fr", 2500)).toEqual({ tier: 1, from: 1 });
    expect(c.snapshot()).toEqual({ fr: { tier: 1, retardMs: 2500 }, es: { tier: 0, retardMs: 500 } });
    c.reset();
    expect(c.tier("fr")).toBe(0);
  });

  it("un relevé hors décision ne fait que descendre : la file juste après une voix compte cette voix", () => {
    const c = new LagControl();
    c.update("fr", 5200); // décision : la voix qui se prépare attendra 5,2 s
    expect(c.update("fr", 8700, false)).toEqual({ tier: 2, from: 2 }); // juste après l'envoi : pas d'alerte
    expect(c.get("fr").retardMs).toBe(5200);
    expect(c.update("fr", 1500, false)).toEqual({ tier: 0, from: 2 }); // l'orateur s'est tu, la file s'est vidée
    expect(c.get("fr").retardMs).toBe(1500);
  });
});

describe("formulation resserrée, garde-fou (D42)", () => {
  const normal = "Alors, vous savez, en 2026 nous avons formé 1 200 personnes avec Kubernetes, et nous ne voulons pas, euh, nous ne voulons pas recommencer.";

  it("accepte une version plus courte qui garde nombres, noms et négations", () => {
    const tight = "En 2026, nous avons formé 1 200 personnes avec Kubernetes, et nous ne voulons pas recommencer.";
    expect(checkTightened(normal, tight, "fr")).toMatchObject({ ok: true, numbers: 2, names: 1, negations: 4 });
  });

  it("refuse une version qui perd un nombre, un nom ou une négation", () => {
    expect(checkTightened(normal, "En 2026, nous avons formé des personnes avec Kubernetes, et nous ne voulons pas recommencer, ne voulons pas.", "fr")).toMatchObject({ ok: false, reason: "nombre perdu : 1200" });
    expect(checkTightened(normal, "En 2026, nous avons formé 1 200 personnes, et nous ne voulons pas recommencer, ne voulons pas.", "fr")).toMatchObject({ ok: false, reason: "nom perdu : Kubernetes" });
    expect(checkTightened(normal, "En 2026, nous avons formé 1 200 personnes avec Kubernetes et voulons recommencer.", "fr")).toMatchObject({ ok: false, reason: "négation perdue" });
    // Une négation qui change d'objet est perdue, même s'il en reste une.
    expect(
      checkTightened("Bon, ce n'est pas facile, euh, et ce n'est pas rapide non plus, voilà.", "Ce n'est pas facile, et c'est rapide.", "fr"),
    ).toMatchObject({ ok: false, reason: "négation perdue" });
  });

  it("compte les nombres en toutes lettres, et les négations élidées", () => {
    expect(checkTightened("Euh, il y a, vous voyez, trois étapes, trois.", "Il y a donc des étapes.", "fr")).toMatchObject({ ok: false, reason: "nombre perdu : trois" });
    // La redite du nombre peut tomber, le nombre reste.
    expect(checkTightened("Euh, il y a, vous voyez, trois étapes, trois.", "Il y a trois étapes.", "fr").ok).toBe(true);
    expect(checkTightened("Well, you know, it doesn't, it doesn't work like that at all.", "It just works like that, at all.", "en")).toMatchObject({ ok: false, reason: "négation perdue" });
    expect(checkTightened("Well, you know, it doesn't, it doesn't work like that at all.", "It doesn't work like that at all.", "en").ok).toBe(true);
  });

  it("refuse ce qui n'est pas plus court, ou beaucoup trop court", () => {
    expect(checkTightened("Nous commençons.", "Nous commençons.", "fr")).toMatchObject({ ok: false, reason: "pas plus court" });
    expect(checkTightened(normal, "Non.", "fr")).toMatchObject({ ok: false, reason: "trop court" });
    expect(checkTightened(normal, "  ", "fr")).toMatchObject({ ok: false, reason: "vide" });
  });

  it("accepte qu'un nom passe en début de phrase", () => {
    expect(checkTightened("Bon, alors, nous allons parler de Docker aujourd'hui, voilà.", "Docker : c'est le sujet du jour.", "fr").ok).toBe(true);
  });
});
