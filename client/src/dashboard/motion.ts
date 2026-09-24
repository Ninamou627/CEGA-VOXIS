/**
 * Mouvement de la constellation. Les animations ne se mettent jamais en pause d'elles-mêmes ;
 * seul l'appareil peut demander moins d'animations (réglage d'accessibilité du système).
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

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
