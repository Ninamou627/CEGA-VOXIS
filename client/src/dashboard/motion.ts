/**
 * Mouvement de la constellation : l'appareil peut demander moins d'animations, et
 * l'exploitant peut les mettre en pause (la traduction, elle, continue). Le choix de
 * pause est une commodité de l'appareil : il est gardé s'il peut l'être, sans plus.
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";
const KEY = "voxis-motion";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia(QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function useMotionPause(): [boolean, () => void] {
  const [paused, setPaused] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "paused";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setPaused((p) => {
      try {
        if (p) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, "paused");
      } catch {
        /* mémoire indisponible : la pause tient pour la page */
      }
      return !p;
    });
  return [paused, toggle];
}
