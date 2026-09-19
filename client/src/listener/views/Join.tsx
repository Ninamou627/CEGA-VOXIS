/**
 * Écran d'entrée : langue, puis « Écouter ». Le geste est obligatoire — c'est lui
 * qui déverrouille la sortie audio du téléphone. Provisoire dans le design system,
 * en attendant la maquette de cet écran.
 */
import type { Lang } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import { ALL_LANGS, LANGS } from "../../ui/langs";
import type { PlayerKind } from "../types";

export interface JoinProps {
  session: string;
  lang: Lang;
  onLang: (l: Lang) => void;
  playerKind: PlayerKind;
  onPlayerKind: (k: PlayerKind) => void;
  onStart: () => void;
  error?: string;
}

export function Join(p: JoinProps) {
  return (
    <div className="flex flex-col w-full px-gutter-mobile gap-space-md">
      <div className="flex flex-col gap-space-xs pt-space-xs">
        <span className="font-label-badge text-label-badge uppercase tracking-wider text-primary">REAL-TIME INTERPRETATION</span>
        <h1 className="font-headline-lg-mobile text-headline-lg-mobile text-on-surface">Rejoindre la session</h1>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Session <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface uppercase">{p.session}</span>. Mettez vos écouteurs,
          choisissez votre langue, puis appuyez sur Écouter.
        </p>
      </div>

      {p.error && (
        <div className="bg-error-container text-on-error-container rounded-xl px-space-md py-space-sm font-body-sm text-body-sm" role="alert">
          {p.error}
        </div>
      )}

      <div className="flex flex-col gap-space-sm bg-surface-container-low rounded-xl p-space-md shadow-lg">
        <span className="font-label-badge text-label-badge uppercase tracking-wider text-on-surface-variant">Langue d'écoute</span>
        <div className="grid grid-cols-2 gap-space-sm" role="radiogroup" aria-label="Langue d'écoute">
          {ALL_LANGS.map((l) => {
            const on = l === p.lang;
            return (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => p.onLang(l)}
                className={`flex items-center gap-space-sm px-3 py-2.5 rounded-lg transition-colors ${
                  on ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface active:bg-surface-bright"
                }`}
              >
                <span className="text-[20px] leading-none">{LANGS[l].flag}</span>
                <span className="flex flex-col text-left min-w-0">
                  <span className="font-headline-sm text-headline-sm truncate">{LANGS[l].label}</span>
                  <span className={`font-metric-mono-sm text-metric-mono-sm ${on ? "text-on-primary-container/80" : "text-on-surface-variant"}`}>{LANGS[l].short}</span>
                </span>
              </button>
            );
          })}
        </div>

        <label className="flex flex-col gap-1 pt-space-xs">
          <span className="font-label-badge text-label-badge uppercase tracking-wider text-on-surface-variant">Lecteur audio</span>
          <select
            value={p.playerKind}
            onChange={(e) => p.onPlayerKind(e.target.value as PlayerKind)}
            className="bg-surface-container-highest text-on-surface font-body-sm text-body-sm rounded-lg px-3 py-2.5 focus:outline-none"
          >
            <option value="element">Lecture média (recommandé — fonctionne écran verrouillé)</option>
            <option value="webaudio">Web Audio (ordinateur seulement — muet sur iPhone)</option>
          </select>
        </label>
      </div>

      <button
        type="button"
        onClick={p.onStart}
        className="group relative w-full h-20 rounded-xl bg-gradient-to-r from-secondary-container via-surface-container-high to-primary-container text-on-surface flex items-center justify-between px-space-md shadow-xl active:scale-[0.98] transition-all overflow-hidden select-none"
      >
        <div className="relative z-10 flex items-center gap-space-md min-w-0">
          <div className="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-secondary shadow-md">
            <Icon name="headphones" className="text-[28px]" />
          </div>
          <div className="flex flex-col text-left min-w-0">
            <span className="font-headline-sm text-headline-sm text-on-surface font-bold tracking-tight truncate">ÉCOUTER</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant truncate">
              {LANGS[p.lang].flag} {LANGS[p.lang].label} · démarre la voix traduite
            </span>
          </div>
        </div>
        <div className="relative z-10 flex items-center gap-1.5 flex-shrink-0 bg-surface/50 backdrop-blur-sm px-3 py-1.5 rounded-full">
          <Icon name="play_arrow" fill className="text-secondary text-[18px]" />
          <span className="font-metric-mono-sm text-metric-mono-sm text-on-surface font-semibold uppercase tracking-wider">GO</span>
        </div>
      </button>

      <p className="font-body-sm text-body-sm text-on-surface-variant/80 text-center">
        Gardez l'écran allumé pendant l'écoute. L'audio est traité par des services tiers pour produire la traduction et n'est pas conservé.
      </p>
    </div>
  );
}
