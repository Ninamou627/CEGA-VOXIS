/**
 * Ce que le téléphone fait de sa file d'écoute — partagé entre la page apprenant et les
 * apprenants simulés du test de charge (`npm run load`), pour que la latence mesurée soit
 * celle qu'entend un vrai téléphone.
 *
 * Le téléphone ne saute plus rien et n'accélère plus rien (D32). Le 9/11/2026, l'apprenant
 * entendait une voix « dégradée, pas fluide » et des phrases perdues :
 *   - les trois voix jamais jouées des séances du 8/11 avaient été livrées 8 à 12 s après
 *     la fin de la phrase (reconnaissance en retard), et le téléphone jetait toute voix de
 *     plus de 8 s ;
 *   - il étirait la voix (×1,08 à ×1,25, hauteur préservée) dès que sa file dépassait 2 s,
 *     en y comptant la voix en cours : 39 % du temps d'écoute étiré, dont la moitié sans
 *     rien derrière.
 * Le retard se résorbe désormais pendant les pauses de l'orateur ; « Revenir au direct »
 * reste le seul moyen de vider la file.
 */

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
