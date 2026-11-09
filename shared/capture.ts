/**
 * Captation du micro formateur : le navigateur livre-t-il tout le son (D34) ?
 *
 * Au test 7 (9/11/2026), le serveur n'a reçu que 74 % du son du micro, contre 100 % au test 6
 * avec le même code. Les pertes tombaient toujours au même endroit d'un bloc de 10 ms : le
 * navigateur jetait des paquets entiers du micro avant même le worklet. Résultat : des mots
 * manquants ou déformés (« Peruvian » → « proving », « constantly doing » → « customly »).
 *
 * La mesure compare le son livré par le worklet au temps réel écoulé, à l'arrivée de chaque
 * trame : ni les minuteries d'un onglet en arrière-plan, ni un thread principal bloqué un
 * instant ne la faussent (les trames en retard arrivent ensemble, avec leur son).
 */

/** Fenêtre glissante de la mesure. */
export const CAPTURE_WINDOW_MS = 10_000;
/** En dessous, la reconnaissance manque des mots : on prévient le formateur et l'administration. */
export const CAPTURE_ALERT_BELOW = 0.95;
/** Un relevé toutes les 5 s de son livré. */
export const CAPTURE_REPORT_EVERY_MS = 5_000;

export class CaptureMeter {
  private frames: { t: number; ms: number }[] = [];
  private since: number | null = null;
  private sinceReport = 0;

  constructor(private windowMs = CAPTURE_WINDOW_MS) {}

  /**
   * Une trame arrive du worklet à l'instant `t` (ms), avec `ms` millisecondes de son.
   * Renvoie la part livrée quand un relevé est dû (toutes les 5 s de son), sinon null.
   */
  frame(t: number, ms: number): number | null {
    if (this.since == null) {
      // La première trame date le début : son propre son est antérieur à la mesure.
      this.since = t;
      return null;
    }
    this.frames.push({ t, ms });
    while (this.frames.length && this.frames[0].t <= t - this.windowMs) this.frames.shift();
    this.sinceReport += ms;
    if (this.sinceReport < CAPTURE_REPORT_EVERY_MS) return null;
    const r = this.ratio(t);
    if (r != null) this.sinceReport = 0;
    return r;
  }

  /** Son livré / temps écoulé sur la fenêtre ; null tant que la mesure couvre moins de 5 s. */
  ratio(now: number): number | null {
    if (this.since == null) return null;
    const from = Math.max(this.since, now - this.windowMs);
    const span = now - from;
    if (span < this.windowMs / 2) return null;
    let ms = 0;
    for (const f of this.frames) if (f.t > from) ms += f.ms;
    return ms / span;
  }
}
