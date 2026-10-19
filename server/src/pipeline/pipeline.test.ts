import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "../metrics";
import type { MtProvider, SttEvents, SttProvider, TtsProvider } from "../providers/types";
import { Pipeline } from "./pipeline";

const T0 = 1_000_000;
/** Une trame de 100 ms de silence à 16 kHz, PCM 16 bits mono. */
const FRAME = new Uint8Array(3200);
/** 100 ms de parole : un ton à −24 dBFS. */
const LOUD = (() => {
  const b = new Uint8Array(3200);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 1600; i++) v.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
  return b;
})();

class FakeStt implements SttProvider {
  readonly name = "fake-stt";
  ev?: SttEvents;
  constructor(readonly finalWords: boolean) {}
  async start(_o: unknown, ev: SttEvents) {
    this.ev = ev;
    return { sendAudio: () => {}, close: async () => {} };
  }
  async transcribeOnce() {
    return "";
  }
}

const mt: MtProvider = { name: "fake-mt", translate: async (r) => `fr:${r.text}` };
const tts: TtsProvider = { name: "fake-tts", synthesize: async () => ({ audio: new Uint8Array(1), mime: "audio/mpeg", durMs: 1000 }) };

function room(finalWords = true) {
  const stt = new FakeStt(finalWords);
  const metrics = new Metrics();
  const pipeline = new Pipeline({ stt, mt, tts }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000 }, metrics);
  const commits: { seq: number; text: string; tOrigin: number; tEnd: number; reason: string }[] = [];
  const audio: { seq: number; tOrigin: number }[] = [];
  pipeline.on("src.commit", (e) => commits.push(e));
  pipeline.on("audio", (e) => audio.push(e));
  /** Le formateur parle : une trame de 100 ms reçue toutes les 100 ms. */
  const speak = async (frames: number) => {
    for (let i = 0; i < frames; i++) {
      await vi.advanceTimersByTimeAsync(100);
      pipeline.pushAudio(LOUD);
    }
  };
  return { stt, metrics, pipeline, commits, audio, speak };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Pipeline — latence fin de phrase → voix (D19)", () => {
  it("date chaque segment à la fin prononcée de son dernier mot, jusqu'à l'accusé de lecture", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(10); // une seconde d'audio : la position p du flux a été dite à T0 + p
    r.stt.ev!.onPartial({
      words: [
        { text: "hello", startMs: 100, endMs: 400, isFinal: true },
        { text: "world.", startMs: 450, endMs: 800, isFinal: true },
      ],
      isFinal: false,
    });
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0].tEnd).toBe(T0 + 800);

    await vi.advanceTimersByTimeAsync(10); // traduction et synthèse (simulées, immédiates)
    expect(r.audio).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(290); // le téléphone commence à jouer 300 ms après le figement
    const { e2eMs, endMs, startMs } = r.metrics.ack("p1", r.audio[0].seq, r.audio[0].tOrigin, 0);
    expect(endMs).toBe(1300 - 800); // fin de « world. » (T0 + 800) → écoute (T0 + 1300)
    expect(e2eMs).toBe(300); // depuis la première apparition de « hello » (T0 + 1000)
    expect(startMs).toBe(1300 - 100); // début prononcé de « hello » (T0 + 100) : ce que ressent la salle

    const snap = r.metrics.snapshot();
    expect(snap.endP50).toBe(500);
    expect(snap.startP50).toBe(1200);
    expect(snap.firstP50).toBe(1200); // premier segment depuis l'ouverture du micro : une prise de parole
    expect(snap.firstN).toBe(1);
    expect(snap.stages.endCommitP50).toBe(200); // fin prononcée → segment figé
    expect(snap.stages.sttLagP50).toBe(1000 - 400); // « hello » fini à T0 + 400, reçu à T0 + 1000
    await r.pipeline.stop();
  });

  it("ne compte comme prise de parole que le segment qui suit un silence de plus de 1,5 s", async () => {
    const r = room();
    const turns: boolean[] = [];
    r.pipeline.on("src.commit", (e) => turns.push(e.turnStart));
    await r.pipeline.start();
    await r.speak(60);
    const w = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 300, isFinal: true });
    r.stt.ev!.onPartial({ words: [w("one.", 100)], isFinal: false });
    r.stt.ev!.onPartial({ words: [w("one.", 100), w("two.", 1000)], isFinal: false }); // 0,6 s après « one. »
    r.stt.ev!.onPartial({ words: [w("one.", 100), w("two.", 1000), w("three.", 3000)], isFinal: false }); // 1,7 s après
    expect(turns).toEqual([true, false, true]);
    await r.pipeline.stop();
  });

  it("un accusé dont le tOrigin ne correspond pas au segment ne fabrique pas de mesure", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(5);
    r.stt.ev!.onPartial({ words: [{ text: "okay.", startMs: 100, endMs: 400, isFinal: true }], isFinal: false });
    await vi.advanceTimersByTimeAsync(10);
    const { endMs } = r.metrics.ack("p1", r.audio[0].seq, r.audio[0].tOrigin - 1, 0);
    expect(endMs).toBeNull();
    await r.pipeline.stop();
  });

  it("un nouveau démarrage du micro n'hérite pas de la phrase de la prise précédente", async () => {
    const r = room(false);
    await r.pipeline.start();
    await r.speak(10);
    const words = (s: string) => s.split(" ").map((text, i) => ({ text, startMs: i * 200, endMs: (i + 1) * 200 }));
    r.stt.ev!.onPartial({ words: words("so the first thing"), isFinal: false });
    await r.pipeline.stop(); // le formateur coupe : la fin de phrase en attente part
    expect(r.commits.map((c) => [c.text, c.reason])).toEqual([["so the first thing", "silence"]]);

    await vi.advanceTimersByTimeAsync(60_000);
    await r.pipeline.start();
    await r.speak(10);
    r.stt.ev!.onPartial({ words: words("so the next one."), isFinal: true });
    expect(r.commits.at(-1)!.text).toBe("so the next one.");
    expect(r.commits.at(-1)!.tOrigin).toBe(T0 + 1000 + 60_000 + 1000); // vu maintenant, pas il y a une minute
    await r.pipeline.stop();
  });

  it("une nouvelle session STT repart de zéro sur l'horloge audio", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(10);
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000); // reconnexion après 1 s
    await r.speak(5); // nouvelle session : ses horodatages repartent de zéro
    r.stt.ev!.onPartial({ words: [{ text: "again.", startMs: 100, endMs: 300, isFinal: true }], isFinal: false });
    // Session rouverte à T0 + 2000 : la position 300 du nouveau flux a été dite à T0 + 2300.
    expect(r.commits.at(-1)!.tEnd).toBe(T0 + 2300);
    await r.pipeline.stop();
  });
});

