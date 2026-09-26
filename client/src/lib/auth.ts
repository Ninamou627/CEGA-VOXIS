/**
 * Connexion de l'administration et du formateur (D17).
 *
 * La session vit dans un cookie `httpOnly` : le navigateur l'envoie tout seul, avec les
 * requêtes comme avec la poignée de main WebSocket. Rien à garder ici, et rien dans l'URL.
 */
import type { AccountView, MeResponse } from "../../../shared/auth";

export type { AccountView };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Qui est connecté, ou null. Ne lève pas pour une absence de session. */
export async function whoami(): Promise<AccountView | null> {
  return (await call<MeResponse>("/api/auth/me")).account;
}

export async function login(username: string, password: string): Promise<AccountView> {
  const { account } = await call<MeResponse>("/api/auth/login", { username, password });
  if (!account) throw new Error("connexion refusée");
  return account;
}

export async function logout(): Promise<void> {
  await call("/api/auth/logout", {});
}
