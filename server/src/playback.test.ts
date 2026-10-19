import { describe, expect, it } from "vitest";
import { keptPauseMs, localRate } from "../../shared/playback";

describe("lecture côté téléphone (shared/playback)", () => {
  it("ne touche à rien sous 2 s de file", () => {
    expect(localRate(0, 1)).toBe(1);
    expect(localRate(2000, 1)).toBe(1);
  });

  it("accélère par paliers quand la file grossit", () => {
    expect(localRate(2500, 1)).toBe(1.08);
    expect(localRate(4500, 1)).toBe(1.15);
    expect(localRate(6500, 1)).toBe(1.25);
  });

  it("rattrape sa file même quand la synthèse est rapide, sans dépasser un débit effectif de ×1,3 (D26)", () => {
    expect(localRate(6500, 1.2)).toBe(1.08); // 1,2 × 1,08 ≈ 1,3
    expect(localRate(4500, 1.1)).toBe(1.15);
    expect(localRate(2500, 1.15)).toBe(1.08);
    expect(localRate(6500, 1.3)).toBe(1); // jamais de ralentissement
  });
});

describe("pause gardée entre deux segments (D26)", () => {
  it("garde 40 % du silence du formateur, 350 ms au plus", () => {
    expect(keptPauseMs(800, 0, 0)).toBe(320);
    expect(keptPauseMs(2000, 0, 0)).toBe(350);
  });

  it("rien pour un simple blanc entre deux mots, ni sans silence connu", () => {
    expect(keptPauseMs(300, 0, 0)).toBe(0);
    expect(keptPauseMs(undefined, 0, 0)).toBe(0);
  });

  it("le silence déjà écoulé sur le téléphone compte", () => {
    expect(keptPauseMs(800, 100, 0)).toBe(220);
    expect(keptPauseMs(800, 1000, 0)).toBe(0);
  });

  it("un téléphone en retard enchaîne sans pause", () => {
    expect(keptPauseMs(800, 0, 2000)).toBe(0);
  });
});
