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

## Ce que six semaines (au lieu de 48 h) remettent sur la table

Dans l'ordre de valeur : tests automatisés dès le départ (fait) ; multilingue réel
(ES/AR/PT — le fan-out est prévu, il manque les voix) ; transcription bilingue remise
aux apprenants (SQLite revient à ce moment-là) ; file de questions avec modération ;
vitesse TTS adaptative ; clonage de la voix du formateur (consentement écrit) ; SFU
WebRTC *si* le test de charge l'exige.

Ce qui ne revient pas : l'application native, le débruitage, le VAD maison.
