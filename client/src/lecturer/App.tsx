/**
 * Page formateur, ouverte dans Chrome sur le PC de la salle. Capture le micro HF,
 * l'envoie en PCM au serveur local, affiche ce que la salle entend, joue les
 * questions traduites dans le casque (fermé !) du formateur.
 *
 * Deux niveaux sont affichés : celui capté ici, et celui reçu par le serveur. S'ils
 * divergent, le problème est réseau ; si les deux sont bas, c'est le micro.
 */
import { useEffect, useRef, useState } from "react";
import type { AudioHeader, FloorState, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { listMics, startMic, type MicHandle } from "../lib/mic";
import { WebAudioPlayer } from "../lib/player";
import { SalleSocket, type ConnState } from "../lib/ws";

interface Line {
  seq: number;
  src?: string;
  tgt?: string;
}

const SPEECH_DB = -35;

export function App() {
  const params = new URLSearchParams(location.search);
  const [token, setToken] = useState(params.get("token") ?? "");
  const [running, setRunning] = useState(false);
  const [conn, setConn] = useState<ConnState>("closed");
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [question, setQuestion] = useState<{ srcText: string; text: string }>();
  const [stats, setStats] = useState<StatsPayload>();
  const [err, setErr] = useState<string>();
  const [degraded, setDegraded] = useState<string>();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(localStorage.getItem("salle.mic") ?? "");
  const [aec, setAec] = useState<boolean>(localStorage.getItem("salle.aec") !== "off");
  const [micLabel, setMicLabel] = useState<string>("");
  const [sampleRate, setSampleRate] = useState<number>();

  const sock = useRef<SalleSocket>(undefined);
  const mic = useRef<MicHandle>(undefined);
  const player = useRef<WebAudioPlayer>(undefined);

  useEffect(() => {
    void listMics().then(setMics);
    return () => stop();
  }, []);

  async function openMic(id: string, echoCancellation = aec) {
    mic.current?.stop();
    const m = await startMic(
      (frame, lvl) => {
        setLevel(lvl);
        if (frame.byteLength) sock.current?.sendBinary(frame);
      },
      { deviceId: id || undefined, echoCancellation },
    );
    mic.current = m;
    m.setMuted(muted);
    setMicLabel(m.label);
    setSampleRate(m.sampleRate);
    setDeviceId(m.deviceId);
    localStorage.setItem("salle.mic", m.deviceId);
    // Après l'autorisation, les libellés des micros deviennent visibles.
    setMics(await listMics());
  }

  async function start() {
    setErr(undefined);
    try {
      const p = new WebAudioPlayer();
      await p.unlock();
      player.current = p;

      await openMic(deviceId);

      const s = new SalleSocket(
        { t: "join", role: "lecturer", token, sampleRate: mic.current!.sampleRate, ua: navigator.userAgent.slice(0, 200) },
        {
          onState: setConn,
          onEvent: handleEvent,
          onAudio: (h: AudioHeader, bytes) => {
            if (h.kind !== "question") return;
            setQuestion({ srcText: "", text: h.text });
            void p.enqueue(bytes, h.mime, { seq: 0, tOrigin: h.tOrigin, durMs: h.durMs, text: h.text, lang: h.lang, replay: true });
          },
        },
      );
      sock.current = s;
      s.connect();
      setRunning(true);
    } catch (e) {
      setErr((e as Error).message);
      stop();
    }
  }

  function stop() {
    mic.current?.stop();
    mic.current = undefined;
    sock.current?.close();
    sock.current = undefined;
    player.current?.destroy();
    player.current = undefined;
    setRunning(false);
    setLevel(0);
  }

  function toggleMute() {
    const m = !muted;
    setMuted(m);
    mic.current?.setMuted(m);
    sock.current?.send({ t: "lecturer.mute", muted: m });
  }

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text });
        break;
      case "tr.segment":
        upsert(e.seq, { tgt: e.text });
        break;
      case "floor":
        setFloor(e.floor);
        break;
      case "question":
        setQuestion({ srcText: e.srcText, text: e.text });
        break;
      case "stats":
        setStats(e.stats);
        break;
      case "degraded":
        setDegraded(e.mode === "none" ? undefined : `${e.mode} — ${e.reason}`);
        break;
      case "error":
        setErr(e.msg);
        break;
    }
  }

  function upsert(seq: number, patch: Partial<Line>) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.seq === seq);
      const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, ...patch } : l)) : [...prev, { seq, ...patch }];
      return next.slice(-8);
    });
  }

  const connPill = conn === "open" ? "ok" : conn === "closed" ? "crit" : "warn";
  const serverDb = stats?.micDb ?? null;
  const silentS = stats?.micSilentS ?? null;
  // 20 s sans parole : au-delà d'une pause normale de formateur, en deçà du doute.
  const serverSilent = running && !muted && serverDb != null && serverDb < SPEECH_DB && (silentS ?? 0) >= 20;

  const micSelect = (
    <>
      <label>
        Micro
        <select
          value={deviceId}
          onChange={(e) => {
            const id = e.target.value;
            setDeviceId(id);
            localStorage.setItem("salle.mic", id);
            if (running) void openMic(id).catch((err) => setErr((err as Error).message));
          }}
        >
          <option value="">Par défaut du système</option>
          {mics.map((m, i) => (
            <option key={m.deviceId || i} value={m.deviceId}>
              {m.label || `Micro ${i + 1} (autorisez le micro pour voir le nom)`}
            </option>
          ))}
        </select>
      </label>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={aec}
          onChange={(e) => {
            const on = e.target.checked;
            setAec(on);
            localStorage.setItem("salle.aec", on ? "on" : "off");
            if (running) void openMic(deviceId, on).catch((err) => setErr((err as Error).message));
          }}
        />
        <span>
          Annulation d'écho — <span className="tiny">obligatoire si la traduction sort des haut-parleurs de ce PC (test sur une seule machine)</span>
        </span>
      </label>
    </>
  );

  return (
    <main className="app">
      <div className="row">
        <h1 className="grow">Formateur</h1>
        {running && <span className={`pill ${connPill}`}>{conn === "open" ? "Connecté" : conn}</span>}
        {stats && (
          <span className="pill">
            {stats.listeners} à l'écoute · {stats.pipeline.stt} / {stats.pipeline.mt} / {stats.pipeline.tts}
          </span>
        )}
      </div>

      {err && <div className="banner crit">{err}</div>}
      {degraded && <div className="banner crit">Mode dégradé : {degraded}</div>}
      {serverSilent && (
        <div className="banner crit">
          Le serveur reçoit du silence ({serverDb} dB depuis {silentS} s). Ce n'est pas le bon micro, ou son niveau est trop bas : choisissez-en un autre
          ci-dessous, et vérifiez le niveau d'entrée dans Windows.
        </div>
      )}

      {!running ? (
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <label>
            Jeton de session
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="SESSION_TOKEN du .env" />
          </label>
          {micSelect}
          <button className="primary big" onClick={() => void start()} disabled={!token}>
            🎙️ Démarrer le micro
          </button>
          <p className="tiny">
            Chrome recommandé. Casque fermé obligatoire : un casque ouvert à côté d'un micro ouvert, c'est un larsen.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ display: "grid", gap: 10 }}>
            <div className="meter">
              <div style={{ width: `${Math.round(level * 100)}%`, background: muted ? "var(--ink-3)" : undefined }} />
            </div>
            <div className="row">
              <button className={`grow ${muted ? "primary" : ""}`} onClick={toggleMute}>
                {muted ? "🔇 MUET — reprendre" : "🔴 En direct — couper le micro"}
              </button>
              <button onClick={stop}>Arrêter</button>
            </div>
            {micSelect}
            <p className="tiny">
              {micLabel} · {sampleRate} Hz · niveau ici {Math.round(level * 100)} % · reçu par le serveur{" "}
              <b className={serverDb != null && serverDb > SPEECH_DB ? "" : "mono"}>{serverDb != null ? `${serverDb} dB` : "—"}</b>
              {" · "}
              {floor.state === "question" ? "un apprenant pose une question" : "vous avez la parole"}
              {stats?.e2eP50 != null && ` · décalage salle ${(stats.e2eP50 / 1000).toFixed(1)} s`}
              {stats?.queueMaxMs != null && ` · file max ${(stats.queueMaxMs / 1000).toFixed(1)} s`}
            </p>
          </div>

          {question && (
            <div className="card">
              <h2>Dernière question</h2>
              <p style={{ fontWeight: 600 }}>{question.text}</p>
              {question.srcText && <p className="tiny">{question.srcText}</p>}
            </div>
          )}

          <div className="card transcript">
            <h2>Ce que la salle entend</h2>
            {lines.map((l) => (
              <div className="line" key={l.seq}>
                <div className="src">{l.src}</div>
                <div className="tgt">{l.tgt ?? "…"}</div>
              </div>
            ))}
            {partial && <div className="partial">{partial}</div>}
            {!lines.length && !partial && <p className="muted">Parlez : la transcription apparaît ici.</p>}
          </div>
        </>
      )}
    </main>
  );
}
