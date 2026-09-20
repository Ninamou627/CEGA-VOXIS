/**
 * Texte qui s'écrit caractère par caractère, comme une transcription qui arrive.
 * Immédiat si l'appareil demande moins d'animations. `start` retarde le départ
 * (la traduction attend la fin de l'original).
 */
import { useEffect, useState } from "react";

export function useTypewriter(text: string, { cps = 45, start = true }: { cps?: number; start?: boolean } = {}): { shown: string; done: boolean } {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!start) {
      setCount(0);
      return;
    }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(text.length);
      return;
    }
    let i = 0;
    setCount(0);
    const id = window.setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) clearInterval(id);
    }, 1000 / cps);
    return () => clearInterval(id);
  }, [text, start, cps]);
  const n = Math.min(count, text.length);
  return { shown: text.slice(0, n), done: n >= text.length };
}
