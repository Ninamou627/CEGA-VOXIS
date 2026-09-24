/**
 * Modèles Claude proposés à l'administration pour la traduction, et ce que l'API
 * accepte pour chacun. Opus 5, Opus 5.5 et Sonnet 5 refusent la température (400) :
 * ils se règlent par l'effort. Haiku 4.5 accepte la température mais refuse l'effort.
 * Envoyer un paramètre refusé casserait la traduction en pleine séance — d'où ce tableau.
 */
import type { ClaudeModel } from "../../../../shared/admin";

export const CLAUDE_MODELS: ClaudeModel[] = [
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    effort: true,
    temperature: false,
    fallbacks: true,
    note: "Le plus sûr pour le registre d'interprète. Modèle par défaut.",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    effort: true,
    temperature: false,
    fallbacks: true,
    note: "Successeur d'Opus 5, moins cher. Réflexion toujours active : l'effort est le seul levier.",
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    effort: true,
    temperature: false,
    fallbacks: false,
    note: "Plus rapide, à comparer sur la fixture avant de l'adopter.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    effort: false,
    temperature: true,
    fallbacks: false,
    note: "Le plus rapide. Seul modèle de la liste qui accepte la température.",
  },
];

/** Un identifiant hors liste (venu du .env) garde le comportement d'origine : effort et repli. */
export function modelCaps(id: string): ClaudeModel {
  return CLAUDE_MODELS.find((m) => m.id === id) ?? { id, label: id, effort: true, temperature: false, fallbacks: true, note: "Modèle défini dans le .env." };
}
