/**
 * Onde décorative de la maquette (12 barres, pulsation CSS). Elle ne mesure rien :
 * elle s'anime quand de l'audio joue, et se replie quand rien ne joue.
 */
const BARS = [
  "bg-secondary h-8 opacity-70 animate-[pulse_1.2s_ease-in-out_infinite]",
  "bg-secondary-fixed h-14 opacity-80 animate-[pulse_0.9s_ease-in-out_infinite_0.1s]",
  "bg-secondary h-20 shadow-sm animate-[pulse_1.4s_ease-in-out_infinite_0.2s]",
  "bg-primary h-28 shadow-[0_0_12px_rgba(78,222,163,0.5)] animate-[pulse_1.1s_ease-in-out_infinite_0.15s]",
  "bg-secondary h-24 shadow-sm animate-[pulse_0.8s_ease-in-out_infinite_0.3s]",
  "bg-secondary-fixed h-32 shadow-[0_0_14px_rgba(180,197,255,0.6)] animate-[pulse_1.3s_ease-in-out_infinite_0.05s]",
  "bg-primary h-20 shadow-sm animate-[pulse_1.0s_ease-in-out_infinite_0.25s]",
  "bg-secondary h-28 shadow-[0_0_12px_rgba(78,222,163,0.5)] animate-[pulse_0.85s_ease-in-out_infinite_0.18s]",
  "bg-secondary-fixed h-16 animate-[pulse_1.25s_ease-in-out_infinite_0.4s]",
  "bg-primary h-24 shadow-sm animate-[pulse_1.1s_ease-in-out_infinite_0.12s]",
  "bg-secondary h-12 opacity-80 animate-[pulse_0.95s_ease-in-out_infinite_0.32s]",
  "bg-secondary-fixed h-6 opacity-60 animate-[pulse_1.3s_ease-in-out_infinite_0.22s]",
];

const IDLE = ["bg-secondary", "bg-secondary-fixed", "bg-secondary", "bg-primary", "bg-secondary", "bg-secondary-fixed", "bg-primary", "bg-secondary", "bg-secondary-fixed", "bg-primary", "bg-secondary", "bg-secondary-fixed"];

export function Waveform({ active }: { active: boolean }) {
  return (
    <div className="relative z-10 w-full h-32 flex items-center justify-center gap-1 px-space-xs my-space-xs" aria-hidden="true">
      {BARS.map((cls, i) => (
        <div key={i} className={`w-1.5 rounded-full transition-all duration-500 ${active ? cls : `${IDLE[i]} h-1.5 opacity-30`}`} />
      ))}
    </div>
  );
}
