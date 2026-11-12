/**
 * Débit de la voix traduite (D26) : chaque segment est dit dans le temps que le formateur a
 * mis à le dire, pause qui le précède comprise. La voix accélère quand il accélère, ralentit
 * quand il ralentit, et la file des téléphones ne grandit plus : une minute de parole donne
 * une minute de voix. Le 19/10/2026, avec une vitesse fixe à ×0,85, elle en donnait 1 min 13 s
 * et le retard grandissait sans limite (D24).
 *
 * La durée de la voix se prévoit avant la synthèse par son débit en caractères par seconde à
 * vitesse ×1, appris segment après segment (ElevenLabs en français : 17 car./s en médiane sur
 * 398 segments réels, p10 14, p90 19,4 ; la durée suit l'inverse de la vitesse demandée).
 *
 * La vitesse suit l'allure du formateur en douceur (D30). Calculée segment par segment, elle
 * sautait d'une borne à l'autre : sur un discours réel le 07/11/2026, 75 % des segments étaient
 * dits à ×0,85 ou à ×1,2, et 23 enchaînements sur 56 changeaient de 0,2 ou plus, ce que l'on
 * entend comme une voix qui accélère sans raison. Elle ne bouge plus que de 0,05 d'un segment
 * au suivant, et une prise de parole repart entre ×1,05 et ×1,1 : rejoué sur les deux séances,
 * plus aucun saut de 0,2, pour une latence à peu près inchangée.
 *
 * Plafond ×1,1 (D32, au lieu de ×1,2) : le 9/11/2026, l'apprenant trouvait la voix pressée,
 * « pas fluide » ; un tiers de la voix était dit à ×1,15 ou plus. Le téléphone n'accélère plus
 * de son côté : ×1,1 est désormais le débit le plus rapide qu'il entende.
 */
import type { Lang } from "../../../shared/protocol";

/** Débit de départ, avant le premier segment de la séance (ElevenLabs, français, 19/10/2026). */
export const DEFAULT_CPS = 17;
/**
 * ElevenLabs accepte 0,7 → 1,2. Sous ×1, la voix allongeait la file des téléphones (D30) ;
 * au-dessus de ×1,1, elle s'entend pressée (D32).
 */
export const MIN_SPEED = 1;
export const MAX_SPEED = 1.1;
/** Écart le plus grand entre deux segments qui se suivent (D30). */
export const MAX_STEP = 0.05;
/** Une prise de parole repart près du haut de la plage, sans hériter de la précédente. */
const TURN_MIN = 1.05;
const TURN_MAX = 1.1;
/** Plancher d'ElevenLabs, quand le réglage de l'administration descend sous ×1. */
const PROVIDER_MIN = 0.7;
/** Part du retard déjà en file que le segment doit résorber. */
const DRAIN = 0.5;
/** Un segment ne peut pas exiger moins de la moitié du temps du formateur, file comprise. */
const MIN_BUDGET_SHARE = 0.5;
/** Une longue pause du formateur ne doit pas donner un segment au ralenti : la file s'y vide déjà. */
const MAX_GAP_MS = 600;
/** Poids d'une nouvelle mesure dans le débit appris. */
const LEARN = 0.3;

export interface TempoInput {
  /** Caractères du texte à dire. */
  chars: number;
  /** Temps de parole du formateur pour ce segment : début du premier mot → fin du dernier. */
  sourceMs: number;
  /** Silence du formateur avant ce segment, s'il continuait de parler (null : prise de parole). */
  gapMs: number | null;
  /** Voix déjà envoyée aux téléphones et pas encore jouée. */
  aheadMs: number;
  /** Réglage « Vitesse de la voix » de l'administration : multiplie le résultat et ses bornes. */
  preference: number;
  /**
   * La salle a 3 s de retard ou plus (D42, palier 1) : la vitesse visée est le plafond, ×1,1,
   * toujours atteinte par pas de MAX_STEP pour ne pas s'entendre (D30).
   */
  catchUp?: boolean;
}

export interface TempoDecision {
  speed: number;
  /** Vitesse qu'aurait demandée ce segment seul, avant le lissage (D30). */
  target: number;
  /** Durée prévue de la voix à ×1, et temps dont elle dispose. */
  predictedMs: number;
  budgetMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export class Tempo {
  private cps = new Map<Lang, number>();
  /** Vitesse du dernier segment, par langue : le suivant ne s'en écarte que de MAX_STEP. */
  private last = new Map<Lang, number>();

  /** Débit appris de la voix (caractères par seconde à ×1). */
  charsPerSecond(lang: Lang): number {
    return this.cps.get(lang) ?? DEFAULT_CPS;
  }

  speedFor(lang: Lang, x: TempoInput): TempoDecision {
    const predictedMs = (x.chars / this.charsPerSecond(lang)) * 1000;
    const available = Math.max(0, x.sourceMs) + Math.min(MAX_GAP_MS, Math.max(0, x.gapMs ?? 0));
    const budgetMs = Math.max(available * MIN_BUDGET_SHARE, available - DRAIN * Math.max(0, x.aheadMs));
    const needed = budgetMs > 0 ? predictedMs / budgetMs : 1;
    const lo = clamp(MIN_SPEED * x.preference, PROVIDER_MIN, MAX_SPEED);
    const target = x.catchUp ? MAX_SPEED : clamp(needed * x.preference, lo, MAX_SPEED);
    const prev = this.last.get(lang);
    // Une prise de parole (ou le premier segment) repart près du milieu ; sinon, un petit pas.
    const window: [number, number] = x.gapMs == null || prev == null ? [TURN_MIN * x.preference, TURN_MAX * x.preference] : [prev - MAX_STEP, prev + MAX_STEP];
    const speed = round2(clamp(clamp(target, window[0], window[1]), lo, MAX_SPEED));
    this.last.set(lang, speed);
    return { speed, target: round2(target), predictedMs: Math.round(predictedMs), budgetMs: Math.round(budgetMs) };
  }

  /** La voix d'un segment est revenue : on affine son débit. */
  learn(lang: Lang, chars: number, durMs: number, speed: number): void {
    if (chars < 10 || durMs < 300) return; // trop court : les silences de bord dominent
    const observed = chars / ((durMs * speed) / 1000);
    if (observed < 6 || observed > 30) return; // mesure aberrante (durée mal lue)
    const prev = this.cps.get(lang);
    this.cps.set(lang, prev == null ? observed : prev + LEARN * (observed - prev));
  }

  reset(): void {
    this.cps.clear();
    this.last.clear();
  }
}
