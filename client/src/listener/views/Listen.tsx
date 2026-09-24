/**
 * Vue « Listen » : l'écran d'écoute de la maquette, branché sur l'état réel.
 * Purement présentationnelle — l'état et les actions viennent de App.
 */
import { useEffect, useRef } from "react";
import type { Lang } from "../../../../shared/protocol";
import type { ConnState } from "../../lib/ws";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { Line, PlayerKind, QuestionOutcome } from "../types";
import { Waveform, type WaveSample } from "./Waveform";

export interface AudioState {
  paused: boolean;
  muted: boolean;
  /** 0 à 100. */
  volume: number;
  /** De l'audio est en cours de lecture (file non vide). */
  playing: boolean;
  queueMs: number;
  dropped: number;
  /** Bout-en-bout p50 mesuré par la salle (ms), ou null avant la première mesure. */
  e2eMs: number | null;
  /** Vitesse effective de la voix (serveur × lecture locale) ; > 1 = rattrapage de la dérive. */
  rate: number;
}

export interface QuestionState {
  supported: boolean;
  asking: boolean;
  /** Un autre apprenant a la parole. */
  busy: boolean;
  status: "idle" | "sending" | "done" | "failed";
  last?: QuestionOutcome;
}

export interface ListenProps {
  conn: ConnState;
  secure: boolean;
  playerKind: PlayerKind;
  srcLang: Lang;
  lang: Lang;
  langs: Lang[];
  onLang: (l: Lang) => void;
  degraded?: string;
  audio: AudioState;
  /** Échantillon de l'onde, lu à chaque image par le composant Waveform. */
  waveSample: () => WaveSample;
  onPause: () => void;
  onMute: () => void;
  onVolume: (v: number) => void;
  onResync: () => void;
  lines: Line[];
  partial: string;
  clockOffset: number;
  showText: boolean;
  onToggleText: () => void;
  canReplay: boolean;
  onReplay: () => void;
  question: QuestionState;
}

