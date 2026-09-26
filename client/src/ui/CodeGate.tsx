/**
 * Entrée du code de séance (D17), pour l'apprenant et l'écran de salle.
 *
 * Le QR code porte déjà le code : personne ne devrait voir cet écran. Il sert quand
 * l'adresse a été tapée à la main, quand le code a expiré, ou quand l'appareil photo
 * n'a pas fonctionné — le formateur dicte alors les six caractères.
 */
import { useState } from "react";
import { APP_NAME } from "./brand";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

export interface CodeGateProps {
  surface: string;
  onCode: (code: string) => void;
  error?: string;
}

export function CodeGate({ surface, onCode, error }: CodeGateProps) {
  const [code, setCode] = useState("");
  const ready = code.replace(/[^A-Z0-9]/g, "").length >= 6;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (ready) onCode(code);
  }

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-surface">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <Logo className="w-9 h-9" />
          <span className="font-label-badge text-xs uppercase tracking-widest text-primary font-bold">{surface}</span>
          <h1 className="font-headline-lg text-2xl font-bold text-on-surface tracking-tight">{APP_NAME}</h1>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
          <p className="text-sm text-on-surface-variant leading-relaxed">
            Scannez le QR code affiché dans la salle, ou saisissez le code de séance que le formateur vous donne.
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-on-surface-variant font-medium">Code de séance</span>
            <input
              value={code}
              // Le code n'a ni I, ni O, ni 0, ni 1 : rien à distinguer à la saisie.
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="A7KP2M"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- la page n'a que ce champ
              autoFocus
              className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-3 font-metric-mono-sm text-center text-2xl tracking-[0.3em] text-on-surface placeholder:text-outline focus:outline-none focus:border-secondary/60"
            />
          </label>

          {error && (
            <p role="alert" className="text-[13px] text-error leading-relaxed flex items-start gap-2">
              <Icon name="gpp_bad" className="text-[17px] shrink-0 mt-px" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!ready}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-secondary text-on-secondary hover:bg-secondary-fixed font-headline-sm text-sm font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            <Icon name="login" fill className="text-[20px]" />
            <span>Rejoindre la séance</span>
          </button>
        </div>
      </form>
    </div>
  );
}
