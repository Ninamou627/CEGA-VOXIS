/**
 * Connexions HTTP vers les fournisseurs : gardées ouvertes, et réchauffées.
 *
 * Mesuré le 14/10/2026 (D20) : le `fetch` de Node ferme une connexion inactive au bout de
 * 4 s, et la requête suivante en rouvre une — 1 à 2,5 s vers DeepL, jusqu'à 2 s vers
 * ElevenLabs, au lieu de 0,1 à 0,6 s. En séance, chaque phrase qui suit une pause du
 * formateur la paierait. Les connexions des fournisseurs sont donc gardées 60 s.
 *
 * DeepL ferme lui-même les siennes entre 20 et 45 s d'inactivité : `WarmLink` envoie une
 * requête gratuite à un fournisseur qui n'a pas servi depuis 15 s, tant que le micro est
 * ouvert, et à chaque ouverture du micro — la première phrase ne paie pas la connexion.
 */
import { Agent, fetch as undiciFetch } from "undici";

const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });

/** Le `fetch` des fournisseurs : même usage que celui de Node, connexions gardées 60 s. */
export const providerFetch = ((input: string | URL, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch;

/** Au-delà, une liaison inactive est réchauffée (DeepL ferme les siennes après 20 à 45 s). */
export const IDLE_PING_MS = 15_000;

/** Garde chaude la liaison vers un fournisseur : une requête gratuite s'il est resté inactif. */
export class WarmLink {
  private last = 0;

  constructor(
    private readonly ping: () => Promise<unknown>,
    private readonly idleMs = IDLE_PING_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Une vraie requête vient de passer par la liaison. */
  used(): void {
    this.last = this.now();
  }

  /** Réchauffe si la liaison n'a pas servi depuis `idleMs` (toujours, avec `force`). N'échoue jamais. */
  async warm(force = false): Promise<void> {
    if (!force && this.now() - this.last < this.idleMs) return;
    this.last = this.now();
    try {
      await this.ping();
    } catch {
      /* la prochaine vraie requête dira ce qui ne va pas */
    }
  }
}
