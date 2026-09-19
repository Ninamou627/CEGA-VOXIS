import type { Lang } from "../../../shared/protocol";

/** Libellés et drapeaux des langues du protocole, pour toutes les interfaces. */
export const LANGS: Record<Lang, { label: string; short: string; flag: string }> = {
  en: { label: "English", short: "EN", flag: "🇺🇸" },
  fr: { label: "Français", short: "FR", flag: "🇫🇷" },
  es: { label: "Español", short: "ES", flag: "🇪🇸" },
  ar: { label: "العربية", short: "AR", flag: "🇸🇦" },
  pt: { label: "Português", short: "PT", flag: "🇵🇹" },
};

export const ALL_LANGS = Object.keys(LANGS) as Lang[];
