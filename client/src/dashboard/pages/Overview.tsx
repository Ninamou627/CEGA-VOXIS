/**
 * Vue d'ensemble : les cinq chiffres de la salle, la chaîne en constellation, ce qui
 * demande une action, et les quatre piliers de la qualité. Tout le reste est à un clic.
 */
import type { Lang } from "../../../../shared/protocol";
import { delay, pct, shortDate, span, spanParts } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { NodeView } from "../nodes";
import type { Alert, Signals, StageId } from "../signals";
import { Accent, Section, Stat, StatStrip, Value, type Tone } from "../ui";
import { Alerts } from "../views/Alerts";
import { Constellation } from "../views/Constellation";
import { pillars, Pillars } from "../views/Pillars";

export interface OverviewProps {
  sig: Signals;
  nodes: NodeView[];
  /** Le micro reçoit de la parole en ce moment. */
  speaking: boolean;
  alerts: Alert[];
  inspected?: StageId;
  onInspect: (id: StageId) => void;
}

const more = (href: string, label = "Détail") => (
  <a href={href} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline underline-offset-4">
    {label}
    <Icon name="arrow_forward" className="text-[15px]" />
  </a>
);

/**
 * Cibles du décalage par mot (D41) : médiane ≤ 4 s, 95ᵉ centile ≤ 6 s — celles que l'audit fixe au
 * mode progressif. En mode « phrases entières », 5 à 10 s sont mesurés : l'indicateur le montre.
 */
const WORD_LAG_TARGET_MS = 4000;
const WORD_LAG_CRIT_MS = 6000;

/** 0.87 → « 0,87 » : le nombre seul, l'unité est posée à côté en petit. */
const dec = (x: number, digits: number) => x.toFixed(digits).replace(".", ",");

function availabilityTone(x: number | null): Tone {
  return x == null ? "idle" : x >= 0.99 ? "ok" : x >= 0.95 ? "warn" : "crit";
}

export function Overview({ sig, nodes, speaking, alerts, inspected, onInspect }: OverviewProps) {
  const { stats, health, overview: ov } = sig;
  const listeners = stats?.listeners ?? health?.listeners ?? 0;
  const byLang = Object.entries(stats?.byLang ?? {}).filter(([, n]) => (n ?? 0) > 0) as [Lang, number][];

  // Indicateur phare (D41) : le décalage par mot, du mot prononcé au mot entendu — médiane de la
  // dernière minute quand la salle écoute, sinon de l'historique. « Fin de phrase → voix » (D19)
  // est désormais un étage de la page Supervision.
  const liveLag = stats?.wordLagP50 ?? null;
  const lagMs = liveLag ?? ov?.wordLag.p50 ?? null;
  const lagP95 = liveLag != null ? (stats?.wordLagP95 ?? null) : (ov?.wordLag.p95 ?? null);
  const lagMax = liveLag != null ? (stats?.lagMaxMs ?? null) : (ov?.quality.lag.maxMs ?? null);
  const latencyTone: Tone = lagMs == null ? "idle" : lagMs > WORD_LAG_CRIT_MS ? "crit" : lagMs > WORD_LAG_TARGET_MS ? "warn" : "ok";

  const crit = alerts.filter((a) => a.severity === "crit").length;
  const warn = alerts.filter((a) => a.severity === "warn").length;
  const info = alerts.length - crit - warn;

  return (
    <>
      <StatStrip>
        <Stat
          icon="groups"
          label="Apprenants connectés"
          value={listeners.toLocaleString("fr-FR")}
          caption={byLang.length ? byLang.map(([l, n]) => `${LANGS[l].flag} ${LANGS[l].short} ${n}`).join("   ") : "aucun téléphone connecté"}
          href="#/seance"
        />
        <Stat
          icon="translate"
          label="Temps de traduction"
          value={ov ? <Value parts={spanParts(ov.all.translatedMs)} /> : "—"}
          caption={ov ? `${span(ov.today.translatedMs)} aujourd'hui · depuis le ${shortDate(ov.since)}` : sig.conn === "open" ? "lecture des compteurs…" : "—"}
          href="#/qualite"
        />
        <Stat
          icon="timer"
          label="Décalage par mot"
          value={lagMs != null ? <Value parts={[[dec(lagMs / 1000, 1), "s"]]} /> : "—"}
          caption={
            lagMs != null
              ? `médiane ${liveLag != null ? "de la dernière minute" : "de l'historique"}${lagP95 != null ? ` · p95 ${delay(lagP95)}` : ""}${lagMax != null ? ` · max ${delay(lagMax)}` : ""}`
              : "aucune écoute mesurée"
          }
          tone={latencyTone}
          href="#/supervision"
        />
        <Stat
          icon="verified_user"
          label="Disponibilité système"
          value={ov?.availability != null ? <Value parts={[[dec(ov.availability * 100, 1), "%"]]} /> : "—"}
          caption={
            ov?.availability != null
              ? `sur ${span(ov.all.sessionMs)} de séance${ov.availabilityToday != null ? ` · aujourd'hui ${pct(ov.availabilityToday, 1)}` : ""}`
              : "aucune séance mesurée"
          }
          tone={availabilityTone(ov?.availability ?? null)}
          href="#/qualite"
        />
        <Stat
          icon="notifications"
          label="Alertes"
          value={crit + warn}
          caption={crit + warn === 0 ? (info ? `${info} information${info > 1 ? "s" : ""}` : "rien à signaler") : [crit && `${crit} critique${crit > 1 ? "s" : ""}`, warn && `${warn} à surveiller`].filter(Boolean).join(" · ")}
          tone={crit ? "crit" : warn ? "warn" : "ok"}
          href="#/supervision"
        />
      </StatStrip>

      <Section
        title={
          <>
            Supervision en <Accent>temps réel</Accent>
          </>
        }
        hint="Du micro du formateur aux écouteurs des apprenants. Les paquets circulent quand la parole passe vraiment ; un clic sur un étage ouvre son inspecteur."
        right={more("#/supervision")}
      >
        <Constellation nodes={nodes} speaking={speaking} micDb={stats?.micDb ?? null} inspected={inspected} onInspect={onInspect} />
      </Section>

      <Section title={alerts.length ? `Alertes · ${alerts.length}` : "Alertes"} hint={alerts.length ? "De la plus grave à la plus légère. Chaque alerte renvoie à la page où agir." : undefined}>
        <Alerts alerts={alerts} limit={5} />
      </Section>

      <Section
        title="Monitoring de qualité"
        hint={ov ? `Depuis le ${shortDate(ov.since)} : quatre mesures, chacune avec sa définition et son échantillon.` : "Lecture des compteurs…"}
        right={more("#/qualite")}
      >
        {ov ? <Pillars items={pillars(ov.quality, ov.days, null, stats?.pipeline.stt ?? health?.pipeline.stt)} /> : <QualityPending error={sig.conn !== "open"} />}
      </Section>
    </>
  );
}

function QualityPending({ error }: { error: boolean }) {
  return <p className="text-[13px] text-on-surface-variant">{error ? "Compteurs indisponibles tant que la liaison avec le serveur est coupée." : "Lecture des compteurs…"}</p>;
}
