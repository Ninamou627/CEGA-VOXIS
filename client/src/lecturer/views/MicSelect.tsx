/** Choix des périphériques et annulation d'écho : à l'entrée, puis en séance dans le panneau audio. */
import { canChooseOutput } from "../../lib/player";
import { Icon } from "../../ui/Icon";

export interface MicSelectProps {
  mics: MediaDeviceInfo[];
  deviceId: string;
  onDevice: (id: string) => void;
  aec: boolean;
  onAec: (on: boolean) => void;
  /** Sorties audio. Absentes là où le navigateur ne sait pas en choisir (Safari, iOS). */
  outputs?: MediaDeviceInfo[];
  outputId?: string;
  onOutput?: (id: string) => void;
}

/** Un `<select>` de périphérique : même habillage pour l'entrée et la sortie. */
function DeviceSelect(p: { label: string; value: string; onChange: (id: string) => void; devices: MediaDeviceInfo[]; fallback: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-on-surface-variant font-medium">{p.label}</span>
      <div className="relative">
        <select
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          className="w-full appearance-none bg-surface-container border border-outline-variant/30 rounded-xl pl-3 pr-9 py-2 text-xs text-on-surface focus:outline-none focus:border-secondary/60"
        >
          <option value="">Par défaut du système</option>
          {p.devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${p.fallback} ${i + 1} (autorisez le micro pour voir le nom)`}
            </option>
          ))}
        </select>
        <Icon name="expand_more" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant pointer-events-none" />
      </div>
    </label>
  );
}

export function MicSelect(p: MicSelectProps) {
  // Le choix de la sortie n'apparaît que là où il a un effet — sinon il mentirait.
  const withOutput = Boolean(p.onOutput) && canChooseOutput();

  return (
    <div className="flex flex-col gap-2">
      <DeviceSelect label="Micro" value={p.deviceId} onChange={p.onDevice} devices={p.mics} fallback="Micro" />

      {withOutput && (
        <DeviceSelect
          label="Sortie (votre casque)"
          value={p.outputId ?? ""}
          onChange={p.onOutput!}
          devices={p.outputs ?? []}
          fallback="Sortie"
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => p.onAec(!p.aec)}
          aria-pressed={p.aec}
          title="Obligatoire si la traduction sort des haut-parleurs de ce PC (test sur une seule machine)"
          className="bg-surface-container-low hover:bg-surface-container rounded-xl p-2.5 border border-outline-variant/20 flex flex-col gap-1 text-left transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-on-surface-variant font-medium">Annulation d'écho</span>
            <span className={`w-2 h-2 rounded-full ${p.aec ? "bg-secondary" : "bg-outline"}`}></span>
          </div>
          <span className="text-xs font-bold text-on-surface">{p.aec ? "Active" : "Inactive"}</span>
        </button>
        <div className="bg-surface-container-low rounded-xl p-2.5 border border-outline-variant/20 flex flex-col gap-1" title="Réduction de bruit et gain automatique du navigateur">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-on-surface-variant font-medium">Bruit + gain auto</span>
            <span className="w-2 h-2 rounded-full bg-secondary"></span>
          </div>
          <span className="text-xs font-bold text-on-surface">Navigateur</span>
        </div>
      </div>
    </div>
  );
}
