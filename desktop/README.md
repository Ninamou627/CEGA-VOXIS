# CEGA Voxis pour Windows

Une fenêtre sur la plateforme en ligne (D18), pas une seconde application. Elle charge les
pages servies par `institutcega.fr` — les mêmes que dans un navigateur — et n'apporte que ce
qu'un navigateur ne sait pas faire.

## Pourquoi une version de bureau

| | Navigateur | Application |
|---|---|---|
| Micro autorisé | à chaque profil, parfois redemandé | accordé d'office, au domaine de la salle |
| Onglet perdu au milieu d'une séance | possible | la fenêtre est à elle seule |
| Navigation ailleurs | possible | verrouillée sur la salle |
| Couper le micro sans revenir à la fenêtre | impossible | `Ctrl+Shift+M`, depuis n'importe où |

Deux des apports de l'étape 3 — le **choix de la sortie audio** et la **notification à
l'arrivée d'une question** — sont écrits dans le client partagé, pas ici : un formateur sur
navigateur en profite de la même façon. Seul le raccourci **global** relève de la coquille,
parce qu'un navigateur ne sait pas l'offrir.

## Le pont vers la page

Un seul objet est exposé, et il ne va que dans un sens : `window.voxis.onShortcut(nom)`.
La coquille annonce qu'un raccourci a été pressé ; rien ne permet à la page d'agir sur la
machine. Le client s'y abonne s'il existe (`client/src/lib/desktop.ts`) et fonctionne sans
lui dans un navigateur.

L'apprenant reste sur le Web : rien à installer pour scanner un QR code.

## Développer

```bash
npm run db:up && npm run dev          # le serveur de salle, dans un terminal
npm run dev -w desktop                # la coquille, dans un autre
```

Hors empaquetage, la coquille vise `https://localhost:8787` ; une fois empaquetée, elle vise
`https://institutcega.fr`. `VOXIS_URL` l'emporte dans les deux cas — pour ouvrir la
production depuis une version de développement, par exemple.

Le certificat auto-signé du serveur de développement est accepté — **pour `localhost`
seulement, et jamais dans une application empaquetée**. `VOXIS_DEBUG=1` affiche en plus ce
que la coquille lit de l'état de la fenêtre.

## Ce qu'elle fait, et ce qu'elle ne fait pas

Elle accorde le micro, le choix du haut-parleur, le presse-papiers et les notifications **au
seul domaine de la salle** ; tout le reste est refusé, et la navigation hors de ce domaine
part dans le vrai navigateur. `contextIsolation` est actif, `nodeIntegration` ne l'est pas, et
le rendu est en bac à sable.

Elle ne contient **aucune** interface, aucune logique métier, aucune clé d'API, aucune base de
données. Un déploiement du serveur la met à jour : rien à réinstaller.

Menu : `Ctrl+1` poste formateur, `Ctrl+2` administration, `Ctrl+R` recharger.

## Quand la salle ne répond pas

La coquille affiche un écran d'attente (`static/offline.html`), interroge `/api/health` à
cadence décroissante — 2 s d'abord, jusqu'à 15 s ensuite — et rouvre **la page qu'on
visait** dès que le serveur revient. Un bouton permet de ne pas attendre.

Cet écran ne couvre que les échecs de chargement. Une coupure **en pleine séance** est déjà
traitée dans la page elle-même : `SalleSocket` se reconnecte avec backoff et l'en-tête
affiche l'état de la liaison. La coquille n'en fait pas un doublon.

La fenêtre retrouve sa taille et sa position au lancement suivant
(`%APPDATA%/@salle/desktop/window-state.json`). Un écran débranché depuis la dernière fois
ne l'envoie pas hors de vue : la position est alors laissée au système.

## Reste à faire

- **Étape 4** — `CEGA_VOXIS_Setup.exe` par electron-builder, mise à jour automatique, page de
  téléchargement sur le serveur. Penser à inclure `static/` dans les fichiers empaquetés.
- **Étape 5** — PWA de la page apprenant (manifeste, icônes, service worker *réseau d'abord*
  pour ne jamais servir une version périmée).

## Signature du code

Il n'y a pas de certificat pour l'instant : Windows SmartScreen affichera un avertissement à
la première installation. Voir D18 pour les parades et les options de signature.