describe("Pipeline — mots définitifs du fournisseur", () => {
  const hyp = (last: string) => ({
    words: [
      { text: "how", startMs: 100, endMs: 300, isFinal: true },
      { text: "the", startMs: 300, endMs: 450, isFinal: true },
      { text: "pipeline", startMs: 450, endMs: 900, isFinal: true },
      { text: "handles", startMs: 900, endMs: 1200, isFinal: true },
      { text: last, startMs: 1200, endMs: 1400 },
      { text: "trans", startMs: 1400, endMs: 1600 },
    ],
    isFinal: false,
  });

  it("un fournisseur qui marque ses mots définitifs ne voit jamais ses fragments figés", async () => {
    const r = room(true);
    await r.pipeline.start();
    await r.speak(17);
    r.stt.ev!.onPartial(hyp("part"));
    r.stt.ev!.onPartial(hyp("part"));
    await r.speak(45); // délai de coupe dépassé : seuls les mots définitifs partent
    expect(r.commits.map((c) => c.text)).toEqual(["how the pipeline handles"]);
    await r.pipeline.stop();
  });

  it("sans mots définitifs (U3.5 Pro), l'accord de deux hypothèses fige ce qui concorde", async () => {
    const r = room(false);
    await r.pipeline.start();
    await r.speak(17);
    r.stt.ev!.onPartial(hyp("part"));
    r.stt.ev!.onPartial(hyp("part"));
    await r.speak(45);
    expect(r.commits.map((c) => c.text)).toEqual(["how the pipeline handles part"]);
    await r.pipeline.stop();
  });
});

