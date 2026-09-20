/**
 * Vue « Ask Q&A » : le studio de question de la maquette (Push To Talk Studio).
 * Le micro se touche pour démarrer, se retouche pour une pause ; « Envoyer
 * maintenant » transmet, « Annuler » jette. La question part en un bloc (D8) :
 * la transcription et la traduction arrivent après l'envoi, pas pendant.
 */
import type { Lang } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { QuestionOutcome } from "../types";

export type StudioPhase = "idle" | "recording" | "paused" | "sending" | "done" | "failed";

export interface StudioProps {
  /** Langue du formateur : celle dans laquelle la question lui parvient. */
  srcLang: Lang;
  /** Langue de l'apprenant : celle dans laquelle il parle. */
  lang: Lang;
  live: boolean;
  supported: boolean;
  /** Un autre apprenant a la parole. */
  busy: boolean;
  phase: StudioPhase;
  /** Durée enregistrée (ms) et plafond. */
  ms: number;
  maxMs: number;
  /** Niveau du micro, 0 à 1. */
  level: number;
  last?: QuestionOutcome;
  /** Temps entre l'envoi et la réponse de la salle (ms). */
  processedMs?: number;
  onMic: () => void;
  onSend: () => void;
  onCancel: () => void;
  onBack: () => void;
}

/** Périmètre du cercle r=46 de la maquette : la jauge se remplit en réduisant le dashoffset. */
const ARC = 289.02;
const BARS = ["h-3 bg-secondary", "h-6 bg-secondary", "h-4 bg-secondary", "h-7 bg-secondary-fixed-dim", "h-5 bg-secondary", "h-7 bg-secondary-fixed", "h-3 bg-secondary", "h-6 bg-secondary-fixed-dim", "h-2 bg-secondary"];
const BAR_DELAYS = [0.1, 0.25, 0.15, 0.35, 0.05, 0.4, 0.2, 0.3, 0.1];

