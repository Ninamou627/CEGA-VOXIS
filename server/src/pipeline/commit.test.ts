import { describe, expect, it } from "vitest";
import { alignedEnd, CommitGate, DEFAULT_COMMIT } from "./commit";

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

  it("ne coupe pas après un titre abrégé : le nom suit (D32)", () => {
    const { g } = gate();
    g.onPartial(W("Um, hello, Mr. President. Thank"));
    const r = g.onPartial(W("Um, hello, Mr. President. Thank you"));
    expect(r.segments.map((s) => [s.text, s.reason])).toEqual([["Um, hello, Mr. President.", "punctuation"]]);
    const b = gate().g;
    b.onPartial(W("Dr. Smith is"));
    expect(b.onPartial(W("Dr. Smith is here")).segments).toEqual([]);
    expect(b.pendingText).toBe("Dr. Smith is");
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
    const { g, advance } = gate({ maxWords: 3, minWords: 2, timeoutMs: 2500 });
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

/**
 * Mots horodatés dans le flux audio : « mot@fin » (fin en ms d'audio). Le flux est reçu en
 * temps réel depuis t = 10 000 : la position p a été prononcée à 10 000 + p.
 */
const T = (s: string, isFinal?: boolean) =>
  s
    .split(" ")
    .filter(Boolean)
    .map((x) => {
      const [text, end] = x.split("@");
      return { text, startMs: Number(end) - 250, endMs: Number(end), ...(isFinal ? { isFinal } : {}) };
    });

function timedGate(overrides = {}) {
  let t = 10_000;
  const g = new CommitGate({ ...DEFAULT_COMMIT, ...overrides }, () => t, { spokenAt: (ms) => 10_000 + ms });
  return { g, advance: (ms: number) => (t += ms) };
}

describe("CommitGate — fin prononcée (D19)", () => {
  it("tEnd est la fin prononcée du dernier mot du segment, pas son apparition", () => {
    const { g, advance } = timedGate();
    advance(1200);
    const r = g.onPartial(T("today@300 we@600 are.@900", true));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].tEnd).toBe(10_900);
    expect(r.segments[0].tEndExact).toBe(true);
    expect(r.segments[0].tOrigin).toBe(11_200); // vus pour la première fois à cet instant
  });

  it("sans horodatage, tEnd retombe sur l'apparition du dernier mot, et le dit", () => {
    const { g, advance } = gate();
    g.onPartial(W("today we")); // 1000
    advance(300);
    g.onPartial(W("today we are.")); // 1300 : « are. » vu
    advance(300);
    const r = g.onPartial(W("today we are. Then"));
    expect(r.segments[0].tEnd).toBe(1300);
    expect(r.segments[0].tEndExact).toBe(false);
  });
});

describe("CommitGate — sans accord, seuls les mots définitifs du fournisseur", () => {
  it("ne fige jamais un fragment affiché puis corrigé (« part » → « partial »)", () => {
    const { g } = gate({ agreement: false });
    // Ce qu'affiche AssemblyAI universal-streaming : le mot en cours de prononciation, puis sa correction.
    g.onPartial([{ text: "handles", isFinal: true }, { text: "part" }, { text: "trans" }]);
    g.onPartial([{ text: "handles", isFinal: true }, { text: "part" }, { text: "transcripts" }]);
    expect(g.pendingText).toBe("handles"); // l'accord aurait figé « part »
    g.onPartial([
      { text: "handles", isFinal: true },
      { text: "partial", isFinal: true },
      { text: "transcripts", isFinal: true },
    ]);
    expect(g.pendingText).toBe("handles partial transcripts");
  });

  it("avec l'accord (U3.5 Pro, simulateur), deux hypothèses concordantes suffisent", () => {
    const { g } = gate({ agreement: true });
    g.onPartial(W("handles part trans"));
    g.onPartial(W("handles part transcripts"));
    expect(g.pendingText).toBe("handles part");
  });
});

describe("CommitGate — un mot ne part jamais deux fois (D22)", () => {
  it("écarte les mots qu'un tour suivant reprend, d'après leurs horodatages", () => {
    const { g, advance } = timedGate();
    advance(5000);
    // Tour A, clos de force : ses hypothèses avaient déjà donné « …and why that matters ».
    const a = g.onFinal(T("partial@3200 transcripts,@3700 and@4000 why@4300 that@4500 matters@4800"));
    expect(a.map((s) => s.text)).toEqual(["partial transcripts, and why that matters"]);
    advance(1000);
    // Tour B : le STT reprend « And why that matters » avant la suite.
    const b = g.onFinal(T("And@4050 why@4300 that@4500 matters@4800 for@5000 latency.@5600"));
    expect(b.map((s) => s.text)).toEqual(["for latency."]);
  });

  it("un nouveau flux STT repart de zéro : ses horodatages recommencent", () => {
    const { g, advance } = timedGate();
    advance(5000);
    g.onFinal(T("hello@800 there.@1200"));
    g.newStream();
    expect(g.onFinal(T("again@600 now.@1000")).map((s) => s.text)).toEqual(["again now."]);
  });
});

