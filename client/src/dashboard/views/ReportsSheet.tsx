/**
 * Les signalements des apprenants, ouverts depuis n'importe quelle page de l'administration.
 * C'est ici qu'ils arrivent — le formateur n'est pas interrompu pendant qu'il parle — avec
 * la cause, le passage visé, la langue, la voix qui l'a dit et le décalage ressenti.
 */
import type { RecentReport } from "../../../../shared/admin";
import type { ReportKind } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import { REPORT_LABEL } from "../../ui/reports";
import { Action, Sheet } from "../ui";
import { ReportBreakdown, ReportList } from "./Reports";

export interface ReportsSheetProps {
  reports: RecentReport[];
  today: Partial<Record<ReportKind, number>>;
  all: Partial<Record<ReportKind, number>>;
  now: number;
  voiceName: (id: string) => string | undefined;
  onClose: () => void;
}

const sum = (r: Partial<Record<ReportKind, number>>) => Object.values(r).reduce((a, b) => a + (b ?? 0), 0);

export function ReportsSheet({ reports, today, all, now, voiceName, onClose }: ReportsSheetProps) {
  const n = sum(today);
  return (
    <Sheet
      title="Signalements des apprenants"
      subtitle={`${n ? `${n} aujourd'hui` : "Aucun aujourd'hui"} · ${sum(all)} depuis le début. Ils arrivent ici, pas chez le formateur.`}
      onClose={onClose}
    >
      <div className="px-6 py-5 flex flex-col gap-8">
        <ReportList reports={reports} now={now} voiceName={voiceName} />
        <section>
          <h3 className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant mb-2">Par cause</h3>
          <ReportBreakdown today={today} all={all} compact />
        </section>
        <div>
          <Action tone="outline" icon="insights" href="#/qualite">
            Analyse sur la page Qualité
          </Action>
        </div>
      </div>
    </Sheet>
  );
}

/** Un signalement qui vient d'arriver s'annonce en bas à droite, quelle que soit la page ; un clic ouvre la liste. */
export function ReportToasts({ items, onOpen, onDismiss }: { items: { id: number; report: RecentReport }[]; onOpen: () => void; onDismiss: (id: number) => void }) {
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2 w-[min(24rem,calc(100vw-2rem))] pointer-events-none">
      {items.map(({ id, report: r }) => (
        <div key={id} role="status" className="rise-in pointer-events-auto w-full flex items-start gap-3 rounded-xl border border-tertiary/35 bg-surface-container-high/95 backdrop-blur-md pl-4 pr-2 py-3 shadow-xl">
          <Icon name={REPORT_LABEL[r.kind].icon} className="text-[20px] text-tertiary shrink-0 mt-0.5" />
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            <span className="block text-[13px] font-semibold text-on-surface">Signalement · {REPORT_LABEL[r.kind].label}</span>
            <span className="block text-xs text-on-surface-variant truncate">{r.srcText ? `« ${r.srcText} »` : "Aucun passage en cours d'écoute"}</span>
          </button>
          <Action icon="close" title="Fermer" onClick={() => onDismiss(id)} />
        </div>
      ))}
    </div>
  );
}
