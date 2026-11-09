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