describe("CommitGate — contexte rejoué à une nouvelle session (D37)", () => {
  /**
   * Premier flux : position p ↔ heure réelle 10 000 + p. `restart(from)` : le flux suivant
   * commence par l'audio dit à 10 000 + from (le contexte rejoué), position 0.
   */
  function replay() {
    let origin = 10_000;
    const g = new CommitGate(DEFAULT_COMMIT, () => 30_000, { spokenAt: (ms) => origin + ms });
    const restart = (from: number, replayed = true) => {
      g.newStream(replayed);
      origin = 10_000 + from;
    };
    return { g, restart };
  }
  const w = (text: string, startMs: number, endMs = startMs + 250) => ({ text, startMs, endMs });
  const texts = (segs: { text: string }[]) => segs.map((s) => s.text);
  // Parti du premier flux : milieux à 11 375, 11 675, 11 975 et 12 275.
  const FIRST = T("one@1500 two@1800 three@2100 four.@2400");

  it("rien de ce qui est parti ne repart ; ce que l'ancienne session n'avait pas encore rendu passe", () => {
    const { g, restart } = replay();
    expect(texts(g.onFinal(FIRST))).toEqual(["one two three four."]);
    restart(500); // le contexte commence à 10 500 : « one » est à 750 dans le nouveau flux
    const again = [w("on", 0, 150), w("one", 750), w("two", 1050), w("three", 1350), w("four.", 1650), w("five", 1950), w("six.", 2250)];
    expect(texts(g.onFinal(again))).toEqual(["five six."]);
  });

  it("près du dernier mot parti, un mot entendu autrement est redit plutôt que perdu", () => {
    const { g, restart } = replay();
    g.onFinal(FIRST);
    restart(500);
    // « four. » devient « for » : même endroit, autre texte. Dans le doute, il repart.
    expect(texts(g.onFinal([w("three", 1350), w("for", 1650), w("five.", 1950)]))).toEqual(["for five."]);
  });

  it("le bout de mot coupé au début du contexte ne part pas, même s'il ne ressemble à rien", () => {
    const { g, restart } = replay();
    g.onFinal(FIRST);
    restart(1900); // le contexte commence au milieu de « four. »
    expect(texts(g.onFinal([w("our", 0, 200), w("five", 350), w("six.", 650)]))).toEqual(["five six."]);
  });

  it("une vraie répétition du formateur, juste après le dernier mot parti, passe (« no, no »)", () => {
    const { g, restart } = replay();
    g.onFinal(T("no,@1500")); // milieu 11 375
    restart(500);
    expect(texts(g.onFinal([w("no,", 750), w("no.", 1050)]))).toEqual(["no."]);
  });

  it("un tour écarté (autre langue) n'a pas été dit : rendu par la nouvelle session, il part", () => {
    const { g, restart } = replay();
    g.onFinal(T("one@1500 two.@1800"));
    g.onPartial(T("trois@2100 quatre@2400 cinq@2700"));
    g.onPartial(T("trois@2100 quatre@2400 cinq@2700 six@3000"));
    g.discard(); // garde-fou de langue : rien de ce tour n'est parti
    restart(500);
    expect(texts(g.onFinal([w("two.", 1050), w("three", 1350), w("four", 1650), w("five.", 1950)]))).toEqual(["three four five."]);
  });

  it("deux sessions datent autrement les mêmes mots : ce qui suit le dernier mot parti passe (banc du 12/11/2026)", () => {
    // Horodatages réels : la session tombée avait rendu « 2019 ITS nominal flow », étalés vers
    // l'arrière ; la nouvelle reçoit le contexte depuis la position 25 950 de l'ancienne et tasse
    // ces mots vers le début : d'une session à l'autre, ils se déplacent de 0,6 à 1,1 s. « is », dit
    // après « flow », semblait le précéder de 0,7 s : il était perdu.
    const { g, restart } = replay();
    g.onFinal([w("2019", 25728, 26429), w("ITS", 26464, 26990), w("nominal", 27025, 28253), w("flow", 28288, 28989)]);
    restart(25950);
    const again = [
      w("ITS", 0, 388), w("nominal", 413, 1318), w("flow", 1343, 1860), w("is", 1885, 2143), w("45", 2168, 2426),
      w("liters", 2451, 3227), w("per", 3252, 3640), w("minute", 3665, 4441), w("at", 4466, 4724),
      w("1,500", 4749, 5395), w("revolutions", 5420, 6842), w("per", 6867, 7255), w("minute.", 7280, 8185),
    ];
    expect(texts(g.onFinal(again))).toEqual(["is 45 liters per minute at 1,500 revolutions per minute."]);
  });

  it("au-delà de l'écart toléré, les mots rendus par les deux sessions les recalent", () => {
    // Plus que mesuré : l'écart grandit de 1,25 à 1,85 s au fil du contexte. Sans recalage, « is »
    // semblerait précéder de 1,55 s le dernier mot parti.
    const { g, restart } = replay();
    g.onFinal([w("the", 1000, 1500), w("nominal", 1600, 2100), w("flow", 2200, 2700), w("rate", 2800, 3300)]);
    restart(0);
    const again = [w("the", 175), w("nominal", 475), w("flow", 775), w("rate", 1075), w("is", 1375), w("45.", 1675)];
    expect(texts(g.onFinal(again))).toEqual(["is 45."]);
  });

  it("sans mot rendu par les deux sessions, l'instant seul n'écarte que ce qui précède de loin le dernier mot parti", () => {
    // La nouvelle session date tout 1 s plus tôt et entend autrement chacun des mots partis : loin
    // avant « four. », ils ne repartent pas ; près de lui, ils sont redits ; la suite passe.
    const { g, restart } = replay();
    g.onFinal(FIRST);
    restart(-500);
    const again = [w("won", 750), w("too", 1050), w("tree", 1350), w("for", 1650), w("five", 1950), w("six.", 2250)];
    expect(texts(g.onFinal(again))).toEqual(["tree for five six."]);
  });

  it("un mot que le tour suivant relit au même endroit ne repart pas, même retrouvé avant (D22)", () => {
    const { g, restart } = replay();
    g.onFinal(FIRST);
    restart(500);
    expect(texts(g.onFinal([w("one", 750), w("two", 1050), w("three", 1350), w("four.", 1650)]))).toEqual([]);
    expect(texts(g.onFinal([w("four", 1650), w("five", 1950), w("six.", 2250)]))).toEqual(["five six."]);
  });

  it("sans contexte rejoué, rien n'est écarté, même daté plus tôt (autre poste, autre horloge)", () => {
    const { g, restart } = replay();
    g.onFinal(FIRST);
    restart(-5000, false);
    expect(texts(g.onFinal([w("hello", 6000), w("again.", 6300)]))).toEqual(["hello again."]);
  });
});

