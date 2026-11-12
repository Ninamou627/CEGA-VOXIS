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

## D29 — L'expressivité ne passe pas par ElevenLabs : ce qui marche, ce qui ne marche pas

**Question.** Quels leviers d'ElevenLabs font réellement passer dans la voix française ce que
D28 mesure chez le formateur (phrase animée ou posée, mot en relief, question) ? Mesuré avec
l'analyse de prosodie (D24) sur la voix produite, le 20/10/2026, voix prédéfinie « Sarah »
(vérifiée en français ; l'offre gratuite refuse par l'API les voix de la bibliothèque, dont
les voix françaises du compte : erreur 402).

| Levier | Résultat | Suite |
|---|---|---|
| Vitesse (`speed`) | respectée par Flash v2.5 et Turbo v2.5 ; **ignorée** par v4 Turbo et v3 Conversational (même durée à ×1 et ×1,2) | les modèles expressifs sont incompatibles avec D26 : écartés |
| Point d'interrogation | la fin monte de 1,4 à 3,1 demi-tons de plus qu'avec un point (4 paires) | déjà fourni par AssemblyAI ; ajouter « ? » sur une voix montante ne ferait que des erreurs (2 cas sur 100 segments, tous deux faux) |
| Virgule (D27) | sur la vraie voix en séance : fin à +0,4 demi-ton après une virgule (18 segments), −1,1 après un point (23) | confirmé |
| Stabilité (0,2 → 0,8) | aucune tendance : l'étendue de la mélodie varie plus d'une génération à l'autre qu'avec le réglage | pas de correspondance « animée → stabilité » |
| Majuscules (« TRÈS ») | mot de même durée, moins ressorti en énergie (+3,1 au lieu de +4,8 dB ; +1,3 au lieu de +5,9) | pas d'accentuation par les majuscules |
| Indications « [excited] » (v3/v4) | non testées : ces modèles ignorent la vitesse | — |

Latence d'un segment de ~80 caractères, connexion ouverte : ~0,3 s pour Flash et Turbo ;
0,5 à 0,6 s pour v4 Turbo.

**Avant / après avec la vraie voix (cours continu de 144 s, AssemblyAI, DeepL, ElevenLabs
Turbo v2.5 ; « avant » = code de D25, « après » = D26 + D27 + D28 ; un passage chacun).**

| | Avant | Après |
|---|---|---|
| Début de parole → son, médiane / p95 | 4,8 / 7,1 s | 4,4 / 6,9 s |
| Pente du retard | +0,7 s/min | +0,5 s/min |
| Le débit de la voix suit celui du formateur (corrélation) | 0,18 | 0,56 |
| L'étendue de la mélodie suit (corrélation) | −0,10 | 0,34 |
| L'énergie suit (corrélation) | −0,16 | −0,21 |
| Pauses de plus de 0,5 s retrouvées à l'écoute | 41 % | 68 % |
| Mots mal relus par un STT (intelligibilité) | 7 % | 9 % |

Coût de l'étape : 3 485 crédits ElevenLabs sur 10 000.

**Conclusion.** Avec ElevenLabs, ce qui passe du formateur à la voix est le débit (D26), les
pauses (D26) et la ponctuation (D27). Ni l'animation d'une phrase ni l'accent d'un mot n'ont de
levier fiable sur les modèles qui respectent la vitesse. Les rendre demanderait un moteur dont
la prosodie se commande de façon déterministe — Azure Neural, déjà branché comme secours, prend
en SSML la hauteur, le volume, le débit et les pauses par mot ou par phrase (offre gratuite :
500 000 caractères neuronaux par mois) — à mesurer de la même façon, avec une clé Azure, et à
comparer à l'oreille.

## D30 — La vitesse de la voix ne saute plus ; ce que le premier serveur hébergé a montré

Deux séances réelles le 07/11/2026 depuis la VM Azure (Autriche) : un discours d'Obama joué
par un téléphone devant le micro du PC, écouté sur le même PC (écouteurs), AssemblyAI U3.5 Pro,
DeepL, ElevenLabs Turbo v2.5 (voix Sarah). 32 puis 63 segments mesurés.

**Ce que l'auditeur a entendu, et ce que disent les mesures.**

| Ressenti | Mesure (2ᵉ séance) | Cause |
|---|---|---|
| « la voix attend trop avant de parler » | début de phrase → son 4,3 s en médiane aux prises de parole, dont 3,2 s à attendre la fin du premier morceau | la traduction par morceaux (D10, D25) |
| « la voix accélère par moments » | 75 % des segments à ×0,85 ou à ×1,2 ; 23 enchaînements sur 56 changent de 0,2 ou plus | D26 calculé segment par segment, sur des morceaux courts |
| « des mots sont sautés » | 63 segments sur 63 joués, aucun trou de numéro | en amont de la page : reconnaissance, traduction ou voix (à mesurer, voir plus bas) |

**Décision.** La vitesse ne bouge plus que de 0,05 d'un segment au suivant, entre ×1 et ×1,2,
et une prise de parole repart entre ×1,05 et ×1,15 (`pipeline/tempo.ts`). La vitesse que le
segment seul aurait demandée reste journalisée (`targetSpeed`). Rejoué sur les deux séances
(modèle de la file des téléphones, ~0,5 s plus optimiste que la mesure) :

| Politique | Séance 2 : fin → son, médiane / p95 | Séance 1 | Sauts ≥ 0,2 (séance 2) |
|---|---|---|---|
| D26 (segment seul, 0,85–1,2) | 2,6 / 7,0 s | 1,1 / 3,1 s | 23 / 56 |
| ±0,05, 1–1,2 (retenu) | 2,4 / 7,0 s | 1,1 / 3,6 s | 0 / 56 |
| Vitesse fixe ×1,10 | 2,4 / 6,6 s | 1,1 / 3,4 s | 0 / 56 |

La vitesse fixe vaut autant pour la latence, mais la voix ne suivrait plus du tout l'allure du
formateur ; le lissage la garde, en douceur.

**Corrigé au passage.**
- *Sourdine.* Le STT ne reçoit rien pendant une sourdine : l'audio d'avant et d'après s'y
  touche. Des mots dits juste avant une sourdine sont partis 20 minutes plus tard avec la
  première phrase d'après, datée de la sourdine (« parole » de 1 208 s, voix à ×0,85). À la
  sourdine, le STT clôt désormais la phrase en cours ; à la reprise, un segment ne commence pas
  avant elle, et la reprise ouvre une prise de parole (premier morceau rapide, D25).
