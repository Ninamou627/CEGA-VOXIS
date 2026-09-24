/**
 * L'inspecteur d'un étage de la constellation, ouvert d'un clic sur son orbe : ses mesures
 * des dernières minutes et ses incidents, ce qui vient réellement d'y passer, et ses
 * réglages en lecture — ils se modifient sur la page Configuration, où chaque champ dit
 * quand il s'applique. Toutes les valeurs viennent du serveur de salle.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingsResponse } from "../../../../shared/admin";
import type { Lang } from "../../../../shared/protocol";
import type { ConnState } from "../../lib/ws";
import { ago, clock, delay, num, pct, rate, span } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { engineName, voiceName, type NodeView } from "../nodes";
import type { Alert, Signals, StageId } from "../signals";
import type { Line, Sample } from "../types";
import { Action, Dot, TONE_PILL, TONE_TEXT, useModal, type Tone } from "../ui";
import { REASON } from "./Segments";

export interface InspectorProps {
  stage: StageId;
  nodes: NodeView[];
  sig: Signals;
  conf?: SettingsResponse;
  history: Sample[];
  lines: Line[];
  alerts: Alert[];
  clockOffset: number;
  onSelect: (id: StageId) => void;
  onClose: () => void;
}

type Tab = "mesures" | "flux" | "reglages";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "mesures", label: "Mesures", icon: "monitoring" },
  { id: "flux", label: "Flux", icon: "stream" },
  { id: "reglages", label: "Réglages", icon: "tune" },
];

interface Row {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
}

interface Series {
  title: string;
  values: (number | null)[];
  /** Hauteur de barre, de 0 à 1. */
  norm: (v: number) => number;
  format: (v: number) => string;
  current: number | null;
  /** Repère horizontal (le seuil de parole). */
  mark?: { at: number; label: string };
}

const SUBTITLE: Record<StageId, string> = {
  mic: "Micro du formateur, reçu par le serveur de salle",
  audio: "Niveau reçu, comparé au seuil de parole",
  stt: "Reconnaissance vocale : la parole devient du texte",
  mt: "Traduction de chaque segment figé",
  tts: "Synthèse vocale : la traduction devient une voix",
};

const EFFORT: Record<string, string> = { low: "rapide", medium: "équilibré", high: "approfondi" };
const ENDPOINTING: Record<string, string> = { min_latency: "rapide", balanced: "équilibrée", max_accuracy: "précise" };
const LINK_TONE: Record<ConnState, Tone> = { open: "ok", connecting: "warn", reconnecting: "warn", closed: "crit" };
const LINK_LABEL: Record<ConnState, string> = { open: "Mesures en direct", connecting: "Connexion…", reconnecting: "Reconnexion…", closed: "Liaison coupée : valeurs figées" };

