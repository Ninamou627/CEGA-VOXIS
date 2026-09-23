import type { Lang, ReportKind } from "../../../shared/protocol";

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
  /** « voice » : parlée au micro ; « text » : écrite sur le téléphone. */
  mode: "voice" | "text";
  audio?: { bytes: Uint8Array; mime: string; durMs: number };
  archived?: boolean;
}

/** Un signalement de qualité, avec le passage que le serveur a retrouvé. */
export interface ReportItem {
  n: number;
  at: number;
  who: string;
  kind: ReportKind;
  lang: Lang;
  srcText?: string;
  text?: string;
  e2eMs?: number | null;
}
