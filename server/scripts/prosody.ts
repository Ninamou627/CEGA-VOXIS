/**
 * Fidélité de la voix traduite à la voix du formateur, sur une séance enregistrée (RECORD_DIR).
 *
 *   npm run prosody -- <dossier> [dossier à comparer] [--stt] [--judge] [--json]
 *
 * Pour chaque segment, la voix du formateur (source.wav, aux instants de ses mots) et la voix
 * traduite (son fichier) sont mesurées de la même façon, puis comparées sur la séance :
 *   - débit : la voix accélère-t-elle quand le formateur accélère ? (corrélation des syllabes/s)
 *   - hauteur et énergie : une phrase animée reste-t-elle animée ? (corrélations d'étendue)
 *   - intonation : les questions montent-elles à la fin, les affirmations descendent-elles ?
 *   - pauses : les silences du formateur entre deux phrases se retrouvent-ils à l'écoute ?
 *   - durée : la voix traduite tient-elle dans le temps du formateur ? (au-dessus de 1, retard)
 * Avec --stt, la voix traduite est relue par AssemblyAI (taux d'erreur sur les mots :
 * intelligibilité). Avec --judge, Claude note chaque traduction de 1 à 5 (fidélité, fluidité).
 * Ces deux options appellent des services payants.
 *
 * Deux dossiers : les mêmes mesures côte à côte (avant / après).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MPEGDecoder } from "mpg123-decoder";
// Le .env de la racine du dépôt (clés AssemblyAI et Anthropic pour --stt et --judge).
import "../src/config";
import { AssemblyAiStt } from "../src/providers/stt/assemblyai";
import {
  analyzeFrames,
  emphasizedWords,
  pearson,
  readWav,
  spanFeatures,
  speechBounds,
  speechThreshold,
  syllables,
  wordErrorRate,
  type Frame,
  type Pcm,
  type SpanFeatures,
} from "../src/prosody";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const withStt = opt("--stt");
const withJudge = opt("--judge");
const json = opt("--json");
const dirs = args.map((d) => path.resolve(process.env.INIT_CWD ?? process.cwd(), d));
if (!dirs.length) {
  console.error("usage : prosody <dossier d'enregistrement> [dossier à comparer] [--stt] [--judge] [--json]");
  process.exit(1);
}

interface Src {
  seq: number;
  text: string;
  turnStart: boolean;
  startMs: number | null;
  endMs: number | null;
  words: { text: string; startMs: number; endMs: number }[];
}
interface Tgt {
  seq: number;
  lang: string;
  text: string;
  file: string;
  durMs: number;
}

async function decode(file: string): Promise<Pcm> {
  const buf = new Uint8Array(readFileSync(file));
  if (file.endsWith(".wav")) return readWav(buf);
  const d = new MPEGDecoder();
  await d.ready;
  const r = d.decode(buf);
  d.free();
  return { samples: r.channelData[0], sampleRate: r.sampleRate };
}

interface SegmentResult {
  seq: number;
  src: SpanFeatures;
  tgt: SpanFeatures;
  srcRate: number;
  tgtRate: number;
  question: boolean;
  /** Silence du formateur avant le segment suivant, et celui entendu sur le téléphone. */
  srcGapMs: number | null;
  playedGapMs: number | null;
  emphasized: number;
  srcText: string;
  tgtText: string;
  tgtFile: string;
}

