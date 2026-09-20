# Du MVP au produit vendable

État au 17/09/2026 : la boucle du brief fonctionne en réel dans les deux sens, sur un
vrai téléphone, avec de vrais moteurs. Neuf des dix critères de succès du §15 sont verts ;
le dixième (tenue sur plusieurs heures) n'a pas été testé.

Ce document dit ce qui sépare ça d'un produit qu'on peut facturer, en trois horizons.
Le principe : **on vend de la fiabilité et de la qualité perçue, pas des fonctionnalités.**
Un client de formation ne compare pas des listes de features ; il se souvient de la fois où
ça a coupé, ou de la voix qui a massacré le nom de son produit.

---

## Horizon 1 — Un pilote payant (2 à 3 semaines)

Ce qu'il faut pour mettre le système devant de vrais apprenants, être payé, et ne pas
avoir honte. Rien ici n'est une fonctionnalité nouvelle : c'est de la preuve.

### Fiabilité prouvée
- [ ] **Soak test 8 h** (`npm run soak`) : fixture en boucle, un téléphone connecté, santé du
      serveur relevée chaque minute. Mémoire, file et latence identiques à la fin.
      Vérifier que la session AssemblyAI se rouvre bien au bout des 3 h.
- [ ] **Wi-Fi réel** : 20 téléphones sur la borne qui ira en salle. Le seul test qui dise
      si WebSocket suffit (D4). Borne pro, 5 GHz, pas de portail captif.
- [ ] **Double liaison Internet** du serveur (Ethernet du lieu + routeur 4G) et test de
      bascule pendant une séance.
- [ ] **Checklist d'avant-séance** (une page) : `npm run check`, certificat valide, borne,
      micro HF sur l'interface USB, casque fermé, page formateur, QR affiché.
- [ ] **Procédure de panne** (une page) : qui fait quoi si le son s'arrête, si un téléphone
      décroche, si Internet tombe. Le mode texte seul et le S2S de secours en font partie.

### Qualité perçue
- [ ] **Voix native** : plan Starter ElevenLabs (5 $/mois) et une voix française de la
      bibliothèque, choisie à l'écoute avec le formateur.
- [ ] **Interprétation** : crédits Anthropic, comparaison Opus / Haiku sur la fixture
      (`mtMs`), condensation vérifiée sur la dérive.
- [ ] **Glossaire de la formation** : `STT_KEYTERMS` + `MT_GLOSSARY`, construit avec le
      formateur. Une heure, le plus gros levier de qualité du projet.
- [ ] **Fixture réelle** de 10 minutes et réglage de la segmentation dessus
      (`ASSEMBLYAI_MODE`, `clauseWords`, `timeoutMs`). Cible : p95 < 2,5 s.
- [ ] **Continuité de voix** : WebSocket multi-contexte ElevenLabs (`new_turn`) à la
      place du request stitching — c'est ce qui enlève l'effet « liste de phrases ».

### Ce que le client emporte
- [ ] **Transcription bilingue exportable** (PDF/DOCX) en fin de journée. Quasi gratuit
      (on a déjà les deux textes), forte valeur perçue, et l'argument commercial le
      plus simple à montrer. Exige stockage, consentement et durée de conservation.

### Conformité minimale
- [ ] Rétention zéro / exclusion de l'entraînement **vérifiées par écrit** chez AssemblyAI
      (région EU déjà active), ElevenLabs, Anthropic, DeepL. Noter les tiers qui ne le
      proposent qu'en offre entreprise.
- [ ] Information des participants (une phrase à l'écran — déjà là — et une ligne dans la
      convocation), registre de traitement, durée de conservation de la transcription.
- [ ] **Certificat sur un nom de domaine** (`docs/CERTIFICAT.md`). Trente téléphones qui
      acceptent un avertissement, c'est trente occasions de perdre quelqu'un.

---

## Horizon 2 — Un produit v1 (2 à 3 mois)

Ce qui permet de le vendre plusieurs fois sans un développeur dans la salle.

### La boîte de salle
- [ ] **Appliance** : mini-PC Ubuntu + borne Wi-Fi + interface audio + routeur 4G, image
      préinstallée (systemd, redémarrage automatique, mise à jour en un geste). C'est la
      forme vendable de l'architecture « serveur local » (D2) : elle s'installe en dix
      minutes dans n'importe quelle salle.
- [ ] **Panneau d'administration** à la place du `.env` : clés, fournisseurs, voix par
      langue, glossaire par formation, session, langues diffusées. Un formateur ne
      touche pas à un fichier texte.
