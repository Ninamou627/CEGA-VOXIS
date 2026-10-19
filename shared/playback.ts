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

/** Débit effectif maximal (synthèse × lecture locale) : au-delà, la voix devient difficile à suivre. */
export const MAX_EFFECTIVE_RATE = 1.3;

/**
 * Vitesse de lecture locale (hauteur préservée), parade immédiate contre la file sans
 * attendre que l'audio déjà synthétisé soit passé. `queueMs` : audio restant à jouer,
 * segment en cours compris, à la vitesse courante ; `serverSpeed` : la vitesse de synthèse
 * du dernier segment. Depuis que la synthèse suit le débit du formateur (D26), elle n'est plus
 * une réponse à la file : le téléphone rattrape sa propre file, sans que le débit effectif
 * dépasse ×1,3.
 */
export function localRate(queueMs: number, serverSpeed: number): number {
  const target = queueMs > 6000 ? 1.25 : queueMs > 4000 ? 1.15 : queueMs > 2000 ? 1.08 : 1;
  return Math.max(1, Math.round(Math.min(target, MAX_EFFECTIVE_RATE / (serverSpeed || 1)) * 100) / 100);
}

/** Silence du formateur à partir duquel une pause se retrouve à l'écoute. */
const KEPT_PAUSE_FROM_MS = 400;
/** Pause rendue au plus, et part du silence du formateur qu'elle reprend. */
const KEPT_PAUSE_MAX_MS = 350;
const KEPT_PAUSE_SHARE = 0.4;
/** Au-delà de ce retard, le téléphone enchaîne sans pause : il doit rattraper. */
const KEPT_PAUSE_LATE_MS = 1500;

/**
 * Pause à marquer avant un segment (D26). Quand le téléphone a du retard, les segments
 * s'enchaînaient sans blanc : les pauses du formateur disparaissaient justement quand il
 * parlait vite. On en garde une partie (40 %, 350 ms au plus), tant que le retard reste
 * sous 1,5 s. `sourcePauseMs` : silence du formateur avant ce segment ; `silentMs` : silence
 * déjà écoulé sur le téléphone depuis la fin du précédent ; `lateMs` : retard du téléphone.
 */
export function keptPauseMs(sourcePauseMs: number | null | undefined, silentMs: number, lateMs: number): number {
  if (sourcePauseMs == null || sourcePauseMs < KEPT_PAUSE_FROM_MS || lateMs > KEPT_PAUSE_LATE_MS) return 0;
  const target = Math.min(KEPT_PAUSE_MAX_MS, Math.round(sourcePauseMs * KEPT_PAUSE_SHARE));
  return Math.max(0, target - Math.max(0, silentMs));
}
