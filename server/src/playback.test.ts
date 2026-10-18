import { describe, expect, it } from "vitest";
import { localRate } from "../../shared/playback";

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

  it("ne double pas la vitesse déjà appliquée par le serveur, et ne ralentit jamais", () => {
    expect(localRate(6500, 1.25)).toBe(1);
    expect(localRate(6500, 1.1)).toBe(1.14);
    expect(localRate(2500, 1.15)).toBe(1);
  });
});
