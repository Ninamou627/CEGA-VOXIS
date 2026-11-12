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
  /** Trames reçues par chaque flux ouvert, dans l'ordre. */
  streams: Uint8Array[][] = [];
  /** Durée de la fermeture d'un flux (AssemblyAI : 200 ms, le temps que `Terminate` parte). */
  closeMs = 0;
  /** Durée de l'ouverture d'un flux (AssemblyAI : ~0,4 s). */
  startMs = 0;
  /** Flux fermés, par numéro d'ouverture. */
  closed: number[] = [];
  /** Attente demandée à chaque fermeture (D37), dans l'ordre. */
  drains: (number | undefined)[] = [];
  /**
   * Ce que le fournisseur fait d'une fermeture qui attend son retard : rend ses derniers tours,
   * puis confirme (`true`) ou non. Sans lui, la fermeture est immédiate (après `closeMs`).
   */
  onDrain?: (ev: SttEvents, drainMs: number) => Promise<boolean>;
  constructor(readonly finalWords: boolean) {}
  async start(_o: unknown, ev: SttEvents) {
    if (this.startMs) await new Promise((resolve) => setTimeout(resolve, this.startMs));
    this.ev = ev;
    const received: Uint8Array[] = [];
    const n = this.streams.push(received) - 1;
    return {
      sendAudio: (pcm: Uint8Array) => void received.push(pcm),
      close: (drainMs?: number) => {
        this.closed.push(n);
        this.drains.push(drainMs);
        if (drainMs && this.onDrain) return this.onDrain(ev, drainMs);
        return new Promise<void>((resolve) => (this.closeMs ? setTimeout(resolve, this.closeMs) : resolve()));
      },
    };
  }
  async transcribeOnce() {
    return "";
  }
}

const mt: MtProvider = { name: "fake-mt", translate: async (r) => `fr:${r.text}` };
const tts: TtsProvider = { name: "fake-tts", synthesize: async () => ({ audio: new Uint8Array(1), mime: "audio/mpeg", durMs: 1000 }) };

/**
 * `joinShort` : morceaux courts attachés à la suite (D32) ; `wholeSentences` : phrases coupées
 * au milieu attachées à la suite (D33). Coupés ailleurs, où chaque segment se suit à l'unité.
 */
function room(finalWords = true, joinShort = false, wholeSentences = false) {
  const stt = new FakeStt(finalWords);
  const metrics = new Metrics();
  const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo: true, speechThresholdDb: -35, quickStart: true, joinShort, wholeSentences });
  const pipeline = new Pipeline({ stt, mt, tts }, { srcLang: "en", targetLangs: ["fr"], sampleRate: 16000, tuning }, metrics);
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

  it("une nouvelle session STT repart de zéro sur l'horloge audio, contexte rejoué compris", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(10);
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000); // reconnexion après 1 s
    await r.speak(5); // nouvelle session : ses horodatages repartent de zéro
    r.stt.ev!.onPartial({ words: [{ text: "again.", startMs: 1100, endMs: 1300, isFinal: true }], isFinal: false });
    // Rouverte à T0 + 2000, elle a d'abord reçu la seconde d'avant (dite de T0 à T0 + 1000, D37) :
    // sa position 1 300 a été dite à T0 + 2300.
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

