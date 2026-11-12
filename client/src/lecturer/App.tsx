/**
 * Poste formateur (maquette « Formateur Control Hub »), ouvert dans Chrome sur le PC
 * de la salle. Capture le micro HF, l'envoie en PCM au serveur local, montre ce que
 * la salle entend, joue les questions traduites dans le casque (fermé !) du formateur.
 *
 * Deux niveaux sont affichés : celui capté ici, et celui reçu par le serveur. S'ils
 * divergent, le problème est réseau ; si les deux sont bas, c'est le micro.
 */
import { useEffect, useRef, useState } from "react";
import { CAPTURE_ALERT_BELOW } from "../../../shared/capture";
import { MicUplink } from "../../../shared/uplink";
import type { AudioHeader, ClientSettings, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { desktop } from "../lib/desktop";
import { listMics, listOutputs, startMic, type MicHandle } from "../lib/mic";
import { askToNotify, notifyIfUnseen } from "../lib/notify";
import { WebAudioPlayer } from "../lib/player";
import { SalleSocket, type ConnState } from "../lib/ws";
import { Header } from "./Header";
import { CodeGate } from "../ui/CodeGate";
import { Login } from "../ui/Login";
import { whoami, type AccountView } from "../lib/auth";
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
  /** Compte connecté (D17) : undefined = on ne sait pas encore, null = il faut un code ou un compte. */
  const [account, setAccount] = useState<AccountView | null | undefined>();
  const [loginNotice, setLoginNotice] = useState<string>();
  /**
   * Le formateur entre avec un code d'accès (plus simple à confier pour une journée qu'un
   * compte à créer) ; « J'ai un compte » bascule vers l'écran de connexion.
   */
  const [code, setCode] = useState(params.get("c") ?? "");
  const [byAccount, setByAccount] = useState(false);
  const [gateError, setGateError] = useState<string>();
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
  /** Réduction de bruit et gain automatique du navigateur ; les couper est une piste de l'essai F-03 (D38). */
  const [proc, setProc] = useState<boolean>(localStorage.getItem("salle.bruit") !== "off");
  /** Contexte audio à la fréquence native (le worklet convertit) au lieu de 16 kHz (le navigateur convertit). */
  const [native, setNative] = useState<boolean>(localStorage.getItem("salle.natif") === "on");
  /** Sortie du retour audio : le casque du formateur, pas les haut-parleurs de la salle. */
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputId, setOutputId] = useState<string>(localStorage.getItem("salle.sortie") ?? "");
  const [micLabel, setMicLabel] = useState<string>();
  const [sampleRate, setSampleRate] = useState<number>();
  /** Fréquence du contexte audio réellement ouvert (16 kHz ou native), pour l'affichage. */
  const [contextRate, setContextRate] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [stopArmed, setStopArmed] = useState(false);
  /** Réglages de l'administration : gain du micro, seuil de parole, alerte de silence. */
  const [roomSettings, setRoomSettings] = useState<ClientSettings>({ listenerVolume: 100, inputGainDb: 0, speechThresholdDb: -35, silenceAlertS: 20 });
  /** Question en cours de lecture dans le casque, pour la barre de progression de sa carte. */
  const [playingQ, setPlayingQ] = useState<{ n: number; startedAt: number; durMs: number }>();
  /** Part du son du micro que le navigateur perd, quand elle dépasse 5 % (D34). */
  const [captureLoss, setCaptureLoss] = useState<number>();
  const lastCaptureLow = useRef(false);

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
  /**
   * Captation en cours (D37) : son identifiant, et la liaison montante qui numérote les trames,
   * garde les 30 dernières secondes et, à chaque admission, renvoie ce que le serveur n'a pas.
   */
  const captureId = useRef(Math.random().toString(36).slice(2, 12));
  const uplink = useRef<MicUplink>(undefined);
  /** Variante de captation en cours (D38), jointe à chaque relevé : elle attribue les pertes après coup. */
  const captureMode = useRef<string>("");

  useEffect(() => {
    questionsRef.current = questions;
  }, [questions]);

  // Qui est connecté ? Le cookie répond sans rien demander au formateur.
  useEffect(() => {
    void whoami()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    void listMics().then(setMics);
    void listOutputs().then(setOutputs);
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

  // Application de bureau : le même « muet », mais depuis n'importe où — le formateur n'a
  // pas à revenir sur la fenêtre pour tousser ou répondre à quelqu'un dans la salle.
  useEffect(() => {
    if (!running) return;
    return desktop()?.onShortcut((name) => {
      if (name === "toggle-mute") toggleMute();
    });
  }, [running]);

  async function openMic(id: string, echoCancellation = aec, processing = proc, nativeRate = native) {
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
        if (frame.byteLength) uplink.current?.push(new Uint8Array(frame));
      },
      {
        deviceId: id || undefined,
        echoCancellation,
        processing,
        nativeRate,
        onCapture: (ratio) => {
          // L'état de l'onglet et la variante de captation (D38) partent avec le relevé : ils
          // diront, après coup, ce qui faisait perdre du son.
          sock.current?.send({
            t: "lecturer.capture",
            ratio,
            visible: document.visibilityState === "visible",
            focused: document.hasFocus(),
            mode: captureMode.current || undefined,
          });
          // Deux relevés bas de suite (10 s) avant d'alerter : un à-coup isolé ne compte pas.
          const low = ratio < CAPTURE_ALERT_BELOW;
          setCaptureLoss(low && lastCaptureLow.current ? 1 - ratio : undefined);
          lastCaptureLow.current = low;
        },
      },
    );
    mic.current = m;
    captureMode.current = `${nativeRate ? `natif${Math.round(m.contextRate / 1000)}k` : "16k"}${processing ? "" : " brut"}${echoCancellation ? "" : " sans-aec"}`;
    m.setMuted(mutedRef.current);
    m.setGainDb(gainRef.current);
    setMicLabel(m.label);
    setSampleRate(m.sampleRate);
    setContextRate(m.contextRate);
    setDeviceId(m.deviceId);
    localStorage.setItem("salle.mic", m.deviceId);
    // Après l'autorisation, les libellés des périphériques deviennent visibles.
    setMics(await listMics());
    setOutputs(await listOutputs());
  }

  /** Dirige le retour audio vers un autre casque, en séance comme avant de commencer. */
  function changeOutput(id: string) {
    setOutputId(id);
    localStorage.setItem("salle.sortie", id);
    void player.current?.setOutputDevice(id);
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
      void p.setOutputDevice(outputId);
      // Dans le geste de démarrage : c'est le seul moment où un navigateur accepte de demander.
      void askToNotify();

      // Nouvelle captation, avant le micro : ce qui se dit pendant la connexion part à l'admission.
      captureId.current = Math.random().toString(36).slice(2, 12);
      uplink.current = new MicUplink(
        (f) => sock.current?.sendBinary(f),
        () => Date.now() + clockOffset.current,
      );
      await openMic(deviceId);

      const s = new SalleSocket(
        {
          t: "join",
          role: "lecturer",
          code: code || undefined,
          sampleRate: mic.current!.sampleRate,
          capture: captureId.current,
          ua: navigator.userAgent.slice(0, 200),
        },
        {
          onState: (st) => {
            // Socket tombé ou rouvert : les trames attendent la prochaine admission (D37).
            uplink.current?.detach();
            setConn(st);
          },
          onEvent: handleEvent,
          onAudio: handleAudio,
        },
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
    uplink.current = undefined;
    player.current?.destroy();
    player.current = undefined;
    clearTimeout(playingTimer.current);
    setPlayingQ(undefined);
    historyRef.current = [];
    setHistory([]);
    setCaptureLoss(undefined);
    lastCaptureLow.current = false;
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

  /** Essai F-03 (D38) : couper la réduction de bruit et le gain automatique du navigateur. */
  function changeProcessing(on: boolean) {
    setProc(on);
    localStorage.setItem("salle.bruit", on ? "on" : "off");
    if (running) void openMic(deviceId, aec, on).catch((e) => setErr((e as Error).message));
  }

  /** Essai F-03 (D38) : contexte audio à la fréquence native, conversion dans le worklet. */
  function changeNative(on: boolean) {
    setNative(on);
    localStorage.setItem("salle.natif", on ? "on" : "off");
    if (running) void openMic(deviceId, aec, proc, on).catch((e) => setErr((e as Error).message));
  }

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        setHello(e);
        setFloor(e.floor);
        applySettings(e.settings);
        setDegraded(e.pipeline.degraded === "none" ? undefined : e.pipeline.degraded);
        // Admis : ce que le serveur n'a pas de cette captation repart, puis le direct (D37).
        uplink.current?.admit(e.resumeSeq);
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
        // Le formateur a pu passer à ses diapositives : on le prévient hors de la page.
        notifyIfUnseen("Question d'un apprenant", e.srcText || e.text || "Une question vient d'arriver.");
        break;
      case "stats":
        setStats(e.stats);
        uplink.current?.confirm(e.stats.micSeq);
        break;
      case "settings":
        applySettings(e.settings);
        break;
      case "degraded":
        setDegraded(e.mode === "none" ? undefined : `${e.mode} — ${e.reason}`);
        break;
      case "error":
        setErr(e.msg);
        // Session expirée ou code refusé : on redemande de quoi entrer.
        if (e.code === "unauthorized") {
          setLoginNotice("Votre session a expiré. Reconnectez-vous pour reprendre la séance.");
          setByAccount(true);
          setAccount(null);
        }
        if (e.code === "bad_code" || e.code === "too_many") {
          setGateError(e.msg);
          setCode("");
          setAccount(null);
        }
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

  // Tant qu'on ne sait pas : rien, pour ne pas faire clignoter l'écran d'entrée.
  if (account === undefined) return <div className="min-h-dvh bg-surface" />;
  // Ni compte connecté, ni code saisi : on demande le code, avec le compte en repli.
  if (account === null && !code && !byAccount) {
    return (
      <CodeGate
        surface="Poste formateur"
        length={8}
        hint="Saisissez le code formateur que l'administration vous a remis pour cette séance."
        error={gateError}
        onCode={(c) => {
          setCode(c);
          setGateError(undefined);
        }}
        onUseAccount={() => setByAccount(true)}
      />
    );
  }
  if (account === null && byAccount) {
    return <Login surface="Poste formateur" notice={loginNotice} onDone={setAccount} />;
  }

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
        {(err || degraded || serverSilent || (running && captureLoss != null)) && (
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
            {running && captureLoss != null && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm" role="alert">
                Le navigateur perd {Math.round(captureLoss * 100)} % du son du micro avant de l'envoyer : la reconnaissance va manquer des mots. Gardez cet
                onglet visible et au premier plan, branchez le PC sur secteur et désactivez l'économie d'énergie, fermez les applications lourdes.
              </div>
            )}
          </div>
        )}

        {!running ? (
          <Join
            mics={mics}
            deviceId={deviceId}
            onDevice={changeDevice}
            aec={aec}
            onAec={changeAec}
            processing={proc}
            onProcessing={changeProcessing}
            nativeRate={native}
            onNativeRate={changeNative}
            contextRate={contextRate}
            outputs={outputs}
            outputId={outputId}
            onOutput={changeOutput}
            onStart={() => void start()}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
            <AudioPanel
              mics={mics}
              deviceId={deviceId}
              onDevice={changeDevice}
              aec={aec}
              onAec={changeAec}
              processing={proc}
              onProcessing={changeProcessing}
              nativeRate={native}
              onNativeRate={changeNative}
              contextRate={contextRate}
              outputs={outputs}
              outputId={outputId}
              onOutput={changeOutput}
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
