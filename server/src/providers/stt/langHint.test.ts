import { describe, expect, it } from "vitest";
import { looksLike } from "./langHint";

describe("looksLike", () => {
  it("reconnaît du français dans un flux attendu en anglais", () => {
    expect(looksLike("Bonjour à tous, aujourd'hui nous allons", "fr", "en")).toBe(true);
    expect(looksLike("nous allons parler de la latence et de la dérive", "fr", "en")).toBe(true);
  });

  it("laisse passer l'anglais, même technique et sans mots-outils", () => {
    expect(looksLike("Today we're going to discuss how the pipeline", "fr", "en")).toBe(false);
    expect(looksLike("pipeline handles partial transcripts", "fr", "en")).toBe(false);
    expect(looksLike("le pipeline is the key", "fr", "en")).toBe(false); // un seul indice français, majorité anglaise
  });

  it("reste prudent sur les textes très courts", () => {
    expect(looksLike("Bonjour à", "fr", "en")).toBe(false);
    expect(looksLike("et", "fr", "en")).toBe(false);
  });

  it("gère l'arabe par l'écriture", () => {
    expect(looksLike("مرحبا بكم جميعا اليوم", "ar", "en")).toBe(true);
    expect(looksLike("Today we start", "ar", "en")).toBe(false);
  });
});
