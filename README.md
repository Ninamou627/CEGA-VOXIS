# CEGA Voxis — interprète de salle

Interprétation IA quasi simultanée EN ↔ FR pour une salle de formation : le formateur
parle dans son micro HF, les apprenants entendent une voix française dans leurs
écouteurs, et peuvent poser une question qui arrive en anglais dans le casque du formateur.

L'objectif est **moins d'une seconde de la fin d'une phrase du formateur au début de sa
traduction entendue** (D19). Mesuré le 14/10/2026 avec les vrais moteurs : environ 4 s ; le
tableau de bord affiche cette latence en direct, avec le décalage ressenti depuis le
premier mot.

Les décisions d'architecture et leurs raisons sont dans [docs/DECISIONS.md](docs/DECISIONS.md).

## Démarrer en deux minutes (sans aucune clé API)

```bash
npm install
cp .env.example .env
npm run dev
```

Puis, dans cet ordre :

1. **Tableau de bord** — <http://localhost:5173/dashboard?token=change-me>
2. **Formateur** — <http://localhost:5173/lecturer?token=change-me> → *Démarrer le micro*
   (sans micro : mettez `MOCK_STT_CLOCK=timer` dans `.env`)
3. **Apprenant** — <http://localhost:5173/> → *Écouter*. Depuis un téléphone sur le même
   Wi-Fi : `http://<IP-du-PC>:5173/`
4. **Écran de salle** — <http://localhost:5173/screen> sur le projecteur, en plein écran (touche F)

Les fournisseurs simulés (`mock`) produisent de vraies hypothèses partielles instables,
une pseudo-traduction et un vrai fichier audio jouable dont la durée correspond à celle
d'une voix. Tout le pipeline — commit verrouillé, segmentation, files, dérive, ack de
latence — est donc exercé pour de vrai, sans dépenser un centime.

## Ce qui est en place

