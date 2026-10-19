import { describe, expect, it } from "vitest";
import { PauseDetector } from "./pause";

/** Trame de `ms` à 16 kHz : un ton à −24 dBFS (parole) ou des zéros (silence). */
function frame(ms: number, speech: boolean): Uint8Array {
  const n = (16000 * ms) / 1000;
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  if (speech) for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
  return b;
}

describe("PauseDetector", () => {
  it("compte le silence qui suit la parole, d'une trame à l'autre", () => {
    const p = new PauseDetector(16000);
    expect(p.push(frame(100, true), -35)).toBe(0);
    expect(p.push(frame(100, false), -35)).toBe(100);
    expect(p.push(frame(100, false), -35)).toBe(200);
  });

  it("repart de zéro dès que la parole reprend, même au milieu d'une trame", () => {
    const p = new PauseDetector(16000);
    p.push(frame(200, false), -35);
    const mixed = new Uint8Array(3200);
    mixed.set(frame(40, false), 0);
    mixed.set(frame(60, true), 1280);
    expect(p.push(mixed, -35)).toBe(0);
  });

  it("le seuil décide : un bruit de fond sous le seuil reste du silence", () => {
    const p = new PauseDetector(16000);
    expect(p.push(frame(100, true), -10)).toBe(100); // le ton à −24 dBFS est sous −10 dBFS
  });
});

describe("PauseDetector — parole depuis la dernière coupe", () => {
  it("compte la parole, et repart de zéro à chaque coupe", () => {
    const p = new PauseDetector(16000);
    p.push(frame(300, true), -35);
    p.push(frame(100, false), -35);
    expect(p.speechSinceCut).toBe(300);
    p.cut();
    expect(p.speechSinceCut).toBe(0);
    p.push(frame(200, true), -35);
    expect(p.speechSinceCut).toBe(200);
  });
});

describe("PauseDetector — mots du STT recalés sur l'audio (D25)", () => {
  /** 1 s de parole, 400 ms de silence, 1 s de parole. */
  function spoken() {
    const p = new PauseDetector(16000);
    p.push(frame(1000, true), -35);
    p.push(frame(400, false), -35);
    p.push(frame(1000, true), -35);
    return p;
  }

  it("une fin de mot placée dans le silence qui suit revient à la fin de la parole", () => {
    expect(spoken().speechEnd(1300)).toBe(1000);
  });

  it("un début de mot placé dans le silence qui précède avance au début de la parole", () => {
    expect(spoken().speechStart(1100)).toBe(1400);
  });

  it("un horodatage dans la parole ne bouge pas", () => {
    expect(spoken().speechEnd(800)).toBe(800);
    expect(spoken().speechStart(1600)).toBe(1600);
  });

  it("la pause en cours compte pour la fin du dernier mot", () => {
    const p = new PauseDetector(16000);
    p.push(frame(1000, true), -35);
    p.push(frame(300, false), -35);
    expect(p.speechEnd(1200)).toBe(1000);
  });

  it("ne recale pas de plus de 0,7 s : une voix sous le seuil n'est pas un silence", () => {
    const p = new PauseDetector(16000);
    p.push(frame(3000, false), -35); // le STT entend des mots que le seuil prend pour du silence
    p.push(frame(100, true), -35);
    expect(p.speechEnd(2500)).toBe(2500);
    expect(p.speechStart(1000)).toBe(1000);
  });
});

describe("PauseDetector — la pause qui suit une phrase (D27)", () => {
  it("donne la durée d'une pause terminée", () => {
    const p = new PauseDetector(16000);
    p.push(frame(1000, true), -35);
    p.push(frame(400, false), -35);
    p.push(frame(500, true), -35);
    expect(p.pauseAfter(1000)).toEqual({ ms: 400, ongoing: false });
  });

  it("dit qu'une pause dure encore", () => {
    const p = new PauseDetector(16000);
    p.push(frame(1000, true), -35);
    p.push(frame(300, false), -35);
    expect(p.pauseAfter(1000)).toEqual({ ms: 300, ongoing: true });
  });

  it("0 quand la parole a repris sans vrai silence, rien pour une position pas encore entendue", () => {
    const p = new PauseDetector(16000);
    p.push(frame(1000, true), -35);
    p.push(frame(60, false), -35);
    p.push(frame(500, true), -35);
    expect(p.pauseAfter(1000)).toEqual({ ms: 0, ongoing: false });
    expect(p.pauseAfter(5000)).toBeUndefined();
  });
});
