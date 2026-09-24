/** Journal de séance : ce qui s'est passé, quand, de quel type — filtrable, du plus récent au plus ancien. */
import { useState } from "react";
import { Icon } from "../../ui/Icon";
import type { EventKind, JournalEntry } from "../types";
import { Action, Empty, Segmented } from "../ui";

const KIND: Record<EventKind, { label: string; cls: string; icon: string }> = {
  parole: { label: "parole", cls: "text-tertiary", icon: "front_hand" },
  question: { label: "question", cls: "text-primary", icon: "contact_support" },
  signalement: { label: "signalé", cls: "text-tertiary", icon: "flag" },
  degrade: { label: "dégradé", cls: "text-error", icon: "warning" },
  erreur: { label: "erreur", cls: "text-error", icon: "error" },
  salle: { label: "salle", cls: "text-secondary", icon: "groups" },
  liaison: { label: "liaison", cls: "text-on-surface-variant", icon: "sensors" },
  reglages: { label: "réglages", cls: "text-primary", icon: "tune" },
};

const FILTERS = ["all", "parole", "question", "signalement", "degrade", "erreur", "salle", "reglages", "liaison"] as const;

export function Journal({ entries, onClear }: { entries: JournalEntry[]; onClear: () => void }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const shown = entries.filter((e) => filter === "all" || e.kind === filter).slice().reverse();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented size="sm" value={filter} onChange={setFilter} options={FILTERS.map((k) => ({ value: k, label: k === "all" ? "tout" : KIND[k].label }))} />
        <Action icon="delete_sweep" onClick={onClear} disabled={!entries.length}>
          Vider l'affichage
        </Action>
      </div>
      <div className="flex flex-col divide-y divide-outline-variant/15 max-h-[420px] overflow-y-auto">
        {shown.length === 0 && (
          <div className="pt-2">
            <Empty icon="history">Rien à signaler.</Empty>
          </div>
        )}
        {shown.map((e) => {
          const k = KIND[e.kind];
          return (
            <div key={e.n} className="rise-in flex items-center gap-4 py-2 text-[13px]">
              <span className="font-metric-mono-sm text-xs text-outline shrink-0 w-16">{new Date(e.at).toLocaleTimeString("fr-FR")}</span>
              <span className={`flex items-center gap-1.5 text-[10px] font-label-badge font-bold uppercase tracking-wider shrink-0 w-24 ${k.cls}`}>
                <Icon name={k.icon} className="text-[14px]" />
                {k.label}
              </span>
              <span className="text-on-surface min-w-0 truncate" title={e.text}>
                {e.text}
              </span>
              {e.count && e.count > 1 && <span className="font-metric-mono-sm text-xs text-outline shrink-0">×{e.count}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
