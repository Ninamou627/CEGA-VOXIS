/**
 * Appels à l'API d'administration. Le jeton de session voyage en en-tête ; une erreur du
 * serveur remonte avec son message, pour être affichée telle quelle.
 */
import type { CatalogVoice, OverviewResponse, SaveResponse, SettingsResponse } from "../../../shared/admin";
import type { Lang } from "../../../shared/protocol";
import type { Settings } from "../../../shared/settings";

export class AdminApi {
  constructor(private readonly token: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api/admin${path}`, {
      ...init,
      headers: { "x-salle-token": this.token, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
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
      headers: { "x-salle-token": this.token, "content-type": "application/json" },
      body: JSON.stringify({ id, lang }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.blob();
  }
}
