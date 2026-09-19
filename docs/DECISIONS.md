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
navigation. Le mode clair existe dans la maquette (bascule, classe `theme-light`)
mais sa palette n'est pas encore définie.

## Ce que six semaines (au lieu de 48 h) remettent sur la table

Dans l'ordre de valeur : tests automatisés dès le départ (fait) ; multilingue réel
(ES/AR/PT — le fan-out est prévu, il manque les voix) ; transcription bilingue remise
aux apprenants (SQLite revient à ce moment-là) ; file de questions avec modération ;
vitesse TTS adaptative ; clonage de la voix du formateur (consentement écrit) ; SFU
WebRTC *si* le test de charge l'exige.

Ce qui ne revient pas : l'application native, le débruitage, le VAD maison.