- *Adresse des appareils derrière Caddy.* Le WebSocket lisait l'adresse de la connexion, celle
  du proxy (172.18.0.4 pour tous) : trente codes faux tapés par n'importe qui bloquaient toutes
  les nouvelles connexions, et chaque bon code remettait le compteur de tous à zéro. Avec
  `TRUST_PROXY`, HTTP et WebSocket prennent la dernière entrée de X-Forwarded-For, celle que le
  proxy écrit (`client-address.ts`) ; `trustProxy: true` de Fastify croyait toute la chaîne et
  prenait la première, que le client peut inventer.

**Ce qui reste à mesurer.** Les mesures ne gardent pas les textes : pour savoir où se perdent
les mots, une séance avec `RECORD_DIR` (texte reconnu, traduction, chaque voix), relue par
`npm run prosody -- --stt`. Trois voix ont duré deux fois la normale (69 caractères en 8,7 s) :
à vérifier sur leurs fichiers. Une minute de discours continu coûte ~370 crédits ElevenLabs
(2 285 caractères en 3,1 min), le double d'une parole avec pauses.

## D31 — L'âge d'une voix part de la fin de sa phrase ; la salle est vouvoyée

Troisième séance le 08/11/2026, même montage que D30, enregistrée (`RECORD_DIR`) : 40 segments.
L'enregistrement dit enfin où se perdent les mots.

| Étape | Mesure | Verdict |
|---|---|---|
| Page apprenant | 39 voix jouées sur 40 : #19 sautée | **la cause du « mot sauté » entendu** |
| Reconnaissance en direct | 19 % d'écart avec la transcription différée du même son | substitutions qui changent le sens ; pas concentrées autour des coupes forcées |
| Traduction | fidèle, mais 8 segments au « tu » (« si tu tiens à moi ») | registre qui change en cours de discours |
| Voix | relue par AssemblyAI : 4,2 % d'écart avec le texte à dire | correcte |

Le blanc de 13 s entendu en cours de séance était les applaudissements du discours.

**Âge depuis la fin de la phrase.** La page sautait une voix arrivée plus de 8 s après le
*premier mot* de sa phrase. #19 durait 7,4 s (23 mots) ; sa voix était prête 1,1 s après la
fin, mais 7,9 s après le premier mot, et elle a sauté entière. Toute phrase de plus de ~6,5 s
était menacée, alors que ce sont les plus longues qui portent le plus de sens. L'âge est
désormais compté depuis la fin prononcée (`tEnd` dans l'en-tête audio, `arrivalAgeMs` et
`tooLate` dans `shared/playback.ts`, partagés avec `npm run load`). La limite reste 8 s, et la
file de 8 s aussi : un téléphone vraiment en retard saute toujours. Rejoué sur la séance, l'âge
le plus élevé au départ de la voix passe de 7,9 s à 5,0 s : aucune voix n'aurait sauté.

**Vouvoiement.** DeepL reçoit `formality: "prefer_more"`, et le prompt de Claude (secours) le
demande aussi. Les 8 segments tutoyés, rejoués avec leur contexte : 8 au « tu » sans le
réglage, 0 avec. Sur deux phrases complètes, DeepL vouvoyait déjà : le réglage tient surtout
le registre sur les fragments. « prefer_ » : une langue cible sans formalité est traduite
quand même (vers l'anglais, vérifié).

**Ce qui reste à mesurer.** L'écart de 19 % compare deux reconnaissances entre elles, pas au
texte vraiment dit. Prochaine séance : un texte connu lu au micro, pour mesurer le vrai taux
d'erreur de la reconnaissance en direct, et vérifier qu'une phrase de plus de 7 s est jouée.

## D32 — Rien n'est sauté, rien n'est accéléré par la page ; moins de morceaux

Séances des 08 et 09/11/2026, même montage que D30. Ressenti de l'auditeur : une voix
« dégradée, pas fluide », des mots « sautés au profit du rattrapage de l'intervenant ». Les
mesures (`metrics.jsonl`, accusés de lecture des téléphones) trouvent trois causes, toutes dans
nos propres règles de rattrapage :

| Ressenti | Mesure | Cause |
|---|---|---|
| des phrases sautées | 3 voix jamais jouées (#111, #124, #126) | livrées par la reconnaissance 8 à 12 s après les mots ; la page jetait toute voix de plus de 8 s (D31) |
| une voix dégradée | le 09/11, 39 % du temps d'écoute étiré par le navigateur, dont la moitié sans rien en attente ; voix produite à ×1,15 ou plus sur 32 % du temps ; au total ×1,2 ou plus pendant 28 % du temps | `ElementPlayer.queueMs` comptait la voix en cours : toute voix de plus de 2 s passait à ×1,08, en plus de la vitesse d'ElevenLabs |
| pas fluide | 27 % (09/11) à 43 % (08/11) des segments font 3 mots ou moins ; « Um, hello, Mr. » puis « President. » partent séparément | coupe sur le point de « Mr. » ; chaque morceau est dit à part, l'intonation repart de zéro |

Hors de cause : la qualité des fichiers de voix (MP3 44,1 kHz, 64 kbit/s mono), les écouteurs
(filaires). Une quatrième cause reste ouverte, côté PC : le 08/11, 15 à 27 % du son du micro
n'est pas arrivé au serveur dans 7 séances sur 8 (rien de perdu le 09/11).

**Décision.** L'apprenant veut tout entendre, d'une voix naturelle, plutôt qu'immédiatement.
- *Aucune voix sautée.* La page ne jette plus rien, ni par l'âge ni par la file
  (`shared/playback.ts` ne garde que la pause gardée de D26). Seul « Revenir au direct », un
  geste de l'apprenant, vide encore la file.
- *Aucun étirement dans le navigateur.* `playbackRate` reste à 1 : `setRate` est retiré du
  lecteur. La file d'attente affichée ne compte plus que ce qui reste à jouer. La seule vitesse
  est celle de la synthèse, plafonnée à ×1,1 au lieu de ×1,2 (`MAX_SPEED`, et une prise de
  parole repart entre ×1,05 et ×1,1). `tEnd` quitte l'en-tête audio : plus personne ne le lit.
- *Moins de morceaux.* La coupe ignore le point d'un titre (« Mr. », « Dr. »… `isTitle`). Un
  segment de 3 mots ou moins, ou qui finit sur un titre, est retenu et part avec le suivant si
  l'orateur reprend en moins de 600 ms (1,5 s après un titre) ; sinon il part seul dès que la
  pause est constatée, et au plus tard après 4 s. Un arrêt, une sourdine ou une panne de la
  reconnaissance le libèrent : aucun mot perdu. Réglage « Morceaux courts » dans la
  Configuration (`speech.joinShort`, actif par défaut).

Rejoué sur la séance du 08/11 (111 segments) : les segments de 3 mots ou moins passent de 43 à
25 ; 11 segments partent plus tard, de 2,6 s en médiane (p90 3,7 s, max 3,9 s). Fusionner aussi
vers l'arrière gagnait peu et n'a pas été retenu.

**Le prix.** Pendant un discours continu, le retard s'accumule au lieu d'être rattrapé, et ne
se résorbe que pendant les pauses de l'orateur ; un morceau court retenu ajoute jusqu'à 4 s.
L'indicateur D19 (moins d'une seconde après la fin de la phrase) s'éloigne : c'est un choix de
l'utilisateur, une traduction complète et fluide avant une traduction immédiate.

**Ce qui reste à mesurer.** Un enregistrement de 2 min de ce qui sort des écouteurs (boucle
WASAPI sur la sortie par défaut), sur le même passage, pour vérifier à l'oreille et par
transcription : vitesse, blancs, coupures, mots perdus. Puis la perte du son du micro côté PC.

## D33 — Aucune phrase sans voix ; des phrases entières

Essai du 09/11/2026 à 12:11 après D32, même montage, avec enregistrement des écouteurs (boucle
WASAPI). Chaque étape a été vérifiée contre la précédente :

| Étape | Mesure | Verdict |
|---|---|---|
| Son du micro | 98 à 102 % reçu par le serveur | bon (perte du 08/11 absente) |
| Reconnaissance | 306 mots dans la transcription différée du même son ; le direct en a 94 % à l'identique, aucun passage de 2 mots manqué | bonne : « Universidad San Marcos » → « University », « Thank you », un « Hello », un « or » |
| Découpage | aucun mot perdu ; **20 voix sur 46 s'arrêtent au milieu d'une phrase** | les « coupures » entendues |
| Traduction | 46 segments sur 46 complets (relus) | bonne |
| Voix | fichiers relus par transcription : 3,2 % d'écart, 1 mot ; **les 4 dernières phrases sans voix** | crédits ElevenLabs épuisés à 12:14:02, aucun secours |
| Lecture | 42 voix sur 42, en entier ; vitesse mesurée dans les écouteurs ×0,99 | bonne (D32 tenu) |

**Une phrase n'est jamais perdue faute de voix.** Le serveur n'affichait que le texte quand
ElevenLabs échouait. Désormais :
- chaque moteur de voix retente une fois une panne passagère (réseau, délai, 429, 5xx) après
  300 ms : la salle garde sa voix ;
- un refus (crédits épuisés, clé refusée) passe aussitôt au secours, la voix française Azure
  « Denise » (`TTS_BACKUP=azure`), pour 60 s avant de réessayer le primaire. Palier gratuit F0 :
  500 000 caractères par mois, environ 8 h de voix. Parmi les régions que l'abonnement étudiant
  permet, seule `germanywestcentral` offre les voix neuronales (`spaincentral` est exclue du
  service Speech autonome) ;
- Azure garde sa connexion ouverte entre deux phrases, comme les autres fournisseurs (D20).

**Des phrases entières.** Le STT clôt un tour à chaque hésitation de l'orateur (pauses de
250 ms, D22) : « C'est vraiment un honneur de »… silence… « J'étudie le marketing à »… Un
segment sans ponctuation finale, ou fini sur une hésitation (« uh, ») ou sur un mot qui annonce
la suite (« to », « the », « and »…, même suivi du point d'une coupe forcée), attend la suite et
part avec elle si l'orateur reprend avant 2,5 s, 8 s au plus depuis le premier morceau retenu ;
une vraie pause l'envoie seul. Réglage « Phrases » dans la Configuration (`speech.wholeSentences`,
actif par défaut). Rejoué sur les deux séances du 09/11 :

