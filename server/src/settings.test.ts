import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { defaultsFrom, SettingsSchema, SettingsStore } from "./settings";

const defaults = defaultsFrom(loadConfig({}));
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("réglages : une voix par défaut pour certaines langues seulement", () => {
  it("n'exige pas une voix pour chaque langue connue", () => {
    const one = { ...defaults, voice: { ...defaults.voice, defaults: { fr: "voix-fr" } } };
    expect(SettingsSchema.parse(one).voice.defaults).toEqual({ fr: "voix-fr" });
    expect(SettingsSchema.parse({ ...defaults, voice: { ...defaults.voice, defaults: {} } }).voice.defaults).toEqual({});
  });

  it("refuse une langue que le produit ne connaît pas", () => {
    const unknown = { ...defaults, voice: { ...defaults.voice, defaults: { de: "voix-de" } } };
    expect(SettingsSchema.safeParse(unknown).success).toBe(false);
  });

  // Un fichier refusé au chargement est remplacé sans bruit par les valeurs du .env :
  // l'administrateur perdrait ses réglages sans erreur visible.
  it("garde les réglages enregistrés quand une seule langue a sa voix", () => {
    dir = mkdtempSync(path.join(tmpdir(), "voxis-settings-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ voice: { defaults: { fr: "voix-fr" }, speed: 1.1 } }));
    const voice = new SettingsStore(file, defaults).get().voice;
    expect(voice.defaults).toEqual({ fr: "voix-fr" });
    expect(voice.speed).toBe(1.1);
  });
});

describe("réglages : rythme de l'interprétation (D43)", () => {
  it("phrases entières par défaut ; un fichier d'avant le réglage le reçoit sans perdre le reste", () => {
    expect(defaults.speech.rhythm).toBe("sentences");
    dir = mkdtempSync(path.join(tmpdir(), "voxis-settings-"));
    const file = path.join(dir, "settings.json");
    const { rhythm: _, ...before } = { ...defaults.speech, wholeSentences: false };
    writeFileSync(file, JSON.stringify({ speech: before }));
    const speech = new SettingsStore(file, defaults).get().speech;
    expect(speech.rhythm).toBe("sentences");
    expect(speech.wholeSentences).toBe(false);
  });

  it("refuse un rythme inconnu", () => {
    expect(SettingsSchema.safeParse({ ...defaults, speech: { ...defaults.speech, rhythm: "progressive" } }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...defaults, speech: { ...defaults.speech, rhythm: "rapide" } }).success).toBe(false);
  });
});
