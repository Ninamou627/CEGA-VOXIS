/**
 * Traduction par Claude, en registre d'interprète.
 *
 * Trois choix qui comptent :
 *   - le prompt système (règles + contexte de séance + glossaire) est stable et mis en
 *     cache : seul le segment change d'un appel à l'autre ;
 *   - les segments précédents sont fournis comme tours user/assistant réels, ce qui
 *     donne la continuité (pronoms, terminologie) sans re-traduire quoi que ce soit ;
 *   - effort "low" par défaut : la latence du premier token est le critère.
 *
 * Modèle, effort, température et délai viennent de l'administration et sont relus à
 * chaque segment ; seuls les paramètres que le modèle accepte sont envoyés.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Lang } from "../../../../shared/protocol";
import { providerFetch, WarmLink } from "../http";
import type { MtProvider, MtRequest } from "../types";
import { modelCaps } from "./claude-models";

export interface AnthropicTuning {
  model: string;
  effort: "low" | "medium" | "high";
  temperature: number;
  timeoutMs: number;
}

const LANG_NAME: Record<Lang, string> = { en: "English", fr: "French", es: "Spanish", ar: "Arabic", pt: "Portuguese" };

export function buildSystemPrompt(from: Lang, to: Lang, glossary?: Record<string, string>, domain?: string): string {
  const lines = [
    `You are a professional simultaneous interpreter working in a training room. The speaker talks in ${LANG_NAME[from]}; the audience listens in ${LANG_NAME[to]} through earphones.`,
    `You receive the speech one short segment at a time. Each user message is the next segment; each of your replies is ONLY its ${LANG_NAME[to]} rendering.`,
    ``,
    `Rules:`,
    `- Interpret, do not translate word for word. Keep the meaning, the tone and the register; drop fillers, hesitations and repetitions ("you know", "basically", "sort of", "uh").`,
    `- Keep it slightly more concise than the original when natural. Never add information.`,
    `- Use the previous segments for continuity of pronouns, gender and terminology. Never re-translate them.`,
    `- Address the audience with the formal form of address when ${LANG_NAME[to]} has one (French: « vous », never « tu »), even when the speaker addresses one person.`,
    `- Keep numbers, product names, acronyms and code identifiers exactly as spoken.`,
    `- Produce well-punctuated ${LANG_NAME[to]} suitable for a text-to-speech voice.`,
    `- Never answer the speaker, never comment, never ask questions, never add quotes or brackets. If a segment is a fragment, render the fragment.`,
  ];
  if (domain) lines.push(``, `About this session (subject, audience, register):`, domain);
  if (glossary && Object.keys(glossary).length) {
    lines.push(``, `Glossary (always use these renderings):`);
    for (const [k, v] of Object.entries(glossary)) lines.push(`- ${k} → ${v}`);
  }
  return lines.join("\n");
}

export class AnthropicMt implements MtProvider {
  private client: Anthropic;
  private readonly link: WarmLink;

  constructor(private opts: { apiKey?: string; tuning: () => AnthropicTuning }) {
    // Connexions gardées (D20) : un premier appel à froid a dépassé le délai de 6 s en séance.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), fetch: providerFetch });
    // Lister un modèle est gratuit : de quoi garder la connexion sans rien générer.
    this.link = new WarmLink(() => this.client.models.list({ limit: 1 }, { timeout: 5000, maxRetries: 0 }));
  }

  get name(): string {
    return `anthropic:${this.opts.tuning().model}`;
  }

  warm(force?: boolean): Promise<void> {
    return this.link.warm(force);
  }

  async translate(req: MtRequest): Promise<string> {
    this.link.used();
    const t = this.opts.tuning();
    const caps = modelCaps(t.model);
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const c of req.context) {
      messages.push({ role: "user", content: c.src }, { role: "assistant", content: c.tgt });
    }
    messages.push({ role: "user", content: req.text });

    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: t.model,
      // La réflexion adaptative compte dans ce plafond (Opus 5.5 réfléchit toujours) :
      // 1024 évite de tronquer une traduction courte, sans rien coûter s'il n'est pas atteint.
      max_tokens: 1024,
      system: [{ type: "text", text: buildSystemPrompt(req.from, req.to, req.glossary, req.domain), cache_control: { type: "ephemeral" } }],
      messages,
    };
    // Chaque modèle ne reçoit que ce qu'il accepte : un paramètre refusé est un 400.
    if (caps.effort) params.output_config = { effort: t.effort };
    if (caps.temperature) params.temperature = t.temperature;
    if (caps.fallbacks) {
      // Repli serveur en cas de refus de sécurité : la requête est rejouée sur le
      // modèle de repli par défaut, dans le même appel.
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    // Pas de nouvelle tentative : au-delà du délai, c'est au secours de répondre.
    const res = await this.client.beta.messages.create(params, { timeout: t.timeoutMs, maxRetries: 0 });

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
