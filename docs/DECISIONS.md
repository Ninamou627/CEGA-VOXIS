# Décisions d'architecture

Revue complète (avec les chiffres, les sources et le raisonnement) :
<https://claude.ai/code/artifact/c93b9e7f-32dd-4f9f-bdaa-08a98aca50be>

Ce fichier est le résumé opposable : ce qu'on a décidé, pourquoi, et ce qui ferait
changer d'avis. Toute nouvelle décision structurante s'ajoute ici.

## D1 — Cascade STT → traduction → TTS, avec commit verrouillé

**Décision.** Trois étages séparés, pas de modèle speech-to-speech natif en voie principale.

**Pourquoi.** Les S2S natifs (Gemini 3.5 Live Translate, GPT-Realtime-2) se mesurent
autour de 3 s bout-en-bout, le double de la cible. La cascade bien segmentée descend à
1,5 s, et donne le texte : sous-titres, glossaire, mesure par étage, fan-out multilingue.

**Ce qui ferait changer d'avis.** Un S2S mesuré sous 2 s *sur notre fixture*, stable, avec
transcription exploitable.

**Assurance.** Gemini Live Translate câblé derrière un interrupteur comme plan de
secours (fournisseur différent, architecture différente).

## D2 — Serveur local en salle, IA dans le cloud

> **Révisée par D17** : le serveur est hébergé sur Internet. Cette décision reste celle de
> la boîte de salle (Horizon 2), pour une salle dont on maîtrise le réseau.

**Décision.** Un PC en Ethernet sur une borne Wi-Fi dédiée porte le pipeline et le
WebSocket. Les appels IA partent vers le cloud, une fois par langue cible.

**Pourquoi.** Pas pour la latence (le LAN pèse 60–120 ms sur 1 500). Pour le fan-out
(un appel TTS pour N auditeurs), le contrôle de la file audio, et une salle qui
continue quand l'Internet du lieu tousse. Seul le serveur a besoin d'Internet : lui
donner deux liaisons montantes (Ethernet du lieu + routeur 4G).

## D3 — Page web, pas d'application native

