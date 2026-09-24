/**
 * Les alertes en cours, de la plus grave à la plus légère. Chaque ligne dit ce qui se
 * passe, pourquoi c'est un problème, et renvoie à la page où agir.
 */
import { Icon } from "../../ui/Icon";
import type { Alert, Severity } from "../signals";

const SEV: Record<Severity, { icon: string; cls: string; label: string }> = {
  crit: { icon: "error", cls: "text-error", label: "Critique" },
  warn: { icon: "warning", cls: "text-tertiary", label: "À surveiller" },
  info: { icon: "info", cls: "text-primary", label: "Information" },
};

const PAGE: Record<string, string> = {
  supervision: "Supervision",
  qualite: "Qualité",
  voix: "Voix",
  configuration: "Configuration",
  seance: "Séance",
};

export function Alerts({ alerts, limit, here }: { alerts: Alert[]; limit?: number; here?: string }) {
  if (!alerts.length) {
    return (
      <div className="flex items-center gap-3 py-1 text-sm text-on-surface-variant">
        <Icon name="check_circle" fill className="text-[22px] text-secondary" />
        Aucune alerte : la chaîne fonctionne normalement.
      </div>
    );
  }
  const shown = limit ? alerts.slice(0, limit) : alerts;
  const rest = alerts.length - shown.length;
  return (
    <ul className="divide-y divide-outline-variant/15 -mt-3">
      {shown.map((a) => (
        <li key={a.id} className="rise-in flex items-start gap-3 py-3.5">
          <Icon name={SEV[a.severity].icon} fill className={`text-[20px] mt-px shrink-0 ${SEV[a.severity].cls}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-on-surface">{a.title}</span>
              <span className={`text-[10px] font-label-badge font-bold uppercase tracking-wider ${SEV[a.severity].cls}`}>{SEV[a.severity].label}</span>
            </div>
            {a.detail && <div className="text-[13px] text-on-surface-variant mt-0.5 break-words leading-relaxed">{a.detail}</div>}
          </div>
          {a.to && a.to !== here && (
            <a href={`#/${a.to}`} className="shrink-0 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline underline-offset-4 mt-px">
              {PAGE[a.to] ?? a.to}
              <Icon name="arrow_forward" className="text-[15px]" />
            </a>
          )}
        </li>
      ))}
      {rest > 0 && (
        <li className="pt-3">
          <a href="#/supervision" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline underline-offset-4">
            {rest} autre{rest > 1 ? "s" : ""} alerte{rest > 1 ? "s" : ""}
            <Icon name="arrow_forward" className="text-[15px]" />
          </a>
        </li>
      )}
    </ul>
  );
}
