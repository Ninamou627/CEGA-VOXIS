/**
 * Prosodie d'une voix, mesurée sur l'audio : hauteur (F0), énergie, pauses, débit.
 *
 * Sert à comparer, segment par segment, la voix du formateur et la voix traduite (`npm run
 * prosody`), puis, à l'étape D, à transmettre l'expressivité du formateur à la synthèse.
 * Les grandeurs sont relatives : demi-tons pour la hauteur (une voix d'homme et une voix de
 * femme se comparent sur leurs variations, pas sur leur registre), dB pour l'énergie. Ce qui
 * se compare entre deux voix, ce sont leurs variations d'un segment à l'autre (corrélations).
 */

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/** Une fenêtre d'analyse de 20 ms. */
export interface Frame {
  /** Centre de la fenêtre (ms). */
  t: number;
  db: number;
  /** Fréquence fondamentale (Hz) si la fenêtre est voisée. */
  f0: number | null;
}

/** Ce qu'on retient d'un passage : un segment du formateur, ou la voix traduite d'un segment. */
export interface SpanFeatures {
  durMs: number;
  /** Temps de parole, pauses internes exclues. */
  speechMs: number;
  /** Silences internes d'au moins 200 ms (ms). */
  pauses: number[];
  /** Hauteur médiane, en demi-tons au-dessus de 100 Hz. */
  f0St: number | null;
  /** Étendue de la hauteur (p90 − p10, demi-tons) : une voix animée varie, une voix plate non. */
  f0RangeSt: number | null;
  /** Énergie médiane de la parole (dBFS). */
  energyDb: number | null;
  /** Étendue de l'énergie (p90 − p10, dB). */
  energyRangeDb: number | null;
  /**
   * Mouvement final de la hauteur (demi-tons) : les 250 dernières ms voisées contre les 500
   * précédentes. Positif : la voix monte (question, continuation) ; négatif : elle conclut.
   */
  finalMoveSt: number | null;
}

const ANALYSIS_RATE = 16000;
const HOP_MS = 20;
const F0_MIN = 70;
const F0_MAX = 400;
/** Seuil de YIN : en dessous, la fenêtre est périodique (voisée). */
const YIN_THRESHOLD = 0.15;
const MIN_PAUSE_MS = 200;

/** WAV PCM 16 bits (mono ou stéréo, dont on garde le premier canal). */
export function readWav(buf: Uint8Array): Pcm {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("ce n'est pas un fichier WAV");
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    let size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bits = view.getUint16(off + 22, true);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`attendu PCM 16 bits, reçu ${bits} bits`);
      // Un en-tête jamais corrigé (enregistrement interrompu) annonce 0 octet : on lit jusqu'au bout.
      if (size === 0 || off + 8 + size > buf.length) size = buf.length - off - 8;
      const n = Math.floor(size / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(off + 8 + i * 2 * channels, true) / 32768;
      return { samples, sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("chunk data absent");
}

/** Rééchantillonnage linéaire, précédé d'une moyenne glissante pour éviter le repliement. */
export function resample(pcm: Pcm, rate = ANALYSIS_RATE): Pcm {
  if (pcm.sampleRate === rate) return pcm;
  const ratio = pcm.sampleRate / rate;
  let src = pcm.samples;
  if (ratio > 1) {
    const k = Math.max(1, Math.round(ratio));
    const smoothed = new Float32Array(src.length);
    let acc = 0;
    for (let i = 0; i < src.length; i++) {
      acc += src[i];
      if (i >= k) acc -= src[i - k];
      smoothed[i] = acc / Math.min(i + 1, k);
    }
    src = smoothed;
  }
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = src[j] * (1 - f) + (src[j + 1] ?? src[j]) * f;
  }
  return { samples: out, sampleRate: rate };
}

/** YIN (de Cheveigné et Kawahara, 2002) sur une fenêtre ; null si elle n'est pas périodique. */
function yin(x: Float32Array, start: number, win: number, sr: number): number | null {
  const tauMin = Math.floor(sr / F0_MAX);
  const tauMax = Math.ceil(sr / F0_MIN);
  if (start + win + tauMax > x.length) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const diff = x[start + j] - x[start + j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // Différence cumulée normalisée, puis premier creux sous le seuil.
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (d[tau] < YIN_THRESHOLD) {
      while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
      // Interpolation parabolique autour du creux.
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const den = a + c - 2 * b;
      const shift = den !== 0 ? (a - c) / (2 * den) : 0;
      return sr / (tau + shift);
    }
  }
  return null;
}

/** Fenêtres de 20 ms : énergie partout, hauteur là où la voix est voisée et audible. */
export function analyzeFrames(input: Pcm): Frame[] {
  const pcm = resample(input);
  const sr = pcm.sampleRate;
  const x = pcm.samples;
  const hop = Math.round((sr * HOP_MS) / 1000);
  const win = Math.round(sr * 0.03);
  const frames: Frame[] = [];
  for (let start = 0; start + hop <= x.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + hop; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / hop);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    frames.push({ t: ((start + hop / 2) / sr) * 1000, db, f0: db > -50 ? yin(x, start, win, sr) : null });
  }
  return frames;
}

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * Seuil parole / silence propre à un enregistrement : au-dessus du bruit de fond, sous la voix.
 * Sans silence du tout (le 10e centile est déjà de la parole), 15 dB sous la voix.
 */