| Séance | Voix coupées au milieu d'une phrase | Voix | Voix qui partent plus tard |
|---|---|---|---|
| 12:08 (D32) | 20 → 3 | 46 → 30, 11 mots en médiane | 13 : +2,9 s en médiane, +7,0 s au plus |
| 10:42 (avant D32) | 13 → 2 | 25 → 19 | 11 : +3,7 s en médiane, +7,1 s au plus |

Les coupures restantes suivent un vrai arrêt de l'orateur (4,4 s de silence après « honor to »).
Le premier morceau rapide d'une prise de parole (D25) attend lui aussi sa suite : la voix
commence plus tard, mais sur une phrase.

**Le prix.** Encore du retard, au profit de phrases entières : c'est le choix de l'utilisateur,
une voix complète et fluide avant une voix immédiate (D32). L'indicateur D19 s'éloigne d'autant.

**Ce que l'essai a aussi montré.** Le retard monte à 8–9 s sur 4 voix en fin de passage : la
phrase #34 est sortie du STT 4,7 s après les mots (coupe au délai, sans ponctuation), puis DeepL
a mis 3,0 s au lieu de 0,2 s, et les trois suivantes ont attendu derrière elle (chaîne série par
langue). Le retard est retombé à 2,8 s à la pause suivante, sans rien sauter. Pistes : un second
moteur de traduction lancé si DeepL tarde, et la coupe au délai.

## D34 — Le micro qui perd du son se voit ; la voix Azure sans blanc ; moins de faux points

