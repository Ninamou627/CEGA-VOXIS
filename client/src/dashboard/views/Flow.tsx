/**
 * La chaîne de la salle en une ligne : microphone → audio → reconnaissance → traduction →
 * voix. Chaque étage a sa couleur d'état ; entre deux étages sains, le flux avance quand
 * la parole passe. C'est le « tout va bien » qu'on lit de loin.
 */
import { Icon } from "../../ui/Icon";
import type { StageState } from "../signals";
import { Dot, TONE_TEXT, type Tone } from "../ui";

const RING: Record<Tone, string> = {
  ok: "ring-secondary/70 text-secondary",
  warn: "ring-tertiary/80 text-tertiary",
  crit: "ring-error/80 text-error",
  idle: "ring-outline-variant text-outline",
};

export function Flow({ stages, flowing, detailed }: { stages: StageState[]; flowing: boolean; detailed?: boolean }) {
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-5 gap-y-8">
      {stages.map((s, i) => {
        const next = stages[i + 1];
        const live = flowing && s.tone === "ok" && next && (next.tone === "ok" || next.tone === "warn");
        return (
          <li key={s.id} className="relative flex flex-col items-center text-center px-2">
            {next && (
              <span
                aria-hidden="true"
                className={`hidden sm:block absolute top-7 h-[2px] left-[calc(50%+34px)] right-[calc(-50%+34px)] ${live ? "flow-dash text-secondary" : s.tone === "idle" ? "bg-outline-variant/50" : `${TONE_TEXT[s.tone]} bg-current opacity-40`}`}
              />
            )}
            <div className={`relative w-14 h-14 rounded-full ring-2 ${RING[s.tone]} bg-surface-container-low flex items-center justify-center`}>
              <Icon name={s.icon} fill={s.tone === "ok"} className="text-[26px]" />
              <span className="absolute -top-0.5 -right-0.5">
                <Dot tone={s.tone} live={s.tone === "ok"} />
              </span>
            </div>
            <span className="mt-3 text-[13px] font-semibold text-on-surface">{s.label}</span>
            <span key={s.status} className={`pop mt-0.5 text-[13px] font-medium ${TONE_TEXT[s.tone]}`}>
              {s.status}
            </span>
            <span className="mt-0.5 font-metric-mono-sm text-[11px] text-on-surface-variant">{s.metric}</span>
            {detailed && s.engine && (
              <span className="mt-1 font-metric-mono-sm text-[10px] text-outline max-w-full truncate" title={s.engine}>
                {s.engine}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
