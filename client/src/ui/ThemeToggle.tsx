import { Icon } from "./Icon";
import { useTheme } from "./theme";

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const light = theme === "light";
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
