import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWav } from "./prosody";
import { SessionRecorder } from "./recorder";

const T0 = 1_000_000;
/** 100 ms à 16 kHz. */
const frame = (v: number) => new Uint8Array(new Int16Array(1600).fill(v).buffer);

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SessionRecorder", () => {
  it("place les mots de chaque flux STT dans l'enregistrement, et date la première écoute", () => {
    root = mkdtempSync(path.join(tmpdir(), "voxis-rec-"));
    const rec = new SessionRecorder(root, 16000);
    rec.start(T0);
    rec.stream(1);
    for (let i = 1; i <= 10; i++) rec.audio(frame(1000), T0 + i * 100);
    // Reconnexion du STT après 1 s : le second flux repart de zéro à 1 000 ms d'enregistrement.
    rec.stream(2);
    for (let i = 11; i <= 20; i++) rec.audio(frame(2000), T0 + i * 100);
    rec.segment({ seq: 7, text: "again.", reason: "final", turnStart: true, stream: 2, words: [{ text: "again.", startMs: 200, endMs: 500 }] });
    rec.voice({ seq: 7, lang: "fr", text: "encore.", mime: "audio/mpeg", durMs: 600, bytes: new Uint8Array([1, 2, 3]) }, T0 + 1900);
    rec.played(7, T0 + 2000);
    const dir = rec.recording!;
    rec.stop();

    const wav = readWav(new Uint8Array(readFileSync(path.join(dir, "source.wav"))));
    expect(wav.samples.length).toBe(32000); // 2 s, tailles de l'en-tête corrigées à l'arrêt
    expect(wav.samples[16000]).toBeCloseTo(2000 / 32768);

    const lines = readFileSync(path.join(dir, "segments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "src", seq: 7, startMs: 1200, endMs: 1500, words: [{ text: "again.", startMs: 1200, endMs: 1500 }] });
    expect(lines[1]).toMatchObject({ kind: "tgt", seq: 7, file: "0007-fr.mp3", durMs: 600 });
    expect(lines[2]).toMatchObject({ kind: "play", seq: 7, atMs: 2000 }); // T0 + 2000 : fin de la 20e trame
    expect(readdirSync(dir).sort()).toEqual(["0007-fr.mp3", "segments.jsonl", "session.json", "source.wav"]);
  });

  it("n'écrit rien tant que le micro n'a pas démarré", () => {
    root = mkdtempSync(path.join(tmpdir(), "voxis-rec-"));
    const rec = new SessionRecorder(root, 16000);
    rec.audio(frame(1000));
    rec.played(1);
    expect(readdirSync(root)).toEqual([]);
  });
});
