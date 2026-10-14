import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { defaultsFrom } from "../settings";
import { SwitchableMt } from "./index";
import type { MtProvider, MtRequest } from "./types";

describe("SwitchableMt — glossaire", () => {
  const seen: MtRequest[] = [];
  const engine: MtProvider = { name: "capture", translate: async (r) => (seen.push(r), "ok") };
  const settings = defaultsFrom(loadConfig({}));
  settings.translation.primary = "mock";
  settings.translation.secondary = "none";
  settings.translation.glossary = "pipeline = chaîne de traitement";
  const hooks = { onFallback: () => {}, onRecover: () => {} };
  const mt = new SwitchableMt({ mock: engine }, hooks, () => settings, "en");

  it("dans le sens du formateur, le glossaire part tel qu'écrit", async () => {
    await mt.translate({ text: "the pipeline", from: "en", to: "fr", context: [] });
    expect(seen.at(-1)!.glossary).toEqual({ pipeline: "chaîne de traitement" });
  });

  it("pour une question d'apprenant, il est retourné", async () => {
    await mt.translate({ text: "la chaîne de traitement", from: "fr", to: "en", context: [] });
    expect(seen.at(-1)!.glossary).toEqual({ "chaîne de traitement": "pipeline" });
  });
});