describe("Pipeline — connexions chaudes (D20)", () => {
  it("réchauffe traduction et voix à l'ouverture du micro, puis les interroge pendant les pauses", async () => {
    const warms: string[] = [];
    const stt = new FakeStt(true);
    const wmt: MtProvider = { ...mt, warm: async (force) => void warms.push(`mt${force ? "!" : ""}`) };
    const wtts: TtsProvider = { ...tts, warm: async (force) => void warms.push(`tts${force ? "!" : ""}`) };
    const pipeline = new Pipeline({ stt, mt: wmt, tts: wtts }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000 }, new Metrics());
    await pipeline.start();
    expect(warms).toEqual(["mt!", "tts!"]);
    await vi.advanceTimersByTimeAsync(20_000); // le formateur se tait 20 s
    expect(warms.filter((w) => w === "mt")).toHaveLength(4);
    await pipeline.stop();
    const after = warms.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warms).toHaveLength(after); // micro coupé : plus rien
  });
});

/** Une salle dont le STT accepte les fins de tour demandées ; `quickStart` : coupe rapide (D25). */
function forcingRoom(opts: { quickStart?: boolean; ttsDurMs?: number } = {}) {
    const forced: number[] = [];
    const stt: SttProvider & { ev?: SttEvents } = {
      name: "fake-stt",
      async start(_o, ev) {
        stt.ev = ev;
        return { sendAudio: () => {}, forceEndpoint: () => void forced.push(Date.now()), close: async () => {} };
      },
      async transcribeOnce() {
        return "";
      },
    };
    const voice: TtsProvider = { name: "fake-tts", synthesize: async () => ({ audio: new Uint8Array(1), mime: "audio/mpeg", durMs: opts.ttsDurMs ?? 1000 }) };
    const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo: true, speechThresholdDb: -35, quickStart: opts.quickStart ?? false });
    const pipeline = new Pipeline({ stt, mt, tts: voice }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000, tuning }, new Metrics());
    const push = async (frames: number, loud: boolean) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        pipeline.pushAudio(loud ? LOUD : FRAME);
      }
    };
    const words = (n: number) => ({ words: Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * 300, endMs: i * 300 + 250 })), isFinal: false });
    return { stt, pipeline, forced, push, words };
}

describe("Pipeline — fin de tour forcée pendant une pause (D22)", () => {
  it("clôt le tour une fois par pause, après au moins 1,2 s de parole", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(20, true);
    r.stt.ev!.onPartial(r.words(6));
    await r.push(2, false); // 200 ms de silence : pas encore une pause
    expect(r.forced).toHaveLength(0);
    await r.push(1, false); // 300 ms
    expect(r.forced).toHaveLength(1);
    await r.push(10, false); // la même pause ne force qu'une fois
    expect(r.forced).toHaveLength(1);
    await r.push(5, true); // il reprend 0,5 s puis se tait : trop peu de parole pour couper
    await r.push(3, false);
    expect(r.forced).toHaveLength(1);
    await r.push(10, true); // il reprend, assez longtemps cette fois
    await r.push(3, false);
    expect(r.forced).toHaveLength(2);
    await r.pipeline.stop();
  });

  it("ne coupe pas après moins de 1,2 s de parole", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(10, true);
    r.stt.ev!.onPartial(r.words(3));
    await r.push(10, false);
    expect(r.forced).toHaveLength(0);
    await r.pipeline.stop();
  });

  it("coupe même quand le STT, en retard, n'a encore livré aucun mot", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(20, true); // 2 s de parole, aucune hypothèse reçue
    await r.push(3, false);
    expect(r.forced).toHaveLength(1);
    await r.pipeline.stop();
  });

  it("une fin de tour du STT lui-même remet le compteur de parole à zéro", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(20, true);
    r.stt.ev!.onUtteranceEnd(); // le STT a clos la phrase de lui-même
    await r.push(5, true);
    await r.push(3, false);
    expect(r.forced).toHaveLength(0);
    await r.pipeline.stop();
  });
});

