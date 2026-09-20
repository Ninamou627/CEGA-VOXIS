/**
 * Thème clair / sombre, mémorisé sur l'appareil (clé `voxis-theme`, comme la maquette).
 * `dark` sur <html> choisit le jeu de couleurs sombre (client/tailwind.config.ts) et
 * pilote les variantes `dark:` ; sans la classe, le jeu clair. `theme-light` est la
 * classe que la maquette pose en mode clair, gardée pour ses sélecteurs éventuels.
 * index.html applique le choix mémorisé avant le premier rendu, pour ne pas cligner.
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

/** Couleur de la barre du navigateur : la surface de chaque thème. */
const THEME_COLOR: Record<Theme, string> = { dark: "#0f131c", light: "#f9f9ff" };

let fadeTimer: number | undefined;

export function applyTheme(theme: Theme): void {
  const el = document.documentElement;
  // Fondu de couleurs quand le thème change vraiment, sauf si l'appareil demande moins d'animations.
  if (el.classList.contains("dark") !== (theme === "dark") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.classList.add("theme-fade");
    clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => el.classList.remove("theme-fade"), 400);
  }
  el.classList.toggle("dark", theme === "dark");
  el.classList.toggle("theme-light", theme === "light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
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
