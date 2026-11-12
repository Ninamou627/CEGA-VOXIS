/**
 * Formulation resserrée (D42) : quand la salle a 5 s de retard ou plus, et seulement si
 * l'administration l'a permis, Claude redit le segment plus court — hésitations et redites
 * retirées. Rien de ce qui porte l'information ne doit tomber : ni un fait, ni un nombre, ni un
 * nom, ni une négation.
 *
 * La version resserrée n'est dite que si elle garde tout ce que la traduction normale contient
 * de vérifiable — comparées dans la même langue, ce qui est plus sûr qu'une comparaison avec la
 * source : chaque nombre (en chiffres ou en toutes lettres), chaque nom propre ou sigle, et
 * chaque négation, qui doit encore porter sur le même mot. Sinon, la traduction normale part.
 *
 * On compare des présences, pas des occurrences : une redite (« nous ne voulons pas, euh, nous
 * ne voulons pas ») est justement ce que le resserrage retire. Un fait sans nombre, sans nom et
 * sans négation ne se vérifie pas ainsi : c'est la limite de ce garde-fou, et l'objet de la consigne.
 */
import type { Lang } from "../../../shared/protocol";

/** Plus courte d'au moins 3 % : sinon, le gain ne vaut pas le risque. */
const MIN_SAVING = 0.03;
/** Moins de 40 % de la traduction normale : quelque chose a sauté. */
const MIN_KEPT = 0.4;

/** Nombres en toutes lettres (« un », « one » écartés : ce sont aussi des articles). */
const NUMBER_WORDS: Partial<Record<Lang, string[]>> = {
  fr: "deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize vingt trente quarante cinquante soixante cent cents mille million millions milliard milliards premier première deuxième troisième moitié quart tiers".split(" "),
  en: "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred hundreds thousand thousands million millions billion billions first second third half quarter".split(" "),
  es: "dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince veinte treinta cuarenta cincuenta sesenta cien ciento cientos mil millón millones primero primera segundo segunda tercero tercera mitad cuarto".split(" "),
  pt: "dois duas três quatro cinco seis sete oito nove dez onze doze treze catorze quinze vinte trinta quarenta cinquenta sessenta cem cento mil milhão milhões primeiro primeira segundo segunda terceiro terceira metade quarto".split(" "),
};

/** Mots qui portent une négation, par langue (formes élidées et préfixées comprises). */
const NEGATIONS: Record<Lang, string[]> = {
  fr: ["ne", "n'", "n’", "pas", "jamais", "aucun", "aucune", "rien", "ni", "sans", "non", "nul", "nulle", "guère"],
  en: ["not", "no", "never", "none", "nothing", "nobody", "neither", "nor", "without", "cannot", "n't", "n’t"],
  es: ["no", "nunca", "jamás", "ningún", "ninguno", "ninguna", "nada", "nadie", "ni", "sin", "tampoco"],
  pt: ["não", "nunca", "jamais", "nenhum", "nenhuma", "nada", "ninguém", "nem", "sem"],
  ar: ["لا", "لم", "لن", "ليس", "ليست", "غير", "بدون", "دون", "ولا", "ولم", "ولن", "فلا", "فلم", "فلن"],
};

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*['’]?|['’][\p{L}]+/gu) ?? [];

/** Nombres écrits en chiffres, séparateurs retirés (« 1 000 », « 1,000 » et « 1000 » se valent). */
function digits(s: string): string[] {
  return (s.match(/\d+(?:[.,   ]\d+)*/g) ?? []).map((n) => n.replace(/[.,   ]/g, ""));
}

function numberWords(s: string, lang: Lang): string[] {
  const list = new Set(NUMBER_WORDS[lang] ?? []);
  return words(s).filter((w) => list.has(w));
}

function isNegation(w: string, lang: Lang, list: Set<string>): boolean {
  return list.has(w) || (lang === "fr" && /^n['’]/.test(w)) || (lang === "en" && /n['’]t$/.test(w));
}

/**
 * Négations : mots de la liste et formes élidées (« n'est », « don't »). Chacune est repérée par
 * le mot sur lequel elle porte — le mot suivant dans la même proposition, autres négations
 * sautées (« ne voulons pas recommencer » → voulons, recommencer). Une négation suivie d'une
 * ponctuation (« it doesn't, it doesn't work ») ne porte sur rien de lisible : comptée seule.
 */
function negations(s: string, lang: Lang): { n: number; on: Set<string> } {
  const list = new Set(NEGATIONS[lang]);
  const on = new Set<string>();
  let n = 0;
  for (const clause of s.split(/[,;:.!?…—–()«»"“”]+/)) {
    const ws = words(clause);
    ws.forEach((w, i) => {
      if (!isNegation(w, lang, list)) return;
      n++;
      const next = ws.slice(i + 1).find((x) => !isNegation(x, lang, list));
      if (next) on.add(next);
    });
  }
  return { n, on };
}

/**
 * Noms propres et sigles : mots qui commencent par une majuscule hors début de phrase, et mots
 * tout en capitales. Un nom en début de phrase ne se distingue pas d'un mot ordinaire ; l'arabe
 * n'a pas de majuscules : pas de contrôle des noms pour lui.
 */
function names(s: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const w = m[0];
    const before = s.slice(0, m.index).trimEnd();
    const initial = before === "" || /[.!?…:«"“]$/.test(before);
    if (/^\p{Lu}{2,}/u.test(w) || (/^\p{Lu}/u.test(w) && !initial)) out.push(w);
  }
  return out;
}

/** Le premier élément de `need` absent de `have`, ou null. */
function covered(need: Iterable<string>, have: Iterable<string>): string | null {
  const h = new Set(have);
  for (const n of need) if (!h.has(n)) return n;
  return null;
}

export interface TightenCheck {
  ok: boolean;
  /** Motif du refus, pour le journal. */
  reason?: string;
  /** Ce qui a été vérifié dans la traduction normale : nombres et noms distincts, négations. */
  numbers: number;
  names: number;
  negations: number;
}

/** La version resserrée garde-t-elle tout ce que la traduction normale contient de vérifiable ? */
export function checkTightened(normal: string, tight: string, lang: Lang): TightenCheck {
  const nNum = new Set([...digits(normal), ...numberWords(normal, lang)]);
  const nNames = new Set(lang === "ar" ? [] : names(normal));
  const nNeg = negations(normal, lang);
  const base = { numbers: nNum.size, names: nNames.size, negations: nNeg.n };
  const t = tight.trim();
  if (!t) return { ok: false, reason: "vide", ...base };
  if (t.length > normal.length * (1 - MIN_SAVING)) return { ok: false, reason: "pas plus court", ...base };
  if (t.length < normal.length * MIN_KEPT) return { ok: false, reason: "trop court", ...base };
  const lostNum = covered(nNum, [...digits(t), ...numberWords(t, lang)]);
  if (lostNum) return { ok: false, reason: `nombre perdu : ${lostNum}`, ...base };
  // Le nom peut passer en début de phrase dans la version resserrée : on le cherche parmi tous ses mots.
  const lostName = covered(nNames, t.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu) ?? []);
  if (lostName) return { ok: false, reason: `nom perdu : ${lostName}`, ...base };
  const tNeg = negations(t, lang);
  if ((nNeg.n > 0 && tNeg.n === 0) || covered(nNeg.on, tNeg.on)) return { ok: false, reason: "négation perdue", ...base };
  return { ok: true, ...base };
}
