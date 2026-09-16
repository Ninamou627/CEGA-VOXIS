/**
 * Indice de langue immédiat sur un texte court, par mots-outils.
 *
 * Sert de garde-fou sur les PARTIELS du STT, dont la détection de langue officielle
 * n'arrive qu'en fin de tour — trop tard pour empêcher le commit verrouillé de figer
 * notre propre sortie captée par le micro. Volontairement conservateur : il ne dit
 * « autre langue » qu'avec au moins deux mots-outils de la langue suspecte et aucune
 * majorité de la langue attendue. En cas de doute, il laisse passer.
 */
import type { Lang } from "../../../../shared/protocol";

const STOP: Record<Exclude<Lang, "ar">, Set<string>> = {
  en: new Set(["the", "and", "to", "of", "is", "are", "we", "you", "that", "this", "for", "with", "it", "be", "have", "has", "not", "but", "so", "what", "how", "why", "today", "going", "i'm", "we're", "it's", "your", "our"]),
  fr: new Set(["le", "la", "les", "de", "des", "du", "et", "à", "nous", "vous", "est", "une", "pour", "que", "qui", "dans", "ce", "cette", "ces", "sur", "avec", "pas", "ne", "je", "il", "elle", "ils", "au", "aux", "en", "bonjour", "merci", "oui", "très", "sont", "être", "aujourd'hui", "c'est", "d'accord", "voilà"]),
  es: new Set(["el", "la", "los", "las", "de", "del", "y", "es", "una", "para", "que", "con", "por", "hoy", "vamos", "nosotros", "hola", "gracias", "muy", "está", "son", "también"]),
  pt: new Set(["o", "os", "as", "de", "do", "da", "e", "é", "uma", "para", "que", "com", "por", "hoje", "vamos", "nós", "olá", "obrigado", "muito", "está", "são", "também", "não"]),
};

const ARABIC = /[؀-ۿ]/;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’\s]/gu, " ")
    .replace(/’/g, "'")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * true si le texte ressemble à `suspect` plutôt qu'à `expected`.
 * Demande au moins 3 mots et 2 mots-outils de la langue suspecte.
 */
export function looksLike(text: string, suspect: Lang, expected: Lang): boolean {
  if (suspect === expected) return false;
  const toks = tokens(text);
  if (toks.length < 3) return false;
  if (suspect === "ar") return ARABIC.test(text);
  if (expected === "ar") return !ARABIC.test(text) && toks.filter((t) => STOP[suspect].has(t)).length >= 2;
  const s = toks.filter((t) => STOP[suspect].has(t)).length;
  const e = toks.filter((t) => STOP[expected].has(t)).length;
  return s >= 2 && s > e;
}
