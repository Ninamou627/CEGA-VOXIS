/**
 * Rapport de latence d'une séance, réelle ou rejouée, à partir de son journal.
 *
 *   npm run report -- [metrics.jsonl] [--from 15:58] [--to 16:15] [--json]
 *
 * Décompose le délai entre la parole du formateur et le premier son sur un téléphone, au début
 * d'une prise de parole et en parole continue ; dit s'il grandit au fil de la séance, et si la
 * mesure est exploitable (retard du STT, serveur bloqué, audio en attente d'envoi, pannes).
 * `--from` / `--to` : heure locale du jour de la séance, ou date ISO.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { analyze, type LogEvent, type Quantiles, type StageKey } from "../src/latency-report";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const json = args.includes("--json");
if (json) args.splice(args.indexOf("--json"), 1);
const fromArg = flag("--from");
const toArg = flag("--to");
const file = args[0] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), args[0]) : path.resolve("metrics.jsonl");

const events: LogEvent[] = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as LogEvent;
    } catch {
      return undefined;
    }
  })
  .filter((e): e is LogEvent => Boolean(e && typeof e.t === "number"));
if (!events.length) {
  console.error(`aucun événement dans ${file}`);
  process.exit(1);
}

/** « 15:58 » : ce jour-là (celui du dernier événement du journal), heure locale. */
function when(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (hm) {
    const d = new Date(events[events.length - 1].t);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d.getTime();
  }
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) throw new Error(`heure illisible : ${v}`);
  return t;
}

const r = analyze(events, when(fromArg, -Infinity), when(toArg, Infinity));
if (json) {
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
}

const s = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1).replace(".", ",")} s`);
const hhmm = (t: number) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const cell = (q: Quantiles) => `${s(q.p50).padStart(8)} ${s(q.p95).padStart(8)}`;

const LABEL: Record<StageKey, string> = {
  speech: "Le formateur dit le segment",
  reco: "Reconnaissance (fin → figé)",
  chain: "Attente derrière le précédent",
  mt: "Traduction",
  tts: "Voix",
  wait: "Envoi et file du téléphone",
  total: "= Début de parole → son",
  end: "  Fin de phrase → son (D19)",
  sttLag: "  Retard du texte du STT",
};

console.log(`\n${file}`);
console.log(
  `Séance du ${new Date(r.from).toLocaleDateString("fr-FR")}, ${hhmm(r.from)} → ${hhmm(r.to)} (${Math.round((r.to - r.from) / 60_000)} min) — ` +
    `${r.committed} segments figés, ${r.untranslated} sans voix, ${r.unplayed} jamais joués, ${r.all.total.n} mesurés`,
);
if (r.approx) console.log("(journal d'avant l'étape A : début du premier mot estimé, fin du premier mot − 0,3 s)");

// Les trois indicateurs de premier rang (D41) : ce que l'apprenant vit, mot par mot.
const L = r.lag;
const sl = L.slope;
const sps = (ms: number) => `${ms >= 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(2).replace(".", ",")} s/min`;
console.log("\nIndicateurs de premier rang (hors segments traversant une panne) :");
console.log(`  Décalage par mot (début → début)  médiane ${s(L.words.p50)} · p95 ${s(L.words.p95)}  (${L.words.n} mots)`);
console.log(
  `  Retard maximal                    ${s(L.max?.ms ?? null)}${L.max ? ` — segment ${L.max.seq}, ${hhmm(L.max.t)}` : ""}` +
    (L.outageSegments ? ` · ${s(L.maxWithOutages)} pannes comprises (${L.outageSegments} seg. écartés)` : ""),
);
console.log(
  `  Pente du retard                   ${sl ? `${sps(sl.msPerMin)}${sl.seMsPerMin != null ? ` (± ${(sl.seMsPerMin / 1000).toFixed(2).replace(".", ",")})` : ""} sur ${String(sl.spanMin).replace(".", ",")} min, ${sl.n} seg.` : "—"}`,
);
console.log(
  `  (estimé : la voix est supposée dire les mots dans l'ordre, à débit régulier ; début des mots du formateur ${
    L.timedSegments === r.all.total.n && L.timedSegments ? "donné par le STT" : L.timedSegments ? `donné par le STT pour ${L.timedSegments} seg. sur ${r.all.total.n}, réparti à proportion ailleurs` : "réparti à proportion du temps de parole"
  })`,
);

console.log(`\nÉtages${"".padEnd(25)}${"Début de prise de parole".padEnd(20)}  Tous les segments`);
console.log(`${"".padEnd(31)}${`(n=${r.turnStarts.total.n})`.padEnd(20)}  (n=${r.all.total.n})`);
console.log(`${"".padEnd(31)}${"médiane      p95".padEnd(20)}  médiane      p95`);
for (const k of Object.keys(LABEL) as StageKey[]) console.log(`${LABEL[k].padEnd(31)}${cell(r.turnStarts[k])}   ${cell(r.all[k])}`);
console.log("(les médianes ne s'additionnent pas exactement)");

console.log("\nAu fil de la séance (médianes par minute) :");
for (const m of r.minutes)
  console.log(`  minute ${String(m.minute + 1).padStart(2)} : par mot ${s(m.wordLag).padStart(7)} · premier mot → son ${s(m.total).padStart(7)} · envoi et file ${s(m.wait).padStart(7)}  (${m.n} seg.)`);
if (r.driftMsPerMin != null) console.log(`Le décalage du premier mot varie de ${r.driftMsPerMin >= 0 ? "+" : ""}${s(r.driftMsPerMin)} par minute (ancienne mesure de dérive).`);
if (r.voiceRatio != null) console.log(`Voix traduite / parole du formateur : ${r.voiceRatio.toFixed(2).replace(".", ",")}${r.voiceRatio > 1 ? " — au-dessus de 1, la file des téléphones grandit" : ""}`);
const x = (v: number | null) => (v == null ? "—" : `×${v.toFixed(2).replace(".", ",")}`);
if (r.speed.p50 != null) console.log(`Vitesse de la voix : ${x(r.speed.p50)} en médiane (de ${x(r.speed.p10)} à ${x(r.speed.p90)} pour 80 % des segments)`);

const h = r.health;
console.log("\nFiabilité de la mesure :");
console.log(`  texte du STT reçu ${s(h.sttLag.p50)} après la parole (p95 ${s(h.sttLag.p95)})${(h.sttLag.p50 ?? 0) > 3000 ? " — anormal : réseau du poste ou du fournisseur" : ""}`);
if (h.loopLagMaxMs != null) console.log(`  serveur bloqué au plus ${h.loopLagMaxMs} ms${h.loopLagMaxMs > 200 ? " — poste surchargé" : ""}`);
if (h.sttBacklogMaxMs != null) console.log(`  audio en attente d'envoi au plus ${s(h.sttBacklogMaxMs)}${h.sttBacklogMaxMs > 1000 ? " — connexion montante saturée" : ""}`);
console.log(`  ${h.endpoints} fins de tour demandées pendant une pause, dont ${h.quickEndpoints} au premier blanc d'une prise de parole`);
const timeline = [
  ...h.degraded.map((d) => ({ t: d.t, line: `${d.mode.padEnd(10)} ${d.reason.slice(0, 110)}` })),
  ...h.settings.map((c) => ({ t: c.t, line: `réglages : ${c.changed.join(", ")}` })),
].sort((a, b) => a.t - b.t);
for (const x of timeline) console.log(`  ${hhmm(x.t)} ${x.line}`);
