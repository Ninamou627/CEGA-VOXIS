/**
 * Test de charge : N apprenants simulés sur le serveur de salle.
 *
 *   npm run load -- [apprenants=30] [secondes=60] [ws://localhost:8787/ws]
 *
 * Chaque client rejoint la session, reçoit les trames audio, simule une lecture
 * (file locale, ack au démarrage effectif de chaque segment, abandon au-delà de 8 s
 * comme la vraie page) et se reconnecte s'il est coupé. Toutes les 10 s, un rapport :
 * clients, trames, débit, égalité du fan-out, santé du serveur (/api/health).
 *
 * Mesure le serveur et le fan-out sur boucle locale — PAS le Wi-Fi de salle.
 * À faire tourner pendant qu'un formateur (ou `npm run replay`) alimente le pipeline.
 */
import WebSocket from "ws";
import { decodeFrame } from "../../shared/framing";
import type { AudioHeader } from "../../shared/protocol";
import { adminCookie, originOf, roomCode } from "./session";

const N = Number(process.argv[2] ?? 30);
const SECONDS = Number(process.argv[3] ?? 60);
const URL = process.argv[4] ?? "ws://localhost:8787/ws";
const ORIGIN = originOf(URL);
const HEALTH = `${ORIGIN}/api/health`;
// Les apprenants simulés présentent un vrai code de séance (D17), comme de vrais téléphones.
const CODE = await roomCode(ORIGIN, await adminCookie(ORIGIN));
const MAX_QUEUE_MS = 8000;

interface Client {
  id: number;
  ws?: WebSocket;
  connected: boolean;
  frames: number;
  bytes: number;
  dropped: number;
  reconnects: number;
  playheadEnd: number; // instant (ms) où la file locale sera vide
  lastSeq: number;
  gaps: number; // seq manqués
}

const clients: Client[] = Array.from({ length: N }, (_, id) => ({
  id,
  connected: false,
  frames: 0,
  bytes: 0,
  dropped: 0,
  reconnects: 0,
  playheadEnd: 0,
  lastSeq: 0,
  gaps: 0,
}));
let totalBytesWindow = 0;
/** Instant où tous les clients sont connectés : l'égalité du fan-out se juge à partir de là. */
let fullAt: number | null = null;

function connect(c: Client, attempt = 0) {
  const ws = new WebSocket(URL, { rejectUnauthorized: false });
  c.ws = ws;
  ws.binaryType = "nodebuffer";
  ws.on("open", () => {
    c.connected = true;
    ws.send(JSON.stringify({ t: "join", role: "listener", lang: "fr", code: CODE, ua: `load-${c.id}` }));
    if (fullAt === null && clients.every((x) => x.connected)) fullAt = Date.now();
  });
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const buf = raw as Buffer;
    const { header, payload } = decodeFrame<AudioHeader>(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    if (header.t !== "audio") return;
    if (fullAt !== null) c.frames++; // avant que la salle soit pleine, les retardataires ratent forcément des segments
    c.bytes += payload.byteLength;
    totalBytesWindow += payload.byteLength;
    if (c.lastSeq && header.seq > c.lastSeq + 1) c.gaps += header.seq - c.lastSeq - 1;
    c.lastSeq = header.seq;

    // Lecture simulée, même politique que la page apprenant.
    const now = Date.now();
    const queueMs = Math.max(0, c.playheadEnd - now);
    if (queueMs > MAX_QUEUE_MS) {
      c.dropped++;
      return;
    }
    const start = Math.max(now, c.playheadEnd);
    c.playheadEnd = start + header.durMs;
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "ack", seq: header.seq, tOrigin: header.tOrigin, queueMs }));
    }, start - now);
  });
  ws.on("close", () => {
    c.connected = false;
    if (!stopping) {
      c.reconnects++;
      setTimeout(() => connect(c, attempt + 1), Math.min(5000, 500 * 2 ** attempt));
    }
  });
  ws.on("error", () => {
    /* close suit */
  });
}

let stopping = false;
const t0 = Date.now();
console.log(`${N} apprenants simulés → ${URL}, pendant ${SECONDS} s\n`);

// Connexions échelonnées (30 par seconde) : une salle se remplit, elle n'apparaît pas d'un coup.
clients.forEach((c, i) => setTimeout(() => connect(c), (i * 1000) / 30));

async function health() {
  try {
    const r = await fetch(HEALTH, { signal: AbortSignal.timeout(2000) });
    return (await r.json()) as any;
  } catch {
    return undefined;
  }
}

function report(final = false) {
  const connected = clients.filter((c) => c.connected).length;
  const frames = clients.map((c) => c.frames);
  const min = Math.min(...frames);
  const max = Math.max(...frames);
  const mbps = ((totalBytesWindow * 8) / 10 / 1e6).toFixed(2);
  totalBytesWindow = 0;
  const dropped = clients.reduce((a, c) => a + c.dropped, 0);
  const reconnects = clients.reduce((a, c) => a + c.reconnects, 0);
  const gaps = clients.reduce((a, c) => a + c.gaps, 0);
  return { t: Math.round((Date.now() - t0) / 1000), connected, min, max, mbps, dropped, reconnects, gaps, final };
}

const rows: any[] = [];
const timer = setInterval(async () => {
  const r = report();
  const h = await health();
  const p = h?.process ?? {};
  const s = h?.stats ?? {};
  rows.push({ ...r, cpu: p.cpuPercent, rss: p.rssMb, lag: p.loopLagMaxMs, e2e: s.e2eP50, e2e95: s.e2eP95, qmax: s.queueMaxMs });
  console.log(
    `t=${String(r.t).padStart(3)}s  clients ${String(r.connected).padStart(3)}/${N}  trames/client ${r.min}–${r.max}` +
      `  ${r.mbps} Mbit/s  sautés ${r.dropped}  reconnexions ${r.reconnects}  trous ${r.gaps}` +
      `  | serveur CPU ${p.cpuPercent ?? "?"} %  RSS ${p.rssMb ?? "?"} Mo  boucle ${p.loopLagMaxMs ?? "?"} ms` +
      `  e2e p50 ${s.e2eP50 ?? "—"} p95 ${s.e2eP95 ?? "—"}  file max ${s.queueMaxMs ?? "—"}`,
  );
  if (r.t >= SECONDS) {
    clearInterval(timer);
    stopping = true;
    for (const c of clients) c.ws?.close();
    const last = rows[rows.length - 1];
    const cpuMax = Math.max(...rows.map((x) => x.cpu ?? 0));
    const lagMax = Math.max(...rows.map((x) => x.lag ?? 0));
    console.log("\n=== Bilan ===");
    console.log(`apprenants connectés en fin de test : ${last.connected}/${N}`);
    console.log(`fan-out : chaque client a reçu entre ${last.min} et ${last.max} trames${last.min === last.max ? " (identique : aucun client lésé)" : " (INÉGAL)"}`);
    console.log(`segments sautés ${last.dropped} · trous de séquence ${last.gaps} · reconnexions ${last.reconnects}`);
    console.log(`serveur : CPU max ${cpuMax} % · RSS ${last.rss} Mo · retard de boucle max ${lagMax} ms`);
    console.log(`bout-en-bout p50 ${last.e2e ?? "—"} ms · p95 ${last.e2e95 ?? "—"} ms · file max ${last.qmax ?? "—"} ms`);
    setTimeout(() => process.exit(0), 500);
  }
}, 10_000);
