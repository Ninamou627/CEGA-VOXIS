import type { Lang } from "../../../shared/protocol";

/**
 * Libellés et drapeaux des langues du protocole, pour toutes les interfaces.
 * `label` est le nom dans la langue elle-même ; `nameFr` le nom en français, pour les phrases.
 */
export const LANGS: Record<Lang, { label: string; nameFr: string; short: string; flag: string }> = {
  en: { label: "English", nameFr: "anglais", short: "EN", flag: "🇺🇸" },
  fr: { label: "Français", nameFr: "français", short: "FR", flag: "🇫🇷" },
  es: { label: "Español", nameFr: "espagnol", short: "ES", flag: "🇪🇸" },
  ar: { label: "العربية", nameFr: "arabe", short: "AR", flag: "🇸🇦" },
  pt: { label: "Português", nameFr: "portugais", short: "PT", flag: "🇵🇹" },
};

export const ALL_LANGS = Object.keys(LANGS) as Lang[];
