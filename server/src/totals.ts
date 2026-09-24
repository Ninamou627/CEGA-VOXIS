/**
 * Compteurs de long terme pour l'administration : ce qui survit aux redémarrages.
 *
 * Le JSONL de `metrics` garde tout, événement par événement, pour les analyses ; ce
 * fichier garde les sommes qu'on affiche (temps de voix traduite, disponibilité,
 * signalements, confiance de la reconnaissance, naturalité perçue par voix), jour par
 * jour, sans relire des millions de lignes au démarrage.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DayTotals, RecentReport, Stage } from "../../shared/admin";
import type { Lang } from "../../shared/protocol";

export type { DayTotals, RecentReport, Stage };

export interface VoiceTotals {
  lang?: Lang;
  spoken: number;
  /** Signalements « voix peu naturelle » sur un segment dit par cette voix. */
  unnatural: number;
}

interface TotalsFile {
  since: number;
  all: DayTotals;
  /** YYYY-MM-DD → sommes du jour (60 derniers jours). */
  days: Record<string, DayTotals>;
  /** Histogramme bout-en-bout, cases de 250 ms jusqu'à 10 s (la dernière déborde). */
  e2eHist: number[];
  voices: Record<string, VoiceTotals>;
}

const BUCKET_MS = 250;
const BUCKETS = 40;
const KEEP_DAYS = 60;

function emptyDay(): DayTotals {
  return {
    translatedMs: 0,
    spoken: 0,
    translated: 0,
    untranslated: 0,
    sessionMs: 0,
    availableMs: 0,
    e2eSum: 0,
    e2eN: 0,
    confSum: 0,
    confN: 0,
    reports: {},
    questions: 0,
  };
}

function dayKey(t = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class Totals {
  private data: TotalsFile;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  /** Volatiles : ce que l'administration montre en détail, sans le garder au-delà du processus. */
  readonly recentReports: RecentReport[] = [];
  readonly lastErrors: Partial<Record<Stage, { at: number; msg: string; count: number }>> = {};

  constructor(private readonly file: string) {
    this.data = this.load();
    this.timer = setInterval(() => this.flush(), 30_000);
    this.timer.unref();
  }

  // ---- alimentation ---------------------------------------------------------

  private bump(fn: (d: DayTotals) => void) {
    fn(this.data.all);
    const k = dayKey();
    fn((this.data.days[k] ??= emptyDay()));
    this.dirty = true;
  }

  /** Un segment traduit (qu'il soit ensuite dit ou non). */
  translated() {
    this.bump((d) => d.translated++);
  }

  /** Un segment dit par la voix : durée diffusée, et la voix qui l'a dit. */
  spoken(o: { durMs: number; voice?: string; lang: Lang }) {
    this.bump((d) => {
      d.spoken++;
      d.translatedMs += o.durMs;
    });
    if (o.voice) {
      const v = (this.data.voices[o.voice] ??= { spoken: 0, unnatural: 0 });
      v.spoken++;
      v.lang = o.lang;
    }
  }

  untranslated() {
    this.bump((d) => {
      d.translated++;
      d.untranslated++;
    });
  }

  ack(e2eMs: number) {
    this.bump((d) => {
      d.e2eSum += e2eMs;
      d.e2eN++;
    });
    const i = Math.min(BUCKETS - 1, Math.floor(e2eMs / BUCKET_MS));
    this.data.e2eHist[i] = (this.data.e2eHist[i] ?? 0) + 1;
  }

  confidence(c: number) {
    this.bump((d) => {
      d.confSum += c;
      d.confN++;
    });
  }

  question() {
    this.bump((d) => d.questions++);
  }

  report(r: RecentReport) {
    this.bump((d) => (d.reports[r.kind] = (d.reports[r.kind] ?? 0) + 1));
    if (r.kind === "voice" && r.voice) {
      const v = (this.data.voices[r.voice] ??= { spoken: 0, unnatural: 0 });
      v.unnatural++;
    }
    this.recentReports.push(r);
    if (this.recentReports.length > 200) this.recentReports.shift();
  }

  stageError(stage: Stage, msg: string) {
    const prev = this.lastErrors[stage];
    this.lastErrors[stage] = { at: Date.now(), msg: msg.slice(0, 240), count: (prev?.count ?? 0) + 1 };
  }

  /** Appelé chaque seconde : temps de séance, et part de ce temps où la voix pouvait être servie. */
  tick(dtMs: number, inSession: boolean, available: boolean) {
    if (!inSession) return;
    this.bump((d) => {
      d.sessionMs += dtMs;
      if (available) d.availableMs += dtMs;
    });
  }

  // ---- lecture --------------------------------------------------------------

  get since(): number {
    return this.data.since;
  }

  all(): DayTotals {
    return this.data.all;
  }

  today(): DayTotals {
    return this.data.days[dayKey()] ?? emptyDay();
  }

  /** Les `n` derniers jours, du plus ancien au plus récent, jours sans séance compris. */
  lastDays(n: number): { day: string; totals: DayTotals }[] {
    const out: { day: string; totals: DayTotals }[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = dayKey(Date.now() - i * 86_400_000);
      out.push({ day: k, totals: this.data.days[k] ?? emptyDay() });
    }
    return out;
  }

  /** Percentile bout-en-bout sur tout l'historique, à la résolution de l'histogramme. */
  e2ePercentile(p: number): number | null {
    const h = this.data.e2eHist;
    const n = h.reduce((a, b) => a + (b ?? 0), 0);
    if (!n) return null;
    let acc = 0;
    for (let i = 0; i < BUCKETS; i++) {
      acc += h[i] ?? 0;
      if (acc >= (p / 100) * n) return (i + 1) * BUCKET_MS;
    }
    return BUCKETS * BUCKET_MS;
  }

  voices(): Record<string, VoiceTotals> {
    return this.data.voices;
  }

  // ---- persistance ----------------------------------------------------------

  flush() {
    if (!this.dirty) return;
    // On ne garde que les derniers jours : le détail ancien vit dans le JSONL.
    const keys = Object.keys(this.data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.data.days[k];
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.warn(`[totals] écriture impossible : ${(err as Error).message}`);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.flush();
  }

  private load(): TotalsFile {
    const fresh: TotalsFile = { since: Date.now(), all: emptyDay(), days: {}, e2eHist: [], voices: {} };
    if (!existsSync(this.file)) return fresh;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TotalsFile>;
      return {
        since: raw.since ?? fresh.since,
        all: { ...emptyDay(), ...raw.all },
        days: raw.days ?? {},
        e2eHist: raw.e2eHist ?? [],
        voices: raw.voices ?? {},
      };
    } catch (err) {
      console.warn(`[totals] ${this.file} illisible, compteurs remis à zéro : ${(err as Error).message}`);
      return fresh;
    }
  }
}