| Brique | Fichier | État |
|---|---|---|
| Contrat d'événements (révisable vs définitif) | `shared/protocol.ts` | ✅ |
| Trame binaire audio ; micro du formateur en trames numérotées et datées, 30 s gardées et renvoyées à la reconnexion (D37) ; variantes de captation à l'essai — traitements coupés, conversion vers 16 kHz dans la page (D38) | `shared/framing.ts`, `shared/uplink.ts`, `client/public/pcm-worklet.js` | ✅ testé |
| Commit verrouillé LocalAgreement-2 + règles de coupe, insensible aux révisions du STT (D36) | `server/src/pipeline/commit.ts` | ✅ testé |
| Orchestration STT → MT → TTS, backlog ; aucun son perdu entre micro et STT : attente pendant une réouverture, parole non rendue rejouée avec son contexte, relève avant 3 h, retard rendu à l'arrêt (D37) ; deux files ordonnées par langue, secours en course quand le primaire tarde, boucle jamais figée plus de ~0,1 s (D39) | `server/src/pipeline/pipeline.ts`, `providers/fallback.ts` | ✅ testé |
| Retard borné sans rien sauter : un contrôleur par langue sur la file des téléphones, paliers à 3, 5 et 8 s — pauses gardées retirées et voix vers ×1,1, formulation resserrée vérifiée (nombres, noms, négations) si l'administration l'a permise, alerte au formateur et au tableau de bord (D42) | `server/src/pipeline/lagcontrol.ts`, `pipeline/tighten.ts` | ✅ testé en simulation |
| Fournisseurs simulés | `server/src/providers/*/mock.ts` | ✅ |
| Traduction Claude (registre interprète, glossaire, cache) | `server/src/providers/mt/anthropic.ts` | ✅ à valider avec une clé |
| STT AssemblyAI (primaire) / Deepgram (secours + questions) | `server/src/providers/stt/` | ✅ écrits, à valider avec une clé (`npm run check`) |
| TTS ElevenLabs (continuité, vitesse) / Azure (secours) | `server/src/providers/tts/` | ✅ écrits, à valider avec une clé (`npm run check`) |
| Durée MP3 exacte pour la file | `server/src/util/mp3.ts` | ✅ vérifié |
| Vitesse adaptative serveur + lecture locale (dérive) | `pipeline.ts`, `client/src/lib/player.ts` | ✅ |
| Guide certificat DNS-01 | `docs/CERTIFICAT.md` | ✅ |
| Salle, mutex de parole, fan-out ; au retour d'une coupure, le texte manqué renvoyé (5 min au plus), la voix reprend au direct (D40) | `server/src/room.ts`, `ws/handlers.ts`, `shared/catchup.ts` | ✅ testé |
| Lecture gardée sur le téléphone : « durée + 2 s », un nouvel essai, puis échec signalé au journal et au tableau de bord (D40) | `client/src/lib/player.ts`, `shared/playguard.ts` | ✅ testé |
| Métriques JSONL + bout-en-bout mesuré à l'ack ; en direct, décalage par mot, retard maximal et pente du retard, pannes écartées (D41) | `server/src/metrics.ts` | ✅ testé |
| Page apprenant (maquette VOXIS : écoute, volume, transcription, boutons flottants) | `client/src/listener` | ✅ |
| Studio de question : micro (30 s max) **ou** question écrite, retour bilingue | `client/src/listener/views/Studio.tsx` | ✅ |
| Signalement de qualité en deux gestes, contexte joint par le serveur (D14) | `views/ReportSheet.tsx`, `server/src/ws/handlers.ts` | ✅ |
| Design system des interfaces (tokens Tailwind clair/sombre, polices et icônes embarquées) | `client/tailwind.config.ts`, `client/src/theme.css`, `client/src/ui` | ✅ |
| Poste formateur (maquette Control Hub : micro et niveaux, onde réelle, pipeline, flux bilingue, questions, muet à l'Espace) | `client/src/lecturer` | ✅ |
| Administration : vue d'ensemble (5 indicateurs), supervision en temps réel, qualité (4 piliers mesurés), gestion des voix ElevenLabs, configuration globale appliquée à chaud, séance (QR, checklist, questions, journal) — D15 | `client/src/dashboard`, `server/src/admin.ts`, `server/src/settings.ts`, `server/src/totals.ts` | ✅ |
| Écran de salle pour le projecteur (QR en grand avant la séance, sous-titres géants, questions en bandeau, réglages à la souris et au clavier) | `client/src/screen` | ✅ |
| Rejeu d'une fixture WAV dans le pipeline | `server/scripts/replay.ts` | ✅ |
| Enregistrement des séances (voix du formateur, segments, voix traduite, écoutes), désactivé par défaut | `server/src/recorder.ts` | ✅ |
| Rapport de latence d'une séance : en tête, décalage par mot, retard maximal et pente du retard (D41) ; du début de parole au premier son, étage par étage, et fiabilité de la mesure (D24) | `server/src/latency-report.ts`, `server/scripts/report.ts` | ✅ |
| Fidélité de la voix traduite : débit, hauteur, énergie, intonation, pauses, intelligibilité, qualité (D24) | `server/src/prosody.ts`, `server/scripts/prosody.ts` | ✅ |

## Commandes

```bash
npm run dev          # serveur (8787) + client Vite (5173)
npm test             # tests du commit verrouillé
npm run typecheck    # serveur + client
npm run build        # client → client/dist, servi ensuite par le serveur
npm start            # serveur seul, sert client/dist
npm run replay -- fixtures/formateur-10min.wav   # rejoue une fixture comme si c'était le micro
npm run check        # valide les fournisseurs du .env en 30 s (écrit fixtures/check-tts.mp3)
npm run load -- 50 80   # 50 apprenants simulés pendant 80 s (serveur + fan-out, pas le Wi-Fi)
npm run report -- server/metrics.jsonl --from 15:58 --to 16:15   # d'où vient le délai d'une séance
npm run prosody -- data/enregistrements/<séance> [<autre séance>] [--stt] [--judge]   # fidélité de la voix
npm run gate -- data/enregistrements/<séance>   # aucun mot du STT perdu ni doublé par le découpage ? (hors ligne, D36)
```

Test de charge du 16/09/2026, serveur isolé avec simulateurs (audio WAV non compressé,
4× plus lourd que le MP3 réel) : 50 apprenants, 0 reconnexion, 0 trame perdue, CPU
serveur 3–6 %, 88 Mo, retard de boucle ≤ 21 ms, bout-en-bout p95 identique à 1 client.
Le serveur n'est pas la limite — la salle se joue sur le Wi-Fi.

## Les interfaces

Les écrans sont maquettés (VOXIS, Material 3 sombre) puis reproduits dans `client/src`
avec le même vocabulaire : les tokens de la maquette (couleurs, rayons, espacements,
styles de texte) vivent dans `client/tailwind.config.ts`, les polices (Inter, Plus
Jakarta Sans, JetBrains Mono) et les icônes Material Symbols sont embarquées dans le
build — un téléphone sur la borne de la salle n'a pas forcément Internet. Les briques
communes (icône, logo, thème clair/sombre, langues, courbes) sont dans `client/src/ui`,
chaque page garde son dossier (`listener`, `lecturer`, `dashboard`) avec ses vues. Les vues de la page
apprenant tient sur un écran, avec deux boutons flottants : poser une question (le
studio s'ouvre par-dessus, micro ou clavier) et signaler un problème (feuille par le
bas). L'écran de salle (`/screen`) se branche avec le rôle `screen` : tout le texte,
toutes les langues, jamais d'audio.

La page apprenant est **installable** sur l'écran d'accueil d'un téléphone (manifeste,
icônes, service worker). L'installation reste facultative : qui scanne le QR code écoute
sans rien installer. Le service worker travaille **réseau d'abord** — il ne sert qu'à
éviter de retélécharger le code sur un Wi-Fi fatigué, jamais à faire croire que la salle
fonctionne hors ligne, et jamais à servir une version périmée après un déploiement.

