/**
 * Scène vocale (centre, haut) : le micro qui capte, l'état de parole et l'onde.
 * L'onde n'est pas décorative : chaque barre est le niveau d'une trame de 100 ms,
 * les 36 dernières, qui défilent de droite à gauche.
 */
import { delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";

export const WAVE_BARS = 36;

export interface VocalStageProps {
  muted: boolean;
  speaking: boolean;
  /** Un apprenant pose une question : le micro du formateur est en pause côté serveur. */
  question: boolean;
  /** Niveaux des dernières trames, 0 à 1, le plus récent en dernier. */
  history: number[];
  serverDb: number | null;
  sampleRate?: number;
  e2eP50: number | null;
  queueMaxMs: number | null;
}

export function VocalStage(p: VocalStageProps) {
  const active = p.speaking && !p.muted && !p.question;
  const status = p.muted
    ? { text: "MICRO COUPÉ • LA SALLE N'ENTEND RIEN", cls: "text-error font-bold", dot: "bg-error" }
    : p.question
      ? { text: "QUESTION D'UN APPRENANT • MICRO EN PAUSE", cls: "text-tertiary font-bold", dot: "bg-tertiary animate-pulse" }
      : active
        ? { text: "PAROLE DÉTECTÉE • MICRO CAPTE LA VOIX", cls: "text-secondary font-bold", dot: "bg-secondary animate-ping" }
        : { text: "SILENCE DÉTECTÉ • EN ATTENTE DE PAROLE", cls: "text-outline font-medium", dot: "bg-outline-variant" };
  const chip = p.muted
    ? { icon: "mic_off", label: "Micro coupé", cls: "bg-error/10 border-error/40 text-error" }
    : active
      ? { icon: "record_voice_over", label: "En train de parler", cls: "bg-secondary/15 border-secondary/40 text-secondary" }
      : { icon: "mic_none", label: "Micro au repos", cls: "bg-surface-container border-outline-variant/40 text-outline" };
  const bars = [...Array(Math.max(0, WAVE_BARS - p.history.length)).fill(0), ...p.history.slice(-WAVE_BARS)];

  return (
    <div
      className={`bg-surface-container-lowest border rounded-2xl p-5 shadow-xl flex flex-col gap-4 relative overflow-hidden transition-all duration-300 ${
        active ? "border-secondary/35" : "border-outline-variant/25"
      }`}
    >
      <div className="absolute -top-16 -right-16 w-56 h-56 bg-secondary/10 rounded-full blur-3xl pointer-events-none transition-all duration-500" style={{ opacity: active ? 1 : 0.15 }}></div>

      <div className="flex flex-wrap items-center justify-between gap-2.5 relative z-10">
        <div className="flex items-center gap-3">
          {/* Le micro et ses anneaux acoustiques */}
          <div className="relative flex items-center justify-center w-10 h-10 shrink-0">
            {active && (
              <>
                <div className="mic-ring-1 absolute inset-0 rounded-full border-2 border-secondary/60 pointer-events-none"></div>
                <div className="mic-ring-2 absolute -inset-2 rounded-full border border-secondary/40 pointer-events-none"></div>
              </>
            )}
            <div
              className={`relative z-10 w-9 h-9 rounded-full bg-gradient-to-tr from-secondary-container to-secondary flex items-center justify-center text-on-secondary shadow-md transition-all ${
                active ? "mic-glowing-badge" : "opacity-60"
              }`}
            >
              <Icon name={p.muted ? "mic_off" : "mic"} className="text-[20px]" />
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h2 className="font-headline-sm text-sm font-bold text-on-surface">Spectre vocal en direct — Formateur</h2>
              <span className="font-label-badge text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                {p.sampleRate ? `PCM ${p.sampleRate / 1000} kHz` : "PCM"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`inline-block w-2 h-2 rounded-full ${status.dot}`}></span>
              <span className={`font-metric-mono-sm text-[11px] tracking-tight ${status.cls}`} role="status">
                {status.text}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden sm:flex flex-col items-end text-xs font-metric-mono-sm">
            <span className="text-on-surface-variant text-[11px]">
              Niveau reçu : <strong className={`font-bold ${p.serverDb != null && p.serverDb > -35 ? "text-secondary" : "text-on-surface-variant"}`}>{p.serverDb != null ? `${p.serverDb} dB` : "—"}</strong>
            </span>
            <span className="text-[10px] text-secondary/80 flex items-center gap-1">
              <Icon name="sensors" className="text-[12px]" /> Flux voix {p.muted ? "coupé" : "actif"}
              {p.sampleRate ? ` (${p.sampleRate / 1000} kHz)` : ""}
            </span>
          </div>
          <span key={chip.label} className={`pop flex items-center gap-1.5 border px-3 py-1.5 rounded-xl text-xs font-headline-sm font-bold shadow-sm ${chip.cls}`}>
            <Icon name={chip.icon} className="text-[16px]" />
            <span>{chip.label}</span>
          </span>
        </div>
      </div>

      {/* L'onde : 36 trames de 100 ms */}
      <div className="relative h-28 w-full bg-surface-container-low/80 border border-secondary/30 rounded-xl px-4 py-3 flex items-center justify-between gap-1 overflow-hidden shadow-inner" aria-hidden="true">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:18px_18px] pointer-events-none opacity-40"></div>
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-secondary/20 border-t border-dashed border-secondary/30 pointer-events-none"></div>
        {bars.map((v, i) => {
          const bright = i % 6 === 4;
          return (
            <div
              key={i}
              className={`waveform-bar w-1.5 rounded-full ${
                p.muted ? "bg-outline/50" : bright ? "bg-secondary-fixed shadow-[0_0_12px_rgba(78,222,163,0.55)]" : v > 0.02 ? "bg-secondary" : "bg-secondary/60"
              }`}
              style={{ height: `${Math.round(6 + Math.min(1, v) * 80)}px` }}
            ></div>
          );
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-on-surface-variant font-metric-mono-sm">
        <span className={`flex items-center gap-1.5 font-medium ${active ? "text-secondary" : "text-outline"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-secondary animate-pulse" : "bg-outline"}`}></span>
          {active ? "Captation micro dynamique" : "Micro au repos"}
          {p.e2eP50 != null ? ` • décalage salle ${delay(p.e2eP50)}` : " • décalage salle en attente de mesure"}
          {p.queueMaxMs != null ? ` • file max ${delay(p.queueMaxMs)}` : ""}
        </span>
        <span className="flex items-center gap-1.5">
          <Icon name="graphic_eq" className="text-[14px] text-secondary" />
          <span>16 bits mono</span>
        </span>
      </div>
    </div>
  );
}
