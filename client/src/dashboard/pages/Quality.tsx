/**
 * Monitoring de qualité : les quatre piliers sur la période choisie, la tendance sur
 * quatorze jours, les signalements des apprenants par cause et un par un, et la façon
 * dont chaque chiffre est calculé — pour pouvoir le défendre devant un client.
 */
import { useState } from "react";
import type { DayRow, RecentReport } from "../../../../shared/admin";
import { delay, pct, rate, shortDate, span } from "../../ui/format";
import type { Signals } from "../signals";
import { Empty, Section, Segmented } from "../ui";
import { pillars, Pillars } from "../views/Pillars";
import { ReportBreakdown, ReportList } from "../views/Reports";

export interface QualityProps {
  sig: Signals;
  voiceName: (id: string) => string | undefined;
}

const key = (r: RecentReport) => `${r.at}-${r.who}-${r.kind}`;

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

function Days({ days }: { days: DayRow[] }) {
  const rows = days.slice().reverse();
  const cell = "py-2.5 px-3 text-right font-metric-mono-sm text-[13px] whitespace-nowrap";
  const dash = <span className="text-outline">—</span>;
  return (
    <div className="overflow-x-auto -mx-6 lg:mx-0 px-6 lg:px-0">
      <table className="w-full min-w-[760px] border-collapse">
        <thead>
          <tr className="border-b border-outline-variant/20 text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">
            <th className="py-2 pr-3 text-left font-bold">Jour</th>
            <th className="py-2 px-3 text-right font-bold">Séance</th>
            <th className="py-2 px-3 text-right font-bold">Voix diffusée</th>
            <th className="py-2 px-3 text-right font-bold">Disponibilité</th>
            <th className="py-2 px-3 text-right font-bold">Latence</th>
            <th className="py-2 px-3 text-right font-bold">Transcription</th>
            <th className="py-2 px-3 text-right font-bold">Traduction</th>
            <th className="py-2 px-3 text-right font-bold">Voix</th>
            <th className="py-2 pl-3 text-right font-bold">Signalés</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => {
            const idle = !d.sessionMs && !d.translatedMs;
            return (
              <tr key={d.day} className={`border-b border-outline-variant/15 ${idle ? "text-outline" : "text-on-surface"}`}>
                <td className="py-2.5 pr-3 text-[13px] whitespace-nowrap">
                  {dayLabel(d.day)}
                  {i === 0 && <span className="ml-2 text-[10px] font-label-badge font-bold uppercase tracking-wider text-primary">aujourd'hui</span>}
                </td>
                <td className={cell}>{d.sessionMs ? span(d.sessionMs) : dash}</td>
                <td className={cell}>{d.translatedMs ? span(d.translatedMs) : dash}</td>
                <td className={`${cell} ${d.availability != null && d.availability < 0.99 ? "text-tertiary" : ""}`}>{d.availability != null ? pct(d.availability, 1) : dash}</td>
                <td className={`${cell} ${d.e2eMean != null && d.e2eMean > 2500 ? "text-tertiary" : ""}`}>{d.e2eMean != null ? delay(d.e2eMean) : dash}</td>
                <td className={cell}>{d.confidence != null ? rate(d.confidence) : dash}</td>
                <td className={cell}>{d.translationOk != null ? rate(d.translationOk) : dash}</td>
                <td className={cell}>{d.voiceNatural != null ? rate(d.voiceNatural) : dash}</td>
                <td className={`py-2.5 pl-3 text-right font-metric-mono-sm text-[13px] ${d.reports ? "text-tertiary font-semibold" : ""}`}>{d.reports || dash}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const METHOD: { term: string; def: string }[] = [
  {
    term: "Rapidité",
    def: "Temps écoulé entre le mot prononcé par le formateur et le moment où le téléphone de l'apprenant commence à le dire, mesuré par l'accusé de lecture de chaque téléphone. Moyenne, et 95ᵉ centile sur l'historique.",
  },
  {
    term: "Transcription",
    def: "Confiance que le moteur de reconnaissance attribue aux mots reconnus, moyennée par segment. C'est l'estimation du moteur lui-même, pas une vérification humaine ; les signalements « mauvaise transcription » la complètent.",
  },
  {
    term: "Traduction",
    def: "Part des segments traduits sans signalement « mauvaise traduction » et sans échec (segment resté dans la langue source).",
  },
  {
    term: "Voix",
    def: "Part des segments dits par la voix sans signalement « voix peu naturelle ». Le même calcul, voix par voix, est sur la page Voix.",
  },
  {
    term: "Disponibilité",
    def: "Part du temps de séance (formateur connecté, micro démarré) pendant lequel la reconnaissance était ouverte et la voix servie, hors mode « texte seul ».",
  },
  {
    term: "Temps de traduction",
    def: "Durée cumulée de voix traduite effectivement diffusée aux apprenants.",
  },
];

export function Quality({ sig, voiceName }: QualityProps) {
  const [period, setPeriod] = useState<"today" | "all">("all");
  const ov = sig.overview;
  if (!ov) {
    return (
      <Section title="Les quatre piliers">
        <Empty icon={sig.conn === "open" ? "hourglass_top" : "cloud_off"}>{sig.conn === "open" ? "Lecture des compteurs…" : "Compteurs indisponibles tant que la liaison avec le serveur est coupée."}</Empty>
      </Section>
    );
  }

  const seen = new Set(ov.reports.map(key));
  const reports = [...sig.reports.filter((r) => !seen.has(key(r))), ...ov.reports].sort((a, b) => b.at - a.at);
  const q = period === "today" ? ov.qualityToday : ov.quality;
  const stt = sig.stats?.pipeline.stt ?? sig.health?.pipeline.stt;

  return (
    <>
      <Section
        title="Les quatre piliers"
        hint={`${period === "today" ? "Aujourd'hui" : `Depuis le ${shortDate(ov.since)}`} — les barres montrent les quatorze derniers jours, aujourd'hui à droite.`}
        right={
          <Segmented
            value={period}
            onChange={setPeriod}
            options={[
              { value: "today", label: "Aujourd'hui" },
              { value: "all", label: "Depuis le début" },
            ]}
          />
        }
      >
        <Pillars items={pillars(q, ov.days, null, stt)} detailed />
      </Section>

      <Section title="Signalements par cause" hint="Chaque cause désigne un étage où agir : c'est la première chose à regarder après une séance.">
        <ReportBreakdown today={ov.today.reports} all={ov.all.reports} />
      </Section>

      <Section title={reports.length ? `Derniers signalements · ${reports.length}` : "Derniers signalements"} hint="Le passage visé est retrouvé par le serveur : l'apprenant n'a rien à ressaisir.">
        <ReportList reports={reports} now={sig.now} voiceName={voiceName} />
      </Section>

      <Section title="Quatorze derniers jours">
        <Days days={ov.days} />
      </Section>

      <Section title="Comment ces chiffres sont calculés" hint="Aucune note n'est inventée : chaque chiffre vient d'une mesure faite pendant la séance.">
        <dl className="grid grid-cols-1 lg:grid-cols-2 gap-x-12">
          {METHOD.map((m) => (
            <div key={m.term} className="py-3 border-b border-outline-variant/15">
              <dt className="text-[13px] font-semibold text-on-surface">{m.term}</dt>
              <dd className="text-[13px] text-on-surface-variant leading-relaxed mt-0.5">{m.def}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
