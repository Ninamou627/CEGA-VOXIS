/**
 * Installation de la page apprenant sur l'écran d'accueil d'un téléphone (D18).
 *
 * Facultative, toujours : un apprenant qui scanne le QR code doit pouvoir écouter sans rien
 * installer. Le service worker ne sert qu'à rendre l'installation possible et à éviter de
 * retélécharger le code à chaque ouverture — jamais à faire croire que la salle fonctionne
 * hors ligne.
 */

/**
 * Enregistre le service worker. Sans effet hors contexte sécurisé, ou dans un navigateur
 * sans support — et sans conséquence : la page fonctionne comme avant.
 */
export function enablePwa(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  const register = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err: Error) => {
      // Certificat non reconnu, service worker désactivé, navigation privée : on le dit et
      // on passe. Rien de tout cela n'empêche d'écouter la formation.
      console.warn(`[pwa] installation impossible : ${err.message}`);
    });
  };

  // Quand le navigateur souffle, mais sans attendre l'événement `load` : celui-ci attend la
  // vidéo de l'animation d'entrée (8 s), et l'enregistrement serait retardé d'autant.
  if ("requestIdleCallback" in window) window.requestIdleCallback(register, { timeout: 3000 });
  else setTimeout(register, 1200);
}
