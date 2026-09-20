/**
 * Les six chiffres qui disent si la salle va bien, avec dix minutes d'historique
 * pour le décalage et la dérive (D7 : la dérive est un indicateur de premier rang).
 */
import type { Lang, StatsPayload } from "../../../../shared/protocol";
import { delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { Sparkline } from "../../ui/Sparkline";
import type { Sample } from "../types";

export interface KpisProps {
  stats?: StatsPayload;
  history: Sample[];
}

type Tone = "" | "warn" | "crit";
const VALUE: Record<Tone, string> = { "": "text-on-surface", warn: "text-tertiary", crit: "text-error" };
const LINE: Record<Tone, "secondary" | "tertiary" | "error"> = { "": "secondary", warn: "tertiary", crit: "error" };

function Tile({ icon, label, value, sub, tone = "", spark }: { icon: string; label: string; value: string; sub?: string; tone?: Tone; spark?: { values: (number | null)[]; warn: number; max?: number } }) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-1.5 text-on-surface-variant">
        <Icon name={icon} className="text-[16px]" />
        <span className="text-[10px] font-label-badge font-bold uppercase tracking-wider truncate">{label}</span>
      </div>
      <span className={`font-metric-mono-lg text-2xl font-bold tracking-tight transition-colors ${VALUE[tone]}`}>{value}</span>
      {sub && <span className="text-[11px] text-on-surface-variant truncate">{sub}</span>}
      {spark && <Sparkline values={spark.values} warn={spark.warn} max={spark.max} tone={LINE[tone]} className="h-7" />}
    </div>
  );
}

export function Kpis({ stats, history }: KpisProps) {
  const e2e = stats?.e2eP50 ?? null;
  const e2eTone: Tone = e2e == null ? "" : e2e > 4000 ? "crit" : e2e > 2500 ? "warn" : "";
  const q = stats?.queueMaxMs ?? null;
  const qTone: Tone = q == null ? "" : q > 5000 ? "crit" : q > 2500 ? "warn" : "";
  const mic = stats?.micDb ?? null;
  const micTone: Tone = mic == null ? "" : mic > -35 ? "" : mic > -50 ? "warn" : "crit";
  const pl = stats?.pipeline;
  const byLang = Object.entries(stats?.byLang ?? {}).filter(([, n]) => (n ?? 0) > 0) as [Lang, number][];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
      <Tile
        icon="timer"
        label="Bout-en-bout p50"
        value={e2e != null ? delay(e2e) : "—"}
        sub="cible 1,5 s · alerte 2,5 s"
        tone={e2eTone}
        spark={{ values: history.map((s) => s.e2eP50), warn: 2500, max: 5000 }}
      />
      <Tile icon="avg_pace" label="Bout-en-bout p95" value={stats?.e2eP95 != null ? delay(stats.e2eP95) : "—"} sub="fenêtre glissante 60 s" tone={stats?.e2eP95 != null && stats.e2eP95 > 4000 ? "warn" : ""} />
      <Tile
        icon="hourglass_top"
        label="File max (dérive)"
        value={q != null ? delay(q) : "—"}
        sub={stats?.queueP50Ms != null ? `p50 ${delay(stats.queueP50Ms)} · saut à 8 s` : "saut à 8 s"}
        tone={qTone}
        spark={{ values: history.map((s) => s.queueMaxMs), warn: 2500, max: 8000 }}
      />
      <Tile
        icon="headphones"
        label="Auditeurs"
        value={String(stats?.listeners ?? 0)}
        sub={byLang.length ? byLang.map(([l, n]) => `${LANGS[l].flag} ${LANGS[l].short} ${n}`).join("  ") : "aucun téléphone connecté"}
        tone={stats && stats.listeners === 0 ? "warn" : ""}
      />
      <Tile
        icon={mic != null && mic > -35 ? "mic" : "mic_off"}
        label="Micro formateur"
        value={mic != null ? `${mic} dB` : "—"}
        sub={mic == null ? "aucun signal reçu" : mic > -35 ? "parole reçue" : mic > -50 ? "niveau faible" : `silence depuis ${stats?.micSilentS ?? 0} s`}
        tone={micTone}
      />
      <Tile
        icon="memory"
        label="Pipeline"
        value={pl ? `${pl.backlog} seg.` : "—"}
        sub={pl ? `en attente · voix ×${pl.speed.toFixed(2).replace(".", ",")}${pl.muted ? " · muet" : ""}` : "en attente du serveur"}
        tone={pl ? (pl.degraded !== "none" ? "crit" : pl.backlog > 2 || pl.speed > 1 ? "warn" : "") : ""}
      />
    </div>
  );
}