À l'ouverture de chaque interface, l'**animation d'entrée** CEGA Voxis
(`client/public/media/intro.mp4`, 8 s, muette) se joue une fois par onglet, par-dessus
l'interface qui se charge dessous. « Passer » ou Échap l'interrompt ; si elle ne peut pas
démarrer (lecture automatique refusée, fichier absent), on entre sans elle, et un onglet
ouvert en arrière-plan la joue quand on y vient. Pour la changer, remplacer le fichier
(H.264 ; chaque téléphone le télécharge à sa première ouverture, visez moins de 2 Mo).

Les signalements des apprenants arrivent à l'administration — pas chez le formateur,
qu'ils interrompraient pendant qu'il parle — et sont écrits dans `metrics.jsonl` avec l'heure, la phrase, sa transcription, sa
traduction et le décalage mesuré — c'est ce qu'on relit pour régler la segmentation,
enrichir le glossaire ou changer de voix (D14).

## L'administration

`/dashboard` demande un compte d'administration (D17), puis ouvre six pages derrière un
menu latéral, sans cartes : des bandeaux de chiffres, des lignes, des filets.

| Page | Ce qu'on y fait |
|---|---|
| Vue d'ensemble | Apprenants connectés, temps de traduction, latence moyenne, disponibilité, alertes ; la chaîne micro → audio → reconnaissance → traduction → voix ; les alertes ; les quatre piliers |
| Supervision | Chaque étage avec son moteur et son temps médian, les derniers incidents, 10 min de latence et de dérive, la santé du serveur, le flux en direct |
| Qualité | Rapidité, transcription, traduction, voix — aujourd'hui ou depuis le début, sur 14 jours ; les signalements par cause et un par un ; la définition de chaque chiffre |
| Voix | Voix par défaut de chaque langue, voix de la salle avec leur naturalité perçue, ajout depuis le compte ElevenLabs (liste ou identifiant), écoute, secours Azure |
| Configuration | Traduction (moteurs, modèle, effort ou température, délai, continuité, contexte, glossaire), parole (gain, seuil, silence, fin de phrase, segmentation, vocabulaire), voix (défauts, vitesse, ton, style, volume) |
| Séance | QR et adresses, checklist d'avant-séance, questions, journal |

Les réglages enregistrés vont dans `data/settings.json` et remplacent ceux du `.env`
(les clés, elles, ne quittent jamais le `.env`). Presque tout s'applique au segment
suivant ; la fin de phrase, le vocabulaire et la description de séance attendent le
prochain démarrage du micro — chaque champ le dit. Les compteurs de long terme
(temps traduit, disponibilité, qualité, signalements par voix) sont dans
`data/totals.json`. Aucun chiffre n'est inventé : la page Qualité dit comment chacun est
mesuré. Deux écoutes de voix : l'échantillon ElevenLabs est gratuit, l'« essai en
situation » synthétise une phrase et décompte une centaine de caractères du compte.

