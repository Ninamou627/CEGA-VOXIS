/**
 * Signalements des apprenants, vus de la régie : combien par cause, et les derniers
 * avec leur passage. C'est la donnée qui fait progresser le système entre deux
 * séances (glossaire, segmentation, choix de voix) ; tout est aussi dans le JSONL.
 */
import type { ReportKind } from "../../../../shared/protocol";
import { ago, delay } from "../../ui/format";
import { LANGS } from "../../ui/langs";
import { REPORT_LABEL } from "../../ui/reports";
import type { ReportEntry } from "../types";
import { Card } from "./Card";

const ORDER: ReportKind[] = ["transcription", "translation", "slow", "voice", "audio"];

export function Reports({ reports, now }: { reports: ReportEntry[]; now: number }) {
  const counts = new Map<ReportKind, number>();
  for (const r of reports) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const top = Math.max(1, ...counts.values());
  const recent = reports.slice().reverse();

  return (
    <Card
      icon="flag"
      title="Signalements"
      tone="tertiary"
      right={
        <span className={`font-metric-mono-sm text-[11px] font-bold px-2 py-0.5 rounded-full border ${reports.length ? "text-tertiary bg-tertiary/10 border-tertiary/30" : "text-on-surface-variant bg-surface-container-low border-outline-variant/30"}`}>
          {reports.length}
        </span>
      }
    >
      {reports.length === 0 ? (
        <p className="text-xs text-on-surface-variant">
          Aucun problème signalé. Les apprenants peuvent en signaler cinq sortes depuis leur téléphone ; chacun arrive ici avec l'heure, la phrase et sa traduction.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {ORDER.filter((k) => counts.get(k)).map((k) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <span aria-hidden="true">{REPORT_LABEL[k].emoji}</span>
                <span className="text-on-surface-variant truncate flex-1">{REPORT_LABEL[k].label}</span>
                <div className="w-20 h-1.5 bg-surface-container-highest rounded-full overflow-hidden shrink-0">
                  <div className="h-full bg-tertiary rounded-full" style={{ width: `${((counts.get(k) ?? 0) / top) * 100}%` }} />
                </div>
                <span className="font-metric-mono-sm text-[11px] text-on-surface font-bold w-5 text-right">{counts.get(k)}</span>
              </div>
            ))}
          </div>
          <div className="h-px bg-outline-variant/20" />
          <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto pr-0.5">
            {recent.map((r) => (
              <div key={r.n} className="rise-in bg-surface-container-low border border-outline-variant/20 rounded-xl p-2.5 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-[10px] font-metric-mono-sm text-outline">
                  <span aria-hidden="true">{REPORT_LABEL[r.kind].emoji}</span>
                  <span className="text-on-surface font-semibold truncate">{REPORT_LABEL[r.kind].label}</span>
                  <span className="ml-auto whitespace-nowrap">{ago(r.at, now)}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] font-metric-mono-sm text-outline">
                  <span>
                    {LANGS[r.lang].flag} {LANGS[r.lang].short}
                  </span>
                  {r.seq != null && <span>segment #{r.seq}</span>}
                  {r.e2eMs != null && <span>décalage {delay(r.e2eMs)}</span>}
                </div>
                {r.srcText && <p className="text-xs text-on-surface-variant italic leading-relaxed line-clamp-2">« {r.srcText} »</p>}
                {r.text && <p className="text-xs text-on-surface leading-snug line-clamp-2">“{r.text}”</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
