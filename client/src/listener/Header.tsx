/** Barre fixe du haut : marque, code de session, état de la connexion, thème. */
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

const BADGE: Record<LinkTone, { pill: string; dot: string }> = {
  live: { pill: "bg-secondary/10 text-secondary", dot: "bg-secondary animate-pulse" },
  wait: { pill: "bg-tertiary/10 text-tertiary", dot: "bg-tertiary animate-pulse" },
  off: { pill: "bg-error/10 text-error", dot: "bg-error" },
};

export function Header({ session, status }: { session: string; status: LinkStatus }) {
  const b = BADGE[status.tone];
  return (
    <header className="fixed top-0 inset-x-0 z-50 bg-surface/80 backdrop-blur-xl pt-safe shadow-[0_1px_8px_rgba(0,0,0,0.4)]">
      <div className="h-16 px-gutter-mobile flex items-center justify-between gap-space-sm">
        <div className="flex items-center gap-space-sm min-w-0 flex-1">
          <Logo className="h-8 w-8 flex-shrink-0" />
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-space-xs">
              <span className="font-headline-sm text-headline-sm text-on-surface truncate">VOXIS</span>
              <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant/80 tracking-wider uppercase truncate">#{session}</span>
            </div>
            <div className="flex items-center gap-space-xs">
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-label-badge text-label-badge tracking-wider ${b.pill}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`}></span>
                {status.badge}
              </span>
              <span className="text-on-surface-variant font-body-sm text-body-sm truncate">• {status.caption}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-space-xs flex-shrink-0">
          <ThemeToggle />
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
            <Icon name="person" className="text-on-primary text-[18px]" />
          </div>
        </div>
      </div>
    </header>
  );
}