Essai du 09/11/2026 à 14:17 après D33, même montage, toutes les voix en secours Azure (crédits
ElevenLabs épuisés jusqu'au 19/11). La reconnaissance est comparée cette fois au texte officiel
de la Maison Blanche (Public Papers of the Presidents, govinfo), et non à une autre transcription
automatique : celle du test 6 avait elle-même perdu « ask you this question. Well, my name is
Alonso Cornejo ».

| Étape | Test 7 (14:17) | Test 6 (12:08) |
|---|---|---|
| Son du micro reçu par le serveur | **74 %** | 100 % |
| Mots du texte officiel retrouvés à l'identique | 94,2 % (16 manquants) | 90,0 % |
| Phrases traduites | 69 / 69 | 46 / 46 |
| Voix fabriquées, jouées, entendues | 69 / 69 | 42 / 46 (crédits) |
| Voix coupées au milieu d'une phrase | 4 / 69, toutes au plafond de 8 s | 20 / 46 |
| Silence entendu à la fin de chaque voix | **984 ms** en médiane (Azure) | 272 ms (ElevenLabs) |

**Le micro qui perd du son se voit.** Au test 7, le navigateur du PC a jeté 26 % du son du micro
par paquets entiers de 10 ms (les ruptures tombent toujours au même endroit d'un bloc de 160
échantillons), avant même le worklet : ce n'est pas le réseau. Le code n'a pas changé depuis le
test 6, où rien n'était perdu ; la cause est donc dans l'environnement du PC (onglet en
arrière-plan, économie d'énergie, charge), pas encore établie. Mots perdus ou déformés :
« not Peru », « Thank you », « Peruvian » → « proving », « constantly doing » → « customly »,
« saying to yourself » → « save yourself a lot » (contresens en français). Désormais :
- la page formateur mesure, à l'arrivée de chaque trame, le son livré par le worklet contre le
  temps réel écoulé sur 10 s (`shared/capture.ts`) ; ni les minuteries d'un onglet caché ni un
  thread principal bloqué un instant ne faussent la mesure ;
- deux relevés de suite sous 95 % affichent une alerte au formateur ;
- chaque relevé part au serveur avec l'état de l'onglet (visible, au premier plan) : journal
  `capture`, champ `micCapture` des stats, alerte et étage « Microphone » du tableau de bord.
Si l'alerte ne suffit pas, une captation qui ne dépend plus du rendu audio du navigateur
(MediaStreamTrackProcessor dans un worker) est la suite.

**La voix Azure sans blanc.** Mesuré sur le serveur : 100 ms de silence avant la phrase, 840 ms
après. Ce silence s'ajoutait à la pause de l'orateur que l'écoute garde déjà (D26) : 70 s de
silence sur 276 s de voix au test 7, un blanc d'environ 1 s entre chaque phrase, et une file
d'écoute qui gonfle. Le SSML fixe désormais 50 ms avant et 150 ms après (`mstts:silence`,
`Leading-exact` / `Tailing-exact`) ; mesuré : 10 ms et 180 ms avec 0 et 150 ms demandés, soit
≈ 0,7 s de gagnée par phrase.

**Moins de faux points.** Quand l'orateur s'arrête au milieu d'une phrase, la reconnaissance met
un point : « the world is. » / « In a place where it can. » devenaient « le monde est ainsi, » /
« Dans un état où il peut l'être, ». Les 63 frontières du test 7 et les 42 du test 6 ont été
étiquetées avec le texte officiel : 26 faux points sur 57 points au test 7, 6 sur 22 au test 6.
Ce qui les distingue d'une vraie fin :
- ni la pause qui suit (médiane 686 ms contre 724 ms pour une vraie fin), ni la coupe forcée
  par nous (21 sur 26 contre 22 sur 31) ;
- « le morceau suivant commence par une minuscule ou une préposition » en recolle 4 sur 26, et
  « … ou par And / Or » 12, mais avec 8 vraies fins sur 31 retenues à tort. Surtout, ces règles
  obligent à attendre le premier mot suivant après chaque phrase, soit 1,5 à 2 s de plus sur
  presque toutes. Non retenu ;
- le dernier mot : un auxiliaire ou un modal (« is », « can », « would »…) ne finit aucune des
  vraies fins des deux séances. Ces mots rejoignent donc ceux qui retiennent le morceau (D33). Et
  quand deux morceaux se rejoignent, le faux point du premier disparaît : la traduction lit une
  seule phrase.
Gain modeste et sans coût : une frontière par séance (« the world is In a place where it
can… »).

## D35 — Une liaison figée se repère ; à la reconnexion, le direct

Essai du 09/11/2026 à 15:25 après D34, même montage. Tout le reste tient : son livré par le
navigateur 98,5 à 102 % (même onglet caché), reçu par le serveur 100 %, 95,0 % des mots du
texte officiel à l'identique, 60 phrases traduites et dites sur 60, blanc après chaque voix
Azure 312 ms au lieu de 984 ms. Mais à 15:27:10, le PC a perdu le réseau environ 80 s (il sort
sous deux IP publiques). La liaison de la page d'écoute s'est figée sans se fermer : ni le
navigateur ni le serveur ne s'en sont aperçus, faute de battement de cœur. Quand elle est
revenue, elle a tout livré d'un coup : 39 voix sur 60 jouées 4 minutes en retard, entre
15:31:14 et 15:33:25. Aucune n'était perdue, mais c'était inutilisable en direct.

**Repérer une liaison figée, des deux côtés.**
- Page (`client/src/lib/ws.ts`) : le serveur parle au moins toutes les 2 s (stats, à tous les
  rôles). Passé 6 s sans rien, ou une ouverture qui n'aboutit pas en 6 s, la page débranche
  l'ancien socket avant de le fermer (code 4000) : rien de ce qu'il livrerait encore ne
  l'atteint. Puis elle en rouvre un, en moins d'une seconde la première fois.
- Serveur (`server/src/ws/heartbeat.ts`) : un ping toutes les 10 s, et toute liaison qui n'a
  pas répondu au précédent est coupée. Le départ est journalisé (`leave`, avec `cut: "no_pong"`
  et le code de fermeture), et le nombre d'apprenants redevient juste.
- Formateur : il revient souvent alors que son ancienne liaison, figée, tient encore la place.
  Avant, il recevait le refus `lecturer_exists`, définitif. Désormais l'ancienne liaison a 2 s
  pour répondre à un ping. Muette, elle cède la place (`cut: "seat_taken"`) ; vivante (un
  second poste ouvert), le refus reste. Le redémarrage du pipeline attend la fin de son arrêt :
  sans cela, le « micro coupé » de l'ancienne prise arrivait après le « micro ouvert » de la
  nouvelle, et l'enregistrement de la séance s'arrêtait 15 s plus tard.

**À la reconnexion, le direct — rien n'est gardé pour plus tard.** Il avait été proposé de
garder 5 minutes de voix sur le serveur et de renvoyer à la page celles qu'elle n'avait pas
reçues. Refusé : après une coupure, on reprend sur le direct. Une voix gardée pour être jouée
plus tard retarderait le direct. Les voix et les lignes de texte émises pendant une coupure
sont donc perdues pour cet apprenant. Ce qui était déjà arrivé dans la page avant la coupure
se joue normalement.

**Mesuré en local**, avec le vrai `attachWs`, le pipeline en fournisseurs simulés, la page
d'écoute construite dans un navigateur, et un relais TCP qu'on fige sans rien fermer :

| Coupure simulée | Page de nouveau dans la salle | Ancienne liaison libérée | Voix émises pendant la coupure |
|---|---|---|---|
| Ancien chemin mort, nouveau ouvert | 6,5 s après le gel | coupée par le serveur en 14,2 s | non jouées |
| L'ancien chemin revient au bout de 8 s, avec son arriéré (le test 8) | 5,8 à 6,5 s | fermée (4000) dès le retour du réseau | arrivées sur l'ancien socket, non jouées |
| Panne de 25 s, nouvelles connexions en suspens | 19 ms après le retour du réseau | coupée par le serveur en 12,1 s | non jouées |

Aucun arriéré après la reprise. Retard bout-en-bout du pipeline simulé :
- avant la coupure : 3,2 à 4,9 s ;
- les 1 à 4 premières voix après la reprise : 5,0 à 7,6 s ;
- ensuite : 3,5 à 5,0 s.

La file d'écoute monte au plus à 5,4 s, contre 4,2 s avant. Un formateur simulé, avec le même chien de garde,
a repris sa place 8,1 s après le gel : 6,6 s pour repérer la coupure, 0,5 s pour rouvrir, 2 s
de sonde. Quand son ancienne liaison s'est fermée d'elle-même, il est entré 3 ms après.

**Limites.**
- Formateur : le micro est perdu du gel jusqu'à la réadmission (la coupure, plus environ 6 s
  pour la repérer, plus jusqu'à 2 s de sonde).
- Au retour du réseau, une tentative en suspens aboutit aussitôt. Si la page vient d'en
  abandonner une, la suivante attend son délai, jusqu'à 9,6 s.
- Entre la reconnexion et la coupure de l'ancienne liaison, l'apprenant compte double au plus
  20 s (7,6 s mesurées).
- Les accusés de lecture envoyés pendant le gel sont perdus : la mesure de latence a un trou
  à cet endroit.
- Une page elle-même endormie plus de 6 s (onglet gelé, veille) peut se reconnecter sans
  nécessité. Coût : une reconnexion.
- Le lecteur à deux `<audio>` (ElementPlayer) n'a toujours pas de garde si `ended` ne vient
  jamais.

## D36 — Les mots figés se retrouvent par alignement, plus par leur rang

Première correction de l'audit du 10/11/2026 (`docs/AUDIT-2026-11.md`, défaut F-01).

**Constat.** Le découpage repérait les mots déjà figés par leur rang dans le tour. Or le STT renvoie
le tour entier à chaque message et le révise. Reproduit sur `CommitGate`, hors serveur :

| Révision du STT | Avant | Après |
|---|---|---|
| un mot retiré en amont (« the ») | « …pipeline friday morning. » : « on » perdu | « …pipeline on friday morning. » |
| un mot inséré en amont (« brand ») | « …new pipeline pipeline on… » : mot doublé | « …new pipeline on… » |
| texte définitif plus court (« twenty five » → « 25 ») | « …dollars per » : « user. » perdu, plus de point final | « …dollars per user. » |

**Décision.** Les mots figés sont alignés sur le début de chaque hypothèse (distance d'édition,
`alignedEnd` dans `pipeline/commit.ts`) et l'on reprend après le dernier. Sans révision, le
comportement est inchangé. Entre deux alignements de même coût : celui où le dernier mot figé se
retrouve tel quel, puis le plus proche, puis le plus court — mieux vaut redire un mot qu'en perdre un.

**De quoi mesurer en séance.** Jusqu'ici, rien ne gardait ce que le STT envoie : impossible de dire
si un mot manquant n'avait jamais été reconnu ou s'était perdu au découpage.
- Avec `RECORD_DIR`, l'enregistreur écrit `stt.jsonl` : hypothèses, textes définitifs, fins de tour,
  tours écartés.
- `npm run gate -- <séance>` rejoue le découpage dessus, hors ligne, et compte les mots perdus,
  doublés, ajoutés après coup, déjà dits au tour précédent, figés puis contredits.
- Le journal porte, à chaque segment, `sttShifts`, `sttShiftedWords` et `sttContradicted`.

**Vérifié.** 205 tests sur 205 (10 nouveaux). Sur une séance de synthèse de 7 tours, le contrôle
trouve 2 mots perdus et 1 doublé avec l'ancien découpage (commit 6727546), aucun avec le nouveau.

**Limites.**
- La fréquence de ces révisions en séance réelle n'est pas mesurée : il faut une séance enregistrée
  depuis cette version. Indice : 18 tours sur 46 de l'essai 6 s'étaient clos sans ponctuation finale.
- Un mot que le STT ajoute en amont de mots déjà figés n'est toujours pas dit (« brand » ci-dessus),
  et un mot figé puis corrigé reste dit dans sa première forme : ce qui est figé ne se réécrit pas,
  même s'il n'est pas encore parti. `npm run gate` compte ces cas ; les rendre révisables tant
  qu'ils sont en tampon est la suite possible, à décider sur ces chiffres.

## D37 — Aucun son perdu entre le micro et la reconnaissance

Deuxième correction de l'audit du 10/11/2026 (étape 1.2, défauts F-02 et F-07).

**Constat.**
- La page du formateur envoyait du PCM brut, sans numéro, et ne gardait rien. Pendant une coupure,
  tout ce qui se disait était perdu : la coupure, plus les ~6 s qu'il faut pour la repérer (D35).
- Le serveur jetait toute trame arrivée sans session STT ouverte : au démarrage du micro (~0,5 s),
  et pendant une réouverture après panne (1 à 10 s).
- Une session refusée par AssemblyAI passait pour ouverte et avalait l'audio.
- La session s'arrêtait au bout de 3 h (3008), au milieu d'une phrase.

**Décision.**
- *Page* (`shared/uplink.ts`, `shared/framing.ts`). Chaque trame de 50 ms part avec son numéro et
  l'instant de sa captation (en-tête de 16 octets ; du PCM brut reste accepté). Les 30 dernières
  secondes restent en réserve. Rien ne part avant l'admission. À chaque admission, la page renvoie
  ce que le serveur n'a pas :
  - liaison reprise : il dit où il en est (`resumeSeq`) ;
  - serveur redémarré : elle repart de la dernière trame qu'il a confirmée (`micSeq`, toutes les 2 s).
- *Serveur* (`pipeline.ts`).
  - Une trame reçue deux fois est écartée ; une trame jamais reçue est comptée (`audio.gap`).
  - L'instant de captation date la parole, et mesure le retard montant (`uplinkP50Ms`).
  - Sans session STT ouverte, l'audio attend, 40 s au plus ; au-delà, le plus ancien cède et se compte.
  - Un formateur admis est attendu même pendant l'arrêt de la prise précédente.
- *Ouverture du STT* (`assemblyai.ts`). La session n'est ouverte qu'à `Begin`, attendu 10 s au plus.
  Refusée, l'audio attend et l'on réessaie avec recul (1 à 10 s). Le motif d'AssemblyAI est
  journalisé : 1008 couvre aussi bien la clé que le plafond de sessions.
- *Rejeu à une nouvelle session.* Une nouvelle session de la même captation reçoit d'abord ce que
  la précédente avait reçu sans le rendre, précédé de 3 s de contexte ; 40 s au plus. Le silence
  qui suit le dernier mot rendu ne se rejoue pas : une session tombée pendant une longue pause ne
  retarde pas la parole d'après. Ce qui était déjà parti ne repart pas (`CommitGate.saidBefore`) :
  - les mots partis que la nouvelle session rend à son tour, même texte, dans le même ordre, sont
    écartés ; l'écart entre leurs deux datations recale la suite ;
  - un mot qu'elle ne retrouve pas est jugé à l'horloge de la parole, recalée : bien avant le
    dernier mot parti (plus de 1,5 s, ou de 400 ms une fois recalée), c'est un mot déjà dit,
    entendu autrement ; plus près ou après, il part ;
  - le bout de mot coupé en tête du contexte est écarté.
- *Relève avant 3 h.* Passé 2 h 50, pendant une pause, quand rien n'attend et que le STT a rendu la
  parole d'avant la pause. Refusée, la session en place continue ; nouvel essai une minute après.
- *Arrêt du micro.* Le STT rend son retard avant de fermer : `Terminate`, puis attente de
  `Termination`. L'attente dure au plus l'audio non encore rendu (le silence après le dernier mot
  n'y compte pas), plus 5 s, et une minute au maximum. Le micro ne se dit éteint qu'ensuite. L'arrêt du serveur, lui, n'attend pas : Docker
  le tue 10 s après SIGTERM.
- *Mesure.* `/api/health` porte les trames doublées, manquantes, en attente et jetées.
  `stt.jsonl` note le début de chaque flux et ce qui lui a été rejoué ; l'événement `stt.warmup`,
  ce que la session d'avant n'avait pas rendu (`behindMs`). `npm run gate` compte à part les mots
  « déjà dits par la session d'avant ».
- *Tableau de bord.* Le retard montant y est visible : « Voix du formateur » dans les tendances,
  micro « En retard » et alerte au-delà de 1 s (critique au-delà de 3 s). Le son jamais reçu
  aussi : micro « Son perdu » et alerte critique. Les deux étaient mesurés sans être montrés.

**Mesuré les 11 et 12/11/2026 sur AssemblyAI U3.5 Pro.**
- Ouverture. Au plafond de sessions simultanées, AssemblyAI accepte la connexion, envoie « Too many
  concurrent sessions » à la place de `Begin`, puis ferme (1008) 0,15 s plus tard. `Begin` arrive
  ~1,1 s après la connexion.
- Langue. Une session neuve qui commence sur « liters per minute at 1,500 revolutions per minute »
  y entend du français (confiance 0,81), et le garde-fou écarte la phrase. Précédée des 2 à 3 s
  d'avant, elle entend de l'anglais.
- Rafale. 45 s d'audio envoyées d'un coup sont acceptées, sans fermeture 3007. Les ~13 premières
  secondes sont transcrites aussitôt, le reste au rythme du temps réel ; le retard se résorbe
  ensuite à ×1,2–1,3.
- Arrêt. Après `Terminate`, AssemblyAI rend encore tout ce qu'il a reçu : le dernier tour arrive
  21,5 s après une rafale de 30 s, 0,2 s en temps réel.
- Session tombée en retard. Coupée du réseau à 30 s, une session n'avait pas rendu ses 3,5
  dernières secondes. Les 3 s alors rejouées n'en couvraient que la fin, sans amorce en anglais :
  9 mots perdus (« A10VSO, and it was installed on March 14, 2019. »). D'où le rejeu de tout ce
  qui n'a pas été rendu.
- Jonction de deux sessions. Elles ne datent pas au même endroit les mots du contexte rejoué. Le
  12/11, les trois séances coupées côté STT perdaient « is » à la jonction (et « 45 » une fois).
  Le diagnostic de la troisième : la session tombée avait rendu « 2019 Its nominal flow » en
  étalant « Its » et « nominal » vers l'arrière, dans la pause qui les précède (« Its » 1,2 s avant
  sa place dans la fixture) ; la nouvelle a tassé ses premiers mots vers le début du contexte
  (« is » 1,1 s trop tôt). D'une session à l'autre, un même mot s'est déplacé de 0,6 à 1,1 s.
  Comparé au dernier mot parti à ±400 ms près, « is », dit après lui, semblait le précéder de
  0,7 s : écarté comme déjà dit. D'où le recalage sur les mots rendus par les deux sessions.
- Banc d'essai. Quatre séances en parallèle depuis le même poste saturent sa connexion montante.
  Le 12/11, dans la séance sans coupure d'un tel lot, jusqu'à 9 s d'audio attendaient dans notre
  connexion vers AssemblyAI, et le texte arrivait 8,4 s après la parole (médiane) ; des sessions
  tombaient (1011 « keepalive ping timeout », 1006). Seule, 30 min plus tard : 0,45 s et 1,1 s.
  Les séances coupées se mesurent donc une à une. En production, le serveur est hébergé.

Banc d'essai de bout en bout : le vrai serveur (`attachWs`, pipeline, AssemblyAI ; traduction et
voix simulées), un relais TCP qu'on fige, et un poste formateur qui fait comme la page (vraie
liaison montante, chien de garde de 6 s). Fixture : 123 s de voix de synthèse, 209 mots ; coupure
à 30 s. Mots du texte perdus, par rapport à une séance sans coupure :

