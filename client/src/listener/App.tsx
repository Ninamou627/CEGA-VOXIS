/**
 * Page apprenant. QR code → langue → « Écouter » → voix + texte, puis les vues
 * (écoute, transcription, questions, canaux) par la barre du bas — le lecteur et
 * le WebSocket vivent ici et survivent aux changements de vue.
 *
 * Tout ce qui touche à la dérive est ici : file mesurée, abandon des segments
 * trop vieux, « revenir au direct », réécoute des 30 dernières secondes.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { AudioHeader, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { QuestionRecorder } from "../lib/mic";
import { ElementPlayer, WebAudioPlayer, type Player, type SegmentMeta } from "../lib/player";
import { keepWakeLockAlive, requestWakeLock } from "../lib/wakelock";
import { SalleSocket, type ConnState } from "../lib/ws";
import { ALL_LANGS } from "../ui/langs";
import { BottomNav, type View } from "./BottomNav";
import { Header, type LinkStatus } from "./Header";
import type { Line, PlayerKind, QuestionOutcome } from "./types";
import { Join } from "./views/Join";
import { Listen } from "./views/Listen";
import { Soon } from "./views/Soon";

/** Au-delà, on saute le segment plutôt que de dériver (§10 de la revue). */
const MAX_QUEUE_MS = 8000;
const MAX_AGE_MS = 8000;
const REPLAY_WINDOW_MS = 30_000;

type Hello = Extract<ServerEvent, { t: "hello" }>;
type AskStatus = "idle" | "sending" | "done";

const LINK: Record<ConnState, LinkStatus> = {
  open: { tone: "live", badge: "LIVE", caption: "Live Audio Stream" },
  connecting: { tone: "wait", badge: "SYNC", caption: "Connexion…" },
  reconnecting: { tone: "wait", badge: "SYNC", caption: "Reconnexion…" },
  closed: { tone: "off", badge: "OFF", caption: "Hors ligne" },
};

