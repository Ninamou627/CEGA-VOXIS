/**
 * Adresse d'un client, la même pour les deux portes : les requêtes HTTP (connexion des comptes)
 * et la poignée de main WebSocket (codes de séance). Les freins contre les essais répétés
 * comptent par adresse.
 *
 * Derrière un reverse proxy (TRUST_PROXY), la connexion vient du proxy : le 07/11/2026, sur le
 * serveur de test, tous les appareils arrivaient de 172.18.0.4 (Caddy). Trente codes faux tapés
 * par n'importe qui bloquaient alors toutes les nouvelles connexions, et chaque bon code remettait
 * le compteur de tout le monde à zéro. L'adresse réelle est la dernière entrée de
 * X-Forwarded-For, celle que le proxy a écrite lui-même ; les précédentes viennent du client et
 * peuvent être inventées. On ne fait confiance qu'à un seul proxy.
 */
import type { IncomingMessage } from "node:http";

/**
 * Réglage `trustProxy` de Fastify, la même règle que `clientAddress` : on ne croit que la
 * connexion elle-même (saut 0, le proxy), donc `req.ip` est la dernière entrée de
 * X-Forwarded-For. `true` croirait toute la chaîne et prendrait la première, que le client
 * écrit ; un nombre de sauts n'est plus accepté par Fastify 5.12 (il ne croit alors plus rien).
 */
export function fastifyTrustProxy(trustProxy: boolean): ((address: string, hop: number) => boolean) | false {
  return trustProxy ? (_address, hop) => hop === 0 : false;
}

export function clientAddress(req: Pick<IncomingMessage, "headers" | "socket">, trustProxy: boolean): string | undefined {
  const socket = req.socket.remoteAddress;
  if (!trustProxy) return socket;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  const last = raw
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .at(-1);
  return last || socket;
}
