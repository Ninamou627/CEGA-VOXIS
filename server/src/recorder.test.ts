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
    expect(readdirSync(dir).sort()).toEqual(["0007-fr.mp3", "segments.jsonl", "session.json", "source.wav", "stt.jsonl"]);
  });

  it("un flux qui reçoit d'abord un contexte rejoué place ses mots là où ce contexte a été enregistré (D37)", () => {
    root = mkdtempSync(path.join(tmpdir(), "voxis-rec-"));
    const rec = new SessionRecorder(root, 16000);
    rec.start(T0);
    rec.stream(1, 0, T0);
    for (let i = 1; i <= 40; i++) rec.audio(frame(1000), T0 + i * 100);
    // Session rouverte à 4 000 ms d'enregistrement, après 3 s de contexte : sa position 0 est à 1 000.
    rec.stream(2, 3000, T0 + 5000);
    rec.segment({ seq: 3, text: "five.", reason: "final", turnStart: false, stream: 2, words: [{ text: "five.", startMs: 2700, endMs: 2950 }] });
    // Liaison reprise (D35) : le premier flux d'un nouvel enregistrement reçoit le contexte de la prise
    // d'avant, déjà enregistrée ailleurs ; ses mots se placent avant le début de source.wav.
    const first = rec.recording!;
    rec.stop();
    rec.start(T0 + 10_000);
    rec.stream(3, 3000, T0 + 10_000);
    rec.turn({ stream: 3, kind: "partial", words: [{ text: "four", startMs: 2500, endMs: 2800 }] }, T0 + 10_500);
    const second = rec.recording!;
    rec.stop();

    const read = (dir: string, file: string) => readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(read(first, "segments.jsonl")[0]).toMatchObject({ seq: 3, startMs: 3700, endMs: 3950 });
    expect(read(first, "stt.jsonl")).toEqual([
      { kind: "stream", stream: 1, atMs: 0, offsetMs: 0, warmupMs: 0 },
      { kind: "stream", stream: 2, atMs: 5000, offsetMs: 1000, warmupMs: 3000 },
    ]);
    expect(read(second, "stt.jsonl")).toEqual([
      { kind: "stream", stream: 3, atMs: 0, offsetMs: -3000, warmupMs: 3000 },
      { kind: "partial", stream: 3, atMs: 500, words: [{ text: "four", startMs: -500, endMs: -200 }] },
    ]);
  });

  it("garde ce que le STT envoie, tel quel, placé dans l'enregistrement (D36)", () => {
    root = mkdtempSync(path.join(tmpdir(), "voxis-rec-"));
    const rec = new SessionRecorder(root, 16000);
    rec.start(T0);
    rec.stream(1, 0, T0);
    for (let i = 1; i <= 10; i++) rec.audio(frame(1000), T0 + i * 100);
    rec.stream(2, 0, T0 + 1000); // second flux : ses horodatages repartent de zéro à 1 000 ms d'enregistrement
    for (let i = 11; i <= 20; i++) rec.audio(frame(1000), T0 + i * 100);
    rec.turn({ stream: 2, kind: "partial", words: [{ text: "twenty", startMs: 100, endMs: 400 }, { text: "five" }] }, T0 + 1500);
    rec.turn({ stream: 2, kind: "final", words: [{ text: "25.", startMs: 100, endMs: 700, isFinal: true }] }, T0 + 1800);
    rec.turn({ stream: 2, kind: "end", words: [] }, T0 + 1800);
    rec.turn({ stream: 9, kind: "partial", words: [{ text: "ghost" }] }, T0 + 1900); // flux inconnu : ignoré
    const dir = rec.recording!;
    rec.stop();

    const lines = readFileSync(path.join(dir, "stt.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { kind: "stream", stream: 1, atMs: 0, offsetMs: 0, warmupMs: 0 },
      { kind: "stream", stream: 2, atMs: 1000, offsetMs: 1000, warmupMs: 0 },
      { kind: "partial", stream: 2, atMs: 1500, words: [{ text: "twenty", startMs: 1100, endMs: 1400 }, { text: "five" }] },
      { kind: "final", stream: 2, atMs: 1800, words: [{ text: "25.", startMs: 1100, endMs: 1700, isFinal: true }] },
      { kind: "end", stream: 2, atMs: 1800, words: [] },
    ]);
  });

  it("n'écrit rien tant que le micro n'a pas démarré", () => {
    root = mkdtempSync(path.join(tmpdir(), "voxis-rec-"));
    const rec = new SessionRecorder(root, 16000);
    rec.audio(frame(1000));
    rec.played(1);
    rec.turn({ stream: 1, kind: "partial", words: [{ text: "hello" }] });
    expect(readdirSync(root)).toEqual([]);
  });
});
