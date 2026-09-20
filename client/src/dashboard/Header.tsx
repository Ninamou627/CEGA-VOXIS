/**
 * Bandeau du tableau de bord : marque, liaison avec le serveur, session et temps de
 * service, formateur et auditeurs par langue, thème, accès aux autres pages.
 */
import type { Lang } from "../../../shared/protocol";
import type { ConnState } from "../lib/ws";
import { hms } from "../ui/format";
import { Icon } from "../ui/Icon";
import { LANGS } from "../ui/langs";
import { ThemeToggle } from "../ui/ThemeToggle";

export interface HeaderProps {
  conn: ConnState;
  session?: string;
  uptimeS?: number;
  lecturer?: boolean;
  listeners: number;
  byLang?: Partial<Record<Lang, number>>;
  lecturerUrl: string;
  joinUrl?: string;
}

const LINK: Record<ConnState, { label: string; cls: string; dot: string }> = {
  open: { label: "LIVE", cls: "bg-secondary/15 border-secondary/30 text-secondary", dot: "bg-secondary animate-ping" },
  connecting: { label: "SYNC", cls: "bg-tertiary/15 border-tertiary/30 text-tertiary", dot: "bg-tertiary animate-pulse" },
  reconnecting: { label: "SYNC", cls: "bg-tertiary/15 border-tertiary/30 text-tertiary", dot: "bg-tertiary animate-pulse" },
  closed: { label: "OFF", cls: "bg-error/15 border-error/30 text-error", dot: "bg-error" },
};

export function Header(p: HeaderProps) {
  const link = LINK[p.conn];
  const byLang = Object.entries(p.byLang ?? {}).filter(([, n]) => (n ?? 0) > 0) as [Lang, number][];
  return (
    <header className="sticky top-0 z-50 h-20 w-full bg-surface-container-lowest/90 backdrop-blur-xl border-b border-outline-variant/30 px-6 lg:px-8 flex items-center justify-between gap-4 transition-colors shadow-lg">
      <div className="flex items-center gap-5 min-w-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-container to-secondary-container/40 p-0.5 shadow-md flex items-center justify-center">
            <div className="w-full h-full bg-surface-container-lowest rounded-[10px] flex items-center justify-center">
              <Icon name="monitoring" className="text-secondary text-[22px]" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-headline-md text-lg font-bold tracking-tight text-on-surface">VOXIS</span>
            <span className="text-xs uppercase tracking-widest text-primary font-label-badge font-bold whitespace-nowrap">Control Room</span>
            <div key={link.label} className={`pop flex items-center gap-1.5 border px-2.5 py-0.5 rounded-full text-[11px] font-label-badge font-bold ml-1 ${link.cls}`}>
              <span className={`w-2 h-2 rounded-full ${link.dot}`}></span>
              <span>{link.label}</span>
            </div>
          </div>
        </div>
        <div className="hidden md:block h-7 w-px bg-outline-variant/40 mx-1"></div>
        <div className="hidden lg:flex items-center gap-3 bg-surface-container-low border border-outline-variant/30 px-3.5 py-1.5 rounded-xl">
          <span className="text-xs text-on-surface-variant font-medium whitespace-nowrap">{p.session ?? "Session"}</span>
          <span className="text-outline-variant">•</span>
          <div className="flex items-center gap-1.5 text-secondary font-metric-mono-sm text-xs font-semibold whitespace-nowrap" title="Temps de service du serveur de salle">
            <Icon name="schedule" className="text-[15px]" />
            <span>{p.uptimeS != null ? hms(p.uptimeS) : "—"}</span>
          </div>
        </div>
      </div>

      {/* Centre : formateur, auditeurs */}
      <div className="hidden xl:flex items-center gap-4">
        <div className="flex items-center gap-2.5 bg-surface-container-low border border-outline-variant/30 px-3 py-1.5 rounded-xl" title="Le formateur a ouvert son micro">
          <div className="relative flex items-center justify-center">
            <Icon name={p.lecturer ? "mic" : "mic_off"} className={`text-[18px] ${p.lecturer ? "text-secondary" : "text-outline"}`} />
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${p.lecturer ? "bg-secondary" : "bg-outline"}`}></span>
          </div>
          <span className="font-headline-sm text-xs font-bold text-on-surface whitespace-nowrap">{p.lecturer ? "Formateur en direct" : "Formateur absent"}</span>
        </div>
        <div className="flex items-center gap-2.5 bg-surface-container-low border border-outline-variant/30 px-3.5 py-1.5 rounded-xl">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Icon name="headphones" className="text-[18px]" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-xs font-bold text-on-surface whitespace-nowrap">
                {p.listeners} auditeur{p.listeners > 1 ? "s" : ""}
              </span>
              <span className={`flex h-1.5 w-1.5 rounded-full ${p.listeners > 0 ? "bg-secondary" : "bg-outline"}`}></span>
            </div>
            {byLang.length > 0 && (
              <div className="flex items-center gap-2 text-[10px] font-metric-mono-sm text-on-surface-variant">
                {byLang.map(([l, n]) => (
                  <span key={l}>
                    {LANGS[l].flag} {LANGS[l].short} {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Droite : thème, autres pages */}
      <div className="flex items-center gap-3">
        <ThemeToggle variant="square" />
        <a
          href={p.lecturerUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-surface-container-high hover:bg-surface-bright text-on-surface border border-outline-variant/40 font-headline-sm text-xs font-bold whitespace-nowrap transition-all active:scale-95 shadow-sm"
        >
          <Icon name="record_voice_over" className="text-secondary text-[18px]" />
          <span>Page formateur</span>
        </a>
        {p.joinUrl && (
          <a
            href={p.joinUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-surface-container-high hover:bg-surface-bright text-on-surface border border-outline-variant/40 font-headline-sm text-xs font-bold whitespace-nowrap transition-all active:scale-95 shadow-sm"
          >
            <Icon name="headphones" className="text-primary text-[18px]" />
            <span>Page apprenant</span>
          </a>
        )}
      </div>
    </header>
  );
}
