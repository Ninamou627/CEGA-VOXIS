/**
 * Écran de salle : les sous-titres en gros caractères pour le projecteur — l'accès
 * pour les malentendants, et l'assurance pour ceux dont le téléphone est à plat.
 * Avant la séance, le QR code en grand ; pendant, les traductions au fur et à mesure,
 * les questions des apprenants en bandeau. Rôle « screen » : tout le texte, jamais
 * d'audio, pas de jeton. Réglages (langue, source, taille, QR) mémorisés sur le PC.
 */
import { APP_NAME } from "../ui/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { keepWakeLockAlive, requestWakeLock } from "../lib/wakelock";
import { SalleSocket, type ConnState } from "../lib/ws";
import { Icon } from "../ui/Icon";
import { LANGS } from "../ui/langs";
import { Qr } from "../ui/Qr";
import type { Line, Prefs, RoomQuestion } from "./types";
import { Captions } from "./views/Captions";
import { Controls } from "./views/Controls";
import { Idle } from "./views/Idle";

type Hello = Extract<ServerEvent, { t: "hello" }>;

const PREFS_KEY = "salle.screen";
/** Une question reste affichée ce temps, le temps que le formateur y réponde. */
const QUESTION_MS = 45_000;
/** La barre de réglages s'efface après ce délai sans souris ni clavier. */
const CONTROLS_MS = 3000;

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { lang: p.lang, source: p.source ?? false, qr: p.qr ?? true, scale: Math.min(1.6, Math.max(0.7, p.scale ?? 1)) };
  } catch {
    return { source: false, qr: true, scale: 1 };
  }
}

