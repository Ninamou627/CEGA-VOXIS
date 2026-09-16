import { describe, expect, it } from "vitest";
import { CommitGate, DEFAULT_COMMIT } from "./commit";

const W = (s: string) => s.split(" ").filter(Boolean).map((text) => ({ text }));

function gate(overrides = {}) {
  let t = 1000;
  const g = new CommitGate({ ...DEFAULT_COMMIT, ...overrides }, () => t);
  return { g, advance: (ms: number) => (t += ms), now: () => t };
}

describe("CommitGate — LocalAgreement-2", () => {
  it("ne fige un mot qu'après deux hypothèses concordantes, et jamais le dernier", () => {
    const { g } = gate();
    g.onPartial(W("today we"));
    expect(g.pendingText).toBe("");
    g.onPartial(W("today we are"));
    expect(g.pendingText).toBe("today we");
    g.onPartial(W("today we are going"));
    expect(g.pendingText).toBe("today we are");
  });

  it("ne fige pas une queue instable, puis la fige quand elle se stabilise", () => {
    const { g } = gate();
    g.onPartial(W("today we are going to"));
    g.onPartial(W("today we are gonna go"));
    expect(g.pendingText).toBe("today we are"); // « going to » vs « gonna go » : désaccord
    g.onPartial(W("today we are gonna go now"));
    expect(g.pendingText).toBe("today we are gonna go");
  });

  it("est append-only : une révision d'un mot déjà figé est ignorée", () => {
    const { g } = gate();
    g.onPartial(W("today we are"));
    g.onPartial(W("today we are going"));
    expect(g.pendingText).toBe("today we are");
    const r = g.onPartial(W("tomorrow we are going home"));
    expect(g.pendingText).toBe("today we are"); // pas de retour arrière
    expect(r.hypothesis).toBe("tomorrow we are going home"); // mais l'écran suit
  });

  it("prend la forme de surface la plus récente (ponctuation à jour)", () => {
    const { g } = gate();
    g.onPartial(W("so we stop"));
    g.onPartial(W("so we stop. Then"));
    g.onPartial(W("so we stop. Then we"));
    // « stop. » est figé avec son point, ce qui déclenche un segment.
    expect(g.pendingText).toBe("Then");
  });
});

describe("CommitGate — mots définitifs du fournisseur", () => {
  it("fige immédiatement les mots marqués isFinal, y compris le dernier", () => {
    const { g } = gate();
    const r = g.onPartial([{ text: "today", isFinal: true }, { text: "we", isFinal: true }, { text: "are" }]);
    expect(g.pendingText).toBe("today we");
    expect(r.hypothesis).toBe("today we are");
  });

  it("ne fige pas au-delà du premier mot non définitif", () => {
    const { g } = gate();
    g.onPartial([{ text: "today", isFinal: true }, { text: "wee" }, { text: "are", isFinal: true }]);
    expect(g.pendingText).toBe("today");
  });
});

