/**
 * Le flux en direct : l'hypothèse en cours (révisable) en tête, puis les segments
 * figés avec leur traduction, du plus récent au plus ancien, avec la règle de coupe
 * et l'heure — c'est ici qu'on règle la segmentation à l'œil avant de la mesurer.
 */
import type { Lang } from "../../../../shared/protocol";
import { clock } from "../../ui/format";
import { LANGS } from "../../ui/langs";
import type { Line } from "../types";
import { Empty } from "../ui";

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
    <div className="flex flex-col">
      <div className="flex items-start gap-3 py-3 text-sm">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${partial ? "bg-primary animate-pulse" : "bg-outline-variant"}`} />
        <span className={partial ? "text-primary italic" : "text-on-surface-variant"}>{partial || "Hypothèse en cours : rien pour l'instant."}</span>
      </div>

      <div className="hidden md:grid grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-6 pt-5 pb-2 border-b border-outline-variant/20 text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">
        <span>Segment</span>
        <span>
          {LANGS[srcLang].flag} Formateur · {LANGS[srcLang].short}
        </span>
        <span>
          {LANGS[tgtLang].flag} Traduction · {LANGS[tgtLang].short}
        </span>
      </div>
      <div className="flex flex-col divide-y divide-outline-variant/15 max-h-[560px] overflow-y-auto">
        {recent.length === 0 && (
          <div className="pt-4">
            <Empty icon="subtitles_off">Aucun segment encore : le formateur n'a pas parlé, ou le micro n'arrive pas au serveur.</Empty>
          </div>
        )}
        {recent.map((l) => (
          <div key={l.seq} className="rise-in grid grid-cols-1 md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-1 py-3">
            <div className="flex md:flex-col gap-x-2 gap-y-0.5 font-metric-mono-sm text-[11px] text-outline">
              <span className="text-on-surface-variant">#{l.seq}</span>
              {l.tOrigin != null && <span>{clock(l.tOrigin, clockOffset)}</span>}
              {l.reason && <span>{REASON[l.reason] ?? l.reason}</span>}
            </div>
            <p className="text-[13px] text-on-surface-variant leading-relaxed">{l.src}</p>
            {l.tgt ? <p className="text-sm text-on-surface font-medium leading-relaxed">{l.tgt}</p> : <p className="text-[13px] text-tertiary">traduction en cours…</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
