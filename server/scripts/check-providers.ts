/**
 * Valide les fournisseurs configurés dans .env en une trentaine de secondes,
 * sans lancer le serveur ni la salle :
 *
 *   npm run check                       # traduction, synthèse (+ continuité), transcription batch
 *   npm run check -- fixtures/x.wav     # + STT streaming sur 20 s de la fixture
 *
 * Le MP3 produit est écrit dans fixtures/check-tts.mp3 : écoutez-le, c'est le
 * premier test de la voix. La durée annoncée (durMs) doit correspondre à l'écoute.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config";
import { makeProviders } from "../src/providers";

const cfg = loadConfig();
const p = makeProviders(cfg, {
  onFallback: (stage, e) => console.warn(`  ⚠ ${stage.toUpperCase()} primaire en échec, secours utilisé :`, e.message.slice(0, 160)),
  onRecover: (stage) => console.info(`  ↩ ${stage.toUpperCase()} primaire rétabli`),
});
const lang = cfg.TARGET_LANGS[0];
const root = process.env.INIT_CWD ?? process.cwd();
const ok = (s: string) => console.log("  ✓", s);
const ko = (s: string) => console.log("  ✗", s);
const ms = (t: number) => `${Date.now() - t} ms`;
let failures = 0;

/** Une étape qui échoue affiche son motif et n'empêche pas les suivantes. */
async function step<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    failures++;
    const err = e as Error & { error?: { error?: { message?: string } } };
    ko(err.error?.error?.message ?? err.message);
    return undefined;
  }
}

console.log(`Fournisseurs : STT ${p.stt.name} · MT ${p.mt.name} · TTS ${p.tts.name}\n`);

// 1. Traduction
console.log("1. Traduction");
let t = Date.now();
const fr =
  (await step(async () => {
    const out = await p.mt.translate({
      text: "Today we're going to discuss how the pipeline handles partial transcripts, and, you know, why that matters for latency.",
      from: cfg.SRC_LANG,
      to: lang,
      context: [],
    });
    ok(`${ms(t)} → « ${out} »`);
    return out;
  })) ?? "";

// 2. Synthèse, puis un second segment en continuité.
// Si la traduction est simulée, on ne fait pas lire son franglais à une vraie voix.
console.log("\n2. Synthèse vocale");
const sample: Record<string, string> = {
  fr: "Aujourd'hui, nous allons voir comment le système gère les transcriptions partielles, et pourquoi c'est important pour la latence.",
  en: "Today we're going to look at how the system handles partial transcripts, and why that matters for latency.",
};
const ttsText = p.mt.name.startsWith("mock") || !fr ? (sample[lang] ?? fr) : fr;
t = Date.now();
const a = await step(async () => {
  const r = await p.tts.synthesize({ text: ttsText, lang });
  ok(`${ms(t)} · ${r.mime} · ${r.audio.byteLength} octets · durée annoncée ${r.durMs} ms`);
  return r;
});
if (a) {
  t = Date.now();
  await step(async () => {
    const b = await p.tts.synthesize({ text: lang === "fr" ? "Et voici la suite, pour vérifier que l'enchaînement reste naturel." : "And here is the next part.", lang, continuation: true, speed: 1.08 });
    ok(`${ms(t)} · continuité + vitesse 1,08 · ${b.durMs} ms`);
  });
  const ext = a.mime === "audio/wav" ? "wav" : "mp3";
  const out = path.resolve(root, `fixtures/check-tts.${ext}`);
  writeFileSync(out, a.audio);
  ok(`écrit ${out} — écoutez-le`);

  // 3. Transcription batch de ce qu'on vient de synthétiser (aller-retour)
  console.log("\n3. Transcription batch (questions)");
  t = Date.now();
  await step(async () => {
    const text = await p.stt.transcribeOnce(a.audio, a.mime, lang);
    ok(`${ms(t)} → « ${text} »`);
  });
}

