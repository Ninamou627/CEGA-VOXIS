import { describe, expect, it } from "vitest";
import type { SttPartial } from "../types";
import { MockStt } from "./mock";

describe("STT simulé", () => {
  it("n'entend un mot qu'une fois prononcé, horodaté depuis l'ouverture du flux", async () => {
    const partials: { at: number; p: SttPartial }[] = [];
    let audioMs = 0;
    const stt = new MockStt({ clock: "audio" });
    const s = await stt.start(
      { lang: "en", sampleRate: 16000 },
      { onPartial: (p) => partials.push({ at: audioMs, p }), onUtteranceEnd: () => {}, onDiscard: () => {}, onError: () => {} },
    );
    // 15 s d'audio : plusieurs phrases, donc des horodatages au-delà de la première.
    for (let i = 0; i < 150; i++) {
      audioMs += 100;
      s.sendAudio(new Uint8Array(3200));
    }
    expect(partials.length).toBeGreaterThan(20);
    for (const { at, p } of partials) {
      for (const w of p.words) expect(w.endMs!).toBeLessThanOrEqual(at);
    }
    expect(Math.max(...partials.flatMap(({ p }) => p.words.map((w) => w.endMs!)))).toBeGreaterThan(10_000);
    await s.close();
  });
});