La Vue d'ensemble et la Supervision montrent la chaîne en **constellation** : cinq orbes
(microphone, audio, reconnaissance, traduction, synthèse vocale) reliées par des liaisons où
circulent des paquets. Tout y est porté par le réel — un paquet part quand un segment passe,
un étage s'élève quand un mot est entendu ou une traduction reçue, une liaison vers un étage
en panne passe en pointillés rouges. En sombre, ces deux pages prennent le design fourni
(bleu nuit, grille de points, halos) ; en clair, les mêmes animations sur la palette claire.
Un clic sur un étage ouvre son **inspecteur** : mesures des dernières minutes, incidents,
ce qui vient d'y passer, et ses réglages en lecture avec un lien vers Configuration.
Le bouton **Signalements** de ces deux pages ouvre la liste des signalements des
apprenants ; un signalement qui arrive s'annonce aussi en bas à droite, sur toutes les
pages de l'administration.

## Les deux choses à faire avant de mettre un téléphone dans la salle

1. **Un vrai certificat TLS.** Le micro des téléphones (questions) exige HTTPS, et une
   page HTTPS ne peut ouvrir qu'un WebSocket WSS. `institutcega.fr` → enregistrement A
   vers l'IP privée du PC → Let's Encrypt par challenge DNS-01 : `npm run cert:domain`.
   Les téléphones ouvrent `https://institutcega.fr` (port 443).
   Avec `HOSTINGER_API_TOKEN`, le serveur fait suivre le nom à l'IP du PC et renouvelle le
   certificat seul. Voir `docs/CERTIFICAT.md`. En développement, `npm run cert:dev` donne
   un certificat auto-signé (avertissement sur le téléphone, mais ça fonctionne).
2. ~~Le test écran verrouillé sur un iPhone réel~~ — **fait** (iPhone 13 Pro Max, iOS 26) :
   le lecteur média continue écran verrouillé et ignore le bouton silence ; Web Audio est
   muet sur iPhone. Le lecteur média est le défaut. Voir `docs/DECISIONS.md`, D3.

## Tester sur un seul PC (formateur et apprenant sur la même machine)

En salle, le formateur porte un casque fermé et les apprenants des écouteurs : le PC ne
joue jamais la traduction. Sur une seule machine, les haut-parleurs jouent la traduction,
le micro la capte, et le système se retraduit en boucle. Deux protections sont en place,
et un réflexe :

- **Annulation d'écho** (case cochée par défaut sur la page formateur) — le navigateur
  soustrait ce qu'il joue de ce qu'il capte.
- **Garde-fou de langue** (`ASSEMBLYAI_LANGUAGE_GATE=true`) — un tour reconnu dans une
  autre langue que la source est écarté sans être prononcé : c'est soit notre propre
  sortie, soit un apprenant francophone près du micro. Vérifié par `npm run check` (4b).
- Le réflexe : **un casque sur la page apprenant**. Aucun algorithme ne vaut l'absence d'écho.

## Mesurer, pas écouter

Enregistrez 10 minutes du formateur (WAV, 16 kHz, mono, 16 bits) dans `fixtures/` et
rejouez-les avec `npm run replay`. Chaque comparaison de moteur ou de réglage de
segmentation se fait sur cette fixture, avec les chiffres de `metrics.jsonl` — jamais en
parlant dans le micro, qui ne dit jamais deux fois la même chose au même rythme.

Avec `RECORD_DIR=data/enregistrements` dans le `.env` (et l'accord du formateur), chaque
démarrage du micro est enregistré : `source.wav` se rejoue tel quel, et `npm run prosody`
compare la voix du formateur et la voix traduite segment par segment (D24). `npm run report`
décompose le délai d'une séance, réelle ou rejouée, et dit si la mesure est exploitable :
un réseau qui renvoie le texte avec 15 s de retard ne juge pas un réglage.