// 4. STT streaming. Sur la fixture WAV fournie, ou — si le TTS est ElevenLabs — sur une
//    phrase anglaise qu'on synthétise en PCM 16 kHz : un aller-retour voix → STT complet,
//    sans rien enregistrer. Le fichier reste dans fixtures/ comme petite fixture EN.
const wavArg = process.argv[2];
let wavPath = wavArg ? (path.isAbsolute(wavArg) ? wavArg : path.resolve(root, wavArg)) : undefined;
const EN_SENTENCE = "Today we're going to discuss how the pipeline handles partial transcripts, and why that matters for latency. The key idea is simple.";
if (!wavPath && p.tts.name.startsWith("elevenlabs") && p.stt.name !== "mock-stt" && cfg.ELEVENLABS_API_KEY) {
  console.log("\n4a. Fixture anglaise synthétisée (PCM 16 kHz)");
  const voice = cfg.ELEVENLABS_VOICE_ID_EN ?? cfg.ELEVENLABS_VOICE_ID ?? "";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": cfg.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: EN_SENTENCE, model_id: cfg.ELEVENLABS_MODEL, language_code: "en" }),
  });
  if (!r.ok) {
    console.warn(`  ⚠ ElevenLabs ${r.status} : ${(await r.text()).slice(0, 200)} — étape 4 sautée`);
  } else {
    const pcm = new Uint8Array(await r.arrayBuffer());
    const { wavHeader } = await import("../src/providers/tts/mock");
    const header = wavHeader(pcm.byteLength / 2, 16000);
    const wav = new Uint8Array(header.length + pcm.byteLength);
    wav.set(header, 0);
    wav.set(pcm, header.length);
    wavPath = path.resolve(root, "fixtures/check-en-16k.wav");
    writeFileSync(wavPath, wav);
    ok(`${(pcm.byteLength / 32000).toFixed(1)} s → ${wavPath}`);
  }
}
/** Streame un WAV 16 bits mono dans le STT et renvoie le nombre de partiels reçus. */
async function streamWav(wav: Buffer, quiet = false): Promise<{ partials: number; firstAt: number; maxWords: number; discards: number }> {
  const sampleRate = wav.readUInt32LE(24);
  const data = wav.subarray(44, 44 + sampleRate * 2 * 20);
  let partials = 0;
  let firstAt = 0;
  let maxWords = 0;
  let discards = 0;
  const t0 = Date.now();
  const stream = await p.stt.start(
    { lang: cfg.SRC_LANG, sampleRate },
    {
      onPartial: (r) => {
        partials++;
        maxWords = Math.max(maxWords, r.words.length);
        if (!firstAt) firstAt = Date.now() - t0;
        const txt = r.words.map((w) => w.text).join(" ");
        if (!quiet) console.log(`  ${r.isFinal ? "FINAL " : "partiel"} ${txt.slice(-90)}`);
        else console.log(`  · transmis avant verdict (${r.words.length} mot(s)) : ${txt.slice(-90)}`);
      },
      onUtteranceEnd: () => {
        if (!quiet) console.log("  — fin d'énoncé");
      },
      onDiscard: () => {
        discards++;
        if (quiet) console.log("  ↩ tour écarté (autre langue)");
      },
      onError: (e) => console.error("  ✗", e.message),
    },
  );
  const frame = (sampleRate * 2) / 10;
  for (let pos = 0; pos < data.length; pos += frame) {
    stream.sendAudio(data.subarray(pos, pos + frame));
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await stream.close();
  return { partials, firstAt, maxWords, discards };
}

async function synthesizeWav16k(text: string, lang: string): Promise<Buffer | undefined> {
  const voice = (lang === "en" ? cfg.ELEVENLABS_VOICE_ID_EN : undefined) ?? cfg.ELEVENLABS_VOICE_ID ?? "";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": cfg.ELEVENLABS_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.ELEVENLABS_MODEL, language_code: lang }),
  });
  if (!r.ok) {
    console.warn(`  ⚠ ElevenLabs ${r.status} : ${(await r.text()).slice(0, 200)}`);
    return undefined;
  }
  const pcm = new Uint8Array(await r.arrayBuffer());
  const { wavHeader } = await import("../src/providers/tts/mock");
  const header = wavHeader(pcm.byteLength / 2, 16000);
  const wav = Buffer.alloc(header.length + pcm.byteLength);
  wav.set(header, 0);
  wav.set(pcm, header.length);
  return wav;
}

if (wavPath) {
  console.log("\n4. STT streaming");
  console.log(`  attendu : « ${wavArg ? "(contenu de la fixture)" : EN_SENTENCE} »`);
  await step(async () => {
    const { partials, firstAt } = await streamWav(readFileSync(wavPath!));
    ok(`${partials} partiels, premier après ${firstAt} ms`);
  });
}

// 4b. Garde-fou de langue : du français streamé au STT doit être ignoré (anti-boucle).
if (!wavArg && p.stt.name.startsWith("assemblyai") && cfg.ASSEMBLYAI_LANGUAGE_GATE && cfg.ELEVENLABS_API_KEY && lang !== cfg.SRC_LANG) {
  console.log("\n4b. Garde-fou de langue (du français dans un STT anglais)");
  await step(async () => {
    const wav = await synthesizeWav16k("Bonjour à tous, aujourd'hui nous allons parler de la latence et de la dérive.", lang);
    if (!wav) return;
    const { maxWords, discards } = await streamWav(wav, true);
    // Un partiel d'un ou deux mots peut passer avant que l'heuristique tranche ; le
    // commit verrouillé n'en fait rien. Au-delà, ou sans aucun écartement, c'est un échec.
    if (discards > 0 && maxWords < 3) ok(`français écarté (${discards} écartement(s), au plus ${maxWords} mot(s) transmis avant verdict)`);
    else throw new Error(`garde-fou insuffisant : ${discards} écartement(s), ${maxWords} mot(s) transmis`);
  });
}

console.log(failures ? `\nTerminé avec ${failures} échec(s).` : "\nTerminé, tout est passé.");
process.exit(failures ? 1 : 0);
