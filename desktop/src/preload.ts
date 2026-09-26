/**
 * Le seul pont entre la coquille et la page (D18), et il ne va que dans un sens : la
 * coquille annonce qu'un raccourci global a été pressé. Rien n'est exposé qui permettrait
 * à une page d'agir sur la machine — c'est pourquoi il n'y a qu'une fonction ici.
 */
import { contextBridge, ipcRenderer } from "electron";

const CHANNEL = "voxis:shortcut";

contextBridge.exposeInMainWorld("voxis", {
  /**
   * Écoute les raccourcis de l'application, même quand la fenêtre n'a pas le focus.
   * Rend une fonction de désabonnement.
   */
  onShortcut(handler: (name: string) => void): () => void {
    const listener = (_event: unknown, name: string) => handler(name);
    ipcRenderer.on(CHANNEL, listener);
    return () => {
      ipcRenderer.off(CHANNEL, listener);
    };
  },
});
