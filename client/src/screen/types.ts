import type { Lang } from "../../../shared/protocol";

/** Un segment figé, avec sa traduction dans chaque langue diffusée. */
export interface Line {
  seq: number;
  src?: string;
  tgt: Partial<Record<Lang, string>>;
}

export interface RoomQuestion {
  at: number;
  srcLang: Lang;
  srcText: string;
  lang: Lang;
  text: string;
}

/** Réglages de l'écran, mémorisés sur le PC de projection. */
export interface Prefs {
  lang?: Lang;
  source: boolean;
  qr: boolean;
  /** Multiplicateur des tailles de texte, 0,7 à 1,6. */
  scale: number;
}
