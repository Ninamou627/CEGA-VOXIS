# Fixtures audio

Déposez ici les enregistrements de référence (ignorés par git).

**La fixture principale** : 10 minutes du formateur, sur du contenu réel de la formation,
avec son micro HF, à son débit naturel. C'est elle qui départage les moteurs et les
réglages — jamais l'oreille.

Format attendu : WAV, PCM 16 bits, mono, 16 kHz.

```bash
# conversion depuis n'importe quoi (ffmpeg)
ffmpeg -i formateur.m4a -ac 1 -ar 16000 -sample_fmt s16 fixtures/formateur-10min.wav

# rejeu dans le pipeline (le serveur doit tourner)
npm run replay -- fixtures/formateur-10min.wav
```

Le rejeu se comporte exactement comme la page formateur : mêmes trames de 100 ms, même
cadence temps réel, mêmes métriques dans `metrics.jsonl`.