**Décision.** Une PWA « légère » (onglet navigateur, pas d'installation) ouverte par QR
code. React + Vite + TypeScript, même socle pour les trois surfaces.

**Pourquoi.** Personne n'installe une app pour une formation ; un correctif se déploie
en dix secondes pendant la session ; rien dans le besoin n'exige le natif.

**Contraintes acceptées.** Le micro des téléphones exige HTTPS → certificat sur IP de
LAN (D6).

**Test J1, fait le 16/09/2026 sur iPhone 13 Pro Max / iOS 26.** Le lecteur média
(`<audio>`, `ElementPlayer`) **continue de jouer écran verrouillé**. Web Audio est muet
même écran allumé (il obéit au bouton silence du téléphone, la lecture média non). Le
lecteur média est donc le défaut partout ; il porte aussi le `playbackRate` à hauteur
préservée (parade locale contre la dérive). Le Wake Lock reste, pour l'affichage.

## D4 — WebSocket, pas WebRTC

**Décision.** Un blob audio par segment, horodaté à l'origine, sur WebSocket.

**Pourquoi.** On ne diffuse pas un flux continu mais une suite d'énoncés discrets de
1 à 4 s. WebRTC ferait gagner ~100 ms et coûterait plusieurs jours.

**Ce qui ferait changer d'avis.** Plus de 40 clients simultanés, ou une perte de
paquets mesurée au test de charge qui rend l'audio inutilisable. Décision de mesure,
pas de conception.

## D5 — Commit verrouillé LocalAgreement-2, segmentation par règles

**Décision.** Un mot n'est figé que s'il apparaît identique dans deux hypothèses
successives, jamais le dernier mot. Coupe sur ponctuation → proposition (≥ 12 mots) →
longueur max (18) → silence → timeout anti-famine (2,5 s). Append-only : une révision
tardive d'un mot déjà dit est ignorée.

**Pourquoi.** Zéro rétractation à l'oreille. C'est ici que vit la latence (400–800 ms
sur 1 500) — on règle la segmentation avant de changer de moteur.

Implémentation : `server/src/pipeline/commit.ts`, tests dans `commit.test.ts`.

## D6 — HTTPS partout, certificat Let's Encrypt en DNS-01

> **Révisée par D17** : un serveur hébergé a une IP publique fixe, donc un enregistrement A
> qui ne bouge pas et un certificat par challenge HTTP-01. Le DNS-01 et le suivi d'IP
> (`server/src/domain.ts`) restent la réponse pour la boîte de salle et le développement local.

**Décision.** Un domaine que nous possédons, un enregistrement A public vers l'IP
privée du PC de salle, un certificat obtenu par challenge DNS-01. Valide hors ligne
pendant 90 jours.

**Pourquoi.** `getUserMedia` exige un contexte sécurisé ; une page HTTPS ne peut
ouvrir que du WSS. mkcert + 30 téléphones n'est pas praticable.

## D7 — La dérive est un indicateur de premier rang

**Décision.** `queueMs` (profondeur de file côté client) est affiché au même niveau que
la latence. Parades dans l'ordre : traduire en interprète (condenser), vitesse de
synthèse adaptative, plafond dur (8 s → on saute), bouton « revenir au direct ».

**Pourquoi.** Le français est ~18 % plus long que l'anglais. Sans parade, quatre
minutes de parole dense créent ~43 s de retard, système « fonctionnel ».

## D8 — Le flux inverse est en batch

**Décision.** La question est enregistrée en entier sur le téléphone, envoyée en un
bloc, transcrite / traduite / synthétisée en batch, jouée au formateur. Mutex de parole
côté serveur, pas de file de modération.

**Pourquoi.** 2–3 s de latence sont normales pour une prise de parole. Dix fois moins de
code que la voie descendante.

## D9 — Le coût n'est pas un critère

≈ 3 $ par heure de parole traduite, ≈ 130 $ pour six jours. Aucun compromis de qualité
ne se justifie pour l'économiser. On choisit sur la latence et la qualité.

## D10 — Ce qu'on ne fait pas

Application native ; débruitage maison devant le STT ; VAD maison ; capture audio côté
Node (le navigateur du PC capture) ; SQLite / Postgres tant qu'on n'archive rien ;
Docker sur le PC de salle ; comptes utilisateurs.

## D11 — Garde-fou de langue plutôt qu'épinglage de la langue source

**Décision.** Le STT tourne en détection de langue (pas de `language_code` épinglé) ; tout
tour reconnu dans une autre langue que la source est écarté sans être prononcé. Sur les
partiels, une heuristique par mots-outils tranche immédiatement ; le verdict officiel
arrive en fin de tour. Un tour suspect que la fin de tour dément est réinjecté entier.

**Pourquoi.** Ce que le micro capte dans la langue cible est notre propre sortie (écho)
ou quelqu'un d'autre : dans les deux cas ça ne doit pas entrer dans le pipeline. Avec une
langue épinglée, le français serait transcrit comme de l'anglais approximatif — et traduit.

**Prix accepté.** Sans épinglage, une légère perte possible sur un accent difficile.
`ASSEMBLYAI_LANGUAGE_GATE=false` rétablit l'épinglage, au prix de la protection.

## D12 — Secours par disjoncteur, pas par segment

**Décision.** Quand un primaire (traduction, voix) échoue, le secours prend le relais
pour 60 s, puis le primaire est réessayé. Un changement de moteur n'est pas signalé
aux apprenants ; il l'est au formateur et au tableau de bord.

**Pourquoi.** Réessayer le primaire à chaque segment pendant une panne ajoute son
timeout à chaque phrase. Et un moteur qui change ne regarde pas l'apprenant — seule une
voix absente mérite un bandeau.

## D13 — Interfaces reproduites depuis les maquettes, tout embarqué

**Décision.** Les écrans sont dessinés en maquette (VOXIS, Material 3), puis reproduits
à l'identique en React avec Tailwind (v3, le moteur de la maquette) : les tokens de la
maquette sont la configuration Tailwind du client, une interface = ses classes. Polices
et icônes sont des dépendances npm servies par le serveur de salle, jamais un CDN.

**Pourquoi.** Reproduire fidèlement sans réécrire chaque écran en CSS maison ; et en
salle, les téléphones sont sur la borne Wi-Fi dédiée (D2) : rien ne garantit l'accès à
Google Fonts — des icônes absentes s'affichent comme des mots. Accessoirement, aucune
requête des participants ne part vers un tiers.

**Contraintes acceptées.** Un build un peu plus lourd (≈ 500 Ko pour la police
d'icônes, servie une fois par téléphone sur le LAN). Les vues de la page apprenant sont
des onglets d'une seule page : le lecteur audio et le WebSocket doivent survivre à la
navigation. Les couleurs sont des variables CSS sur `<html>` : `dark` donne le jeu de
la maquette, son absence le jeu clair — la déclinaison Material 3 des mêmes palettes
tonales (accents au ton 40, conteneurs au ton 90, surfaces de 87 à 100). Le choix est
mémorisé sur l'appareil et appliqué avant le premier rendu.

## D14 — Une question s'écrit aussi, et un problème se signale en deux gestes

**Décision.** L'apprenant a deux chemins vers le formateur : parler (mutex de parole,
D8) ou **écrire** — une question écrite ne prend la parole à personne, elle est
traduite et synthétisée comme l'autre, mais ne se joue pas d'elle-même dans le casque :
le formateur la lit, et l'écoute s'il veut. Et il a un bouton **« Signaler un
problème »** : cinq causes (transcription, traduction, lenteur, voix, audio), un
toucher, envoyé. Le serveur y joint l'heure, le segment visé, sa transcription, sa
traduction et le décalage mesuré ; tout part dans `metrics.jsonl`. Le signalement va à
l'administration seulement : le formateur, qui parle, n'a pas à le traiter en direct.

**Pourquoi.** Tout le monde ne prend pas la parole devant trente personnes, et le
téléphone est déjà dans la main. Surtout : les seuls à savoir que la traduction est
mauvaise sont ceux qui l'écoutent — ni le formateur ni le tableau de bord ne peuvent
l'entendre. Un signalement daté et rattaché à sa phrase est la matière première du
réglage (glossaire, segmentation, choix de voix) ; demander à l'apprenant de ressaisir
la phrase garantirait qu'il ne signale rien.

**Conséquences d'interface.** La barre d'onglets de la page apprenant disparaît — elle
masquait le bouton de question. Il reste un bouton flottant « Cliquez ici pour poser une
question » et, au-dessus, le signalement : discret par défaut, il s'ouvre et pulse dès
que le système repère un souci (voix perdue, décalage > 4 s, file > 5 s, passage non
traduit), s'efface au bout de 20 s et revient toutes les 90 s tant que ça dure.

**Ce qui ferait changer d'avis.** Des signalements en rafale sans rapport avec la
qualité (chahut) : il faudrait alors les compter par apprenant, pas les afficher un par un.

## D15 — L'administration règle la salle à chaud, et ses chiffres sont des mesures

**Décision.** Les réglages de séance (moteurs de traduction, modèle, effort ou
température, délai, contexte et glossaire ; gain, seuil de parole, segmentation,
vocabulaire ; voix par défaut, vitesse, ton, volume) se changent dans l'administration,
sont validés par un schéma partagé (`shared/settings.ts`), enregistrés dans
`data/settings.json` et appliqués sans redémarrer : au segment suivant, ou au prochain
démarrage du micro pour ce que le moteur de reconnaissance ne lit qu'à l'ouverture de
son flux. Le `.env` garde les clés et les valeurs de départ.

Les indicateurs sont définis par ce qu'on mesure vraiment : latence à l'accusé de lecture,
confiance donnée par le moteur de reconnaissance, part des segments non signalés
« mauvaise traduction » ou « voix peu naturelle » (voix par voix), temps de séance où la
voix pouvait être servie. Pas de note de qualité fabriquée ; quand la mesure n'existe pas
(simulateur), la page affiche « — » et dit pourquoi.

**Pourquoi.** Changer un glossaire ou une voix ne doit pas couper une séance. Et un
chiffre montré à un client doit pouvoir s'expliquer en une phrase.

**Garde-fous.** Un paramètre que l'API refuse n'est jamais envoyé : la température n'est
proposée que pour Claude Haiku 4.5 (Opus 5, Opus 5.5 et Sonnet 5 la refusent et se règlent
par l'effort ; Haiku refuse l'effort). Une voix n'entre dans la salle qu'après vérification
dans le compte ElevenLabs. Un brouillon de configuration n'envoie que les champs touchés,
posés sur les réglages les plus récents : la page Voix et la page Configuration ne
s'écrasent pas l'une l'autre.

**Parti pris d'interface.** Pas de cartes dans l'administration : des bandeaux de chiffres
séparés par des filets, des listes en lignes, des sections séparées par un trait. C'est
une page qu'on lit en diagonale pendant une séance, pas une mosaïque de boîtes.

## D16 — La constellation : un design de démonstration, des données réelles

**Décision.** La Vue d'ensemble et la Supervision reprennent le design « constellation »
fourni : en sombre tel quel (bleu nuit, grille de points, halos, orbes, paquets) ; en clair,
le design de l'administration avec les mêmes animations. Les cinq étages restent ceux de la
supervision (microphone, audio, reconnaissance, traduction, synthèse vocale). Chaque
mouvement correspond à un événement réel : paquets sur un segment qui passe ou pendant la
parole, onde sur un mot entendu, une traduction reçue ou une voix produite. Tout ce que la
maquette montrait sans mesure derrière (logits, « WebRTC », quantification, 28 pairs,
phrases de démonstration) est retiré. L'inspecteur d'un étage lit ses réglages ; on les
modifie sur la page Configuration, seul endroit où un réglage s'enregistre.

**Pourquoi.** Une animation qui tourne quoi qu'il arrive ment à l'exploitant : il doit
pouvoir lire un étage figé ou une liaison rouge de loin. Et un tableau de bord ouvert des
heures ne doit pas chauffer le PC de salle : 30 images/s au plus, rien de dessiné quand la
page n'est pas à l'écran. Les animations ne se mettent jamais en pause d'elles-mêmes ; seul
le réglage « moins d'animations » du système de l'appareil les fige (accessibilité).

**Mise en œuvre.** Le design est une portée de thème (`.cosmos`, theme.css) : en sombre elle
redéfinit les jetons Material 3, si bien que les briques existantes suivent sans être
réécrites ; les couleurs propres au design sont des jetons `--cz-*` qui ont une valeur par
thème. Les autres pages et les autres interfaces ne changent pas.

## D17 — Serveur hébergé, application de bureau cliente, une seule plateforme

**Décision.** Le serveur est hébergé sur Internet, joignable sur `institutcega.fr`, et sert
les mêmes pages aux apprenants, au formateur et à l'administration. La version Windows est
une coque de bureau qui charge ces mêmes pages (Administration et Formateur) : un client de
plus, pas une seconde plateforme à maintenir. Les apprenants restent sur le Web, par QR code.
Révise D2 (serveur local en salle) et la partie « IP privée » de D6.

**Pourquoi.** Trois contraintes du terrain, par ordre de poids. (1) On ne peut pas apporter
sa borne Wi-Fi en salle d'hôtel, et un Wi-Fi d'hôtel isole presque toujours les appareils
entre eux : un serveur posé dans la salle serait *injoignable* par les téléphones, certificat
ou pas. (2) Des auditeurs suivent la formation à distance ; un serveur local n'a aucune
adresse depuis l'extérieur, et on ne gère pas le routeur de l'hôtel. (3) Un navigateur et une
application de bureau ont besoin du même point de rendez-vous fixe.

Effet de bord favorable : en salle, les apprenants peuvent utiliser leurs propres données
mobiles (64 kbit/s chacun), ce qui contourne à la fois le portail captif et le débit partagé
de l'hôtel. En hôtel, c'est plus robuste que l'architecture locale.

**Ce qu'on perd.** Le fan-out local (un appel TTS pour N auditeurs sur le LAN) et
l'indépendance vis-à-vis de l'Internet du lieu. La liaison critique devient la montée du
formateur : 256 kbit/s en continu (PCM 16 bits, 16 kHz). Un partage de connexion 4G sur son
poste sert d'assurance. La latence ajoutée par l'hébergement (10 à 30 ms sur ~1500 ms) n'est
pas un critère.

**Ce que ça rend obligatoire, avant toute mise en ligne.** Une authentification. Aujourd'hui
`role: "listener"` ne présente aucun jeton (`ws/handlers.ts`) : exposé sur Internet, quiconque
connaît l'adresse pourrait écouter la formation, écrire au formateur et à l'écran de salle, et
*prendre la parole* (`takeFloor`, transcrite puis prononcée au formateur). Il faut des comptes
pour l'administration et les formateurs — à la place du jeton dans l'URL, qui devient un écran
de connexion dans l'application de bureau — et un code de séance à durée limitée pour les
apprenants. C'est ce qui fait entrer une base de données : PostgreSQL plutôt que SQLite, parce
que l'hébergeur n'est pas tranché et que les disques des hébergements managés sont éphémères.

**Ce qui ferait changer d'avis.** Une salle dont on maîtrise le réseau (notre propre borne,
aucun auditeur à distance) : la boîte de salle de l'Horizon 2 redevient la meilleure réponse,
et `server/src/domain.ts` en porte déjà le certificat automatique.

