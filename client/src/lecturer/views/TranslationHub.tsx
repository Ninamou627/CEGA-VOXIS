/**
 * Centre, bas : ce que la salle entend. Flux 1, la transcription source (segments
 * figés puis l'hypothèse en cours, révisable) ; flux 2, la traduction synthétisée.
 */
import type { Lang, StatsPayload } from "../../../../shared/protocol";
import { clock, delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { Line } from "../types";

export interface TranslationHubProps {
  lines: Line[];
  partial: string;
  srcLang: Lang;
  /** Première langue diffusée dans la salle. */
  tgtLang: Lang;
  stats?: StatsPayload;
  degraded?: string;
  clockOffset: number;
}

/** Règles de coupe du commit verrouillé (server/src/pipeline/commit.ts), en français. */
const REASON: Record<string, string> = {
  punctuation: "ponctuation",
  clause: "proposition",
  maxlen: "longueur max",
  timeout: "délai anti-famine",
  silence: "silence",
  final: "fin de tour",
};

export function TranslationHub(p: TranslationHubProps) {
  const recent = p.lines.slice(-3);
  const last = p.lines[p.lines.length - 1];
  const pl = p.stats?.pipeline;
  return (
    <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
      {/* Flux 1 : source */}
      <div className="bg-surface-container-low border border-outline-variant/20 rounded-xl p-4 flex flex-col gap-2 relative">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full bg-primary shrink-0 ${p.partial ? "animate-pulse" : "opacity-50"}`}></span>
            <span className="font-label-badge text-xs font-bold text-primary uppercase tracking-wider truncate">
              Transcription source en direct ({LANGS[p.srcLang].short})
            </span>
          </div>
          <span className="text-[11px] font-metric-mono-sm text-outline truncate max-w-[45%]" title={pl?.stt}>
            {pl?.stt ?? "—"}
          </span>
        </div>
        <p className="font-body-transcript-lg text-lg text-on-surface leading-relaxed pt-1 min-h-[3.5rem]">
          {recent.length === 0 && !p.partial && <span className="text-on-surface-variant">Parlez : la transcription apparaît ici.</span>}
          {recent.map((l) => (
            <span key={l.seq}>{l.src} </span>
          ))}
          {p.partial && <span className="text-primary/80 italic">{p.partial}</span>}
        </p>
        <div className="flex items-center justify-between pt-2 border-t border-outline-variant/15 text-xs text-on-surface-variant font-metric-mono-sm">
          <span className="flex items-center gap-1.5 text-secondary">
            <Icon name="done_all" className="text-[15px]" />
            {last?.reason ? `coupe : ${REASON[last.reason] ?? last.reason}` : "commit verrouillé"}
          </span>
          <span>{last ? `Segment #${last.seq}${last.tOrigin != null ? ` • ${clock(last.tOrigin, p.clockOffset)}` : ""}` : "—"}</span>
        </div>
      </div>

      {/* Flux 2 : traduction synthétisée */}
      <div className="bg-surface-container-high/90 border border-secondary/30 rounded-xl p-4 flex flex-col gap-2 relative shadow-md">
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-secondary rounded-l-xl"></div>
        <div className="flex flex-wrap items-center justify-between gap-2 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full bg-secondary shrink-0"></span>
            <span className="font-label-badge text-xs font-bold text-secondary uppercase tracking-wider truncate">Traduction IA synthétisée ({LANGS[p.tgtLang].label})</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-label-badge bg-surface-container px-2 py-0.5 rounded text-on-surface-variant truncate max-w-[200px]" title={pl?.tts}>
              TTS : {pl?.tts ?? "—"}
            </span>
            <span className="text-[11px] font-metric-mono-sm text-secondary bg-secondary/10 px-2 py-0.5 rounded font-bold" title="Bout-en-bout p50 mesuré à l'oreille des apprenants">
              Delta : {p.stats?.e2eP50 != null ? delay(p.stats.e2eP50) : "—"}
            </span>
          </div>
        </div>
        <p className="font-body-transcript-lg text-lg text-on-surface leading-relaxed pl-1 pt-1 min-h-[3.5rem]">
          {recent.every((l) => !l.tgt) && <span className="text-on-surface-variant">La traduction suit, segment par segment.</span>}
          {recent.map((l) => l.tgt && <span key={l.seq}>{l.tgt} </span>)}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-outline-variant/20 text-xs text-on-surface-variant pl-1">
          <div className="flex items-center gap-2 text-on-surface font-metric-mono-sm">
            <Icon name="volume_up" className="text-secondary text-[16px]" />
            <span>
              Diffusion vers <strong>{p.stats?.listeners ?? 0} casque{(p.stats?.listeners ?? 0) > 1 ? "s" : ""}</strong>
            </span>
            {p.stats?.queueP50Ms != null && <span className="text-outline-variant">• file p50 {delay(p.stats.queueP50Ms)}</span>}
          </div>
          <div className={`flex items-center gap-1 font-label-badge text-[11px] ${p.degraded ? "text-error" : "text-secondary"}`}>
            <span>{p.degraded ? `MODE DÉGRADÉ : ${p.degraded.toUpperCase()}` : "PIPELINE NOMINAL"}</span>
            <Icon name={p.degraded ? "error" : "check_circle"} className="text-[15px]" />
          </div>
        </div>
      </div>
    </div>
  );
}
