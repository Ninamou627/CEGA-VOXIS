import { describe, expect, it } from "vitest";
import { azureSsml } from "./azure";

describe("voix Azure : SSML (D34)", () => {
  it("fixe un silence court en tête et en fin de voix, dans l'élément voice", () => {
    const ssml = azureSsml("fr-FR-DeniseNeural", "Bonjour à tous.", 1.05);
    expect(ssml).toContain('xmlns:mstts="http://www.w3.org/2001/mstts"');
    expect(ssml).toMatch(/<voice name="fr-FR-DeniseNeural"><mstts:silence type="Leading-exact" value="50ms"\/><mstts:silence type="Tailing-exact" value="150ms"\/><prosody/);
    expect(ssml).toContain('xml:lang="fr-FR"');
    expect(ssml).toContain('<prosody rate="+5%">Bonjour à tous.</prosody>');
  });

  it("échappe le texte et garde une vitesse négative", () => {
    const ssml = azureSsml("fr-FR-DeniseNeural", "R&D <test> « l'été »", 0.9);
    expect(ssml).toContain("R&amp;D &lt;test&gt; « l&apos;été »");
    expect(ssml).toContain('<prosody rate="-10%">');
  });
});

describe("voix Azure : voix continue (D43, audit 2.4)", () => {
  it("pas de silence de bord du côté où la phrase continue", () => {
    const both = azureSsml("fr-FR-DeniseNeural", "puis nous en parlerons,", 1, { previous: true, next: true });
    expect(both).toContain('<mstts:silence type="Leading-exact" value="0ms"/><mstts:silence type="Tailing-exact" value="0ms"/>');
    const first = azureSsml("fr-FR-DeniseNeural", "Aujourd'hui,", 1, { next: true });
    expect(first).toContain('<mstts:silence type="Leading-exact" value="50ms"/><mstts:silence type="Tailing-exact" value="0ms"/>');
    const last = azureSsml("fr-FR-DeniseNeural", "parlerons.", 1, { previous: true });
    expect(last).toContain('<mstts:silence type="Leading-exact" value="0ms"/><mstts:silence type="Tailing-exact" value="150ms"/>');
  });
});
