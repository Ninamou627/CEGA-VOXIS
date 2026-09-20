/**
 * Barre de réglages de l'écran de salle. Elle n'apparaît qu'au mouvement de la
 * souris et s'efface toute seule : sur le projecteur, on ne voit que les sous-titres.
 */
import type { ReactNode } from "react";
import type { Lang } from "../../../../shared/protocol";
import { delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { ThemeToggle } from "../../ui/ThemeToggle";
import type { Prefs } from "../types";

export interface ControlsProps {
  visible: boolean;
  prefs: Prefs;
  lang: Lang;
  srcLang: Lang;
  langs: Lang[];
  fullscreen: boolean;
  listeners?: number;
  e2eMs?: number | null;
  onLang: (l: Lang) => void;
  onToggleSource: () => void;
  onToggleQr: () => void;
  onScale: (delta: number) => void;
  onFullscreen: () => void;
}

function Chip({ active, onClick, title, children }: { active?: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-headline-sm font-bold whitespace-nowrap transition-colors ${
        active ? "bg-primary text-on-primary border-primary" : "bg-surface-container-high hover:bg-surface-bright text-on-surface border-outline-variant/40"
      }`}
    >
      {children}
    </button>
  );
}

export function Controls(p: ControlsProps) {
  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-40 px-6 pb-5 pt-10 bg-gradient-to-t from-surface via-surface/80 to-transparent transition-all duration-300 ${
        p.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {p.langs.length > 1 &&
            p.langs.map((l) => (
              <Chip key={l} active={l === p.lang} onClick={() => p.onLang(l)} title={`Afficher ${LANGS[l].label} (touche L pour changer)`}>
                {LANGS[l].flag} {LANGS[l].short}
              </Chip>
            ))}
          <Chip active={p.prefs.source} onClick={p.onToggleSource} title="Afficher aussi la phrase du formateur (S)">
            <Icon name="subtitles" className="text-[16px]" />
            Source {LANGS[p.srcLang].short}
          </Chip>
          <Chip active={p.prefs.qr} onClick={p.onToggleQr} title="Afficher le QR code (Q)">
            <Icon name="qr_code_2" className="text-[16px]" />
            QR
          </Chip>
          <div className="flex items-center rounded-xl border border-outline-variant/40 bg-surface-container-high overflow-hidden">
            <button type="button" onClick={() => p.onScale(-0.1)} title="Texte plus petit (−)" className="px-3 py-2 text-xs font-bold hover:bg-surface-bright">
              A−
            </button>
            <span className="px-2 font-metric-mono-sm text-[11px] text-on-surface-variant">{Math.round(p.prefs.scale * 100)} %</span>
            <button type="button" onClick={() => p.onScale(0.1)} title="Texte plus grand (+)" className="px-3 py-2 text-xs font-bold hover:bg-surface-bright">
              A+
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-metric-mono-sm text-[11px] text-on-surface-variant whitespace-nowrap">
            {p.listeners != null ? `${p.listeners} à l'écoute` : "—"}
            {p.e2eMs != null ? ` · décalage ${delay(p.e2eMs)}` : ""}
            {" · F plein écran"}
          </span>
          <ThemeToggle variant="square" />
          <Chip onClick={p.onFullscreen} title={p.fullscreen ? "Quitter le plein écran (F)" : "Plein écran (F)"}>
            <Icon name={p.fullscreen ? "fullscreen_exit" : "fullscreen"} className="text-[18px]" />
            {p.fullscreen ? "Quitter" : "Plein écran"}
          </Chip>
        </div>
      </div>
    </div>
  );
}
