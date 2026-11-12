/**
 * DeepL — traduction principale en séance (D20), Claude en secours.
 *
 * Mesuré le 14/10/2026 : ~0,25 s par segment, contre 0,85 s pour le Claude le plus rapide
 * (Haiku 4.5) et 1,4 s pour Opus 5 — la seule traduction qui tienne dans l'objectif d'une
 * seconde. Le réglage `model_type` (latence ou qualité) n'a rien changé de mesurable.
 *
 * Pas de registre d'interprète ni de condensation : c'est une traduction, pas une
 * interprétation — la dérive (§09) n'est donc combattue que par la vitesse de synthèse.
 * Les segments précédents sont fournis via `context`, qui influence la traduction sans
 * être traduit.
 *
 * Glossaire : DeepL ne lit pas un glossaire dans la requête, il faut le créer (~0,2 s) et
 * le citer par son identifiant. Chaque glossaire est créé une fois par contenu et par sens
 * de traduction ; celui qu'il remplace est supprimé. Seuls les glossaires créés par ce
 * processus le sont : un autre serveur sur la même clé (développement, production) garde
 * les siens. Une clé gratuite n'a droit qu'à UN glossaire (refus 456 au deuxième, vérifié) :
 * il va au sens du formateur (`mainFrom`), et les questions des apprenants s'en passent.
 *
 * Clé gratuite : se termine par « :fx » et utilise api-free.deepl.com.
 */
import type { Lang } from "../../../../shared/protocol";
import { providerFetch, WarmLink } from "../http";
import type { MtProvider, MtRequest } from "../types";

/** DeepL exige une variante régionale pour certaines cibles (EN, PT). */
const TARGET: Record<Lang, string> = { en: "EN-US", fr: "FR", es: "ES", ar: "AR", pt: "PT-PT" };
const SOURCE: Record<Lang, string> = { en: "EN", fr: "FR", es: "ES", ar: "AR", pt: "PT" };
/** Préfixe des glossaires de la salle dans le compte DeepL (lisible dans le compte). */
const GLOSSARY_PREFIX = "voxis";

/** Entrées d'un glossaire au format TSV de DeepL (ni tabulation ni retour à la ligne dans un terme). */
export function glossaryTsv(glossary: Record<string, string>): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
  return Object.entries(glossary)
    .map(([k, v]) => [clean(k), clean(v)])
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `${k}\t${v}`)
    .join("\n");
}

/** Empreinte courte d'un contenu, pour nommer son glossaire (FNV-1a 32 bits). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface DeepLOptions {
  apiKey: string;
  timeoutMs?: () => number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Langue du formateur : sur une clé gratuite (un seul glossaire), elle seule a son glossaire. */
  mainFrom?: Lang;
}

export class DeepLMt implements MtProvider {
  readonly name: string;
  private readonly free: boolean;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly link: WarmLink;
  /** « en>fr:<tsv> » → identifiant du glossaire (undefined si sa création a échoué). */
  private glossaries = new Map<string, Promise<string | undefined>>();
  /** Sens de traduction → glossaire en service créé par ce processus, et sa clé. */
  private current = new Map<string, { id: string; key: string }>();

  constructor(private opts: DeepLOptions) {
    if (!opts.apiKey) throw new Error("DEEPL_API_KEY manquant");
    this.free = opts.apiKey.trim().endsWith(":fx");
    this.base = this.free ? "https://api-free.deepl.com" : "https://api.deepl.com";
    this.name = this.free ? "deepl:free" : "deepl:pro";
    this.headers = { Authorization: `DeepL-Auth-Key ${opts.apiKey}`, "Content-Type": "application/json" };
    this.link = new WarmLink(() => this.fetch(`${this.base}/v2/usage`, { headers: this.headers, signal: AbortSignal.timeout(5000) }));
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? providerFetch;
  }

  warm(force?: boolean): Promise<void> {
    return this.link.warm(force);
  }

