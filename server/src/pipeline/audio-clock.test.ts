import { describe, expect, it } from "vitest";
import { AudioClock } from "./audio-clock";

/** Une trame de 100 ms à 16 kHz, PCM 16 bits mono. */
const FRAME = 3200;

describe("AudioClock", () => {
  it("date une position du flux à l'instant où elle a été prononcée", () => {
    const c = new AudioClock(16000);
    // Trames reçues à l'heure : la trame [0, 100] à 1100, [100, 200] à 1200…
    for (let i = 1; i <= 3; i++) c.push(FRAME, 1000 + i * 100);
    expect(c.audioMs).toBe(300);
    expect(c.spokenAt(150)).toBe(1150);
    expect(c.spokenAt(300)).toBe(1300);
  });

  it("ne se laisse pas tromper par des trames groupées par le Wi-Fi", () => {
    const c = new AudioClock(16000);
    c.push(FRAME, 1100); // à l'heure
    c.push(FRAME, 1300); // retardée de 100 ms…
    c.push(FRAME, 1300); // …arrivée avec la suivante, elle à l'heure
    // La trame retardée seule dirait 1 250 ; la suivante, arrivée à l'heure, dit la vérité.
    expect(c.spokenAt(150)).toBe(1150);
  });

  it("prolonge un horodatage un peu au-delà de l'audio reçu", () => {
    const c = new AudioClock(16000);
    c.push(FRAME, 1100);
    expect(c.spokenAt(120)).toBe(1120);
  });

  it("repart de zéro avec un nouveau flux STT", () => {
    const c = new AudioClock(16000);
    c.push(FRAME, 1100);
    c.reset();
    expect(c.audioMs).toBe(0);
    expect(c.spokenAt(50)).toBeUndefined();
    c.push(FRAME, 5100);
    expect(c.spokenAt(50)).toBe(5050);
  });

  it("dit « inconnu » pour une position plus ancienne que ce qu'elle garde", () => {
    const c = new AudioClock(16000, 10);
    for (let i = 1; i <= 600; i++) c.push(FRAME, i * 100);
    expect(c.spokenAt(100)).toBeUndefined();
    expect(c.spokenAt(59_950)).toBe(59_950);
  });
});
