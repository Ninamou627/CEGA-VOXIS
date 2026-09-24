/**
 * Battements de la salle pour la constellation : chaque événement réel — mot entendu,
 * segment figé, traduction reçue, voix produite — fait vibrer l'étage où il se produit.
 * Un bus minuscule plutôt qu'un état React : ces battements arrivent plusieurs fois par
 * seconde et ne doivent animer que la constellation, sans redessiner la page.
 */
import type { StageId } from "./signals";

export type PulseKind = "partial" | "commit" | "segment" | "voice";
type Listener = (stage: StageId, kind: PulseKind) => void;

const listeners = new Set<Listener>();

export function pulse(stage: StageId, kind: PulseKind): void {
  for (const l of listeners) l(stage, kind);
}

export function onPulse(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