| Coupure | Première version (réserve 10 s, attente 15 s) | + contexte rejoué, `Begin` attendu | + retard rendu à l'arrêt | + tout le non-rendu rejoué, jonction recalée |
|---|---|---|---|---|
| Réseau du formateur, 5 s | 0 | — | 0 | 0 |
| Réseau du formateur, 20 s | 24 (235 trames jamais reçues) | 10, dont la fin du texte (9) | 2 \* | 0 |
| STT injoignable, 5 s | 11 (phrase écartée par le garde-fou de langue) | 1 \* | — | 0 |
| STT injoignable, 20 s | 23 (10,4 s d'audio jetées) | 11, dont la fin du texte (9) | 0 | 0 |

\* Les mots comptés perdus sont là, soudés par le STT au mot suivant : « notevery », « hf2208 ».
C'est une graphie du STT, pas une perte du chemin audio. Elle est plus fréquente quand une
seconde session s'est ouverte en cours de route : « hf2208 » dans 16 séances coupées sur 20, contre
1 sur 4 sans coupure ; « notevery » dans 8 sur 20, jamais sans coupure.

Dernière colonne : le 12/11, séances une à une, après une séance témoin sans coupure (texte 0,8 s
après la parole, rien en attente vers AssemblyAI). Le « we'll, we'll » en trop de la coupure de 5 s
côté formateur est une graphie du STT, à 72 s, loin de la coupure et dans la même session ; il était
déjà là avant le recalage.

Dans les séances des quatre dernières colonnes, aucune trame n'a manqué, n'a été reçue deux fois ou
n'a été jetée.

Le retard se voit au tableau de bord. Le banc relève toutes les 2 s les médianes de la dernière
minute qu'il affiche, séances une à une, le 12/11 (deux séries ; la seconde avec la version finale) :
- sans coupure (trois séances), le texte reconnu arrive 0,8 à 1,1 s après la parole, jamais plus de 3 s ;
- après 20 s de coupure, jusqu'à 24,5 et 24,3 s (STT), 20,7 et 19,4 s (formateur), au-dessus du
  seuil d'alerte (3 s) pendant 50 à 53 s. Côté formateur, la voix arrive au serveur jusqu'à 10,7 et
  10,5 s après sa captation, au-dessus de 1 s pendant 18 s ;
- après 5 s de coupure du STT, 4,7 s au plus et au-dessus de 3 s pendant 50 s dans la première
  série ; 1,9 s, jamais au-dessus, dans la seconde. Le rattrapage d'AssemblyAI varie d'une séance à
  l'autre : la médiane ne montre pas toujours une coupure courte. Une coupure de 5 s côté formateur
  ne déplace aucune médiane (100 trames en retard sur 1 200 dans la minute) : rien ne s'affiche, et
  rien ne se perd.

**Vérifié.** 252 tests sur 252 (47 nouveaux) ; types vérifiés sans erreur. Les trois règles de la
jonction (recalage, mot relu au même endroit, instant seul sans recalage) ont chacune un test qui
échoue sans elle, dont un sur les horodatages réels du 12/11. De bout en bout, version finale :
aucun mot perdu dans les quatre coupures (tableau, dernière colonne). À la jonction, « is 45 liters… »
passe ; après 5 s de coupure du STT, « flow », que la session tombée n'avait pas rendu, aussi —
l'ancienne règle l'aurait écarté (0,58 s avant le dernier mot parti). Le tableau de bord n'a pas été
regardé dans un navigateur : les chiffres ci-dessus sont ceux qu'il lit.

**Limites.**
- Redémarrage du serveur : le nouveau processus ne connaît ni la captation ni son contexte. Jusqu'à
  2 s sont redites, et la première session démarre sans contexte. Sur la fixture : 7 mots perdus,
  dont « is 45 » et « 1500 revolutions per », comme avec une session neuve (10 avant ces changements).
- Le rattrapage d'AssemblyAI est plafonné (ci-dessus). Le réduire est à décider ; rien n'est fait.
  Les pistes : des sessions en parallèle pour l'arriéré, ou les silences compressés. Plafonner
  l'arriéré, lui, perdrait du contenu.
- Une session qui tombe avec plus de 40 s de retard emporte le plus ancien de ce qu'elle n'avait
  pas rendu. Le rejeu s'ajoute à la rafale de la réouverture, donc au rattrapage plafonné.
- À la reprise du STT, le rejeu et l'audio en attente passent d'un bloc par l'analyse de la hauteur
  de la voix (`LiveProsody`, ~5 ms par trame de 100 ms sur le poste de développement) : la boucle
  d'événements du serveur se fige, pour toutes les salles, 3,4 s dans le pire cas (40 s rejouées et
  40 s en attente, mesuré hors réseau) ; ~1,5 s estimées pour la coupure de 20 s du banc, ~0,15 s
  avant D37 (3 s rejouées). Corrigé en D39 : l'analyse passe par tranches bornées — 86 ms de
  figement au plus, mesuré sur le même pire cas. Cette analyse coûte aussi ~5 % d'un cœur par
  formateur, en continu ; cela reste.
