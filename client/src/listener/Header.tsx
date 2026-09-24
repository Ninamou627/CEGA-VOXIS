/**
 * Barre fixe du haut, sous deux formes dans les maquettes :
 *   - « brand » : marque et état de la connexion (écran d'écoute) ;
 *   - « page »  : flèche retour, titre et sous-titre (studio de question).
 */
import { APP_NAME } from "../ui/brand";
import { Icon } from "../ui/Icon";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";

export type LinkTone = "live" | "wait" | "off";

export interface LinkStatus {
  tone: LinkTone;
  /** Texte du badge (LIVE, SYNC, OFF). */
  badge: string;
  /** Texte après le badge. */
  caption: string;
}

export type HeaderProps =
  | { kind: "brand"; status: LinkStatus }
  | { kind: "page"; title: string; subtitle: string; onBack: () => void };

const BADGE: Record<LinkTone, { pill: string; dot: string }> = {
  live: { pill: "bg-secondary/10 text-secondary", dot: "bg-secondary animate-pulse" },
  wait: { pill: "bg-tertiary/10 text-tertiary", dot: "bg-tertiary animate-pulse" },
  off: { pill: "bg-error/10 text-error", dot: "bg-error" },
};

export function Header(p: HeaderProps) {
  return (
    <header className="fixed top-0 inset-x-0 z-50 bg-surface/80 backdrop-blur-xl pt-safe shadow-[0_1px_8px_rgba(25,27,35,0.10)] dark:shadow-[0_1px_8px_rgba(0,0,0,0.4)]">
      <div className="h-16 px-gutter-mobile flex items-center justify-between gap-space-sm">
        {p.kind === "brand" ? <Brand status={p.status} /> : <Page title={p.title} subtitle={p.subtitle} onBack={p.onBack} />}
        <div className="flex items-center gap-space-xs flex-shrink-0">
          <ThemeToggle variant={p.kind === "brand" ? "switch" : "round"} />
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <Icon name="person" className="text-on-primary text-[18px]" />
          </div>
        </div>
      </div>
    </header>
  );
}

function Brand({ status }: { status: LinkStatus }) {
  const b = BADGE[status.tone];
  return (
    <div className="flex items-center gap-space-sm min-w-0 flex-1">
      <Logo className="h-8 w-8 flex-shrink-0" />
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-space-xs">
          <span className="font-headline-sm text-headline-sm text-on-surface truncate">{APP_NAME}</span>
        </div>
        <div className="flex items-center gap-space-xs">
          <span key={status.badge} className={`pop inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-label-badge text-label-badge tracking-wider ${b.pill}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`}></span>
            {status.badge}
          </span>
          <span className="text-on-surface-variant font-body-sm text-body-sm truncate">• {status.caption}</span>
        </div>
      </div>
    </div>
  );
}

function Page({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-space-xs min-w-0 flex-1">
      <button
        type="button"
        aria-label="Retour"
        onClick={onBack}
        className="w-11 h-11 flex items-center justify-center text-on-surface hover:text-primary transition-colors flex-shrink-0"
      >
        <Icon name="arrow_back" className="text-[24px]" />
      </button>
      <Logo className="h-7 w-7 flex-shrink-0" />
      <div className="flex flex-col min-w-0 pl-1">
        <h1 className="font-headline-sm text-headline-sm text-on-surface truncate">{title}</h1>
        <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant truncate">{subtitle}</span>
      </div>
    </div>
  );
}
