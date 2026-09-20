import type { Lang } from "../../../shared/protocol";

/** Un segment figé : source (src.commit) puis sa traduction (tr.segment). */
export interface Line {
  seq: number;
  src?: string;
  tgt?: string;
  tOrigin?: number;
  /** Règle de coupe du commit verrouillé (ponctuation, proposition, silence…). */
  reason?: string;
}

/** Une question d'apprenant : texte reçu par l'événement, son reçu par la trame binaire. */
export interface QuestionItem {
  /** Rang d'arrivée dans la séance. */
  n: number;
  who: string;
  srcLang: Lang;
  srcText: string;
  lang: Lang;
  text: string;
  at: number;
  audio?: { bytes: Uint8Array; mime: string; durMs: number };
  archived?: boolean;
}