## D18 — Application de bureau : une coquille Electron sur la plateforme en ligne

**Décision.** La version Windows est une fenêtre qui charge les pages servies par le serveur
(`https://institutcega.fr/lecturer`, `/dashboard`), et rien d'autre : aucune interface, aucune
logique métier, aucune base locale. Elle s'adresse au formateur et à l'administration ;
l'apprenant reste sur le Web. La coquille est en **Electron**, pas en Tauri.

**Pourquoi une coquille et pas une application.** Le client est déjà bâti pour ça : il déduit
l'adresse de son WebSocket de la page qui le sert (`client/src/lib/ws.ts`), et tout le reste
est relatif. Charger l'origine réelle plutôt qu'un front embarqué donne deux choses d'un
coup : un déploiement serveur met l'application à jour sans réinstallation, et le cookie de
session fonctionne tel quel — un front embarqué aurait exigé du CORS et un cookie
`SameSite=None`, c'est-à-dire un affaiblissement réel de D17.

**Pourquoi Electron plutôt que Tauri.** Le micro du formateur *est* le produit. Electron
embarque Chromium : le comportement est identique à Chrome, déjà validé sur ce projet. Tauri
s'appuie sur le WebView2 du poste client — version variable d'une machine à l'autre — et son
autorisation micro passe par un `PermissionRequested` à écrire en Rust, avec des refus
silencieux rapportés. À cela s'ajoute que charger une URL distante est l'usage le plus
ordinaire d'Electron et un chemin secondaire chez Tauri, et que la chaîne Rust est absente de
la machine de développement.

**Ce qu'on perd.** Un installeur d'environ 150 Mo au lieu de 10, ~200 Mo de mémoire au lieu
de 80, et la charge de suivre les correctifs de Chromium — une nouvelle version à publier tous
les quelques mois. La coquille faisant environ deux cents lignes, revenir sur ce choix
coûterait une journée : ce n'est pas une porte à sens unique.

**Signature du code.** Sans certificat, Windows SmartScreen affiche un avertissement à la
première installation. Un certificat OV coûte ~300 €/an ; Azure Artifact Signing (ex-Trusted
Signing) revient à ~10 $/mois mais exige une identité d'organisation vérifiée. En attendant :
empreinte SHA-256 publiée à côté du téléchargement, page d'installation illustrée, et
distribution en HTTPS depuis notre propre domaine.

**Ce qui ferait changer d'avis.** Un client pour qui 150 Mo est rédhibitoire, ou un support
micro de première classe côté Tauri : la coquille se réécrit en une journée.

## D19 — La latence qui valide le projet part de la fin de la phrase

