/**
 * Notification du système pour le formateur : une question est arrivée alors qu'il regardait
 * ailleurs (D18).
 *
 * Écrit dans le client partagé, pas dans la coquille : un formateur sur navigateur en
 * profite aussi. La différence tient à l'autorisation — l'application de bureau l'accorde
 * d'office à la salle, un navigateur la demande.
 */

const supported = (): boolean => typeof Notification !== "undefined";

/**
 * Demande l'autorisation, à appeler dans un geste de l'utilisateur (le démarrage du micro).
 * Ne demande jamais deux fois, et ne relance pas qui a déjà refusé.
 */
export async function askToNotify(): Promise<void> {
  if (!supported() || Notification.permission !== "default") return;
  try {
    await Notification.requestPermission();
  } catch {
    /* refus ou navigateur sans notifications : la séance continue sans */
  }
}

/**
 * Signale l'événement, mais seulement si la page n'est pas sous les yeux : une notification
 * pour ce qu'on voit déjà à l'écran est du bruit.
 */
export function notifyIfUnseen(title: string, body: string): void {
  if (!supported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const n = new Notification(title, { body, tag: "voxis-question", silent: false });
    // Un clic ramène la salle au premier plan.
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* certaines plateformes exigent un service worker : on s'en passe */
  }
}
