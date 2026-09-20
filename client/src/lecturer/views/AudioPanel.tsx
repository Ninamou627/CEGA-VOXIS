/**
 * Colonne de gauche : entrées audio (micro, niveaux, écho, muet) et état du pipeline.
 * Deux niveaux sont affichés : celui capté ici et celui reçu par le serveur. S'ils
 * divergent, le problème est réseau ; si les deux sont bas, c'est le micro.
 */
import type { StatsPayload } from "../../../../shared/protocol";
import { delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { MicSelect, type MicSelectProps } from "./MicSelect";

/** En deçà, le serveur considère qu'il ne reçoit pas de parole. */
export const SPEECH_DB = -35;
const FLOOR_DB = -60;

export interface AudioPanelProps extends MicSelectProps {
  /** Niveau capté ici, 0 à 1. */
  level: number;
  serverDb: number | null;
  sampleRate?: number;
  muted: boolean;
  onMute: () => void;
  stats?: StatsPayload;
  degraded?: string;
}

function Meter({ value, tone }: { value: number; tone: "secondary" | "tertiary" | "error" | "outline" }) {
  const fill = { secondary: "bg-secondary", tertiary: "bg-tertiary", error: "bg-error", outline: "bg-outline" }[tone];
  return (
    <div className="w-full h-1.5 bg-surface-container-highest rounded-lg overflow-hidden">
      <div className={`h-full rounded-lg transition-[width] duration-100 ${fill}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

function Tile({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-surface-container-low rounded-xl p-2.5 border border-outline-variant/20 flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] text-on-surface-variant font-medium uppercase tracking-wider truncate">{label}</span>
      <span className={`font-metric-mono-sm text-sm font-bold truncate ${tone || "text-on-surface"}`} title={value}>
        {value}
      </span>
    </div>
  );
}

export function AudioPanel(p: AudioPanelProps) {
  const db = p.serverDb;
  const serverRatio = db == null ? 0 : (db - FLOOR_DB) / -FLOOR_DB;
  const serverTone = db == null ? "outline" : db > -3 ? "error" : db > SPEECH_DB ? "secondary" : "tertiary";
  const pl = p.stats?.pipeline;
  return (
    <div className="lg:col-span-3 flex flex-col gap-4">
      {/* Entrées audio */}
      <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex flex-col gap-3.5 relative overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-secondary/15 flex items-center justify-center text-secondary">
              <Icon name="tune" className="text-[17px]" />
            </div>
            <span className="font-headline-sm text-xs font-bold uppercase tracking-wider text-on-surface">Studio Audio I/O</span>
          </div>
          <span className="flex items-center gap-1 text-[11px] font-metric-mono-sm text-secondary bg-secondary/10 px-2 py-1 rounded-lg border border-secondary/20" title="Fréquence d'échantillonnage envoyée au serveur">
            <Icon name="graphic_eq" className="text-[14px]" />
            <span>{p.sampleRate ? `${p.sampleRate / 1000} kHz` : "—"}</span>
          </span>
        </div>

        <MicSelect mics={p.mics} deviceId={p.deviceId} onDevice={p.onDevice} aec={p.aec} onAec={p.onAec} />

        {/* Niveaux : capté ici, reçu par le serveur */}
        <div className="bg-surface-container-low rounded-xl p-3 border border-outline-variant/20 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-on-surface-variant font-medium">Capté ici</span>
            <span className="font-metric-mono-sm text-secondary font-bold">{Math.round(p.level * 100)} %</span>
          </div>
          <Meter value={p.level} tone={p.muted ? "outline" : "secondary"} />
          <div className="flex items-center justify-between text-xs pt-1">
            <span className="text-on-surface-variant font-medium">Reçu par le serveur</span>
            <span className={`font-metric-mono-sm font-bold ${db == null ? "text-outline" : db > SPEECH_DB ? "text-secondary" : "text-tertiary"}`}>{db != null ? `${db} dB` : "—"}</span>
          </div>
          <Meter value={serverRatio} tone={serverTone} />
          <div className="flex justify-between text-[10px] text-outline font-metric-mono-sm">
            <span>{FLOOR_DB} dB (silence)</span>
            <span className="text-secondary font-semibold">parole &gt; {SPEECH_DB} dB</span>
            <span>0 dB (saturé)</span>
          </div>
        </div>

        {/* Muet */}
        <button
          type="button"
          onClick={p.onMute}
          aria-pressed={p.muted}
          className={`w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-on-surface font-headline-sm text-xs font-semibold transition-all cursor-pointer active:scale-[0.98] ${
            p.muted ? "bg-error-container/30 border-error/40 hover:bg-error-container/40" : "bg-surface-container hover:bg-surface-container-high border-outline-variant/30"
          }`}
        >
          <Icon name={p.muted ? "mic_off" : "mic"} className={`text-[18px] ${p.muted ? "text-error" : "text-secondary"}`} />
          <span>{p.muted ? "Micro coupé (muet) — Espace pour reprendre" : "Microphone en ligne (barre Espace)"}</span>
        </button>
      </div>

      {/* Pipeline IA */}
      <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              <Icon name="memory" className="text-[17px]" />
            </div>
            <span className="font-headline-sm text-xs font-bold uppercase tracking-wider text-on-surface">Pipeline IA</span>
          </div>
          <span
            className={`flex items-center gap-1 text-[10px] font-label-badge font-bold px-2 py-0.5 rounded-full border ${
              p.degraded ? "text-error bg-error/10 border-error/30" : "text-secondary bg-secondary/10 border-secondary/20"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${p.degraded ? "bg-error" : "bg-secondary"}`}></span>
            {p.degraded ? `DÉGRADÉ · ${p.degraded}` : "NOMINAL"}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          {(
            [
              ["Reconnaissance", pl?.stt],
              ["Traduction", pl?.mt],
              ["Voix", pl?.tts],
            ] as const
          ).map(([label, name]) => (
            <div key={label} className="flex items-center justify-between gap-2 bg-surface-container-low rounded-lg px-2.5 py-1.5 border border-outline-variant/20">
              <span className="text-on-surface-variant font-medium shrink-0">{label}</span>
              <span className="font-metric-mono-sm text-[11px] text-on-surface truncate" title={name}>
                {name ?? "—"}
              </span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Décalage p50" value={p.stats?.e2eP50 != null ? delay(p.stats.e2eP50) : "—"} tone={p.stats?.e2eP50 != null && p.stats.e2eP50 > 2500 ? "text-tertiary" : ""} />
          <Tile label="Décalage p95" value={p.stats?.e2eP95 != null ? delay(p.stats.e2eP95) : "—"} />
          <Tile label="File max" value={p.stats?.queueMaxMs != null ? delay(p.stats.queueMaxMs) : "—"} tone={p.stats?.queueMaxMs != null && p.stats.queueMaxMs > 4000 ? "text-tertiary" : ""} />
          <Tile label="En attente" value={pl ? `${pl.backlog} segment${pl.backlog > 1 ? "s" : ""}` : "—"} />
          <Tile label="Vitesse voix" value={pl ? `×${pl.speed.toFixed(2).replace(".", ",")}` : "—"} tone={pl && pl.speed > 1 ? "text-tertiary" : ""} />
          <Tile label="Serveur" value={p.stats ? `${Math.floor(p.stats.uptimeS / 60)} min` : "—"} />
        </div>
      </div>
    </div>
  );
}
