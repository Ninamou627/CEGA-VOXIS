/**
 * Rejoue le découpage (CommitGate) sur ce que le STT a réellement envoyé pendant une séance
 * enregistrée, et vérifie, tour par tour, qu'aucun mot du texte définitif ne s'est perdu ni
 * n'est parti deux fois (D36).
 *
 *   npm run gate -- data/enregistrements/<séance> [--json]
 *
 * Lit `stt.jsonl` (écrit par l'enregistreur, RECORD_DIR). Hors ligne : ni clé, ni réseau, ni
 * coût. Les retenues du pipeline (D32, D33) ne sont pas rejouées : elles réunissent des
 * segments, elles ne changent pas les mots. Code de sortie 1 si un mot est perdu ou doublé.
 *
 * Ce que le rapport distingue, pour chaque tour qui a reçu son texte définitif :
 *   - perdu        : dans le texte définitif, jamais parti alors qu'il pouvait partir — le
 *                    défaut que D36 corrige ;
 *   - doublé       : parti deux fois de suite alors que le texte définitif ne le dit qu'une fois ;
 *   - ajouté après coup : le STT l'a glissé en amont de mots déjà figés. Il n'est pas dit : ce
 *                    qui est figé ne se réécrit pas. Ce n'est pas le défaut de D36, mais c'est
 *                    un mot que la salle n'entend pas, et il se compte ici ;
 *   - déjà dit     : dans le texte définitif, mais parti au tour précédent (reprise du STT, D22) ;
 *   - contexte rejoué : dans le texte définitif d'une session rouverte, à l'endroit de l'audio
 *                    d'un mot que la session précédente avait fait partir (D37) ;
 *   - contredit    : figé avant que le STT ne change d'avis (remplacé ou retiré au texte
 *                    définitif) : le prix d'un mot dit tôt.
 *
 * Les mots sont rendus au découpage tels que le pipeline les a reçus : datés dans leur flux, et
 * l'heure réelle remplacée par la position dans l'enregistrement, qui suit l'audio d'un flux à
 * l'autre — de quoi rejouer aussi ce qu'un flux rouvert ne redit pas du contexte rejoué (D37).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CommitGate, DEFAULT_COMMIT, normalize, type Segment } from "../src/pipeline/commit";
import type { Word } from "../src/providers/types";

interface Line {
  kind: "partial" | "final" | "end" | "discard" | "stream";
  stream: number;
  atMs: number;
  words: Word[];
  /** Ligne `stream` (D37) : position du début du flux dans l'enregistrement, et contexte rejoué. */
  offsetMs?: number;
  warmupMs?: number;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage : gate <dossier d'enregistrement | stt.jsonl> [--json]");
  process.exit(1);
}
const base = path.resolve(process.env.INIT_CWD ?? process.cwd(), target);
const file = existsSync(base) && statSync(base).isDirectory() ? path.join(base, "stt.jsonl") : base;
if (!existsSync(file)) {
  console.error(`${file} introuvable : seules les séances enregistrées depuis D36 (RECORD_DIR) gardent ce que le STT envoie.`);
  process.exit(1);
}

const lines: Line[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Line;
    } catch {
      return undefined;
    }
  })
  .filter((l): l is Line => Boolean(l && (Array.isArray(l.words) || l.kind === "stream")))
  .map((l) => (l.kind === "stream" ? { ...l, words: [] } : l));
if (!lines.length) {
  console.error(`aucun message du STT dans ${file}`);
  process.exit(1);
}

type Op = { op: "same" | "replaced"; ref: number; got: number } | { op: "missing"; ref: number } | { op: "extra"; got: number };

/** Alignement de deux suites de mots (distance d'édition), du premier au dernier. */
function align(ref: string[], got: string[]): Op[] {
  const m = ref.length;
  const n = got.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j - 1] + (ref[i - 1] === got[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
  }
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === got[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === got[j - 1] ? "same" : "replaced", ref: --i, got: --j });
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: "missing", ref: --i });
    } else {
      ops.push({ op: "extra", got: --j });
    }
  }
  return ops.reverse();
}

/** Mots partis gardés en mémoire d'un tour au suivant : de quoi reconnaître une reprise du STT (D22). */
const RECENT = 12;
const SHOWN = 20;

// Le fournisseur marque-t-il ses mots définitifs en cours de tour ? Alors pas d'accord de deux hypothèses.
const agreement = !lines.some((l) => l.kind === "partial" && l.words.some((w) => w.isFinal));
let now = 0;
/** Début du flux courant dans l'enregistrement : les mots sont rendus datés dans leur flux. */
let offset = 0;
const gate = new CommitGate({ ...DEFAULT_COMMIT, agreement }, () => now, { spokenAt: (ms) => ms + offset });
const inStream = (words: Word[]): Word[] =>
  words.map((w) => (w.startMs != null && w.endMs != null ? { ...w, startMs: w.startMs - offset, endMs: w.endMs - offset } : w));