describe("Pipeline — premier morceau d'une prise de parole (D25)", () => {
  it("coupe au premier blanc de 120 ms après 0,8 s de parole, puis revient aux règles ordinaires", async () => {
    const r = forcingRoom({ quickStart: true });
    await r.pipeline.start();
    await r.push(9, true); // 0,9 s : « So today we »
    await r.push(1, false); // 100 ms : l'occlusion d'un « p », pas encore un blanc
    expect(r.forced).toHaveLength(0);
    await r.push(1, false); // 200 ms : un blanc entre deux mots
    expect(r.forced).toHaveLength(1);
    await r.push(9, true);
    await r.push(2, false); // même blanc : la prise de parole a déjà son premier morceau
    expect(r.forced).toHaveLength(1);
    await r.push(4, true);
    await r.push(3, false); // 1,3 s de parole et une vraie pause : règle ordinaire
    expect(r.forced).toHaveLength(2);
    await r.pipeline.stop();
  });

  it("une nouvelle prise de parole, après 1,5 s de silence, a de nouveau son premier morceau rapide", async () => {
    const r = forcingRoom({ quickStart: true });
    await r.pipeline.start();
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(1);
    await r.push(16, false); // la salle a tout entendu
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(2);
    await r.pipeline.stop();
  });

  it("pas de coupe rapide quand les téléphones ont encore à jouer : elle n'avancerait rien", async () => {
    const r = forcingRoom({ quickStart: true, ttsDurMs: 5000 });
    await r.pipeline.start();
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(1);
    const w = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 300, isFinal: true });
    r.stt.ev!.onPartial({ words: [w("So", 0), w("today.", 400)], isFinal: true });
    await r.push(16, false); // 5 s de voix envoyées : il en reste plus de 1,5 s à jouer
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(1);
    await r.push(4, true);
    await r.push(3, false);
    expect(r.forced).toHaveLength(2); // règle ordinaire
    await r.pipeline.stop();
  });

  it("une fin de tour reçue pendant un long silence ne prive pas la prise de parole suivante", async () => {
    const r = forcingRoom({ quickStart: true });
    await r.pipeline.start();
    await r.push(13, true);
    await r.push(3, false);
    expect(r.forced).toHaveLength(1);
    await r.push(16, false);
    r.stt.ev!.onUtteranceEnd(); // le texte définitif de la phrase d'avant arrive en retard
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(2);
    await r.pipeline.stop();
  });
});

describe("Pipeline — mots recalés sur l'audio (D25)", () => {
  it("date la fin d'un segment à la fin réelle de la parole, pas à l'horodatage du STT", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(6); // parole de T0 à T0 + 600
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(FRAME); // puis silence
    }
    // Le STT fait finir « world. » à 800 ms, dans le silence : la parole s'est arrêtée à 600.
    r.stt.ev!.onPartial({
      words: [
        { text: "hello", startMs: 100, endMs: 400, isFinal: true },
        { text: "world.", startMs: 450, endMs: 800, isFinal: true },
      ],
      isFinal: false,
    });
    expect(r.commits[0].tEnd).toBe(T0 + 600);
    await r.pipeline.stop();
  });
});