const CONN_LABEL: Record<ConnState, string> = {
  open: "Connecté",
  connecting: "Connexion…",
  reconnecting: "Reconnexion…",
  closed: "Déconnecté",
};

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function fmtTime(tOrigin: number | undefined, clockOffset: number): string {
  if (tOrigin == null) return "—";
  return new Date(tOrigin - clockOffset).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function Listen(p: ListenProps) {
  const live = p.conn === "open";
  const a = p.audio;
  const q = p.question;
  const latest = p.lines[p.lines.length - 1];
  const previous = p.lines.slice(-3, -1);
  // Hypothèse en cours : les mots au-delà de ceux du rendu précédent viennent d'arriver.
  const words = p.partial ? p.partial.split(" ") : [];
  const seenWords = useRef(0);
  const newFrom = seenWords.current;
  useEffect(() => {
    seenWords.current = words.length;
  });

  // Ce que dit la pastille au-dessus de l'onde, du plus bloquant au nominal.
  const status = p.degraded
    ? { icon: "voice_over_off", text: "Voix indisponible — texte seul", cls: "text-error" }
    : !live
      ? { icon: "sync", text: CONN_LABEL[p.conn], cls: "text-tertiary animate-spin" }
      : q.asking
        ? { icon: "mic", text: "Question en cours…", cls: "text-secondary animate-pulse" }
        : q.busy
          ? { icon: "record_voice_over", text: "Un apprenant pose une question", cls: "text-tertiary" }
          : a.paused
            ? { icon: "pause_circle", text: "Écoute en pause", cls: "text-on-surface-variant" }
            : a.rate > 1
              ? { icon: "speed", text: `Rattrapage de la dérive ×${a.rate.toFixed(2).replace(".", ",")}`, cls: "text-tertiary" }
              : { icon: "headphones", text: "Traduction en direct active", cls: "text-secondary animate-pulse" };

  const queueTone = a.queueMs > 5000 ? "text-error" : a.queueMs > 2500 ? "text-tertiary" : "text-on-surface-variant";
  const lagging = a.queueMs > 2500;
  const linkDot = live ? "bg-secondary" : p.conn === "closed" ? "bg-error" : "bg-tertiary";

  // Retour sur la dernière question, là où le bouton se trouvait avant.
  const note = !q.supported
    ? { text: "Les questions exigent une connexion sécurisée (HTTPS). Voir docs/DECISIONS.md, D6.", cls: "text-error" }
    : q.busy
      ? { text: "Un apprenant pose une question — patientez.", cls: "text-tertiary" }
      : q.status === "sending"
        ? { text: "Question envoyée, transcription en cours…", cls: "text-primary" }
        : q.status === "failed"
          ? { text: "La question n'a pas pu être transmise. Réessayez.", cls: "text-error" }
        : q.status === "done" && q.last
          ? !q.last.srcText
            ? { text: "Rien n'a été compris. Parlez plus près du téléphone, et gardez le bouton enfoncé pendant toute la question.", cls: "text-error" }
            : q.last.delivered
              ? { text: `Transmise au formateur : « ${q.last.srcText} » → « ${q.last.text} »`, cls: "text-secondary" }
              : { text: `Comprise : « ${q.last.srcText} » — mais aucun formateur n'est connecté pour l'entendre.`, cls: "text-tertiary" }
          : undefined;

  return (
    <div className="flex flex-col w-full px-gutter-mobile gap-space-md">
      {/* Section 1 : en-tête de session & routage linguistique */}
      <div className="flex flex-col gap-space-xs pt-space-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-space-xs">
            <span className="font-label-badge text-label-badge uppercase tracking-wider text-primary">REAL-TIME INTERPRETATION</span>
          </div>
          <div key={p.conn} className="pop flex items-center gap-space-xs bg-surface-container-low px-2 py-0.5 rounded-full shadow-sm">
            <span className="relative flex h-2 w-2">
              {live && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75"></span>}
              <span className={`relative inline-flex rounded-full h-2 w-2 ${linkDot}`}></span>
            </span>
            <span className={`font-label-badge text-label-badge tracking-widest uppercase ${live ? "text-secondary" : p.conn === "closed" ? "text-error" : "text-tertiary"}`}>
              {live ? "LIVE" : p.conn === "closed" ? "OFF" : "SYNC"}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between bg-surface-container p-space-sm rounded-xl">
          <div className="flex items-center gap-space-sm min-w-0">
            <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center flex-shrink-0 text-secondary">
              <Icon name="sensors" fill className="text-[18px]" />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${linkDot}`}></span>
                <span className="font-headline-sm text-headline-sm text-on-surface truncate">{CONN_LABEL[p.conn]}</span>
              </div>
              <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant truncate">
                {p.secure ? "Flux chiffré WSS" : "Flux WS"} • {p.playerKind === "element" ? "Lecteur média" : "Web Audio"}
              </span>
            </div>
          </div>
          {/* Sélecteur de langue : le bouton de la maquette, un <select> natif par-dessus. */}
          <div className="relative flex-shrink-0">
            <button
              className="flex items-center gap-space-xs bg-surface-container-highest active:bg-surface-bright px-3 py-1.5 rounded-lg transition-colors"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
            >
              <span className="font-body-sm text-body-sm font-semibold text-on-surface">
                {LANGS[p.srcLang].flag} {LANGS[p.srcLang].short}
              </span>
              <Icon name="arrow_forward" className="text-primary text-[14px]" />
              <span className="font-body-sm text-body-sm font-semibold text-primary">
                {LANGS[p.lang].flag} {LANGS[p.lang].short}
              </span>
              <Icon name="expand_more" className="text-on-surface-variant text-[16px] ml-0.5" />
            </button>
            <select
              aria-label="Langue d'écoute"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              value={p.lang}
              onChange={(e) => p.onLang(e.target.value as Lang)}
            >
              {p.langs.map((l) => (
                <option key={l} value={l}>
                  {LANGS[l].flag} {LANGS[l].label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Section 2 : cœur de l'écran — audio en direct */}
      <div className="relative flex flex-col items-center bg-surface-container-low rounded-xl p-space-md overflow-clip shadow-lg">
        <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-64 h-64 bg-secondary/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-16 left-1/2 -translate-x-1/2 w-56 h-56 bg-primary-container/15 rounded-full blur-3xl pointer-events-none"></div>

        <div key={status.text} className="pop relative z-10 flex items-center gap-space-xs bg-surface-container-high/90 px-3 py-1 rounded-full shadow-sm mb-space-sm" role="status">
          <Icon name={status.icon} className={`text-[18px] ${status.cls}`} />
          <span className="font-headline-sm text-headline-sm text-on-surface">{status.text}</span>
        </div>

        <Waveform sample={p.waveSample} />

        {/* Télémétrie : décalage de la salle, profondeur de file (dérive) */}
        <div className="relative z-10 flex items-center justify-between w-full px-space-xs pt-space-xs pb-space-sm">
          <div className="flex items-center gap-1.5 bg-surface-container px-2.5 py-1 rounded-full whitespace-nowrap">
            <span className={`w-2 h-2 rounded-full bg-secondary ${live ? "animate-ping" : "opacity-40"}`}></span>
            <span className="font-metric-mono-sm text-metric-mono-sm text-secondary">{a.e2eMs != null ? fmtMs(a.e2eMs) : "—"}</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              {a.dropped > 0 ? `Décalage · ${a.dropped} sauté${a.dropped > 1 ? "s" : ""}` : "Décalage salle"}
            </span>
          </div>
          {lagging ? (
            <button type="button" onClick={p.onResync} className={`flex items-center gap-1 whitespace-nowrap ${queueTone} active:opacity-70`}>
              <Icon name="fast_forward" className="text-[16px]" />
              <span className="font-metric-mono-sm text-metric-mono-sm">Au direct · {fmtMs(a.queueMs)}</span>
            </button>
          ) : (
            <div className={`flex items-center gap-1 whitespace-nowrap ${queueTone}`}>
              <Icon name="av_timer" className="text-[16px] text-primary" />
              <span className="font-metric-mono-sm text-metric-mono-sm">file {fmtMs(a.queueMs)}</span>
            </div>
          )}
        </div>

        {/* Pause, volume, muet */}
        <div className="relative z-10 flex items-center gap-space-sm w-full bg-surface-container px-space-md py-space-sm rounded-xl">
          <button
            type="button"
            aria-label={a.paused ? "Reprendre l'écoute au direct" : "Mettre l'écoute en pause"}
            aria-pressed={a.paused}
            onClick={p.onPause}
            className="w-10 h-10 rounded-full bg-surface-container-highest hover:bg-surface-bright flex items-center justify-center flex-shrink-0 text-on-surface transition-transform active:scale-95 shadow-sm"
          >
            <Icon name={a.paused ? "play_arrow" : "pause"} fill className={`text-[22px] ${a.paused ? "text-secondary" : ""}`} />
          </button>
          <div className="flex flex-col flex-1 gap-1">
            <div className="flex items-center justify-between">
              <span className="font-body-sm text-body-sm text-on-surface-variant">Volume d'écoute</span>
              <span className="font-metric-mono-sm text-metric-mono-sm text-primary">{a.muted ? 0 : a.volume}%</span>
            </div>
            <div className="relative w-full flex items-center py-1">
              <input
                aria-label="Volume d'écoute"
                className="w-full h-2 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-secondary focus:outline-none"
                type="range"
                min={0}
                max={100}
                value={a.muted ? 0 : a.volume}
                onChange={(e) => p.onVolume(Number(e.target.value))}
              />
            </div>
          </div>
          <button
            type="button"
            aria-label={a.muted ? "Rétablir le son" : "Couper le son"}
            aria-pressed={a.muted}
            onClick={p.onMute}
            className="w-10 h-10 rounded-full bg-surface-container-highest hover:bg-surface-bright flex items-center justify-center flex-shrink-0 text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <Icon name={a.muted || a.volume === 0 ? "volume_off" : "volume_up"} className="text-[20px]" />
          </button>
        </div>
      </div>

      {/* Section 3 : transcription discrète, avec bascule */}
      <div className="flex flex-col gap-space-xs">
        <div className="flex items-center justify-between px-space-xs">
          <div className="flex items-center gap-1.5">
            <Icon name="subtitles" className="text-[16px] text-on-surface-variant" />
            <span className="font-label-badge text-label-badge uppercase tracking-wider text-on-surface-variant">Transcription Neuronale</span>
          </div>
          <button
            type="button"
            onClick={p.onToggleText}
            aria-expanded={p.showText}
            className="flex items-center gap-1 text-primary hover:text-primary-fixed text-body-sm font-body-sm py-0.5"
          >
            <span>{p.showText ? "Masquer le texte" : "Afficher le texte"}</span>
            <Icon name={p.showText ? "expand_less" : "expand_more"} className="text-[16px] transition-transform" />
          </button>
        </div>

        {p.showText && (
          <div className="flex flex-col gap-space-xs bg-surface-container/90 backdrop-blur-md p-space-md rounded-xl transition-all duration-300" aria-live="polite">
            <div className="flex items-center gap-space-xs">
              <span className={`w-2 h-2 rounded-full bg-primary ${p.partial ? "animate-pulse" : "opacity-50"}`}></span>
              <span className="font-label-badge text-label-badge text-on-surface-variant tracking-wider uppercase">Interprétation continue</span>
              <button
                type="button"
                aria-label="Réécouter les 30 dernières secondes"
                disabled={!p.canReplay}
                onClick={p.onReplay}
                className="ml-auto flex items-center text-primary active:opacity-70 disabled:text-on-surface-variant/40"
              >
                <Icon name="replay_30" className="text-[18px]" />
              </button>
              <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant/70">{fmtTime(latest?.tOrigin, p.clockOffset)}</span>
            </div>

            {previous.map((l) => (
              <div key={l.seq} className="font-body-sm text-body-sm text-on-surface-variant/70">
                {l.tgt ?? l.src}
              </div>
            ))}

            {latest ? (
              <div key={latest.seq} className="rise-in flex flex-col gap-space-xs">
                {latest.src && <div className="font-body-sm text-body-sm text-on-surface-variant italic pl-2 border-l-0">“{latest.src}”</div>}
                <div
                  key={latest.tgt ? "tgt" : "wait"}
                  className={`font-body-transcript-lg-mobile text-body-transcript-lg-mobile pt-1 ${latest.tgt ? "rise-in" : ""} ${
                    latest.untranslated ? "text-error font-normal" : "text-on-surface font-medium"
                  }`}
                >
                  {latest.tgt ? `“${latest.tgt}”` : "…"}
                </div>
              </div>
            ) : (
              !p.partial && <div className="font-body-md text-body-md text-on-surface-variant">En attente du formateur…</div>
            )}

            {p.partial && (
              <div className="font-body-sm text-body-sm text-on-surface-variant/70 italic">
                {words.map((w, i) => (
                  <span key={`${i}-${w}`} className={i >= newFrom ? "word-in inline-block" : undefined}>
                    {w}{" "}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {note && (
        <div className="flex items-start gap-space-xs px-space-xs pb-space-sm" role="status">
          <Icon name="front_hand" className={`text-[16px] mt-px shrink-0 ${note.cls}`} />
          <span className={`font-body-sm text-body-sm ${note.cls}`}>{note.text}</span>
        </div>
      )}
    </div>
  );
}
