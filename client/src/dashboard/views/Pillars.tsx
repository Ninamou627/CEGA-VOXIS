/**
 * Les quatre piliers de la qualité. Chacun a une mesure définie et son échantillon :
 * pas de note inventée, un chiffre qu'on peut expliquer à un client.
 *
 *   1. Rapidité      — décalage par mot moyen, du mot prononcé au mot entendu (D41) ; avant cette
 *                      mesure, premier mot reconnu → voix ;
 *   2. Transcription — confiance moyenne donnée par le moteur de reconnaissance ;
 *   3. Traduction    — part des segments sans signalement « mauvaise traduction » ni échec ;
 *   4. Voix          — part des segments sans signalement « voix peu naturelle ».
 */
import type { DayRow, Quality } from "../../../../shared/admin";
import { delay, num, perMin, rate, secs } from "../../ui/format";
import { Bars, Ring, TONE_TEXT, type Tone } from "../ui";

export interface Pillar {
  n: number;
  key: "speed" | "transcription" | "translation" | "voice";
  title: string;
  metric: string;
  value: string;
  ring: number | null;
  tone: Tone;
  definition: string;
  sample: string;
  /** Série des 14 derniers jours pour la page Qualité. */
  series: (number | null)[];
  seriesMax?: number;
}

const rateTone = (x: number | null, ok: number, warn: number): Tone => (x == null ? "idle" : x >= ok ? "ok" : x >= warn ? "warn" : "crit");

/** Cibles du décalage par mot (D41) : 4 s, et 6 s au-delà desquelles c'est critique. */
const LAG_OK_MS = 4000;
const LAG_CRIT_MS = 6000;

/** Rapidité : le décalage par mot quand on l'a mesuré (D41), sinon l'ancienne mesure. */
function speedPillar(q: Quality, days: DayRow[], liveMeanMs: number | null): Pillar {
  const l = q.lag;
  if (l.n > 0 || liveMeanMs != null) {
    const ms = liveMeanMs ?? l.meanMs;
    return {
      n: 1,
      key: "speed",
      title: "Rapidité",
      metric: "Décalage par mot",
      value: ms != null ? secs(ms) : "—",
      // L'anneau est plein à la cible (4 s) et se vide au-delà.
      ring: ms != null ? Math.min(1, LAG_OK_MS / Math.max(1, ms)) : null,
      tone: ms == null ? "idle" : ms <= LAG_OK_MS ? "ok" : ms <= LAG_CRIT_MS ? "warn" : "crit",
      definition: `${liveMeanMs != null ? "moyenne de la dernière minute" : "moyenne historique"}, du mot prononcé au même mot entendu (estimé)`,
      sample: [
        `${num(l.n)} mots`,
        l.p95Ms != null && `p95 ${delay(l.p95Ms)}`,
        l.maxMs != null && `max ${delay(l.maxMs)}`,
        l.slopeMaxMsPerMin != null && `pente max ${perMin(l.slopeMaxMsPerMin)}`,
        q.speed.reports && `${q.speed.reports} signalée${q.speed.reports > 1 ? "s" : ""} lente${q.speed.reports > 1 ? "s" : ""}`,
      ]
        .filter(Boolean)
        .join(" · "),
      series: days.map((d) => d.wordLagMean),
      seriesMax: 15000,
    };
  }
  const speedMs = q.speed.meanMs;
  return {
    n: 1,
    key: "speed",
    title: "Rapidité",
    metric: "Latence de traduction",
    value: speedMs != null ? secs(speedMs) : "—",
    // L'anneau est plein à la cible (1,5 s) et se vide au-delà.
    ring: speedMs != null ? Math.min(1, 1500 / speedMs) : null,
    tone: speedMs == null ? "idle" : speedMs <= 2500 ? "ok" : speedMs <= 4000 ? "warn" : "crit",
    definition: "moyenne historique, du premier mot reconnu à la voix entendue (mesure d'avant le décalage par mot)",
    sample: q.speed.n ? `${num(q.speed.n)} lectures${q.speed.p95Ms != null ? ` · p95 ${delay(q.speed.p95Ms)}` : ""}${q.speed.reports ? ` · ${q.speed.reports} signalée${q.speed.reports > 1 ? "s" : ""} lente${q.speed.reports > 1 ? "s" : ""}` : ""}` : "aucune lecture mesurée",
    series: days.map((d) => d.e2eMean),
    seriesMax: 4000,
  };
}

