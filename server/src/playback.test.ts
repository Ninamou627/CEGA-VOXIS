import { describe, expect, it } from "vitest";
import { keptPauseMs } from "../../shared/playback";

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
