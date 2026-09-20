/**
 * Avant que le formateur parle : le QR code en grand au milieu de l'écran, l'adresse
 * pour ceux qui préfèrent la taper, les langues, et l'état de la salle.
 */
import type { Lang } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { Qr } from "../../ui/Qr";

export interface IdleProps {
  joinUrl?: string;
  srcLang: Lang;
  langs: Lang[];
  lecturer: boolean;
  speaking: boolean;
}

export function Idle(p: IdleProps) {
  const status = !p.lecturer ? "En attente du formateur…" : p.speaking ? "Le formateur parle, la traduction arrive…" : "Le formateur est en ligne";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-[3vh] px-[6vw] text-center">
      <div className="flex flex-col items-center gap-[1vh]">
        <span className="font-label-badge uppercase tracking-[0.2em] text-primary" style={{ fontSize: "clamp(12px, 1.1vw, 20px)" }}>
          Interprétation en direct
        </span>
        <h1 className="font-headline-lg font-bold tracking-tight text-on-surface text-balance" style={{ fontSize: "clamp(28px, 3.6vw, 64px)", lineHeight: 1.15 }}>
          Écoutez la traduction dans vos écouteurs
        </h1>
      </div>
      {p.joinUrl ? (
        <Qr value={p.joinUrl} size={640} className="w-[min(34vh,34vw)]" />
      ) : (
        <div className="w-[min(34vh,34vw)] aspect-square rounded-xl bg-surface-container-high animate-pulse" />
      )}
      <div className="flex flex-col items-center gap-[1vh]">
        <span className="text-on-surface-variant" style={{ fontSize: "clamp(14px, 1.5vw, 28px)" }}>
          Scannez le code avec l'appareil photo du téléphone, ou tapez l'adresse
        </span>
        <span className="font-metric-mono-sm text-on-surface break-all" style={{ fontSize: "clamp(14px, 1.7vw, 32px)" }}>
          {p.joinUrl?.replace(/^https?:\/\//, "") ?? "…"}
        </span>
      </div>
      <div className="flex items-center gap-[0.8vw]" style={{ fontSize: "clamp(12px, 1.2vw, 22px)" }}>
        <span className="px-[0.8em] py-[0.3em] rounded-lg bg-surface-container-highest font-metric-mono-sm text-on-surface-variant">
          {LANGS[p.srcLang].flag} {LANGS[p.srcLang].label}
        </span>
        <Icon name="arrow_forward" className="text-primary" />
        {p.langs.map((l) => (
          <span key={l} className="px-[0.8em] py-[0.3em] rounded-lg bg-primary-container font-metric-mono-sm text-on-primary-container">
            {LANGS[l].flag} {LANGS[l].label}
          </span>
        ))}
      </div>
      <div key={status} className="pop flex items-center gap-[0.6em] text-on-surface-variant" style={{ fontSize: "clamp(12px, 1.2vw, 22px)" }}>
        <span className={`w-[0.6em] h-[0.6em] rounded-full ${p.lecturer ? "bg-secondary animate-pulse" : "bg-outline"}`}></span>
        {status}
      </div>
    </div>
  );
}
