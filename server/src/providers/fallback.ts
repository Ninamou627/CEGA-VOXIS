/**
 * Une panne passagère (réseau, délai dépassé, service surchargé) mérite un second essai ;
 * un refus (crédits épuisés, clé refusée, requête invalide) se reproduirait à l'identique.
 * Les fournisseurs mettent le code HTTP en tête du message : « ElevenLabs 503 : … ».
 */
export function isTransient(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  const msg = e?.message ?? "";
  const status = msg.match(/^\S+(?: \S+)? (\d{3}) :/)?.[1];
  if (status) return status === "408" || status === "429" || status.startsWith("5");
  const code = e?.code ?? e?.cause?.code ?? "";
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|UND_ERR/i.test(`${msg} ${code}`);
}

/** Réessaie une fois après `delayMs` si la panne est passagère ; sinon l'erreur repart telle quelle. */
export async function retryTransient<T>(call: () => Promise<T>, delayMs = 300, onRetry?: (err: Error) => void): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isTransient(err)) throw err;
    onRetry?.(err as Error);
    await new Promise((r) => setTimeout(r, delayMs));
    return call();
  }
}

/**
 * Disjoncteur primaire / secours, commun aux étages.
 *
 * À la première erreur du primaire, le secours prend le relais pour ce segment ET
 * pour les suivants pendant `cooldownMs` : on ne paie pas un aller-retour raté à
 * chaque segment quand une API est en panne ou sans crédit. Le primaire est
 * réessayé une fois le délai écoulé ; s'il répond, on revient dessus.
 */
export class Breaker {
  /** Instant de la dernière panne du primaire ; null = disjoncteur fermé. */
  private openedAt: number | null = null;

  constructor(
    private readonly onFallback: (err: Error) => void,
    private readonly onRecover: () => void,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get usingBackup(): boolean {
    return this.openedAt !== null && this.now() - this.openedAt < this.cooldownMs;
  }

  async call<T>(primary: () => Promise<T>, backup: () => Promise<T>): Promise<T> {
    if (this.usingBackup) return backup();
    try {
      const out = await primary();
      if (this.openedAt !== null) {
        this.openedAt = null;
        this.onRecover();
      }
      return out;
    } catch (err) {
      this.openedAt = this.now();
      this.onFallback(err as Error);
      return backup();
    }
  }
}
