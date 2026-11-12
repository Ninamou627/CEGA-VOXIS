/**
 * Contrôleur du retard, par langue (D42, audit F-05). Depuis D32, plus rien ne bornait le retard
 * en parole continue : le téléphone ne saute plus rien et n'accélère plus, et la voix ne rattrape
 * que pendant les pauses de l'orateur.
 *
 * Le retard est celui de la file : combien de temps une voix prête maintenant attendrait avant
 * d'être entendue, parce que les téléphones jouent encore les précédentes. C'est la part du
 * décalage qui s'accumule, et la seule que le débit ou les pauses peuvent rattraper : en mode
 * « phrases entières », le décalage par mot contient aussi le temps de dire la phrase (5 à 8 s
 * sur les essais), et des paliers posés sur lui resserreraient sans raison.
 *
 * Il est estimé de deux façons, et la plus grande l'emporte :
 *   - le modèle du serveur : chaque voix envoyée occupe la salle pendant sa durée ;
 *   - les accusés des téléphones : instant de l'ack + leur file, médiane des téléphones de la
 *     langue — ce que le modèle ignore (pauses gardées, téléphones lents, nouvel essai D40).
 *
 * Le retard se juge au moment où une voix se prépare : juste après l'envoi d'une voix, la file
 * compte aussi celle-ci, et un relevé pris à cet instant dépasserait d'une voix entière ce
 * qu'attendra la suivante (en dents de scie). Seule une décision de segment peut donc monter
 * d'un palier ; le relevé de chaque seconde ne fait que descendre, quand la file se vide
 * pendant une pause de l'orateur.
 *
 * Paliers, avec 1 s d'hystérésis à la descente :
 *   0 — sous 3 s : rien de plus que D26 ;
 *   1 — dès 3 s : plus de pause gardée, vitesse portée vers ×1,1 (par pas de 0,05, D30) ;
 *   2 — dès 5 s : en plus, formulation resserrée si l'administration l'a permis (éteint par défaut) ;
 *   3 — dès 8 s : en plus, alerte au formateur et à l'administration.
 */
import type { Lang, LagState, LagTier } from "../../../shared/protocol";

export type { LagState, LagTier };

/** Seuils d'entrée des paliers 1, 2 et 3 (ms). */
export const TIER_ENTER_MS = [3000, 5000, 8000] as const;
/** On ne redescend d'un palier qu'une seconde sous son seuil : pas de va-et-vient d'un segment à l'autre. */
export const HYSTERESIS_MS = 1000;

/** Palier suivant pour un retard donné : on monte d'autant de paliers que franchis, on descend avec hystérésis. */
export function nextTier(current: LagTier, retardMs: number): LagTier {
  let t: number = current;
  while (t < 3 && retardMs >= TIER_ENTER_MS[t]) t++;
  while (t > 0 && retardMs < TIER_ENTER_MS[t - 1] - HYSTERESIS_MS) t--;
  return t as LagTier;
}

export class LagControl {
  private state = new Map<Lang, LagState>();

  /**
   * Nouvelle estimation du retard d'une langue : rend son palier, et celui d'avant. `rise` faux :
   * relevé hors décision de segment, qui ne peut que faire descendre le palier et le retard affiché.
   */
  update(lang: Lang, retardMs: number, rise = true): { tier: LagTier; from: LagTier } {
    const prev = this.state.get(lang);
    const from = prev?.tier ?? 0;
    const r = Math.max(0, retardMs);
    let tier = nextTier(from, r);
    if (!rise && tier > from) tier = from;
    const shown = !rise && prev ? Math.min(prev.retardMs, r) : r;
    this.state.set(lang, { tier, retardMs: Math.round(shown) });
    return { tier, from };
  }

  tier(lang: Lang): LagTier {
    return this.state.get(lang)?.tier ?? 0;
  }

  get(lang: Lang): LagState {
    return this.state.get(lang) ?? { tier: 0, retardMs: 0 };
  }

  snapshot(): Partial<Record<Lang, LagState>> {
    return Object.fromEntries(this.state);
  }

  reset(): void {
    this.state.clear();
  }
}