export function App() {
  const params = new URLSearchParams(location.search);
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const p = loadPrefs();
    const fromUrl = params.get("lang") as Lang | null;
    return fromUrl ? { ...p, lang: fromUrl } : p;
  });
  const [conn, setConn] = useState<ConnState>("closed");
  const [hello, setHello] = useState<Hello>();
  const [joinUrl, setJoinUrl] = useState<string>();
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [question, setQuestion] = useState<RoomQuestion>();
  const [stats, setStats] = useState<StatsPayload>();
  const [lecturer, setLecturer] = useState(false);
  const [degraded, setDegraded] = useState<string>();
  const [controls, setControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const hideTimer = useRef<number>(undefined);
  const questionTimer = useRef<number>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* mémoire indisponible : les réglages tiennent pour la page */
    }
  }, [prefs]);

  // Adresse à projeter dans le QR code, puis présence du formateur toutes les 5 s.
  useEffect(() => {
    let stop = false;
    const session = async () => {
      try {
        const r = await fetch("/api/session");
        if (r.ok) setJoinUrl(((await r.json()) as { joinUrl: string }).joinUrl);
        else throw new Error();
      } catch {
        if (!stop) window.setTimeout(session, 5000);
      }
    };
    const health = async () => {
      try {
        const r = await fetch("/api/health");
        if (r.ok && !stop) setLecturer(((await r.json()) as { lecturer: boolean }).lecturer);
      } catch {
        /* le WebSocket dira si la salle est là */
      }
    };
    void session();
    void health();
    const id = setInterval(health, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const s = new SalleSocket({ t: "join", role: "screen" }, { onState: setConn, onAudio: () => {}, onEvent: handleEvent });
    s.connect();
    void requestWakeLock(); // le PC de projection ne doit pas éteindre son écran
    const stopWake = keepWakeLockAlive();
    return () => {
      s.close();
      stopWake();
    };
  }, []);

  // La barre de réglages et le curseur ne vivent que quelques secondes après un geste.
  useEffect(() => {
    const wake = () => {
      setControls(true);
      clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setControls(false), CONTROLS_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("touchstart", wake);
    window.addEventListener("keydown", wake);
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  const langs: Lang[] = hello?.langs ?? ["fr"];
  const lang: Lang = prefs.lang && langs.includes(prefs.lang) ? prefs.lang : langs[0];
  const srcLang: Lang = hello?.srcLang ?? "en";

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  // Raccourcis : F plein écran, S source, Q QR, + / − taille, L langue suivante.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key.toLowerCase()) {
        case "f":
          toggleFullscreen();
          break;
        case "s":
          setPrefs((p) => ({ ...p, source: !p.source }));
          break;
        case "q":
          setPrefs((p) => ({ ...p, qr: !p.qr }));
          break;
        case "+":
        case "=":
          setPrefs((p) => ({ ...p, scale: Math.min(1.6, Math.round((p.scale + 0.1) * 10) / 10) }));
          break;
        case "-":
          setPrefs((p) => ({ ...p, scale: Math.max(0.7, Math.round((p.scale - 0.1) * 10) / 10) }));
          break;
        case "l":
          if (langs.length > 1) setPrefs((p) => ({ ...p, lang: langs[(langs.indexOf(lang) + 1) % langs.length] }));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [langs, lang, toggleFullscreen]);

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        setHello(e);
        setFloor(e.floor);
        setDegraded(e.pipeline.degraded === "text-only" ? "Voix indisponible : la traduction continue à l'écrit" : undefined);
        break;
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        setLines((prev) => {
          const i = prev.findIndex((l) => l.seq === e.seq);
          const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, src: e.text } : l)) : [...prev, { seq: e.seq, src: e.text, tgt: {} }];
          return next.slice(-12);
        });
        break;
      case "tr.segment":
        setLines((prev) => {
          const i = prev.findIndex((l) => l.seq === e.seq);
          const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, tgt: { ...l.tgt, [e.lang]: e.text } } : l)) : [...prev, { seq: e.seq, tgt: { [e.lang]: e.text } }];
          return next.slice(-12);
        });
        break;
      case "floor":
        setFloor(e.floor);
        break;
      case "question":
        if (!e.srcText) break; // rien de compris : rien à projeter
        setQuestion({ at: Date.now(), srcLang: e.srcLang, srcText: e.srcText, lang: e.lang, text: e.text });
        clearTimeout(questionTimer.current);
        questionTimer.current = window.setTimeout(() => setQuestion(undefined), QUESTION_MS);
        break;
      case "stats":
        setStats(e.stats);
        break;
      case "degraded":
        setDegraded(e.mode === "text-only" ? "Voix indisponible : la traduction continue à l'écrit" : undefined);
        break;
    }
  }

  const idle = lines.every((l) => !l.tgt[lang]);
  const live = conn === "open";

  return (
    <div className={`relative w-screen h-screen overflow-hidden bg-surface text-on-surface ${controls ? "" : "cursor-none"}`} style={{ ["--cap" as string]: prefs.scale }}>
      {/* Marque et état, discrets en haut à gauche */}
      <div className="absolute top-[3vh] left-[3vw] z-30 flex items-center gap-[0.8vw] opacity-80" style={{ fontSize: "clamp(12px, 1.1vw, 20px)" }}>
        <Icon name="graphic_eq" className="text-secondary" style={{ fontSize: "1.6em" }} />
        <span className="font-headline-md font-bold tracking-tight">{APP_NAME}</span>
        <span key={live ? "live" : conn} className={`pop flex items-center gap-[0.4em] font-label-badge uppercase tracking-wider ${live ? "text-secondary" : conn === "closed" ? "text-error" : "text-tertiary"}`}>
          <span className={`w-[0.55em] h-[0.55em] rounded-full ${live ? "bg-secondary animate-pulse" : conn === "closed" ? "bg-error" : "bg-tertiary animate-pulse"}`}></span>
          {live ? "Direct" : conn === "closed" ? "Hors ligne" : "Connexion"}
        </span>
      </div>

      {/* QR en coin pendant la séance */}
      {!idle && prefs.qr && joinUrl && (
        <div className="absolute top-[3vh] right-[3vw] z-30 flex flex-col items-center gap-[0.8vh] rise-in">
          <Qr value={joinUrl} size={400} className="w-[min(16vh,14vw)]" />
          <span className="text-on-surface-variant text-center max-w-[16vw]" style={{ fontSize: "clamp(10px, 0.9vw, 16px)" }}>
            Scannez pour écouter dans votre langue
          </span>
        </div>
      )}

      {/* Bandeaux : question en cours, question reçue, voix absente */}
      <div className="absolute top-[3vh] inset-x-0 z-20 flex flex-col items-center gap-[1.2vh] px-[20vw] pointer-events-none">
        {floor.state === "question" && (
          <div key="asking" className="pop flex items-center gap-[0.6em] px-[1.2em] py-[0.5em] rounded-full bg-tertiary/15 border border-tertiary/40 text-tertiary font-headline-sm font-bold" style={{ fontSize: "clamp(12px, 1.3vw, 24px)" }}>
            <Icon name="front_hand" style={{ fontSize: "1.2em" }} />
            Un apprenant pose une question…
          </div>
        )}
        {question && (
          <div key={question.at} className="rise-in max-w-[62vw] bg-surface-container-high/95 border border-tertiary/40 rounded-2xl px-[2vw] py-[1.6vh] shadow-xl flex flex-col items-center gap-[0.8vh] text-center backdrop-blur">
            <span className="flex items-center gap-[0.5em] font-label-badge uppercase tracking-wider text-tertiary" style={{ fontSize: "clamp(11px, 1vw, 18px)" }}>
              <Icon name="contact_support" style={{ fontSize: "1.3em" }} />
              Question d'un apprenant {LANGS[question.srcLang].flag}
            </span>
            <p className="text-on-surface font-medium leading-snug text-balance" style={{ fontSize: "calc(var(--cap) * clamp(20px, 2.4vw, 44px))" }}>
              « {question.srcText} »
            </p>
            {prefs.source && question.lang !== question.srcLang && (
              <p className="text-on-surface-variant italic leading-snug text-balance" style={{ fontSize: "calc(var(--cap) * clamp(14px, 1.5vw, 28px))" }}>
                “{question.text}”
              </p>
            )}
          </div>
        )}
        {degraded && (
          <div key="degraded" className="pop flex items-center gap-[0.6em] px-[1.2em] py-[0.5em] rounded-full bg-error/10 border border-error/30 text-error font-headline-sm font-bold" style={{ fontSize: "clamp(12px, 1.1vw, 20px)" }}>
            <Icon name="voice_over_off" style={{ fontSize: "1.2em" }} />
            {degraded}
          </div>
        )}
      </div>

      {idle ? (
        <Idle joinUrl={joinUrl} srcLang={srcLang} langs={langs} lecturer={lecturer} speaking={Boolean(partial) || lines.length > 0} />
      ) : (
        <Captions lines={lines} lang={lang} showSource={prefs.source} partial={partial} />
      )}

      {/* Repères discrets en bas à gauche quand la barre est effacée */}
      {!controls && !idle && (
        <div className="absolute bottom-[2.5vh] left-[3vw] z-10 font-metric-mono-sm text-on-surface-variant/60" style={{ fontSize: "clamp(10px, 0.9vw, 16px)" }}>
          {LANGS[lang].flag} {LANGS[lang].label}
          {stats ? ` · ${stats.listeners} à l'écoute` : ""}
        </div>
      )}

      <Controls
        visible={controls}
        prefs={prefs}
        lang={lang}
        srcLang={srcLang}
        langs={langs}
        fullscreen={fullscreen}
        listeners={stats?.listeners}
        e2eMs={stats?.e2eP50}
        onLang={(l) => setPrefs((p) => ({ ...p, lang: l }))}
        onToggleSource={() => setPrefs((p) => ({ ...p, source: !p.source }))}
        onToggleQr={() => setPrefs((p) => ({ ...p, qr: !p.qr }))}
        onScale={(d) => setPrefs((p) => ({ ...p, scale: Math.min(1.6, Math.max(0.7, Math.round((p.scale + d) * 10) / 10)) }))}
        onFullscreen={toggleFullscreen}
      />
    </div>
  );
}