interface Turn {
  atMs: number;
  /** Chaque message du tour (hypothèses, puis texte définitif), sous sa forme comparée. */
  messages: string[][];
  final?: Word[];
  /** Mots partis en segment pendant le tour, dans l'ordre. */
  sent: Word[];
  /** Rang du message qui a fait figer chaque mot parti ou en attente, dans le même ordre que `sent`. */
  frozenAt: number[];
}
const newTurn = (atMs: number): Turn => ({ atMs, messages: [], sent: [], frozenAt: [] });

const totals = {
  turns: 0,
  withFinal: 0,
  discarded: 0,
  finalWords: 0,
  sentWords: 0,
  lost: 0,
  doubled: 0,
  tooLate: 0,
  alreadySaid: 0,
  replayed: 0,
  replaced: 0,
  withdrawn: 0,
};
const findings: { atMs: number; kind: "perdu" | "doublé" | "ajouté après coup"; word: string; final: string; sent: string }[] = [];
let recent: string[] = [];
let cur = newTurn(lines[0].atMs);
let stream = lines[0].stream;
/** Le flux courant a reçu en tête les dernières secondes du précédent (D37). */
let replayedStream = false;
/** Où, dans l'enregistrement, sont les mots partis des flux précédents (D37). */
let saidBefore: { start: number; end: number }[] = [];
let saidNow: { start: number; end: number }[] = [];

/** Les segments qui sortent du découpage, et l'instant où chacun de leurs mots a été figé. */
const take = (segs: Segment[]) => {
  for (const s of segs) {
    cur.sent.push(...s.words);
    for (const w of s.words) if (w.startMs != null && w.endMs != null) saidNow.push({ start: w.startMs + offset, end: w.endMs + offset });
  }
  const frozen = cur.sent.length + gate.pendingCount;
  while (cur.frozenAt.length < frozen) cur.frozenAt.push(cur.messages.length - 1);
};

/** Ce mot du texte définitif tombe-t-il sur l'audio d'un mot parti d'un flux précédent ? */
const replayedWord = (w: Word): boolean => {
  if (!replayedStream || w.startMs == null || w.endMs == null) return false;
  const mid = (w.startMs + w.endMs) / 2;
  return saidBefore.some((s) => s.start - 100 <= mid && mid <= s.end + 100);
};

function close(discarded: boolean) {
  totals.turns++;
  totals.sentWords += cur.sent.length;
  const sent = cur.sent.map((w) => normalize(w.text));
  if (discarded) totals.discarded++;
  else if (cur.final) {
    totals.withFinal++;
    totals.finalWords += cur.final.length;
    const final = cur.final;
    const ref = final.map((w) => normalize(w.text));
    const text = { final: final.map((w) => w.text).join(" "), sent: cur.sent.map((w) => w.text).join(" ") };
    const ops = align(ref, sent);
    ops.forEach((o, k) => {
      if (o.op === "replaced") totals.replaced++;
      else if (o.op === "missing") {
        const w = ref[o.ref];
        // Premier message où le mot apparaît à sa place (à côté de son voisin du texte définitif).
        const beside = (keys: string[]) => keys.some((key, i) => key === w && (keys[i + 1] === ref[o.ref + 1] || (o.ref > 0 && keys[i - 1] === ref[o.ref - 1])));
        let seen = cur.messages.findIndex(beside);
        if (seen < 0) seen = cur.messages.findIndex((keys) => keys.includes(w));
        // Le mot parti qui le suit était-il déjà figé quand le STT l'a ajouté ?
        const after = ops.slice(k + 1).find((x): x is Extract<Op, { got: number; ref: number }> => x.op === "same" || x.op === "replaced");
        if (after && seen >= 0 && cur.frozenAt[after.got] < seen) {
          totals.tooLate++;
          findings.push({ atMs: cur.atMs, kind: "ajouté après coup", word: final[o.ref].text, ...text });
        } else if (replayedWord(final[o.ref])) totals.replayed++;
        else if (recent.includes(w)) totals.alreadySaid++;
        else {
          totals.lost++;
          findings.push({ atMs: cur.atMs, kind: "perdu", word: final[o.ref].text, ...text });
        }
      } else if (o.op === "extra") totals.withdrawn++;
    });
    // Un mot dit deux fois de suite plus souvent que dans le texte définitif. Compté à part de
    // l'alignement, qui peut préférer y voir deux mots remplacés.
    const twice = (a: string[]) => {
      const n = new Map<string, number>();
      for (let i = 1; i < a.length; i++) if (a[i] === a[i - 1]) n.set(a[i], (n.get(a[i]) ?? 0) + 1);
      return n;
    };
    const inFinal = twice(ref);
    for (const [w, n] of twice(sent)) {
      const more = n - (inFinal.get(w) ?? 0);
      if (more <= 0) continue;
      totals.doubled += more;
      findings.push({ atMs: cur.atMs, kind: "doublé", word: w, ...text });
    }
  }
  recent = [...recent, ...sent].slice(-RECENT);
}

