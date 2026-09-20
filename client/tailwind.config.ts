/**
 * Design system des interfaces (tokens Material 3 de la maquette VOXIS).
 *
 * Les couleurs sont des variables CSS posées sur <html> : le jeu sombre est celui
 * de la maquette, le jeu clair sa déclinaison Material 3 (mêmes palettes tonales,
 * tons inversés). `html.dark` choisit le sombre ; sans la classe, le clair. Rayons,
 * espacements et styles de texte sont ceux de la maquette, repris tels quels : une
 * interface se reproduit avec les mêmes classes.
 */
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/** Jeu sombre : les tokens de la maquette, tels quels. */
const DARK = {
  primary: "#b4c5ff",
  "on-primary": "#002a78",
  "primary-container": "#2563eb",
  "on-primary-container": "#eeefff",
  "inverse-primary": "#0053db",
  "primary-fixed": "#dbe1ff",
  "primary-fixed-dim": "#b4c5ff",
  "on-primary-fixed": "#00174b",
  "on-primary-fixed-variant": "#003ea8",
  secondary: "#4edea3",
  "on-secondary": "#003824",
  "secondary-container": "#00a572",
  "on-secondary-container": "#00311f",
  "secondary-fixed": "#6ffbbe",
  "secondary-fixed-dim": "#4edea3",
  "on-secondary-fixed": "#002113",
  "on-secondary-fixed-variant": "#005236",
  tertiary: "#ffb95f",
  "on-tertiary": "#472a00",
  "tertiary-container": "#996100",
  "on-tertiary-container": "#ffeedd",
  "tertiary-fixed": "#ffddb8",
  "tertiary-fixed-dim": "#ffb95f",
  "on-tertiary-fixed": "#2a1700",
  "on-tertiary-fixed-variant": "#653e00",
  error: "#ffb4ab",
  "on-error": "#690005",
  "error-container": "#93000a",
  "on-error-container": "#ffdad6",
  surface: "#0f131c",
  "on-surface": "#dfe2ee",
  "surface-variant": "#31353e",
  "on-surface-variant": "#c3c6d7",
  "surface-dim": "#0f131c",
  "surface-bright": "#353942",
  "surface-container-lowest": "#0a0e16",
  "surface-container-low": "#181c24",
  "surface-container": "#1c2028",
  "surface-container-high": "#262a33",
  "surface-container-highest": "#31353e",
  "surface-tint": "#b4c5ff",
  background: "#0f131c",
  "on-background": "#dfe2ee",
  "inverse-surface": "#dfe2ee",
  "inverse-on-surface": "#2c3039",
  outline: "#8d90a0",
  "outline-variant": "#434655",
};

/**
 * Jeu clair : mêmes palettes tonales (les couleurs « fixed » ne bougent pas), tons
 * Material 3 du schéma clair — accents au ton 40, conteneurs au ton 90, texte des
 * conteneurs au ton 30, surfaces de 87 à 100.
 */
const LIGHT: Record<keyof typeof DARK, string> = {
  primary: "#0053db",
  "on-primary": "#ffffff",
  "primary-container": "#dbe1ff",
  "on-primary-container": "#003ea8",
  "inverse-primary": "#b4c5ff",
  "primary-fixed": "#dbe1ff",
  "primary-fixed-dim": "#b4c5ff",
  "on-primary-fixed": "#00174b",
  "on-primary-fixed-variant": "#003ea8",
  secondary: "#006c48",
  "on-secondary": "#ffffff",
  "secondary-container": "#6ffbbe",
  "on-secondary-container": "#005236",
  "secondary-fixed": "#6ffbbe",
  "secondary-fixed-dim": "#4edea3",
  "on-secondary-fixed": "#002113",
  "on-secondary-fixed-variant": "#005236",
  tertiary: "#7f5000",
  "on-tertiary": "#ffffff",
  "tertiary-container": "#ffddb8",
  "on-tertiary-container": "#653e00",
  "tertiary-fixed": "#ffddb8",
  "tertiary-fixed-dim": "#ffb95f",
  "on-tertiary-fixed": "#2a1700",
  "on-tertiary-fixed-variant": "#653e00",
  error: "#ba1a1a",
  "on-error": "#ffffff",
  "error-container": "#ffdad6",
  "on-error-container": "#93000a",
  surface: "#f9f9ff",
  "on-surface": "#191b23",
  "surface-variant": "#e1e2ec",
  "on-surface-variant": "#434655",
  "surface-dim": "#d9dae4",
  "surface-bright": "#f9f9ff",
  "surface-container-lowest": "#ffffff",
  "surface-container-low": "#f3f3fd",
  "surface-container": "#edeef8",
  "surface-container-high": "#e7e8f2",
  "surface-container-highest": "#e1e2ec",
  "surface-tint": "#0053db",
  background: "#f9f9ff",
  "on-background": "#191b23",
  "inverse-surface": "#2c3039",
  "inverse-on-surface": "#f0f0fc",
  outline: "#747786",
  "outline-variant": "#c3c6d7",
};