- À la reprise du STT, l'audio rejoué attend dans notre connexion vers AssemblyAI (4,4 s et 8,9 s
  au plus, contre 0 dans la séance témoin) : l'alerte « La voix du formateur part avec … de
  retard » s'affiche, et son texte accuse la connexion du PC, à tort. Elle date d'avant D37 ; la
  reformuler pour ce cas est à décider.
- Après une longue pause, la nouvelle session reçoit les 3 dernières secondes de la pause, pas la
  parole d'avant : pas d'amorce dans la langue, comme une session neuve (voir « Langue »). Non mesuré.
- Près du dernier mot parti, un mot que la nouvelle session entend autrement (« for » pour
  « four. ») est redit : mieux vaut redire un mot que d'en perdre un. Si elle ne retrouve aucun des
  mots partis et les décale de plus de 1,5 s, le mot qui suit le dernier mot parti peut encore se
  perdre (mesuré : 1,1 s au plus).
- Un formateur réadmis pendant une longue attente d'arrêt voit son audio attendre, 40 s au plus.
- Une séance par scénario, voix de synthèse. D'une séance à l'autre, le STT soude, sépare ou écrit
  autrement des mots et des nombres : un écart de cet ordre ne se lit pas comme une perte.

## D38 — Le son que le navigateur perd se traque : variantes de captation à l'essai

