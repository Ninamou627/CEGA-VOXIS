/**
 * Traduction par Claude, en registre d'interprète.
 *
 * Trois choix qui comptent :
 *   - le prompt système (règles + glossaire) est stable et mis en cache : seul le
 *     segment change d'un appel à l'autre ;
 *   - les segments précédents sont fournis comme tours user/assistant réels, ce qui
 *     donne la continuité (pronoms, terminologie) sans re-traduire quoi que ce soit ;
 *   - effort "low" : la latence du premier token est le critère, pas la profondeur.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Lang } from "../../../../shared/protocol";
import type { MtProvider, MtRequest } from "../types";

const LANG_NAME: Record<Lang, string> = { en: "English", fr: "French", es: "Spanish", ar: "Arabic", pt: "Portuguese" };

export function buildSystemPrompt(from: Lang, to: Lang, glossary?: Record<string, string>): string {
  const lines = [
    `You are a professional simultaneous interpreter working in a training room. The speaker talks in ${LANG_NAME[from]}; the audience listens in ${LANG_NAME[to]} through earphones.`,
    `You receive the speech one short segment at a time. Each user message is the next segment; each of your replies is ONLY its ${LANG_NAME[to]} rendering.`,
    ``,
    `Rules:`,
    `- Interpret, do not translate word for word. Keep the meaning, the tone and the register; drop fillers, hesitations and repetitions ("you know", "basically", "sort of", "uh").`,
    `- Keep it slightly more concise than the original when natural. Never add information.`,
    `- Use the previous segments for continuity of pronouns, gender and terminology. Never re-translate them.`,
    `- Keep numbers, product names, acronyms and code identifiers exactly as spoken.`,
    `- Produce well-punctuated ${LANG_NAME[to]} suitable for a text-to-speech voice.`,
    `- Never answer the speaker, never comment, never ask questions, never add quotes or brackets. If a segment is a fragment, render the fragment.`,
  ];
  if (glossary && Object.keys(glossary).length) {
    lines.push(``, `Glossary (always use these renderings):`);
    for (const [k, v] of Object.entries(glossary)) lines.push(`- ${k} → ${v}`);
  }
  return lines.join("\n");
}

export class AnthropicMt implements MtProvider {
  readonly name: string;
  private client: Anthropic;

  constructor(private opts: { apiKey?: string; model: string }) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.name = `anthropic:${opts.model}`;
  }

  async translate(req: MtRequest): Promise<string> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const c of req.context) {
      messages.push({ role: "user", content: c.src }, { role: "assistant", content: c.tgt });
    }
    messages.push({ role: "user", content: req.text });

    const res = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: 400,
      // Repli serveur en cas de refus de sécurité : la requête est rejouée sur le
      // modèle de repli par défaut, dans le même appel.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: buildSystemPrompt(req.from, req.to, req.glossary), cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { effort: "low" },
    });

    if (res.stop_reason === "refusal") throw new Error("traduction refusée par le modèle");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("traduction vide");
    return text;
  }
}
