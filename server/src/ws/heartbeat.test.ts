import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { attachHeartbeat, type Heartbeat } from "./heartbeat";

/** Un client qui ne répond pas aux pings : la liaison figée de D35, vue du serveur. */
async function setup(everyMs: number) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const hb = attachHeartbeat(wss, everyMs);
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const server = new Map<string, import("ws").WebSocket>();
  wss.on("connection", (ws, req) => server.set(String(req.headers["x-name"]), ws));
  const connect = async (name: string, autoPong: boolean) => {
    const c = new WebSocket(url, { autoPong, headers: { "x-name": name } });
    await new Promise<void>((r) => c.once("open", () => r()));
    while (!server.has(name)) await new Promise((r) => setTimeout(r, 5));
    return { client: c, server: server.get(name)! };
  };
  return { wss, hb, connect };
}

const closeCode = (ws: import("ws").WebSocket) => new Promise<number>((r) => ws.once("close", (code) => r(code)));

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("battement de cœur (D35)", () => {
  it("coupe une liaison muette au second ping, garde une liaison vivante", async () => {
    const { wss, hb, connect } = await setup(40);
    cleanup = () => {
      hb.stop();
      for (const c of wss.clients) c.terminate();
      wss.close();
    };
    const live = await connect("vivant", true);
    const mute = await connect("muet", false);
    const t0 = Date.now();
    const code = await closeCode(mute.server);
    const took = Date.now() - t0;

    expect(code).toBe(1006); // terminate : pas de poignée de main
    expect(hb.reason(mute.server)).toBe("no_pong");
    expect(took).toBeLessThan(200); // ≤ 2 intervalles de 40 ms, avec de la marge
    // La liaison vivante a traversé les mêmes pings sans être coupée.
    await new Promise((r) => setTimeout(r, 150));
    expect(live.server.readyState).toBe(WebSocket.OPEN);
    expect(hb.reason(live.server)).toBeUndefined();
  });

  it("sonde : vrai si le client répond, faux sinon", async () => {
    const { wss, hb, connect } = await setup(60_000);
    cleanup = () => {
      hb.stop();
      for (const c of wss.clients) c.terminate();
      wss.close();
    };
    const live = await connect("vivant", true);
    const mute = await connect("muet", false);
    expect(await hb.probe(live.server, 500)).toBe(true);
    const t0 = Date.now();
    expect(await hb.probe(mute.server, 100)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);

    hb.cut(mute.server, "seat_taken");
    await closeCode(mute.server);
    expect(hb.reason(mute.server)).toBe("seat_taken");
  });
});
