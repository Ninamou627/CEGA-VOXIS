/**
 * Rattrapage du texte après une coupure de l'apprenant (D40, F-08). Partagé pour être testé
 * hors serveur.
 *
 * Un téléphone qui perd le réseau 20 s manquait jusqu'ici tout le texte de ces 20 s : les
 * lignes figées (`src.commit`, `tr.segment`) ne partent qu'une fois, et la page revenait sur
 * un trou. Désormais, il dit au retour où il en était (`resume`) et le serveur renvoie les
 * lignes manquées — le texte seulement : la voix, elle, reprend au direct (D35), une voix
 * vieille de 20 s ne servirait à rien.
 *
 * Bornes : cinq minutes (au-delà, le cours est passé à autre chose) et ce que le serveur garde
 * en mémoire (60 segments). La page n'en affiche de toute façon que les dernières lignes.
 */
import type { CatchupLine, Lang } from "./protocol";

/** On ne rattrape pas plus loin : au-delà, la page repart simplement du direct. */
export const CATCHUP_WINDOW_MS = 5 * 60_000;

/** Ce que le serveur garde d'un segment diffusé. */
export interface RecentLine {
  seq: number;
  srcText: string;
  tOrigin: number;
  tgt: Partial<Record<Lang, string>>;
  /** Traduction ratée : le texte source a été renvoyé à la place. */
  untranslated?: Partial<Record<Lang, boolean>>;
}

export interface CatchupQuery {
  lang: Lang;
  /** Dernier segment que la page a reçu en entier ; `null` : elle ne sait rien de ce serveur. */
  since: number | null;
  now: number;
  windowMs?: number;
}

/** Les lignes que la page a manquées, dans l'ordre de la parole. */
export function catchupLines(recent: Iterable<RecentLine>, q: CatchupQuery): CatchupLine[] {
  const from = q.now - (q.windowMs ?? CATCHUP_WINDOW_MS);
  const out: CatchupLine[] = [];
  for (const r of recent) {
    if (q.since != null && r.seq <= q.since) continue;
    if (r.tOrigin < from) continue;
    // Une ligne sans texte source n'a jamais été montrée : rien à rattraper.
    if (!r.srcText) continue;
    const line: CatchupLine = { seq: r.seq, src: r.srcText, tOrigin: r.tOrigin };
    const tgt = r.tgt[q.lang];
    if (tgt != null) line.tgt = tgt;
    if (r.untranslated?.[q.lang]) line.untranslated = true;
    out.push(line);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
