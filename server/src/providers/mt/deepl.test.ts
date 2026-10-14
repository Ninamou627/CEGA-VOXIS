import { describe, expect, it } from "vitest";
import { DeepLMt, glossaryTsv } from "./deepl";

/** Faux DeepL : enregistre les appels, crée des glossaires numérotés, dans la limite du compte. */
function fakeDeepL(opts: { glossaryStatus?: number; maxGlossaries?: number; mainFrom?: "en" | "fr"; missingGlossary?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const existing = new Set<string>();
  let n = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path === "/v2/translate") {
      if (body.glossary_id && (opts.missingGlossary || !existing.has(body.glossary_id))) return json(404, { message: "Glossary not found" });
      return json(200, { translations: [{ text: `fr:${body.text[0]}` }] });
    }
    if (path === "/v2/glossaries" && method === "POST") {
      if (opts.glossaryStatus) return json(opts.glossaryStatus, { message: "refusé" });
      if (existing.size >= (opts.maxGlossaries ?? 99)) return json(456, { message: "Too many glossaries" });
      const id = `g${++n}`;
      existing.add(id);
      return json(201, { glossary_id: id });
    }
    if (path.startsWith("/v2/glossaries/") && method === "DELETE") {
      existing.delete(path.split("/").pop()!);
      return new Response(null, { status: 204 });
    }
    if (path === "/v2/usage") return json(200, { character_count: 0 });
    return json(404, {});
  }) as unknown as typeof globalThis.fetch;
  const logs: string[] = [];
  const mt = new DeepLMt({ apiKey: "cle:fx", fetch: fakeFetch, log: (m) => logs.push(m), mainFrom: opts.mainFrom });
  return { mt, calls, logs, existing, translations: () => calls.filter((c) => c.path === "/v2/translate") };
}

const req = (text: string, glossary?: Record<string, string>) => ({ text, from: "en" as const, to: "fr" as const, context: [{ src: "Previous.", tgt: "Précédent." }], glossary });

describe("DeepL", () => {
  it("traduit avec le contexte source, sans glossaire s'il n'y en a pas", async () => {
    const d = fakeDeepL();
    expect(await d.mt.translate(req("Hello"))).toBe("fr:Hello");
    const body = d.translations()[0].body;
    expect(body).toMatchObject({ text: ["Hello"], source_lang: "EN", target_lang: "FR", context: "Previous." });
    expect(body.glossary_id).toBeUndefined();
  });

  it("crée le glossaire une seule fois, puis le cite à chaque segment", async () => {
    const d = fakeDeepL();
    const g = { pipeline: "chaîne de traitement" };
    await d.mt.translate(req("The pipeline", g));
    await d.mt.translate(req("The pipeline again", g));
    const created = d.calls.filter((c) => c.path === "/v2/glossaries" && c.method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ source_lang: "en", target_lang: "fr", entries: "pipeline\tchaîne de traitement", entries_format: "tsv" });
    expect(d.translations().map((c) => c.body.glossary_id)).toEqual(["g1", "g1"]);
  });

  it("un glossaire modifié en remplace un autre, qui est supprimé", async () => {
    const d = fakeDeepL();
    await d.mt.translate(req("A", { pipeline: "chaîne" }));
    await d.mt.translate(req("B", { pipeline: "chaîne", dashboard: "tableau de bord" }));
    await new Promise((r) => setTimeout(r, 0)); // la suppression part en arrière-plan
    expect(d.translations().map((c) => c.body.glossary_id)).toEqual(["g1", "g2"]);
    expect(d.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v2/glossaries/g1"]);
  });

  it("si DeepL refuse le glossaire, traduit quand même, sans glossaire, et le dit", async () => {
    const d = fakeDeepL({ glossaryStatus: 400 });
    expect(await d.mt.translate(req("The pipeline", { pipeline: "chaîne" }))).toBe("fr:The pipeline");
    expect(d.translations()[0].body.glossary_id).toBeUndefined();
    expect(d.logs[0]).toMatch(/glossaire en→fr non créé/);
  });

  it("ne réchauffe pas une liaison qui vient de servir", async () => {
    const d = fakeDeepL();
    await d.mt.translate(req("Hello"));
    await d.mt.warm();
    expect(d.calls.filter((c) => c.path === "/v2/usage")).toHaveLength(0);
    await d.mt.warm(true);
    expect(d.calls.filter((c) => c.path === "/v2/usage")).toHaveLength(1);
  });

  it("clé gratuite, un seul glossaire : le remplacer libère l'ancien avant de créer le nouveau", async () => {
    const d = fakeDeepL({ maxGlossaries: 1 });
    await d.mt.translate(req("A", { pipeline: "chaîne" }));
    await d.mt.translate(req("B", { pipeline: "chaîne", dashboard: "tableau de bord" }));
    expect(d.translations().map((c) => c.body.glossary_id)).toEqual(["g1", "g2"]);
    expect([...d.existing]).toEqual(["g2"]);
    expect(d.logs).toEqual([]);
  });

  it("clé gratuite : seul le sens du formateur a un glossaire, les questions s'en passent", async () => {
    const d = fakeDeepL({ maxGlossaries: 1, mainFrom: "en" });
    await d.mt.translate(req("The pipeline", { pipeline: "chaîne" }));
    await d.mt.translate({ text: "La chaîne ?", from: "fr", to: "en", context: [], glossary: { chaîne: "pipeline" } });
    expect(d.translations().map((c) => c.body.glossary_id)).toEqual(["g1", undefined]);
    expect(d.calls.filter((c) => c.path === "/v2/glossaries" && c.method === "POST")).toHaveLength(1);
  });

  it("un glossaire disparu entre-temps : la phrase repart sans lui, sans erreur", async () => {
    const d = fakeDeepL({ missingGlossary: true });
    expect(await d.mt.translate(req("The pipeline", { pipeline: "chaîne" }))).toBe("fr:The pipeline");
    expect(d.translations().map((c) => c.body.glossary_id)).toEqual(["g1", undefined]);
  });

  it("le TSV n'a ni tabulation ni retour à la ligne dans un terme", () => {
    expect(glossaryTsv({ "a\tb": "c\nd", vide: " " })).toBe("a b\tc d");
  });
});
