/**
 * Cadre de l'administration : un menu latéral (les pages, leurs signaux, les liens vers
 * les autres écrans de la salle) et l'en-tête de la page courante. Sur un écran étroit,
 * le menu passe en bandeau horizontal.
 *
 * La Vue d'ensemble et la Supervision portent le design « constellation » (`cosmos`) :
 * un ciel fixe derrière la page, et la portée `.cosmos` qui accorde les couleurs au
 * design en sombre (voir theme.css). Le menu, lui, ne change pas d'une page à l'autre.
 */
import type { ReactNode } from "react";
import type { AccountView } from "../lib/auth";
import type { ConnState } from "../lib/ws";
import { APP_NAME } from "../ui/brand";
import { hms } from "../ui/format";
import { Icon } from "../ui/Icon";
import { Logo } from "../ui/Logo";
import { ThemeToggle } from "../ui/ThemeToggle";
import { Accent, Dot, type Tone } from "./ui";

export type Route = "" | "supervision" | "qualite" | "voix" | "configuration" | "seance";

export const PAGES: { route: Route; label: string; icon: string; title: string; subtitle: string; accent?: string }[] = [
  { route: "", label: "Vue d'ensemble", icon: "space_dashboard", title: "Vue d'ensemble", subtitle: "L'état de la salle en un coup d'œil : qui écoute, ce qui marche, ce qui demande une action." },
  {
    route: "supervision",
    label: "Supervision",
    icon: "monitor_heart",
    title: "Supervision en temps réel",
    accent: "temps réel",
    subtitle: "Chaque étage de la chaîne, du micro du formateur aux écouteurs des apprenants. Un clic sur un étage ouvre son inspecteur.",
  },
  { route: "qualite", label: "Qualité", icon: "verified", title: "Monitoring de qualité", subtitle: "Les quatre piliers — rapidité, transcription, traduction, voix — mesurés séance après séance." },
  { route: "voix", label: "Voix", icon: "record_voice_over", title: "Gestion des voix", subtitle: "Les voix de la salle, leur naturalité perçue par les apprenants, et la voix par défaut de chaque langue." },
  { route: "configuration", label: "Configuration", icon: "tune", title: "Configuration globale", subtitle: "Traduction, parole et voix. Chaque réglage dit s'il s'applique tout de suite ou au prochain démarrage du micro." },
  { route: "seance", label: "Séance", icon: "co_present", title: "Séance", subtitle: "Rejoindre la salle, vérifier avant de commencer, suivre les questions et le journal." },
];

export interface ShellProps {
  route: Route;
  conn: ConnState;
  uptimeS?: number;
  alerts: { crit: number; warn: number };
  /** Signalements du jour, en pastille sur « Qualité ». */
  reports: number;
  /** Des réglages attendent d'être enregistrés. */
  configDirty?: boolean;
  /** Compte connecté : son nom s'affiche, et « Se déconnecter » ferme sa session. */
  account: AccountView;
  onLogout: () => void;
  joinUrl?: string;
  /** Actions à droite de l'en-tête de la page. */
  actions?: ReactNode;
  /** Design « constellation » : ciel de fond, couleurs du design en sombre, titre en dégradé. */
  cosmos?: boolean;
  children: ReactNode;
}

const LINK_TONE: Record<ConnState, Tone> = { open: "ok", connecting: "warn", reconnecting: "warn", closed: "crit" };
const LINK_LABEL: Record<ConnState, string> = { open: "En direct", connecting: "Connexion…", reconnecting: "Reconnexion…", closed: "Hors ligne" };

