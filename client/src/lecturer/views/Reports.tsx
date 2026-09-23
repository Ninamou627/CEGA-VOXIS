/**
 * Signalements des apprenants. Ils disent ce qui ne va pas là où le formateur ne
 * peut pas l'entendre — dans les écouteurs de la salle. Tout est aussi écrit dans
 * `metrics.jsonl` : c'est la matière du réglage d'après séance.
 */
import { ago } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { REPORT_LABEL } from "../../ui/reports";
import type { ReportItem } from "../types";
import { delay } from "../../ui/format";

export function Reports({ reports, now }: { reports: ReportItem[]; now: number }) {
  const recent = reports.slice().reverse();
  // Deux signalements du même type en cinq minutes : ce n'est plus un avis isolé.
  const counts = new Map<string, number>();
  for (const r of reports) if (now - r.at < 300_000) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const hot = [...counts.entries()].filter(([, n]) => n >= 2);

  return (
    <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-tertiary/15 flex items-center justify-center text-tertiary shrink-0">
            <Icon name="flag" className="text-[19px]" />
          </div>
          <div className="flex flex-col min-w-0">
            <h2 className="font-headline-sm text-xs font-bold text-on-surface uppercase tracking-wider">Signalements</h2>
            <span className="font-metric-mono-sm text-[11px] text-on-surface-variant truncate">
              {reports.length === 0 ? "Aucun problème signalé" : `${reports.length} depuis le début`}
            </span>
          </div>
        </div>
        {hot.length > 0 && (
          <span key={hot.map(([k]) => k).join()} className="pop flex items-center gap-1 text-[10px] font-label-badge font-bold uppercase px-2 py-1 rounded-full border text-error bg-error/10 border-error/30">
            <Icon name="priority_high" className="text-[12px]" />
            Plusieurs avis
          </span>
        )}
      </div>

      {hot.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hot.map(([k, n]) => (
            <span key={k} className="text-[11px] font-metric-mono-sm px-2 py-1 rounded-lg bg-error-container/40 text-on-error-container border border-error/20">
              {REPORT_LABEL[k as keyof typeof REPORT_LABEL].emoji} ×{n}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 max-h-[280px] overflow-y-auto pr-0.5">
        {recent.length === 0 && (
          <p className="text-xs text-on-surface-variant">
            Les apprenants peuvent signaler une mauvaise transcription, une traduction fausse ou trop lente, une voix peu naturelle ou un son coupé.
          </p>
        )}
        {recent.map((r) => {
          const l = REPORT_LABEL[r.kind];
          return (
            <div key={r.n} className="rise-in bg-surface-container-low border border-outline-variant/20 rounded-xl p-2.5 flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[11px] font-metric-mono-sm">
                <span aria-hidden="true">{l.emoji}</span>
                <span className="text-on-surface font-semibold truncate">{l.label}</span>
                <span className="ml-auto text-outline whitespace-nowrap">{ago(r.at, now)}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-metric-mono-sm text-outline">
                <span>
                  {LANGS[r.lang].flag} {LANGS[r.lang].short}
                </span>
                <span>Apprenant {r.who.slice(-4).toUpperCase()}</span>
                {r.e2eMs != null && <span>décalage {delay(r.e2eMs)}</span>}
              </div>
              {r.srcText && <p className="text-xs text-on-surface-variant italic leading-relaxed line-clamp-2">« {r.srcText} »</p>}
              {r.text && <p className="text-xs text-on-surface leading-snug line-clamp-2">“{r.text}”</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