describe("CommitGate — fin de tour demandée", () => {
  it("le délai de coupe attend le texte définitif demandé au STT", () => {
    const { g, advance } = gate({ timeoutMs: 1000, minWords: 3 });
    g.onPartial(W("a b c d e"));
    g.onPartial(W("a b c d e f")); // t = 1 000 : « a b c d e » en attente
    advance(900);
    g.holdTimeout(800); // pause du formateur : fin de tour demandée
    advance(300); // délai de coupe dépassé (1 200 ms), mais suspendu
    expect(g.tick()).toEqual([]);
    const segs = g.onFinal(W("a b c d e f g"));
    expect(segs.map((s) => [s.text, s.reason])).toEqual([["a b c d e f g", "final"]]);
  });

  it("si le texte définitif tarde, le délai de coupe reprend", () => {
    const { g, advance } = gate({ timeoutMs: 1000, minWords: 3 });
    g.onPartial(W("a b c d e"));
    g.onPartial(W("a b c d e f"));
    advance(900);
    g.holdTimeout(800);
    advance(900); // la suspension a expiré
    expect(g.tick().map((s) => s.reason)).toEqual(["timeout"]);
  });
});

describe("CommitGate — un mot nouveau n'est jamais pris pour une répétition", () => {
  it("garde un mot nouveau même si l'horodatage provisoire du mot précédent le chevauchait", () => {
    const { g, advance } = timedGate({ timeoutMs: 1000 });
    advance(3000);
    // « discuss » est parti avec une fin provisoire à 2 500 ms ; « how the » arrivent ensuite, plus tôt dans l'audio.
    g.onFinal(T("going@1600 to@1800 discuss@2500"));
    expect(g.onFinal(T("how@2450 the@2600 pipeline.@3000")).map((s) => s.text)).toEqual(["how the pipeline."]);
  });

  it("garde une vraie répétition du formateur (« no, no »)", () => {
    const { g, advance } = timedGate();
    advance(3000);
    g.onFinal(T("no,@1000"));
    expect(g.onFinal(T("no.@1400")).map((s) => s.text)).toEqual(["no."]);
  });
});

