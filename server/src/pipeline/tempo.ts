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
 */
import type { Lang } from "../../../shared/protocol";

/** Débit de départ, avant le premier segment de la séance (ElevenLabs, français, 19/10/2026). */
export const DEFAULT_CPS = 17;
/** ElevenLabs accepte 0,7 → 1,2 ; en dessous de ×0,85 la voix traîne. */
export const MIN_SPEED = 0.85;
export const MAX_SPEED = 1.2;
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
  /** Réglage « Vitesse de la voix » de l'administration : multiplie le résultat. */
  preference: number;
}

export interface TempoDecision {
  speed: number;
  /** Durée prévue de la voix à ×1, et temps dont elle dispose. */
  predictedMs: number;
  budgetMs: number;
}

export class Tempo {
  private cps = new Map<Lang, number>();

  /** Débit appris de la voix (caractères par seconde à ×1). */
  charsPerSecond(lang: Lang): number {
    return this.cps.get(lang) ?? DEFAULT_CPS;
  }

  speedFor(lang: Lang, x: TempoInput): TempoDecision {
    const predictedMs = (x.chars / this.charsPerSecond(lang)) * 1000;
    const available = Math.max(0, x.sourceMs) + Math.min(MAX_GAP_MS, Math.max(0, x.gapMs ?? 0));
    const budgetMs = Math.max(available * MIN_BUDGET_SHARE, available - DRAIN * Math.max(0, x.aheadMs));
    const needed = budgetMs > 0 ? predictedMs / budgetMs : 1;
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, needed * x.preference));
    return { speed: Math.round(speed * 100) / 100, predictedMs: Math.round(predictedMs), budgetMs: Math.round(budgetMs) };
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
  }
}
