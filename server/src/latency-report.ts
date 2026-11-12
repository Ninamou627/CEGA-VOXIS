/**
 * Décomposition d'une séance à partir de son journal (metrics.jsonl) : d'où vient le délai
 * entre le moment où le formateur parle et celui où la salle l'entend, étage par étage,
 * au début d'une prise de parole et en parole continue, et s'il grandit au fil du temps.
 *
 * C'est l'outil des comparaisons avant / après (`npm run report`). Il dit aussi si la mesure
 * est exploitable : un STT qui renvoie le texte avec dix secondes de retard, un serveur
 * bloqué ou de l'audio qui n'arrive pas à partir désignent le réseau ou le poste, pas le
 * réglage qu'on voulait évaluer.
 *
 * Les journaux d'avant l'étape A n'ont ni `tStart` ni `turnStart` : le début du premier mot est
 * alors estimé (fin du premier mot − 300 ms) et la ligne est marquée approchée.
 *
 * Trois indicateurs de premier rang (D41, audit F-12) : le décalage par mot (début prononcé d'un
 * mot → début de son écoute), le retard maximal et la pente du retard. « Fin de phrase → son »
 * (D19) reste un indicateur d'étage : il récompensait l'attente de phrases entières.
 */

export interface LogEvent {
  t: number;
  type: string;
  [k: string]: unknown;
}

/** Un segment, du premier mot prononcé à la première écoute sur un téléphone (ms). */
export interface SegmentRow {
  run: number;
  seq: number;
  /** Instant du commit (horloge serveur). */
  t: number;
  turnStart: boolean;
  /** Début du premier mot estimé (journal d'avant l'étape A). */
  approx: boolean;
  words: number;
  reason: string;
  sttLag: number | null;
  /** Le formateur prononce le segment : début du premier mot → fin du dernier. */
  speech: number;
  /** Fin du dernier mot → segment figé. */
  reco: number;
  /** Attente derrière les segments précédents, avant la traduction (chaîne par langue). */
  chain: number;
  mt: number;
  tts: number;
  /** Voix prête → premier téléphone qui la joue (envoi, file du téléphone). */
  wait: number;
  /** Début de parole → premier son. */
  total: number;
  /** Fin de phrase → premier son (D19). */
  end: number;
  durMs: number;
  speed: number | null;
  /** Début prononcé du premier mot, et premier son sur un téléphone (horloge serveur). */
  tStart: number;
  play: number;
  /** Début de chaque mot depuis le premier, donné par le STT (journaux depuis D41) ; null sinon. */
  wordStarts: number[] | null;
  /** Décalage de chaque mot, début prononcé → début entendu (estimé, voir `wordLags`). */
  lags: number[];
  /** Le segment traverse une panne (reconnaissance perdue, texte seul) : écarté des indicateurs de retard. */
  outage: boolean;
}

export interface Quantiles {
  n: number;
  p50: number | null;
  p95: number | null;
}

/** Durée moyenne d'un mot, pour estimer le début du premier mot dans les anciens journaux. */
const WORD_MS = 300;
/** Comme le pipeline : au-delà, le segment ouvre une nouvelle prise de parole. */
const TURN_GAP_MS = 1500;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function quantiles(values: number[]): Quantiles {
  if (!values.length) return { n: 0, p50: null, p95: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]);
  return { n: s.length, p50: at(0.5), p95: at(0.95) };
}

/**
 * Décalage de chaque mot d'un segment : début prononcé par le formateur → début entendu sur le
 * téléphone. Estimé : on ne sait pas où chaque mot tombe dans la voix traduite ; elle est supposée
 * les dire dans l'ordre, à débit régulier — le mot k sur n commence à k/n de sa durée. Côté
 * formateur, le début de chaque mot vient du STT quand on l'a (`wordStarts`), sinon de la même
 * règle sur son temps de parole.
 */
export function wordLags(x: { tStart: number; play: number; speech: number; durMs: number; words: number; wordStarts?: readonly number[] | null }): number[] {
  const n = Math.max(1, Math.round(x.words));
  const timed = x.wordStarts && x.wordStarts.length === n ? x.wordStarts : null;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const src = timed ? Math.min(Math.max(0, timed[k]), Math.max(0, x.speech)) : (k / n) * Math.max(0, x.speech);
    out.push(Math.round(x.play + (k / n) * Math.max(0, x.durMs) - (x.tStart + src)));
  }
  return out;
}

