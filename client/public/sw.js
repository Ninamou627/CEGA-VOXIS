/**
 * Service worker de la page apprenant (D18).
 *
 * Principe : **le réseau d'abord, toujours**. Les interfaces sont servies en ligne et se
 * mettent à jour par déploiement du serveur ; un cache qui répondrait à sa place servirait
 * une version périmée — exactement ce que toute l'architecture cherche à éviter.
 *
 * Ce service worker n'est donc pas là pour faire fonctionner la salle hors ligne : une
 * traduction en direct n'a aucun sens sans réseau. Il est là pour deux choses :
 *   - rendre la page installable sur l'écran d'accueil d'un téléphone ;
 *   - éviter de retélécharger les polices et le code à chaque ouverture, sur le Wi-Fi
 *     fatigué d'un hôtel.
 */

/** Change à chaque déploiement grâce aux noms de fichiers hachés par Vite. */
const CACHE = "voxis-v1";

/**
 * Vite hache le nom de chaque fichier produit (`index-BvGWMwIV.js`) : une adresse d'actif
 * désigne un contenu qui ne changera jamais. Ceux-là, et eux seuls, se servent depuis le
 * cache sans même consulter le réseau.
 */
const IMMUABLE = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|ttf|png|svg|jpe?g|mp4)$/;

self.addEventListener("install", (event) => {
  // Le nouveau service worker prend la main sans attendre la fermeture des onglets.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Les caches d'une version précédente n'ont plus de raison d'être.
      const noms = await caches.keys();
      await Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // On ne touche ni aux requêtes d'API, ni au WebSocket, ni à rien d'autre que GET.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (IMMUABLE.test(url.pathname)) {
    event.respondWith(depuisLeCache(request));
    return;
  }

  event.respondWith(reseauDAbord(request));
});

/** Contenu immuable : le cache d'abord, le réseau seulement s'il manque. */
async function depuisLeCache(request) {
  const cache = await caches.open(CACHE);
  const connu = await cache.match(request);
  if (connu) return connu;
  const reponse = await fetch(request);
  if (reponse.ok) void cache.put(request, reponse.clone());
  return reponse;
}

/**
 * Tout le reste — les pages en premier lieu : le réseau fait foi. Le cache ne sert que de
 * filet quand la connexion a lâché, et il vaut mieux une page d'hier qu'une page blanche.
 */
async function reseauDAbord(request) {
  const cache = await caches.open(CACHE);
  try {
    const reponse = await fetch(request);
    if (reponse.ok) void cache.put(request, reponse.clone());
    return reponse;
  } catch (err) {
    const secours = await cache.match(request);
    if (secours) return secours;
    // Une navigation sans rien en cache : mieux vaut un message qu'une erreur du navigateur.
    if (request.mode === "navigate") {
      const accueil = await cache.match("/");
      if (accueil) return accueil;
    }
    throw err;
  }
}