export function Shell(p: ShellProps) {
  const page = PAGES.find((x) => x.route === p.route) ?? PAGES[0];
  // Plus de jeton dans l'adresse : le poste formateur reconnaît la même session (D17).
  const lecturerUrl = "/lecturer";
  const badge = (route: Route) => {
    if ((route === "" || route === "supervision") && p.alerts.crit + p.alerts.warn > 0) {
      return (
        <span className={`ml-auto min-w-[1.25rem] px-1.5 h-5 rounded-full text-[11px] font-bold font-metric-mono-sm flex items-center justify-center ${p.alerts.crit ? "bg-error text-on-error" : "bg-tertiary text-on-tertiary"}`}>
          {p.alerts.crit + p.alerts.warn}
        </span>
      );
    }
    if (route === "configuration" && p.configDirty) {
      return <span className="ml-auto w-2 h-2 rounded-full bg-primary" title="Modifications non enregistrées" />;
    }
    if (route === "qualite" && p.reports > 0) {
      return <span title="Signalements aujourd'hui" className="ml-auto min-w-[1.25rem] px-1.5 h-5 rounded-full text-[11px] font-bold font-metric-mono-sm flex items-center justify-center bg-surface-container-highest text-on-surface-variant">{p.reports}</span>;
    }
    return null;
  };

  const title =
    p.cosmos && page.accent && page.title.endsWith(page.accent) ? (
      <>
        {page.title.slice(0, -page.accent.length)}
        <Accent>{page.accent}</Accent>
      </>
    ) : (
      page.title
    );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-surface text-on-surface">
      {p.cosmos && <div aria-hidden="true" className="cosmos cosmos-sky" />}
      {/* Menu latéral (positionné : il passe devant le ciel quand il devient un bandeau) */}
      <aside className="relative lg:w-64 lg:shrink-0 lg:h-screen lg:sticky lg:top-0 flex flex-col bg-surface-container-lowest border-b lg:border-b-0 lg:border-r border-outline-variant/25">
        <div className="flex items-center gap-3 px-5 h-16 lg:h-20 shrink-0">
          <Logo className="w-9 h-9" />
          <div className="flex flex-col leading-tight">
            <span className="font-headline-md text-[17px] font-bold tracking-tight">{APP_NAME}</span>
            <span className="text-[10px] font-label-badge font-bold uppercase tracking-[0.18em] text-primary">Administration</span>
          </div>
        </div>

        <nav className="flex lg:flex-col gap-0.5 px-3 pb-3 lg:pb-0 overflow-x-auto lg:overflow-visible" aria-label="Pages de l'administration">
          {PAGES.map((x) => {
            const on = x.route === p.route;
            return (
              <a
                key={x.route}
                href={`#/${x.route}`}
                aria-current={on ? "page" : undefined}
                className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                  on ? "bg-surface-container-high text-on-surface font-semibold" : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low"
                }`}
              >
                {on && <span className="hidden lg:block absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-primary" />}
                <Icon name={x.icon} fill={on} className={`text-[20px] ${on ? "text-primary" : ""}`} />
                <span>{x.label}</span>
                {badge(x.route)}
              </a>
            );
          })}
        </nav>

        <div className="hidden lg:flex flex-col gap-4 mt-auto px-5 py-5 border-t border-outline-variant/20">
          <div className="flex items-center gap-2 text-xs">
            <Dot tone={LINK_TONE[p.conn]} live={p.conn === "open"} />
            <span className="font-semibold">{LINK_LABEL[p.conn]}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <Icon name="schedule" className="text-[15px]" />
            <span>Serveur en service</span>
            <span className="font-metric-mono-sm text-on-surface ml-auto">{p.uptimeS != null ? hms(p.uptimeS) : "—"}</span>
          </div>
          <div className="flex flex-col gap-0.5 -mx-2">
            {[
              { href: lecturerUrl, icon: "record_voice_over", label: "Page formateur" },
              { href: "/screen", icon: "cast", label: "Écran de salle" },
              ...(p.joinUrl ? [{ href: p.joinUrl, icon: "smartphone", label: "Page apprenant" }] : []),
            ].map((l) => (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[13px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low">
                <Icon name={l.icon} className="text-[17px]" />
                {l.label}
                <Icon name="open_in_new" className="text-[14px] ml-auto opacity-60" />
              </a>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-on-surface-variant">
            <span>Thème</span>
            <ThemeToggle variant="square" />
          </div>
          <div className="flex items-center gap-2 text-xs -mx-2 px-2">
            <Icon name="account_circle" className="text-[17px] text-on-surface-variant" />
            <span className="font-semibold text-on-surface truncate" title={p.account.username}>
              {p.account.username}
            </span>
            <button
              type="button"
              onClick={p.onLogout}
              title="Se déconnecter"
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low"
            >
              <Icon name="logout" className="text-[16px]" />
              <span>Quitter</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Page */}
      <main className={`relative flex-1 min-w-0 ${p.cosmos ? "cosmos text-on-surface" : ""}`}>
        <header className="px-6 lg:px-10 pt-8 pb-6 border-b border-outline-variant/20 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className={`font-headline-lg text-[28px] leading-tight tracking-tight ${p.cosmos ? "font-extrabold" : "font-semibold"}`}>{title}</h1>
            <p className="text-sm text-on-surface-variant mt-1.5 max-w-3xl">{page.subtitle}</p>
          </div>
          {p.actions && <div className="flex items-center gap-2">{p.actions}</div>}
        </header>
        <div className="px-6 lg:px-10 pb-24">{p.children}</div>
      </main>
    </div>
  );
}
