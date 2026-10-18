import { describe, expect, it } from "vitest";
import { streamParams } from "./assemblyai";

const base = { sampleRate: 16000, lang: "en" as const, gate: true, mode: "balanced" as const, keyterms: [] as string[] };

describe("AssemblyAI — paramètres d'ouverture du flux", () => {
  it("universal-streaming-english : ni mode, ni prompt, ni langue (refusés ou sans objet)", () => {
    const p = streamParams({ ...base, model: "universal-streaming-english", prompt: "Technical training.", keyterms: ["SCADA"] });
    expect(p.get("speech_model")).toBe("universal-streaming-english");
    expect(p.has("mode")).toBe(false);
    expect(p.has("prompt")).toBe(false);
    expect(p.has("language_detection")).toBe(false);
    expect(p.has("language_code")).toBe(false);
    expect(p.has("format_turns")).toBe(false);
    expect(p.get("keyterms_prompt")).toBe('["SCADA"]');
  });

  it("fin de phrase « Rapide » : clore le tour après 160 ms de silence ; « Équilibrée » : réglage d'AssemblyAI", () => {
    expect(streamParams({ ...base, model: "universal-streaming-english", mode: "min_latency" }).get("min_end_of_turn_silence_when_confident")).toBe("160");
    expect(streamParams({ ...base, model: "universal-streaming-english", mode: "balanced" }).has("min_end_of_turn_silence_when_confident")).toBe(false);
  });

  it("universal-streaming-multilingual : garde la détection de langue (garde-fou anti-écho)", () => {
    expect(streamParams({ ...base, model: "universal-streaming-multilingual" }).get("language_detection")).toBe("true");
    expect(streamParams({ ...base, model: "universal-streaming-multilingual", gate: false }).get("language_code")).toBe("en");
  });

  it("U3.5 Pro : mode, prompt et focalisation de la voix, sans réglage de fin de tour", () => {
    const p = streamParams({ ...base, model: "universal-3-5-pro", prompt: "Technical training.", voiceFocus: "near-field" });
    expect(p.get("mode")).toBe("balanced");
    expect(p.get("prompt")).toBe("Technical training.");
    expect(p.get("voice_focus")).toBe("near-field");
    expect(p.get("language_detection")).toBe("true");
    expect(p.has("min_end_of_turn_silence_when_confident")).toBe(false);
  });
});

