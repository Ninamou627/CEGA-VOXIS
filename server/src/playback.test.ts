import { describe, expect, it } from "vitest";
import { arrivalAgeMs, keptPauseMs, localRate, tooLate } from "../../shared/playback";

describe("voix trop ancienne : âge compté depuis la fin de la phrase (D31)", () => {
  // Le segment #19 du test du 8/11 : 7,4 s de phrase, voix prête 1,1 s après la fin.
  const t0 = 1_000_000;
  const h19 = { tOrigin: t0 + 550, tEnd: t0 + 7_380 };
  const arrival = t0 + 7_380 + 1_092 + 200; // + transport jusqu'au téléphone

  it("une phrase longue dont la voix arrive à temps n'est plus sautée", () => {
    expect(arrival - h19.tOrigin).toBeGreaterThan(8_000); // l'ancienne règle la sautait
    expect(arrivalAgeMs(arrival, h19)).toBe(1_292);
    expect(tooLate(0, arrivalAgeMs(arrival, h19))).toBe(false);
  });

  it("une voix arrivée plus de 8 s après la fin de sa phrase saute toujours", () => {
    expect(tooLate(0, arrivalAgeMs(h19.tEnd + 8_001, h19))).toBe(true);
  });

  it("une file de plus de 8 s fait toujours sauter", () => {
    expect(tooLate(8_001, 0)).toBe(true);
    expect(tooLate(8_000, 8_000)).toBe(false);
  });

  it("sans fin de phrase connue (question), l'âge part du premier mot", () => {
    expect(arrivalAgeMs(t0 + 3_000, { tOrigin: t0 })).toBe(3_000);
  });
});

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
