/**
 * Rejoue un fichier WAV dans le pipeline comme s'il sortait du micro du formateur.
 *
 *   npm run replay -- ../fixtures/formateur-10min.wav [ws://localhost:8787/ws]
 *
 * Se connecte comme le vrai poste formateur, avec le compte d'administration de la
 * configuration (ADMIN_USER / ADMIN_PASSWORD).
 *
 * C'est l'outil de mesure : la même fixture, rejouée à l'identique, permet de
 * comparer deux moteurs ou deux réglages de segmentation sur des chiffres, pas à
 * l'oreille. Le WAV doit être PCM 16 bits mono (idéalement 16 kHz).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { adminCookie, originOf } from "./session";

const [, , file, url = "ws://localhost:8787/ws"] = process.argv;
if (!file) {
  console.error("usage: replay <fichier.wav> [url ws]");
  process.exit(1);
}

// Lancé via `npm run replay` depuis la racine : npm change le cwd vers server/,
// mais INIT_CWD garde le répertoire d'où la commande a été tapée.
const filePath = path.isAbsolute(file) ? file : path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
const wav = readFileSync(filePath);
if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
  console.error("ce n'est pas un fichier WAV");
  process.exit(1);
}

// Lecture minimale des chunks RIFF : fmt puis data.
let off = 12;
let sampleRate = 16000;
let channels = 1;
let bits = 16;
let data: Buffer | undefined;
while (off + 8 <= wav.length) {
  const id = wav.toString("ascii", off, off + 4);
  const size = wav.readUInt32LE(off + 4);
  const body = wav.subarray(off + 8, off + 8 + size);
  if (id === "fmt ") {
    channels = body.readUInt16LE(2);
    sampleRate = body.readUInt32LE(4);
    bits = body.readUInt16LE(14);
  } else if (id === "data") {
    data = body;
  }
  off += 8 + size + (size % 2);
}
if (!data) throw new Error("chunk data absent");
if (bits !== 16 || channels !== 1) throw new Error(`attendu PCM 16 bits mono, reçu ${bits} bits / ${channels} canaux`);

const FRAME_MS = 100;
const frameBytes = (sampleRate * 2 * FRAME_MS) / 1000;
console.log(`fixture : ${(data.length / (sampleRate * 2)).toFixed(1)} s à ${sampleRate} Hz — ${Math.ceil(data.length / frameBytes)} trames`);

const cookie = await adminCookie(originOf(url));
const ws = new WebSocket(url, { rejectUnauthorized: false, headers: { cookie } });
ws.on("open", () => {
  ws.send(JSON.stringify({ t: "join", role: "lecturer", sampleRate, ua: "replay" }));
  let pos = 0;
  // Une trame par tick, jamais de rattrapage : les STT temps réel refusent l'audio
  // envoyé plus vite que le réel (AssemblyAI ferme avec le code 3007). Si le timer
  // prend du retard, le rejeu est un peu plus lent que le réel — acceptable.
  const timer = setInterval(() => {
    if (pos < data!.length) {
      ws.send(data!.subarray(pos, pos + frameBytes), { binary: true });
      pos += frameBytes;
    }
    if (pos >= data!.length) {
      clearInterval(timer);
      console.log("fixture terminée, fermeture dans 5 s");
      setTimeout(() => ws.close(), 5000);
    }
  }, FRAME_MS);
});
ws.on("message", (raw, isBinary) => {
  if (isBinary) return;
  const e = JSON.parse(raw.toString());
  if (e.t === "src.commit") console.log(`[commit #${e.seq} ${e.reason}] ${e.text}`);
  if (e.t === "tr.segment") console.log(`   → ${e.lang}: ${e.text}`);
  if (e.t === "stats" && e.stats.e2eP50 != null) console.log(`   (e2e p50 ${e.stats.e2eP50} ms · p95 ${e.stats.e2eP95} ms · file max ${e.stats.queueMaxMs} ms)`);
  if (e.t === "error") console.error("erreur :", e.msg);
});
ws.on("close", () => process.exit(0));
ws.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
