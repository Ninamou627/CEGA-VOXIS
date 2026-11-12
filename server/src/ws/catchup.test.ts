import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerEvent } from "../../../shared/protocol";
import type { Auth } from "../auth";
import type { Config } from "../config";
import { Metrics } from "../metrics";
import type { Pipeline, PipelineEvents } from "../pipeline/pipeline";
import type { Providers } from "../providers/types";
import { Room } from "../room";
import type { Settings } from "../settings";
import type { Totals } from "../totals";
import { TypedEmitter } from "../util/emitter";
import { attachWs } from "./handlers";

/**
 * Le rattrapage du texte et le signalement des voix non jouées, de bout en bout à travers le
 * vrai `attachWs` (D40, F-08) : un apprenant coupé pendant que des segments se figent retrouve
 * toutes ses lignes au retour ; une voix non jouée se voit au journal et au tableau de bord.
 */

type Hello = Extract<ServerEvent, { t: "hello" }>;
const noop = () => {};
/** Ce que ces tests n'exercent pas : chaque appel ne fait rien. */
const inert = <T>() => new Proxy({}, { get: () => noop }) as T;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const pipeline = Object.assign(new TypedEmitter<PipelineEvents>(), {
    status: { stt: "stt", mt: "mt", tts: "tts", backlog: 0, degraded: "none", muted: false, speed: 1 },
    micSeq: null,
  });
  const metrics = new Metrics();
  const room = new Room("salle", "en", ["fr", "es"]);
  attachWs(wss, {
    room,
    pipeline: pipeline as unknown as Pipeline,
    providers: {} as Providers,
    metrics,
    config: { TRUST_PROXY: false } as unknown as Config,
    auth: { codes: { allow: () => true, fail: noop, succeed: noop }, checkRoomCode: async () => true, accountOf: async () => undefined } as unknown as Auth,
    log: { info: noop, warn: noop, error: noop },
    settings: () => ({ voice: { listenerVolume: 80 }, speech: { inputGainDb: 0, speechThresholdDb: -35, silenceAlertS: 20 } }) as Settings,
    totals: inert<Totals>(),
  });
  cleanup = () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  };
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

  /** Un téléphone : garde tout ce qu'il reçoit, dans l'ordre ; `until` attend un type d'événement. */
  const phone = async (join: Record<string, unknown> = {}) => {
    const ws = new WebSocket(url);
    const got: ServerEvent[] = [];
    let wake = noop;
    ws.on("message", (data, binary) => {
      if (binary) return;
      got.push(JSON.parse(data.toString()) as ServerEvent);
      wake();
    });
    await new Promise<void>((r) => ws.once("open", () => r()));
    const until = async <T extends ServerEvent["t"]>(t: T, nth = 1): Promise<Extract<ServerEvent, { t: T }>> => {
      for (;;) {
        const hits = got.filter((e) => e.t === t);
        if (hits.length >= nth) return hits[nth - 1] as Extract<ServerEvent, { t: T }>;
        await new Promise<void>((r) => (wake = r));
      }
    };
    ws.send(JSON.stringify({ t: "join", role: "listener", lang: "fr", code: "1234", ...join }));
    const hello = (await until("hello")) as Hello;
    return { ws, got, until, hello };
  };

  /** Le pipeline fige un segment, et sa traduction française si `translated`. */
  const say = (seq: number, translated = true) => {
    const tOrigin = Date.now();
    pipeline.emit("src.commit", { seq, text: `sentence ${seq}`, tOrigin, tEnd: tOrigin, tStart: tOrigin, turnStart: false, reason: "test", stream: 1, words: [] });
    if (translated) translate(seq);
  };
  const translate = (seq: number) => pipeline.emit("tr.segment", { seq, lang: "fr", text: `phrase ${seq}`, srcSeq: seq });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  /** Le téléphone perd le réseau ; le serveur le voit partir. */
  const cut = async (p: { ws: WebSocket }) => {
    p.ws.terminate();
    while (room.count("listener") > 0) await settle();
  };

  return { pipeline, metrics, phone, say, translate, settle, cut };
}

