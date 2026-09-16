/**
 * Traduction simulée : un petit lexique EN→FR pour que l'écran ressemble à quelque
 * chose, et un marqueur de langue pour ne jamais confondre avec une vraie traduction.
 */
import type { MtProvider, MtRequest } from "../types";

const LEXICON: Record<string, string> = {
  today: "aujourd'hui", we: "nous", the: "le", and: "et", is: "est", a: "un", to: "à",
  pipeline: "pipeline", latency: "latence", word: "mot", words: "mots", queue: "file",
  french: "le français", english: "l'anglais", problem: "problème", simple: "simple",
  demo: "démo", questions: "questions", any: "des", so: "donc", far: "loin", okay: "d'accord",
  now: "maintenant", second: "deuxième", drift: "dérive", voice: "voix", little: "peu",
};

export class MockMt implements MtProvider {
  readonly name = "mock-mt";

  async translate(req: MtRequest): Promise<string> {
    await new Promise((r) => setTimeout(r, 120)); // latence plausible d'un petit modèle
    if (req.to === "fr" && req.from === "en") {
      const out = req.text
        .split(" ")
        .map((w) => {
          const m = w.match(/^([^\p{L}']*)([\p{L}']+)([^\p{L}']*)$/u);
          if (!m) return w;
          const tr = LEXICON[m[2].toLowerCase()];
          return tr ? m[1] + tr + m[3] : w;
        })
        .join(" ");
      return `[fr] ${out}`;
    }
    return `[${req.to}] ${req.text}`;
  }
}
