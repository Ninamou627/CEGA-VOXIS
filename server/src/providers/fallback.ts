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

export interface HedgeHooks {
  /** Le primaire vient d'échouer (erreur ou délai dépassé) ; le secours prend le relais. */
  onFallback: (err: Error) => void;
  /** Le primaire répond de nouveau. */
  onRecover: () => void;
  /** Le secours, parti en parallèle parce que le primaire tardait, a répondu le premier. */
  onHedge?: (ms: number) => void;
}

const timeoutError = (ms: number) => Object.assign(new Error(`sans réponse en ${ms} ms`), { name: "TimeoutError" });

/**
 * Secours en parallèle, avec disjoncteur (D39, F-06).
 *
 * Le primaire est appelé ; s'il n'a pas répondu après `hedgeAfterMs`, le secours part en
 * parallèle et la première réponse est retenue — un appel lent ne bloque plus la chaîne, au
 * prix d'un segment payé deux fois quand le primaire traîne. Sa lenteur seule ne le
 * disqualifie pas pour les segments suivants : il reste le primaire.
 *
 * Au-delà de `deadlineMs`, l'étage abandonne : mieux vaut un segment sans voix qu'une salle
 * qui attend (le texte source reste affiché).
 *
 * À la première erreur du primaire — un refus, ou rien à l'échéance —, le secours prend le
 * relais pour ce segment ET les suivants pendant `cooldownMs` (l'ancien `Breaker`) : on ne
 * paie pas un aller-retour raté à chaque segment quand une API est en panne ou sans crédit.
 * Le primaire est réessayé une fois le délai écoulé ; s'il répond, on revient dessus.
 */
export class Hedge {
  /** Instant de la dernière panne du primaire ; null = disjoncteur fermé. */
  private openedAt: number | null = null;

  constructor(
    private readonly hedgeAfterMs: number,
    private readonly deadlineMs: number,
    private readonly hooks: HedgeHooks,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get usingBackup(): boolean {
    return this.openedAt !== null && this.now() - this.openedAt < this.cooldownMs;
  }

  call<T>(primary: () => Promise<T>, backup: () => Promise<T>): Promise<T> {
    if (this.usingBackup) return this.withDeadline(backup());
    return new Promise<T>((resolve, reject) => {
      const t0 = this.now();
      let settled = false;
      let backupStarted = false;
      let primaryErr: Error | null = null;
      let backupErr: Error | null = null;
      const timers: NodeJS.Timeout[] = [];
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        fn();
      };
      const startBackup = () => {
        if (backupStarted || settled) return;
        backupStarted = true;
        backup().then(
          (v) =>
            settle(() => {
              // Parti parce que le primaire tardait (pas d'erreur) : c'est une course gagnée,
              // le disjoncteur reste fermé.
              if (!primaryErr) this.hooks.onHedge?.(this.now() - t0);
              resolve(v);
            }),
          (e) => {
            backupErr = e as Error;
            if (primaryErr) settle(() => reject(primaryErr));
          },
        );
      };
      primary().then(
        (v) =>
          settle(() => {
            if (this.openedAt !== null) {
              this.openedAt = null;
              this.hooks.onRecover();
            }
            resolve(v);
          }),
        (e) => {
          if (settled) return;
          primaryErr = e as Error;
          this.openedAt = this.now();
          this.hooks.onFallback(primaryErr);
          if (backupErr) return settle(() => reject(primaryErr));
          startBackup();
        },
      );
      timers.push(setTimeout(startBackup, this.hedgeAfterMs));
      timers.push(
        setTimeout(() => {
          settle(() => {
            if (!primaryErr) {
              // Rien du primaire à l'échéance : une panne, pour ce segment et les suivants.
              primaryErr = timeoutError(this.deadlineMs);
              this.openedAt = this.now();
              this.hooks.onFallback(primaryErr);
            }
            reject(backupErr ?? primaryErr);
          });
        }, this.deadlineMs),
      );
    });
  }

  /** Disjoncteur ouvert : le secours seul, mais l'échéance tient toujours. */
  private withDeadline<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(timeoutError(this.deadlineMs)), this.deadlineMs);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e as Error);
        },
      );
    });
  }
}
