import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./anthropic";

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
