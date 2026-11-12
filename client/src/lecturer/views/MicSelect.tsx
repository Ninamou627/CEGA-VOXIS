/** Choix des périphériques et annulation d'écho : à l'entrée, puis en séance dans le panneau audio. */
import { canChooseOutput } from "../../lib/player";
import { Icon } from "../../ui/Icon";

export interface MicSelectProps {
  mics: MediaDeviceInfo[];
  deviceId: string;
  onDevice: (id: string) => void;
  aec: boolean;
  onAec: (on: boolean) => void;
  /** Réduction de bruit et gain automatique du navigateur ; les couper est une piste de l'essai F-03 (D38). */
  processing: boolean;
  onProcessing: (on: boolean) => void;
  /** Conversion vers 16 kHz faite ici (contexte natif) plutôt que par le navigateur — l'autre piste (D38). */
  nativeRate: boolean;
  onNativeRate: (on: boolean) => void;
  /** Fréquence du contexte réellement ouvert, affichée quand le micro tourne. */
  contextRate?: number;
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
        <Toggle
          label="Annulation d'écho"
          on={p.aec}
          value={p.aec ? "Active" : "Inactive"}
          title="Obligatoire si la traduction sort des haut-parleurs de ce PC (test sur une seule machine)"
          onClick={() => p.onAec(!p.aec)}
        />
        <Toggle
          label="Bruit + gain auto"
          on={p.processing}
          value={p.processing ? "Navigateur" : "Coupés"}
          title="Réduction de bruit et gain automatique du navigateur. Les couper est un essai de diagnostic : si le son perdu disparaît, c'est eux (D38)."
          onClick={() => p.onProcessing(!p.processing)}
        />
      </div>
      <Toggle
        label="Conversion vers 16 kHz"
        on={!p.nativeRate}
        value={p.nativeRate ? `Dans la page${p.contextRate ? ` (micro à ${Math.round(p.contextRate / 1000)} kHz)` : ""}` : "Par le navigateur"}
        title="Par le navigateur : chemin habituel, où du son se perdait certains jours. Dans la page : le micro reste à sa fréquence native et la page convertit elle-même (D38)."
        onClick={() => p.onNativeRate(!p.nativeRate)}
      />
    </div>
  );
}

/** Un réglage à deux états, même habillage que les tuiles du panneau audio. */
function Toggle(p: { label: string; on: boolean; value: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={p.onClick}
      aria-pressed={p.on}
      title={p.title}
      className="bg-surface-container-low hover:bg-surface-container rounded-xl p-2.5 border border-outline-variant/20 flex flex-col gap-1 text-left transition-colors"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-on-surface-variant font-medium">{p.label}</span>
        <span className={`w-2 h-2 rounded-full ${p.on ? "bg-secondary" : "bg-outline"}`}></span>
      </div>
      <span className="text-xs font-bold text-on-surface">{p.value}</span>
    </button>
  );
}