export interface Slope {
  /** Variation par minute (ms), par moindres carrés. */
  msPerMin: number;
  /** Erreur type de la pente (ms par minute) ; null sous quatre points. */
  seMsPerMin: number | null;
  /** Durée couverte par les points (min). */
  spanMin: number;
  n: number;
}

/** Pente d'une série datée, en ms par minute, avec son erreur type : une pente sur 4 minutes est peu sûre. */
export function slope(points: readonly { t: number; v: number }[]): Slope | null {
  if (points.length < 3) return null;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / 60_000);
  const ys = points.map((p) => p.v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i] - a - b * xs[i]) ** 2;
  const se = n > 3 ? Math.sqrt(ss / (n - 2) / sxx) : null;
  return { msPerMin: Math.round(b), seMsPerMin: se != null ? Math.round(se) : null, spanMin: Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10, n };
}

/**
 * Modes où la salle n'a plus de voix : un segment qui en traverse un attend la réouverture (D37)
 * ou n'a pas de voix. Ses chiffres disent la panne, pas le rythme de la chaîne : ils sont comptés
 * à part, pas mêlés aux indicateurs de retard. Les secours (`backup-*`, `s2s`) servent la voix.
 */
export const OUTAGE_MODES: ReadonlySet<string> = new Set(["stt-lost", "text-only"]);

/** Intervalles de panne d'après les événements `degraded` : du passage en panne au mode suivant. */
export function outages(events: readonly LogEvent[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.type !== "degraded") continue;
    const down = OUTAGE_MODES.has(String(e.mode));
    if (down && open == null) open = e.t;
    else if (!down && open != null) {
      out.push({ from: open, to: e.t });
      open = null;
    }
  }
  if (open != null) out.push({ from: open, to: Infinity });
  return out;
}

/**
 * Relie commits, segments et acks. Le compteur de segments repart de 1 à chaque redémarrage du
 * serveur : un numéro qui recule ouvre une nouvelle série. Avec plusieurs langues, la première
 * écoute est rapprochée de la voix de sa langue quand l'ack la donne (journaux depuis D41).
 */
export function segmentRows(
  events: LogEvent[],
  down: readonly { from: number; to: number }[] = outages(events),
): { rows: SegmentRow[]; committed: number; untranslated: number; unplayed: number } {
  let run = 0;
  let lastSeq = 0;
  const commits = new Map<string, LogEvent>();
  const segs = new Map<string, LogEvent>();
  const plays = new Map<string, { t: number; lang: string | null }>();
  const order: string[] = [];
  for (const e of events) {
    const seq = num(e.seq);
    if (seq == null) continue;
    if (e.type === "commit") {
      if (seq <= lastSeq) run++;
      lastSeq = seq;
      const key = `${run}:${seq}`;
      commits.set(key, e);
      order.push(key);
    } else if (e.type === "segment") {
      const key = `${run}:${seq}`;
      if (!segs.has(key)) segs.set(key, e);
      if (typeof e.lang === "string") segs.set(`${key}:${e.lang}`, e);
    } else if (e.type === "ack") {
      const key = `${run}:${seq}`;
      if (!plays.has(key)) plays.set(key, { t: e.t, lang: typeof e.lang === "string" ? e.lang : null });
    }
  }

  const rows: SegmentRow[] = [];
  let untranslated = 0;
  let unplayed = 0;
  let prev: { run: number; tEnd: number } | undefined;
  for (const key of order) {
    const c = commits.get(key)!;
    const [r, seq] = key.split(":").map(Number);
    const tOrigin = num(c.tOrigin)!;
    const tEnd = num(c.tEnd) ?? tOrigin;
    const sttLag = num(c.sttLagMs);
    const exact = num(c.tStart);
    const tStart = exact ?? (sttLag != null ? tOrigin - sttLag - WORD_MS : tOrigin);
    const turnStart =
      typeof c.turnStart === "boolean" ? c.turnStart : !prev || prev.run !== r || tStart - prev.tEnd > TURN_GAP_MS;
    prev = { run: r, tEnd: Math.max(prev?.run === r ? prev.tEnd : 0, tEnd) };

    const p = plays.get(key);
    const s = (p?.lang != null ? segs.get(`${key}:${p.lang}`) : undefined) ?? segs.get(key);
    if (!s) {
      untranslated++;
      continue;
    }
    if (p == null) {
      unplayed++;
      continue;
    }
    const play = p.t;
    const mt = num(s.mtMs) ?? 0;
    const tts = num(s.ttsMs) ?? 0;
    const words = num(c.words) ?? 0;
    const durMs = num(s.durMs) ?? 0;
    const starts = Array.isArray(c.wordStarts) && c.wordStarts.every((v) => num(v) != null) ? (c.wordStarts as number[]) : null;
    const wordStarts = starts && starts.length === Math.max(1, words) ? starts : null;
    rows.push({
      run: r,
      seq,
      t: c.t,
      turnStart,
      approx: exact == null,
      words,
      reason: String(c.reason ?? ""),
      sttLag,
      speech: tEnd - tStart,
      reco: c.t - tEnd,
      chain: Math.max(0, s.t - c.t - mt - tts),
      mt,
      tts,
      wait: play - s.t,
      total: play - tStart,
      end: play - tEnd,
      durMs,
      speed: num(s.speed),
      tStart,
      play,
      wordStarts,
      lags: wordLags({ tStart, play, speech: tEnd - tStart, durMs, words, wordStarts }),
      outage: down.some((o) => o.from <= play && o.to >= tStart),
    });
  }
  return { rows, committed: order.length, untranslated, unplayed };
}

