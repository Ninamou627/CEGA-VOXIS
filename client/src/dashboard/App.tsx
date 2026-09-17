/**
 * Tableau de bord de salle : QR code de connexion, latence bout-en-bout, profondeur
 * de file (dérive), état des fournisseurs, journal des segments et des questions.
 */
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { FloorState, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { SalleSocket, type ConnState } from "../lib/ws";

interface SessionInfo {
  sessionId: string;
  langs: string[];
  joinUrl: string;
  joinUrls?: { url: string; iface: string; virtual: boolean }[];
  tls: boolean;
}

interface Line {
  seq: number;
  src?: string;
  tgt?: string;
  reason?: string;
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [token] = useState(params.get("token") ?? "");
  const [conn, setConn] = useState<ConnState>("closed");
  const [info, setInfo] = useState<SessionInfo>();
  const [stats, setStats] = useState<StatsPayload>();
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [lines, setLines] = useState<Line[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [err, setErr] = useState<string>();
  const qr = useRef<HTMLCanvasElement>(null);
  const sock = useRef<SalleSocket>(undefined);

  useEffect(() => {
    fetch("/api/session")
      .then(async (r) => {
        if (!r.ok) throw new Error(`serveur : HTTP ${r.status}`);
        return (await r.json()) as SessionInfo;
      })
      .then((i) => {
        setInfo(i);
        if (qr.current) void QRCode.toCanvas(qr.current, i.joinUrl, { width: 220, margin: 1 });
      })
      .catch((e) => setErr(`Serveur de salle injoignable (${(e as Error).message}). Est-il lancé, et sur le bon schéma (HTTP/HTTPS) ?`));

    const s = new SalleSocket(
      { t: "join", role: "dashboard", token },
      {
        onState: setConn,
        onAudio: () => {},
        onEvent: (e: ServerEvent) => {
          switch (e.t) {
            case "src.commit":
              setLines((p) => [...p, { seq: e.seq, src: e.text, reason: e.reason }].slice(-20));
              break;
            case "tr.segment":
              setLines((p) => p.map((l) => (l.seq === e.seq ? { ...l, tgt: e.text } : l)));
              break;
            case "stats":
              setStats(e.stats);
              break;
            case "floor":
              setFloor(e.floor);
              log(e.floor.state === "question" ? `question : ${e.floor.who} a la parole` : "parole rendue au formateur");
              break;
            case "question":
              log(`question (${e.who}) : « ${e.srcText} » → « ${e.text} »`);
              break;
            case "degraded":
              log(`DÉGRADÉ ${e.mode} — ${e.reason}`);
              break;
            case "error":
              setErr(e.msg);
              break;
          }
        },
      },
    );
    sock.current = s;
    s.connect();
    return () => s.close();
  }, [token]);

  function log(msg: string) {
    setEvents((p) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...p].slice(0, 50));
  }

  const p = stats?.pipeline;
  const e2e = stats?.e2eP50 ?? null;
  const q = stats?.queueMaxMs ?? null;

  return (
    <main className="app wide">
      <div className="row">
        <h1 className="grow">Tableau de bord · {info?.sessionId ?? "…"}</h1>
        <span className={`pill ${conn === "open" ? "ok" : "crit"}`}>{conn === "open" ? "Connecté" : conn}</span>
        {p && <span className={`pill ${p.degraded === "none" ? "ok" : "crit"}`}>{p.degraded === "none" ? "Pipeline nominal" : `Dégradé : ${p.degraded}`}</span>}
        {p?.muted && <span className="pill warn">Micro coupé</span>}
        {p && p.speed > 1 && <span className="pill warn">Voix ×{p.speed.toFixed(2)} — rattrapage</span>}
        {floor.state === "question" && <span className="pill warn">Question en cours</span>}
      </div>

      {err && <div className="banner crit">{err}</div>}

      <div className="grid">
        <div className="card stat">
          <b>{stats?.listeners ?? 0}</b>
          <span>à l'écoute</span>
        </div>
        <div className={`card stat ${e2e != null && e2e > 2500 ? "warn" : ""}`}>
          <b>{e2e != null ? `${(e2e / 1000).toFixed(2)} s` : "—"}</b>
          <span>bout-en-bout p50</span>
        </div>
        <div className="card stat">
          <b>{stats?.e2eP95 != null ? `${(stats.e2eP95 / 1000).toFixed(2)} s` : "—"}</b>
          <span>bout-en-bout p95</span>
        </div>
        <div className={`card stat ${q != null && q > 5000 ? "crit" : q != null && q > 2500 ? "warn" : ""}`}>
          <b>{q != null ? `${(q / 1000).toFixed(1)} s` : "—"}</b>
          <span>file max (dérive)</span>
        </div>
        <div className={`card stat ${p && p.backlog > 2 ? "warn" : ""}`}>
          <b>{p?.backlog ?? 0}</b>
          <span>segments en attente</span>
        </div>
        <div className={`card stat ${stats?.micDb == null ? "" : stats.micDb > -35 ? "" : stats.micDb > -50 ? "warn" : "crit"}`}>
          <b>{stats?.micDb == null ? "—" : `${stats.micDb} dB`}</b>
          <span>{stats?.micDb == null ? "micro" : stats.micDb > -35 ? "micro · parole" : stats.micDb > -50 ? "micro · faible" : "micro · silence"}</span>
        </div>
        <div className="card stat">
          <b>{stats ? `${Math.floor(stats.uptimeS / 60)} min` : "—"}</b>
          <span>en service</span>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(240px, 1fr) 2fr" }}>
        <div className="card" style={{ display: "grid", gap: 8, justifyItems: "center" }}>
          <h2>Rejoindre</h2>
          <canvas ref={qr} />
          <div className="mono tiny" style={{ wordBreak: "break-all", textAlign: "center" }}>
            {info?.joinUrl}
          </div>
          {info?.joinUrls && info.joinUrls.length > 1 && (
            <details className="tiny" style={{ width: "100%" }}>
              <summary>Autres adresses ({info.joinUrls.length - 1}) — si le téléphone ne joint pas celle du QR</summary>
              {info.joinUrls.slice(1).map((j) => (
                <div key={j.url} className="mono" style={{ wordBreak: "break-all", opacity: j.virtual ? 0.6 : 1 }}>
                  {j.url} <span className="tiny">({j.iface}{j.virtual ? ", virtuelle" : ""})</span>
                </div>
              ))}
            </details>
          )}
          {info && !info.tls && <div className="banner crit">HTTP : les questions (micro) ne fonctionneront pas sur les téléphones.</div>}
          {p && (
            <div className="tiny mono">
              STT {p.stt} · MT {p.mt} · TTS {p.tts}
            </div>
          )}
        </div>
        <div className="card transcript">
          <h2>Segments</h2>
          {lines
            .slice()
            .reverse()
            .map((l) => (
              <div className="line" key={l.seq}>
                <div className="src">
                  <span className="mono tiny">#{l.seq} {l.reason}</span> {l.src}
                </div>
                <div className="tgt">{l.tgt ?? "…"}</div>
              </div>
            ))}
          {!lines.length && <p className="muted">Aucun segment encore.</p>}
        </div>
      </div>

      <div className="card log">
        <h2>Événements</h2>
        {events.map((e, i) => (
          <div key={i} className="mono">
            {e}
          </div>
        ))}
        {!events.length && <p className="muted">—</p>}
      </div>
    </main>
  );
}