/** `#rrggbb` → `r g b`, la forme qui laisse Tailwind appliquer les opacités (`bg-surface/80`). */
function channels(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function variables(palette: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(palette).map(([name, hex]) => [`--${name}`, channels(hex)]));
}

const colors = Object.fromEntries(Object.keys(DARK).map((name) => [name, `rgb(var(--${name}) / <alpha-value>)`]));

export default {
  content: ["./index.html", "./lecturer.html", "./dashboard.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors,
      borderRadius: { DEFAULT: "0.25rem", lg: "0.5rem", xl: "0.75rem", full: "9999px" },
      spacing: {
        "gutter-mobile": "0.75rem",
        "space-lg": "1.5rem",
        "space-xl": "2.5rem",
        "margin-mobile": "1rem",
        "space-xs": "0.25rem",
        "space-sm": "0.5rem",
        margin: "2rem",
        "space-md": "1rem",
        gutter: "1.5rem",
      },
      fontFamily: {
        "body-sm": ["Inter", "system-ui", "sans-serif"],
        "headline-lg-mobile": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        "headline-sm": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        "display-hero": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        "body-transcript-lg": ["Inter", "system-ui", "sans-serif"],
        "metric-mono-lg": ["JetBrains Mono", "ui-monospace", "monospace"],
        "body-md": ["Inter", "system-ui", "sans-serif"],
        "headline-lg": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        "headline-md": ["Plus Jakarta Sans", "system-ui", "sans-serif"],
        "label-badge": ["JetBrains Mono", "ui-monospace", "monospace"],
        "metric-mono-sm": ["JetBrains Mono", "ui-monospace", "monospace"],
        "body-transcript-lg-mobile": ["Inter", "system-ui", "sans-serif"],
      },
      fontSize: {
        "body-sm": ["12px", { lineHeight: "16px", fontWeight: "400" }],
        "headline-lg-mobile": ["24px", { lineHeight: "32px", letterSpacing: "-0.01em", fontWeight: "600" }],
        "headline-sm": ["16px", { lineHeight: "24px", fontWeight: "600" }],
        "display-hero": ["48px", { lineHeight: "56px", letterSpacing: "-0.02em", fontWeight: "700" }],
        "body-transcript-lg": ["20px", { lineHeight: "32px", fontWeight: "400" }],
        "metric-mono-lg": ["18px", { lineHeight: "24px", letterSpacing: "-0.02em", fontWeight: "600" }],
        "body-md": ["14px", { lineHeight: "20px", fontWeight: "400" }],
        "headline-lg": ["32px", { lineHeight: "40px", letterSpacing: "-0.015em", fontWeight: "600" }],
        "headline-md": ["20px", { lineHeight: "28px", fontWeight: "600" }],
        "label-badge": ["11px", { lineHeight: "12px", letterSpacing: "0.06em", fontWeight: "700" }],
        "metric-mono-sm": ["12px", { lineHeight: "16px", letterSpacing: "0.02em", fontWeight: "500" }],
        "body-transcript-lg-mobile": ["16px", { lineHeight: "26px", fontWeight: "400" }],
      },
    },
  },
  plugins: [
    // Les deux jeux de couleurs, et le rendu natif (select, curseur) accordé au thème.
    plugin(({ addBase }) => {
      addBase({
        ":root": { colorScheme: "light", ...variables(LIGHT) },
        ":root.dark": { colorScheme: "dark", ...variables(DARK) },
      });
    }),
  ],
} satisfies Config;
