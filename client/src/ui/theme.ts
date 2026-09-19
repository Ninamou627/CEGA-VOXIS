/**
 * Thème clair / sombre, mémorisé sur l'appareil (clé `voxis-theme`, comme la maquette).
 * `dark` sur <html> pilote les variantes `dark:` de Tailwind ; `theme-light` est la
 * classe que la maquette pose en mode clair. La palette claire n'est pas encore définie :
 * aujourd'hui seule la classe change.
 */
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "voxis-theme";

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  el.classList.toggle("dark", theme === "dark");
  el.classList.toggle("theme-light", theme === "light");
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* navigation privée : on garde le thème pour la session seulement */
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
