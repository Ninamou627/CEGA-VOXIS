/**
 * Appels à l'API d'administration. Le cookie de session voyage tout seul ; une erreur du
 * serveur remonte avec son message, pour être affichée telle quelle.
 */
import type { CatalogVoice, OverviewResponse, SaveResponse, SettingsResponse } from "../../../shared/admin";
import type { CurrentCodeResponse, RoomCodeResponse } from "../../../shared/auth";
import type { Lang } from "../../../shared/protocol";
import type { Settings } from "../../../shared/settings";

export class AdminApi {
  // Aucun jeton : le cookie de session (D17) voyage tout seul avec chaque requête.
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api/admin${path}`, {
      ...init,
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  settings(): Promise<SettingsResponse> {
    return this.call("/settings");
  }

  save(settings: Settings): Promise<SaveResponse> {
    return this.call("/settings", { method: "PUT", body: JSON.stringify(settings) });
  }

  reset(): Promise<SaveResponse> {
    return this.call("/settings/reset", { method: "POST" });
  }

  overview(): Promise<OverviewResponse> {
    return this.call("/overview");
  }

  /** Code de séance courant (D17). `undefined` quand aucun n'est ouvert ou qu'il a expiré. */
  async code(): Promise<RoomCodeResponse | undefined> {
    return (await this.call<CurrentCodeResponse>("/code")).current ?? undefined;
  }

  /** Nouveau code : l'ancien QR code ne vaut plus rien. */
  rotateCode(hours?: number): Promise<RoomCodeResponse> {
    return this.call("/code", { method: "POST", body: JSON.stringify(hours ? { hours } : {}) });
  }

  catalog(refresh = false): Promise<{ voices: CatalogVoice[] }> {
    return this.call(`/voices/catalog${refresh ? "?refresh=1" : ""}`);
  }

  addVoice(id: string, lang: Lang): Promise<{ settings: Settings }> {
    return this.call("/voices", { method: "POST", body: JSON.stringify({ id, lang }) });
  }

  removeVoice(id: string, lang: Lang): Promise<{ settings: Settings }> {
    return this.call(`/voices/${encodeURIComponent(id)}?lang=${lang}`, { method: "DELETE" });
  }

  /** Écoute d'essai d'une voix dans une langue : un MP3 prêt à jouer. */
  async preview(id: string, lang: Lang): Promise<Blob> {
    const res = await fetch("/api/admin/voices/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, lang }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.blob();
  }
}