const dec = (x: number, digits = 2) => x.toFixed(digits).replace(".", ",");
const signedDb = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)} dB`;
const levelNorm = (v: number) => Math.max(0, Math.min(1, (v + 60) / 60));
const count = (text: string, sep: RegExp) =>
  text
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean).length;

/** Moyennes par paquets : au plus 60 barres pour dix minutes de relevés. */
function buckets(values: (number | null)[], n = 60): (number | null)[] {
  const size = Math.max(1, Math.ceil(values.length / n));
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += size) {
    const chunk = values.slice(i, i + size).filter((v): v is number => v != null);
    out.push(chunk.length ? chunk.reduce((a, b) => a + b, 0) / chunk.length : null);
  }
  return out;
}

function seriesOf(id: StageId, history: Sample[], sig: Signals): Series {
  const st = sig.stats;
  const threshold = sig.room?.speechThresholdDb ?? -35;
  const latency = (title: string, pick: (s: Sample) => number | null, current: number | null): Series => {
    const values = history.map(pick);
    const top = Math.max(500, ...values.filter((v): v is number => v != null));
    return { title, values, norm: (v) => v / top, format: delay, current };
  };
  switch (id) {
    case "mic":
      return { title: "Niveau du micro", values: history.map((s) => s.micDb), norm: levelNorm, format: (v) => `${Math.round(v)} dB`, current: st?.micDb ?? null };
    case "audio":
      return {
        title: "Niveau reçu et seuil de parole",
        values: history.map((s) => s.micDb),
        norm: levelNorm,
        format: (v) => `${Math.round(v)} dB`,
        current: st?.micDb ?? null,
        mark: { at: levelNorm(threshold), label: `seuil ${threshold} dB` },
      };
    case "stt":
      return latency("Temps de reconnaissance (médiane)", (s) => s.commitP50, st?.stages.commitP50 ?? null);
    case "mt":
      return latency("Temps de traduction (médiane)", (s) => s.mtP50, st?.stages.mtP50 ?? null);
    case "tts":
      return latency("Temps de synthèse (médiane)", (s) => s.ttsP50, st?.stages.ttsP50 ?? null);
  }
}

function measuresOf(id: StageId, sig: Signals, conf?: SettingsResponse): Row[] {
  const st = sig.stats;
  const h = sig.health;
  const pl = st?.pipeline ?? h?.pipeline;
  const au = h?.audio;
  const today = sig.overview?.qualityToday;
  const threshold = sig.room?.speechThresholdDb ?? -35;
  switch (id) {
    case "mic":
      return [
        { label: "Formateur", value: h ? (h.lecturer ? "connecté" : "absent") : "—", tone: h && !h.lecturer ? "warn" : undefined },
        { label: "Micro", value: pl ? (pl.muted ? "coupé (sourdine)" : "ouvert") : "—", tone: pl?.muted ? "warn" : undefined },
        { label: "Trames reçues", value: au ? num(au.received) : "—" },
        {
          label: "Dernière trame",
          value: au?.lastFrameAgoMs != null ? `il y a ${delay(au.lastFrameAgoMs)}` : "—",
          tone: au?.lastFrameAgoMs != null && au.lastFrameAgoMs > 3000 && h?.lecturer ? "crit" : undefined,
        },
        { label: "Audio reçu", value: au ? `${(au.bytes / 1048576).toFixed(1).replace(".", ",")} Mo` : "—" },
        { label: "Gain appliqué", value: conf ? signedDb(conf.settings.speech.inputGainDb) : "—" },
      ];
    case "audio": {
      const db = st?.micDb ?? null;
      return [
        { label: "Niveau reçu", value: db != null ? `${db} dB` : "—", tone: db != null && db > -3 ? "crit" : undefined },
        { label: "Seuil de parole", value: `${threshold} dB` },
        {
          label: "Silence",
          value: db == null ? "—" : db > threshold ? "parole en cours" : st?.micSilentS != null ? `depuis ${span(st.micSilentS * 1000)}` : "—",
          tone: db != null && db <= threshold && (st?.micSilentS ?? 0) >= (sig.room?.silenceAlertS ?? 20) ? "warn" : undefined,
        },
        { label: "Alerte de silence", value: `après ${sig.room?.silenceAlertS ?? 20} s` },
      ];
    }
    case "stt":
      return [
        { label: "Moteur", value: engineName(pl?.stt) ?? "—", title: pl?.stt },
        { label: "Flux", value: au ? (au.sttOpen ? "ouvert" : "fermé") : "—", tone: au && h?.lecturer && !au.sttOpen ? "crit" : undefined },
        { label: "Temps médian", value: st?.stages.commitP50 != null ? delay(st.stages.commitP50) : "—", title: "Du mot entendu au segment figé, sur la dernière minute" },
        { label: "Confiance aujourd'hui", value: today?.transcription.confidence != null ? rate(today.transcription.confidence) : "—" },
        { label: "Segments aujourd'hui", value: today ? num(today.transcription.segments) : "—" },
        { label: "Signalés aujourd'hui", value: today ? String(today.transcription.reports) : "—", tone: today?.transcription.reports ? "warn" : undefined },
      ];
    case "mt":
      return [
        { label: "En service", value: engineName(pl?.mt, pl?.degraded === "backup-mt" ? "backup" : "primary") ?? "—", title: pl?.mt, tone: pl?.degraded === "backup-mt" ? "warn" : undefined },
        { label: "Secours", value: engineName(pl?.mt, "backup") ?? "aucun" },
        { label: "Temps médian", value: st?.stages.mtP50 != null ? delay(st.stages.mtP50) : "—", title: "Appel au moteur, sur la dernière minute" },
        { label: "Délai maximal", value: conf ? delay(conf.settings.translation.timeoutMs) : "—" },
        { label: "Qualité aujourd'hui", value: today?.translation.ok != null ? rate(today.translation.ok) : "—" },
        { label: "Échecs aujourd'hui", value: today ? String(today.translation.untranslated) : "—", tone: today?.translation.untranslated ? "warn" : undefined },
      ];
    case "tts":
      return [
        { label: "Moteur", value: engineName(pl?.tts, pl?.degraded === "backup-tts" ? "backup" : "primary") ?? "—", title: pl?.tts, tone: pl?.degraded === "backup-tts" ? "warn" : undefined },
        { label: "Vitesse actuelle", value: pl ? `×${dec(pl.speed)}` : "—", tone: pl && pl.speed > 1 ? "warn" : undefined, title: "Au-dessus de ×1, la voix rattrape la dérive" },
        { label: "Temps médian", value: st?.stages.ttsP50 != null ? delay(st.stages.ttsP50) : "—", title: "Du texte au premier son, sur la dernière minute" },
        { label: "En attente", value: pl ? `${pl.backlog} seg.` : "—" },
        { label: "Dits aujourd'hui", value: today ? num(today.voice.n) : "—" },
        { label: "Naturalité aujourd'hui", value: today?.voice.natural != null ? rate(today.voice.natural) : "—" },
      ];
  }
}

function settingsOf(id: StageId, conf: SettingsResponse): { rows: Row[]; section: "parole" | "traduction" | "voix" } {
  const s = conf.settings;
  const o = conf.options;
  switch (id) {
    case "mic":
      return { section: "parole", rows: [{ label: "Sensibilité du micro", value: signedDb(s.speech.inputGainDb) }] };
    case "audio":
      return {
        section: "parole",
        rows: [
          { label: "Seuil de parole", value: `${s.speech.speechThresholdDb} dB` },
          { label: "Détection de silence", value: `${s.speech.silenceAlertS} s` },
        ],
      };
    case "stt":
      return {
        section: "parole",
        rows: [
          { label: "Fin de phrase", value: o.sttTunable ? ENDPOINTING[s.speech.endpointing] : "non utilisée par ce moteur" },
          { label: "Segmentation", value: `${s.speech.minWords} / ${s.speech.clauseWords} / ${s.speech.maxWords} mots`, title: "minimum / coupe à la proposition / maximum" },
          { label: "Délai de coupe", value: delay(s.speech.segmentTimeoutMs) },
          { label: "Vocabulaire", value: `${count(s.speech.keyterms, /[,\n]/)} termes` },
          { label: "Description de séance", value: s.speech.prompt.trim() ? "renseignée" : "vide" },
        ],
      };
    case "mt": {
      const t = s.translation;
      const label = (e: string) => o.mtEngines.find((x) => x.id === e)?.label ?? e;
      const claude = t.primary === "anthropic" || t.secondary === "anthropic";
      const model = o.models.find((m) => m.id === t.model);
      const rows: Row[] = [
        { label: "Moteur principal", value: label(t.primary) },
        { label: "Moteur secondaire", value: t.secondary === "none" ? "aucun" : label(t.secondary) },
      ];
      if (claude) {
        rows.push({ label: "Modèle", value: model?.label ?? t.model });
        if (model?.temperature) rows.push({ label: "Température", value: dec(t.temperature) });
        else rows.push({ label: "Effort", value: EFFORT[t.effort] ?? t.effort });
      }
      rows.push(
        { label: "Délai maximal", value: delay(t.timeoutMs) },
        { label: "Continuité", value: `${t.contextSegments} seg.` },
        { label: "Contexte linguistique", value: t.domain.trim() ? "renseigné" : "vide" },
        { label: "Glossaire", value: `${t.glossary.split(/[\n;]/).filter((l) => l.indexOf("=") > 0).length} paires` },
      );
      return { section: "traduction", rows };
    }
    case "tts": {
      const langs: Lang[] = [...new Set<Lang>([...o.targetLangs, o.srcLang])];
      return {
        section: "voix",
        rows: [
          ...langs.map((l) => ({ label: `Voix ${LANGS[l].nameFr}`, value: voiceName(conf, l) ?? "voix d'origine" })),
          { label: "Vitesse", value: `×${dec(s.voice.speed)}` },
          { label: "Ton", value: pct(s.voice.stability, 0) },
          { label: "Style", value: pct(s.voice.style, 0) },
          { label: "Volume d'écoute", value: `${s.voice.listenerVolume} %` },
        ],
      };
    }
  }
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6">
      {rows.map((r) => (
        <div key={r.label} className="py-2.5 border-b border-outline-variant/25 min-w-0">
          <dt className="text-[10px] font-metric-mono-sm uppercase tracking-wide text-on-surface-variant truncate">{r.label}</dt>
          <dd className={`mt-0.5 text-sm font-metric-mono-sm font-semibold truncate ${r.tone && r.tone !== "ok" ? TONE_TEXT[r.tone] : "text-on-surface"}`} title={r.title}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function History({ series, history }: { series: Series; history: Sample[] }) {
  const bars = buckets(series.values);
  const minutes = history.length > 1 ? Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60000)) : 0;
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-xs font-metric-mono-sm uppercase text-primary font-semibold">{series.title}</span>
        {series.current != null && (
          <span className="text-[10px] font-metric-mono-sm text-secondary px-2 py-0.5 rounded border border-secondary/30 bg-secondary/10 whitespace-nowrap">maintenant : {series.format(series.current)}</span>
        )}
      </div>
      {bars.some((v) => v != null) ? (
        <div className="relative h-32" aria-hidden="true">
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {bars.map((v, k) => (
              <div key={k} className="flex-1 h-full flex items-end">
                <div
                  className={`w-full rounded-t-sm ${v == null ? "bg-on-surface/10 h-[2px]" : "cz-eq"} ${v != null && series.mark && series.norm(v) < series.mark.at ? "opacity-40" : "opacity-85"}`}
                  style={v == null ? undefined : { height: `${Math.max(4, series.norm(v) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          {series.mark && (
            <div className="absolute inset-x-0 border-t border-dashed border-tertiary/70" style={{ bottom: `${series.mark.at * 100}%` }}>
              <span className="absolute right-0 -top-4 text-[10px] font-metric-mono-sm text-tertiary">{series.mark.label}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="h-32 flex items-center justify-center text-[13px] text-on-surface-variant text-center">Pas encore de relevé : les mesures arrivent toutes les 2 secondes pendant la séance.</p>
      )}
      <div className="flex justify-between text-[10px] font-metric-mono-sm text-outline mt-2 pt-1.5 border-t border-outline-variant/25">
        <span>{minutes ? `il y a ${minutes} min` : "—"}</span>
        <span>maintenant</span>
      </div>
    </section>
  );
}

