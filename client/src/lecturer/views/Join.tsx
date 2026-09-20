/** Entrée du poste formateur : jeton de session, micro, puis « Démarrer le micro ». */
import { Icon } from "../../ui/Icon";
import { MicSelect, type MicSelectProps } from "./MicSelect";

export interface JoinProps extends MicSelectProps {
  token: string;
  onToken: (t: string) => void;
  onStart: () => void;
}

export function Join(p: JoinProps) {
  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-5 pt-6">
      <div className="flex flex-col gap-1">
        <span className="font-label-badge text-xs uppercase tracking-widest text-primary font-bold">Poste formateur</span>
        <h1 className="font-headline-lg text-2xl font-bold text-on-surface tracking-tight">Ouvrir la salle</h1>
        <p className="text-sm text-on-surface-variant">
          Votre micro HF est capté par ce navigateur, transcrit et traduit pour les apprenants ; leurs questions arrivent dans votre casque.
        </p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-on-surface-variant font-medium">Jeton de session</span>
          <input
            value={p.token}
            onChange={(e) => p.onToken(e.target.value)}
            placeholder="SESSION_TOKEN du .env"
            autoComplete="off"
            className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 font-metric-mono-sm text-sm text-on-surface placeholder:text-outline focus:outline-none focus:border-secondary/60"
          />
        </label>
        <MicSelect mics={p.mics} deviceId={p.deviceId} onDevice={p.onDevice} aec={p.aec} onAec={p.onAec} />
        <button
          type="button"
          disabled={!p.token}
          onClick={p.onStart}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-secondary text-on-secondary hover:bg-secondary-fixed font-headline-sm text-sm font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
        >
          <Icon name="mic" fill className="text-[20px]" />
          <span>Démarrer le micro</span>
        </button>
        <p className="text-[11px] text-on-surface-variant">
          Chrome recommandé. Casque fermé obligatoire : un casque ouvert à côté d'un micro ouvert, c'est un larsen.
        </p>
      </div>
    </div>
  );
}
