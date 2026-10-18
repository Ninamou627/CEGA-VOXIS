/**
 * Ce que le téléphone fait de sa file d'écoute — partagé entre la page apprenant et les
 * apprenants simulés du test de charge (`npm run load`), pour que la latence mesurée soit
 * celle qu'entend un vrai téléphone.
 *
 * Mesuré le 14/10/2026 (D21) : la file ne vient pas d'une dérive (avec DeepL, la voix
 * française dure ×0,93 à ×1,04 la parole anglaise), mais d'un segment rapide qui attend
 * derrière un segment lent. Accélérer davantage la lecture n'y gagne que 0,1 à 0,5 s ;
 * la politique ci-dessous reste donc celle qui était en place.
 */

/** Au-delà de cette file, ou de cet âge, on saute le segment plutôt que de dériver (§10). */
export const MAX_QUEUE_MS = 8000;
export const MAX_AGE_MS = 8000;
/** Cadence à laquelle la page réajuste sa vitesse de lecture. */
export const RATE_EVERY_MS = 500;

/**
 * Vitesse de lecture locale (hauteur préservée), parade immédiate contre la file sans
 * attendre que l'audio déjà synthétisé soit passé. `queueMs` : audio restant à jouer,
 * segment en cours compris, à la vitesse courante ; `serverSpeed` : la vitesse déjà
 * appliquée à la synthèse, qu'on ne double pas.
 */
export function localRate(queueMs: number, serverSpeed: number): number {
  const target = queueMs > 6000 ? 1.25 : queueMs > 4000 ? 1.15 : queueMs > 2000 ? 1.08 : 1;
  return Math.max(1, Math.round((target / (serverSpeed || 1)) * 100) / 100);
}
