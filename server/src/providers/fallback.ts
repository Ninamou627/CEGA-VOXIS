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