export function App() {
  const params = new URLSearchParams(location.search);
  const [session] = useState(params.get("s") ?? "TRAINING-01");
  const [lang, setLang] = useState<Lang>((params.get("lang") as Lang) ?? "fr");
  // Lecteur média par défaut, partout : validé sur iPhone 13 Pro Max / iOS 26 écran
  // verrouillé, insensible au bouton silence, et il porte le playbackRate à hauteur
  // préservée. Web Audio reste disponible pour comparer sur ordinateur.
  const [playerKind, setPlayerKind] = useState<PlayerKind>("element");
  const [phase, setPhase] = useState<"join" | "live">("join");
  const [view, setView] = useState<View>("listen");
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
  const [askStatus, setAskStatus] = useState<AskStatus>("idle");
  const [lastQuestion, setLastQuestion] = useState<QuestionOutcome>();
  const [err, setErr] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [showText, setShowText] = useState(true);
  const [localRate, setLocalRate] = useState(1);

  const sock = useRef<SalleSocket>(undefined);
  const player = useRef<Player>(undefined);
  const clockOffset = useRef(0);
  const ring = useRef<{ bytes: Uint8Array; mime: string; meta: SegmentMeta }[]>([]);
  const recorder = useRef<QuestionRecorder>(undefined);
  const serverSpeed = useRef(1);
  // Lus depuis les rappels du WebSocket et du lecteur, qui ne voient pas l'état React.
  const helloRef = useRef<Hello>(undefined);
  const askStatusRef = useRef<AskStatus>("idle");
  const askingRef = useRef(false);
  const pausedRef = useRef(false);
  const mutedRef = useRef(false);

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
    // Écran maintenu allumé pendant l'écoute (le lecteur média joue même écran verrouillé).
    const stop = keepWakeLockAlive();
    return () => {
      clearInterval(id);
      stop();
    };
  }, []);

  /** Ouvre le WebSocket de salle ; un ancien socket qu'on ferme ne parle plus à l'écran. */
  function connect(l: Lang) {
    const s: SalleSocket = new SalleSocket(
      { t: "join", role: "listener", session, lang: l, ua: navigator.userAgent.slice(0, 200) },
      {
        onState: (st) => sock.current === s && setConn(st),
        onEvent: (e) => sock.current === s && handleEvent(e),
        onAudio: (h, b) => sock.current === s && handleAudio(h, b),
      },
    );
    sock.current = s;
    s.connect();
  }

  async function start() {
    setErr(undefined);
    const p: Player = playerKind === "element" ? new ElementPlayer() : new WebAudioPlayer();
    await p.unlock(); // dans le geste utilisateur, obligatoire sur mobile
    p.onStart = (meta) => {
      if (meta.replay) return;
      sock.current?.send({ t: "ack", seq: meta.seq, tOrigin: meta.tOrigin, queueMs: p.queueMs });
    };
    p.setVolume(volume / 100);
    player.current = p;
    void requestWakeLock();
    connect(lang);
    setPhase("live");
  }

  /** Changer de langue en séance : on rejoint la salle avec la nouvelle langue, au direct. */
  function changeLang(l: Lang) {
    if (l === lang) return;
    setLang(l);
    player.current?.flush();
    ring.current = [];
    setLines([]);
    setPartial("");
    sock.current?.close();
    connect(l);
  }

  function setAsk(status: AskStatus) {
    askStatusRef.current = status;
    setAskStatus(status);
  }

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        helloRef.current = e;
        setHello(e);
        setFloor(e.floor);
        setDegraded(e.pipeline.degraded === "none" ? undefined : { mode: e.pipeline.degraded, reason: "" });
        break;
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text, tOrigin: e.tOrigin });
        break;
      case "tr.segment":
        upsert(e.seq, { tgt: e.text, untranslated: e.untranslated });
        break;
      case "floor":
        setFloor(e.floor);
        break;
      case "question":
        if (e.who === helloRef.current?.participantId || askStatusRef.current === "sending") {
          setLastQuestion({ srcText: e.srcText, text: e.text, delivered: e.delivered });
          setAsk("done");
        }
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
          askingRef.current = false;
          setAsking(false);
          applyMute();
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
    if (!pausedRef.current && (p.queueMs > MAX_QUEUE_MS || age > MAX_AGE_MS)) {
      setDropped((d) => d + 1);
      return;
    }
    const meta: SegmentMeta = { seq: h.seq, tOrigin: h.tOrigin, durMs: h.durMs, text: h.text, lang: h.lang };
    const r = ring.current;
    r.push({ bytes, mime: h.mime, meta });
    let total = r.reduce((a, x) => a + x.meta.durMs, 0);
    while (r.length > 1 && total > REPLAY_WINDOW_MS) total -= r.shift()!.meta.durMs;
    // En pause, on garde pour la réécoute mais on ne joue pas : à la reprise, on est au direct.
    if (pausedRef.current) return;
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

  /** Pause = on cesse d'écouter et on jette ce qui attend ; reprise = au direct, sans retard. */
  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) resync();
  }

  /** Le silence effectif : celui choisi par l'apprenant, ou le temps de sa question. */
  function applyMute() {
    player.current?.setMuted(mutedRef.current || askingRef.current);
  }

  function toggleMute() {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    applyMute();
  }

  function changeVolume(v: number) {
    setVolume(v);
    player.current?.setVolume(v / 100);
    if (v === 0 && !mutedRef.current) {
      mutedRef.current = true;
      setMuted(true);
    } else if (v > 0 && mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
    }
    applyMute();
  }

  async function askStart(e: PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (askingRef.current || floor.state === "question") return;
    setErr(undefined);
    setLastQuestion(undefined);
    setAsk("idle");
    askingRef.current = true;
    setAsking(true);
    applyMute(); // on ne s'entend pas par-dessus la voix traduite
    sock.current?.send({ t: "ask", phase: "start" });
    const rec = new QuestionRecorder();
    recorder.current = rec;
    try {
      await rec.start();
    } catch (err) {
      setErr("micro indisponible : " + (err as Error).message);
      sock.current?.send({ t: "ask", phase: "end" });
      askingRef.current = false;
      setAsking(false);
      applyMute();
    }
  }

  async function askEnd() {
    if (!askingRef.current) return;
    askingRef.current = false;
    setAsking(false);
    const rec = recorder.current;
    recorder.current = undefined;
    const blob = rec ? await rec.stop() : new Blob([]);
    if (blob.size) {
      sock.current?.sendBinary(await blob.arrayBuffer());
      setAsk("sending");
    }
    sock.current?.send({ t: "ask", phase: "end", mime: rec?.mime });
    applyMute();
  }

  // ---------------------------------------------------------------------------

  if (phase === "join") {
    return (
      <>
        <Header session={session} status={{ tone: "wait", badge: "READY", caption: "Prêt à écouter" }} />
        <main className="flex flex-col relative w-full pt-16 pb-8 bg-surface min-h-screen">
          <Join
            session={session}
            lang={lang}
            onLang={setLang}
            playerKind={playerKind}
            onPlayerKind={setPlayerKind}
            onStart={() => void start()}
            error={err}
          />
        </main>
      </>
    );
  }

  const floorBusyByOther = floor.state === "question" && floor.who !== hello?.participantId;
  const rate = Math.round(serverSpeed.current * localRate * 100) / 100;

  return (
    <>
      <Header session={session} status={LINK[conn]} />
      <main className="flex flex-col relative w-full pt-16 pb-24 bg-surface min-h-screen gap-space-md">
        {(err || degraded) && (
          <div className="flex flex-col gap-space-xs px-gutter-mobile pt-space-xs">
            {err && (
              <div className="bg-error-container text-on-error-container rounded-xl px-space-md py-space-sm font-body-sm text-body-sm" role="alert">
                {err}
              </div>
            )}
            {degraded && (
              <div className="bg-error-container text-on-error-container rounded-xl px-space-md py-space-sm font-body-sm text-body-sm" role="alert">
                Mode dégradé : {degraded.mode === "text-only" ? "texte seul, la voix reviendra dès que possible" : degraded.mode}
                {degraded.reason ? ` — ${degraded.reason}` : ""}
              </div>
            )}
          </div>
        )}

        {view === "listen" && (
          <Listen
            session={session}
            conn={conn}
            secure={location.protocol === "https:"}
            playerKind={playerKind}
            srcLang={hello?.srcLang ?? "en"}
            lang={lang}
            langs={hello?.langs ?? ALL_LANGS}
            onLang={changeLang}
            degraded={degraded?.mode}
            audio={{ paused, muted, volume, playing: queueMs > 0, queueMs, dropped, e2eMs: stats?.e2eP50 ?? null, rate }}
            onPause={togglePause}
            onMute={toggleMute}
            onVolume={changeVolume}
            onResync={resync}
            lines={lines}
            partial={partial}
            clockOffset={clockOffset.current}
            showText={showText}
            onToggleText={() => setShowText((s) => !s)}
            canReplay={ring.current.length > 0}
            onReplay={replay}
            question={{ supported: QuestionRecorder.supported(), asking, busy: floorBusyByOther, status: askStatus, last: lastQuestion }}
            onAskStart={(e) => void askStart(e)}
            onAskEnd={() => void askEnd()}
          />
        )}
        {view === "transcript" && <Soon icon="subtitles" title="Transcript" />}
        {view === "questions" && <Soon icon="live_help" title="Ask Q&A" />}
        {view === "channels" && <Soon icon="tune" title="Channels" />}
      </main>
      <BottomNav view={view} onChange={setView} />
    </>
  );
}
