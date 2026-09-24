/**
 * Page apprenant. QR code → langue → « Écouter » → voix + texte. Un seul écran,
 * deux boutons flottants : poser une question (studio par-dessus) et signaler un
 * problème (feuille par le bas). Le lecteur et le WebSocket vivent ici.
 *
 * Tout ce qui touche à la dérive est ici : file mesurée, abandon des segments
 * trop vieux, « revenir au direct », réécoute des 30 dernières secondes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioHeader, FloorState, Lang, ReportKind, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { BIN_MS, envelope } from "../lib/envelope";
import { QuestionRecorder } from "../lib/mic";
import { ElementPlayer, WebAudioPlayer, type Player, type SegmentMeta } from "../lib/player";
import { keepWakeLockAlive, requestWakeLock } from "../lib/wakelock";
import { SalleSocket, type ConnState } from "../lib/ws";
import { ALL_LANGS } from "../ui/langs";
import { Header, type LinkStatus } from "./Header";
import type { Line, PlayerKind, QuestionOutcome } from "./types";
import { Fabs } from "./views/Fabs";
import { Join } from "./views/Join";
import { Listen } from "./views/Listen";
import { ReportSheet } from "./views/ReportSheet";
import { Studio, type StudioPhase } from "./views/Studio";
import { WAVE_BARS, type WaveSample } from "./views/Waveform";

/** Au-delà, on saute le segment plutôt que de dériver (§10 de la revue). */
const MAX_QUEUE_MS = 8000;
const MAX_AGE_MS = 8000;
const REPLAY_WINDOW_MS = 30_000;
/** Une question dure au plus 30 s : au-delà, elle part toute seule. */
const MAX_ASK_MS = 30_000;
/**
 * Le bouton de signalement se montre dès qu'un souci apparaît, s'efface au bout de
 * 20 s et revient toutes les 90 s tant que ça dure : présent, jamais collant.
 */
const ALERT_SHOW_MS = 20_000;
const ALERT_EVERY_MS = 90_000;
/** Au-delà, le décalage ne s'explique plus par le fonctionnement normal (D7). */
const TROUBLE_E2E_MS = 4000;
const TROUBLE_QUEUE_MS = 5000;