async function measure(dir: string) {
  const lines = readFileSync(path.join(dir, "segments.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const srcs = new Map<number, Src>(lines.filter((l) => l.kind === "src").map((l) => [l.seq, l]));
  const tgts = new Map<number, Tgt>();
  for (const l of lines) if (l.kind === "tgt" && !tgts.has(l.seq)) tgts.set(l.seq, l); // première langue cible
  const plays = new Map<number, number>(lines.filter((l) => l.kind === "play").map((l) => [l.seq, l.atMs]));

  const source = await decode(path.join(dir, "source.wav"));
  const frames = analyzeFrames(source);
  const thr = speechThreshold(frames);

  const seqs = [...srcs.keys()].filter((s) => tgts.has(s) && srcs.get(s)!.startMs != null).sort((a, b) => a - b);
  const results: SegmentResult[] = [];
  let words = 0;
  let emphasizedTotal = 0;
  for (let i = 0; i < seqs.length; i++) {
    const s = srcs.get(seqs[i])!;
    const t = tgts.get(seqs[i])!;
    const tgtFile = path.join(dir, t.file);
    if (!existsSync(tgtFile)) continue;
    const src = spanFeatures(frames, s.startMs!, s.endMs!, thr);
    const tf: Frame[] = analyzeFrames(await decode(tgtFile));
    const tthr = speechThreshold(tf);
    const [a, b] = speechBounds(tf, tthr);
    const tgt = spanFeatures(tf, a, b, tthr);
    const emph = emphasizedWords(frames, s.words, thr).filter(Boolean).length;
    words += s.words.length;
    emphasizedTotal += emph;

    const next = srcs.get(seqs[i + 1]);
    const srcGapMs = next?.startMs != null && s.endMs != null ? next.startMs - s.endMs : null;
    const play = plays.get(s.seq);
    const nextPlay = next ? plays.get(next.seq) : undefined;
    const playedGapMs = play != null && nextPlay != null ? Math.max(0, nextPlay - (play + t.durMs)) : null;
    results.push({
      seq: s.seq,
      src,
      tgt,
      srcRate: syllables(s.text, "en") / Math.max(0.3, src.speechMs / 1000),
      tgtRate: syllables(t.text, t.lang) / Math.max(0.3, tgt.speechMs / 1000),
      question: /\?\s*$/.test(s.text),
      srcGapMs,
      playedGapMs,
      emphasized: emph,
      srcText: s.text,
      tgtText: t.text,
      tgtFile,
    });
  }

  const pairs = (f: (r: SegmentResult) => [number | null, number | null]) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of results) {
      const [x, y] = f(r);
      if (x != null && y != null) {
        xs.push(x);
        ys.push(y);
      }
    }
    return pearson(xs, ys);
  };
  const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
  const share = (rs: SegmentResult[], ok: (r: SegmentResult) => boolean) => (rs.length ? rs.filter(ok).length / rs.length : null);

  const questions = results.filter((r) => r.question && r.src.finalMoveSt != null && r.tgt.finalMoveSt != null);
  const statements = results.filter((r) => /[.!]\s*$/.test(r.srcText) && r.tgt.finalMoveSt != null);
  const pauses = results.filter((r) => r.srcGapMs != null && r.srcGapMs >= 500 && r.playedGapMs != null);

  const summary = {
    dir,
    segments: results.length,
    rateCorr: pairs((r) => [r.srcRate, r.tgtRate]),
    pitchRangeCorr: pairs((r) => [r.src.f0RangeSt, r.tgt.f0RangeSt]),
    energyRangeCorr: pairs((r) => [r.src.energyRangeDb, r.tgt.energyRangeDb]),
    internalPausesCorr: pairs((r) => [r.src.pauses.length, r.tgt.pauses.length]),
    durationRatio: median(results.map((r) => r.tgt.durMs / Math.max(1, r.src.durMs))),
    questions: questions.length,
    questionsRising: share(questions, (r) => r.tgt.finalMoveSt! > 1),
    questionsRisingSource: share(questions, (r) => r.src.finalMoveSt! > 1),
    statementsFalling: share(statements, (r) => r.tgt.finalMoveSt! < -1),
    sourcePauses: pauses.length,
    pausesKept: share(pauses, (r) => r.playedGapMs! >= 200),
    emphasizedShare: words ? emphasizedTotal / words : null,
    wer: null as number | null,
    adequacy: null as number | null,
    fluency: null as number | null,
  };

  if (withStt) summary.wer = await intelligibility(results);
  if (withJudge) Object.assign(summary, await judge(results));
  return summary;
}