Troisième correction de l'audit du 10/11/2026 (étape 1.3, défaut F-03).

**Constat.** Certains jours, le navigateur du poste formateur jette 15 à 27 % du son du micro
avant même le worklet (test 7 du 9/11 : 74 % reçus, mots manquants ou déformés) ; d'autres jours,
rien, avec le même code. La cause n'est pas établie. Les pistes de l'audit : le rééchantillonnage
imposé par le contexte à 16 kHz (le micro tourne à 48 kHz, le navigateur convertit), les
traitements (réduction de bruit, gain automatique) sous charge, l'envoi depuis le thread principal.

**Décision.** L'essai se prépare : chaque piste devient un réglage du poste formateur, et chaque
relevé de captation dit sous quelle variante il a été pris. Par défaut, rien ne change.
- Deux réglages nouveaux, à côté de l'annulation d'écho, gardés d'une séance à l'autre et
  changeables en cours de séance : « Bruit + gain auto » (navigateur / coupés) et « Conversion
  vers 16 kHz » (par le navigateur / dans la page).
- « Dans la page » : le contexte audio s'ouvre à la fréquence native du micro — le navigateur ne
  rééchantillonne plus rien — et le worklet convertit lui-même (passe-bas à 7,2 kHz, sinc fenêtré,
  phases précalculées ; position tenue en entiers). Le PCM envoyé reste du 16 kHz : serveur, D34
  et D37 inchangés.
- Chaque relevé (toutes les 5 s de son) porte la variante (`mode` de `lecturer.capture`, journal
  `capture`) : les pertes s'attribueront après coup, jour faste ou néfaste.
