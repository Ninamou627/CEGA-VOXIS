/**
 * Supervision en temps réel : chaque étage de la chaîne avec son moteur et sa mesure,
 * les incidents récents, dix minutes de latence et de dérive, la santé du serveur et
 * le flux de ce qui passe réellement dans les écouteurs.
 */
import type { Lang } from "../../../../shared/protocol";
import { ago, delay, hms } from "../../ui/format";
import { LANGS } from "../../ui/langs";
import type { NodeView } from "../nodes";
import type { Alert, Signals, StageId } from "../signals";
import type { Line, Sample } from "../types";
import { Chip, Kv, Section, type Tone } from "../ui";
import { Alerts } from "../views/Alerts";
import { Constellation } from "../views/Constellation";
import { Segments } from "../views/Segments";
import { Trends } from "../views/Trends";

export interface SupervisionProps {
  sig: Signals;
  nodes: NodeView[];
  /** Le micro reçoit de la parole en ce moment. */
  speaking: boolean;
  inspected?: StageId;
  onInspect: (id: StageId) => void;
  alerts: Alert[];
  history: Sample[];
  lines: Line[];
  partial: string;
  srcLang: Lang;
  tgtLang: Lang;
  clockOffset: number;
}

const MODE: Record<string, { label: string; tone: "ok" | "warn" | "crit" }> = {
  none: { label: "Nominal", tone: "ok" },
  "backup-mt": { label: "Traduction de secours", tone: "warn" },
  "backup-tts": { label: "Voix de secours", tone: "warn" },
  "text-only": { label: "Texte seul", tone: "crit" },
  "stt-lost": { label: "Reconnaissance perdue", tone: "crit" },
  s2s: { label: "Chemin de secours S2S", tone: "warn" },
};

const STAGE: Record<string, string> = { stt: "Reconnaissance vocale", mt: "Traduction", tts: "Synthèse vocale" };

export function Supervision(p: SupervisionProps) {
  const { stats, health, overview } = p.sig;
  const pl = stats?.pipeline ?? health?.pipeline;
  const mode = pl ? MODE[pl.degraded] ?? { label: pl.degraded, tone: "warn" as const } : undefined;
  const incidents = Object.entries(overview?.lastErrors ?? {})
    .filter((e): e is [string, { at: number; msg: string; count: number }] => Boolean(e[1]))
    .sort((a, b) => b[1].at - a[1].at);
  const pr = health?.process;
  const au = health?.audio;
  const lagTone: Tone = !pr ? "idle" : pr.loopLagMaxMs > 100 ? "crit" : pr.loopLagMaxMs > 30 ? "warn" : "ok";

  return (
    <>
      <Section
        title="Chaîne de traitement"
        hint="L'état de chaque étage, son moteur et son temps médian sur la dernière minute. Un clic sur un étage ouvre son inspecteur."
        right={
          mode && (
            <span key={pl?.degraded} className="pop">
              <Chip tone={mode.tone}>{mode.label}</Chip>
            </span>
          )
        }
      >
        <Constellation nodes={p.nodes} speaking={p.speaking} micDb={stats?.micDb ?? null} inspected={p.inspected} onInspect={p.onInspect} detailed />
        {incidents.length > 0 && (
          <div className="mt-8">
            <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant mb-1">Derniers incidents</div>
            <ul className="divide-y divide-outline-variant/15">
              {incidents.map(([stage, e]) => (
                <li key={stage} className="grid grid-cols-1 md:grid-cols-[13rem_9rem_minmax(0,1fr)] gap-x-6 gap-y-0.5 py-2.5 text-[13px]">
                  <span className="text-on-surface font-medium">{STAGE[stage] ?? stage}</span>
                  <span className="font-metric-mono-sm text-xs text-on-surface-variant md:pt-px">
                    {ago(e.at, p.sig.now)} · {e.count} erreur{e.count > 1 ? "s" : ""}
                  </span>
                  <span className="font-metric-mono-sm text-xs text-on-surface-variant break-words md:pt-px">{e.msg}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title={p.alerts.length ? `Alertes en cours · ${p.alerts.length}` : "Alertes en cours"}>
        <Alerts alerts={p.alerts} here="supervision" />
      </Section>

      <Section title="Latence et dérive" hint="Dix minutes de relevés, un toutes les 2 secondes. La ligne pointillée marque le seuil d'alerte.">
        <Trends history={p.history} stats={stats} />
      </Section>

      <Section title="Serveur de salle" hint={health ? "Relevé toutes les 5 secondes : ce que regarde un test de tenue sur plusieurs heures." : "En attente du premier relevé…"}>
        <dl className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-12">
          <Kv label="En service depuis" value={stats?.uptimeS != null || health ? hms(stats?.uptimeS ?? health!.uptimeS) : "—"} />
          <Kv label="Processeur" value={pr?.cpuPercent != null ? `${pr.cpuPercent} %` : "—"} tone={pr?.cpuPercent != null && pr.cpuPercent > 60 ? "warn" : undefined} />
          <Kv label="Mémoire" value={pr ? `${pr.rssMb} Mo` : "—"} tone={pr && pr.rssMb > 600 ? "warn" : undefined} />
          <Kv label="Tas JavaScript" value={pr ? `${pr.heapMb} Mo` : "—"} />
          <Kv label="Retard de boucle" value={pr ? `${pr.loopLagMaxMs} ms` : "—"} tone={lagTone} />
          <Kv label="Formateur" value={health ? (health.lecturer ? (pl?.muted ? "connecté · micro coupé" : "connecté") : "absent") : "—"} tone={health && !health.lecturer ? "warn" : undefined} />
          <Kv label="Trames micro reçues" value={au ? au.received.toLocaleString("fr-FR") : "—"} />
          <Kv
            label="Dernière trame"
            value={au?.lastFrameAgoMs != null ? `il y a ${delay(au.lastFrameAgoMs)}` : "—"}
            tone={au?.lastFrameAgoMs != null && au.lastFrameAgoMs > 3000 && health?.lecturer ? "crit" : undefined}
          />
          <Kv label="Flux de reconnaissance" value={au ? (au.sttOpen ? "ouvert" : "fermé") : "—"} tone={au && health?.lecturer && !au.sttOpen ? "crit" : undefined} />
          <Kv label="Audio reçu" value={au ? `${(au.bytes / 1048576).toFixed(1).replace(".", ",")} Mo` : "—"} />
          <Kv label="Niveau du micro" value={stats?.micDb != null ? `${stats.micDb} dB` : "—"} />
          <Kv label="Auditeurs" value={stats ? String(stats.listeners) : health ? String(health.listeners) : "—"} />
        </dl>
      </Section>

      <Section
        title="Flux en direct"
        hint="Ce que le formateur dit, tel que figé par la reconnaissance, et ce que les apprenants entendent. Le motif de coupe aide à régler la segmentation."
        right={
          <span className="font-metric-mono-sm text-xs text-on-surface-variant">
            {LANGS[p.srcLang].short} → {LANGS[p.tgtLang].short} · {p.lines.length} segment{p.lines.length > 1 ? "s" : ""}
          </span>
        }
      >
        <Segments lines={p.lines} partial={p.partial} srcLang={p.srcLang} tgtLang={p.tgtLang} clockOffset={p.clockOffset} />
      </Section>
    </>
  );
}
