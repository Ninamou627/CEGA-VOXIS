import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AssemblyAiStt, describeClose, streamParams } from "./assemblyai";

/** Un faux AssemblyAI local : ce que fait le serveur à chaque connexion. */
async function fakeAssemblyAi(onConnection: (socket: WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", onConnection);
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
}

function listener() {
  const errors: string[] = [];
  return { errors, ev: { onPartial() {}, onUtteranceEnd() {}, onDiscard() {}, onError: (e: Error) => errors.push(e.message) } };
}

const BEGIN = JSON.stringify({ type: "Begin", id: "s", expires_at: 0 });
const TOO_MANY = "Unauthorized Connection: Too many concurrent sessions";
const OPEN = { lang: "en" as const, sampleRate: 16000 };

describe("AssemblyAI — ouverture de session (D37)", () => {
  it("le flux n'est rendu qu'à Begin, pas à l'ouverture du socket : l'audio part ensuite", async () => {
    const received: number[] = [];
    const srv = await fakeAssemblyAi((s) => {
      s.on("message", (d, binary) => binary && received.push((d as Buffer).length));
      setTimeout(() => s.send(BEGIN), 80);
    });
    const { ev, errors } = listener();
    const t0 = Date.now();
    const stream = await new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    stream.sendAudio(new Uint8Array(3200));
    await vi.waitFor(() => expect(received).toEqual([3200]));
    await stream.close();
    expect(errors).toEqual([]);
    await srv.close();
  });

  it("plafond de sessions : le message d'erreur à la place de Begin fait échouer l'ouverture, rien ne part", async () => {
    const received: number[] = [];
    const srv = await fakeAssemblyAi((s) => {
      s.on("message", (d, binary) => binary && received.push((d as Buffer).length));
      s.send(JSON.stringify({ error: TOO_MANY }));
      setTimeout(() => s.close(1008, TOO_MANY), 150);
    });
    const { ev, errors } = listener();
    await expect(new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev)).rejects.toThrow(TOO_MANY);
    // L'échec se dit par l'ouverture, pas en plus par onError : le pipeline réessaie une fois.
    await new Promise((r) => setTimeout(r, 250));
    expect(errors).toEqual([]);
    expect(received).toEqual([]);
    await srv.close();
  });

  it("fermeture avant Begin : l'ouverture échoue avec le motif d'AssemblyAI", async () => {
    const srv = await fakeAssemblyAi((s) => s.close(1008, "Invalid API key"));
    const { ev } = listener();
    await expect(new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev)).rejects.toThrow(
      "AssemblyAI fermé à l'ouverture (1008 — session refusée (clé API, ou plafond de sessions simultanées) : Invalid API key)",
    );
    await srv.close();
  });

  it("fermeture en séance : le pipeline reçoit le motif d'AssemblyAI, pas seulement le code", async () => {
    const srv = await fakeAssemblyAi((s) => {
      s.send(BEGIN);
      setTimeout(() => s.close(1008, TOO_MANY), 50);
    });
    const { ev, errors } = listener();
    await new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev);
    await vi.waitFor(() => expect(errors).toEqual([`AssemblyAI fermé (1008 — session refusée (clé API, ou plafond de sessions simultanées) : ${TOO_MANY})`]));
    await srv.close();
  });

  /** Le faux serveur répond à Terminate comme AssemblyAI (mesuré le 11/11/2026), ou pas. */
  const onTerminate = (s: WebSocket, then: () => void) =>
    s.on("message", (d, binary) => {
      if (!binary && JSON.parse(d.toString()).type === "Terminate") then();
    });

  it("arrêt avec attente : les tours rendus après Terminate arrivent encore, Termination le confirme", async () => {
    const srv = await fakeAssemblyAi((s) => {
      s.send(BEGIN);
      onTerminate(s, () => {
        const words = [{ text: "late.", start: 100, end: 400, word_is_final: true, confidence: 0.9 }];
        setTimeout(() => s.send(JSON.stringify({ type: "Turn", turn_order: 3, end_of_turn: true, transcript: "late.", words })), 150);
        setTimeout(() => s.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 1 })), 250);
        setTimeout(() => s.close(1000, "Session Ended"), 350);
      });
    });
    const turns: string[] = [];
    const errors: string[] = [];
    const ev = {
      onPartial: (p: { words: { text: string }[] }) => void turns.push(p.words.map((w) => w.text).join(" ")),
      onUtteranceEnd: () => void turns.push("fin de tour"),
      onDiscard() {},
      onError: (e: Error) => void errors.push(e.message),
    };
    const stream = await new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev);
    const t0 = Date.now();
    expect(await stream.close(5000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000); // à Termination, pas au bout du délai
    expect(turns).toEqual(["late.", "fin de tour"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors).toEqual([]);
    await srv.close();
  });

  it("arrêt avec attente : sans Termination, la fermeture n'attend pas plus que le délai donné", async () => {
    const srv = await fakeAssemblyAi((s) => s.send(BEGIN)); // Terminate reste sans réponse
    const { ev, errors } = listener();
    const stream = await new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev);
    const t0 = Date.now();
    expect(await stream.close(300)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors).toEqual([]); // fermée par nous : pas une panne
    await srv.close();
  });

  it("arrêt avec attente : une connexion coupée avant Termination arrête l'attente, et se dit comme une panne", async () => {
    const srv = await fakeAssemblyAi((s) => {
      s.send(BEGIN);
      onTerminate(s, () => setTimeout(() => s.terminate(), 50));
    });
    const { ev, errors } = listener();
    const stream = await new AssemblyAiStt({ apiKey: "k", endpoint: srv.url }).start(OPEN, ev);
    const t0 = Date.now();
    expect(await stream.close(5000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(errors).toEqual(["AssemblyAI fermé (1006 — sans motif)"]);
    await srv.close();
  });

  it("motif de fermeture : le sens du code, et ce qu'AssemblyAI en dit", () => {
    expect(describeClose(3008, "")).toBe("session expirée (limite de 3 h)");
    expect(describeClose(4001, "Not authorized")).toBe("Not authorized");
    expect(describeClose(1006, "")).toBe("sans motif");
  });
});

