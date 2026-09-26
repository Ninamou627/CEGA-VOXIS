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
| Raccourcis, notifications, sortie audio | limités | natifs (étape 3) |

L'apprenant reste sur le Web : rien à installer pour scanner un QR code.

## Développer

```bash
npm run db:up && npm run dev          # le serveur de salle, dans un terminal
VOXIS_URL=https://localhost:8787 npm run dev -w desktop
```

`VOXIS_URL` remplace l'adresse de production. Le certificat auto-signé du serveur de
développement est accepté — **pour `localhost` seulement, et hors application empaquetée**.

Sans cette variable, la coquille ouvre `https://institutcega.fr`.

## Ce qu'elle fait, et ce qu'elle ne fait pas

Elle accorde le micro, le choix du haut-parleur, le presse-papiers et les notifications **au
seul domaine de la salle** ; tout le reste est refusé, et la navigation hors de ce domaine
part dans le vrai navigateur. `contextIsolation` est actif, `nodeIntegration` ne l'est pas, et
le rendu est en bac à sable.

Elle ne contient **aucune** interface, aucune logique métier, aucune clé d'API, aucune base de
données. Un déploiement du serveur la met à jour : rien à réinstaller.

Menu : `Ctrl+1` poste formateur, `Ctrl+2` administration, `Ctrl+R` recharger.

## Reste à faire

- **Étape 2** — taille de fenêtre mémorisée, écran de reconnexion plus complet.
- **Étape 3** — choix de la sortie audio (à ajouter dans le client partagé, pour que le Web
  en profite aussi), raccourci de coupure micro, notification à l'arrivée d'une question.
- **Étape 4** — `CEGA_VOXIS_Setup.exe` par electron-builder, mise à jour automatique, page de
  téléchargement sur le serveur.

## Signature du code

Il n'y a pas de certificat pour l'instant : Windows SmartScreen affichera un avertissement à
la première installation. Voir D18 pour les parades et les options de signature.
