/**
 * Bandeau du poste formateur (maquette « Formateur Control Hub ») : marque, état de
 * la connexion, session et chrono, micro et niveau reçu par le serveur, auditeurs,
 * thème, arrêt de la session en deux temps.
 */
import type { Lang } from "../../../shared/protocol";
import type { ConnState } from "../lib/ws";
import { hms } from "../ui/format";
import { Icon } from "../ui/Icon";
import { LANGS } from "../ui/langs";
import { ThemeToggle } from "../ui/ThemeToggle";

export interface HeaderProps {
  running: boolean;
  conn: ConnState;
  session?: string;
  /** Secondes depuis le démarrage du micro. */
  elapsedS: number;
  micLabel?: string;
  muted: boolean;
  /** Niveau reçu par le serveur (dBFS), null avant la première mesure. */
  serverDb: number | null;
  listeners?: number;
  srcLang: Lang;
  /** Premier clic : armé ; second clic dans les 4 s : arrêt. */
  stopArmed: boolean;
  onStop: () => void;
}

const LIVE: Record<ConnState, { label: string; cls: string; dot: string }> = {
  open: { label: "LIVE", cls: "bg-secondary/15 border-secondary/30 text-secondary", dot: "bg-secondary animate-ping" },
  connecting: { label: "SYNC", cls: "bg-tertiary/15 border-tertiary/30 text-tertiary", dot: "bg-tertiary animate-pulse" },
  reconnecting: { label: "SYNC", cls: "bg-tertiary/15 border-tertiary/30 text-tertiary", dot: "bg-tertiary animate-pulse" },
  closed: { label: "OFF", cls: "bg-error/15 border-error/30 text-error", dot: "bg-error" },
};

export function Header(p: HeaderProps) {
  const live = p.running ? LIVE[p.conn] : { label: "PRÊT", cls: "bg-surface-container-high border-outline-variant/30 text-on-surface-variant", dot: "bg-outline" };
  const micOn = p.running && !p.muted;
  return (
    <header className="sticky top-0 z-50 h-20 w-full bg-surface-container-lowest/90 backdrop-blur-xl border-b border-outline-variant/30 px-6 lg:px-8 flex items-center justify-between transition-colors shadow-lg">
      {/* Marque et état du direct */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-container to-secondary-container/40 p-0.5 shadow-md flex items-center justify-center">
            <div className="w-full h-full bg-surface-container-lowest rounded-[10px] flex items-center justify-center">
              <Icon name="graphic_eq" className="text-secondary text-[22px]" />
            </div>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-headline-md text-lg font-bold tracking-tight text-on-surface">VOXIS</span>
              <span className="text-xs uppercase tracking-widest text-primary font-label-badge font-bold whitespace-nowrap">Live Studio</span>
              <div className={`flex items-center gap-1.5 border px-2.5 py-0.5 rounded-full text-[11px] font-label-badge font-bold ml-1 ${live.cls}`}>
                <span className={`w-2 h-2 rounded-full ${live.dot}`}></span>
                <span>{live.label}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="hidden md:block h-7 w-px bg-outline-variant/40 mx-1"></div>
        {/* Session et chrono */}
        <div className="hidden lg:flex items-center gap-3 bg-surface-container-low border border-outline-variant/30 px-3.5 py-1.5 rounded-xl">
          <span className="text-xs text-on-surface-variant font-medium whitespace-nowrap">{p.session ?? "Session"}</span>
          <span className="text-outline-variant">•</span>
          <div className="flex items-center gap-1.5 text-secondary font-metric-mono-sm text-xs font-semibold whitespace-nowrap" title="Durée de la session">
            <Icon name="schedule" className="text-[15px]" />
            <span>{hms(p.elapsedS)}</span>
          </div>
        </div>
      </div>

      {/* Centre : micro et auditeurs */}
      <div className="hidden xl:flex items-center gap-4">
        <div className="flex items-center gap-2.5 bg-surface-container-low border border-outline-variant/30 px-3 py-1.5 rounded-xl" title="Statut micro formateur">
          <div className="relative flex items-center justify-center">
            <Icon name={micOn ? "mic" : "mic_off"} className={`text-[18px] ${micOn ? "text-secondary" : p.running ? "text-error" : "text-outline"}`} />
            <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${micOn ? "bg-secondary" : p.running ? "bg-error" : "bg-outline"}`}></span>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-xs font-bold text-on-surface truncate max-w-[200px]">{p.micLabel ?? "Micro non ouvert"}</span>
              <span className="font-metric-mono-sm text-[11px] text-secondary font-semibold" title="Niveau reçu par le serveur">
                {p.serverDb != null ? `${p.serverDb} dB` : "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5 bg-surface-container-low border border-outline-variant/30 px-3.5 py-1.5 rounded-xl">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Icon name="headphones" className="text-[18px]" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-headline-sm text-xs font-bold text-on-surface whitespace-nowrap">
                {p.listeners ?? 0} auditeur{(p.listeners ?? 0) > 1 ? "s" : ""} connecté{(p.listeners ?? 0) > 1 ? "s" : ""}
              </span>
              <span className={`flex h-1.5 w-1.5 rounded-full ${(p.listeners ?? 0) > 0 ? "bg-secondary" : "bg-outline"}`}></span>
            </div>
          </div>
        </div>
      </div>

      {/* Droite : thème, arrêt, langue du formateur */}
      <div className="flex items-center gap-3">
        <ThemeToggle variant="square" />
        {p.running && (
          <button
            type="button"
            onClick={p.onStop}
            title={p.stopArmed ? "Cliquez encore pour arrêter" : "Arrête le micro et ferme la session"}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border font-headline-sm text-xs font-bold whitespace-nowrap transition-all active:scale-95 cursor-pointer shadow-md ${
              p.stopArmed ? "bg-error-container text-on-error-container border-error" : "bg-error-container/80 hover:bg-error-container text-on-error-container border-error/30"
            }`}
          >
            <Icon name="stop_circle" className="text-[18px]" />
            <span>{p.stopArmed ? "Confirmer l'arrêt" : "Terminer la session"}</span>
          </button>
        )}
        <div className="relative ml-1 pl-2 border-l border-outline-variant/30" title={`Langue du formateur : ${LANGS[p.srcLang].label}`}>
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-primary to-secondary p-0.5 flex items-center justify-center">
            <div className="w-full h-full rounded-[10px] bg-surface-container-highest flex items-center justify-center font-bold text-xs text-on-surface">{LANGS[p.srcLang].short}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