/** Pente du décalage ressenti (premier mot) au fil de la séance : ms gagnées (ou perdues) par minute. */
export function driftPerMinute(rows: SegmentRow[]): number | null {
  return slope(rows.map((r) => ({ t: r.t, v: r.total })))?.msPerMin ?? null;
}

/** Les trois indicateurs de premier rang (D41), hors segments traversant une panne. */
export interface LagReport {
  /** Décalage par mot : tous les mots des segments joués (estimé, voir `wordLags`). */
  words: Quantiles;
  /** Le mot le plus en retard. */
  max: { ms: number; seq: number; t: number } | null;
  /** Le même, segments en panne compris. */
  maxWithOutages: number | null;
  /** Pente du décalage moyen de chaque segment au fil de la séance. */
  slope: Slope | null;
  /** Segments écartés parce qu'ils traversent une panne. */
  outageSegments: number;
  /** Segments dont le début de chaque mot vient du STT (sinon réparti à proportion). */
  timedSegments: number;
}

export function lagReport(rows: SegmentRow[]): LagReport {
  const ok = rows.filter((r) => !r.outage);
  let max: LagReport["max"] = null;
  for (const r of ok) {
    const m = Math.max(...r.lags);
    if (!max || m > max.ms) max = { ms: m, seq: r.seq, t: r.t };
  }
  const all = rows.flatMap((r) => r.lags);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return {
    words: quantiles(ok.flatMap((r) => r.lags)),
    max,
    maxWithOutages: all.length ? Math.max(...all) : null,
    slope: slope(ok.map((r) => ({ t: r.t, v: mean(r.lags) }))),
    outageSegments: rows.length - ok.length,
    timedSegments: rows.filter((r) => r.wordStarts).length,
  };
}

/**
 * Durée de la voix traduite rapportée au temps de parole du formateur. Au-dessus de 1, chaque
 * minute de parole produit plus d'une minute de voix : la file des téléphones grandit.
 */
export function voiceRatio(rows: SegmentRow[]): number | null {
  let src = 0;
  let out = 0;
  let prevEnd: number | null = null;
  for (const r of rows) {
    const start = r.t - r.reco - r.speech; // début du premier mot
    // En parole continue, le temps source court depuis la fin du segment précédent.
    const from = prevEnd != null && !r.turnStart && start - prevEnd < TURN_GAP_MS ? prevEnd : start;
    src += r.t - r.reco - from;
    out += r.durMs;
    prevEnd = r.t - r.reco;
  }
  return src > 0 ? Math.round((out / src) * 100) / 100 : null;
}

export const STAGES = ["speech", "reco", "chain", "mt", "tts", "wait", "total", "end", "sttLag"] as const;
export type StageKey = (typeof STAGES)[number];