**Décision.** L'objectif du projet — moins d'une seconde — se mesure **de la fin prononcée
d'un segment au début de son écoute** chez l'apprenant (`endP50`, `endP95`). Le serveur date
la fin du dernier mot par ses horodatages STT, reliés à l'heure de réception de l'audio
(`pipeline/audio-clock.ts`) ; l'accusé de lecture du téléphone ferme la mesure. Le décalage
ressenti, du premier mot reconnu à l'écoute (`e2eP50`), reste affiché à côté.

**Pourquoi.** Mesurée depuis le premier mot, la latence contient le temps que met le
formateur à dire le segment : 2,4 s pour six mots à débit normal. Aucun système, ni aucun
interprète humain (2 à 3 s derrière l'orateur), ne passe sous une seconde sur cette
définition. Depuis la fin de la phrase, la mesure dit ce que le système ajoute.

**Garde-fou.** Cette mesure récompense l'attente de phrases entières : un segment plus long
ne la dégrade pas, alors que l'apprenant attend davantage. On la lit toujours avec le
décalage ressenti, jamais seule.

**Première mesure (14/10/2026, fixture synthétique de 36 s, vrais moteurs, 3 apprenants
simulés).** Fin de phrase → voix : ~4 s en médiane. Décomposition : reconnaissance 0,4 à
0,8 s, traduction Claude Opus 5 ~1,4 s (p95 2,2 s), synthèse ~0,3 s, attente derrière le
segment précédent jusqu'à 1,4 s, file du téléphone ~0,8 s. Deux premiers appels Claude sur
quatre ont dépassé le délai de 6 s (connexion à froid) et basculé sur DeepL.

**Reconnaissance : U3.5 Pro reste le défaut.** Deux passages par modèle, de la fin d'un
segment à son commit :

| Modèle | Médiane | p95 | Fins de phrase | Phrases coupées au délai |
|---|---|---|---|---|
| `universal-3-5-pro` | 0,36–0,46 s | 2,9–3,4 s | ~0,4 s | ~2 s |
| `universal-streaming-english` | 0,66–0,75 s | 0,9–1,1 s | ~0,6 s | ~0,9 s |

U3.5 Pro clôt vite une fin de phrase mais n'envoie qu'un partiel par seconde ; le modèle
anglais est régulier mais plus lent en médiane, sans ponctuation, et sans détection de
langue (l'écho n'est reconnu qu'au 7e mot). Le gain n'étant pas établi sur la médiane, le
défaut ne change pas ; le choix se fera sur l'enregistrement réel du formateur, dont la
longueur des phrases décide. Le modèle anglais affiche des fragments de mots en cours de
prononciation (« part », « trans ») que l'accord de deux hypothèses figeait : avec lui, le
commit n'attend que les mots qu'il déclare définitifs (`SttProvider.finalWords`). Une coupe
sur pause (absence de mot nouveau) a été essayée et retirée : elle figeait ces fragments.

**Ce qui ferait changer d'avis.** Sur l'enregistrement réel, une part de phrases coupées au
délai qui fasse passer la médiane d'U3.5 Pro au-dessus de celle du modèle anglais.

## D20 — DeepL traduit en direct, Claude en secours ; des connexions toujours chaudes

**Décision.** En séance, la traduction principale est DeepL ; Claude (Haiku 4.5) prend le
relais 60 s s'il échoue. Les connexions vers les fournisseurs sont gardées ouvertes 60 s et
réchauffées : à l'ouverture du micro, puis dès qu'un fournisseur est resté 15 s sans servir
(`providers/http.ts`). Le glossaire de l'administration est transmis à DeepL (créé une fois
chez DeepL, puis cité par son identifiant) et retourné pour les questions des apprenants.

**Pourquoi DeepL.** Mesuré le 14/10/2026, par segment et connexion ouverte : DeepL ~0,25 s ;
Claude Haiku 4.5 ~0,85 s ; Haiku 5.5 ~1,1 s ; Sonnet 5 ~1,35 s ; Opus 5 ~1,7 s. Avec une
reconnaissance à 0,4–0,8 s, seul DeepL laisse une chance de passer sous une seconde de la fin
de phrase à la voix (D19). Le réglage `model_type` de DeepL (latence ou qualité) n'a rien
changé de mesurable. Le mode rapide d'Opus n'est pas ouvert sur le compte, et il accélère le
débit, pas le premier mot ; le cache de prompt ne s'active pas (prompt sous 512 tokens).

**Ce qu'on perd.** Le registre d'interprète : DeepL traduit, il ne condense pas. Le français
est plus long, la dérive se combat par la vitesse de la voix. Claude reste dans le produit :
secours, préparation du glossaire, transcription révisée.

**Pourquoi des connexions chaudes.** Le `fetch` de Node ferme une connexion inactive au bout
de 4 s ; la requête suivante en rouvre une. Mesuré, requête gratuite après un silence :

| Fournisseur | Connexion chaude | Après 6 s / 20 s (Node par défaut) | Gardée 60 s |
|---|---|---|---|
| DeepL | ~0,1 s | 1,0 / 2,6 s | 0,1 / 0,1 s |
| ElevenLabs | ~0,6 s | 2,1 / 0,9 s | 0,6 / 0,6 s |
| Anthropic | ~0,3 s | 0,5 / 0,5 s | 0,3 / 0,4 s |

DeepL ferme lui-même ses connexions entre 20 et 45 s (1,6 s après 45 s, même gardées) :
d'où la requête de maintien à 15 s. En séance, chaque phrase qui suit une pause du formateur
payait ce prix ; les fixtures précédentes, sans pause de plus de 0,6 s, ne le montraient pas.
Sur un passage réel avec pauses (ancien code), la traduction a une médiane de 0,34 s mais des
pointes de 1,1 à 2,1 s, et la voix de 0,9 à 1,9 s.

**Mesuré avant / après** (même fixture de 66 s avec des pauses de 8 et 15 s, DeepL en
direct, voix simulée, passages enchaînés) :

| | Avant | Après |
|---|---|---|
| Traduction, médiane / p95 | 0,90 / 4,09 s | 0,33 / 0,91 s |
| Attente derrière le segment précédent, médiane | 1,26 s (jusqu'à 11,8 s) | ~0 |
| Dégradations | DeepL puis Claude hors délai : texte seul | aucune |
| Fin de phrase → voix, médiane / p95 | 8,9 / 17,9 s | 3,9 / 7,6 s |

Le réseau du poste de mesure était instable ce jour-là, et plus dégradé pendant le passage
« avant » (retard d'AssemblyAI jusqu'à 5 s) : l'écart total surestime le gain, qui est établi
sur la traduction et l'attente. Après, l'essentiel des 3,9 s vient de la reconnaissance
(médiane 2 s : phrases longues coupées au délai, D19) et de la file du téléphone (~1,2 s).

**Glossaire, vérifié contre l'API.** Une clé DeepL gratuite n'a droit qu'à un glossaire
(refus 456 au deuxième) : il va au sens du formateur, et un glossaire modifié libère
l'ancien avant d'être créé. Les questions des apprenants (français → anglais) s'en passent
sur une clé gratuite ; Claude, en secours, reçoit le glossaire retourné.

**Ce qui ferait changer d'avis.** Un Claude sous 0,4 s par segment mesuré depuis le serveur
hébergé, ou des signalements « traduction » nettement plus nombreux avec DeepL.

## D21 — La file du téléphone se vide en amont, pas sur le téléphone

**Constat.** La file d'écoute du téléphone (1,2 à 1,7 s en médiane sur les passages mesurés)
n'est pas une dérive. Avec DeepL, la voix française dure ×0,93 à ×1,04 la parole anglaise
qu'elle traduit (×0,77 avec Claude, qui condense) ; les silences en tête et en queue des
segments ElevenLabs pèsent 2 % du son (mesuré par l'alignement des caractères). La file
vient d'un segment rapide qui attend derrière un segment lent : une phrase longue coupée au
délai est reconnue en 1 à 3 s, la fin de phrase qui la suit en 0,3 s, et sa voix arrive
pendant que la précédente joue encore.

**Ce qui a été simulé** (lecture de la page rejouée pas à pas sur quatre passages réels) :
accélérer la lecture jusqu'à ×1,3 ne gagne que 0,1 à 0,5 s en médiane, pour une voix
nettement plus rapide. En revanche, sur le passage de référence (U3.5 Pro, DeepL, vraie
voix), une reconnaissance aussi rapide pour toutes les phrases que pour les fins de phrase
ferait passer l'attente au téléphone de 1,6 à 0,6 s et la fin de phrase → voix de 4,4 à
2,7 s ; avec en plus une traduction et une voix sans pointes (D20), 1,6 s.

**Décision.** La politique de lecture du téléphone ne change pas (×1,08 au-delà de 2 s de
file, ×1,15 au-delà de 4 s, ×1,25 au-delà de 6 s, saut au-delà de 8 s). Elle vit désormais
dans `shared/playback.ts`, partagée avec les apprenants simulés du test de charge, qui
l'appliquent à l'identique (vitesse réajustée toutes les 500 ms, même définition de file
dans l'accusé) : la latence mesurée par `npm run load` est celle d'un vrai téléphone.
Jusqu'ici, ils jouaient sans accélérer et surestimaient la file. Le levier est la
reconnaissance : la rendre aussi rapide pour les phrases longues que pour les fins de phrase.

**Pas encore mesuré.** La latence avec ces apprenants fidèles : les deux passages du
14/10/2026 au soir ont été faussés par le réseau du poste de mesure (retard d'AssemblyAI de
3 à 15 s, DeepL hors délai). À refaire depuis le serveur hébergé.

## D22 — Pendant une pause du formateur, on demande au STT de clore le tour

**Décision.** Quand le formateur marque une pause d'au moins 250 ms (audio sous le seuil de
parole de l'administration) après au moins 1,2 s de parole depuis la dernière coupe (~4 mots),
le serveur envoie à AssemblyAI `ForceEndpoint` : le tour se clôt, son texte définitif arrive,
et ces mots partent en segment. Une fois par pause. La parole se mesure sur l'audio, pas sur
les mots du STT : quand AssemblyAI prend 2 s de retard, ses mots ne sont pas encore arrivés à
la pause, et une première version qui exigeait 4 mots reçus laissait passer la phrase entière. Pendant l'attente de ce texte (au plus 1 s), le délai de coupe
ne tranche pas la phrase : sinon il la coupait juste avant la pause, plus lentement.

**Pourquoi.** U3.5 Pro clôt une fin de phrase ~0,4 s après le dernier mot, mais au milieu
d'une phrase longue il ne marque aucun mot définitif : le segment attendait le délai de coupe,
~2 s après son dernier mot (D19), et faisait attendre le suivant au téléphone (D21). Mesuré sur
la fixture : le tour forcé arrive 0,17 à 0,34 s après la commande, 0,2 à 0,4 s après le dernier
mot ; 88 mots justes sur 88.

**Mesuré de bout en bout** (fixture de 66 s avec pauses, U3.5 Pro, DeepL, voix simulée,
apprenants fidèles à la page ; reconnaissance = fin prononcée du segment → segment figé) :

| | Avant | Après (délai 2,5 s) | Après (délai 4 s) |
|---|---|---|---|
| Reconnaissance, médiane / p95 | 1,09 / 5,4 s | 0,34 / 3,2 s | 0,50 / 5,1 s* |
| Coupes au délai (lentes, ~2 à 3 s) | 7 sur 17 | 4 sur 17 | 0 sur 12 |
| Mots perdus ou répétés | 0 | 0 (après correctifs) | 0 |

\* Réseau dégradé pendant ce passage (retard d'AssemblyAI 2,2 s au lieu de 0,9 s) ; les fins
de phrase et les coupes à la pause y restent à ~0,47 s. Le délai de coupe passe à 4 s par
défaut : à 2,5 s, il tranchait encore la phrase juste avant sa pause.

**Ce qui reste.** La fin de phrase → voix reste vers 3,5–3,9 s sur ces passages : l'essentiel
est désormais l'attente au téléphone d'un segment court derrière la voix d'une phrase longue
(D21). Simulé sur les mêmes arrivées : une voix française plus rapide (×1,1 à ×1,2) ne gagne
que 0,1 à 0,3 s ; la condensation de Claude (voix ×0,8, traduction +0,55 s) entre −0,4 et
+0,3 s selon le passage. Ces passages utilisent une voix simulée qui parle ~18 % plus
lentement qu'ElevenLabs (0,38 contre 0,32 s par mot) et une fixture rapide (176 mots/min) :
la file y est surestimée. La mesure avec la vraie voix reste à faire sur un réseau stable.

**Ce qui a été écarté, et pourquoi.** Forcer à un nombre de mots coupe un mot en deux
(« partial transfers » + « scripts ») ; la virgule n'est pas un repère (U3.5 n'en affiche pas
en cours de phrase). Seule une pause garantit qu'aucun mot n'est en cours. D10 écartait un VAD
maison pour segmenter ; ici le silence ne décide que du moment, le STT reste seul juge du texte.

**Défaut connu et parade.** Si la commande arrive alors que le formateur a repris, AssemblyAI
glisse parfois le début de la suite dans le tour clos, puis la reprend au tour suivant
(« …transcripts, and why that matters » puis « And why that matters ») ; et des mots figés
depuis ses hypothèses peuvent passer au tour suivant. La segmentation retient la fin du
dernier mot réellement envoyé et n'envoie jamais un mot qui se termine avant : chaque mot part
une fois, quel que soit le tour qui le porte.

## D23 — L'attente au téléphone : couper toutes les phrases longues, puis une voix à ×1,15

**Constat.** Une fois les phrases longues reconnues aussi vite que les fins de phrase (D22),
il restait ~2 s d'attente au téléphone : un segment attend que la voix française du précédent
ait fini, et le français est plus long que l'anglais.

**Ce qui a été fait, et mesuré** (fixture de 66 s avec pauses, U3.5 Pro, DeepL, voix simulée,
apprenants fidèles à la page) :

1. La coupe à la pause se décide sur la parole entendue (D22) : les 5 phrases longues sont
   coupées à leur pause, contre 2 sur 4 au passage précédent ; reconnaissance médiane / p95
   0,24 / 0,76 s ; fin de phrase → voix médiane / p95 de 3,7 / 8,6 s à **3,0 / 4,4 s**.
2. Vitesse de base de la voix à ×1,15 (réglage Voix de l'administration ; ElevenLabs plafonne
   à ×1,2, d'où une marge laissée au rattrapage de la dérive) : attente au téléphone médiane de
   **2,1 s à 0,6 s** mesurée. La fin de phrase → voix de ce passage (4,1 s) n'est pas
   comparable : 3 traductions DeepL sur 14 y ont dépassé 1 s (jusqu'à 4,9 s, réseau du poste),
   et chacune a bloqué les segments suivants.

**Simulé** sur les arrivées du passage 1, avec des durées ramenées au débit d'ElevenLabs
(la voix simulée est ~18 % plus lente) : fin de phrase → voix médiane / p95 de 2,0 / 3,0 s
tel quel, **1,8 / 2,5 s** avec la voix à ×1,15, 1,6 / 2,2 s à ×1,2. Accélérer en plus la
lecture sur le téléphone (×1,3 dès qu'un segment attend) n'ajoute presque rien.

**À vérifier à l'oreille** : une voix à ×1,15 doit rester naturelle pour les apprenants. Le
réglage se change dans Configuration → Voix.

**Reste à mesurer** : la latence avec la vraie voix ElevenLabs, sur un réseau stable (serveur
hébergé) — le réseau du poste de mesure a faussé un passage sur deux.

## D24 — Mesurer ce que la salle ressent : du début de la parole au premier son

**Constat (séance réelle du 19/10/2026, voix du formateur, vrais moteurs, un PC et un iPhone).**
« Il faut environ 5 s avant d'entendre la traduction » : le journal le confirme. Pour le premier
segment d'une prise de parole, du premier mot prononcé au premier son : 5,1 s en médiane avec
Claude Opus 5 (15 cas), 4,3 s avec DeepL (10 cas). Environ 60 % de ce délai est le temps que met
le formateur à prononcer ce premier segment (2,7 s, 5 mots) ; le reste : reconnaissance 0,3 s,
traduction 0,85 s (Claude) ou 0,3 s (DeepL), voix 0,3 s. En parole continue, la file des
téléphones grandit : attente médiane de 0,9 s à 3,8 s (p95 7,5 s) au fil de la séance ; avec la
voix réglée à ×0,85, la voix traduite a duré 1,22 fois la parole du formateur.

**Décision : de quoi mesurer avant de changer quoi que ce soit (étape A).**

- Deux indicateurs : `start`, du début prononcé du premier mot d'un segment au début de son
  écoute, et `first`, le même pour le premier segment d'une prise de parole (après plus de
  1,5 s de silence). Le « décalage ressenti » du tableau de bord partait jusqu'ici du premier mot
  *reçu* du STT : il omettait son retard d'affichage (~1 s avec U3.5 Pro) et la durée du mot.
- `npm run report` décompose une séance depuis son journal, étage par étage, au début d'une prise
  de parole et en parole continue, minute par minute, et dit si la mesure est exploitable.
- `RECORD_DIR` enregistre chaque démarrage du micro (désactivé par défaut : il faut l'accord du
  formateur) : `source.wav` se rejoue tel quel, les mots y sont placés exactement, la voix
  traduite de chaque segment et sa première écoute sont gardées.
- `npm run prosody` compare la voix du formateur et la voix traduite : débit, étendue de la
  hauteur et de l'énergie (corrélations d'un segment à l'autre), questions qui montent,
  affirmations qui descendent, pauses gardées, rapport de durée ; avec `--stt`, la voix traduite
  relue par AssemblyAI (intelligibilité) ; avec `--judge`, Claude note fidélité et fluidité.
- Un événement `health` toutes les 5 s de séance (retard de boucle du serveur, audio en attente
  d'envoi vers le STT), et trois alertes : « Réseau du poste instable » (au moins deux étages en
  échec ensemble), « La voix du formateur part avec X de retard », « Le texte reconnu arrive X
  après la parole ».

**Pourquoi ces alertes.** Séance de test du 19/10/2026 (15:58–16:14, réglages par défaut) :
reconnaissance, traduction et voix « en panne » ou « instables » en même temps. Aucun incident
ce jour-là chez AssemblyAI, Anthropic ni ElevenLabs (pages de statut). Le texte du STT est arrivé
jusqu'à 44 s après la parole, AssemblyAI a fermé la connexion (1006), Anthropic, DeepL et
ElevenLabs ont dépassé leurs délais ; 32 voix produites n'ont jamais été jouées, arrivées sur le
téléphone plus vieilles que 8 s. Mesuré ensuite depuis le même poste : résolution DNS de 0,7 à
1,7 s, poignées de main TLS jusqu'à 5,6 s. Le tableau de bord désignait trois fournisseurs ; la
cause commune était la connexion du poste.

**Vérifié** sur deux rejeux de la fixture de 66 s (U3.5 Pro réel, traduction et voix simulées,
3 apprenants simulés, enregistrement activé) : le rapport, l'enregistrement et la comparaison de
prosodie s'enchaînent. La fixture ne contient que 3 prises de parole : leur premier son a valu
5,9 s puis 3,4 s d'un passage à l'autre, trop peu pour juger un réglage. Les comparaisons des
étapes suivantes se feront sur l'enregistrement réel du formateur (3 à 5 minutes).

**Limites.** Le début du premier mot vient des horodatages du STT reliés à l'heure de réception
de l'audio : il est en retard de l'aller simple micro → serveur, la mesure est donc légèrement
optimiste. La prosodie mesurée (syllabes écrites, hauteur par YIN) compare des variations, pas une
qualité perçue : une écoute à l'aveugle reste nécessaire. L'accentuation n'est mesurée que chez le
formateur : la voix traduite n'a pas de mots datés (étape D).

## D25 — Le premier morceau d'une prise de parole part au premier blanc ; la mesure suit l'audio

**Constat.** Au début d'une prise de parole, plus de la moitié du délai ressenti est le temps
que met le formateur à dire le premier segment (2,7 s en médiane le 19/10/2026, D24). Le
segment se clôt à une pause d'au moins 250 ms après 1,2 s de parole (D22, D23).

**Décision.**

1. Quand le formateur reprend après au moins 1,5 s de silence, et que les téléphones ont moins
   de 1,5 s à jouer, le premier morceau part au premier blanc d'au moins 120 ms après 0,8 s
   de parole. Ensuite, les règles ordinaires. Réglage « Premier morceau d'une prise de
   parole » dans Configuration → Parole (« Au premier blanc » par défaut, ou « À la première
   pause » pour revenir à D23).
2. La page formateur envoie des trames de 50 ms (le minimum d'AssemblyAI) au lieu de 100 :
   le serveur ne peut demander la fin d'un tour qu'à la réception d'une trame, et un blanc de
   150 ms n'est vu en entier, pendant qu'il dure, qu'avec des trames plus courtes que lui. Le
   rejeu suit la même cadence, calée sur le temps réellement écoulé : un minuteur de 50 ms se
   déclenche toutes les ~62 ms sous Windows, ce qui étirait les silences de 25 %.
3. Les instants de début et de fin d'un segment sont recalés sur l'audio. U3.5 Pro place la
   fin du dernier mot avant une pause dans le silence qui suit, et le début du premier mot
   après une pause dans le silence qui précède (vrai silence à −80 dB sur l'enregistrement).
   Mesuré sur deux rejeux (92 segments) : la fin de **chaque** segment était datée 0,24 s
   après la fin réelle de la parole (médiane), le début de la moitié d'entre eux 0,27 à 0,46 s
   trop tôt. Le recalage est borné à 0,7 s : au-delà, c'est le seuil de parole qui se trompe
   (une voix plus faible que lui passerait pour un long silence).

**Conséquence sur les mesures.** Les « fin de phrase → voix » publiées jusqu'à D23 étaient
optimistes d'environ 0,24 s ; les « début de parole → son » de D24, pessimistes d'environ 0,3
à 0,5 s sur les segments qui suivent une pause. Toute comparaison avec un chiffre antérieur
doit en tenir compte.

**Pourquoi 120 ms.** Sur l'enregistrement mesuré, l'occlusion du « p » de « pipeline » dure
100 ms, un blanc entre deux mots (« handles | partial ») 140 à 160 ms.

**Mesuré (19/10/2026, cours synthétique de 147 s en 15 prises de parole, voix Windows « Zira »,
AssemblyAI et DeepL réels, voix simulée, réglage désactivé puis activé, même code).** La
coupe rapide s'est déclenchée 11 fois sur 15, sans couper de mot. Mais le premier segment n'a
pas raccourci (2,3 s puis 2,4 s en médiane), et le premier son non plus (4,4 s puis 4,3 s,
dans le bruit de mesure). Cette voix n'a presque pas de blanc de plus de 120 ms à l'intérieur
d'une phrase (6 contre 71 entre 60 et 120 ms) ; ses virgules durent 420 ms et déclenchaient
déjà les règles existantes. La coupe rapide s'est donc surtout déclenchée en fin de phrase,
~130 ms avant l'ancienne règle. **Le gain dépend des micro-pauses d'une vraie voix : il reste
à mesurer sur l'enregistrement du formateur** (RECORD_DIR, D24), comme le risque de couper un
mot sur une occlusion ou une consonne faible de plus de 120 ms.

**Vu en passant (pour l'étape D).** Chaque fin de tour forcée — celles de D22 comprises — fait
mettre un point par AssemblyAI là où le formateur avait une virgule (« Good morning
everyone. » puis « And welcome… ») : la voix française conclut une phrase qui continue.

## D26 — La voix suit le débit du formateur ; le téléphone garde une partie de ses pauses

**Constat.** La vitesse de la voix était fixe (réglage de l'administration), accélérée par
paliers quand la file des téléphones grandissait. Elle ignorait l'allure du formateur, et le
retard s'installait avant d'être rattrapé : avec la voix à ×0,85 le 19/10/2026, une minute de
parole donnait 1 min 13 s de voix (D24). Quand un téléphone avait du retard, les segments
s'enchaînaient sans blanc : les pauses du formateur disparaissaient justement quand il
parlait vite.

**Décision.**

1. Chaque segment est dit dans le temps que le formateur a mis à le dire, pause qui le précède
   comprise (au plus 0,6 s ; rien après une prise de parole), moins la moitié de la voix déjà
   en attente sur les téléphones (`pipeline/tempo.ts`). La durée de la voix se prévoit par son
   débit, appris segment après segment : ElevenLabs en français dit 17 caractères par seconde
   à ×1 (médiane de 398 segments réels, p10 14, p90 19,4), et sa durée suit l'inverse de la
   vitesse demandée. Vitesse bornée entre ×0,85 et ×1,2 (plafond d'ElevenLabs) ; le réglage
   « Vitesse » de l'administration la multiplie. Réglage « Débit » (Configuration → Voix) :
   « Suit le formateur » par défaut, ou « Constant » pour revenir à l'ancienne règle.
2. Le téléphone garde 40 % d'une pause du formateur d'au moins 0,4 s (350 ms au plus), tant
   qu'il a moins de 1,5 s de retard (`shared/playback.ts`, les deux lecteurs et les apprenants
   simulés).
3. Le téléphone rattrape sa propre file même quand la synthèse est rapide, sans que le débit
   effectif (synthèse × lecture) dépasse ×1,3. Avant, il n'accélérait pas si le serveur l'avait
   déjà fait — ce qui n'a plus de sens quand la vitesse de synthèse suit le formateur.
4. Les libellés « Rattrapage de la dérive ×1,15 » et « Vitesse de la voix ×1,00 » montraient
   le rattrapage automatique comme si c'était la vitesse réglée : ils disent maintenant la
   vitesse du dernier segment, et l'écran apprenant n'annonce un rattrapage que quand le
   téléphone accélère lui-même.
5. La voix simulée parle au débit mesuré d'ElevenLabs (17 car./s à ×1) au lieu de ~440 ms par
   mot : 18 % plus lente, elle ne tenait pas une parole continue même à ×1,2. Les mesures de
   file faites avec elle (D21, D23) étaient pessimistes.

**Mesuré (19/10/2026, cours continu de 144 s à l'allure variable — passages rapides et lents,
voix Windows « Zira » ; AssemblyAI et DeepL réels, voix simulée au débit d'ElevenLabs, 3
apprenants simulés ; un passage par configuration).**

| | Avant (constant, sans pauses gardées) | Après |
|---|---|---|
| Début de parole → son, médiane / p95 | 5,0 / 9,3 s | 4,5 / 7,3 s |
| Fin de phrase → son, médiane / p95 | 2,1 / 8,1 s | 1,8 / 6,1 s |
| Le débit de la voix suit celui du formateur (corrélation par segment) | 0,32 | 0,53 |
| Durée de la voix / durée du formateur (médiane par segment) | 1,08 | 1,01 |
| Pauses de plus de 0,5 s retrouvées à l'écoute | 43 % | 63 % |
| Pente du retard | +0,6 s/min | +0,6 s/min |

Les pauses gardées coûtent ~0,3 s de médiane (5,3 s avec vitesse constante et pauses gardées).

**Limite.** Le retard grandit encore dans les passages où le formateur va plus vite que ce
que la voix peut suivre à ×1,2 : dans ce cours, la vitesse est au plafond pour plus de la
moitié des segments, et le retard reprend à la 3e minute, dans le passage rapide. Sur la séance
réelle du 19/10, la vitesse qu'il aurait fallu est de ×0,81 et ×0,98 en médiane selon la
période, au-delà de ×1,2 pour 7 % et 23 % des segments (la seconde période avec des segments
de 1 à 8 mots) : la voix de ce cours est plus rapide que le formateur. Au-delà de ×1,2, il
faudrait dire moins (condenser la traduction), ce que DeepL ne fait pas.

## D27 — Une phrase qui continue ne se conclut pas : la pause décide de la virgule

**Constat.** Quand le serveur clôt un tour pendant une pause (D22, D25), AssemblyAI met un
point même là où le formateur avait une virgule (« Good morning everyone. » puis « And
welcome… ») : la voix française descend comme en fin de phrase, puis repart. Sur deux cours
enregistrés, 45 à 47 % des segments finis par un point étaient en réalité des phrases qui
continuaient.

**Ce qui ne marche pas.** La mélodie de la voix : en fin de virgule comme en fin de phrase,
elle descend de 3,3 demi-tons en médiane (48 segments, voix de synthèse). La probabilité de fin
de tour d'AssemblyAI : pour U3.5 Pro, elle vaut 0 ou 1 (documentation), rien de plus que la fin
de tour elle-même. La pause lue sur les horodatages du STT : ils débordent dans les pauses (D25).

**Ce qui marche.** La pause mesurée sur l'audio : 0 à 800 ms après une virgule, 540 ms et plus
après un point. **Décision** : au retour de la traduction (~0,7 s après le début de la pause),
si le formateur a repris en moins de 600 ms, ou si le segment finit sur un mot qui appelle une
suite (« and », « the », « to »…), le point final de la traduction devient une virgule ; la voix
ne conclut pas, et l'enchaînement d'ElevenLabs (texte précédent) se fait sur une virgule. Pause
encore en cours et plus courte que 600 ms : le point reste. Aucune attente ajoutée.

**Mesuré (19/10/2026, AssemblyAI et DeepL réels, comparé au texte lu).**

| Fins de segment justes (point ou virgule) | Avant | Après |
|---|---|---|
| Cours à 15 prises de parole, 38 segments | 55 % | 97 % (16 virgules rendues, aucune à tort) |
| Cours continu à l'allure variable, 43 segments | 53 % | 84 % (15 rendues, 2 à tort, 5 manquées) |

Une décision sur 81 était encore indécise au retour de la traduction. Les deux virgules mises
à tort suivent des fins de phrase où la voix rapide a raccourci sa pause (0 et 550 ms).

**Limites.** Voix de synthèse : ses pauses de virgule et de fin de phrase sont plus régulières
que celles d'un formateur ; le seuil de 600 ms est à vérifier sur son enregistrement. Que la
virgule fasse bien remonter la voix d'ElevenLabs est à vérifier à l'écoute (crédits). Le texte
anglais affiché garde la ponctuation d'AssemblyAI.

## D28 — La voix du formateur décrite en direct, segment par segment

**Pourquoi.** Pour que la voix traduite rende l'expressivité du formateur (D3), il faut d'abord
la mesurer pendant qu'il parle : animée ou posée, plus rapide ou plus lente que d'habitude,
montant à la fin, et les mots qu'il met en relief.

**Décision.**

1. La hauteur (YIN) et l'énergie sont analysées au fil de l'audio reçu, par fenêtres de 20 ms
   (`LiveProsody`, même calcul que l'analyse hors ligne de D24). Analyser d'un bloc les 2 s d'un
   segment coûterait ~60 ms, pendant lesquelles le serveur ne diffuserait plus rien.
2. Chaque segment est décrit entre ses bornes réelles (recalées sur l'audio, D25) et comparé
   aux habitudes du formateur depuis le démarrage du micro (`pipeline/voice-profile.ts`) :
   hauteur, étendue de la mélodie, énergie, débit en syllabes par seconde, mouvement final ;
   « animée » quand mélodie et énergie dépassent nettement l'habitude, « posée » en dessous ;
   un mot est « mis en relief » quand il est nettement plus fort ou plus aigu que ses mots
   habituels. Rien n'est jugé avant ~8 segments (~20 s de parole). Chaque mesure a une
   dispersion minimale (un demi-ton, un décibel, un tiers de syllabe par seconde) : une voix
   très régulière rendait sinon le moindre écart invisible.
3. La description part avec le segment (`src.commit`), dans le journal et dans l'enregistrement :
   elle ne change encore rien à la voix traduite.

**Mesuré (19/10/2026).** Coût : 2,9 % d'un cœur, 1,45 ms par trame de 50 ms en médiane ; retard
médian de la boucle du serveur 14 ms en rejeu, contre 16 ms avant. Analyse au fil de l'audio
identique à l'analyse d'un bloc (test). Sur le cours continu dont l'allure est connue, le débit
mesuré range les passages : lents 4,0 syllabes/s (écart à l'habitude −1,05), normaux 5,8
(−0,11), rapides 9,6 (+1,81). Les 3 questions finissent à +0,1 demi-ton en médiane, les autres
phrases à −3,3.

**Limites.** Voix de synthèse : elle ne met rien en relief volontairement et ne varie pas
d'expressivité ; « animée », « posée » et les mots en relief (7 % des mots ici) restent à juger
sur l'enregistrement du formateur. Trois questions ne font pas une mesure.

## Ce que six semaines (au lieu de 48 h) remettent sur la table

Dans l'ordre de valeur : tests automatisés dès le départ (fait) ; multilingue réel
(ES/AR/PT — le fan-out est prévu, il manque les voix) ; transcription bilingue remise
aux apprenants (SQLite revient à ce moment-là) ; file de questions avec modération ;
vitesse TTS adaptative ; clonage de la voix du formateur (consentement écrit) ; SFU
WebRTC *si* le test de charge l'exige.

Ce qui ne revient pas : l'application native, le débruitage, le VAD maison.
