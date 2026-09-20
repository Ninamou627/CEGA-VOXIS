/**
 * Le flux en direct : l'hypothèse en cours (révisable) en tête, puis les segments
 * figés avec leur traduction, du plus récent au plus ancien, avec la règle de coupe
 * et l'heure — c'est ici qu'on règle la segmentation à l'œil avant de la mesurer.
 */
import type { Lang } from "../../../../shared/protocol";
import { clock } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { Line } from "../types";
import { Card } from "./Card";

const REASON: Record<string, string> = {
  punctuation: "ponctuation",
  clause: "proposition",
  maxlen: "longueur max",
  timeout: "délai",
  silence: "silence",
  final: "fin de tour",
};

export function Segments({ lines, partial, srcLang, tgtLang, clockOffset }: { lines: Line[]; partial: string; srcLang: Lang; tgtLang: Lang; clockOffset: number }) {
  const recent = lines.slice(-30).reverse();
  return (
    <Card
      icon="subtitles"
      title="Flux en direct"
      right={
        <span className="flex items-center gap-1.5 text-[10px] font-metric-mono-sm text-on-surface-variant">
          <span className="px-1.5 py-0.5 rounded bg-surface-container-highest">{LANGS[srcLang].short}</span>
          <Icon name="arrow_forward" className="text-[12px] text-primary" />
          <span className="px-1.5 py-0.5 rounded bg-primary-container text-on-primary-container">{LANGS[tgtLang].short}</span>
          <span className="ml-1">{lines.length} segment{lines.length > 1 ? "s" : ""}</span>
        </span>
      }
      className="min-h-[320px]"
    >
      <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm min-h-[2.75rem] ${partial ? "border-primary/30 bg-primary/5" : "border-outline-variant/20 bg-surface-container-low"}`}>
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${partial ? "bg-primary animate-pulse" : "bg-outline-variant"}`}></span>
        <span className={partial ? "text-primary italic" : "text-on-surface-variant"}>{partial || "Hypothèse en cours : rien pour l'instant."}</span>
      </div>
      <div className="flex flex-col divide-y divide-outline-variant/15 max-h-[560px] overflow-y-auto pr-0.5">
        {recent.length === 0 && <p className="text-xs text-on-surface-variant py-2">Aucun segment encore : le formateur n'a pas parlé, ou le micro n'arrive pas au serveur.</p>}
        {recent.map((l) => (
          <div key={l.seq} className="rise-in flex flex-col gap-1 py-2.5">
            <div className="flex items-center gap-2 font-metric-mono-sm text-[10px] text-outline">
              <span>#{l.seq}</span>
              {l.tOrigin != null && <span>{clock(l.tOrigin, clockOffset)}</span>}
              {l.reason && <span className="px-1.5 py-px rounded bg-surface-container-high text-on-surface-variant">{REASON[l.reason] ?? l.reason}</span>}
              {!l.tgt && <span className="text-tertiary">traduction en cours…</span>}
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">{l.src}</p>
            {l.tgt && <p className="text-sm text-on-surface font-medium leading-relaxed">{l.tgt}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}
