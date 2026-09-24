/**
 * « Signaler un problème » : feuille qui monte du bas, cinq causes, un envoi.
 * L'apprenant ne ressaisit rien — le passage qu'il écoutait part avec le
 * signalement, et le serveur y ajoute l'heure, la transcription et la traduction.
 */
import { useEffect, useState } from "react";
import type { ReportKind } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import { REPORT_LABEL } from "../../ui/reports";

/** L'ordre de la maquette, avec ce que chaque cause veut dire pour un apprenant. */
const HINT: Record<ReportKind, string> = {
  transcription: "le formateur a dit autre chose",
  translation: "le sens n'y est pas",
  slow: "la voix est en retard sur la salle",
  voice: "difficile à suivre à l'oreille",
  audio: "coupures, grésillements, silence",
};
const ORDER: ReportKind[] = ["transcription", "translation", "slow", "voice", "audio"];

export interface ReportSheetProps {
  open: boolean;
  /** Le passage que l'apprenant écoutait, joint au signalement. */
  context?: { src?: string; tgt?: string };
  sent: boolean;
  onSend: (kind: ReportKind) => void;
  onClose: () => void;
}

export function ReportSheet(p: ReportSheetProps) {
  const [kind, setKind] = useState<ReportKind>();

  useEffect(() => {
    if (p.open) setKind(undefined);
  }, [p.open]);

  // Échap ferme la feuille (téléphone avec clavier, ordinateur).
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open, p.onClose]);

  if (!p.open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Signaler un problème">
      <button type="button" aria-label="Fermer" onClick={p.onClose} className="absolute inset-0 bg-surface-container-lowest/70 backdrop-blur-sm sheet-fade" />
      <div className="sheet-up relative w-full max-h-[88vh] overflow-y-auto bg-surface-container rounded-t-[1.75rem] shadow-[0_-8px_32px_rgba(0,0,0,0.45)] pb-safe">
        <div className="sticky top-0 bg-surface-container pt-space-sm rounded-t-[1.75rem]">
          <div className="mx-auto w-10 h-1 rounded-full bg-outline-variant" aria-hidden="true" />
          <div className="flex items-center justify-between px-gutter-mobile py-space-sm">
            <h2 className="font-headline-md text-headline-md text-on-surface">Signaler un problème</h2>
            <button type="button" onClick={p.onClose} aria-label="Fermer" className="w-9 h-9 rounded-full bg-surface-container-high active:bg-surface-bright flex items-center justify-center text-on-surface-variant">
              <Icon name="close" className="text-[20px]" />
            </button>
          </div>
        </div>

        {p.sent ? (
          <div className="flex flex-col items-center gap-space-sm px-gutter-mobile py-space-xl text-center">
            <div className="w-14 h-14 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container">
              <Icon name="check" fill className="text-[28px]" />
            </div>
            <span className="font-headline-sm text-headline-sm text-on-surface">Merci, c'est signalé</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant max-w-xs">
              L'équipe qui gère la salle est prévenue, et le passage est enregistré pour améliorer le système.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-space-sm px-gutter-mobile pb-space-md">
            <span className="font-body-md text-body-md text-on-surface-variant">Qu'est-ce qui n'allait pas ?</span>
            <div className="flex flex-col gap-space-xs" role="radiogroup" aria-label="Type de problème">
              {ORDER.map((k) => {
                const r = REPORT_LABEL[k];
                const on = kind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setKind(k)}
                    className={`flex items-center gap-space-sm px-space-md py-space-sm rounded-xl text-left transition-colors ${
                      on ? "bg-primary-container text-on-primary-container shadow-md" : "bg-surface-container-high text-on-surface active:bg-surface-bright"
                    }`}
                  >
                    <span className="text-[22px] leading-none" aria-hidden="true">
                      {r.emoji}
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="font-headline-sm text-headline-sm">{r.label}</span>
                      <span className={`font-body-sm text-body-sm ${on ? "text-on-primary-container/80" : "text-on-surface-variant"}`}>{HINT[k]}</span>
                    </span>
                    {on && <Icon name="check_circle" fill className="ml-auto text-[20px]" />}
                  </button>
                );
              })}
            </div>

            {(p.context?.tgt || p.context?.src) && (
              <div className="flex flex-col gap-1 bg-surface-container-low rounded-xl px-space-md py-space-sm">
                <span className="font-label-badge text-label-badge uppercase tracking-wider text-on-surface-variant">Passage joint automatiquement</span>
                {p.context.tgt && <span className="font-body-sm text-body-sm text-on-surface line-clamp-2">« {p.context.tgt} »</span>}
                {p.context.src && <span className="font-body-sm text-body-sm text-on-surface-variant italic line-clamp-2">{p.context.src}</span>}
              </div>
            )}

            <button
              type="button"
              disabled={!kind}
              onClick={() => kind && p.onSend(kind)}
              className="w-full h-14 rounded-xl bg-primary text-on-primary font-headline-sm text-headline-sm font-bold shadow-lg transition-all active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
            >
              Envoyer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
