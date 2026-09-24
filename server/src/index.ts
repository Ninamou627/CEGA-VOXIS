import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerAdmin } from "./admin";
import { loadConfig, repoPath } from "./config";
import { Metrics } from "./metrics";
import { Pipeline } from "./pipeline/pipeline";
import { lanIp, lanIps } from "./net";
import { makeProviders } from "./providers";
import { Room } from "./room";
import { clientSettings, commitConfig, defaultsFrom, SettingsStore } from "./settings";
import { Totals } from "./totals";
import { VoiceCatalog } from "./voices/elevenlabs";
import { attachWs, binaryFrames } from "./ws/handlers";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

// Chemins relatifs à la racine du dépôt (npm lance le serveur depuis server/).
const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(here, "../..", p));
const tls = cfg.TLS_CERT && cfg.TLS_KEY ? { cert: readFileSync(fromRoot(cfg.TLS_CERT)), key: readFileSync(fromRoot(cfg.TLS_KEY)) } : undefined;

/** Un certificat auto-signé ne vaut que pour les IP qu'il liste : on prévient si l'IP a changé. */
function certCoversCurrentIp(): string | undefined {
  if (!tls || cfg.PUBLIC_URL) return undefined;
  const ip = lanIp();
  if (!ip) return undefined;
  try {
    const san = new X509Certificate(tls.cert).subjectAltName ?? "";
    if (!san.includes(`IP Address:${ip}`) && !san.includes(`IP:${ip}`)) {
      return `le certificat ${cfg.TLS_CERT} ne couvre pas l'IP courante ${ip} — les téléphones refuseront la connexion. Relancez : npm run cert:dev`;
    }
  } catch {
    /* certificat illisible : la vraie erreur sortira au démarrage HTTPS */
  }
  return undefined;
}

let wss: WebSocketServer | undefined;
const app = Fastify({
  logger: { level: cfg.LOG_LEVEL },
  serverFactory: (handler) => {
    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1024 * 1024 });
    return server;
  },
});

// Réglages de l'administration (le .env en donne les valeurs de départ) et compteurs de long terme.
const store = new SettingsStore(repoPath(cfg.SETTINGS_FILE), defaultsFrom(cfg));
const settings = () => store.get();
const totals = new Totals(repoPath(cfg.TOTALS_FILE));

const metrics = new Metrics(cfg.METRICS_FILE);
metrics.speechDb = settings().speech.speechThresholdDb;
const providers = makeProviders(cfg, settings, {
  onFallback: (stage, err) => {
    app.log.warn({ stage, err: err.message }, "primaire en échec, bascule sur le secours pour 60 s");
    pipeline.reportDegraded(stage === "mt" ? "backup-mt" : "backup-tts", err.message.slice(0, 200));
  },
  onRecover: (stage) => {
    app.log.info({ stage }, "primaire rétabli");
    pipeline.reportDegraded("none", `${stage.toUpperCase()} primaire rétabli`);
  },
});
const room = new Room(cfg.SESSION_ID, cfg.SRC_LANG, cfg.TARGET_LANGS);
const pipeline = new Pipeline(
  providers,
  {
    srcLang: cfg.SRC_LANG,
    targetLangs: cfg.TARGET_LANGS,
    sampleRate: 16000,
    tuning: () => {
      const s = settings();
      return { commit: commitConfig(s), contextSegments: s.translation.contextSegments, baseSpeed: s.voice.speed };
    },
  },
  metrics,
);

// Un enregistrement dans l'administration s'applique ici, sans redémarrer la salle.
store.on("change", ({ settings: s, changed }) => {
  if (changed.includes("translation.primary") || changed.includes("translation.secondary")) providers.mt.rebuild();
  if (changed.some((k) => k.startsWith("speech."))) {
    pipeline.retune();
    metrics.speechDb = s.speech.speechThresholdDb;
  }
  room.broadcast({ t: "settings", settings: clientSettings(s) });
  metrics.event("settings", { changed });
  app.log.info({ changed }, "réglages modifiés depuis l'administration");
});

// Disponibilité : chaque seconde de séance compte, et la part où la voix pouvait être servie.
setInterval(() => {
  const inSession = pipeline.isStarted;
  const { degraded } = pipeline.status;
  totals.tick(1000, inSession, inSession && pipeline.sttOpen && degraded !== "text-only" && degraded !== "stt-lost");
}, 1000).unref();

registerAdmin(app, {
  cfg,
  store,
  totals,
  providers,
  catalog: cfg.ELEVENLABS_API_KEY ? new VoiceCatalog(cfg.ELEVENLABS_API_KEY) : undefined,
});