/** La voix traduite relue par AssemblyAI : ce qu'un auditeur en comprend. */
async function intelligibility(results: SegmentResult[]): Promise<number | null> {
  if (!process.env.ASSEMBLYAI_API_KEY) throw new Error("ASSEMBLYAI_API_KEY manquant pour --stt");
  const stt = new AssemblyAiStt({ apiKey: process.env.ASSEMBLYAI_API_KEY });
  const wers: number[] = [];
  for (const r of results) {
    const mime = r.tgtFile.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
    const heard = await stt.transcribeOnce(new Uint8Array(readFileSync(r.tgtFile)), mime, "fr");
    wers.push(wordErrorRate(r.tgtText, heard));
  }
  return wers.length ? wers.reduce((a, b) => a + b, 0) / wers.length : null;
}

/** Claude note chaque traduction, avec les deux segments précédents pour contexte. */
async function judge(results: SegmentResult[]): Promise<{ adequacy: number | null; fluency: number | null }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY manquant pour --judge");
  const client = new Anthropic();
  const model = process.env.JUDGE_MODEL ?? "claude-opus-5";
  const a: number[] = [];
  const f: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const ctx = results.slice(Math.max(0, i - 2), i).map((r) => `EN: ${r.srcText}\nFR: ${r.tgtText}`).join("\n");
    const msg = await client.messages.create({
      model,
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content:
            `Interprétation simultanée anglais → français d'un cours, segment par segment.\n` +
            (ctx ? `Segments précédents :\n${ctx}\n\n` : "") +
            `Segment à noter :\nEN: ${results[i].srcText}\nFR: ${results[i].tgtText}\n\n` +
            `Note de 1 à 5 la fidélité (le sens est-il rendu, sans ajout ni oubli ?) et la fluidité (un francophone le dirait-il ainsi ?). ` +
            `Réponds uniquement par deux chiffres séparés par un espace, fidélité puis fluidité.`,
        },
      ],
    });
    const text = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const m = /([1-5])\D+([1-5])/.exec(text);
    if (m) {
      a.push(Number(m[1]));
      f.push(Number(m[2]));
    }
  }
  const mean = (v: number[]) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : null);
  return { adequacy: mean(a), fluency: mean(f) };
}

const summaries: Awaited<ReturnType<typeof measure>>[] = [];
for (const d of dirs) summaries.push(await measure(d));
if (json) {
  console.log(JSON.stringify(summaries, null, 1));
  process.exit(0);
}

const r2 = (v: number | null) => (v == null ? "—" : v.toFixed(2).replace(".", ","));
const p = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const rows: [string, (s: (typeof summaries)[number]) => string][] = [
  ["Segments comparés", (s) => String(s.segments)],
  ["Débit suit le formateur (r)", (s) => r2(s.rateCorr)],
  ["Hauteur animée suit (r)", (s) => r2(s.pitchRangeCorr)],
  ["Énergie suit (r)", (s) => r2(s.energyRangeCorr)],
  ["Pauses internes suivent (r)", (s) => r2(s.internalPausesCorr)],
  ["Durée voix / formateur (méd.)", (s) => r2(s.durationRatio)],
  ["Questions qui montent (voix)", (s) => `${p(s.questionsRising)} sur ${s.questions}`],
  ["  … chez le formateur", (s) => p(s.questionsRisingSource)],
  ["Affirmations qui descendent", (s) => p(s.statementsFalling)],
  ["Pauses ≥ 0,5 s gardées", (s) => `${p(s.pausesKept)} sur ${s.sourcePauses}`],
  ["Mots mis en relief (formateur)", (s) => p(s.emphasizedShare)],
  ["Erreurs de relecture (WER)", (s) => p(s.wer)],
  ["Fidélité / fluidité (1-5)", (s) => `${r2(s.adequacy)} / ${r2(s.fluency)}`],
];
console.log("");
for (const s of summaries) console.log(`${String.fromCharCode(65 + summaries.indexOf(s))} : ${s.dir}`);
console.log(`\n${"".padEnd(32)}${summaries.map((_, i) => String.fromCharCode(65 + i).padStart(14)).join("")}`);
for (const [label, f] of rows) console.log(`${label.padEnd(32)}${summaries.map((s) => f(s).padStart(14)).join("")}`);
console.log("\nr : corrélation segment par segment (1 = suit parfaitement, 0 = indépendant).");
