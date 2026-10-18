import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Metrics } from "../metrics";
import type { MtProvider, SttEvents, SttProvider, TtsProvider } from "../providers/types";
import { Pipeline } from "./pipeline";

const T0 = 1_000_000;
/** Une trame de 100 ms à 16 kHz, PCM 16 bits mono. */
const FRAME = new Uint8Array(3200);

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
      pipeline.pushAudio(FRAME);
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
    const { e2eMs, endMs } = r.metrics.ack("p1", r.audio[0].seq, r.audio[0].tOrigin, 0);
    expect(endMs).toBe(1300 - 800); // fin de « world. » (T0 + 800) → écoute (T0 + 1300)
    expect(e2eMs).toBe(300); // depuis la première apparition de « hello » (T0 + 1000)

    const snap = r.metrics.snapshot();
    expect(snap.endP50).toBe(500);
    expect(snap.stages.endCommitP50).toBe(200); // fin prononcée → segment figé
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

describe("Pipeline — fin de tour forcée pendant une pause (D22)", () => {
  /** Ton à −24 dBFS : le formateur parle. */
  const LOUD = (() => {
    const b = new Uint8Array(3200);
    const v = new DataView(b.buffer);
    for (let i = 0; i < 1600; i++) v.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
    return b;
  })();

  function forcingRoom() {
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
    const pipeline = new Pipeline({ stt, mt, tts }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000 }, new Metrics());
    const push = async (frames: number, loud: boolean) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        pipeline.pushAudio(loud ? LOUD : FRAME);
      }
    };
    const words = (n: number) => ({ words: Array.from({ length: n }, (_, i) => ({ text: `w${i}`, startMs: i * 300, endMs: i * 300 + 250 })), isFinal: false });
    return { stt, pipeline, forced, push, words };
  }

  it("clôt le tour une fois par pause, quand au moins 4 mots attendent", async () => {
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
    await r.push(5, true); // il reprend, puis se tait de nouveau
    await r.push(3, false);
    expect(r.forced).toHaveLength(2);
    await r.pipeline.stop();
  });

  it("ne coupe pas pour moins de 4 mots en attente", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(10, true);
    r.stt.ev!.onPartial(r.words(3));
    await r.push(10, false);
    expect(r.forced).toHaveLength(0);
    await r.pipeline.stop();
  });
});
