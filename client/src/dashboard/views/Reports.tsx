/**
 * Signalements des apprenants : combien par cause (aujourd'hui, depuis le début), et les
 * derniers avec leur passage. C'est la donnée qui fait progresser le système entre deux
 * séances (glossaire, segmentation, choix de voix) ; tout est aussi dans le JSONL.
 */
import type { RecentReport } from "../../../../shared/admin";
import type { ReportKind } from "../../../../shared/protocol";
import { ago, delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { REPORT_LABEL } from "../../ui/reports";
import { Empty, Meter } from "../ui";

const ORDER: ReportKind[] = ["transcription", "translation", "slow", "voice", "audio"];

/** Ce que chaque cause met en cause, pour savoir où agir. */
const WHERE: Record<ReportKind, string> = {
  transcription: "reconnaissance : vocabulaire, micro",
  translation: "traduction : glossaire, contexte",
  slow: "latence : moteur, délai, segmentation",
  voice: "voix : choix de la voix, ton",
  audio: "son : Wi-Fi, volume, téléphone",
};

export function ReportBreakdown({ today, all }: { today: Partial<Record<ReportKind, number>>; all: Partial<Record<ReportKind, number>> }) {
  const top = Math.max(1, ...ORDER.map((k) => all[k] ?? 0));
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_10rem_5.5rem_5.5rem] gap-x-4 pb-2 border-b border-outline-variant/20 text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">
        <span>Cause</span>
        <span className="hidden sm:block" />
        <span className="text-right">Aujourd'hui</span>
        <span className="text-right">Total</span>
      </div>
      {ORDER.map((k) => (
        <div key={k} className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] sm:grid-cols-[minmax(0,1fr)_10rem_5.5rem_5.5rem] gap-x-4 items-center py-3 border-b border-outline-variant/15">
          <div className="flex items-center gap-3 min-w-0">
            <Icon name={REPORT_LABEL[k].icon} className="text-[18px] text-on-surface-variant shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] text-on-surface truncate">{REPORT_LABEL[k].label}</div>
              <div className="text-xs text-outline truncate">{WHERE[k]}</div>
            </div>
          </div>
          <Meter value={(all[k] ?? 0) / top} tone={(all[k] ?? 0) ? "warn" : "idle"} className="hidden sm:block w-full" />
          <span className={`font-metric-mono-sm text-sm text-right ${today[k] ? "text-tertiary font-semibold" : "text-outline"}`}>{today[k] ?? 0}</span>
          <span className="font-metric-mono-sm text-sm text-right text-on-surface">{all[k] ?? 0}</span>
        </div>
      ))}
    </div>
  );
}

export function ReportList({ reports, now, voiceName }: { reports: RecentReport[]; now: number; voiceName: (id: string) => string | undefined }) {
  if (!reports.length) {
    return (
      <Empty icon="flag">
        Aucun signalement. Les apprenants peuvent en envoyer cinq sortes depuis leur téléphone ; chacun arrive ici avec l'heure, la phrase, sa traduction et la voix qui l'a dite.
      </Empty>
    );
  }
  return (
    <ul className="divide-y divide-outline-variant/15 max-h-[560px] overflow-y-auto -mt-3">
      {reports.map((r) => {
        const voice = r.voice ? voiceName(r.voice) : undefined;
        return (
          <li key={`${r.at}-${r.who}-${r.kind}`} className="rise-in grid grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)] gap-x-6 gap-y-1.5 py-3.5">
            <div className="flex md:flex-col gap-x-3 gap-y-1 text-xs">
              <span className="flex items-center gap-2 text-[13px] font-medium text-on-surface">
                <Icon name={REPORT_LABEL[r.kind].icon} className="text-[17px] text-tertiary" />
                {REPORT_LABEL[r.kind].label}
              </span>
              <span className="font-metric-mono-sm text-outline" title={new Date(r.at).toLocaleString("fr-FR")}>
                {new Date(r.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · {ago(r.at, now)}
              </span>
            </div>
            <div className="min-w-0">
              {r.srcText || r.text ? (
                <>
                  {r.text && <p className="text-sm text-on-surface leading-snug">“{r.text}”</p>}
                  {r.srcText && <p className="text-[13px] text-on-surface-variant italic leading-relaxed mt-0.5">« {r.srcText} »</p>}
                </>
              ) : (
                <p className="text-[13px] text-on-surface-variant">Aucun segment en cours d'écoute au moment du signalement.</p>
              )}
              <p className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 font-metric-mono-sm text-[11px] text-outline">
                <span>
                  {LANGS[r.lang].flag} {LANGS[r.lang].short}
                </span>
                {r.seq != null && <span>segment #{r.seq}</span>}
                {r.e2eMs != null && <span>décalage {delay(r.e2eMs)}</span>}
                {voice && <span>voix {voice}</span>}
                <span>apprenant {r.who.slice(-4).toUpperCase()}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