- [ ] **Certificat automatisé** : chaque boîte a son nom (`box-12.produit.fr`) et
      renouvelle seule son certificat (DNS-01 par API de l'hébergeur DNS).
- [ ] **Diagnostic à distance** : `/api/health` remonté vers un tableau de bord central,
      journaux consultables sans être sur place.

### Fonctionnalités que les clients demanderont dès la deuxième séance
- [ ] **Multilingue réel** : ES, PT, AR… Le fan-out existe ; il manque les voix par langue,
      les tests, et l'interface en écriture droite-à-gauche pour l'arabe.
- [ ] **Sessions multiples** : plusieurs salles, codes de session, expiration, un serveur
      pour plusieurs formations en parallèle.
- [x] **Écran de salle** : une page « sous-titres » en gros caractères pour le projecteur —
      l'accès pour les malentendants, et l'assurance pour ceux dont le téléphone est à plat.
      Fait le 21/09/2026 (`/screen`) : QR en grand avant la séance, questions en bandeau.
- [ ] **File de questions** : lever la main, le formateur choisit qui parle, voit le texte
      avant de l'entendre, peut choisir « lire » ou « afficher ». Le mutex actuel suffit à
      dix personnes, pas à quarante.
- [ ] **Profils de formation** : glossaire, prompt STT, voix, langue — sauvegardés et
      rechargés par formation. La qualité devient reproductible d'une session à l'autre.
- [ ] **Contrôles formateur en direct** : glossaire modifiable en séance
      (`UpdateConfiguration` AssemblyAI), vitesse de voix, pause.

### Hygiène d'un produit
- [ ] Tests d'intégration du pipeline (mocks) et tests navigateur (Playwright) sur les
      trois pages ; intégration continue (typecheck, tests, build) ; versions et notes.
- [ ] Remontée d'erreurs (type Sentry) et journaux structurés conservés.
- [ ] Secrets hors du `.env` en clair sur une boîte physique (coffre, ou au minimum
      permissions strictes et chiffrement du disque).
- [ ] Guides d'une page : formateur, apprenant, exploitant.

---

## Horizon 3 — Ce qui différencie (plus tard)

- **Clonage de la voix du formateur** (consentement écrit) : les apprenants entendent
  *leur* formateur parler leur langue. Effet démo considérable, trente minutes de travail,
  qualité à valider à l'oreille.
- **Mode hybride cloud** : serveur hébergé pour les formations à distance ou mixtes.
  C'est un autre produit (latence, dépendance au réseau des participants) ; la boîte de
  salle reste le différenciateur.
- **Analytique de formation** : temps de parole, questions posées, termes du glossaire
  rencontrés — un rapport de fin de session pour l'organisme de formation.
- **Intégration LMS** : la transcription et les questions versées dans la plateforme de
  formation du client.
- **Speech-to-speech** (Gemini Live Translate) comme chemin complet alternatif, à mesurer
  sur la fixture quand il sortira de preview.
- **Mode dégradé hors ligne** (STT + TTS locaux) pour les lieux sans Internet fiable.
  Coûteux ; à ne faire que si un client le paie.

---

## Le modèle économique, en ordres de grandeur

- **Coût variable** : ≈ 3 $ par heure de parole et par langue cible (mesuré). Une journée
  de formation en une langue coûte moins de 25 $ d'API.
- **Coût fixe** : plans fournisseurs (ElevenLabs Starter/Creator pour les voix et les
  droits commerciaux — vérifier la licence), nom de domaine, une boîte de salle ≈ 800 à
  1 200 € de matériel.
- **Formes de vente** possibles : prestation par journée avec la boîte et un opérateur ;
  location de la boîte au mois ; licence logicielle sur le matériel du client. Commencer
  par la prestation : c'est là qu'on apprend ce qui casse.
- **Ce qu'on vend** : « vos apprenants entendent le formateur dans leur langue, avec moins
  de deux secondes de décalage, et repartent avec la transcription ». Chaque mot de cette
  phrase doit être mesuré et tenu.

## Risques à dire au client, pas à cacher

- Dépendance à trois fournisseurs cloud (prix, conditions, disponibilité). Chaque étage a
  un secours ; aucun n'est gratuit.
- La qualité dépend du formateur : micro discipliné, glossaire fourni, débit raisonnable.
- Un accent difficile ou un vocabulaire très spécialisé dégrade la reconnaissance ;
  la fixture le dira avant la salle.
- Le Wi-Fi du lieu n'est jamais garanti : la borne dédiée fait partie du produit.
