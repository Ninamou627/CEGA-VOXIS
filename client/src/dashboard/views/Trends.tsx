/**
 * Dix minutes de latence et de dérive, relevées toutes les 2 s (D7 : la dérive est un
 * indicateur de premier rang), puis le temps médian de chaque étage de la chaîne.
 */
import type { StatsPayload } from "../../../../shared/protocol";
import { delay } from "../../ui/format";
import { Sparkline } from "../../ui/Sparkline";
import type { Sample } from "../types";
import { TONE_TEXT, type Tone } from "../ui";

function Trend({ label, value, caption, tone, values, warn, max }: { label: string; value: number | null; caption: string; tone: Tone; values: (number | null)[]; warn: number; max: number }) {
  const line = tone === "crit" ? "error" : tone === "warn" ? "tertiary" : "secondary";
  return (
    <div className="min-w-0 py-2 md:px-7 md:first:pl-0 md:border-l md:first:border-l-0 border-outline-variant/20">
      <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className={`mt-2 font-metric-mono-lg text-2xl font-semibold leading-none ${tone === "ok" || tone === "idle" ? "text-on-surface" : TONE_TEXT[tone]}`}>{value != null ? delay(value) : "—"}</div>
      <div className="text-xs text-on-surface-variant mt-1.5">{caption}</div>
      <Sparkline values={values} warn={warn} max={max} tone={line} className="h-12 mt-3" />
    </div>
  );
}

const toneOf = (v: number | null, warn: number, crit: number): Tone => (v == null ? "idle" : v > crit ? "crit" : v > warn ? "warn" : "ok");

export function Trends({ history, stats }: { history: Sample[]; stats?: StatsPayload }) {
  const sg = stats?.stages;
  const pl = stats?.pipeline;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-y-6">
        <Trend
          label="Décalage médian"
          value={stats?.e2eP50 ?? null}
          caption="du mot prononcé à la voix entendue · alerte à 2,5 s"
          tone={toneOf(stats?.e2eP50 ?? null, 2500, 4000)}
          values={history.map((s) => s.e2eP50)}
          warn={2500}
          max={5000}
        />
        <Trend
          label="Décalage p95"
          value={stats?.e2eP95 ?? null}
          caption="les 5 % de lectures les plus lentes"
          tone={toneOf(stats?.e2eP95 ?? null, 4000, 6000)}
          values={history.map((s) => s.e2eP95)}
          warn={4000}
          max={8000}
        />
        <Trend
          label="Dérive (file max)"
          value={stats?.queueMaxMs ?? null}
          caption="retard du téléphone le plus en retard · saut à 8 s"
          tone={toneOf(stats?.queueMaxMs ?? null, 2500, 5000)}
          values={history.map((s) => s.queueMaxMs)}
          warn={2500}
          max={8000}
        />
      </div>
      <dl className="flex flex-wrap gap-x-10 gap-y-3 pt-5 border-t border-outline-variant/15">
        {[
          { k: "Reconnaissance", v: sg?.commitP50 != null ? delay(sg.commitP50) : "—", hint: "mot entendu → segment figé" },
          { k: "Traduction", v: sg?.mtP50 != null ? delay(sg.mtP50) : "—", hint: "appel au moteur" },
          { k: "Synthèse", v: sg?.ttsP50 != null ? delay(sg.ttsP50) : "—", hint: "texte → premier son" },
          { k: "En attente", v: pl ? `${pl.backlog} seg.` : "—", hint: "segments pas encore dits" },
          { k: "Vitesse de la voix", v: pl ? `×${pl.speed.toFixed(2).replace(".", ",")}` : "—", hint: pl && pl.speed > 1 ? "rattrapage de la dérive" : "vitesse de base" },
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