describe("Pipeline — aucune trame du micro perdue ni doublée (D37)", () => {
  it("les trames reçues pendant une réouverture du STT partent au nouveau flux, dans l'ordre", async () => {
    const r = room();
    await r.pipeline.start();
    await r.speak(5);
    expect(r.stt.streams[0]).toHaveLength(5);
    r.stt.ev!.onError(new Error("coupure"));
    // 1 s de recul avant la réouverture : dix trames arrivent entre-temps.
    const frames = Array.from({ length: 10 }, (_, i) => new Uint8Array(3200).fill(i + 1));
    for (const f of frames) {
      await vi.advanceTimersByTimeAsync(50);
      r.pipeline.pushAudio(f);
    }
    expect(r.pipeline.audio.buffered).toBe(10);
    expect(r.stt.streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600); // réouverture
    expect(r.stt.streams).toHaveLength(2);
    // D'abord les dernières secondes que l'ancien flux avait reçues (le contexte, D37), puis l'attente.
    expect(r.stt.streams[1].slice(0, 5)).toEqual(r.stt.streams[0]);
    expect(r.stt.streams[1].slice(5).map((f) => f[0])).toEqual(frames.map((f) => f[0]));
    expect(r.pipeline.audio.buffered).toBe(0);
    await r.pipeline.stop();
  });

  it("une trame renvoyée après une coupure n'est pas transmise deux fois ; une trame manquante est comptée", async () => {
    const r = room();
    r.pipeline.setCapture("page-1");
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    const push = (seq: number) => r.pipeline.pushAudio(LOUD, { seq, tCapture: Date.now() - 40 });
    push(1);
    push(2);
    push(2); // renvoyée à la réadmission
    push(1);
    push(5); // 3 et 4 jamais arrivées
    expect(r.stt.streams[0]).toHaveLength(3);
    expect(r.pipeline.audio.duplicates).toBe(2);
    expect(r.pipeline.audio.missing).toBe(2);
    expect(events).toHaveBeenCalledWith("audio.gap", { frames: 2, ms: 200, seq: 5 });
    expect(r.metrics.snapshot().audioGapMs).toBe(200);
    // Nouvelle captation (page rouverte) : les numéros repartent, rien n'est pris pour un doublon.
    r.pipeline.setCapture("page-2");
    push(1);
    expect(r.stt.streams[0]).toHaveLength(4);
    await r.pipeline.stop();
  });

  it("date la parole à la captation, jamais après la réception, et mesure le retard montant", async () => {
    const r = room();
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    // Dix trames captées 300 ms avant d'arriver : la liaison montante est lente.
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(LOUD, { seq: i, tCapture: Date.now() - 300 });
    }
    r.stt.ev!.onPartial({ words: [{ text: "hello.", startMs: 100, endMs: 1000, isFinal: true }], isFinal: false });
    // La position 1 000 ms du flux a été captée à T0 + 1 000 − 300, pas reçue à T0 + 1 000.
    expect(r.commits[0].tEnd).toBe(T0 + 700);
    expect(r.metrics.snapshot().uplinkP50Ms).toBe(300);
    await r.pipeline.stop();
  });

  it("les trames renvoyées à la réadmission, arrivées pendant l'arrêt de l'ancienne prise, vont au nouveau flux", async () => {
    // Le chemin de `handlers.ts` après une liaison figée (D35) : l'ancienne liaison est coupée,
    // son arrêt ferme le STT (200 ms chez AssemblyAI), et pendant ce temps la page réadmise
    // renvoie son tampon de 10 s.
    const r = room();
    r.stt.closeMs = 200;
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    const frame = (seq: number) => new Uint8Array(3200).fill(seq);
    for (let seq = 1; seq <= 5; seq++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(frame(seq), { seq, tCapture: Date.now() });
    }
    // La liaison gèle : les trames 6 à 12 restent dans la page.
    await vi.advanceTimersByTimeAsync(700);
    const stopping = r.pipeline.stop();
    r.pipeline.setCapture("page-1");
    const started = stopping.then(() => r.pipeline.start());
    for (let seq = 1; seq <= 12; seq++) r.pipeline.pushAudio(frame(seq), { seq, tCapture: T0 + seq * 100 });
    await vi.advanceTimersByTimeAsync(300);
    await started;
    expect(r.stt.streams).toHaveLength(2);
    expect(r.stt.streams[0].map((f) => f[0])).toEqual([1, 2, 3, 4, 5]);
    // Même captation : le nouveau flux reçoit d'abord 1 à 5 en contexte (D37), puis la suite, sans trou.
    expect(r.stt.streams[1].map((f) => f[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.pipeline.audio.duplicates).toBe(5);
    expect(r.pipeline.audio.missing).toBe(0);
    const stopped = r.pipeline.stop();
    await vi.advanceTimersByTimeAsync(300);
    await stopped;
  });

  it("une panne du STT plus longue que l'attente garde les 40 dernières secondes et compte le reste", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    r.stt.ev!.onError(new Error("coupure"));
    // La réouverture échoue tant que la panne dure.
    const start = r.stt.start.bind(r.stt);
    r.stt.start = async () => {
      throw new Error("injoignable");
    };
    for (let i = 0; i < 450; i++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(new Uint8Array(3200).fill(i % 250));
    }
    expect(r.pipeline.audio.buffered).toBe(400);
    expect(r.pipeline.audio.dropped).toBe(5000);
    expect(r.metrics.snapshot().audioGapMs).toBe(5000);
    r.stt.start = start;
    await vi.advanceTimersByTimeAsync(11_000); // essais à 1, 3, 7, 15, 25, 35, 45 s ; celui de 55 s aboutit
    expect(r.stt.streams[1]).toHaveLength(400); // les 40 dernières secondes, dans l'ordre
    expect(r.stt.streams[1][0][0]).toBe(50);
    expect(events).toHaveBeenCalledWith("audio.flush", { frames: 400, ms: 40_000, droppedMs: 5000 });
    await r.pipeline.stop();
  });

  it("dit à la page réadmise où il en est de sa captation, et rien à une captation inconnue", async () => {
    const r = room();
    expect(r.pipeline.setCapture("page-1")).toBeUndefined();
    expect(r.pipeline.micSeq).toBe(0);
    await r.pipeline.start();
    for (let seq = 1; seq <= 4; seq++) r.pipeline.pushAudio(LOUD, { seq, tCapture: Date.now() });
    expect(r.pipeline.micSeq).toBe(4);
    await r.pipeline.stop();
    expect(r.pipeline.setCapture("page-1")).toBe(4); // la même page revient : elle renverra la suite
    expect(r.pipeline.setCapture("page-2")).toBeUndefined(); // autre page : tout est nouveau
    expect(r.pipeline.setCapture(undefined)).toBeUndefined(); // page sans numéros
  });

  it("relève la session STT avant 3 h, pendant une pause, sans perdre une trame", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    r.stt.startMs = 300;
    const start = r.pipeline.start();
    await vi.advanceTimersByTimeAsync(300);
    await start;
    let pushed = 0;
    const push = async (n: number, pcm: Uint8Array) => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(pcm);
        pushed++;
      }
    };
    await push(10, LOUD);
    await push(10, FRAME); // une pause avant 2 h 50 : rien ne se passe
    expect(r.stt.streams).toHaveLength(1);
    vi.setSystemTime(Date.now() + 170 * 60_000);
    await push(10, LOUD);
    // Une phrase reconnue mais pas encore figée : la pause qui suit ne relève pas la session.
    r.stt.ev!.onPartial({ words: [{ text: "so", startMs: 100, endMs: 300 }, { text: "the", startMs: 300, endMs: 500 }], isFinal: false });
    await push(10, FRAME);
    expect(r.stt.streams).toHaveLength(1);
    r.stt.ev!.onPartial({ words: [{ text: "so", startMs: 100, endMs: 300 }, { text: "the", startMs: 300, endMs: 500 }], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await vi.advanceTimersByTimeAsync(10_000); // les morceaux retenus partent
    await push(4, LOUD);
    r.stt.ev!.onPartial({ words: [{ text: "right.", startMs: 4000, endMs: 4400 }], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await push(10, FRAME); // pause, rien n'attend, le STT a tout rendu : relève
    await push(10, LOUD);
    expect(events).toHaveBeenCalledWith("stt.rotate", expect.objectContaining({ ageMs: expect.any(Number) }));
    expect(r.stt.streams).toHaveLength(2);
    expect(r.stt.closed).toEqual([0]); // l'ancienne fermée une fois la nouvelle ouverte
    // L'ancienne avait tout rendu : la nouvelle reçoit ses 3 dernières secondes en contexte (D37),
    // les 30 dernières trames, et rien de plus.
    expect(events).toHaveBeenCalledWith("stt.warmup", { ms: 3000, behindMs: 0 });
    expect(r.stt.streams[1].slice(0, 30)).toEqual(r.stt.streams[0].slice(-30));
    // Les trames reçues pendant l'ouverture de la relève (300 ms) ont attendu : aucune perdue.
    expect(r.stt.streams[0].length + r.stt.streams[1].length - 30).toBe(pushed);
    await r.pipeline.stop();
  });

  it("une relève refusée garde la session en place, qui reçoit ce qui attendait ; nouvel essai une minute après", async () => {
    const r = room();
    await r.pipeline.start();
    let pushed = 0;
    const push = async (n: number, pcm: Uint8Array) => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(pcm);
        pushed++;
      }
    };
    const start = r.stt.start.bind(r.stt);
    let refused = 0;
    r.stt.start = async () => {
      refused++;
      throw new Error("AssemblyAI : Unauthorized Connection: Too many concurrent sessions");
    };
    vi.setSystemTime(Date.now() + 170 * 60_000);
    await push(10, LOUD);
    await push(10, FRAME); // pause : relève tentée, refusée
    expect(refused).toBe(1);
    expect(r.stt.closed).toEqual([]);
    await push(10, LOUD);
    await push(10, FRAME); // moins d'une minute après : pas de nouvel essai
    expect(refused).toBe(1);
    expect(r.stt.streams).toHaveLength(1);
    expect(r.stt.streams[0]).toHaveLength(pushed); // la session en place a tout reçu
    r.stt.start = start;
    vi.setSystemTime(Date.now() + 60_000);
    await push(10, LOUD);
    r.stt.ev!.onPartial({ words: [{ text: "okay.", startMs: 4200, endMs: 4900 }], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await push(10, FRAME);
    expect(r.stt.streams).toHaveLength(2);
    expect(r.stt.closed).toEqual([0]);
    await r.pipeline.stop();
  });

  it("une session rouverte reçoit d'abord ce que l'ancienne n'avait pas rendu, avec 3 s de contexte : rien de déjà dit ne repart, le reste passe", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    await r.speak(100); // 10 s de parole : la position p du premier flux a été dite à T0 + p
    const w = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 250 });
    r.stt.ev!.onPartial({ words: [w("one", 4850), w("two", 5150), w("three", 5450), w("four.", 5750)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    expect(r.commits.map((c) => c.text)).toEqual(["one two three four."]);
    // La session tombe à T0 + 10 000, en retard : elle n'a rien rendu après « four. » (6 000), 4 s.
    r.stt.ev!.onError(new Error("coupure"));
    await r.speak(10); // recul de 1 s : la réouverture a lieu pendant ces trames
    expect(r.stt.streams).toHaveLength(2);
    // 3 s de contexte avant la fin de « four. », puis tout ce qui suit : les trames 31 à 100 du
    // premier flux, telles quelles — pas seulement ses 3 dernières secondes.
    expect(r.stt.streams[1].slice(0, 70)).toEqual(r.stt.streams[0].slice(30));
    expect(r.stt.streams[1]).toHaveLength(80);
    expect(events).toHaveBeenCalledWith("stt.warmup", { ms: 7000, behindMs: 4000 });
    // Le nouveau flux commence à T0 + 3 000 : « one », dit à T0 + 4 850, y est à 1 850. Les mots
    // déjà partis, puis ce que l'ancienne n'avait pas rendu — « five six. », avant ses 3 dernières
    // secondes, s'y serait perdu.
    const again = [w("one", 1850), w("two", 2150), w("three", 2450), w("four.", 2750), w("five", 3050), w("six.", 3350), w("seven.", 4650)];
    r.stt.ev!.onPartial({ words: again, isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    expect(r.commits.map((c) => c.text)).toEqual(["one two three four.", "five six.", "seven."]);
    await r.pipeline.stop();
  });

  it("une session tombée après une longue pause ne la rejoue pas : 3 s de la pause, puis la parole pas encore rendue", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    const push = async (n: number, pcm: Uint8Array) => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(pcm);
      }
    };
    await push(30, LOUD); // 3 s de parole, toutes rendues
    r.stt.ev!.onPartial({ words: [said("so", 2400), said("we.", 2750)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await push(200, FRAME); // 20 s de silence : aucun mot à rendre
    await push(20, LOUD); // la parole reprend ; la session tombe avant d'en rendre un mot
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.stt.streams).toHaveLength(2);
    // Rejouer la pause entière retarderait d'autant la parole d'après.
    expect(r.stt.streams[1]).toEqual(r.stt.streams[0].slice(-50));
    expect(events).toHaveBeenCalledWith("stt.warmup", { ms: 5000, behindMs: 2000 });
    await r.pipeline.stop();
  });

  it("un STT muet depuis plus de 40 s : la nouvelle session en reçoit les 40 dernières secondes", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    await r.speak(600); // une minute de parole, aucun mot rendu
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.stt.streams[1]).toHaveLength(400);
    expect(events).toHaveBeenCalledWith("stt.warmup", { ms: 40_000, behindMs: 60_000 });
    await r.pipeline.stop();
    // ~5 s : chaque trame de parole passe par l'analyse de la hauteur (`LiveProsody`, ~5 ms
    // mesurées par trame de 100 ms), et 1 000 trames passent ici.
  }, 20_000);

  it("une session rouverte qui tombe à son tour rejoue à la suivante, datée dans son propre flux", async () => {
    const r = room();
    await r.pipeline.start();
    let seq = 0;
    const push = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(new Uint8Array(3200).fill(++seq));
      }
    };
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    await push(60);
    r.stt.ev!.onPartial({ words: [said("one.", 3750)], isFinal: true }); // rendu jusqu'à 4 000
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000);
    // 3 s avant 4 000 : à partir de la trame 11.
    expect(r.stt.streams[1].map((f) => f[0])).toEqual(range(11, 60));
    // Le deuxième flux rend jusqu'à sa position 4 000 (la trame 50), puis tombe.
    r.stt.ev!.onPartial({ words: [said("two.", 3750)], isFinal: true });
    r.stt.ev!.onError(new Error("coupure"));
    await vi.advanceTimersByTimeAsync(1000);
    // 3 s avant, dans ses positions à lui (pas celles du premier flux) : à partir de la trame 21.
    expect(r.stt.streams[2].map((f) => f[0])).toEqual(range(21, 60));
    expect(r.commits.map((c) => c.text)).toEqual(["one.", "two."]);
    await r.pipeline.stop();
  });

  it("une autre captation ne reçoit pas le contexte de la précédente", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    await r.speak(20);
    await r.pipeline.stop();
    r.pipeline.setCapture("page-2");
    await r.pipeline.start();
    expect(r.stt.streams[1]).toHaveLength(0);
    expect(events).not.toHaveBeenCalledWith("stt.warmup", expect.anything());
    await r.pipeline.stop();
  });

  it("si le STT refuse d'ouvrir au démarrage du micro, l'audio attend et la reconnaissance reprend avec recul", async () => {
    const r = room();
    const degraded: string[] = [];
    r.pipeline.on("degraded", (d) => degraded.push(d.mode));
    const start = r.stt.start.bind(r.stt);
    let refusals = 2;
    r.stt.start = async (o, ev) => {
      if (refusals-- > 0) throw new Error("AssemblyAI : Unauthorized Connection: Too many concurrent sessions");
      return start(o, ev);
    };
    await r.pipeline.start(); // ne lève pas : le micro ne reste pas ouvert sans reconnaissance
    expect(degraded).toEqual(["stt-lost"]);
    await r.speak(35); // essais à 1 s (refusé) puis à 3 s (accepté)
    expect(r.stt.streams).toHaveLength(1);
    expect(r.stt.streams[0]).toHaveLength(35); // rien de perdu
    expect(degraded).toEqual(["stt-lost", "none"]);
    await r.pipeline.stop();
  });

  const said = (text: string, startMs: number) => ({ text, startMs, endMs: startMs + 250 });

  it("à l'arrêt du micro, ce que le STT n'avait pas encore rendu arrive encore et part, puis le micro se dit éteint", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    const order: string[] = [];
    r.pipeline.on("src.commit", (e) => order.push(e.text));
    r.pipeline.on("mic", (e) => order.push(e.on ? "micro ouvert" : "micro éteint"));
    await r.pipeline.start();
    await r.speak(100); // 10 s de parole
    r.stt.ev!.onPartial({ words: [said("one", 1000), said("two.", 1300)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    // Le STT est en retard (rafale après une coupure) : il n'a rendu que jusqu'à 1 550 ms sur 10 000.
    r.stt.onDrain = async (ev) => {
      await new Promise((resolve) => setTimeout(resolve, 6000)); // le temps de transcrire le reste
      ev.onPartial({ words: [said("three", 8000), said("four.", 8300)], isFinal: true });
      ev.onUtteranceEnd();
      return true;
    };
    const stopped = r.pipeline.stop();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(order).toEqual(["micro ouvert", "one two.", "three four.", "micro éteint"]);
    // L'attente se borne à ce qui reste à entendre, plus 5 s : 10 000 − 1 550 + 5 000.
    expect(r.stt.drains).toEqual([13_450]);
    expect(events).toHaveBeenCalledWith("stt.drain", { behindMs: 8450, waitMs: 13_450, ms: 6000, complete: true });
  });

  it("l'attente de l'arrêt est bornée, à une minute au plus ; après elle, ce flux ne compte plus", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    await r.speak(20); // 2 s de parole, rien de rendu
    r.stt.onDrain = async (_ev, drainMs) => {
      await new Promise((resolve) => setTimeout(resolve, drainMs)); // le STT ne confirme jamais
      return false;
    };
    const stopped = r.pipeline.stop();
    await vi.advanceTimersByTimeAsync(7000);
    await stopped;
    expect(r.stt.drains).toEqual([7000]);
    expect(events).toHaveBeenCalledWith("stt.drain", { behindMs: 2000, waitMs: 7000, ms: 7000, complete: false });
    // Un tour arrivé trop tard : le micro est éteint, il ne part pas.
    r.stt.ev!.onPartial({ words: [said("ghost.", 100)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    expect(r.commits).toEqual([]);

    // 70 s sans un mot rendu : l'attente ne dépasse pas une minute.
    r.stt.onDrain = undefined;
    await r.pipeline.start();
    await r.speak(700);
    await r.pipeline.stop();
    expect(r.stt.drains).toEqual([7000, 60_000]);
    // ~3,5 s : l'analyse de la hauteur (`LiveProsody`) de près de 800 trames de parole.
  }, 20_000);

  it("à l'arrêt du serveur, le STT se ferme sans attendre son retard", async () => {
    const r = room();
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    await r.speak(20);
    await r.pipeline.stop({ drain: false });
    expect(r.stt.drains).toEqual([undefined]);
    expect(events).not.toHaveBeenCalledWith("stt.drain", expect.anything());
  });

  it("formateur réadmis pendant l'attente : son audio attend la fin de l'ancien flux, sans s'y mêler", async () => {
    // Le chemin de `handlers.ts` : le démarrage suit l'arrêt, qui attend le retard du STT.
    const r = room();
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    const frame = (seq: number) => new Uint8Array(3200).fill(seq);
    for (let seq = 1; seq <= 30; seq++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(frame(seq), { seq, tCapture: Date.now() });
    }
    r.stt.onDrain = async (ev) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      ev.onPartial({ words: [said("late.", 2500)], isFinal: true });
      ev.onUtteranceEnd();
      return true;
    };
    const stopping = r.pipeline.stop();
    r.pipeline.setCapture("page-1");
    const started = stopping.then(() => r.pipeline.start());
    for (let seq = 31; seq <= 40; seq++) {
      await vi.advanceTimersByTimeAsync(100);
      r.pipeline.pushAudio(frame(seq), { seq, tCapture: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(1000);
    await started;
    expect(r.commits.map((c) => c.text)).toEqual(["late."]);
    expect(r.commits[0].tEnd).toBe(T0 + 2750); // daté par l'horloge de son flux, pas du suivant
    expect(r.stt.streams).toHaveLength(2);
    // Le contexte d'abord (les 3 dernières secondes : trames 1 à 30), puis ce qui a attendu.
    expect(r.stt.streams[1].map((f) => f[0])).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(r.pipeline.audio.dropped).toBe(0);
    r.stt.onDrain = undefined;
    await r.pipeline.stop();
  });

  it("la relève attend que le STT ait rendu la parole d'avant la pause : l'ancienne session n'emporte rien", async () => {
    const r = room();
    await r.pipeline.start();
    const push = async (n: number, pcm: Uint8Array) => {
      for (let i = 0; i < n; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(pcm);
      }
    };
    vi.setSystemTime(Date.now() + 170 * 60_000);
    await push(30, LOUD); // 3 s de parole
    r.stt.ev!.onPartial({ words: [said("so", 100), said("we.", 300)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await push(20, FRAME); // 2 s de pause, mais le STT n'a rendu que la première demi-seconde
    expect(r.stt.streams).toHaveLength(1);
    r.stt.ev!.onPartial({ words: [said("start", 1500), said("now.", 2600)], isFinal: true });
    r.stt.ev!.onUtteranceEnd();
    await push(2, FRAME); // la même pause, le STT à jour : relève
    expect(r.stt.streams).toHaveLength(2);
    expect(r.commits.map((c) => c.text)).toEqual(["so we.", "start now."]);
    await r.pipeline.stop();
  });

  it("un flux STT qui s'ouvre après l'arrêt du micro est refermé", async () => {
    const r = room();
    r.stt.startMs = 500;
    const start = r.pipeline.start();
    const stop = r.pipeline.stop(); // le formateur repart pendant l'ouverture
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([start, stop]);
    expect(r.stt.streams).toHaveLength(1);
    expect(r.stt.closed).toEqual([0]);
  });

  it("sans formateur admis, une trame n'est ni gardée ni comptée comme reçue", async () => {
    const r = room();
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    r.pipeline.pushAudio(LOUD, { seq: 1, tCapture: Date.now() });
    await r.pipeline.stop();
    // Une trame en retard de l'ancienne liaison : personne ne l'attend.
    r.pipeline.pushAudio(LOUD, { seq: 2, tCapture: Date.now() });
    expect(r.pipeline.audio.buffered).toBe(0);
    // La même page revient : la trame 2, renvoyée, n'est pas prise pour un doublon.
    r.pipeline.setCapture("page-1");
    await r.pipeline.start();
    r.pipeline.pushAudio(LOUD, { seq: 2, tCapture: Date.now() });
    expect(r.stt.streams[1]).toHaveLength(2); // la trame 1 en contexte (D37), puis la 2
    expect(r.pipeline.audio.duplicates).toBe(0);
    await r.pipeline.stop();
  });
});

describe("Pipeline — le STT révise le nombre de mots (D36)", () => {
  const words = (s: string) => s.split(" ").map((text, i) => ({ text, startMs: i * 300, endMs: i * 300 + 250 }));

  it("un mot retiré en amont ne fait perdre aucun mot à la salle, et la révision est journalisée", async () => {
    const r = room(false);
    const turns: string[] = [];
    r.pipeline.on("stt.turn", (e) => turns.push(`${e.kind}:${e.words.length}`));
    const events = vi.spyOn(r.metrics, "event");
    await r.pipeline.start();
    await r.speak(30);
    r.stt.ev!.onPartial({ words: words("we deploy the new pipeline"), isFinal: false });
    r.stt.ev!.onPartial({ words: words("we deploy the new pipeline on"), isFinal: false });
    r.stt.ev!.onPartial({ words: words("we deploy new pipeline on friday"), isFinal: false }); // « the » retiré
    r.stt.ev!.onPartial({ words: words("we deploy new pipeline on friday morning."), isFinal: true });
    r.stt.ev!.onUtteranceEnd();

    expect(r.commits.map((c) => c.text)).toEqual(["we deploy the new pipeline on friday morning."]);
    // Tout ce que le STT a envoyé part vers l'enregistreur, dans l'ordre.
    expect(turns).toEqual(["partial:5", "partial:6", "partial:6", "final:7", "end:0"]);
    const commit = events.mock.calls.find(([type]) => type === "commit")![1];
    expect(commit).toMatchObject({ sttShifts: 1, sttShiftedWords: 1, sttContradicted: 1 });
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
    const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo: true, speechThresholdDb: -35, quickStart: opts.quickStart ?? false, joinShort: false, wholeSentences: false });
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

describe("Pipeline — sourdine du formateur", () => {
  it("un segment entendu après une sourdine n'est pas daté d'avant elle", async () => {
    const r = room();
    const seen: { tStart: number; turnStart: boolean }[] = [];
    r.pipeline.on("src.commit", (e) => seen.push(e));
    await r.pipeline.start();
    await r.speak(10); // la position p du flux est dite à T0 + p, jusqu'à T0 + 1000
    r.stt.ev!.onPartial({ words: [{ text: "hello.", startMs: 100, endMs: 600, isFinal: true }], isFinal: true });
    r.pipeline.setMuted(true);
    await vi.advanceTimersByTimeAsync(60_000);
    r.pipeline.setMuted(false); // reprise à T0 + 61 000 ; le flux, lui, reprend à la position 1000
    await r.speak(10);
    // Le STT colle un mot d'avant la sourdine (position 800) à la phrase d'après (07/11/2026).
    r.stt.ev!.onPartial({
      words: [
        { text: "so", startMs: 800, endMs: 950, isFinal: true },
        { text: "again.", startMs: 1100, endMs: 1600, isFinal: true },
      ],
      isFinal: true,
    });
    expect(seen).toHaveLength(2);
    expect(seen[1].tStart).toBe(T0 + 61_000);
    expect(seen[1].turnStart).toBe(true); // et non 200 ms après « hello. »
    await r.pipeline.stop();
  });

  it("à la sourdine, le STT clôt la phrase en cours : elle part sans attendre la reprise", async () => {
    const r = forcingRoom();
    await r.pipeline.start();
    await r.push(8, true); // 0,8 s de parole, pas de pause : rien de forcé
    expect(r.forced).toHaveLength(0);
    r.pipeline.setMuted(true);
    expect(r.forced).toHaveLength(1);
    r.pipeline.setMuted(false);
    r.pipeline.setMuted(true); // aucune parole depuis : rien à clore
    expect(r.forced).toHaveLength(1);
    await r.pipeline.stop();
  });

  it("la reprise ouvre une prise de parole : son premier morceau part au premier blanc", async () => {
    const r = forcingRoom({ quickStart: true });
    await r.pipeline.start();
    await r.push(9, true);
    await r.push(2, false);
    expect(r.forced).toHaveLength(1); // premier morceau
    await r.push(9, true);
    r.pipeline.setMuted(true); // la phrase en cours est close
    expect(r.forced).toHaveLength(2);
    r.pipeline.setMuted(false);
    await r.push(9, true); // 0,9 s : trop peu pour la règle ordinaire, assez pour un premier morceau
    await r.push(2, false);
    expect(r.forced).toHaveLength(3);
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
    const tuning = () => ({ commit: {}, contextSegments: 2, baseSpeed: 1, followTempo, speechThresholdDb: -35, quickStart: false, joinShort: false, wholeSentences: false });
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

describe("Pipeline — morceaux courts attachés à la suite (D32)", () => {
  function joinRoom() {
    const r = room(true, true);
    const silence = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(FRAME);
      }
    };
    /** Texte définitif d'un tour : des mots de 200 ms bout à bout à partir de `at` (position du flux). */
    const final = (at: number, text: string) =>
      r.stt.ev!.onPartial({ words: text.split(" ").map((t, i) => ({ text: t, startMs: at + i * 200, endMs: at + (i + 1) * 200, isFinal: true })), isFinal: true });
    return { ...r, silence, final };
  }

  it("un morceau de trois mots ou moins part avec la suite quand l'orateur reprend aussitôt", async () => {
    const r = joinRoom();
    await r.pipeline.start();
    await r.speak(10);
    r.final(400, "Um, hello,");
    await r.speak(10); // il continue de parler
    expect(r.commits).toHaveLength(0);
    r.final(900, "how are you today?");
    expect(r.commits.map((c) => c.text)).toEqual(["Um, hello, how are you today?"]);
    await r.pipeline.stop();
  });

  it("après une vraie pause de l'orateur, le morceau court part seul", async () => {
    const r = joinRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(1300, "Hello.");
    await r.silence(4); // 0,4 s : on ne sait pas encore
    expect(r.commits).toHaveLength(0);
    await r.silence(4); // 0,8 s : la phrase était finie
    expect(r.commits.map((c) => c.text)).toEqual(["Hello."]);
    await r.pipeline.stop();
  });

  it("après « Mr. », le nom est attendu jusqu'à 1,5 s de silence", async () => {
    const r = joinRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(900, "Um, hello, Mr.");
    await r.silence(9); // 0,9 s : la pause de l'étudiant, le 9/11
    expect(r.commits).toHaveLength(0);
    await r.speak(5);
    r.final(2400, "President.");
    expect(r.commits.map((c) => c.text)).toEqual(["Um, hello, Mr. President."]);
    await r.pipeline.stop();
  });

  it("un morceau retenu n'attend jamais plus de 4 s", async () => {
    const r = joinRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(1300, "Uh,");
    await r.speak(35); // il parle, mais rien n'est encore reconnu
    expect(r.commits).toHaveLength(0);
    await r.speak(10);
    expect(r.commits.map((c) => c.text)).toEqual(["Uh,"]);
    await r.pipeline.stop();
  });

  it("un morceau retenu part quand le formateur arrête le micro : aucun mot perdu", async () => {
    const r = joinRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(1100, "Thank you.");
    expect(r.commits).toHaveLength(0);
    await r.pipeline.stop();
    expect(r.commits.map((c) => c.text)).toEqual(["Thank you."]);
  });
});

describe("Pipeline — phrases entières (D33)", () => {
  /** Réglages d'usine : morceaux courts et phrases coupées attachés à la suite. */
  function sentenceRoom(wholeSentences = true) {
    const r = room(true, true, wholeSentences);
    const silence = async (frames: number) => {
      for (let i = 0; i < frames; i++) {
        await vi.advanceTimersByTimeAsync(100);
        r.pipeline.pushAudio(FRAME);
      }
    };
    /** Texte définitif d'un tour : des mots de 200 ms bout à bout à partir de `at` (position du flux). */
    const final = (at: number, text: string) =>
      r.stt.ev!.onPartial({ words: text.split(" ").map((t, i) => ({ text: t, startMs: at + i * 200, endMs: at + (i + 1) * 200, isFinal: true })), isFinal: true });
    return { ...r, silence, final };
  }

  it("un morceau qui finit sur « to » attend la suite et part avec elle (séance du 9/11)", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "It's really an honor to");
    await r.speak(10); // l'orateur hésite puis reprend
    expect(r.commits).toHaveLength(0);
    r.final(1500, "be here today.");
    expect(r.commits.map((c) => c.text)).toEqual(["It's really an honor to be here today."]);
    await r.pipeline.stop();
  });

  it("une hésitation finale (« uh, ») n'achève pas la phrase", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "I don't know that, uh,");
    await r.speak(5);
    expect(r.commits).toHaveLength(0);
    r.final(1400, "I can give you advice.");
    expect(r.commits.map((c) => c.text)).toEqual(["I don't know that, uh, I can give you advice."]);
    await r.pipeline.stop();
  });

  it("le point d'une coupe forcée après « the » n'achève pas la phrase", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(300, "Then we will look at the.");
    await r.speak(5);
    expect(r.commits).toHaveLength(0);
    r.final(1600, "results now.");
    // Le faux point disparaît : la traduction lit une seule phrase (D34).
    expect(r.commits.map((c) => c.text)).toEqual(["Then we will look at the results now."]);
    await r.pipeline.stop();
  });

  it("un faux point après un auxiliaire (« is. ») n'achève pas la phrase (test 7, D34)", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(300, "The truth is the world is.");
    await r.speak(5);
    expect(r.commits).toHaveLength(0);
    r.final(1800, "In a place where it can solve its problems.");
    expect(r.commits.map((c) => c.text)).toEqual(["The truth is the world is In a place where it can solve its problems."]);
    await r.pipeline.stop();
  });

  it("une vraie fin de phrase part tout de suite, même suivie d'un mot ordinaire", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(15);
    r.final(300, "People are healthier today.");
    expect(r.commits.map((c) => c.text)).toEqual(["People are healthier today."]);
    await r.pipeline.stop();
  });

  it("sans le réglage, la même phrase part en deux morceaux", async () => {
    const r = sentenceRoom(false);
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "It's really an honor to");
    expect(r.commits.map((c) => c.text)).toEqual(["It's really an honor to"]);
    await r.pipeline.stop();
  });

  it("une phrase finie (point, question) part aussitôt", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "Is it better than before?");
    expect(r.commits.map((c) => c.text)).toEqual(["Is it better than before?"]);
    r.final(1400, "People are healthier today.");
    expect(r.commits.map((c) => c.text)).toEqual(["Is it better than before?", "People are healthier today."]);
    await r.pipeline.stop();
  });

  it("après 2,5 s de vrai silence, le morceau part seul : rien n'est perdu", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "It's really an honor to");
    await r.silence(20); // 2 s : l'orateur cherche ses mots
    expect(r.commits).toHaveLength(0);
    await r.silence(7); // 2,7 s : il s'est arrêté
    expect(r.commits.map((c) => c.text)).toEqual(["It's really an honor to"]);
    await r.pipeline.stop();
  });

  it("un morceau retenu n'attend jamais plus de 8 s", async () => {
    const r = sentenceRoom();
    await r.pipeline.start();
    await r.speak(13);
    r.final(300, "It's really an honor to");
    await r.speak(75); // il parle, mais rien n'est encore reconnu
    expect(r.commits).toHaveLength(0);
    await r.speak(10);
    expect(r.commits.map((c) => c.text)).toEqual(["It's really an honor to"]);
    await r.pipeline.stop();
  });
});
