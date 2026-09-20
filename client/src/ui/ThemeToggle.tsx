import { Icon } from "./Icon";
import { useTheme } from "./theme";

/**
 * Trois formes dans les maquettes : l'interrupteur à deux icônes (écran d'écoute), le
 * bouton rond à une icône (studio de question) et le bouton carré du poste formateur,
 * qui montre le thème vers lequel on bascule. Même thème derrière.
 */
export function ThemeToggle({ variant = "switch" }: { variant?: "switch" | "round" | "square" }) {
  const [theme, toggle] = useTheme();
  const light = theme === "light";
  if (variant === "square") {
    return (
      <button
        type="button"
        aria-label="Basculer thème sombre / clair"
        title="Basculer thème clair/sombre"
        aria-pressed={light}
        onClick={toggle}
        className="flex items-center justify-center w-10 h-10 rounded-xl bg-surface-container hover:bg-surface-container-high border border-outline-variant/30 text-on-surface transition-all cursor-pointer shadow-sm"
      >
        <Icon name={light ? "dark_mode" : "light_mode"} className={`text-[20px] ${light ? "text-primary" : "text-tertiary"}`} />
      </button>
    );
  }
  if (variant === "round") {
    return (
      <button
        type="button"
        aria-label="Basculer le thème"
        aria-pressed={light}
        onClick={toggle}
        className="w-9 h-9 rounded-full bg-surface-container-high hover:bg-surface-bright text-on-surface flex items-center justify-center transition-colors shadow-sm focus:outline-none"
      >
        <Icon name={light ? "light_mode" : "dark_mode"} className="text-[20px] text-tertiary" />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label="Basculer mode clair et sombre"
      aria-pressed={light}
      onClick={toggle}
      className="relative flex items-center justify-between w-14 h-8 px-1 rounded-full bg-surface-container-highest active:bg-surface-bright cursor-pointer transition-colors shadow-sm focus:outline-none"
    >
      <Icon name="dark_mode" className="text-[16px] text-tertiary transition-colors" />
      <Icon name="light_mode" className="text-[16px] text-on-surface-variant transition-colors" />
      <span
        className={`absolute left-1 top-1 w-6 h-6 rounded-full bg-primary flex items-center justify-center shadow-md transition-transform duration-200 pointer-events-none ${light ? "translate-x-6" : ""}`}
      >
        <Icon name={light ? "light_mode" : "dark_mode"} className="text-on-primary text-[14px]" />
      </span>
    </button>
  );
}
