/**
 * Page apprenant. QR code → choix de langue → « Écouter » → voix + texte.
 * Tout ce qui touche à la dérive est ici : file mesurée, abandon des segments
 * trop vieux, « revenir au direct », réécoute des 30 dernières secondes.
 */
import { useEffect, useRef, useState } from "react";
import type { AudioHeader, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { QuestionRecorder } from "../lib/mic";
import { ElementPlayer, WebAudioPlayer, type Player, type SegmentMeta } from "../lib/player";
import { keepWakeLockAlive, requestWakeLock } from "../lib/wakelock";
import { SalleSocket, type ConnState } from "../lib/ws";

/** Au-delà, on saute le segment plutôt que de dériver (§10 de la revue). */
const MAX_QUEUE_MS = 8000;
const MAX_AGE_MS = 8000;
const REPLAY_WINDOW_MS = 30_000;

const LANG_LABEL: Record<Lang, string> = { fr: "Français", en: "English", es: "Español", ar: "العربية", pt: "Português" };

interface Line {
  seq: number;
  src?: string;
  tgt?: string;
  untranslated?: boolean;
}

type Hello = Extract<ServerEvent, { t: "hello" }>;

export function App() {
  const params = new URLSearchParams(location.search);
  const [session] = useState(params.get("s") ?? "TRAINING-01");
  const [lang, setLang] = useState<Lang>((params.get("lang") as Lang) ?? "fr");
  // Lecteur média par défaut, partout : validé sur iPhone 13 Pro Max / iOS 26 écran
  // verrouillé, insensible au bouton silence, et il porte le playbackRate à hauteur
  // préservée. Web Audio reste disponible pour comparer sur ordinateur.
  const [playerKind, setPlayerKind] = useState<"webaudio" | "element">("element");
  const [phase, setPhase] = useState<"join" | "live">("join");
  const [conn, setConn] = useState<ConnState>("closed");
  const [hello, setHello] = useState<Hello>();
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [stats, setStats] = useState<StatsPayload>();
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [degraded, setDegraded] = useState<{ mode: string; reason: string }>();
  const [queueMs, setQueueMs] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [asking, setAsking] = useState(false);
  const [wake, setWake] = useState(false);
  const [err, setErr] = useState<string>();

  const sock = useRef<SalleSocket>(undefined);
  const player = useRef<Player>(undefined);
  const clockOffset = useRef(0);
  const ring = useRef<{ bytes: Uint8Array; mime: string; meta: SegmentMeta }[]>([]);
  const recorder = useRef<QuestionRecorder>(undefined);
  const serverSpeed = useRef(1);
  const [localRate, setLocalRate] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      const p = player.current;
      if (!p) return;
      const q = p.queueMs;
      setQueueMs(Math.round(q));
      // Parade locale immédiate (§09) : on vise la même vitesse cible que le serveur,
      // mais sans attendre que l'audio déjà synthétisé soit passé.
      const target = q > 6000 ? 1.25 : q > 4000 ? 1.15 : q > 2000 ? 1.08 : 1;
      const rate = Math.max(1, Math.round((target / serverSpeed.current) * 100) / 100);
      p.setRate(rate);
      setLocalRate(rate);
    }, 500);
    const stop = keepWakeLockAlive(setWake);
    return () => {
      clearInterval(id);
      stop();
    };
  }, []);

  async function start() {
    setErr(undefined);
    const p: Player = playerKind === "element" ? new ElementPlayer() : new WebAudioPlayer();
    await p.unlock(); // dans le geste utilisateur, obligatoire sur mobile
    p.onStart = (meta) => {
      if (meta.replay) return;
      sock.current?.send({ t: "ack", seq: meta.seq, tOrigin: meta.tOrigin, queueMs: p.queueMs });
    };
    player.current = p;
    setWake(await requestWakeLock());

    const s = new SalleSocket(
      { t: "join", role: "listener", session, lang, ua: navigator.userAgent.slice(0, 200) },
      { onState: setConn, onEvent: handleEvent, onAudio: handleAudio },
    );
    sock.current = s;
    s.connect();
    setPhase("live");
  }

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        setHello(e);
        setFloor(e.floor);
        setDegraded(e.pipeline.degraded === "none" ? undefined : { mode: e.pipeline.degraded, reason: "" });
        break;
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text });
        break;
      case "tr.segment":
        upsert(e.seq, { tgt: e.text, untranslated: e.untranslated });
        break;
      case "floor":
        setFloor(e.floor);
        break;
      case "stats":
        setStats(e.stats);
        serverSpeed.current = e.stats.pipeline.speed;
        break;
      case "degraded":
        // Un changement de moteur (secours) ne regarde pas l'apprenant ; une voix absente, si.
        setDegraded(e.mode === "none" || e.mode.startsWith("backup-") ? undefined : { mode: e.mode, reason: e.reason });
        break;
      case "error":
        setErr(e.msg);
        if (e.code === "floor_busy") {
          recorder.current?.cancel();
          setAsking(false);
          player.current?.setMuted(false);
        }
        break;
    }
  }

  function upsert(seq: number, patch: Partial<Line>) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.seq === seq);
      const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, ...patch } : l)) : [...prev, { seq, ...patch }];
      return next.slice(-12);
    });
  }

  function handleAudio(h: AudioHeader, bytes: Uint8Array) {
    const p = player.current;
    if (!p) return;
    const age = Date.now() + clockOffset.current - h.tOrigin;
    if (p.queueMs > MAX_QUEUE_MS || age > MAX_AGE_MS) {
      setDropped((d) => d + 1);
      return;
    }
    const meta: SegmentMeta = { seq: h.seq, tOrigin: h.tOrigin, durMs: h.durMs, text: h.text, lang: h.lang };
    const r = ring.current;
    r.push({ bytes, mime: h.mime, meta });
    let total = r.reduce((a, x) => a + x.meta.durMs, 0);
    while (r.length > 1 && total > REPLAY_WINDOW_MS) total -= r.shift()!.meta.durMs;
    void p.enqueue(bytes, h.mime, meta);
  }

  function resync() {
    const p = player.current;
    const droppedMs = Math.round(p?.queueMs ?? 0);
    p?.flush();
    sock.current?.send({ t: "resync", droppedMs });
  }

  function replay() {
    const p = player.current;
    if (!p) return;
    p.flush();
    for (const it of ring.current) void p.enqueue(it.bytes, it.mime, { ...it.meta, replay: true });
  }

  async function askStart() {
    if (asking || floor.state === "question") return;
    setErr(undefined);
    setAsking(true);
    player.current?.setMuted(true); // on ne s'entend pas par-dessus la voix traduite
    sock.current?.send({ t: "ask", phase: "start" });
    const rec = new QuestionRecorder();
    recorder.current = rec;
    try {
      await rec.start();
    } catch (e) {
      setErr("micro indisponible : " + (e as Error).message);
      sock.current?.send({ t: "ask", phase: "end" });
      setAsking(false);
      player.current?.setMuted(false);
    }
  }

  async function askEnd() {
    if (!asking) return;
    setAsking(false);
    const rec = recorder.current;
    recorder.current = undefined;
    const blob = rec ? await rec.stop() : new Blob([]);
    if (blob.size) sock.current?.sendBinary(await blob.arrayBuffer());
    sock.current?.send({ t: "ask", phase: "end", mime: rec?.mime });
    player.current?.setMuted(false);
  }

  // ---------------------------------------------------------------------------

  if (phase === "join") {
    return (
      <main className="app">
        <h1>Interprète de salle</h1>
        <div className="card" style={{ display: "grid", gap: 14 }}>
          <p className="muted">
            Session <b className="mono">{session}</b>. Mettez vos écouteurs, choisissez votre langue, puis appuyez sur Écouter.
          </p>
          <label>
            Langue
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {(["fr", "en", "es", "ar", "pt"] as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {LANG_LABEL[l]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lecteur audio
            <select value={playerKind} onChange={(e) => setPlayerKind(e.target.value as "webaudio" | "element")}>
              <option value="element">Lecture média (recommandé — fonctionne écran verrouillé)</option>
              <option value="webaudio">Web Audio (ordinateur seulement — muet sur iPhone)</option>
            </select>
          </label>
          <button className="primary big" onClick={() => void start()}>
            🎧 Écouter
          </button>
          <p className="tiny">
            Gardez l'écran allumé pendant l'écoute. L'audio est traité par des services tiers pour produire la traduction et n'est pas conservé.
          </p>
        </div>
      </main>
    );
  }

  const connPill = conn === "open" ? "ok" : conn === "closed" ? "crit" : "warn";
  const queueClass = queueMs > 5000 ? "crit" : queueMs > 2500 ? "warn" : "";
  const floorBusyByOther = floor.state === "question" && floor.who !== hello?.participantId;

  return (
    <main className="app">
      <div className="row">
        <h1 className="grow">
          {LANG_LABEL[lang]} <span className="tiny mono">{session}</span>
        </h1>
        <span className={`pill ${connPill}`}>
          {conn === "open" ? "Connecté" : conn === "reconnecting" ? "Reconnexion…" : conn === "connecting" ? "Connexion…" : "Déconnecté"}
        </span>
        {wake && <span className="pill ok">Écran maintenu</span>}
        {stats && stats.pipeline.speed > 1 && <span className="pill warn">Voix ×{stats.pipeline.speed.toFixed(2)}</span>}
        {localRate > 1 && player.current?.kind === "element" && <span className="pill warn">Lecture ×{localRate.toFixed(2)}</span>}
      </div>

      {err && <div className="banner crit">{err}</div>}
      {degraded && (
        <div className="banner crit">
          Mode dégradé : {degraded.mode === "text-only" ? "texte seul, la voix reviendra dès que possible" : degraded.mode}
          {degraded.reason ? ` — ${degraded.reason}` : ""}
        </div>
      )}
      {floorBusyByOther && <div className="banner info">Un apprenant pose une question.</div>}

      <div className="card grid">
        <div className={`stat ${queueClass}`}>
          <b>{(queueMs / 1000).toFixed(1)} s</b>
          <span>d'avance en file</span>
        </div>
        <div className="stat">
          <b>{stats?.e2eP50 != null ? `${(stats.e2eP50 / 1000).toFixed(1)} s` : "—"}</b>
          <span>décalage (salle)</span>
        </div>
        <div className="stat">
          <b>{dropped}</b>
          <span>segments sautés</span>
        </div>
      </div>

      <div className="row">
        <button className="grow" onClick={resync} disabled={queueMs < 300}>
          ⏩ Revenir au direct
        </button>
        <button className="grow" onClick={replay} disabled={!ring.current.length}>
          ↺ Réécouter 30 s
        </button>
      </div>

      <div className="card transcript">
        {lines.length === 0 && !partial && <p className="muted">En attente du formateur…</p>}
        {lines.map((l) => (
          <div className="line" key={l.seq}>
            <div className={`tgt ${l.untranslated ? "untranslated" : ""}`}>{l.tgt ?? "…"}</div>
            {l.src && <div className="src">{l.src}</div>}
          </div>
        ))}
        {partial && <div className="partial">{partial}</div>}
      </div>

      {QuestionRecorder.supported() ? (
        <button
          className={`ptt ${asking ? "active" : ""}`}
          disabled={floorBusyByOther || conn !== "open"}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            void askStart();
          }}
          onPointerUp={() => void askEnd()}
          onPointerCancel={() => void askEnd()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {asking ? "🎙️ Parlez… relâchez pour envoyer" : "🙋 Maintenir pour poser une question"}
        </button>
      ) : (
        <p className="tiny">
          Les questions exigent une connexion sécurisée (HTTPS). Voir docs/DECISIONS.md — certificat sur IP de LAN.
        </p>
      )}
    </main>
  );
}
