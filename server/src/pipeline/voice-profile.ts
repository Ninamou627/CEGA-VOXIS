/**
 * La voix du formateur, segment par segment, comparée à ses propres habitudes (D28) : de quoi
 * dire à la voix traduite qu'une phrase est animée ou posée, plus rapide que d'habitude, qu'elle
 * monte à la fin, et quels mots il a mis en relief (étape D3).
 *
 * Tout est relatif : une voix grave et une voix aiguë, un micro proche et un micro lointain se
 * comparent sur leurs écarts à leur propre moyenne, apprise depuis le démarrage du micro.
 */
import type { Word } from "../providers/types";
import { spanFeatures, syllables, type Frame } from "../prosody";

/** Moyenne et dispersion glissantes (Welford) : situer une mesure par rapport à l'habitude. */
class Habit {
  private n = 0;
  private mean = 0;
  private m2 = 0;

  constructor(
    private readonly ready: number,
    /**
     * Dispersion minimale : une voix très régulière (voix de synthèse, formateur monotone) aurait
     * sinon une dispersion nulle, et le moindre écart deviendrait infini — ou, à zéro, invisible.
     */
    private readonly minSd: number,
  ) {}

  add(x: number | null): void {
    if (x == null || !Number.isFinite(x)) return;
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }

  /** Écart réduit à l'habitude ; null tant qu'elle n'est pas connue. */
  z(x: number | null): number | null {
    if (x == null || this.n < this.ready) return null;
    const sd = Math.max(this.minSd, Math.sqrt(this.m2 / this.n));
    return Math.round(((x - this.mean) / sd) * 100) / 100;
  }
}

export interface SegmentProsody {
  /** Hauteur médiane (demi-tons au-dessus de 100 Hz), étendue (p90 − p10), mouvement final. */
  f0St: number | null;
  f0RangeSt: number | null;
  finalMoveSt: number | null;
  /** Énergie médiane de la parole (dBFS). */
  energyDb: number | null;
  /** Syllabes par seconde de parole, pauses exclues. */
  rate: number | null;
  /** Écarts réduits à l'habitude du formateur : 0 = comme d'habitude, ±1 = nettement au-dessus / en dessous. */
  pitchZ: number | null;
  rangeZ: number | null;
  energyZ: number | null;
  rateZ: number | null;
  /** Animée (mélodie et énergie au-dessus de l'habitude), posée (en dessous), ou ordinaire. */
  arousal: "lively" | "calm" | "neutral" | null;
  /** Mots mis en relief : nettement plus forts ou plus aigus que ses mots habituels. */
  emphasized: string[];
}

/** Segments nécessaires avant de juger un segment par rapport à l'habitude (~20 s de parole). */
const READY_SEGMENTS = 8;
const READY_WORDS = 30;
/** Au-delà de cet écart réduit, un segment est animé (ou posé), un mot mis en relief. */
const AROUSAL_Z = 0.75;
const EMPHASIS_Z = 1.5;

const st = (hz: number) => 12 * Math.log2(hz / 100);
const round = (x: number | null, k = 10) => (x == null ? null : Math.round(x * k) / k);

export class VoiceProfile {
  // Dispersions minimales : un demi-ton, un décibel, un tiers de syllabe par seconde.
  private pitch = new Habit(READY_SEGMENTS, 0.5);
  private range = new Habit(READY_SEGMENTS, 0.5);
  private energy = new Habit(READY_SEGMENTS, 1);
  private rate = new Habit(READY_SEGMENTS, 0.3);
  private wordDb = new Habit(READY_WORDS, 1);
  private wordSt = new Habit(READY_WORDS, 0.5);

  constructor(private readonly lang: string) {}

  /**
   * Décrit un segment entre deux positions du flux (parole recalée sur l'audio), puis l'ajoute à
   * l'habitude. `frames` : les fenêtres de LiveProsody ; `thresholdDb` : le seuil de parole.
   */
  describe(frames: Frame[], startMs: number, endMs: number, words: Word[], text: string, thresholdDb: number): SegmentProsody {
    const f = spanFeatures(frames, startMs, endMs, thresholdDb);
    const rate = f.speechMs >= 300 ? syllables(text, this.lang) / (f.speechMs / 1000) : null;
    const pitchZ = this.pitch.z(f.f0St);
    const rangeZ = this.range.z(f.f0RangeSt);
    const energyZ = this.energy.z(f.energyDb);
    const rateZ = this.rate.z(rate);
    const lively = [rangeZ, energyZ].filter((z): z is number => z != null);
    const score = lively.length ? lively.reduce((a, b) => a + b, 0) / lively.length : null;
    const arousal = score == null ? null : score > AROUSAL_Z ? "lively" : score < -AROUSAL_Z ? "calm" : "neutral";

    const emphasized: string[] = [];
    const peaks: { db: number | null; st: number | null }[] = [];
    for (const w of words) {
      if (w.startMs == null || w.endMs == null) continue;
      const fs = frames.filter((x) => x.t >= w.startMs! && x.t < w.endMs! && x.db >= thresholdDb);
      const voiced = fs.filter((x) => x.f0 != null).map((x) => st(x.f0!));
      const peak = { db: fs.length ? Math.max(...fs.map((x) => x.db)) : null, st: voiced.length ? Math.max(...voiced) : null };
      peaks.push(peak);
      const zDb = this.wordDb.z(peak.db);
      const zSt = this.wordSt.z(peak.st);
      if ((zDb != null && zDb > EMPHASIS_Z) || (zSt != null && zSt > EMPHASIS_Z)) emphasized.push(w.text);
    }

    this.pitch.add(f.f0St);
    this.range.add(f.f0RangeSt);
    this.energy.add(f.energyDb);
    this.rate.add(rate);
    for (const p of peaks) {
      this.wordDb.add(p.db);
      this.wordSt.add(p.st);
    }

    return {
      f0St: round(f.f0St),
      f0RangeSt: round(f.f0RangeSt),
      finalMoveSt: round(f.finalMoveSt),
      energyDb: round(f.energyDb),
      rate: round(rate),
      pitchZ,
      rangeZ,
      energyZ,
      rateZ,
      arousal,
      emphasized,
    };
  }
}
