/**
 * Dix minutes de retard, relevées toutes les 2 s, puis le temps médian de chaque étage.
 *
 * Trois indicateurs de premier rang (D41, audit F-12) : le décalage par mot (du début prononcé
 * d'un mot au début de son écoute), le retard maximal et la pente du retard. « Fin de phrase →
 * voix » (D19) n'est plus qu'un étage parmi les autres : il récompensait l'attente de phrases
 * entières. Le premier son d'une prise de parole reste donné à part.
 */
import type { Lang, LagState, StatsPayload } from "../../../../shared/protocol";
import { LANGS } from "../../ui/langs";
import { delay, perMin } from "../../ui/format";
import { Sparkline } from "../../ui/Sparkline";
import type { Sample } from "../types";
import { TONE_TEXT, type Tone } from "../ui";

function Trend({
  label,
  value,
  caption,
  tone,
  values,
  warn,
  max,
  format = delay,
}: {
  label: string;
  value: number | null;
  caption: string;
  tone: Tone;
  values: (number | null)[];
  warn: number;
  max: number;
  format?: (v: number) => string;
}) {
  const line = tone === "crit" ? "error" : tone === "warn" ? "tertiary" : "secondary";
  return (
    <div className="min-w-0 py-2 md:px-7 md:first:pl-0 md:border-l md:first:border-l-0 border-outline-variant/20">
      <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className={`mt-2 font-metric-mono-lg text-2xl font-semibold leading-none ${tone === "ok" || tone === "idle" ? "text-on-surface" : TONE_TEXT[tone]}`}>{value != null ? format(value) : "—"}</div>
      <div className="text-xs text-on-surface-variant mt-1.5">{caption}</div>
      <Sparkline values={values} warn={warn} max={max} tone={line} className="h-12 mt-3" />
    </div>
  );
}

const toneOf = (v: number | null, warn: number, crit: number): Tone => (v == null ? "idle" : v > crit ? "crit" : v > warn ? "warn" : "ok");

/** « FR 1 · 3,4 s » : palier et retard de file de chaque langue (D42). */
function lagText(lag: Partial<Record<Lang, LagState>> | undefined): string {
  const e = Object.entries(lag ?? {}) as [Lang, LagState][];
  return e.length ? e.map(([l, s]) => `${LANGS[l].short} ${s.tier} · ${delay(s.retardMs)}`).join("  ") : "—";
}

/** Cibles de l'audit : décalage par mot p50 ≤ 4 s et p95 ≤ 6 s (mode progressif), retard ≤ 8 s, pente entre −0,1 et +0,1 s/min. */
const WORD_LAG_OK_MS = 4000;
const WORD_LAG_CRIT_MS = 6000;
const LAG_MAX_OK_MS = 8000;
const SLOPE_OK = 100;

export function Trends({ history, stats }: { history: Sample[]; stats?: StatsPayload }) {
  const sg = stats?.stages;
  const pl = stats?.pipeline;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-y-6">
        <Trend
          label="Décalage par mot"
          value={stats?.wordLagP50 ?? null}
          caption={`médiane, du mot prononcé au mot entendu (estimé)${stats?.wordLagP95 != null ? ` · p95 ${delay(stats.wordLagP95)}` : ""}`}
          tone={toneOf(stats?.wordLagP50 ?? null, WORD_LAG_OK_MS, WORD_LAG_CRIT_MS)}
          values={history.map((s) => s.wordLagP50)}
          warn={WORD_LAG_OK_MS}
          max={15000}
        />
        <Trend
          label="Retard maximal"
          value={stats?.lagMaxMs ?? null}
          caption="le mot le plus en retard, 10 dernières minutes, hors pannes"
          tone={toneOf(stats?.lagMaxMs ?? null, LAG_MAX_OK_MS, 1.5 * LAG_MAX_OK_MS)}
          values={history.map((s) => s.lagMaxMs)}
          warn={LAG_MAX_OK_MS}
          max={20000}
        />
        <Trend
          label="Pente du retard"
          value={stats?.lagSlopeMsPerMin ?? null}
          format={perMin}
          caption={stats?.lagSlopeMsPerMin != null ? "sur 10 minutes · stable entre −0,1 et +0,1 s/min" : "il faut 3 minutes de mesures"}
          tone={toneOf(stats?.lagSlopeMsPerMin ?? null, SLOPE_OK, 5 * SLOPE_OK)}
          values={history.map((s) => (s.lagSlopeMsPerMin != null ? Math.max(0, s.lagSlopeMsPerMin) : null))}
          warn={SLOPE_OK}
          max={2000}
        />
      </div>
      <dl className="flex flex-wrap gap-x-10 gap-y-3 pt-5 border-t border-outline-variant/15">
        {[
          { k: "Fin de phrase → voix", v: stats?.endP50 != null ? delay(stats.endP50) : "—", hint: "étage, D19 · cible 1 s" },
          {
            k: "Premier mot → voix",
            v: stats?.startP50 != null ? delay(stats.startP50) : "—",
            hint: stats?.firstP50 != null ? `prise de parole : ${delay(stats.firstP50)} (${stats.firstN})` : "début du segment → son",
          },
          { k: "File du téléphone", v: stats?.queueMaxMs != null ? delay(stats.queueMaxMs) : "—", hint: "le plus en retard" },
          {
            k: "Rattrapage",
            v: lagText(pl?.lag),
            hint: "palier du contrôleur (D42) : 1 dès 3 s, 2 dès 5 s, 3 dès 8 s",
          },
          { k: "Voix du formateur", v: stats?.uplinkP50Ms != null ? delay(stats.uplinkP50Ms) : "—", hint: "captée → reçue par le serveur" },
          { k: "Reconnaissance", v: sg?.endCommitP50 != null ? delay(sg.endCommitP50) : "—", hint: "fin de phrase → segment figé" },
          { k: "Retard du texte", v: sg?.sttLagP50 != null ? delay(sg.sttLagP50) : "—", hint: "mot prononcé → texte reçu" },
          { k: "Traduction", v: sg?.mtP50 != null ? delay(sg.mtP50) : "—", hint: "appel au moteur" },
          { k: "Synthèse", v: sg?.ttsP50 != null ? delay(sg.ttsP50) : "—", hint: "texte → premier son" },
          { k: "En attente", v: pl ? `${pl.backlog} seg.` : "—", hint: "segments pas encore dits" },
          { k: "Vitesse de la voix", v: pl ? `×${pl.speed.toFixed(2).replace(".", ",")}` : "—", hint: pl && pl.speed >= 1.2 ? "au maximum : le formateur va plus vite" : "dernier segment dit" },
        ].map((x) => (
          <div key={x.k} className="min-w-0">
            <dt className="text-xs text-on-surface-variant">{x.k}</dt>
            <dd className="font-metric-mono-sm text-base font-semibold text-on-surface mt-0.5">{x.v}</dd>
            <dd className="text-[11px] text-outline">{x.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
