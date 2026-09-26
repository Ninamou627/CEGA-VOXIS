/**
 * Ce que les outils de mesure (`replay`, `load`) doivent présenter depuis D17 : une session
 * d'administration pour le formateur, un code de séance pour les apprenants.
 *
 * Les identifiants viennent de la configuration (ADMIN_USER, ADMIN_PASSWORD) : les scripts
 * emprunt le même chemin que les vraies interfaces, sans porte dérobée.
 */
import { loadConfig } from "../src/config";

/** ws://host/ws → http://host */
export function originOf(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

/** Se connecte et rend le cookie de session, à passer en en-tête du WebSocket. */
export async function adminCookie(origin: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD manque dans la configuration : les scripts ne peuvent pas se connecter.");
  }
  const res = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: cfg.ADMIN_USER, password: cfg.ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`connexion refusée (HTTP ${res.status}) : vérifiez ADMIN_USER et ADMIN_PASSWORD.`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("le serveur n'a pas déposé de cookie de session.");
  return cookie;
}

/** Le code de séance courant, ou un nouveau si aucun n'est ouvert. */
export async function roomCode(origin: string, cookie: string): Promise<string> {
  const get = await fetch(`${origin}/api/admin/code`, { headers: { cookie } });
  if (get.ok) return ((await get.json()) as { code: string }).code;
  const made = await fetch(`${origin}/api/admin/code`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  if (!made.ok) throw new Error(`impossible d'ouvrir un code de séance (HTTP ${made.status}).`);
  return ((await made.json()) as { code: string }).code;
}
