/**
 * Dix minutes de latence et de dérive, relevées toutes les 2 s (D7 : la dérive est un
 * indicateur de premier rang), puis le temps médian de chaque étage de la chaîne.
 *
 * Deux latences (D19) : celle qui valide le projet part de la fin de la phrase prononcée ;
 * le décalage ressenti part du début prononcé de son premier mot, et contient donc le temps
 * de la dire. Le premier son d'une prise de parole est donné à part : c'est l'attente de la
 * salle quand le formateur se met à parler.
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
          label="Fin de phrase → voix"
          value={stats?.endP50 ?? null}
          caption={`médiane${stats?.endP95 != null ? ` · p95 ${delay(stats.endP95)}` : ""} · cible 1 s`}
          tone={toneOf(stats?.endP50 ?? null, 1000, 2000)}
          values={history.map((s) => s.endP50)}
          warn={1000}
          max={4000}
        />
        <Trend
          label="Décalage ressenti"
          value={stats?.startP50 ?? null}
          caption={`médiane, du début de la parole à la voix${stats?.firstP50 != null ? ` · premier son d'une prise de parole ${delay(stats.firstP50)} (${stats.firstN})` : ""}`}
          tone={toneOf(stats?.startP50 ?? null, 3000, 5000)}
          values={history.map((s) => s.startP50)}
          warn={3000}
          max={10000}
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