describe("CommitGate — règles de coupe", () => {
  it("coupe sur la ponctuation terminale, même pour un segment court", () => {
    const { g } = gate();
    g.onPartial(W("Okay. Now"));
    const r = g.onPartial(W("Okay. Now the"));
    expect(r.segments.map((s) => [s.text, s.reason])).toEqual([["Okay.", "punctuation"]]);
    expect(g.pendingText).toBe("Now");
  });

  it("coupe sur une virgule à partir de clauseWords", () => {
    const { g } = gate({ clauseWords: 5 });
    const hyp = "one two three four five, six seven";
    g.onPartial(W(hyp));
    const r = g.onPartial(W(hyp + " eight"));
    expect(r.segments.map((s) => s.text)).toEqual(["one two three four five,"]);
    expect(r.segments[0].reason).toBe("clause");
  });

  it("coupe à maxWords sans ponctuation, en préférant une frontière de proposition", () => {
    const { g } = gate({ maxWords: 8, minWords: 3 });
    const hyp = "a b c d, e f g h i j";
    g.onPartial(W(hyp));
    const r = g.onPartial(W(hyp + " k"));
    expect(r.segments.map((s) => [s.text, s.reason])).toEqual([["a b c d,", "clause"]]);
  });

  it("coupe brutalement à maxWords s'il n'y a aucune frontière", () => {
    const { g } = gate({ maxWords: 6, minWords: 3 });
    const hyp = "a b c d e f g h";
    g.onPartial(W(hyp));
    const r = g.onPartial(W(hyp + " i"));
    expect(r.segments.map((s) => [s.text, s.reason])).toEqual([["a b c d e f", "maxlen"]]);
    expect(g.pendingText).toBe("g h");
  });

  it("vide tout sur fin d'énoncé, y compris le dernier mot et sous minWords", () => {
    const { g } = gate();
    g.onPartial(W("okay then"));
    const segs = g.onUtteranceEnd();
    expect(segs.map((s) => [s.text, s.reason])).toEqual([["okay then", "silence"]]);
    expect(g.pendingText).toBe("");
  });

  it("repart de zéro après une fin d'énoncé", () => {
    const { g } = gate();
    g.onPartial(W("first sentence here"));
    g.onUtteranceEnd();
    g.onPartial(W("second one"));
    g.onPartial(W("second one now"));
    expect(g.pendingText).toBe("second one");
  });

  it("la transcription finale fige les mots restants puis découpe", () => {
    const { g } = gate();
    g.onPartial(W("we never speak a word until it"));
    const segs = g.onFinal(W("we never speak a word until it has appeared twice."));
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("we never speak a word until it has appeared twice.");
    expect(segs[0].reason).toBe("punctuation");
  });

  it("flush anti-famine après timeoutMs si minWords sont en attente", () => {
    const { g, advance } = gate({ timeoutMs: 2000, minWords: 4 });
    const hyp = "one two three four five";
    g.onPartial(W(hyp));
    g.onPartial(W(hyp + " six"));
    expect(g.pendingCount).toBe(5);
    advance(1500);
    expect(g.tick()).toEqual([]);
    advance(600);
    const segs = g.tick();
    expect(segs.map((s) => [s.text, s.reason])).toEqual([["one two three four five", "timeout"]]);
  });

  it("n'applique pas le timeout sous minWords", () => {
    const { g, advance } = gate({ timeoutMs: 1000, minWords: 4 });
    g.onPartial(W("a b c"));
    g.onPartial(W("a b c d"));
    expect(g.pendingCount).toBe(3);
    advance(5000);
    expect(g.tick()).toEqual([]);
  });
});

describe("CommitGate — abandon", () => {
  it("discard oublie les mots figés non envoyés, sans segment", () => {
    const { g } = gate();
    g.onPartial(W("bonjour à tous"));
    g.onPartial(W("bonjour à tous aujourd'hui"));
    expect(g.pendingText).toBe("bonjour à tous");
    g.discard();
    expect(g.pendingText).toBe("");
    expect(g.onUtteranceEnd()).toEqual([]);
    const r = g.onPartial(W("today we"));
    expect(r.segments).toEqual([]);
  });
});

describe("CommitGate — horodatage", () => {
  it("tOrigin est la première apparition du premier mot du segment", () => {
    const { g, advance } = gate();
    g.onPartial(W("today")); // t = 1000 : « today » vu
    advance(300);
    g.onPartial(W("today we")); // t = 1300 : « we » vu
    advance(300);
    g.onPartial(W("today we are.")); // t = 1600
    advance(300);
    const r = g.onPartial(W("today we are. Then")); // « are. » figé → segment
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].tOrigin).toBe(1000);
  });

  it("le reste du tampon hérite de l'origine de son propre premier mot", () => {
    const { g, advance } = gate({ maxWords: 3, minWords: 2 });
    g.onPartial(W("a b c")); // 1000
    advance(500);
    const r = g.onPartial(W("a b c d e")); // 1500 : d, e vus ; a b c figés → coupe à 3
    expect(r.segments[0].text).toBe("a b c");
    expect(r.segments[0].tOrigin).toBe(1000);
    advance(500);
    g.onPartial(W("a b c d e f")); // 2000 : d e figés
    advance(3000);
    const t = g.tick();
    expect(t[0].text).toBe("d e");
    expect(t[0].tOrigin).toBe(1500);
  });
});
