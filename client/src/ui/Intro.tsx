/**
 * Animation d'entrée de CEGA Voxis : la vidéo de marque (public/media/intro.mp4, 8 s), jouée
 * à l'ouverture d'une interface, une fois par onglet, par-dessus l'interface qui se charge
 * dessous. Jamais bloquante : on peut la passer (bouton, Échap), et si elle ne peut pas
 * démarrer vite — réseau lent, lecture automatique refusée, fichier absent — on entre sans elle.
 *
 * Muette : la vidéo n'a pas de son, et un navigateur ne lance seul qu'une vidéo muette.
 * Si l'appareil demande moins d'animations (réglage d'accessibilité du système), elle n'est
 * pas jouée, comme le reste des animations.
 */
import { useEffect, useRef, useState } from "react";
import { APP_NAME } from "./brand";

const SRC = "/media/intro.mp4";
const KEY = "cega-voxis-intro";
/**
 * Où la vidéo s'arrête (secondes). `undefined` : jusqu'au bout. La version actuelle affiche
 * à partir de ~5,5 s une accroche mal orthographiée (« Real-Tine Voice Interqlunation ») :
 * 5.3 l'arrête juste avant, sur le logo formé.
 */
const END_AT_S: number | undefined = undefined;
/** Au-delà, la vidéo n'a pas démarré : on entre sans elle. */
const START_TIMEOUT_MS = 2500;
const FADE_MS = 600;

function alreadySeen(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "vue";
  } catch {
    return false;
  }
}

export function Intro() {
  const [phase, setPhase] = useState<"play" | "fade" | "done">(() =>
    alreadySeen() || matchMedia("(prefers-reduced-motion: reduce)").matches ? "done" : "play",
  );
  const video = useRef<HTMLVideoElement>(null);
  const skip = useRef<HTMLButtonElement>(null);
  const leave = () => setPhase((p) => (p === "play" ? "fade" : p));

  useEffect(() => {
    if (phase !== "play") return;
    try {
      sessionStorage.setItem(KEY, "vue");
    } catch {
      /* navigation privée stricte : l'intro rejouera au prochain chargement, sans plus */
    }
    const v = video.current;
    if (!v) return;
    let late: number | undefined;
    let retry: number | undefined;
    const tryPlay = () => {
      if (!v.paused) return;
      v.play().catch((e: unknown) => {
        const name = e instanceof DOMException ? e.name : "";
        // Lecture automatique refusée par le navigateur : on entre sans l'intro.
        if (name === "NotAllowedError" || name === "NotSupportedError") leave();
        // Interrompue (Chrome met en pause une vidéo sans son dans une page à l'arrière-plan) :
        // elle reprend dès que la page est de nouveau à l'écran.
        else if (document.visibilityState === "visible") retry = window.setTimeout(tryPlay, 400);
      });
    };
    // Le délai de démarrage ne court que page visible : un onglet ouvert en arrière-plan
    // jouera son intro quand on y viendra.
    const watch = () => {
      clearTimeout(late);
      clearTimeout(retry);
      if (document.visibilityState !== "visible") return;
      tryPlay();
      late = window.setTimeout(() => v.currentTime === 0 && leave(), START_TIMEOUT_MS);
    };
    watch();
    document.addEventListener("visibilitychange", watch);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && leave();
    addEventListener("keydown", onKey);
    skip.current?.focus({ preventScroll: true });
    return () => {
      clearTimeout(late);
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", watch);
      removeEventListener("keydown", onKey);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "fade") return;
    video.current?.pause();
    const t = window.setTimeout(() => setPhase("done"), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Animation d'entrée ${APP_NAME}`}
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-[#090d15] transition-opacity ease-out ${phase === "fade" ? "opacity-0 pointer-events-none" : "opacity-100"}`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <video
        ref={video}
        src={SRC}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        onEnded={leave}
        onError={leave}
        onTimeUpdate={(e) => {
          if (END_AT_S != null && e.currentTarget.currentTime >= END_AT_S) leave();
        }}
        className="intro-video"
      />
      <button
        ref={skip}
        type="button"
        onClick={leave}
        className="absolute right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] px-4 py-2 rounded-full border border-white/20 bg-white/10 backdrop-blur-md text-sm font-medium text-white/85 hover:bg-white/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 transition-colors"
      >
        Passer
      </button>
    </div>
  );
}
