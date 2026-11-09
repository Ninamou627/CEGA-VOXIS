/**
 * Battement de cœur des WebSocket (D35).
 *
 * Une coupure réseau peut laisser une connexion ouverte sans que plus rien ne passe : ni le
 * serveur ni le navigateur ne la ferment avant plusieurs minutes. Le serveur envoie donc un
 * ping toutes les 10 s ; une connexion qui n'a pas répondu au précédent est coupée. Sa
 * fermeture suit le chemin ordinaire : le départ est journalisé et le nombre d'apprenants
 * reste juste. Les navigateurs répondent aux pings d'eux-mêmes, même onglet caché.
 */
import type { WebSocket, WebSocketServer } from "ws";

export const PING_EVERY_MS = 10_000;

/** Pourquoi le serveur a coupé une connexion — consigné avec le départ. */
export type CutReason = "no_pong" | "seat_taken";

export interface Heartbeat {
  /** Ping immédiat : la connexion répond-elle dans le délai ? */
  probe(ws: WebSocket, timeoutMs: number): Promise<boolean>;
  /** Coupe la connexion sans attendre de poignée de main (elle ne répond plus). */
  cut(ws: WebSocket, why: CutReason): void;
  /** Raison de la coupure, si c'est le serveur qui l'a décidée. */
  reason(ws: WebSocket): CutReason | undefined;
  stop(): void;
}

export function attachHeartbeat(wss: WebSocketServer, everyMs = PING_EVERY_MS): Heartbeat {
  /** A répondu depuis le dernier ping. */
  const alive = new WeakMap<WebSocket, boolean>();
  const why = new WeakMap<WebSocket, CutReason>();

  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });

  const cut = (ws: WebSocket, r: CutReason) => {
    if (!why.has(ws)) why.set(ws, r);
    ws.terminate();
  };

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        cut(ws, "no_pong");
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* déjà en fermeture */
      }
    }
  }, everyMs);
  timer.unref();
  wss.on("close", () => clearInterval(timer));

  return {
    probe(ws, timeoutMs) {
      if (ws.readyState !== ws.OPEN) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => {
          clearTimeout(t);
          ws.off("pong", onPong);
          ws.off("close", onClose);
          resolve(ok);
        };
        const onPong = () => done(true);
        const onClose = () => done(false);
        const t = setTimeout(() => done(false), timeoutMs);
        ws.on("pong", onPong);
        ws.on("close", onClose);
        try {
          ws.ping();
        } catch {
          done(false);
        }
      });
    },
    cut,
    reason: (ws) => why.get(ws),
    stop: () => clearInterval(timer),
  };
}
