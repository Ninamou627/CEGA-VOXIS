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
 * Relie commits, segments et acks. Le compteur de segments repart de 1 à chaque redémarrage du
 * serveur : un numéro qui recule ouvre une nouvelle série.
 */
export function segmentRows(events: LogEvent[]): { rows: SegmentRow[]; committed: number; untranslated: number; unplayed: number } {
  let run = 0;
  let lastSeq = 0;
  const commits = new Map<string, LogEvent>();
  const segs = new Map<string, LogEvent>();
  const plays = new Map<string, number>();
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
      segs.set(`${run}:${seq}`, e);
    } else if (e.type === "ack") {
      const key = `${run}:${seq}`;
      if (!plays.has(key)) plays.set(key, e.t);
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

    const s = segs.get(key);
    if (!s) {
      untranslated++;
      continue;
    }
    const play = plays.get(key);
    if (play == null) {
      unplayed++;
      continue;
    }
    const mt = num(s.mtMs) ?? 0;
    const tts = num(s.ttsMs) ?? 0;
    rows.push({
      run: r,
      seq,
      t: c.t,
      turnStart,
      approx: exact == null,
      words: num(c.words) ?? 0,
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
      durMs: num(s.durMs) ?? 0,
      speed: num(s.speed),
    });
  }
  return { rows, committed: order.length, untranslated, unplayed };
}

/** Pente du décalage ressenti au fil de la séance : ms gagnées (ou perdues) par minute. */
export function driftPerMinute(rows: SegmentRow[]): number | null {
  if (rows.length < 3) return null;
  const t0 = rows[0].t;
  const xs = rows.map((r) => (r.t - t0) / 60_000);
  const ys = rows.map((r) => r.total);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? Math.round(sxy / sxx) : null;
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
  /** Par minute de séance : décalage ressenti et attente au téléphone (médianes). */
  minutes: { minute: number; n: number; total: number | null; wait: number | null }[];
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
  const { rows, committed, untranslated, unplayed } = segmentRows(inRange);
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
      minutes.push({ minute, n: rs.length, total: quantiles(rs.map((r) => r.total)).p50, wait: quantiles(rs.map((r) => r.wait)).p50 });
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