function clock(ms: number): string {
  const s = Math.min(Math.floor(ms / 1000), 5999);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

type Tone = "secondary" | "tertiary" | "muted" | "error";
const TONE: Record<Tone, { box: string; title: string; badge: string }> = {
  secondary: { box: "bg-secondary-container text-on-secondary-container shadow-sm", title: "text-secondary", badge: "text-secondary/90" },
  tertiary: { box: "bg-tertiary-container text-on-tertiary-container", title: "text-tertiary", badge: "text-tertiary" },
  muted: { box: "bg-surface-container-highest text-on-surface-variant", title: "text-on-surface-variant", badge: "text-outline" },
  error: { box: "bg-error-container text-on-error-container", title: "text-error", badge: "text-error" },
};

function Step({ icon, fill, title, badge, tone }: { icon: string; fill?: boolean; title: string; badge: string; tone: Tone }) {
  const t = TONE[tone];
  return (
    <div className="flex flex-col items-center text-center p-2 rounded-lg bg-surface-container">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center mb-1 ${t.box}`}>
        <Icon name={icon} fill={fill} className="text-[15px]" />
      </div>
      <span className={`font-metric-mono-sm text-metric-mono-sm font-semibold ${t.title}`}>{title}</span>
      <span className={`font-label-badge text-label-badge ${t.badge}`}>{badge}</span>
    </div>
  );
}

export function Studio(p: StudioProps) {
  const recording = p.phase === "recording";
  const paused = p.phase === "paused";
  const capturing = recording || paused;
  const done = p.phase === "done";
  const understood = done && !!p.last?.srcText;
  const micDisabled = !p.supported || !p.live || p.busy || p.phase === "sending";

  // Bouton micro : vert quand il écoute, gris sinon (l'état « off » de la maquette).
  const micOn = recording;
  const micLabel = !p.supported
    ? "HTTPS requis"
    : p.busy
      ? "Occupé"
      : recording
        ? "En écoute"
        : paused
          ? "En pause"
          : p.phase === "sending"
            ? "Envoi…"
            : "Parler";

  const pill: { dot: string; text: string; cls: string; hint: string } = !p.supported
    ? { dot: "bg-error", text: "Micro indisponible", cls: "text-error", hint: "Connexion sécurisée requise" }
    : p.busy
      ? { dot: "bg-tertiary", text: "Un apprenant parle", cls: "text-tertiary", hint: "Patientez" }
      : recording
        ? { dot: "bg-secondary shadow-[0_0_8px_rgba(78,222,163,0.8)] animate-pulse", text: "Enregistrement en cours", cls: "text-secondary", hint: "Toucher : pause" }
        : paused
          ? { dot: "bg-tertiary", text: "Session suspendue", cls: "text-tertiary", hint: "Toucher : reprendre" }
          : p.phase === "sending"
            ? { dot: "bg-tertiary animate-pulse", text: "Transcription en cours", cls: "text-tertiary", hint: "Quelques secondes" }
            : p.phase === "failed"
              ? { dot: "bg-error", text: "Échec de l'envoi", cls: "text-error", hint: "Réessayez" }
              : done
                ? understood
                  ? { dot: "bg-secondary", text: p.last?.delivered ? "Question transmise" : "Question comprise", cls: "text-secondary", hint: "Toucher : nouvelle question" }
                  : { dot: "bg-error", text: "Rien n'a été compris", cls: "text-error", hint: "Parlez plus près" }
                : { dot: "bg-outline", text: "Prêt à enregistrer", cls: "text-on-surface-variant", hint: "Toucher le micro" };

  // Les trois étapes du flux inverse : capture ici, IA sur le serveur, casque du formateur.
  const step1 = recording ? ["En cours", "secondary"] : paused ? ["En pause", "tertiary"] : capturing || p.phase === "idle" ? ["En attente", "muted"] : ["Terminé", "secondary"];
  const step2 = p.phase === "sending" ? ["Actif", "tertiary"] : p.phase === "failed" ? ["Échec", "error"] : done ? (understood ? ["Terminé", "secondary"] : ["Vide", "error"]) : ["En attente", "muted"];
  const step3 = done && understood ? (p.last?.delivered ? ["Transmis", "secondary"] : ["Absent", "error"]) : ["En attente", "muted"];

  const srcTag = capturing ? { dot: true, text: recording ? "En direct" : "En pause", cls: "text-secondary" } : p.phase === "sending" ? { dot: true, text: "Transcription…", cls: "text-tertiary" } : done ? { dot: false, text: "Terminé", cls: "text-on-surface-variant" } : null;

  return (
    <div className="flex flex-col w-full px-gutter-mobile pb-margin space-y-space-md select-none">
      {/* Consigne */}
      <div className="flex flex-col space-y-space-xs text-center pt-space-xs">
        <div className="inline-flex items-center justify-center gap-space-xs self-center px-3 py-1 rounded-full bg-secondary-container/20 text-secondary">
          <span className={`w-2 h-2 rounded-full bg-secondary ${p.live ? "animate-ping" : "opacity-40"}`}></span>
          <span className="font-label-badge text-label-badge uppercase tracking-wider">Canal Direct Formateur</span>
        </div>
        <h2 className="font-headline-lg-mobile text-headline-lg-mobile text-on-surface">Posez votre question</h2>
        <p className="font-body-transcript-lg-mobile text-body-transcript-lg-mobile text-on-surface-variant max-w-xs mx-auto">
          Votre voix sera automatiquement traduite en <span className="text-primary font-medium">{LANGS[p.srcLang].nameFr}</span> pour le formateur.
        </p>
      </div>

      {/* Scène PTT */}
      <div className="flex flex-col items-center justify-center py-space-sm relative">
        <div className="relative flex items-center justify-center w-64 h-64">
          <div className={`absolute w-56 h-56 rounded-full bg-secondary/10 ${recording ? "animate-ping" : "opacity-0"}`} style={{ animationDuration: "2.2s" }}></div>
          <div className={`absolute w-44 h-44 rounded-full bg-secondary/15 ${recording ? "animate-pulse" : capturing ? "" : "opacity-40"}`}></div>
          <button
            type="button"
            aria-label={recording ? "Mettre la question en pause" : paused ? "Reprendre la question" : "Commencer à parler"}
            aria-pressed={recording}
            disabled={micDisabled}
            onClick={p.onMic}
            className={`relative z-10 w-36 h-36 rounded-full shadow-[0_0_35px_rgba(0,165,114,0.45)] active:scale-95 transition-transform flex flex-col items-center justify-center group focus:outline-none disabled:shadow-none disabled:active:scale-100 ${
              micOn ? "bg-secondary-container text-on-secondary-container" : "bg-surface-variant text-on-surface-variant"
            }`}
          >
            <Icon name={p.phase === "sending" ? "hourglass_top" : "mic"} fill className="text-[48px] transition-transform group-active:scale-110" />
            <span className="font-label-badge text-label-badge tracking-wider uppercase mt-1">{micLabel}</span>
          </button>
          {/* Jauge de niveau sur le pourtour */}
          <svg className="absolute inset-0 w-64 h-64 -rotate-90 pointer-events-none" viewBox="0 0 100 100" aria-hidden="true">
            <circle className="stroke-surface-container-high fill-none" cx="50" cy="50" r="46" strokeWidth="3"></circle>
            <circle
              className="stroke-secondary fill-none transition-all duration-150"
              cx="50"
              cy="50"
              r="46"
              strokeDasharray={ARC}
              strokeDashoffset={ARC * (1 - (recording ? p.level : 0))}
              strokeLinecap="round"
              strokeWidth="3.5"
            ></circle>
          </svg>
        </div>

        {/* État, onde, chrono */}
        <div className="flex flex-col items-center space-y-space-xs mt-space-xs">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface shadow-sm whitespace-nowrap" role="status">
            <span className={`w-2.5 h-2.5 rounded-full ${pill.dot}`}></span>
            <span className={`font-metric-mono-sm text-metric-mono-sm ${pill.cls}`}>{pill.text}</span>
            <span className="text-outline-variant font-body-sm text-body-sm">•</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">{pill.hint}</span>
          </div>
          <div className="flex items-center justify-center gap-1 h-8 w-48 px-2" aria-hidden="true">
            {BARS.map((cls, i) => (
              <span
                key={i}
                className={`w-1 rounded-full transition-all duration-300 ${recording ? `${cls} animate-bounce` : `${cls.split(" ")[1]} h-1 opacity-30`}`}
                style={recording ? { animationDelay: `${BAR_DELAYS[i]}s` } : undefined}
              ></span>
            ))}
          </div>
          <div className="flex items-center gap-1 font-metric-mono-sm text-metric-mono-sm text-on-surface-variant">
            <span className={`font-semibold ${p.ms >= p.maxMs - 5000 && capturing ? "text-tertiary" : "text-on-surface"}`}>{clock(p.ms)}</span>
            <span>/</span>
            <span>{clock(p.maxMs)} max</span>
          </div>
        </div>
      </div>

      {/* Les trois étapes */}
      <div className="grid grid-cols-3 gap-space-xs w-full bg-surface-container-low p-2 rounded-xl">
        <Step icon="hearing" fill title="1. Écoute" badge={step1[0]} tone={step1[1] as Tone} />
        <Step icon="translate" title="2. IA Vocale" badge={step2[0]} tone={step2[1] as Tone} />
        <Step icon="headphones" title="3. Casque" badge={step3[0]} tone={step3[1] as Tone} />
      </div>

      {/* Transcription bilingue */}
      <div className="flex flex-col w-full bg-surface-container p-space-md rounded-xl space-y-space-sm shadow-md" aria-live="polite">
        <div className="flex flex-col space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="px-1.5 py-0.5 rounded bg-surface-container-highest font-metric-mono-sm text-metric-mono-sm text-on-surface-variant">{LANGS[p.lang].short}</span>
              <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant truncate">Votre question (détectée)</span>
            </div>
            {srcTag && (
              <span className={`font-label-badge text-label-badge flex items-center gap-1 whitespace-nowrap flex-shrink-0 ${srcTag.cls}`}>
                {srcTag.dot && <span className="w-1.5 h-1.5 rounded-full bg-current"></span>} {srcTag.text}
              </span>
            )}
          </div>
          <p className={`font-body-transcript-lg-mobile text-body-transcript-lg-mobile leading-relaxed ${done && !understood ? "text-error" : "text-on-surface"}`}>
            {done ? (
              understood ? (
                `« ${p.last!.srcText} »`
              ) : (
                "Rien n'a été compris. Parlez plus près du téléphone, et gardez le micro ouvert pendant toute la question."
              )
            ) : capturing || p.phase === "sending" ? (
              <>
                {capturing ? "« " : "Transcription en cours"}
                <span className="inline-block w-1.5 h-4 bg-primary align-middle animate-pulse"></span>
              </>
            ) : p.phase === "failed" ? (
              <span className="text-error">La question n'a pas pu être transmise. Réessayez.</span>
            ) : (
              <span className="text-on-surface-variant">Votre question apparaîtra ici une fois envoyée.</span>
            )}
          </p>
        </div>

        <div className="w-full h-px bg-surface-variant/40"></div>

        <div className="flex flex-col space-y-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="px-1.5 py-0.5 rounded bg-primary-container font-metric-mono-sm text-metric-mono-sm text-on-primary-container">{LANGS[p.srcLang].short}</span>
              <span className="font-metric-mono-sm text-metric-mono-sm text-primary truncate">Traduction synthétisée formateur</span>
            </div>
            <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface-variant whitespace-nowrap flex-shrink-0">
              {understood && p.processedMs != null ? `Latence ${seconds(p.processedMs)}` : "—"}
            </span>
          </div>
          <p className="font-body-transcript-lg-mobile text-body-transcript-lg-mobile text-on-surface-variant italic leading-relaxed">
            {understood ? `“${p.last!.text}”` : "…"}
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-space-sm pt-space-xs">
        <button
          type="button"
          onClick={capturing ? p.onCancel : p.onBack}
          className="flex-1 py-3 px-4 rounded-xl bg-surface-container-high hover:bg-surface-bright text-on-surface font-headline-sm text-headline-sm text-center transition-colors flex items-center justify-center gap-2"
        >
          <Icon name={capturing ? "close" : "arrow_back"} className={`text-[20px] ${capturing ? "text-error" : "text-on-surface-variant"}`} />
          <span>{capturing ? "Annuler" : "Retour"}</span>
        </button>
        <button
          type="button"
          disabled={!capturing}
          onClick={p.onSend}
          className="flex-[1.8] py-3 px-4 rounded-xl bg-primary hover:bg-primary-fixed text-on-primary font-headline-sm text-headline-sm text-center shadow-lg transition-all flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 disabled:shadow-none disabled:active:scale-100"
        >
          <Icon name="send" fill className="text-[20px]" />
          <span>Envoyer maintenant</span>
        </button>
      </div>
    </div>
  );
}
