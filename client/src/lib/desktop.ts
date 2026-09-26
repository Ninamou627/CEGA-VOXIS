/**
 * L'application de bureau, vue depuis la page (D18).
 *
 * Les quatre interfaces restent des pages web ordinaires : ce pont est toujours
 * facultatif, et tout ce qui s'y branche doit fonctionner sans lui dans un navigateur.
 */

export interface DesktopBridge {
  /** Raccourci global pressé, même fenêtre non focalisée. Rend une fonction d'arrêt. */
  onShortcut(handler: (name: string) => void): () => void;
}

/** Le pont, ou `undefined` dans un navigateur. */
export function desktop(): DesktopBridge | undefined {
  return (window as unknown as { voxis?: DesktopBridge }).voxis;
}

export const isDesktop = (): boolean => Boolean(desktop());
