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
