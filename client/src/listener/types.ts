import type { Lang } from "../../../shared/protocol";

/** Un segment figé : source (src.commit) puis sa traduction (tr.segment). */
export interface Line {
  seq: number;
  /** Horloge serveur du premier mot (affichée en heure locale). */
  tOrigin?: number;
  src?: string;
  tgt?: string;
  untranslated?: boolean;
}

export interface QuestionOutcome {
  srcText: string;
  text: string;
  delivered: boolean;
}

export type PlayerKind = "webaudio" | "element";

export interface LangChoice {
  value: Lang;
  options: Lang[];
}
