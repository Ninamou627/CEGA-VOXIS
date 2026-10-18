/**
 * Test de charge : N apprenants simulés sur le serveur de salle.
 *
 *   npm run load -- [apprenants=30] [secondes=60] [ws://localhost:8787/ws]
 *
 * Chaque client rejoint la session, reçoit les trames audio, et les « joue » comme la
 * page apprenant (shared/playback) : file locale, vitesse de lecture réajustée toutes les
 * 500 ms selon la file, saut au-delà de 8 s, ack au démarrage effectif de chaque segment
 * avec la même définition de file. La latence mesurée est donc celle d'un vrai téléphone.
 * Il se reconnecte s'il est coupé. Toutes les 10 s, un rapport :
 * clients, trames, débit, égalité du fan-out, santé du serveur (/api/health).
 *
 * Mesure le serveur et le fan-out sur boucle locale — PAS le Wi-Fi de salle.
 * À faire tourner pendant qu'un formateur (ou `npm run replay`) alimente le pipeline.
 */
import WebSocket from "ws";
import { decodeFrame } from "../../shared/framing";
import { localRate, MAX_AGE_MS, MAX_QUEUE_MS, RATE_EVERY_MS } from "../../shared/playback";
import type { AudioHeader, ServerEvent } from "../../shared/protocol";
import { adminCookie, originOf, roomCode } from "./session";

const N = Number(process.argv[2] ?? 30);
const SECONDS = Number(process.argv[3] ?? 60);
const URL = process.argv[4] ?? "ws://localhost:8787/ws";
const ORIGIN = originOf(URL);
const HEALTH = `${ORIGIN}/api/health`;
// Les apprenants simulés présentent un vrai code de séance (D17), comme de vrais téléphones.
const CODE = await roomCode(ORIGIN, await adminCookie(ORIGIN));
/** Pas de la lecture simulée : l'écoute démarre au plus 20 ms après l'instant réel. */
const PLAY_STEP_MS = 20;

/** Un segment dans la file d'un apprenant simulé ; `left` : ms restant à jouer à vitesse 1. */
interface Item {
  seq: number;
  tOrigin: number;
  left: number;
}

interface Client {
  id: number;
  ws?: WebSocket;
  connected: boolean;
  frames: number;
  bytes: number;
  dropped: number;
  reconnects: number;
  // Lecteur simulé, comme ElementPlayer : ce qui joue, ce qui attend, la vitesse locale.
  current?: Item;
  queue: Item[];
  rate: number;
  /** Vitesse déjà appliquée à la synthèse par le serveur (stats). */
  serverSpeed: number;
  /** Horloge serveur − horloge locale (hello). */
  clockOffset: number;
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
  queue: [],
  rate: 1,
  serverSpeed: 1,
  clockOffset: 0,
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
    if (!isBinary) {
      const e = JSON.parse(raw.toString()) as ServerEvent;
      if (e.t === "hello") c.clockOffset = e.tServer - Date.now();
      if (e.t === "stats") c.serverSpeed = e.stats.pipeline.speed;
      return;
    }
    const buf = raw as Buffer;
    const { header, payload } = decodeFrame<AudioHeader>(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    if (header.t !== "audio") return;
    if (fullAt !== null) c.frames++; // avant que la salle soit pleine, les retardataires ratent forcément des segments
    c.bytes += payload.byteLength;
    totalBytesWindow += payload.byteLength;
    if (c.lastSeq && header.seq > c.lastSeq + 1) c.gaps += header.seq - c.lastSeq - 1;
    c.lastSeq = header.seq;

    // Même politique que la page apprenant : saut si la file ou l'âge dépassent 8 s.
    const age = Date.now() + c.clockOffset - header.tOrigin;
    if (queueOf(c) > MAX_QUEUE_MS || age > MAX_AGE_MS) {
      c.dropped++;
      return;
    }
    c.queue.push({ seq: header.seq, tOrigin: header.tOrigin, left: header.durMs });
    if (!c.current) startNext(c);
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

/** Comme ElementPlayer.queueMs : audio restant à jouer, segment en cours compris, à la vitesse courante. */
function queueOf(c: Client): number {
  return (c.queue.reduce((a, q) => a + q.left, 0) + (c.current?.left ?? 0)) / c.rate;
}

/** Le segment suivant commence : ack avec la file vue à cet instant, comme la page. */
function startNext(c: Client) {
  c.current = c.queue.shift();
  if (!c.current || c.ws?.readyState !== WebSocket.OPEN) return;
  c.ws.send(JSON.stringify({ t: "ack", seq: c.current.seq, tOrigin: c.current.tOrigin, queueMs: queueOf(c) }));
}

// La lecture avance, et la vitesse se réajuste toutes les 500 ms, pour tous les apprenants simulés.
let lastRateAt = 0;
setInterval(() => {
  const now = Date.now();
  const retune = now - lastRateAt >= RATE_EVERY_MS;
  if (retune) lastRateAt = now;
  for (const c of clients) {
    if (retune) c.rate = localRate(queueOf(c), c.serverSpeed);
    if (!c.current) continue;
    c.current.left -= PLAY_STEP_MS * c.rate;
    if (c.current.left <= 0) startNext(c);
  }
}, PLAY_STEP_MS).unref();

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
  rows.push({ ...r, cpu: p.cpuPercent, rss: p.rssMb, lag: p.loopLagMaxMs, e2e: s.e2eP50, e2e95: s.e2eP95, end: s.endP50, end95: s.endP95, qmax: s.queueMaxMs });
  console.log(
    `t=${String(r.t).padStart(3)}s  clients ${String(r.connected).padStart(3)}/${N}  trames/client ${r.min}–${r.max}` +
      `  ${r.mbps} Mbit/s  sautés ${r.dropped}  reconnexions ${r.reconnects}  trous ${r.gaps}` +
      `  | serveur CPU ${p.cpuPercent ?? "?"} %  RSS ${p.rssMb ?? "?"} Mo  boucle ${p.loopLagMaxMs ?? "?"} ms` +
      `  fin de phrase → voix p50 ${s.endP50 ?? "—"} p95 ${s.endP95 ?? "—"}  e2e p50 ${s.e2eP50 ?? "—"}  file max ${s.queueMaxMs ?? "—"}`,
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
    console.log(`fin de phrase → voix p50 ${last.end ?? "—"} ms · p95 ${last.end95 ?? "—"} ms`);
    console.log(`décalage ressenti (premier mot → voix) p50 ${last.e2e ?? "—"} ms · p95 ${last.e2e95 ?? "—"} ms · file max ${last.qmax ?? "—"} ms`);
    setTimeout(() => process.exit(0), 500);
  }
}, 10_000);