type Hello = Extract<ServerEvent, { t: "hello" }>;
type AskStatus = "idle" | "sending" | "done" | "failed";

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
  /** Ce qui est ouvert par-dessus l'écoute : rien, le studio, la feuille de signalement. */
  const [sheet, setSheet] = useState<"none" | "ask" | "report">("none");
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
  const [askPaused, setAskPaused] = useState(false);
  const [askMs, setAskMs] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [lastQuestion, setLastQuestion] = useState<QuestionOutcome>();
  const [processedMs, setProcessedMs] = useState<number>();
  const [err, setErr] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(100);
  const [showText, setShowText] = useState(true);
  const [localRate, setLocalRate] = useState(1);
  const [alert, setAlert] = useState<string>();
  const [reportSent, setReportSent] = useState(false);
  /** Passage figé à l'ouverture de la feuille : on signale ce qu'on a entendu, pas la suite. */
  const [reportOn, setReportOn] = useState<{ seq?: number; src?: string; tgt?: string; e2eMs: number | null }>();

  const sock = useRef<SalleSocket>(undefined);
  const player = useRef<Player>(undefined);
  const clockOffset = useRef(0);
  const ring = useRef<{ bytes: Uint8Array; mime: string; meta: SegmentMeta }[]>([]);
  /** Enveloppes d'amplitude par segment, pour l'onde qui suit la voix. */
  const envelopes = useRef(new Map<number, Float32Array>());
  const recorder = useRef<QuestionRecorder>(undefined);
  const serverSpeed = useRef(1);
  // Lus depuis les rappels du WebSocket et du lecteur, qui ne voient pas l'état React.
  const helloRef = useRef<Hello>(undefined);
  const askStatusRef = useRef<AskStatus>("idle");
  const askingRef = useRef(false);
  const pausedRef = useRef(false);
  const mutedRef = useRef(false);
  // Chrono de la question : temps effectivement enregistré, pauses exclues.
  const askClock = useRef<{ accumMs: number; since: number | null }>({ accumMs: 0, since: null });
  const askSentAt = useRef(0);
  const troubleRef = useRef<string>(undefined);
  /** L'apprenant a réglé son volume : le réglage de l'administration ne l'écrase plus. */
  const volumeTouched = useRef(false);
  const reportTimer = useRef<number>(undefined);

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

  useEffect(() => {
    if (!asking) return;
    let level = 0;
    const id = setInterval(() => {
      const ms = askElapsed();
      setAskMs(ms);
      level = level * 0.6 + (recorder.current?.level() ?? 0) * 0.4; // lissé, sinon l'anneau tremble
      setMicLevel(level);
      if (ms >= MAX_ASK_MS) void askEnd();
    }, 100);
    return () => clearInterval(id);
  }, [asking]);

  // Ce qui, vu du téléphone, dit que la traduction ne va pas. Le libellé est celui
  // que l'apprenant lira sur le bouton : on ne lui demande pas de deviner.
  const trouble =
    degraded?.mode === "text-only" || degraded?.mode === "stt-lost"
      ? "La voix s'est arrêtée — signalez-le"
      : queueMs > TROUBLE_QUEUE_MS || (stats?.e2eP50 ?? 0) > TROUBLE_E2E_MS
        ? "La traduction a du retard — signalez-le"
        : lines[lines.length - 1]?.untranslated
          ? "Un passage n'a pas été traduit"
          : dropped > 0 && queueMs > TROUBLE_QUEUE_MS / 2
            ? "Des passages ont été sautés"
            : undefined;

  useEffect(() => {
    troubleRef.current = trouble;
    setAlert(trouble);
  }, [trouble]);

  useEffect(() => {
    if (!alert) return;
    const id = setTimeout(() => setAlert(undefined), ALERT_SHOW_MS);
    return () => clearTimeout(id);
  }, [alert]);

  useEffect(() => {
    const id = setInterval(() => {
      if (troubleRef.current) setAlert(troubleRef.current);
    }, ALERT_EVERY_MS);
    return () => clearInterval(id);
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
        applyDefaultVolume(e.settings.listenerVolume);
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
          setProcessedMs(askSentAt.current ? Date.now() - askSentAt.current : undefined);
          setAsk("done");
        }
        break;
      case "stats":
        setStats(e.stats);
        serverSpeed.current = e.stats.pipeline.speed;
        break;
      case "settings":
        applyDefaultVolume(e.settings.listenerVolume);
        break;
      case "degraded":
        // Un changement de moteur (secours) ne regarde pas l'apprenant ; une voix absente, si.
        setDegraded(e.mode === "none" || e.mode.startsWith("backup-") ? undefined : { mode: e.mode, reason: e.reason });
        break;
      case "error":
        setErr(e.msg);
        if (e.code === "floor_busy") askDiscard();
        if (e.code === "question_failed") setAsk("failed");
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
    envelope(bytes)
      .then((env) => {
        const m = envelopes.current;
        m.set(h.seq, env);
        while (m.size > 40) m.delete(m.keys().next().value!); // les plus anciennes d'abord
      })
      .catch(() => {}); // sans enveloppe, l'onde pulse simplement
    const r = ring.current;
    r.push({ bytes, mime: h.mime, meta });
    let total = r.reduce((a, x) => a + x.meta.durMs, 0);
    while (r.length > 1 && total > REPLAY_WINDOW_MS) total -= r.shift()!.meta.durMs;
    // En pause, on garde pour la réécoute mais on ne joue pas : à la reprise, on est au direct.
    if (pausedRef.current) return;
    void p.enqueue(bytes, h.mime, meta);
  }

  /** Ce que l'onde doit montrer maintenant : lu à chaque image, sans passer par l'état React. */
  const waveSample = useCallback((): WaveSample => {
    const pl = player.current?.playing;
    if (!pl || pausedRef.current || mutedRef.current) return { kind: "idle" };
    const env = envelopes.current.get(pl.meta.seq);
    if (!env) return { kind: "pulse" };
    // Fenêtre centrée sur la position de lecture : le passé à gauche, la suite à droite.
    const at = Math.floor(pl.elapsedMs / BIN_MS);
    const levels: number[] = [];
    for (let i = 0; i < WAVE_BARS; i++) levels.push(env[at + i - WAVE_BARS / 2] ?? 0);
    return { kind: "levels", levels };
  }, []);

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

  /** Volume de départ choisi dans l'administration, appliqué tant que l'apprenant n'y touche pas. */
  function applyDefaultVolume(v: number) {
    if (volumeTouched.current) return;
    setVolume(v);
    player.current?.setVolume(v / 100);
  }

  function changeVolume(v: number) {
    volumeTouched.current = true;
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

  function askElapsed(): number {
    const c = askClock.current;
    return c.accumMs + (c.since != null ? performance.now() - c.since : 0);
  }

  /** Prend la parole et ouvre le micro. Depuis le PTT (maintenir) comme depuis le studio (toucher). */
  async function askStart() {
    if (askingRef.current || floor.state === "question") return;
    setErr(undefined);
    setLastQuestion(undefined);
    setProcessedMs(undefined);
    setAsk("idle");
    askingRef.current = true;
    setAsking(true);
    setAskPaused(false);
    askClock.current = { accumMs: 0, since: performance.now() };
    setAskMs(0);
    applyMute(); // on ne s'entend pas par-dessus la voix traduite
    sock.current?.send({ t: "ask", phase: "start" });
    const rec = new QuestionRecorder();
    recorder.current = rec;
    try {
      await rec.start();
    } catch (err) {
      setErr("micro indisponible : " + (err as Error).message);
      askDiscard();
    }
  }

  /** Studio : un toucher démarre, le suivant suspend, le suivant reprend. */
  function askToggle() {
    const rec = recorder.current;
    if (!askingRef.current) return void askStart();
    const c = askClock.current;
    if (rec?.state === "paused") {
      rec.resume();
      c.since = performance.now();
      setAskPaused(false);
    } else if (rec) {
      rec.pause();
      if (c.since != null) c.accumMs += performance.now() - c.since;
      c.since = null;
      setAskPaused(true);
    }
  }

  /** Ferme le micro et rend la parole sans rien envoyer. */
  function askDiscard() {
    recorder.current?.cancel();
    recorder.current = undefined;
    askingRef.current = false;
    setAsking(false);
    setAskPaused(false);
    askClock.current = { accumMs: 0, since: null };
    setAskMs(0);
    sock.current?.send({ t: "ask", phase: "end" });
    applyMute();
  }

  /** Question écrite : pas de micro, pas de tour de parole — elle ne coupe personne. */
  function askText(text: string) {
    if (conn !== "open") return setErr("hors ligne : la question n'a pas pu partir");
    setErr(undefined);
    setLastQuestion(undefined);
    setProcessedMs(undefined);
    askSentAt.current = Date.now();
    setAsk("sending");
    sock.current?.send({ t: "ask.text", text });
  }

  /** Signalement de qualité : le serveur y joint l'heure, la phrase et sa traduction. */
  function sendReport(kind: ReportKind) {
    if (conn !== "open") {
      setSheet("none");
      return setErr("hors ligne : le signalement n'a pas pu partir");
    }
    sock.current?.send({ t: "report", kind, seq: reportOn?.seq, e2eMs: reportOn?.e2eMs ?? null });
    setReportSent(true);
    setAlert(undefined);
    clearTimeout(reportTimer.current);
    reportTimer.current = window.setTimeout(() => setSheet("none"), 1800);
  }

  /** Ferme le micro et envoie la question en un bloc. */
  async function askEnd() {
    if (!askingRef.current) return;
    askingRef.current = false;
    setAsking(false);
    setAskPaused(false);
    const rec = recorder.current;
    recorder.current = undefined;
    const blob = rec ? await rec.stop() : new Blob([]);
    if (blob.size) {
      sock.current?.sendBinary(await blob.arrayBuffer());
      askSentAt.current = Date.now();
      setAsk("sending");
    }
    sock.current?.send({ t: "ask", phase: "end", mime: rec?.mime });
    applyMute();
  }

  // ---------------------------------------------------------------------------

  if (phase === "join") {
    return (
      <>
        <Header kind="brand" session={session} status={{ tone: "wait", badge: "READY", caption: "Prêt à écouter" }} />
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
  const studioPhase: StudioPhase = asking ? (askPaused ? "paused" : "recording") : askStatus;
  // Le studio est un écran plein : flèche retour dans l'en-tête, pas de boutons flottants.
  const studio = sheet === "ask";
  const last = lines[lines.length - 1];
  const micSupported = QuestionRecorder.supported();

  return (
    <>
      {studio ? (
        <Header kind="page" title="Poser une question" subtitle="VOXIS ACTIVE FEED" onBack={() => setSheet("none")} />
      ) : (
        <Header kind="brand" session={session} status={LINK[conn]} />
      )}
      <main className={`flex flex-col relative w-full pt-16 bg-surface min-h-screen gap-space-md ${studio ? "" : "pb-40"}`}>
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

        {!studio && (
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
            waveSample={waveSample}
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
            question={{ supported: micSupported, asking, busy: floorBusyByOther, status: askStatus, last: lastQuestion }}
          />
        )}
        {studio && (
          <Studio
            srcLang={hello?.srcLang ?? "en"}
            lang={lang}
            live={conn === "open"}
            supported={micSupported}
            busy={floorBusyByOther}
            phase={studioPhase}
            ms={askMs}
            maxMs={MAX_ASK_MS}
            level={micLevel}
            last={lastQuestion}
            processedMs={processedMs}
            onMic={askToggle}
            onSend={() => void askEnd()}
            onSendText={askText}
            onCancel={askDiscard}
            onBack={() => setSheet("none")}
          />
        )}
      </main>

      {!studio && (
        <Fabs
          askDisabled={conn !== "open"}
          askHint={
            !micSupported
              ? "Écrivez : le micro exige une connexion sécurisée"
              : floorBusyByOther
                ? "Un apprenant parle — vous pouvez écrire"
                : "Parlez ou écrivez, c'est traduit pour le formateur"
          }
          alert={Boolean(alert)}
          alertLabel={alert}
          onAsk={() => setSheet("ask")}
          onReport={() => {
            setReportSent(false);
            setReportOn({ seq: last?.seq, src: last?.src, tgt: last?.tgt, e2eMs: stats?.e2eP50 ?? null });
            setSheet("report");
          }}
        />
      )}

      <ReportSheet
        open={sheet === "report"}
        context={reportOn}
        sent={reportSent}
        onSend={sendReport}
        onClose={() => setSheet("none")}
      />
    </>
  );
}