export function speechThreshold(frames: Frame[]): number {
  const dbs = frames.map((f) => f.db);
  const floor = pct(dbs, 0.1) ?? -100;
  const loud = pct(dbs, 0.95) ?? -20;
  return Math.min(Math.max(floor + 10, loud - 35), loud - 15);
}

const st = (hz: number) => 12 * Math.log2(hz / 100);

export function spanFeatures(frames: Frame[], startMs: number, endMs: number, threshold: number): SpanFeatures {
  const span = frames.filter((f) => f.t >= startMs && f.t < endMs);
  const speech = span.filter((f) => f.db >= threshold);
  const pauses: number[] = [];
  let run = 0;
  let seenSpeech = false;
  for (const f of span) {
    if (f.db >= threshold) {
      if (seenSpeech && run >= MIN_PAUSE_MS) pauses.push(run);
      run = 0;
      seenSpeech = true;
    } else if (seenSpeech) run += HOP_MS;
  }
  const voiced = speech.filter((f) => f.f0 != null);
  const semis = voiced.map((f) => st(f.f0!));
  const p90 = pct(semis, 0.9);
  const p10 = pct(semis, 0.1);
  const dbs = speech.map((f) => f.db);
  const e90 = pct(dbs, 0.9);
  const e10 = pct(dbs, 0.1);

  let finalMoveSt: number | null = null;
  if (voiced.length >= 10) {
    const lastT = voiced[voiced.length - 1].t;
    const tail = voiced.filter((f) => f.t > lastT - 250).map((f) => st(f.f0!));
    const before = voiced.filter((f) => f.t <= lastT - 250 && f.t > lastT - 750).map((f) => st(f.f0!));
    if (tail.length >= 3 && before.length >= 3) finalMoveSt = pct(tail, 0.5)! - pct(before, 0.5)!;
  }

  return {
    durMs: endMs - startMs,
    speechMs: speech.length * HOP_MS,
    pauses,
    f0St: pct(semis, 0.5),
    f0RangeSt: p90 != null && p10 != null ? p90 - p10 : null,
    energyDb: pct(dbs, 0.5),
    energyRangeDb: e90 != null && e10 != null ? e90 - e10 : null,
    finalMoveSt,
  };
}

/** Début et fin de la parole dans un enregistrement (la voix de synthèse a des blancs aux bords). */
export function speechBounds(frames: Frame[], threshold: number): [number, number] {
  const speech = frames.filter((f) => f.db >= threshold);
  if (!speech.length) return [0, 0];
  return [speech[0].t - HOP_MS / 2, speech[speech.length - 1].t + HOP_MS / 2];
}

/**
 * Syllabes écrites, approchées par les groupes de voyelles : de quoi comparer des débits d'un
 * segment à l'autre, pas une transcription phonétique. Le « e » muet final du français et
 * celui de l'anglais (« make ») ne se prononcent pas.
 */
export function syllables(text: string, lang: string): number {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let n = 0;
  for (let w of words) {
    if (lang === "fr") {
      w = w.replace(/(?<=\p{L}{2})(es|e|ent)$/u, "");
      n += Math.max(1, (w.match(/[aeiouyàâäéèêëîïôöùûüœæ]+/gu) ?? []).length);
    } else {
      w = w.replace(/(?<=\p{L}{2})(e|es|ed)$/u, "");
      n += Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length);
    }
  }
  return n;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * Mots mis en relief par le formateur : plus forts ou plus aigus que ses autres mots de la
 * séance (écart réduit au-delà de 1,5). Ce qui doit se retrouver dans la voix traduite.
 */
export function emphasizedWords(frames: Frame[], words: { text: string; startMs: number; endMs: number }[], threshold: number): boolean[] {
  const stats = words.map((w) => {
    const fs = frames.filter((f) => f.t >= w.startMs && f.t < w.endMs && f.db >= threshold);
    const f0s = fs.filter((f) => f.f0 != null).map((f) => st(f.f0!));
    return { db: fs.length ? Math.max(...fs.map((f) => f.db)) : null, f0: f0s.length ? Math.max(...f0s) : null };
  });
  const z = (vals: (number | null)[]) => {
    const v = vals.filter((x): x is number => x != null);
    const m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1)) || 1;
    return vals.map((x) => (x == null ? 0 : (x - m) / sd));
  };
  const zdb = z(stats.map((s) => s.db));
  const zf0 = z(stats.map((s) => s.f0));
  return stats.map((_, i) => zdb[i] > 1.5 || zf0[i] > 1.5);
}

/** Taux d'erreur sur les mots : ce que la voix traduite fait comprendre, relu par un STT. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const norm = (s: string) => s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  const ref = norm(reference);
  const hyp = norm(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}
