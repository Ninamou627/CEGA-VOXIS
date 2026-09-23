/**
 * Les deux boutons flottants de la page apprenant, au-dessus de tout le reste :
 *   - poser une question, toujours là, large, au pouce ;
 *   - signaler un problème, discret par défaut, qui s'ouvre et pulse quand le
 *     système détecte que la traduction va mal (l'apprenant n'a pas à y penser).
 */
import { Icon } from "../../ui/Icon";

export interface FabsProps {
  /** Question impossible : plus de liaison, ou un autre apprenant a la parole. */
  askDisabled: boolean;
  askHint?: string;
  /** Le système a repéré un souci : le bouton s'ouvre et se signale. */
  alert: boolean;
  alertLabel?: string;
  onAsk: () => void;
  onReport: () => void;
}

export function Fabs(p: FabsProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="flex flex-col items-center gap-space-xs px-gutter-mobile pb-safe-md">
        <button
          type="button"
          onClick={p.onReport}
          aria-label="Signaler un problème"
          className={`pointer-events-auto flex items-center gap-space-xs rounded-full shadow-lg transition-all active:scale-95 ${
            p.alert
              ? "pop bg-tertiary-container text-on-tertiary-container px-4 py-2.5 border border-tertiary/50"
              : "bg-surface-container-high/90 backdrop-blur text-on-surface-variant px-3 py-2 border border-outline-variant/30"
          }`}
        >
          <Icon name={p.alert ? "report" : "flag"} fill={p.alert} className={`text-[18px] ${p.alert ? "animate-pulse" : ""}`} />
          <span className="font-headline-sm text-headline-sm">{p.alert ? (p.alertLabel ?? "Un souci ? Signalez-le") : "Signaler un problème"}</span>
        </button>

        <button
          type="button"
          disabled={p.askDisabled}
          onClick={p.onAsk}
          className="pointer-events-auto group relative w-full h-16 rounded-full bg-gradient-to-r from-secondary-container via-surface-container-high to-primary-container text-on-surface flex items-center justify-between pl-space-sm pr-space-md shadow-xl active:scale-[0.98] transition-all overflow-hidden select-none disabled:opacity-60 disabled:active:scale-100"
        >
          <span className="flex items-center gap-space-sm min-w-0">
            <span className="w-11 h-11 rounded-full bg-surface-container flex items-center justify-center text-secondary shadow-md shrink-0">
              <Icon name="front_hand" className="text-[24px]" />
            </span>
            <span className="flex flex-col text-left min-w-0">
              <span className="font-headline-sm text-headline-sm font-bold tracking-tight truncate">Cliquez ici pour poser une question</span>
              {p.askHint && <span className="font-body-sm text-body-sm text-on-surface-variant truncate">{p.askHint}</span>}
            </span>
          </span>
          <Icon name="chevron_right" className="text-on-surface-variant text-[22px] shrink-0" />
        </button>
      </div>
    </div>
  );
}