describe("retour d'une coupure : le texte manqué est renvoyé (D40)", () => {
  it("coupure pendant que 7 segments se figent (≈ 20 s) : toutes les lignes au retour, dans l'ordre", async () => {
    const { phone, say, translate, cut } = await setup();
    const a = await phone();
    expect(a.hello.epoch).toBeTruthy();
    for (const seq of [1, 2, 3]) say(seq);
    await a.until("tr.segment", 3);

    await cut(a);
    for (const seq of [4, 5, 6, 7, 8, 9]) say(seq);
    say(10, false); // le dernier : reconnu, sa traduction encore en route

    const b = await phone({ resume: { epoch: a.hello.epoch, seq: 3 } });
    const c = await b.until("catchup");
    expect(c.lines.map((l) => l.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(c.lines[0]).toMatchObject({ seq: 4, src: "sentence 4", tgt: "phrase 4" });
    expect(c.lines[6]).toMatchObject({ seq: 10, src: "sentence 10" });
    expect(c.lines[6].tgt).toBeUndefined();
    // Juste après `hello`, avant tout le direct.
    expect(b.got.findIndex((e) => e.t === "catchup")).toBe(b.got.findIndex((e) => e.t === "hello") + 1);
    // La traduction en route arrive ensuite en direct : rien ne tombe entre les deux.
    translate(10);
    expect(await b.until("tr.segment")).toMatchObject({ seq: 10, text: "phrase 10" });
  });

  it("serveur redémarré entre-temps (autre `epoch`) : tout le texte récent, pas « après le 150 »", async () => {
    const { phone, say } = await setup();
    for (const seq of [1, 2, 3]) say(seq);
    const b = await phone({ resume: { epoch: "ancien", seq: 150 } });
    expect(b.hello.epoch).not.toBe("ancien");
    expect((await b.until("catchup")).lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("une première connexion, ou rien de manqué : pas de rattrapage", async () => {
    const { phone, say, settle } = await setup();
    for (const seq of [1, 2]) say(seq);
    const first = await phone();
    const back = await phone({ resume: { epoch: first.hello.epoch, seq: 2 } });
    await settle();
    expect(first.got.some((e) => e.t === "catchup")).toBe(false);
    expect(back.got.some((e) => e.t === "catchup")).toBe(false);
  });
});

describe("voix non jouée sur un téléphone : signalée (D40)", () => {
  it("visible au journal, avec la voix du segment, et comptée pour le tableau de bord", async () => {
    const { phone, say, pipeline, metrics, settle } = await setup();
    const events: [string, Record<string, unknown>][] = [];
    const real = metrics.event.bind(metrics);
    vi.spyOn(metrics, "event").mockImplementation((type, data) => {
      events.push([type, data]);
      real(type, data);
    });
    const a = await phone();
    say(1);
    pipeline.emit("audio", { seq: 1, lang: "fr", mime: "audio/mpeg", durMs: 1200, tOrigin: Date.now(), srcSeq: 1, text: "phrase 1", bytes: new Uint8Array(4), voice: "voix-fr" });
    a.ws.send(JSON.stringify({ t: "play.fail", seq: 1, reason: "error", attempts: 2, player: "element" }));
    await settle();
    expect(events.find(([t]) => t === "play.fail")?.[1]).toMatchObject({ seq: 1, reason: "error", attempts: 2, player: "element", lang: "fr", voice: "voix-fr" });
    expect(metrics.snapshot().playFails).toBe(1);
  });

  it("un message mal formé est refusé", async () => {
    const { phone } = await setup();
    const a = await phone();
    a.ws.send(JSON.stringify({ t: "play.fail", seq: 1, reason: "boom", attempts: 2, player: "element" }));
    expect(await a.until("error")).toMatchObject({ code: "bad_event" });
  });
});
