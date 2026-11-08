import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { clientAddress, fastifyTrustProxy } from "./client-address";

const CADDY = "172.18.0.4";
const req = (xff?: string | string[]) => ({ headers: xff == null ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: CADDY } }) as Parameters<typeof clientAddress>[0];

describe("Adresse du client derrière un reverse proxy", () => {
  it("sans proxy de confiance, l'adresse de la connexion, quoi que dise l'en-tête", () => {
    expect(clientAddress(req("203.0.113.7"), false)).toBe(CADDY);
  });

  it("derrière Caddy, l'adresse qu'il a transmise, et non la sienne", () => {
    expect(clientAddress(req("203.0.113.7"), true)).toBe("203.0.113.7");
  });

  it("une adresse inventée par le client ne passe pas : seule compte la dernière entrée", () => {
    expect(clientAddress(req("10.9.9.9, 203.0.113.7"), true)).toBe("203.0.113.7");
    expect(clientAddress(req(["10.9.9.9", "203.0.113.7"]), true)).toBe("203.0.113.7");
  });

  it("sans en-tête, l'adresse de la connexion", () => {
    expect(clientAddress(req(), true)).toBe(CADDY);
    expect(clientAddress(req(" "), true)).toBe(CADDY);
  });

  it("les requêtes HTTP voient la même adresse que la poignée de main WebSocket", async () => {
    for (const trust of [true, false]) {
      const app = Fastify({ trustProxy: fastifyTrustProxy(trust) });
      app.get("/ip", (r) => ({ ip: r.ip, ws: clientAddress(r.raw, trust) }));
      const res = await app.inject({ url: "/ip", remoteAddress: CADDY, headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.7" } });
      const { ip, ws } = res.json() as { ip: string; ws: string };
      expect(ip).toBe(trust ? "203.0.113.7" : CADDY);
      expect(ws).toBe(ip);
      await app.close();
    }
  });
});
