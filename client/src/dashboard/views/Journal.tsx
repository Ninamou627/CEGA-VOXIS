/** Journal de séance : ce qui s'est passé, quand, de quel type — filtrable, du plus récent au plus ancien. */
import { useState } from "react";
import { Icon } from "../../ui/Icon";
import type { EventKind, JournalEntry } from "../types";
import { Card } from "./Card";

const KIND: Record<EventKind, { label: string; cls: string; icon: string }> = {
  parole: { label: "parole", cls: "text-tertiary bg-tertiary/10 border-tertiary/30", icon: "front_hand" },
  question: { label: "question", cls: "text-primary bg-primary/10 border-primary/30", icon: "contact_support" },
  degrade: { label: "dégradé", cls: "text-error bg-error/10 border-error/30", icon: "warning" },
  erreur: { label: "erreur", cls: "text-error bg-error/10 border-error/30", icon: "error" },
  salle: { label: "salle", cls: "text-secondary bg-secondary/10 border-secondary/30", icon: "groups" },
  liaison: { label: "liaison", cls: "text-on-surface-variant bg-surface-container-high border-outline-variant/30", icon: "sensors" },
};

export function Journal({ entries, onClear }: { entries: JournalEntry[]; onClear: () => void }) {
  const [filter, setFilter] = useState<EventKind | "all">("all");
  const shown = entries.filter((e) => filter === "all" || e.kind === filter).slice().reverse();
  return (
    <Card
      icon="history"
      title="Journal de séance"
      tone="primary"
      right={
        <div className="flex items-center gap-1.5">
          {(["all", "parole", "question", "degrade", "erreur", "salle", "liaison"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`text-[10px] font-label-badge font-bold uppercase px-2 py-1 rounded-full border transition-colors ${
                filter === k ? "text-on-primary bg-primary border-primary" : "text-on-surface-variant bg-surface-container-low border-outline-variant/30 hover:bg-surface-container"
              }`}
            >
              {k === "all" ? "tout" : KIND[k].label}
            </button>
          ))}
          <button type="button" onClick={onClear} title="Vider le journal affiché" className="ml-1 w-7 h-7 rounded-lg bg-surface-container-low hover:bg-surface-container border border-outline-variant/30 text-on-surface-variant flex items-center justify-center">
            <Icon name="delete_sweep" className="text-[16px]" />
          </button>
        </div>
      }
    >
      <div className="flex flex-col divide-y divide-outline-variant/15 max-h-[360px] overflow-y-auto pr-0.5">
        {shown.length === 0 && <p className="text-xs text-on-surface-variant py-2">Rien à signaler.</p>}
        {shown.map((e) => {
          const k = KIND[e.kind];
          return (
            <div key={e.n} className="rise-in flex items-center gap-3 py-1.5 text-xs">
              <span className="font-metric-mono-sm text-[11px] text-outline shrink-0 w-16">{new Date(e.at).toLocaleTimeString("fr-FR")}</span>
              <span className={`flex items-center gap-1 text-[10px] font-label-badge font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 w-24 justify-center ${k.cls}`}>
                <Icon name={k.icon} className="text-[12px]" />
                {k.label}
              </span>
              <span className="text-on-surface min-w-0 truncate" title={e.text}>
                {e.text}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
