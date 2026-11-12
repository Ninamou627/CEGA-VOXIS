import { describe, expect, it } from "vitest";
import { CATCHUP_WINDOW_MS, catchupLines, type RecentLine } from "../../shared/catchup";

/** Rattrapage du texte manqué pendant une coupure de l'apprenant (D40, F-08). */

const T0 = 1_800_000_000_000;
/** Un segment toutes les 3 s, traduit en français ; `n` segments jusqu'à `T0`. */
function talk(n: number, every = 3000): RecentLine[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    srcText: `sentence ${i + 1}`,
    tOrigin: T0 - (n - 1 - i) * every,
    tgt: { fr: `phrase ${i + 1}` },
  }));
}

describe("catchupLines — le texte manqué, borné (D40)", () => {
  it("coupure de 20 s : toutes les lignes manquées, dans l'ordre", () => {
    const recent = talk(30);
    // La page avait reçu jusqu'au 23 ; 7 segments (≈ 20 s) se sont figés pendant la coupure.
    const lines = catchupLines(recent, { lang: "fr", since: 23, now: T0 + 500 });
    expect(lines.map((l) => l.seq)).toEqual([24, 25, 26, 27, 28, 29, 30]);
    expect(lines[0]).toEqual({ seq: 24, src: "sentence 24", tOrigin: recent[23].tOrigin, tgt: "phrase 24" });
  });

  it("au-delà de cinq minutes, on ne rattrape plus", () => {
    const recent = talk(150); // 7,5 min de parole
    const lines = catchupLines(recent, { lang: "fr", since: 0, now: T0 });
    expect(lines.length).toBeGreaterThan(90);
    for (const l of lines) expect(T0 - l.tOrigin).toBeLessThanOrEqual(CATCHUP_WINDOW_MS);
    expect(lines[lines.length - 1].seq).toBe(150);
  });

  it("serveur redémarré (`since` inconnu) : tout ce qu'il a de récent", () => {
    const lines = catchupLines(talk(5), { lang: "fr", since: null, now: T0 });
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("la langue de l'apprenant, une traduction ratée marquée, une traduction en route absente", () => {
    const recent: RecentLine[] = [
      { seq: 1, srcText: "one", tOrigin: T0, tgt: { fr: "un", es: "uno" } },
      { seq: 2, srcText: "two", tOrigin: T0, tgt: { es: "two" }, untranslated: { es: true } },
      { seq: 3, srcText: "", tOrigin: T0, tgt: { es: "?" } }, // jamais montré : rien à rattraper
    ];
    expect(catchupLines(recent, { lang: "es", since: 0, now: T0 })).toEqual([
      { seq: 1, src: "one", tOrigin: T0, tgt: "uno" },
      { seq: 2, src: "two", tOrigin: T0, tgt: "two", untranslated: true },
    ]);
    // En français, la 2 n'est pas encore traduite : le texte source, la traduction suivra.
    expect(catchupLines(recent, { lang: "fr", since: 0, now: T0 })[1]).toEqual({ seq: 2, src: "two", tOrigin: T0 });
  });

  it("rien de manqué : rien à renvoyer", () => {
    expect(catchupLines(talk(10), { lang: "fr", since: 10, now: T0 })).toEqual([]);
  });
});
