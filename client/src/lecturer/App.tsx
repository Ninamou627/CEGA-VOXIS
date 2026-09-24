/**
 * Poste formateur (maquette « Formateur Control Hub »), ouvert dans Chrome sur le PC
 * de la salle. Capture le micro HF, l'envoie en PCM au serveur local, montre ce que
 * la salle entend, joue les questions traduites dans le casque (fermé !) du formateur.
 *
 * Deux niveaux sont affichés : celui capté ici, et celui reçu par le serveur. S'ils
 * divergent, le problème est réseau ; si les deux sont bas, c'est le micro.
 */
import { useEffect, useRef, useState } from "react";
import type { AudioHeader, ClientSettings, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { listMics, startMic, type MicHandle } from "../lib/mic";
import { WebAudioPlayer } from "../lib/player";
import { SalleSocket, type ConnState } from "../lib/ws";
import { Header } from "./Header";
import type { Line, QuestionItem } from "./types";
import { AudioPanel } from "./views/AudioPanel";
import { Join } from "./views/Join";
import { Questions } from "./views/Questions";
import { TranslationHub } from "./views/TranslationHub";
import { VocalStage, WAVE_BARS } from "./views/VocalStage";

type Hello = Extract<ServerEvent, { t: "hello" }>;

/** Niveau RMS local au-delà duquel on considère que le formateur parle. */
const SPEAK_LEVEL = 0.06;
/** La parole reste « détectée » ce temps après la dernière trame forte : pas de clignotement entre deux mots. */
const SPEAK_HOLD_MS = 700;
/** Après le premier clic sur « Terminer », le second doit arriver dans ce délai. */
const STOP_ARM_MS = 4000;

export function App() {
  const params = new URLSearchParams(location.search);
  const [token, setToken] = useState(params.get("token") ?? "");
  const [running, setRunning] = useState(false);
  const [conn, setConn] = useState<ConnState>("closed");
  const [hello, setHello] = useState<Hello>();
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [muted, setMuted] = useState(false);
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [stats, setStats] = useState<StatsPayload>();
  const [err, setErr] = useState<string>();
  const [degraded, setDegraded] = useState<string>();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(localStorage.getItem("salle.mic") ?? "");
  const [aec, setAec] = useState<boolean>(localStorage.getItem("salle.aec") !== "off");
  const [micLabel, setMicLabel] = useState<string>();
  const [sampleRate, setSampleRate] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [stopArmed, setStopArmed] = useState(false);
  /** Réglages de l'administration : gain du micro, seuil de parole, alerte de silence. */
  const [roomSettings, setRoomSettings] = useState<ClientSettings>({ listenerVolume: 100, inputGainDb: 0, speechThresholdDb: -35, silenceAlertS: 20 });
  /** Question en cours de lecture dans le casque, pour la barre de progression de sa carte. */
  const [playingQ, setPlayingQ] = useState<{ n: number; startedAt: number; durMs: number }>();

  const sock = useRef<SalleSocket>(undefined);
  const mic = useRef<MicHandle>(undefined);
  const player = useRef<WebAudioPlayer>(undefined);
  const clockOffset = useRef(0);
  const startedAt = useRef(0);
  const historyRef = useRef<number[]>([]);
  const speakUntil = useRef(0);
  const questionSeq = useRef(0);
  const questionsRef = useRef<QuestionItem[]>([]);
  const mutedRef = useRef(false);
  const gainRef = useRef(0);
  const stopTimer = useRef<number>(undefined);
  const playingTimer = useRef<number>(undefined);

  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);

  useEffect(() => {
    void listMics().then(setMics);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(id);
      stop();
    };
  }, []);

  // Barre Espace = muet, comme sur une console : sauf quand on tape ou qu'on vise un bouton.
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      e.preventDefault();
      toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  async function openMic(id: string, echoCancellation = aec) {
    mic.current?.stop();
    const m = await startMic(
      (frame, lvl) => {
        setLevel(lvl);
        if (lvl > SPEAK_LEVEL) speakUntil.current = performance.now() + SPEAK_HOLD_MS;
        setSpeaking(performance.now() < speakUntil.current);
        const h = historyRef.current;
        h.push(lvl);
        if (h.length > WAVE_BARS) h.splice(0, h.length - WAVE_BARS);
        setHistory([...h]);
        if (frame.byteLength) sock.current?.sendBinary(frame);
      },
      { deviceId: id || undefined, echoCancellation },
    );
    mic.current = m;
    m.setMuted(mutedRef.current);
    m.setGainDb(gainRef.current);
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
      // Le son d'une question porte son rang (seq) : la carte sait qu'elle joue, et jusqu'à quand.
      p.onStart = (meta) => {
        setPlayingQ({ n: meta.seq, startedAt: performance.now(), durMs: meta.durMs });
        clearTimeout(playingTimer.current);
        playingTimer.current = window.setTimeout(() => setPlayingQ(undefined), meta.durMs + 150);
      };
      player.current = p;

      await openMic(deviceId);

      const s = new SalleSocket(
        { t: "join", role: "lecturer", token, sampleRate: mic.current!.sampleRate, ua: navigator.userAgent.slice(0, 200) },
        { onState: setConn, onEvent: handleEvent, onAudio: handleAudio },
      );
      sock.current = s;
      s.connect();
      startedAt.current = Date.now();
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
    clearTimeout(playingTimer.current);
    setPlayingQ(undefined);
    historyRef.current = [];
    setHistory([]);
    setRunning(false);
    setStopArmed(false);
    setLevel(0);
    setSpeaking(false);
  }

  /** « Terminer la session » en deux clics : le premier arme, le second dans les 4 s arrête. */
  function requestStop() {
    if (stopArmed) {
      clearTimeout(stopTimer.current);
      stop();
      return;
    }
    setStopArmed(true);
    stopTimer.current = window.setTimeout(() => setStopArmed(false), STOP_ARM_MS);
  }

  function toggleMute() {
    const m = !mutedRef.current;
    mutedRef.current = m;
    setMuted(m);
    mic.current?.setMuted(m);
    sock.current?.send({ t: "lecturer.mute", muted: m });
  }

  function changeDevice(id: string) {
    setDeviceId(id);
    localStorage.setItem("salle.mic", id);
    if (running) void openMic(id).catch((e) => setErr((e as Error).message));
  }

  function changeAec(on: boolean) {
    setAec(on);
    localStorage.setItem("salle.aec", on ? "on" : "off");
    if (running) void openMic(deviceId, on).catch((e) => setErr((e as Error).message));
  }

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        setHello(e);
        setFloor(e.floor);
        applySettings(e.settings);
        setDegraded(e.pipeline.degraded === "none" ? undefined : e.pipeline.degraded);
        break;
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text, tOrigin: e.tOrigin, reason: e.reason });
        break;
      case "tr.segment":
        upsert(e.seq, { tgt: e.text });
        break;
      case "floor":
        setFloor(e.floor);
        break;
      case "question":
        setQuestions((prev) =>
          [...prev, { n: ++questionSeq.current, who: e.who, srcLang: e.srcLang, srcText: e.srcText, lang: e.lang, text: e.text, at: Date.now(), mode: e.mode }].slice(-30),
        );
        break;
      case "stats":
        setStats(e.stats);
        break;
      case "settings":
        applySettings(e.settings);
        break;
      case "degraded":
        setDegraded(e.mode === "none" ? undefined : `${e.mode} — ${e.reason}`);
        break;
      case "error":
        setErr(e.msg);
        break;
    }
  }

  /** Le son d'une question arrive après son texte : on le range avec elle, et on le joue. */
  function handleAudio(h: AudioHeader, bytes: Uint8Array) {
    if (h.kind !== "question") return;
    const audio = { bytes: bytes.slice(), mime: h.mime, durMs: h.durMs };
    const qs = questionsRef.current;
    let target = qs[qs.length - 1];
    for (let i = qs.length - 1; i >= 0; i--) {
      if (!qs[i].audio && qs[i].text === h.text) {
        target = qs[i];
        break;
      }
    }
    if (target) setQuestions((prev) => prev.map((q) => (q.n === target.n ? { ...q, audio } : q)));
    if (h.autoplay === false) return; // question écrite : elle attend « Écouter »
    void player.current?.enqueue(audio.bytes, h.mime, { seq: target?.n ?? 0, tOrigin: h.tOrigin, durMs: h.durMs, text: h.text, lang: h.lang, replay: true });
  }

  function replay(q: QuestionItem) {
    const p = player.current;
    if (!p || !q.audio) return;
    p.flush();
    void p.enqueue(q.audio.bytes, q.audio.mime, { seq: q.n, tOrigin: Date.now(), durMs: q.audio.durMs, text: q.text, lang: q.lang, replay: true });
  }

  /** L'administration a changé un réglage : le gain s'applique au micro ouvert, sans le rouvrir. */
  function applySettings(s: ClientSettings) {
    gainRef.current = s.inputGainDb;
    mic.current?.setGainDb(s.inputGainDb);
    setRoomSettings(s);
  }

  function upsert(seq: number, patch: Partial<Line>) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.seq === seq);
      const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, ...patch } : l)) : [...prev, { seq, ...patch }];
      return next.slice(-8);
    });
  }

  // ---------------------------------------------------------------------------

  const serverDb = stats?.micDb ?? null;
  const silentS = stats?.micSilentS ?? null;
  // 20 s sans parole : au-delà d'une pause normale de formateur, en deçà du doute.
  const serverSilent = running && !muted && serverDb != null && serverDb < roomSettings.speechThresholdDb && (silentS ?? 0) >= roomSettings.silenceAlertS;
  const srcLang: Lang = hello?.srcLang ?? "en";
  const tgtLang: Lang = hello?.langs[0] ?? "fr";
  const asking = floor.state === "question";

  return (
    <>
      <Header
        running={running}
        conn={conn}
        elapsedS={running ? (now - startedAt.current) / 1000 : 0}
        micLabel={micLabel}
        muted={muted}
        serverDb={serverDb}
        listeners={stats?.listeners}
        srcLang={srcLang}
        stopArmed={stopArmed}
        onStop={requestStop}
      />
      <main className="flex-1 w-full max-w-[1780px] mx-auto p-4 md:p-6 lg:p-7 flex flex-col gap-5">
        {(err || degraded || serverSilent) && (
          <div className="flex flex-col gap-2">
            {err && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm" role="alert">
                {err}
              </div>
            )}
            {degraded && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm" role="alert">
                Mode dégradé : {degraded}
              </div>
            )}
            {serverSilent && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm" role="alert">
                Le serveur reçoit du silence ({serverDb} dB depuis {silentS} s). Ce n'est pas le bon micro, ou son niveau est trop bas : choisissez-en un
                autre dans le panneau audio, et vérifiez le niveau d'entrée dans Windows.
              </div>
            )}
          </div>
        )}

        {!running ? (
          <Join token={token} onToken={setToken} mics={mics} deviceId={deviceId} onDevice={changeDevice} aec={aec} onAec={changeAec} onStart={() => void start()} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
            <AudioPanel
              mics={mics}
              deviceId={deviceId}
              onDevice={changeDevice}
              aec={aec}
              onAec={changeAec}
              level={level}
              speechDb={roomSettings.speechThresholdDb}
              gainDb={roomSettings.inputGainDb}
              serverDb={serverDb}
              sampleRate={sampleRate}
              muted={muted}
              onMute={toggleMute}
              stats={stats}
              degraded={degraded}
            />
            <div className="lg:col-span-6 flex flex-col gap-4">
              <VocalStage
                muted={muted}
                speaking={speaking}
                question={asking}
                history={history}
                serverDb={serverDb}
                sampleRate={sampleRate}
                e2eP50={stats?.e2eP50 ?? null}
                queueMaxMs={stats?.queueMaxMs ?? null}
              />
              <TranslationHub lines={lines} partial={partial} srcLang={srcLang} tgtLang={tgtLang} stats={stats} degraded={degraded} clockOffset={clockOffset.current} />
            </div>
            <div className="lg:col-span-3 flex flex-col gap-4">
              <Questions
                questions={questions}
                asking={asking}
                now={now}
                playing={playingQ}
                onReplay={replay}
                onArchive={(q) => setQuestions((prev) => prev.map((x) => (x.n === q.n ? { ...x, archived: true } : x)))}
              />
            </div>
          </div>
        )}
      </main>
    </>
  );
}