export interface Report {
  from: number;
  to: number;
  committed: number;
  untranslated: number;
  unplayed: number;
  approx: boolean;
  turnStarts: Record<StageKey, Quantiles>;
  all: Record<StageKey, Quantiles>;
  /** Décalage par mot, retard maximal, pente du retard (D41). */
  lag: LagReport;
  /** Par minute de séance : décalage par mot (hors pannes), décalage du premier mot, attente au téléphone (médianes). */
  minutes: { minute: number; n: number; wordLag: number | null; total: number | null; wait: number | null }[];
  /** Pente du décalage du premier mot de chaque segment (ancien indicateur de dérive, gardé pour comparer). */
  driftMsPerMin: number | null;
  voiceRatio: number | null;
  /** Vitesse de synthèse appliquée aux segments : 10e centile, médiane, 90e centile. */
  speed: { p10: number | null; p50: number | null; p90: number | null };
  /** De quoi juger si la mesure est exploitable. */
  health: {
    sttLag: Quantiles;
    loopLagMaxMs: number | null;
    sttBacklogMaxMs: number | null;
    degraded: { t: number; mode: string; reason: string }[];
    settings: { t: number; changed: string[] }[];
    endpoints: number;
    /** Dont les premiers morceaux de prise de parole, coupés au premier blanc (D25). */
    quickEndpoints: number;
  };
}

export function analyze(events: LogEvent[], from = -Infinity, to = Infinity): Report {
  const inRange = events.filter((e) => e.t >= from && e.t <= to);
  // Les pannes se lisent sur tout le journal : une panne ouverte avant la fenêtre compte.
  const { rows, committed, untranslated, unplayed } = segmentRows(inRange, outages(events));
  const pick = (rs: SegmentRow[]) =>
    Object.fromEntries(STAGES.map((k) => [k, quantiles(rs.map((r) => r[k]).filter((v): v is number => v != null))])) as Record<StageKey, Quantiles>;

  const minutes: Report["minutes"] = [];
  if (rows.length) {
    const t0 = rows[0].t;
    const by = new Map<number, SegmentRow[]>();
    for (const r of rows) {
      const m = Math.floor((r.t - t0) / 60_000);
      by.set(m, [...(by.get(m) ?? []), r]);
    }
    for (const [minute, rs] of [...by].sort((a, b) => a[0] - b[0])) {
      minutes.push({
        minute,
        n: rs.length,
        wordLag: quantiles(rs.filter((r) => !r.outage).flatMap((r) => r.lags)).p50,
        total: quantiles(rs.map((r) => r.total)).p50,
        wait: quantiles(rs.map((r) => r.wait)).p50,
      });
    }
  }

  const health = inRange.filter((e) => e.type === "health");
  const maxOf = (k: string) => (health.length ? Math.max(...health.map((e) => num(e[k]) ?? 0)) : null);
  return {
    from: inRange[0]?.t ?? from,
    to: inRange[inRange.length - 1]?.t ?? to,
    committed,
    untranslated,
    unplayed,
    approx: rows.some((r) => r.approx),
    turnStarts: pick(rows.filter((r) => r.turnStart)),
    all: pick(rows),
    lag: lagReport(rows),
    minutes,
    driftMsPerMin: driftPerMinute(rows),
    voiceRatio: voiceRatio(rows),
    speed: (() => {
      const v = rows.map((r) => r.speed).filter((x): x is number => x != null).sort((a, b) => a - b);
      const at = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
      return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
    })(),
    health: {
      sttLag: quantiles(inRange.filter((e) => e.type === "commit").map((e) => num(e.sttLagMs)).filter((v): v is number => v != null)),
      loopLagMaxMs: maxOf("loopLagMaxMs"),
      sttBacklogMaxMs: maxOf("sttBacklogMaxMs"),
      degraded: inRange.filter((e) => e.type === "degraded").map((e) => ({ t: e.t, mode: String(e.mode), reason: String(e.reason ?? "") })),
      settings: inRange.filter((e) => e.type === "settings").map((e) => ({ t: e.t, changed: (e.changed as string[]) ?? [] })),
      endpoints: inRange.filter((e) => e.type === "endpoint").length,
      quickEndpoints: inRange.filter((e) => e.type === "endpoint" && e.quick === true).length,
    },
  };
}
