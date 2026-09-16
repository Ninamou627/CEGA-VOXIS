# Interprète de salle

Interprétation IA quasi simultanée EN ↔ FR pour une salle de formation : le formateur
parle dans son micro HF, les apprenants entendent une voix française dans leurs
écouteurs avec ~1,5 s de décalage, et peuvent poser une question qui arrive en anglais
dans le casque du formateur.

Les décisions d'architecture et leurs raisons sont dans [docs/DECISIONS.md](docs/DECISIONS.md).

## Démarrer en deux minutes (sans aucune clé API)

```bash
npm install
cp .env.example .env
npm run dev
```

Puis, dans cet ordre :

1. **Tableau de bord** — <http://localhost:5173/dashboard.html?token=change-me>
2. **Formateur** — <http://localhost:5173/lecturer.html?token=change-me> → *Démarrer le micro*
   (sans micro : mettez `MOCK_STT_CLOCK=timer` dans `.env`)
3. **Apprenant** — <http://localhost:5173/> → *Écouter*. Depuis un téléphone sur le même
   Wi-Fi : `http://<IP-du-PC>:5173/`

Les fournisseurs simulés (`mock`) produisent de vraies hypothèses partielles instables,
une pseudo-traduction et un vrai fichier audio jouable dont la durée correspond à celle
d'une voix. Tout le pipeline — commit verrouillé, segmentation, files, dérive, ack de
latence — est donc exercé pour de vrai, sans dépenser un centime.

## Ce qui est en place

| Brique | Fichier | État |
|---|---|---|
| Contrat d'événements (révisable vs définitif) | `shared/protocol.ts` | ✅ |
| Trame binaire audio | `shared/framing.ts` | ✅ |
| Commit verrouillé LocalAgreement-2 + règles de coupe | `server/src/pipeline/commit.ts` | ✅ testé |
| Orchestration STT → MT → TTS, série par langue, backlog | `server/src/pipeline/pipeline.ts` | ✅ |
| Fournisseurs simulés | `server/src/providers/*/mock.ts` | ✅ |
| Traduction Claude (registre interprète, glossaire, cache) | `server/src/providers/mt/anthropic.ts` | ✅ à valider avec une clé |
| STT AssemblyAI (primaire) / Deepgram (secours + questions) | `server/src/providers/stt/` | ✅ écrits, à valider avec une clé (`npm run check`) |
| TTS ElevenLabs (continuité, vitesse) / Azure (secours) | `server/src/providers/tts/` | ✅ écrits, à valider avec une clé (`npm run check`) |
| Durée MP3 exacte pour la file | `server/src/util/mp3.ts` | ✅ vérifié |
| Vitesse adaptative serveur + lecture locale (dérive) | `pipeline.ts`, `client/src/lib/player.ts` | ✅ |
| Guide certificat DNS-01 | `docs/CERTIFICAT.md` | ✅ |
| Salle, mutex de parole, fan-out | `server/src/room.ts`, `ws/handlers.ts` | ✅ |
| Métriques JSONL + bout-en-bout mesuré à l'ack | `server/src/metrics.ts` | ✅ |
| Page apprenant (2 lecteurs audio, wake lock, dérive, PTT) | `client/src/listener` | ✅ |
| Page formateur (capture navigateur, MUTE, questions) | `client/src/lecturer` | ✅ |
| Tableau de bord (QR, latences, file, journal) | `client/src/dashboard` | ✅ |
| Rejeu d'une fixture WAV dans le pipeline | `server/scripts/replay.ts` | ✅ |

## Commandes

```bash
npm run dev          # serveur (8787) + client Vite (5173)
npm test             # tests du commit verrouillé
npm run typecheck    # serveur + client
npm run build        # client → client/dist, servi ensuite par le serveur
npm start            # serveur seul, sert client/dist
npm run replay -- fixtures/formateur-10min.wav   # rejoue une fixture comme si c'était le micro
npm run check        # valide les fournisseurs du .env en 30 s (écrit fixtures/check-tts.mp3)
```

## Les deux choses à faire avant de mettre un téléphone dans la salle

1. **Un vrai certificat TLS sur l'IP du LAN.** Le micro des téléphones (questions) exige
   HTTPS, et une page HTTPS ne peut ouvrir qu'un WebSocket WSS. Domaine → enregistrement A
   vers l'IP privée du PC → Let's Encrypt par challenge DNS-01 → `TLS_CERT` / `TLS_KEY`
   dans `.env`. En développement, `VITE_HTTPS=1 npm run dev:client` donne un certificat
   auto-signé (avertissement sur le téléphone, mais ça fonctionne).
2. **Le test écran verrouillé sur un iPhone réel**, avec les deux lecteurs audio proposés
   sur la page apprenant. C'est ce test qui décide du lecteur par défaut.

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