describe("Pipeline — la voix suit le débit du formateur (D26)", () => {
  function tempoRoom(followTempo: boolean) {
    const stt = new FakeStt(true);
    const speeds: number[] = [];
    // 17 car./s à ×1, comme ElevenLabs en français : la durée suit l'inverse de la vitesse.
    const voice: TtsProvider = {
      name: "fake-tts",
      synthesize: async (r) => {
        speeds.push(r.speed ?? 1);
        return { audio: new Uint8Array(1), mime: "audio/mpeg", durMs: Math.round((r.text.length / 17 / (r.speed ?? 1)) * 1000) };
      },
    };
    const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo, speechThresholdDb: -35, quickStart: false });
    const pipeline = new Pipeline({ stt, mt, tts: voice }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000, tuning }, new Metrics());
    const audio: { pauseMs?: number }[] = [];
    pipeline.on("audio", (e) => audio.push(e));
    const speak = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        pipeline.pushAudio(LOUD);
      }
    };
    /** La même phrase (« fr: » + 60 caractères), dite en `ms` à partir de `at` (position du flux). */
    const say = (at: number, ms: number) => {
      const words = Array.from({ length: 6 }, (_, i) => ({ text: i === 5 ? "abcdefghi." : "abcdefghi", startMs: at + (i * ms) / 6, endMs: at + ((i + 1) * ms) / 6 - 20, isFinal: true }));
      stt.ev!.onPartial({ words, isFinal: true });
    };
    return { pipeline, speeds, audio, speak, say };
  }

  it("la même phrase dite plus vite par le formateur est dite plus vite par la voix", async () => {
    const r = tempoRoom(true);
    await r.pipeline.start();
    await r.speak(120);
    r.say(0, 4000); // dite en 4 s
    await vi.advanceTimersByTimeAsync(5000);
    r.say(4300, 3000); // la même, en 3 s, après 300 ms de pause
    await vi.advanceTimersByTimeAsync(10);
    expect(r.speeds[1]).toBeGreaterThan(r.speeds[0]);
    expect(r.audio[1].pauseMs).toBe(320); // la pause du formateur (le dernier mot finissait à 3 980 ms) part avec le segment
    await r.pipeline.stop();
  });

  it("réglage « constant » : la vitesse de base, quelle que soit l'allure du formateur", async () => {
    const r = tempoRoom(false);
    await r.pipeline.start();
    await r.speak(120);
    r.say(0, 4000);
    await vi.advanceTimersByTimeAsync(5000);
    r.say(4300, 3000);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.speeds).toEqual([1, 1]);
    await r.pipeline.stop();
  });
});

describe("Pipeline — phrase finie ou phrase qui continue (D27)", () => {
  function endingRoom() {
    const r = room(true);
    const fr: string[] = [];
    r.pipeline.on("tr.segment", (e) => fr.push(e.text));
    const silence = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(FRAME);
      }
    };
    /** Le texte définitif d'une phrase dite de 0 à 1 500 ms, livré quand le STT le rend. */
    const final = (last: string) =>
      r.stt.ev!.onPartial({
        words: [
          { text: "Good", startMs: 0, endMs: 400, isFinal: true },
          { text: "morning", startMs: 450, endMs: 900, isFinal: true },
          { text: last, startMs: 950, endMs: 1500, isFinal: true },
        ],
        isFinal: true,
      });
    return { ...r, fr, silence, final };
  }

  it("le formateur a repris après 400 ms : le point redevient une virgule", async () => {
    const r = endingRoom();
    await r.pipeline.start();
    await r.speak(15);
    await r.silence(4);
    await r.speak(3);
    r.final("everyone.");
    await vi.advanceTimersByTimeAsync(10);
    expect(r.fr).toEqual(["fr:Good morning everyone,"]);
    await r.pipeline.stop();
  });

  it("une pause d'au moins 600 ms : la phrase est finie, le point reste", async () => {
    const r = endingRoom();
    await r.pipeline.start();
    await r.speak(15);
    await r.silence(8);
    r.final("everyone.");
    await vi.advanceTimersByTimeAsync(10);
    expect(r.fr).toEqual(["fr:Good morning everyone."]);
    await r.pipeline.stop();
  });

  it("pause encore trop courte pour juger : on garde le point du STT", async () => {
    const r = endingRoom();
    await r.pipeline.start();
    await r.speak(15);
    await r.silence(3);
    r.final("everyone.");
    await vi.advanceTimersByTimeAsync(10);
    expect(r.fr).toEqual(["fr:Good morning everyone."]);
    await r.pipeline.stop();
  });

  it("une phrase qui finit sur « the » n'est pas finie, quelle que soit la pause", async () => {
    const r = endingRoom();
    await r.pipeline.start();
    await r.speak(15);
    await r.silence(8);
    r.final("the.");
    await vi.advanceTimersByTimeAsync(10);
    expect(r.fr).toEqual(["fr:Good morning the,"]);
    await r.pipeline.stop();
  });
});