export function pillars(q: Quality, days: DayRow[], liveMeanMs: number | null, sttName?: string): Pillar[] {
  const mock = sttName?.includes("mock");
  return [
    speedPillar(q, days, liveMeanMs),
    {
      n: 2,
      key: "transcription",
      title: "Transcription",
      metric: "Précision de la reconnaissance",
      value: q.transcription.confidence != null ? rate(q.transcription.confidence) : "—",
      ring: q.transcription.confidence,
      tone: rateTone(q.transcription.confidence, 0.9, 0.8),
      definition: "confiance moyenne que le moteur accorde aux mots reconnus",
      sample:
        q.transcription.n > 0
          ? `${num(q.transcription.n)} segments · ${q.transcription.reports} signalement${q.transcription.reports > 1 ? "s" : ""}`
          : mock
            ? "le simulateur ne donne pas de confiance"
            : "pas encore de segment reconnu",
      series: days.map((d) => d.confidence),
      seriesMax: 1,
    },
    {
      n: 3,
      key: "translation",
      title: "Traduction",
      metric: "Qualité de la traduction",
      value: q.translation.ok != null ? rate(q.translation.ok) : "—",
      ring: q.translation.ok,
      tone: rateTone(q.translation.ok, 0.97, 0.92),
      definition: "segments traduits sans signalement « mauvaise traduction » ni échec",
      sample: q.translation.n
        ? `${num(q.translation.n)} segments · ${q.translation.reports} signalé${q.translation.reports > 1 ? "s" : ""}${q.translation.untranslated ? ` · ${q.translation.untranslated} échec${q.translation.untranslated > 1 ? "s" : ""}` : ""}`
        : "aucun segment traduit",
      series: days.map((d) => d.translationOk),
      seriesMax: 1,
    },
    {
      n: 4,
      key: "voice",
      title: "Voix",
      metric: "Naturalité de la voix",
      value: q.voice.natural != null ? rate(q.voice.natural) : "—",
      ring: q.voice.natural,
      tone: rateTone(q.voice.natural, 0.97, 0.92),
      definition: "segments dits sans signalement « voix peu naturelle »",
      sample: q.voice.n ? `${num(q.voice.n)} segments dits · ${q.voice.reports} signalé${q.voice.reports > 1 ? "s" : ""}${q.voice.audioReports ? ` · ${q.voice.audioReports} son` : ""}` : "aucun segment dit",
      series: days.map((d) => d.voiceNatural),
      seriesMax: 1,
    },
  ];
}

/** Les quatre piliers en bandeau : un filet vertical entre chacun, pas de boîte. */
export function Pillars({ items, detailed }: { items: Pillar[]; detailed?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 xl:divide-x divide-outline-variant/20">
      {items.map((p) => (
        <div key={p.key} className="py-4 xl:px-6 xl:first:pl-0 flex flex-col gap-3 min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">
            <span className="text-primary">{p.n}.</span>
            {p.title}
          </div>
          <div className="flex items-center gap-4">
            <Ring value={p.ring} tone={p.tone} size={detailed ? 64 : 52} />
            <div className="min-w-0">
              <div className={`font-metric-mono-lg ${detailed ? "text-[30px]" : "text-[26px]"} leading-none font-semibold tracking-tight ${p.tone === "ok" || p.tone === "idle" ? "text-on-surface" : TONE_TEXT[p.tone]}`}>{p.value}</div>
              <div className="text-[13px] text-on-surface mt-1.5">{p.metric}</div>
            </div>
          </div>
          <div className="text-xs text-on-surface-variant leading-relaxed">
            {p.definition}
            <div className="font-metric-mono-sm text-[11px] text-outline mt-1">{p.sample}</div>
          </div>
          {detailed && (
            <div className="pt-1 mt-auto">
              <Bars values={p.series} max={p.seriesMax} tone={p.tone === "idle" ? "ok" : p.tone} />
              <div className="flex justify-between text-[10px] font-metric-mono-sm text-outline mt-1">
                <span>il y a 14 j</span>
                <span>aujourd'hui</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
