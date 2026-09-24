/**
 * Briques de l'administration. Parti pris : pas de cartes. Les zones se séparent par
 * des filets et des espaces, les chiffres s'alignent dans des bandeaux, les listes sont
 * des lignes — l'œil lit une page, pas une mosaïque de boîtes.
 */
import { useEffect, type ReactNode } from "react";
import { Icon } from "../ui/Icon";

export type Tone = "ok" | "warn" | "crit" | "idle";

export const TONE_TEXT: Record<Tone, string> = { ok: "text-secondary", warn: "text-tertiary", crit: "text-error", idle: "text-outline" };
export const TONE_BG: Record<Tone, string> = { ok: "bg-secondary", warn: "bg-tertiary", crit: "bg-error", idle: "bg-outline" };
/** Pastille d'état teintée (constellation, inspecteur). */
export const TONE_PILL: Record<Tone, string> = {
  ok: "bg-secondary/10 border-secondary/30 text-secondary",
  warn: "bg-tertiary/10 border-tertiary/35 text-tertiary",
  crit: "bg-error/10 border-error/40 text-error",
  idle: "bg-on-surface/[0.04] border-on-surface/[0.08] text-outline",
};

/** Mots mis en lumière dans un titre, avec le dégradé bleu ciel → indigo → émeraude du design. */
export function Accent({ children }: { children: ReactNode }) {
  return <span className="cz-gradient-text">{children}</span>;
}