- L'envoi depuis un Worker (troisième piste) n'est pas construit : depuis D37, un thread principal
  bloqué retarde les trames (numérotées, 30 s de réserve, renvoyées) mais n'en perd plus, et ce
  retard se lit déjà (`uplinkP50Ms`). À revoir si l'essai montre des pertes que les deux premières
  variantes n'expliquent pas.

**Vérifié.** Le worklet est chargé tel quel dans les tests (5) : à 16 kHz, conversion directe
inchangée ; à 48 kHz, durée conservée et ton préservé (RMS à ±2 %), un ton à 11 kHz filtré au lieu
de se replier (< 5 % résiduel) ; à 44,1 kHz (rapport non entier), pareil ; et deux découpages en
blocs différents du même signal donnent les mêmes échantillons — ce dernier test a attrapé une
dérive d'un ulp de la position flottante, corrigée en passant la position en entiers. Coût mesuré :
3,65 % du temps réel à 48 kHz (poste de développement, bac à sable Node). Types vérifiés.

**Limites.**
- L'essai lui-même reste à faire, sur le poste et le micro réels : 15 minutes par variante, onglet
  caché et PC sur batterie compris ; critère de l'audit, captation ≥ 99,5 % sur 30 minutes.
  L'instrument est prêt ; la cause, elle, n'est toujours pas établie — rien ne prouve encore
  qu'une variante supprime la perte.
- Traitements coupés : le niveau d'entrée n'est plus régulé (le gain de l'administration reste),
  et sans annulation d'écho non plus, un poste unique reboucle micro et haut-parleurs (le
  garde-fou de langue reste le dernier recours).
- Les nouveaux réglages n'ont pas été regardés dans un navigateur (pas de micro ici) : types et
  tests seulement.

## D39 — Un appel lent ne bloque plus la chaîne : deux files, secours en course, analyse bornée

Quatrième correction de l'audit du 10/11/2026 (étape 1.4, défaut F-06).

**Constat.**
- Traduction et voix d'un segment vivaient dans la même promesse, en série par langue : un seul
  appel lent retardait tous les segments suivants des deux étages, et aucun secours ne partait
  avant l'échec du primaire (délais internes : 6 s traduction, 10 s voix).
- Limite relevée en D37 : à la réouverture du STT, le rejeu passait d'un bloc par l'analyse de la
  hauteur (~5 ms par trame de 100 ms) ; la boucle d'événements se figeait, pour toutes les salles,
  3,4 s dans le pire cas mesuré.

**Décision.**
- *Deux files ordonnées par langue* (`pipeline.ts`). La traduction du segment suivant part pendant
  que la voix du précédent se synthétise ; la diffusion garde l'ordre des segments (la file des
  voix est série). L'attente du tour de la voix se journalise (`chainWaitMs`, événement `segment`).
- *Secours en course* (`Hedge`, qui remplace `Breaker` en gardant ses règles : secours seul 60 s
  après une panne du primaire, retour au primaire quand il répond). Si le primaire n'a pas répondu
  après 0,6 s (traduction) ou 1 s (voix), le secours part en parallèle et la première réponse est
  retenue ; sa lenteur seule n'ouvre pas le disjoncteur. Au-delà de 2 s (traduction) ou 4 s
  (voix), l'étage abandonne : texte source affiché, ou segment sans voix signalé — mieux vaut
  borné que tard. La course gagnée se journalise (`hedge` : étage, ms) sans passer en mode dégradé.
- *Analyse de la hauteur par tranches* (`ProsodyFeed`). Au plus 500 ms d'audio analysées par tour
  de boucle, le reste au tour suivant ; le rejeu part au STT d'un bloc comme avant (~0,1 ms par
  trame), l'analyse suit en tranches (~20 fois le temps réel). Décrire un segment force l'analyse
  jusqu'à sa fin : la description ne lit jamais un trou.

**Mesuré.** Le pire cas de D37 rejoué (40 s rejouées plus 40 s en attente, hors réseau, ton voisé) :
le figement maximal de la boucle passe de 3,4 s à 86 ms (les cinq pires écarts : 86, 36, 29, 29,
27 ms, minuterie de 5 ms en sonde).

**Vérifié.** 269 tests sur 269 (17 nouveaux entre D38 et D39, 3 de `Breaker` repris par `Hedge`) ;
types vérifiés. Le recouvrement a son test (la traduction 2
commence avant la fin de la voix 1 — il échoue sur l'ancienne chaîne série), la course aussi (un
primaire muet sur un segment : le secours répond à 0,6 s, les suivants ne l'attendent pas, pas de
mode dégradé), le disjoncteur garde ses tests (adaptés de `Breaker`), et la rafale d'analyse ne
passe plus d'un bloc (test qui échoue sans les tranches).

**Limites.**
- L'« attente en chaîne p95 < 0,2 s sur une séance » de l'audit reste à lire en séance réelle :
  `chainWaitMs` est au journal, pas encore mesuré en vrai.
- À l'échéance (2 s), une traduction qui serait arrivée à 2,5 s est perdue quand le secours est en
  panne lui aussi : le texte source s'affiche. C'est le choix de l'audit.
- Sans secours configuré, rien ne change : les délais internes des fournisseurs (6 s, 10 s)
  s'appliquent — les ramener à 2 s et 4 s sans personne derrière ferait perdre des segments lents
  mais réussis.
- Le registre du secours n'est pas celui du primaire (risque noté à l'audit) : inchangé, visible
  au journal (`voice`, bascules).
- Les segments payés deux fois (course partie) restent à compter en séance (`hedge` au journal) ;
  l'audit les attend entre 1 et 5 %.
- L'alerte « La voix du formateur part avec … de retard », qui accuse à tort la connexion du PC
  après une réouverture du STT (limite D37), n'est pas retouchée ici.
- L'analyse de la hauteur coûte toujours ~5 % d'un cœur par formateur, en continu : l'alléger
  (recherche de hauteur à fréquence réduite) reste une piste, non faite.

## Ce que six semaines (au lieu de 48 h) remettent sur la table

Dans l'ordre de valeur : tests automatisés dès le départ (fait) ; multilingue réel
(ES/AR/PT — le fan-out est prévu, il manque les voix) ; transcription bilingue remise
aux apprenants (SQLite revient à ce moment-là) ; file de questions avec modération ;
vitesse TTS adaptative ; clonage de la voix du formateur (consentement écrit) ; SFU
WebRTC *si* le test de charge l'exige.

Ce qui ne revient pas : l'application native, le débruitage, le VAD maison.
