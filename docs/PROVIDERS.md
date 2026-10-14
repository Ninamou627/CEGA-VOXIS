# Fournisseurs

Le contrat est dans `server/src/providers/types.ts`. Chaque fournisseur se branche
derrière la même interface que le simulateur, et se compare à lui sur la fixture.

**Valider une clé** : renseignez `.env`, puis

```bash
npm run check
```

Le script traduit une phrase, la synthétise (deux segments, dont un en continuité et à
vitesse 1,08), écrit `fixtures/check-tts.mp3` — **écoutez-le** — puis retranscrit
l'audio en batch. Avec un chemin de WAV en argument, il ajoute 20 s de STT streaming.

Règle commune : **rétention zéro** et exclusion de l'entraînement activées sur chaque
compte, vérifiées par écrit (RGPD, sous-traitance).

## STT — `SttProvider`

| Fournisseur | Fichier | Rôle | État |
|---|---|---|---|
| AssemblyAI Universal-3.5 Pro Realtime | `stt/assemblyai.ts` | primaire EN (défaut), batch des questions FR | **validé** (streaming + batch, région EU) |
| AssemblyAI universal-streaming (english / multilingual) | `stt/assemblyai.ts` | alternative, `ASSEMBLYAI_MODEL` | **validé** (streaming, région EU) — voir D19 |
| Deepgram Nova-3 | `stt/deepgram.ts` | secours EN | écrit, à valider avec une clé |

Latence mesurée de la fin d'un segment à son commit (D19) : U3.5 Pro ~0,4 s en fin de
phrase mais ~2 s pour une phrase longue coupée au délai ; universal-streaming-english
~0,7 s partout. `npm run check` le dit pour le modèle choisi ; le tableau de bord, en séance.

Ce que le pipeline attend : `onPartial` reçoit l'**hypothèse complète** de l'énoncé
courant (pas le delta) ; `isFinal:true` quand le fournisseur ne la révisera plus ;
`onUtteranceEnd()` sur son endpointing ; `Word.isFinal` si le fournisseur marque ses
mots définitifs (le commit verrouillé les fige sans attendre).

Différences qui comptent pour la comparaison :

- **AssemblyAI** renvoie le tour complet à chaque message, **ponctué dès les partiels**,
  avec `word_is_final` par mot. `end_of_turn:true` = finalisé et ponctué en un seul
  message. Aligné sur le document officiel « Coding Agent Instructions » (dans les
  Documents OneDrive de l'équipe).
- **Deepgram** finalise **par tranches** : chaque `is_final` couvre une fenêtre, l'intérim
  suivant repart de zéro. Le fournisseur reconstitue l'énoncé complet.

Réglages AssemblyAI (`.env`) :

- `ASSEMBLYAI_MODE` — `balanced` (défaut) / `min_latency` / `max_accuracy`. **Le** réglage
  principal, à départager sur la fixture (`metrics.jsonl` → `commitMs`).
- `ASSEMBLYAI_REGION` — `eu` (défaut, RGPD) / `us` / `edge`.
- `STT_PROMPT` — une description de la séance en anglais (« Technical training on X by an
  American trainer… »), `STT_KEYTERMS` — termes, acronymes, noms propres (≤ 100). **C'est le
  glossaire côté STT** : à remplir avec le formateur, même liste que pour la traduction.
- `ASSEMBLYAI_VOICE_FOCUS` — `near-field` pour un micro-cravate/main, si la salle est bruyante.

Deepgram : `endpointing=300`, `utterance_end_ms=1000`.

## Traduction — `MtProvider`

| Fournisseur | Fichier | Rôle | Mesuré par segment (14/10/2026, D20) |
|---|---|---|---|
| DeepL | `mt/deepl.ts` | **principal en séance** | ~0,25 s |
| Claude Haiku 4.5 | `mt/anthropic.ts` | secours | ~0,85 s |
| Claude Opus 5 | `mt/anthropic.ts` | — | ~1,7 s |

`mt/deepl.ts` : contexte des segments précédents (non traduit), glossaire de
l'administration créé une fois chez DeepL puis cité par son identifiant. `model_type`
(latence ou qualité) n'a rien changé de mesurable. Ne condense pas : la dérive se combat
par la vitesse de la voix.

`mt/anthropic.ts` : prompt d'interprète (condense, ne commente jamais), glossaire, les
deux segments précédents fournis comme tours réels, `effort: "low"`, repli serveur en
cas de refus de sécurité. Le préfixe est marqué pour le cache, mais il est sous le minimum
de 512 tokens : rien n'est servi depuis le cache (mesuré).

**Connexions** (`providers/http.ts`) : gardées 60 s, et réchauffées à l'ouverture du micro
puis après 15 s d'inactivité. Sans cela, la première requête après une pause du formateur
rouvrait une connexion : 1 à 2,5 s vers DeepL, jusqu'à 2 s vers ElevenLabs (D20).

## TTS — `TtsProvider`

| Fournisseur | Fichier | Rôle | État |
|---|---|---|---|
| ElevenLabs Turbo v2.5 | `tts/elevenlabs.ts` | primaire FR | écrit, à valider avec une clé |
| Azure Neural | `tts/azure.ts` | secours (`TTS_BACKUP=azure`) | écrit, à valider avec une clé |

`synthesize()` renvoie un MP3 complet par segment avec sa durée exacte (comptage des
trames, `util/mp3.ts`). 64 kbit/s chez ElevenLabs, 48 chez Azure : de la parole, et un
Wi-Fi de salle qu'on ménage.

**Continuité** (§08 de la revue) : ElevenLabs reçoit `previous_text` et les
`previous_request_ids` des trois segments précédents (*request stitching*), ce qui
conditionne la prosodie sur ce qui vient d'être dit. `resetContinuity()` à une vraie fin
de tour. Semaine 3 : passer au WebSocket multi-contexte (`new_turn`), même principe en
flux continu, ~100 ms de mieux au premier octet.

**Vitesse** (§09) : `speed` → `voice_settings.speed` chez ElevenLabs (0,7–1,2),
`<prosody rate>` chez Azure.

## Speech-to-speech de secours

`gemini-3.5-live-translate-preview` : entrée PCM 16 kHz mono par blocs de 100 ms, sortie
PCM 24 kHz mono, transcriptions d'entrée et de sortie disponibles. Audio uniquement.
À câbler derrière un interrupteur dans le panneau formateur, comme *autre* chemin
complet, pas comme un étage. <https://ai.google.dev/gemini-api/docs/live-api/live-translate>