// ---- client compilé (npm run build) ------------------------------------------------
const clientDist = path.resolve(here, "../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist, prefix: "/" });
  app.get("/lecturer", (_req, reply) => reply.sendFile("lecturer.html"));
  app.get("/dashboard", (_req, reply) => reply.sendFile("dashboard.html"));
  app.get("/screen", (_req, reply) => reply.sendFile("screen.html"));
} else {
  app.get("/", async () => ({
    message: "Client non compilé. En développement, ouvrez le serveur Vite (npm run dev) ; en production, npm run build.",
  }));
}

// ---- API ---------------------------------------------------------------------------
function publicUrl(ip = lanIp()): string {
  if (cfg.PUBLIC_URL) return cfg.PUBLIC_URL.replace(/\/$/, "");
  return `${tls ? "https" : "http"}://${ip ?? "localhost"}:${cfg.PORT}`;
}

// ---- santé du processus : CPU depuis le dernier appel, mémoire, retard de la boucle ----
let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let loopLagMaxMs = 0;
{
  let expected = performance.now() + 100;
  setInterval(() => {
    const now = performance.now();
    loopLagMaxMs = Math.max(loopLagMaxMs, now - expected);
    expected = now + 100;
  }, 100);
}
function processHealth() {
  const cpu = process.cpuUsage(lastCpu);
  const now = process.hrtime.bigint();
  const wallMs = Number(now - lastCpuAt) / 1e6;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  const lag = Math.round(loopLagMaxMs);
  loopLagMaxMs = 0;
  const mem = process.memoryUsage();
  return {
    cpuPercent: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100) : null,
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    loopLagMaxMs: lag,
  };
}

app.get("/api/health", async () => ({
  ok: true,
  uptimeS: Math.round((Date.now() - metrics.startedAt) / 1000),
  listeners: room.count("listener"),
  lecturer: room.count("lecturer") > 0,
  pipeline: pipeline.status,
  process: processHealth(),
  stats: metrics.snapshot(),
  audio: {
    wsBinaryFrames: binaryFrames,
    received: pipeline.audio.received,
    forwarded: pipeline.audio.forwarded,
    bytes: pipeline.audio.bytes,
    lastFrameAgoMs: pipeline.audio.lastAt ? Date.now() - pipeline.audio.lastAt : null,
    sttOpen: pipeline.sttOpen,
    started: pipeline.isStarted,
    micDb: metrics.snapshot().micDb,
  },
}));

app.get("/api/session", async () => ({
  sessionId: room.sessionId,
  srcLang: room.srcLang,
  langs: room.langs,
  providers: { stt: providers.stt.name, mt: providers.mt.name, tts: providers.tts.name },
  /** Certificat auto-signé qui ne couvre pas l'IP courante : la checklist du tableau de bord le montre. */
  certWarning: certCoversCurrentIp() ?? null,
  joinUrl: `${publicUrl()}/`,
  /** Toutes les adresses candidates, les vraies interfaces d'abord (PUBLIC_URL les remplace). */
  joinUrls: cfg.PUBLIC_URL
    ? [{ url: `${publicUrl()}/`, iface: "PUBLIC_URL", virtual: false }]
    : lanIps().map((i) => ({ url: `${publicUrl(i.address)}/`, iface: i.iface, virtual: i.virtual })),
  tls: Boolean(tls),
}));

// ---- démarrage ----------------------------------------------------------------------
await app.listen({ port: cfg.PORT, host: cfg.HOST });
if (!wss) throw new Error("WebSocketServer non initialisé");
attachWs(wss, { room, pipeline, providers, metrics, config: cfg, log: app.log, settings, totals });

app.log.info(
  {
    session: room.sessionId,
    langs: room.langs,
    stt: providers.stt.name,
    mt: providers.mt.name,
    tts: providers.tts.name,
    joinUrl: `${publicUrl()}/`,
    lecturerUrl: `${publicUrl()}/lecturer?token=…`,
    dashboardUrl: `${publicUrl()}/dashboard?token=…`,
    screenUrl: `${publicUrl()}/screen`,
    tls: Boolean(tls),
  },
  "salle ouverte",
);
const certWarning = certCoversCurrentIp();
if (certWarning) app.log.warn(certWarning);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info("arrêt…");
    await pipeline.stop().catch(() => {});
    totals.close();
    metrics.close();
    await app.close();
    process.exit(0);
  });
}
