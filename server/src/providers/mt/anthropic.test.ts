import { describe, expect, it } from "vitest";
import { AnthropicMt, buildSystemPrompt } from "./anthropic";

describe("Claude — prompt d'interprète", () => {
  it("demande le vouvoiement, comme DeepL (formality)", () => {
    const p = buildSystemPrompt("en", "fr");
    expect(p).toMatch(/formal form of address/);
    expect(p).toMatch(/« vous », never « tu »/);
  });

  it("garde le contexte de séance et le glossaire", () => {
    const p = buildSystemPrompt("en", "fr", { pipeline: "chaîne de traitement" }, "Formation Kubernetes");
    expect(p).toContain("Formation Kubernetes");
    expect(p).toContain("- pipeline → chaîne de traitement");
  });
});

describe("Claude — suite d'une phrase commencée (D43)", () => {
  /** Claude remplacé par un faux client qui garde la requête et rend `reply`. */
  function fakeClaude(reply: string) {
    const sent: { messages: { role: string; content: string }[]; system: { text: string }[] }[] = [];
    const mt = new AnthropicMt({ apiKey: "cle", tuning: () => ({ model: "claude-haiku-4-5", effort: "low", temperature: 0, timeoutMs: 1000 }) });
    (mt as unknown as { client: unknown }).client = {
      beta: { messages: { create: async (params: (typeof sent)[number]) => (sent.push(params), { stop_reason: "end_turn", content: [{ type: "text", text: reply }] }) } },
      models: { list: async () => ({}) },
    };
    return { mt, sent };
  }

  it("donne le début de phrase tel que dit, puis la suite marquée « … », sans réponse pré-remplie", async () => {
    const c = fakeClaude("puis nous en parlerons.");
    const text = await c.mt.translate({
      text: "and then we discuss them.",
      from: "en",
      to: "fr",
      context: [{ src: "Good morning.", tgt: "Bonjour." }],
      prefix: { src: "So today we will look at the results,", tgt: "Aujourd'hui, nous verrons les résultats," },
    });
    expect(text).toBe("puis nous en parlerons.");
    expect(c.sent[0].messages).toEqual([
      { role: "user", content: "Good morning." },
      { role: "assistant", content: "Bonjour." },
      { role: "user", content: "So today we will look at the results," },
      { role: "assistant", content: "Aujourd'hui, nous verrons les résultats," },
      { role: "user", content: "… and then we discuss them." },
    ]);
    expect(c.sent[0].system[0].text).toMatch(/starts with « … » continues the sentence/);
  });

  it("sans début de phrase, le segment part seul, sans marque", async () => {
    const c = fakeClaude("Bonjour.");
    await c.mt.translate({ text: "Good morning.", from: "en", to: "fr", context: [] });
    expect(c.sent[0].messages).toEqual([{ role: "user", content: "Good morning." }]);
  });
});
