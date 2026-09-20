/**
 * L'onde de l'écran d'écoute (12 barres de la maquette). Trois régimes :
 *   - « levels » : elle suit la voix entendue — fenêtre de 12 tranches de 50 ms de
 *     l'enveloppe du segment en cours, centrée sur la position de lecture, qui défile ;
 *   - « pulse »  : de l'audio joue mais son enveloppe n'est pas (encore) connue,
 *     pulsation CSS de la maquette ;
 *   - « idle »   : rien ne joue, barres repliées.
 * Les hauteurs sont écrites directement dans le DOM à ~25 i/s, sans re-rendu React.
 */
import { useEffect, useRef, useState } from "react";

export type WaveSample = { kind: "idle" } | { kind: "pulse" } | { kind: "levels"; levels: number[] };

export const WAVE_BARS = 12;

const COLOR = ["bg-secondary", "bg-secondary-fixed", "bg-secondary", "bg-primary", "bg-secondary", "bg-secondary-fixed", "bg-primary", "bg-secondary", "bg-secondary-fixed", "bg-primary", "bg-secondary", "bg-secondary-fixed"];
const GLOW = [
  "",
  "",
  "shadow-sm",
  "shadow-[0_0_12px_rgba(78,222,163,0.5)]",
  "shadow-sm",
  "shadow-[0_0_14px_rgba(180,197,255,0.6)]",
  "shadow-sm",
  "shadow-[0_0_12px_rgba(78,222,163,0.5)]",
  "",
  "shadow-sm",
  "",
  "",
];
/** Pulsation CSS de la maquette, barre par barre. */
const PULSE = [
  "h-8 opacity-70 animate-[pulse_1.2s_ease-in-out_infinite]",
  "h-14 opacity-80 animate-[pulse_0.9s_ease-in-out_infinite_0.1s]",
  "h-20 animate-[pulse_1.4s_ease-in-out_infinite_0.2s]",
  "h-28 animate-[pulse_1.1s_ease-in-out_infinite_0.15s]",
  "h-24 animate-[pulse_0.8s_ease-in-out_infinite_0.3s]",
  "h-32 animate-[pulse_1.3s_ease-in-out_infinite_0.05s]",
  "h-20 animate-[pulse_1.0s_ease-in-out_infinite_0.25s]",
  "h-28 animate-[pulse_0.85s_ease-in-out_infinite_0.18s]",
  "h-16 animate-[pulse_1.25s_ease-in-out_infinite_0.4s]",
  "h-24 animate-[pulse_1.1s_ease-in-out_infinite_0.12s]",
  "h-12 opacity-80 animate-[pulse_0.95s_ease-in-out_infinite_0.32s]",
  "h-6 opacity-60 animate-[pulse_1.3s_ease-in-out_infinite_0.22s]",
];

export function Waveform({ sample }: { sample: () => WaveSample }) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const [mode, setMode] = useState<WaveSample["kind"]>("idle");

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 40) return;
      last = t;
      const s = sample();
      setMode((m) => (m === s.kind ? m : s.kind));
      bars.current.forEach((el, i) => {
        if (!el) return;
        el.style.height = s.kind === "levels" ? `${Math.round(6 + Math.min(1, s.levels[i] ?? 0) * 122)}px` : "";
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sample]);

  return (
    <div className="relative z-10 w-full h-32 flex items-center justify-center gap-1 px-space-xs my-space-xs" aria-hidden="true">
      {COLOR.map((color, i) => (
        <div
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className={`w-1.5 rounded-full ${color} ${
            mode === "levels"
              ? `transition-[height] duration-75 ease-out ${GLOW[i]}`
              : mode === "pulse"
                ? `transition-all duration-500 ${PULSE[i]} ${GLOW[i]}`
                : "transition-all duration-500 h-1.5 opacity-30"
          }`}
        />
      ))}
    </div>
  );
}