const base = { sampleRate: 16000, lang: "en" as const, gate: true, mode: "balanced" as const, keyterms: [] as string[] };

describe("AssemblyAI — paramètres d'ouverture du flux", () => {
  it("universal-streaming-english : ni mode, ni prompt, ni langue (refusés ou sans objet)", () => {
    const p = streamParams({ ...base, model: "universal-streaming-english", prompt: "Technical training.", keyterms: ["SCADA"] });
    expect(p.get("speech_model")).toBe("universal-streaming-english");
    expect(p.has("mode")).toBe(false);
    expect(p.has("prompt")).toBe(false);
    expect(p.has("language_detection")).toBe(false);
    expect(p.has("language_code")).toBe(false);
    expect(p.has("format_turns")).toBe(false);
    expect(p.get("keyterms_prompt")).toBe('["SCADA"]');
  });

  it("fin de phrase « Rapide » : clore le tour après 160 ms de silence ; « Équilibrée » : réglage d'AssemblyAI", () => {
    expect(streamParams({ ...base, model: "universal-streaming-english", mode: "min_latency" }).get("min_end_of_turn_silence_when_confident")).toBe("160");
    expect(streamParams({ ...base, model: "universal-streaming-english", mode: "balanced" }).has("min_end_of_turn_silence_when_confident")).toBe(false);
  });

  it("universal-streaming-multilingual : garde la détection de langue (garde-fou anti-écho)", () => {
    expect(streamParams({ ...base, model: "universal-streaming-multilingual" }).get("language_detection")).toBe("true");
    expect(streamParams({ ...base, model: "universal-streaming-multilingual", gate: false }).get("language_code")).toBe("en");
  });

  it("U3.5 Pro : mode, prompt et focalisation de la voix, sans réglage de fin de tour", () => {
    const p = streamParams({ ...base, model: "universal-3-5-pro", prompt: "Technical training.", voiceFocus: "near-field" });
    expect(p.get("mode")).toBe("balanced");
    expect(p.get("prompt")).toBe("Technical training.");
    expect(p.get("voice_focus")).toBe("near-field");
    expect(p.get("language_detection")).toBe("true");
    expect(p.has("min_end_of_turn_silence_when_confident")).toBe(false);
  });
});