export function Inspector({ stage, nodes, sig, conf, history, lines, alerts, clockOffset, onSelect, onClose }: InspectorProps) {
  const [tab, setTab] = useState<Tab>("mesures");
  const panel = useRef<HTMLDivElement>(null);
  useModal(onClose);

  const idx = Math.max(0, nodes.findIndex((n) => n.stage.id === stage));
  const node = nodes[idx];
  const s = node.stage;
  const prev = nodes[(idx - 1 + nodes.length) % nodes.length];
  const next = nodes[(idx + 1) % nodes.length];
  const go = (d: number) => onSelect((d < 0 ? prev : next).stage.id);

  // Flèches ← → : étage précédent / suivant (sauf pendant une saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  useEffect(() => panel.current?.focus(), []);

  const incidents = alerts.filter((a) => a.stage === stage);
  const lastError = stage === "stt" || stage === "mt" || stage === "tts" ? sig.overview?.lastErrors[stage] : undefined;
  const threshold = sig.room?.speechThresholdDb ?? -35;

  const recent = (): { key: string; time: string; text: ReactNode; note?: string }[] => {
    if (stage === "mic" || stage === "audio") {
      return history
        .slice(-14)
        .reverse()
        .map((h) => ({
          key: String(h.t),
          time: new Date(h.t).toLocaleTimeString("fr-FR"),
          text: h.micDb != null ? `${h.micDb} dB` : "aucun signal",
          note: h.micDb == null ? undefined : h.micDb > threshold ? "parole" : "silence",
        }));
    }
    const withTime = (l: Line) => (l.tOrigin != null ? clock(l.tOrigin, clockOffset) : "—");
    if (stage === "stt") {
      return lines
        .filter((l) => l.src)
        .slice(-10)
        .reverse()
        .map((l) => ({ key: String(l.seq), time: withTime(l), text: l.src, note: l.reason ? (REASON[l.reason] ?? l.reason) : undefined }));
    }
    return lines
      .filter((l) => l.tgt)
      .slice(-10)
      .reverse()
      .map((l) => ({
        key: String(l.seq),
        time: withTime(l),
        text:
          stage === "mt" ? (
            <>
              <span className="block text-on-surface">{l.tgt}</span>
              <span className="block text-on-surface-variant italic">« {l.src} »</span>
            </>
          ) : (
            l.tgt
          ),
        note: `#${l.seq}`,
      }));
  };

  const FLUX_TITLE: Record<StageId, string> = {
    mic: "Derniers relevés du micro",
    audio: "Derniers relevés du niveau",
    stt: "Derniers segments reconnus",
    mt: "Dernières traductions",
    tts: "Derniers segments confiés à la voix",
  };

  const settings = conf ? settingsOf(stage, conf) : undefined;
  const items = tab === "flux" ? recent() : [];

  return (
    <div id="inspecteur" className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="inspecteur-titre">
      <button type="button" aria-label="Fermer l'inspecteur" onClick={onClose} className="sheet-fade absolute inset-0 bg-black/55 backdrop-blur-sm cursor-default" />
      <div ref={panel} tabIndex={-1} className="drawer-in relative w-full sm:w-[500px] lg:w-[540px] h-full bg-surface border-l border-outline-variant/40 flex flex-col shadow-2xl focus:outline-none">
        {/* En-tête : l'étage, son état, le passage aux étages voisins */}
        <div className="px-5 py-4 border-b border-outline-variant/30 bg-surface-container-low/80 backdrop-blur-md flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center text-primary shrink-0">
              <Icon name={s.icon} className="text-[24px]" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="inspecteur-titre" className="text-sm font-bold tracking-tight uppercase font-metric-mono-sm text-on-surface">
                  {s.label}
                </h2>
                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-metric-mono-sm font-semibold ${TONE_PILL[s.tone]}`}>
                  {s.status}
                  {s.metric ? ` · ${s.metric}` : ""}
                </span>
              </div>
              <p className="text-[11px] text-on-surface-variant font-metric-mono-sm truncate mt-0.5" title={s.engine}>
                {s.engine ? `${SUBTITLE[stage]} · ${s.engine}` : SUBTITLE[stage]}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="hidden sm:flex items-center rounded-lg border border-outline-variant/40 bg-on-surface/[0.04] p-0.5">
              <button type="button" onClick={() => go(-1)} title={`Étage précédent : ${prev.stage.label} (←)`} aria-label={`Étage précédent : ${prev.stage.label}`} className="px-2 py-1 text-[11px] font-metric-mono-sm text-on-surface-variant hover:text-on-surface hover:bg-on-surface/10 rounded">
                ←
              </button>
              <button type="button" onClick={() => go(1)} title={`Étage suivant : ${next.stage.label} (→)`} aria-label={`Étage suivant : ${next.stage.label}`} className="px-2 py-1 text-[11px] font-metric-mono-sm text-on-surface-variant hover:text-on-surface hover:bg-on-surface/10 rounded">
                →
              </button>
            </div>
            <Action icon="close" title="Fermer (Échap)" onClick={onClose} />
          </div>
        </div>

        {/* Onglets */}
        <div role="tablist" aria-label="Vues de l'étage" className="flex items-center gap-5 px-5 border-b border-outline-variant/30 bg-surface-container-lowest/60 text-xs font-metric-mono-sm overflow-x-auto shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`py-3 border-b-2 flex items-center gap-1.5 whitespace-nowrap transition-colors ${tab === t.id ? "border-primary text-primary font-semibold" : "border-transparent text-on-surface-variant hover:text-on-surface"}`}
            >
              <Icon name={t.icon} className="text-[15px]" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-6 text-sm" role="tabpanel">
          {tab === "mesures" && (
            <>
              <History series={seriesOf(stage, history, sig)} history={history} />
              <RowList rows={measuresOf(stage, sig, conf)} />
              <section>
                <h3 className="text-xs font-metric-mono-sm uppercase text-primary font-semibold mb-2">Incidents</h3>
                {incidents.length === 0 && !lastError ? (
                  <p className="flex items-center gap-2 text-[13px] text-on-surface-variant">
                    <Icon name="check_circle" fill className="text-[18px] text-secondary" />
                    Aucun incident sur cet étage.
                  </p>
                ) : (
                  <ul className="divide-y divide-outline-variant/25">
                    {incidents.map((a) => (
                      <li key={a.id} className="py-2.5 flex items-start gap-2.5">
                        <Icon name={a.severity === "crit" ? "error" : a.severity === "warn" ? "warning" : "info"} fill className={`text-[18px] mt-px ${a.severity === "crit" ? "text-error" : a.severity === "warn" ? "text-tertiary" : "text-primary"}`} />
                        <div className="min-w-0">
                          <div className="text-[13px] text-on-surface">{a.title}</div>
                          {a.detail && <div className="text-xs text-on-surface-variant mt-0.5 break-words">{a.detail}</div>}
                        </div>
                      </li>
                    ))}
                    {lastError && (
                      <li className="py-2.5 flex items-start gap-2.5">
                        <Icon name="history" className="text-[18px] mt-px text-on-surface-variant" />
                        <div className="min-w-0">
                          <div className="text-[13px] text-on-surface">
                            Dernière erreur {ago(lastError.at, sig.now)} · {lastError.count} au total
                          </div>
                          <div className="text-xs font-metric-mono-sm text-on-surface-variant mt-0.5 break-words">{lastError.msg}</div>
                        </div>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            </>
          )}

          {tab === "flux" && (
            <section>
              <h3 className="text-xs font-metric-mono-sm uppercase text-primary font-semibold mb-2">{FLUX_TITLE[stage]}</h3>
              {items.length === 0 ? (
                <p className="text-[13px] text-on-surface-variant">Rien encore : cette liste se remplit dès que la parole passe par cet étage.</p>
              ) : (
                <ul className="divide-y divide-outline-variant/25">
                  {items.map((it) => (
                    <li key={it.key} className="rise-in py-2.5 grid grid-cols-[4.5rem_minmax(0,1fr)_auto] gap-x-3 items-baseline">
                      <span className="font-metric-mono-sm text-[11px] text-primary">{it.time}</span>
                      <span className="text-[13px] text-on-surface leading-relaxed min-w-0 break-words">{it.text}</span>
                      {it.note && <span className="font-metric-mono-sm text-[10px] text-on-surface-variant">{it.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "reglages" && (
            <section className="flex flex-col gap-4">
              <p className="text-[13px] text-on-surface-variant leading-relaxed">Les réglages de cet étage, tels qu'ils s'appliquent en ce moment. Ils se modifient sur la page Configuration, qui dit pour chacun s'il agit tout de suite ou au prochain démarrage du micro.</p>
              {settings ? <RowList rows={settings.rows} /> : <p className="text-[13px] text-on-surface-variant">Lecture des réglages…</p>}
              <div>
                <Action tone="halo" icon="tune" href={`#/configuration/${settings?.section ?? ""}`}>
                  Modifier dans Configuration
                </Action>
              </div>
            </section>
          )}
        </div>

        {/* Pied : la fraîcheur des mesures, l'étage suivant */}
        <div className="px-5 py-3 border-t border-outline-variant/30 bg-surface-container-low/80 backdrop-blur-md flex items-center justify-between gap-3 shrink-0">
          <span className="flex items-center gap-2 text-xs font-metric-mono-sm text-on-surface-variant">
            <Dot tone={LINK_TONE[sig.conn]} live={sig.conn === "open"} />
            {LINK_LABEL[sig.conn]}
          </span>
          <Action tone="halo" onClick={() => go(1)}>
            Étage suivant
            <Icon name="arrow_forward" className="text-[15px]" />
          </Action>
        </div>
      </div>
    </div>
  );
}
