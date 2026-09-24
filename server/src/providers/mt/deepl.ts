/**
 * DeepL — traduction de secours (ou primaire pour les tests).
 *
 * Rapide, prévisible, excellent français. Pas de registre d'interprète ni de
 * condensation : c'est une traduction, pas une interprétation — la dérive (§09)
 * n'est donc combattue que par la vitesse de synthèse. Les segments précédents sont
 * fournis via `context`, qui influence la traduction sans être traduit.
 *
 * Clé gratuite : se termine par « :fx » et utilise api-free.deepl.com.
 */
import type { Lang } from "../../../../shared/protocol";
import type { MtProvider, MtRequest } from "../types";

/** DeepL exige une variante régionale pour certaines cibles (EN, PT). */
const TARGET: Record<Lang, string> = { en: "EN-US", fr: "FR", es: "ES", ar: "AR", pt: "PT-PT" };
const SOURCE: Record<Lang, string> = { en: "EN", fr: "FR", es: "ES", ar: "AR", pt: "PT" };

export class DeepLMt implements MtProvider {
  readonly name: string;
  private readonly base: string;

  constructor(private opts: { apiKey: string; timeoutMs?: () => number }) {
    if (!opts.apiKey) throw new Error("DEEPL_API_KEY manquant");
    const free = opts.apiKey.trim().endsWith(":fx");
    this.base = free ? "https://api-free.deepl.com" : "https://api.deepl.com";
    this.name = free ? "deepl:free" : "deepl:pro";
  }

  async translate(req: MtRequest): Promise<string> {
    const body: Record<string, unknown> = {
      text: [req.text],
      source_lang: SOURCE[req.from],
      target_lang: TARGET[req.to],
      preserve_formatting: true,
    };
    // Le contexte de séance et les segments précédents (source) donnent le fil, sans être traduits.
    const context = [req.domain, ...req.context.map((c) => c.src)].filter(Boolean).join(" ");
    if (context) body.context = context;

    const res = await fetch(`${this.base}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs?.() ?? 8_000),
    });
    if (!res.ok) throw new Error(`DeepL ${res.status} : ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { translations?: { text: string }[] };
    const text = j.translations?.[0]?.text?.trim();
    if (!text) throw new Error("DeepL : traduction vide");
    return text;
  }
}