for (const l of lines) {
  now = l.atMs;
  if (l.kind === "stream") {
    // Un flux s'ouvre (enregistré depuis D37). L'ancien est tombé en plein tour : comme le
    // pipeline, on fait partir ce qui restait, puis le nouveau reçoit ou non le contexte rejoué.
    if (cur.messages.length) {
      take(gate.onUtteranceEnd());
      close(false);
      cur = newTurn(l.atMs);
    }
    replayedStream = (l.warmupMs ?? 0) > 0;
    gate.newStream(replayedStream);
    saidBefore = replayedStream ? [...saidBefore, ...saidNow].slice(-200) : [];
    saidNow = [];
    stream = l.stream;
    offset = l.offsetMs ?? 0;
    continue;
  }
  if (l.stream !== stream) {
    // Enregistrement d'avant D37 : pas de ligne de flux, pas de contexte rejoué.
    gate.newStream();
    stream = l.stream;
  }
  if (!cur.messages.length) cur.atMs = l.atMs;
  take(gate.tick());
  if (l.kind === "partial") {
    cur.messages.push(l.words.map((w) => normalize(w.text)));
    take(gate.onPartial(inStream(l.words)).segments);
  } else if (l.kind === "final") {
    cur.messages.push(l.words.map((w) => normalize(w.text)));
    cur.final = l.words;
    take(gate.onFinal(inStream(l.words)));
  } else {
    if (l.kind === "end") take(gate.onUtteranceEnd());
    else gate.discard();
    close(l.kind === "discard");
    cur = newTurn(l.atMs);
  }
}
// Enregistrement arrêté en plein tour : ce qui était figé part, comme à l'arrêt du micro.
if (cur.messages.length) {
  take(gate.onUtteranceEnd());
  close(false);
}

const revisions = gate.takeRevisions();
const failed = totals.lost > 0 || totals.doubled > 0;

if (json) {
  console.log(JSON.stringify({ file, messages: lines.length, agreement, ...totals, revisions, findings }, null, 1));
} else {
  const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
  const row = (label: string, n: number) => console.log(`  ${label.padEnd(58)}${String(n).padStart(5)}`);
  console.log(`\n${file}`);
  console.log(
    `${lines.length} messages du STT, ${totals.turns} tours (${totals.withFinal} avec leur texte définitif, ${totals.discarded} écartés) — ` +
      (agreement ? "mots figés par l'accord de deux hypothèses" : "mots définitifs marqués par le fournisseur"),
  );
  console.log(`\nMots des textes définitifs : ${totals.finalWords} · mots partis : ${totals.sentWords}`);
  row("perdus par le découpage (le mot pouvait partir)", totals.lost);
  row("doublés (partis deux fois de suite)", totals.doubled);
  row("ajoutés après coup par le STT, en amont de mots figés", totals.tooLate);
  row("déjà dits au tour précédent, non redits (D22)", totals.alreadySaid);
  row("déjà dits par la session d'avant, contexte rejoué (D37)", totals.replayed);
  row("figés puis remplacés par le STT", totals.replaced);
  row("figés puis retirés par le STT", totals.withdrawn);
  console.log(
    `\nRévisions réalignées par le découpage : ${revisions.shifts} décalage(s) de rang, ${revisions.shiftedWords} mot(s) — ` +
      "autant d'endroits où un repérage par le rang aurait perdu ou doublé un mot.",
  );
  for (const f of findings.slice(0, SHOWN)) {
    console.log(`\n  ${clock(f.atMs)} — ${f.kind} : « ${f.word} »`);
    console.log(`    texte définitif : ${f.final}`);
    console.log(`    parti           : ${f.sent}`);
  }
  if (findings.length > SHOWN) console.log(`\n  … et ${findings.length - SHOWN} autre(s) (--json pour tout voir)`);
  console.log(failed ? "\nÉCHEC : le découpage a perdu ou doublé des mots." : "\nAucun mot perdu ni doublé par le découpage.");
}
process.exit(failed ? 1 : 0);
