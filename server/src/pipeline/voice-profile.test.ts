import { describe, expect, it } from "vitest";
import type { Frame } from "../prosody";
import { VoiceProfile } from "./voice-profile";

/** Fenêtres de 20 ms d'une phrase : hauteur autour de `hz` (± `swing`), énergie `db`. */
function phrase(at: number, ms: number, hz: number, swing: number, db: number): Frame[] {
  const out: Frame[] = [];
  for (let t = at + 10; t < at + ms; t += 20) out.push({ t, db, f0: hz * 2 ** ((swing * Math.sin(t / 150)) / 12) });
  return out;
}
const words = (at: number, n: number, ms: number) => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: at + (i * ms) / n, endMs: at + ((i + 1) * ms) / n }));
const TEXT = "the pipeline handles partial transcripts"; // 9 syllabes

/** Huit phrases ordinaires pour apprendre l'habitude, avec de petites variations. */
function trained() {
  const p = new VoiceProfile("en");
  for (let i = 0; i < 8; i++) {
    const at = i * 3000;
    p.describe(phrase(at, 2000, 150 + i, 2 + (i % 3) * 0.3, -26 - (i % 3)), at, at + 2000, words(at, 5, 2000), TEXT, -35);
  }
  return p;
}

describe("VoiceProfile — la voix du formateur comparée à ses habitudes (D28)", () => {
  it("ne juge rien tant que l'habitude n'est pas apprise", () => {
    const d = new VoiceProfile("en").describe(phrase(0, 2000, 150, 2, -26), 0, 2000, words(0, 5, 2000), TEXT, -35);
    expect(d.arousal).toBeNull();
    expect(d.rateZ).toBeNull();
    expect(d.f0St).not.toBeNull();
  });

  it("une phrase plus mélodieuse et plus forte que d'habitude est animée ; plate et faible, posée", () => {
    const p = trained();
    expect(p.describe(phrase(30_000, 2000, 150, 8, -18), 30_000, 32_000, words(30_000, 5, 2000), TEXT, -35).arousal).toBe("lively");
    expect(trained().describe(phrase(30_000, 2000, 150, 0.5, -32), 30_000, 32_000, words(30_000, 5, 2000), TEXT, -35).arousal).toBe("calm");
    expect(trained().describe(phrase(30_000, 2000, 152, 2.3, -27), 30_000, 32_000, words(30_000, 5, 2000), TEXT, -35).arousal).toBe("neutral");
  });

  it("la même phrase dite en moins de temps : débit au-dessus de l'habitude", () => {
    const d = trained().describe(phrase(30_000, 1300, 150, 2, -26), 30_000, 31_300, words(30_000, 5, 1300), TEXT, -35);
    expect(d.rate).toBeGreaterThan(6);
    expect(d.rateZ!).toBeGreaterThan(1);
  });

  it("repère le mot dit plus fort que les autres", () => {
    const p = trained();
    const frames = phrase(30_000, 2000, 150, 2, -26).map((f) => (f.t >= 30_800 && f.t < 31_200 ? { ...f, db: -14 } : f));
    const d = p.describe(frames, 30_000, 32_000, words(30_000, 5, 2000), TEXT, -35);
    expect(d.emphasized).toEqual(["w2"]);
  });
});