describe("CommitGate — le STT révise le nombre de mots (D36)", () => {
  it("un mot retiré en amont ne fait pas perdre le mot suivant", () => {
    const { g } = gate();
    g.onPartial(W("we deploy the new pipeline"));
    g.onPartial(W("we deploy the new pipeline on")); // « we deploy the new pipeline » figés
    g.onPartial(W("we deploy new pipeline on friday")); // le STT retire « the »
    g.onPartial(W("we deploy new pipeline on friday morning"));
    const segs = g.onFinal(W("we deploy new pipeline on friday morning."));
    // Repéré par son rang, « on » était perdu : « …pipeline friday morning. »
    expect(segs.map((s) => s.text)).toEqual(["we deploy the new pipeline on friday morning."]);
  });

  it("un mot inséré en amont ne fait pas redire un mot déjà figé", () => {
    const { g } = gate();
    g.onPartial(W("we deploy the new pipeline"));
    g.onPartial(W("we deploy the new pipeline on"));
    g.onPartial(W("we deploy the brand new pipeline on friday")); // le STT ajoute « brand »
    g.onPartial(W("we deploy the brand new pipeline on friday morning"));
    const segs = g.onFinal(W("we deploy the brand new pipeline on friday morning."));
    // Repéré par son rang, « pipeline » partait deux fois. L'ajout, lui, arrive trop tard pour être dit.
    expect(segs.map((s) => s.text)).toEqual(["we deploy the new pipeline on friday morning."]);
  });

  it("un texte définitif plus court (« twenty five » → « 25 ») garde le dernier mot et son point", () => {
    const { g } = gate();
    g.onPartial(W("it costs twenty five dollars"));
    g.onPartial(W("it costs twenty five dollars per"));
    g.onPartial(W("it costs twenty five dollars per user"));
    const segs = g.onFinal(W("It costs 25 dollars per user."));
    // Repéré par son rang, « user. » était perdu, et le segment partait sans ponctuation finale.
    expect(segs.map((s) => [s.text, s.reason])).toEqual([["it costs twenty five dollars per user.", "punctuation"]]);
  });

  it("un mot ajouté juste avant le dernier mot figé ne le fait pas redire", () => {
    const { g } = gate();
    g.onPartial(W("the cat sat"));
    g.onPartial(W("the cat sat down")); // « the cat sat » figés
    g.onPartial(W("the cat really sat down now"));
    g.onPartial(W("the cat really sat down now then"));
    expect(g.pendingText).toBe("the cat sat down now");
  });

  it("une hypothèse qui raccourcit puis revient ne redit rien", () => {
    const { g } = gate();
    g.onPartial(W("a b c d"));
    g.onPartial(W("a b c d e")); // « a b c d » figés
    g.onPartial(W("a b")); // le STT retire la queue un instant
    g.onPartial(W("a b c d e f"));
    g.onPartial(W("a b c d e f g"));
    expect(g.pendingText).toBe("a b c d e f");
    expect(g.takeRevisions().shifts).toBe(0); // rien n'était à couper pendant le retrait
  });

  it("une vraie répétition reste, même après un mot figé identique", () => {
    const { g } = gate();
    g.onPartial(W("no way"));
    g.onPartial(W("no way no")); // « no way » figés
    g.onPartial(W("no way no way out"));
    g.onPartial(W("no way no way out now"));
    expect(g.pendingText).toBe("no way no way out");
  });

  it("compte les décalages et les mots figés que le texte définitif contredit", () => {
    const { g } = gate();
    g.onPartial(W("we deploy the new pipeline"));
    g.onPartial(W("we deploy the new pipeline on"));
    g.onPartial(W("we deploy new pipeline on friday"));
    g.onPartial(W("we deploy new pipeline on friday morning"));
    g.onFinal(W("we deploy new pipeline on friday morning."));
    expect(g.takeRevisions()).toEqual({ shifts: 1, shiftedWords: 1, contradicted: 1 });
    expect(g.takeRevisions()).toEqual({ shifts: 0, shiftedWords: 0, contradicted: 0 }); // relevé remis à zéro
  });

  it("sans révision, rien n'est compté et la reprise est le nombre de mots figés", () => {
    const { g } = gate();
    g.onPartial(W("today we are going"));
    g.onPartial(W("today we are going home"));
    g.onFinal(W("Today we are going home now."));
    expect(g.takeRevisions()).toEqual({ shifts: 0, shiftedWords: 0, contradicted: 0 });
    expect(alignedEnd(["today", "we"], ["today", "we", "are"])).toEqual({ end: 2, cost: 0 });
  });
});