  async translate(req: MtRequest): Promise<string> {
    const body: Record<string, unknown> = {
      text: [req.text],
      source_lang: SOURCE[req.from],
      target_lang: TARGET[req.to],
      preserve_formatting: true,
      // Vouvoiement : sans ce réglage, DeepL a tutoyé la salle sur 8 segments du test du 8/11
      // (« si tu tiens à moi ») ; rejoués avec leur contexte, les 8 passent au « vous ».
      // « prefer_ » : une cible sans formalité (anglais…) est traduite quand même (vérifié, 200).
      formality: "prefer_more",
    };
    // Le contexte de séance et les segments précédents (source) donnent le fil, sans être traduits.
    // Suite d'une phrase commencée (D43) : DeepL ne sait pas la continuer ; il traduit le groupe
    // avec, en contexte, le début de la phrase en source et tel que la salle l'a entendu.
    const context = [req.domain, ...req.context.map((c) => c.src), req.prefix?.src, req.prefix?.tgt].filter(Boolean).join(" ");
    if (context) body.context = context;
    const glossaryId = req.glossary && this.glossaryAllowed(req.from) ? await this.glossaryId(req.from, req.to, req.glossary) : undefined;
    if (glossaryId) body.glossary_id = glossaryId;

    this.link.used();
    let res = await this.post(body);
    if (!res.ok && glossaryId && (res.status === 400 || res.status === 404)) {
      // Glossaire disparu entre-temps (remplacé, supprimé ailleurs) : la phrase passe sans lui,
      // plutôt que de basculer la salle sur le secours pour une minute.
      this.forget(glossaryId);
      delete body.glossary_id;
      res = await this.post(body);
    }
    if (!res.ok) throw new Error(`DeepL ${res.status} : ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { translations?: { text: string }[] };
    const text = j.translations?.[0]?.text?.trim();
    if (!text) throw new Error("DeepL : traduction vide");
    return text;
  }

  private post(body: Record<string, unknown>): Promise<Response> {
    return this.fetch(`${this.base}/v2/translate`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs?.() ?? 8_000),
    });
  }

  /** Une clé gratuite n'a qu'un glossaire : il va au sens du formateur. */
  private glossaryAllowed(from: Lang): boolean {
    return !this.free || this.opts.mainFrom == null || from === this.opts.mainFrom;
  }

  /** Oublie un glossaire qui n'existe plus chez DeepL. */
  private forget(id: string): void {
    for (const [pair, g] of this.current) if (g.id === id) this.current.delete(pair);
    void (async () => {
      for (const [key, p] of this.glossaries) if ((await p) === id) this.glossaries.delete(key);
    })();
  }

  /** Le glossaire de ce sens de traduction, créé à la première demande. Sans glossaire si DeepL le refuse. */
  private glossaryId(from: Lang, to: Lang, glossary: Record<string, string>): Promise<string | undefined> {
    const tsv = glossaryTsv(glossary);
    if (!tsv) return Promise.resolve(undefined);
    const key = `${from}>${to}:${tsv}`;
    let id = this.glossaries.get(key);
    if (!id) {
      id = this.createGlossary(from, to, tsv, key);
      this.glossaries.set(key, id);
    }
    return id;
  }

  private async createGlossary(from: Lang, to: Lang, tsv: string, key: string): Promise<string | undefined> {
    const create = () =>
      this.fetch(`${this.base}/v2/glossaries`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ name: `${GLOSSARY_PREFIX}-${from}-${to}-${hash(tsv)}`, source_lang: from, target_lang: to, entries: tsv, entries_format: "tsv" }),
        signal: AbortSignal.timeout(5000),
      });
    try {
      let res = await create();
      if (res.status === 456 && this.current.size) {
        // Quota de glossaires atteint (un seul sur une clé gratuite) : on libère les nôtres, puis on réessaie.
        for (const g of [...this.current.values()]) await this.dropGlossary(g);
        this.current.clear();
        res = await create();
      }
      if (!res.ok) throw new Error(`${res.status} : ${(await res.text()).slice(0, 200)}`);
      const { glossary_id } = (await res.json()) as { glossary_id: string };
      const pair = `${from}>${to}`;
      const replaced = this.current.get(pair);
      this.current.set(pair, { id: glossary_id, key });
      if (replaced) void this.dropGlossary(replaced);
      return glossary_id;
    } catch (err) {
      this.opts.log?.(`DeepL : glossaire ${from}→${to} non créé, traduction sans glossaire — ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Le glossaire remplacé ne sert plus : le compte n'en accumule pas. */
  private async dropGlossary(g: { id: string; key: string }): Promise<void> {
    this.glossaries.delete(g.key);
    try {
      await this.fetch(`${this.base}/v2/glossaries/${g.id}`, { method: "DELETE", headers: this.headers, signal: AbortSignal.timeout(5000) });
    } catch {
      /* ménage seulement : un ancien glossaire qui reste ne gêne pas la séance */
    }
  }
}