/** Section de page : un titre, une ligne d'explication, le contenu. Séparée par un filet, jamais encadrée. */
export function Section({ title, hint, right, children, id }: { title: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="py-8 border-t border-outline-variant/20 first:border-t-0 scroll-mt-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 mb-5">
        <div className="min-w-0">
          <h2 className="font-headline-sm text-[15px] font-semibold text-on-surface tracking-tight">{title}</h2>
          {hint && <p className="text-[13px] text-on-surface-variant mt-1 max-w-3xl leading-relaxed">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Pastille d'état ; elle respire quand l'étage est actif et sain. */
export function Dot({ tone, live }: { tone: Tone; live?: boolean }) {
  return (
    <span className="relative inline-flex w-2 h-2 shrink-0">
      {live && tone === "ok" && <span className={`absolute inset-0 rounded-full ${TONE_BG[tone]} opacity-60 animate-ping`} />}
      <span className={`relative inline-flex w-2 h-2 rounded-full ${TONE_BG[tone]}`} />
    </span>
  );
}

/** Grand nombre avec ses unités en petit : « 31 h 42 min », « 0,87 s ». */
export function Value({ parts }: { parts: [string, string?][] }) {
  return (
    <>
      {parts.map(([v, u], i) => (
        <span key={i} className="whitespace-nowrap">
          {i > 0 && " "}
          {v}
          {u && <span className="text-[0.52em] font-medium text-on-surface-variant ml-[0.18em]">{u}</span>}
        </span>
      ))}
    </>
  );
}

/**
 * Un chiffre du bandeau d'indicateurs. Le bandeau est une simple grille : filets verticaux
 * entre les chiffres sur grand écran, filets horizontaux entre les rangées sur téléphone.
 */
export function Stat({ icon, label, value, caption, tone, href }: { icon: string; label: string; value: ReactNode; caption?: ReactNode; tone?: Tone; href?: string }) {
  const cls =
    "group block min-w-0 py-6 pr-4 lg:px-5 xl:px-7 lg:first:pl-0 border-outline-variant/20 lg:border-l lg:first:border-l-0 [&:nth-child(n+3)]:border-t lg:[&:nth-child(n+3)]:border-t-0";
  const body = (
    <>
      <div className="flex items-start gap-1.5 text-on-surface-variant lg:min-h-8">
        <Icon name={icon} className="text-[16px] shrink-0" />
        <span className="text-[11px] leading-4 font-label-badge font-bold uppercase tracking-wide">{label}</span>
        {href && <Icon name="arrow_forward" className="text-[14px] ml-auto shrink-0 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />}
      </div>
      <div className={`mt-3 font-metric-mono-lg text-[32px] leading-none font-semibold tracking-tight transition-colors ${tone && tone !== "ok" && tone !== "idle" ? TONE_TEXT[tone] : "text-on-surface"}`}>{value}</div>
      {caption && <div className="mt-2.5 text-xs leading-snug text-on-surface-variant">{caption}</div>}
    </>
  );
  return href ? (
    <a href={href} className={cls}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Bandeau d'indicateurs : cinq colonnes sur grand écran, deux sur téléphone. */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 lg:grid-cols-5">{children}</div>;
}

/** Anneau de progression (0 à 1), pour les piliers de la qualité. */
export function Ring({ value, tone, size = 56 }: { value: number | null; tone: Tone; size?: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className="-rotate-90 shrink-0" aria-hidden="true">
      <circle cx="24" cy="24" r={r} fill="none" strokeWidth="4" className="stroke-surface-container-highest" />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        className={`transition-[stroke-dashoffset] duration-700 ${tone === "ok" ? "stroke-secondary" : tone === "warn" ? "stroke-tertiary" : tone === "crit" ? "stroke-error" : "stroke-outline"}`}
      />
    </svg>
  );
}

/** Petites barres d'une série (jours), la dernière en évidence. */
export function Bars({ values, max, tone = "ok", labels }: { values: (number | null)[]; max?: number; tone?: Tone; labels?: string[] }) {
  const top = Math.max(max ?? 0, ...values.map((v) => v ?? 0), 1e-9);
  return (
    <div className="flex items-end gap-[3px] h-10" aria-hidden="true">
      {values.map((v, i) => (
        <div key={i} className="flex-1 h-full flex items-end" title={labels?.[i]}>
          <div
            className={`w-full rounded-sm ${v == null ? "bg-surface-container-highest h-[2px]" : `${TONE_BG[tone]} ${i === values.length - 1 ? "" : "opacity-50"}`}`}
            style={v == null ? undefined : { height: `${Math.max(6, (v / top) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/** Barre horizontale fine (répartition des signalements, naturalité d'une voix). */
export function Meter({ value, tone = "ok", className = "w-24" }: { value: number; tone?: Tone; className?: string }) {
  return (
    <div className={`h-1.5 rounded-full bg-surface-container-highest overflow-hidden shrink-0 ${className}`} aria-hidden="true">
      <div className={`h-full rounded-full ${TONE_BG[tone]} transition-[width] duration-500`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** Choix exclusif en ligne (moteur, effort, mode). Un contrôle, pas une carte. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" className={`inline-flex flex-wrap rounded-lg border border-outline-variant/40 p-0.5 bg-surface-container-low ${disabled ? "opacity-50" : ""}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={`${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-1.5 text-[13px]"} rounded-md font-medium transition-colors whitespace-nowrap disabled:cursor-not-allowed ${
              on ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface disabled:opacity-40 disabled:hover:text-on-surface-variant"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Curseur avec sa valeur lisible, et ses deux bornes en clair. */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  ends,
  disabled,
  marker,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  ends?: [string, string];
  disabled?: boolean;
  /** Repère sous la piste (niveau mesuré en ce moment, par exemple). */
  marker?: { value: number; label: string };
}) {
  const at = (v: number) => `${((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100}%`;
  return (
    <div className={`w-full max-w-md ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-4">
        <div className="relative flex-1 flex items-center">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full h-1.5 accent-primary cursor-pointer disabled:cursor-not-allowed"
          />
          {marker && (
            <span className="absolute top-full mt-1 -translate-x-1/2 flex flex-col items-center pointer-events-none transition-[left] duration-500" style={{ left: at(marker.value) }}>
              <span className="w-px h-2 bg-secondary" />
              <span className="font-metric-mono-sm text-[10px] text-secondary whitespace-nowrap">{marker.label}</span>
            </span>
          )}
        </div>
        <span className="font-metric-mono-sm text-sm font-semibold text-on-surface w-20 text-right tabular-nums">{format(value)}</span>
      </div>
      {ends && (
        <div className={`flex justify-between text-[11px] text-outline pr-24 ${marker ? "mt-6" : "mt-1"}`}>
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      {marker && !ends && <div className="h-5" />}
    </div>
  );
}

/** Ligne de formulaire : ce que c'est et quand ça s'applique à gauche, le contrôle à droite. */
export function Field({
  label,
  help,
  applies,
  changed,
  children,
}: {
  label: string;
  help?: ReactNode;
  applies?: "live" | "next-mic";
  changed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-x-10 gap-y-3 py-5 border-t border-outline-variant/15 first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-on-surface">{label}</span>
          {changed && <span className="w-1.5 h-1.5 rounded-full bg-primary" title="modifié, non enregistré" />}
        </div>
        {help && <div className="text-[13px] text-on-surface-variant mt-1 leading-relaxed">{help}</div>}
        {applies && (
          <div className={`inline-flex items-center gap-1 mt-2 text-[10px] font-label-badge font-bold uppercase tracking-wider ${applies === "live" ? "text-secondary" : "text-tertiary"}`}>
            <Icon name={applies === "live" ? "bolt" : "restart_alt"} className="text-[13px]" />
            {applies === "live" ? "immédiat" : "au prochain démarrage du micro"}
          </div>
        )}
      </div>
      <div className="min-w-0 flex flex-col items-start gap-2">{children}</div>
    </div>
  );
}

/** Zone de texte avec compteur, pour le contexte, le glossaire, le vocabulaire. */
export function TextArea({
  value,
  onChange,
  max,
  rows = 4,
  placeholder,
  mono,
  disabled,
  footer,
}: {
  value: string;
  onChange: (v: string) => void;
  max: number;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div className={`w-full ${disabled ? "opacity-50" : ""}`}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        className={`w-full resize-y bg-surface-container-low border border-outline-variant/40 rounded-lg px-3 py-2.5 text-[13px] leading-relaxed text-on-surface placeholder:text-outline focus:outline-none focus:border-primary/70 disabled:cursor-not-allowed ${mono ? "font-metric-mono-sm" : ""}`}
      />
      <div className="flex items-start justify-between gap-4 text-[11px] text-outline mt-1">
        <span>{footer}</span>
        <span className="tabular-nums shrink-0">
          {value.length} / {max}
        </span>
      </div>
    </div>
  );
}

/** Entier avec − et +, pour la segmentation. */
export function Stepper({ value, min, max, onChange, unit, label }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string; label?: string }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-outline-variant/40 bg-surface-container-low" role="group" aria-label={label}>
      <button type="button" aria-label="moins" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} className="w-8 h-8 flex items-center justify-center text-on-surface-variant hover:text-on-surface disabled:opacity-30">
        <Icon name="remove" className="text-[16px]" />
      </button>
      <span className="font-metric-mono-sm text-sm font-semibold text-on-surface min-w-[3.5rem] text-center tabular-nums">
        {value}
        {unit && <span className="text-outline font-normal"> {unit}</span>}
      </span>
      <button type="button" aria-label="plus" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} className="w-8 h-8 flex items-center justify-center text-on-surface-variant hover:text-on-surface disabled:opacity-30">
        <Icon name="add" className="text-[16px]" />
      </button>
    </div>
  );
}

/** Bouton d'action discret, pour les en-têtes de section et les lignes. */
export function Action({
  icon,
  children,
  onClick,
  href,
  tone = "default",
  disabled,
  title,
  busy,
  external,
}: {
  icon?: string;
  children?: ReactNode;
  onClick?: () => void;
  href?: string;
  /** `halo` et `solid` : les deux boutons de la constellation (inspecteur, pause). */
  tone?: "default" | "primary" | "danger" | "outline" | "halo" | "solid";
  disabled?: boolean;
  title?: string;
  busy?: boolean;
  external?: boolean;
}) {
  const shape = tone === "halo" || tone === "solid" ? "rounded-xl text-xs font-metric-mono-sm" : "rounded-lg text-[13px] font-medium";
  const cls = `inline-flex items-center gap-1.5 ${children ? "px-3" : "px-1.5"} py-1.5 ${shape} transition-all whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed ${
    tone === "primary"
      ? "bg-primary text-on-primary hover:bg-primary/90"
      : tone === "danger"
        ? "text-error hover:bg-error/10"
        : tone === "outline"
          ? "border border-outline-variant/50 text-on-surface hover:bg-surface-container-high"
          : tone === "halo"
            ? "border border-primary/30 bg-on-surface/[0.05] text-primary hover:bg-primary/15"
            : tone === "solid"
              ? "bg-[rgb(var(--cz-indigo))] text-white font-semibold shadow-md shadow-[color:rgb(var(--cz-indigo)/0.3)] hover:brightness-110 active:scale-95"
              : "text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high"
  }`;
  const inner = (
    <>
      {busy ? <Icon name="progress_activity" className="text-[17px] animate-spin" /> : icon && <Icon name={icon} className="text-[17px]" />}
      {children}
    </>
  );
  if (href) {
    return (
      <a href={href} className={cls} title={title} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} className={cls} title={title} aria-label={!children ? title : undefined}>
      {inner}
    </button>
  );
}

/** Étiquette courte dans une ligne : capacité d'un modèle, voix par défaut, langue. */
export function Chip({ children, tone = "muted", title }: { children: ReactNode; tone?: "muted" | "primary" | "ok" | "warn" | "crit"; title?: string }) {
  const cls = {
    muted: "text-on-surface-variant bg-surface-container-high",
    primary: "text-primary bg-primary/10",
    ok: "text-secondary bg-secondary/10",
    warn: "text-tertiary bg-tertiary/10",
    crit: "text-error bg-error/10",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-label-badge font-bold uppercase tracking-wider whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

/** Bandeau d'information pleine largeur, sous l'en-tête de page. Pas une boîte : une bande. */
export function Banner({ tone, icon, children, action }: { tone: "crit" | "warn" | "info" | "ok"; icon: string; children: ReactNode; action?: ReactNode }) {
  const cls = {
    crit: "bg-error/10 border-error/25 text-error",
    warn: "bg-tertiary/10 border-tertiary/25 text-tertiary",
    info: "bg-primary/10 border-primary/20 text-primary",
    ok: "bg-secondary/10 border-secondary/20 text-secondary",
  }[tone];
  return (
    <div role={tone === "crit" ? "alert" : "status"} className={`-mx-6 lg:-mx-10 px-6 lg:px-10 py-3 flex items-start gap-3 text-[13px] border-b ${cls}`}>
      <Icon name={icon} fill className="text-[19px] shrink-0 mt-px" />
      <div className="flex-1 min-w-0 text-on-surface leading-relaxed">{children}</div>
      {action}
    </div>
  );
}

/** Une paire libellé / valeur d'une liste de mesures, soulignée d'un filet. */
export function Kv({ label, value, tone, title }: { label: ReactNode; value: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 border-b border-outline-variant/15 min-w-0">
      <dt className="text-[13px] text-on-surface-variant shrink-0">{label}</dt>
      <dd className={`font-metric-mono-sm text-[13px] text-right truncate ${tone && tone !== "ok" && tone !== "idle" ? TONE_TEXT[tone] : "text-on-surface"}`} title={title}>
        {value}
      </dd>
    </div>
  );
}

/** Ce qu'on affiche quand une liste est vide : une ligne, pas un encadré. */
export function Empty({ icon = "inbox", children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2 text-[13px] text-on-surface-variant leading-relaxed">
      <Icon name={icon} className="text-[20px] text-outline shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Un panneau par-dessus la page : Échap le ferme, la page derrière ne défile plus. */
export function useModal(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
}

/**
 * Panneau latéral (ajout d'une voix) : il glisse depuis la droite par-dessus la page,
 * se ferme avec Échap ou en cliquant à côté.
 */
export function Sheet({ title, subtitle, onClose, children }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  useModal(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Fermer" onClick={onClose} className="sheet-fade absolute inset-0 bg-black/40 cursor-default" />
      <div className="drawer-in relative w-full max-w-xl h-full bg-surface-container-lowest border-l border-outline-variant/25 flex flex-col shadow-2xl">
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 border-b border-outline-variant/20">
          <div className="min-w-0">
            <h2 className="font-headline-sm text-lg font-semibold text-on-surface">{title}</h2>
            {subtitle && <div className="text-[13px] text-on-surface-variant mt-1 leading-relaxed">{subtitle}</div>}
          </div>
          <Action icon="close" onClick={onClose} title="Fermer" />
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
