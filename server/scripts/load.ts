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
 * LOAD_PAUSES=off : enchaîne les segments sans les pauses gardées (D26), pour mesurer l'avant.
 *
 * Mesure le serveur et le fan-out sur boucle locale — PAS le Wi-Fi de salle.
 * À faire tourner pendant qu'un formateur (ou `npm run replay`) alimente le pipeline.
 */
import WebSocket from "ws";
import { decodeFrame } from "../../shared/framing";
import { arrivalAgeMs, keptPauseMs, localRate, RATE_EVERY_MS, tooLate } from "../../shared/playback";
import type { AudioHeader, ServerEvent } from "../../shared/protocol";
import { adminCookie, originOf, roomCode } from "./session";

const N = Number(process.argv[2] ?? 30);
const SECONDS = Number(process.argv[3] ?? 60);
const URL = process.argv[4] ?? "ws://localhost:8787/ws";
const ORIGIN = originOf(URL);
const HEALTH = `${ORIGIN}/api/health`;
// Les apprenants simulés présentent un vrai code de séance (D17), comme de vrais téléphones.
const CODE = await roomCode(ORIGIN, await adminCookie(ORIGIN));
/**
 * Cadence de la lecture simulée. Elle avance du temps réellement écoulé : sous Windows, un
 * minuteur de 20 ms se déclenche toutes les ~31 ms (mesuré), et avancer d'un pas fixe jouait
 * l'audio à ×0,66, ce qui gonflait la file.
 */
const PLAY_STEP_MS = 20;
/** Pauses du formateur gardées à l'écoute (D26), comme la page apprenant. */
const KEEP_PAUSES = process.env.LOAD_PAUSES !== "off";

/** Un segment dans la file d'un apprenant simulé ; `left` : ms restant à jouer à vitesse 1. */
interface Item {
  seq: number;
  tOrigin: number;
  left: number;
  /** Silence du formateur avant ce segment, et arrivée dans la file (pause gardée, D26). */
  pauseMs?: number;
  at: number;
  /** Pause restant à marquer avant de jouer (ms). */
  wait?: number;
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
  /** Fin du segment précédent (horloge locale). */
  lastEndedAt: number;
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
  lastEndedAt: 0,
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

    // Même politique que la page apprenant : saut si la file, ou l'âge depuis la fin de la phrase, dépassent 8 s.
    if (tooLate(queueOf(c), arrivalAgeMs(Date.now() + c.clockOffset, header))) {
      c.dropped++;
      return;
    }
    c.queue.push({ seq: header.seq, tOrigin: header.tOrigin, left: header.durMs, pauseMs: header.pauseMs, at: Date.now() });
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

/** Le segment suivant commence, après la pause gardée s'il y en a une (comme ElementPlayer). */
function startNext(c: Client) {
  c.current = c.queue.shift();
  if (!c.current) return;
  const now = Date.now();
  const pause = KEEP_PAUSES ? keptPauseMs(c.current.pauseMs, c.lastEndedAt ? now - c.lastEndedAt : Infinity, now - c.current.at) : 0;
  if (pause > 0) {
    c.current.wait = pause;
    return;
  }
  ack(c);
}

/** Début effectif de l'écoute : ack avec la file vue à cet instant, comme la page. */
function ack(c: Client) {
  if (!c.current || c.ws?.readyState !== WebSocket.OPEN) return;
  c.ws.send(JSON.stringify({ t: "ack", seq: c.current.seq, tOrigin: c.current.tOrigin, queueMs: queueOf(c) }));
}

// La lecture avance, et la vitesse se réajuste toutes les 500 ms, pour tous les apprenants simulés.
let lastRateAt = 0;
let lastTick = performance.now();
setInterval(() => {
  const now = Date.now();
  const tick = performance.now();
  const elapsed = tick - lastTick;
  lastTick = tick;
  const retune = now - lastRateAt >= RATE_EVERY_MS;
  if (retune) lastRateAt = now;
  for (const c of clients) {
    if (retune) c.rate = localRate(queueOf(c), c.serverSpeed);
    if (!c.current) continue;
    if (c.current.wait) {
      c.current.wait = Math.max(0, c.current.wait - elapsed);
      if (!c.current.wait) ack(c);
      continue;
    }
    c.current.left -= elapsed * c.rate;
    if (c.current.left <= 0) {
      c.lastEndedAt = Date.now();
      startNext(c);
    }
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
  rows.push({ ...r, cpu: p.cpuPercent, rss: p.rssMb, lag: p.loopLagMaxMs, e2e: s.e2eP50, e2e95: s.e2eP95, end: s.endP50, end95: s.endP95, start: s.startP50, start95: s.startP95, first: s.firstP50, qmax: s.queueMaxMs });
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
    console.log(`début de parole → voix p50 ${last.start ?? "—"} ms · p95 ${last.start95 ?? "—"} ms · premier son d'une prise de parole p50 ${last.first ?? "—"} ms`);
    console.log(`premier mot reconnu → voix p50 ${last.e2e ?? "—"} ms · p95 ${last.e2e95 ?? "—"} ms · file max ${last.qmax ?? "—"} ms`);
    setTimeout(() => process.exit(0), 500);
  }
}, 10_000);
