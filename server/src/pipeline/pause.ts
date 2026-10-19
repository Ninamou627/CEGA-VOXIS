/**
 * Silence du formateur, mesuré sur l'audio reçu par fenêtres de 20 ms : de quoi forcer la fin
 * d'un tour du STT pendant une pause, entre deux mots (D22).
 *
 * Ce n'est pas une segmentation maison (D10) : le STT reste seul juge du texte. Le silence dit
 * seulement *quand* lui demander de clore le tour en cours. Forcer à un instant quelconque
 * coupait un mot en deux (« partial transfers » + « scripts », mesuré) ; pendant une pause,
 * aucun mot n'est en cours.
 *
 * Il sert aussi à recaler les mots du STT sur l'audio (D25) : U3.5 Pro place la fin du dernier
 * mot avant une pause ~0,4 s dans le silence qui suit, et le début du premier mot après une
 * pause ~0,5 s dans le silence qui précède (mesuré sur un enregistrement, vrai silence à
 * −80 dB). La latence se mesure depuis la vraie fin de la parole, pas depuis l'horodatage.
 */

/** Silence le plus court gardé pour recaler un mot : plus court, c'est l'occlusion d'un « p ». */
const SNAP_MIN_MS = 120;
/** Cinq minutes de silences suffisent : un segment se fige quelques secondes après sa fin. */
const SNAP_KEPT = 600;
/**
 * Décalage maximal corrigé (0,4 à 0,6 s mesurés). Au-delà, ce n'est plus l'horodatage qui se
 * trompe mais le seuil : une voix plus faible que le seuil de parole passerait pour un long
 * silence, et le recalage reculerait la fin de la phrase de plusieurs secondes.
 */
const MAX_SNAP_MS = 700;

export class PauseDetector {
  private silentMs = 0;
  /** Parole entendue depuis la dernière coupe (ms). */
  private speechMs = 0;
  /** Position dans le flux STT (ms d'audio depuis la remise à zéro). */
  private posMs = 0;
  /** Silences terminés d'au moins SNAP_MIN_MS, en positions du flux. */
  private silences: { start: number; end: number }[] = [];

  constructor(private readonly sampleRate: number) {}

  /**
   * Parole depuis la dernière coupe. Jugée sur l'audio, pas sur l'hypothèse du STT : quand
   * le STT prend du retard (2 s mesurées), ses mots n'ont pas encore été vus à la pause, et
   * une condition sur eux laissait passer la phrase entière d'un bloc.
   */
  get speechSinceCut(): number {
    return this.speechMs;
  }

  /** Silence en cours (ms) ; 0 pendant la parole. */
  get silence(): number {
    return this.silentMs;
  }

  /** Une coupe vient d'avoir lieu (fin de tour demandée, ou fin de tour du STT). */
  cut(): void {
    this.speechMs = 0;
  }

  /** Une trame PCM 16 bits mono ; renvoie la durée du silence en cours à la fin de la trame (ms). */
  push(pcm: Uint8Array, thresholdDb: number): number {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength & ~1);
    const n = pcm.byteLength >> 1;
    const win = Math.max(1, Math.round(this.sampleRate / 50)); // 20 ms
    for (let start = 0; start < n; start += win) {
      const end = Math.min(n, start + win);
      let sum = 0;
      for (let i = start; i < end; i++) {
        const s = view.getInt16(i * 2, true);
        sum += s * s;
      }
      const rms = Math.sqrt(sum / (end - start));
      const db = rms > 0 ? 20 * Math.log10(rms / 32768) : -100;
      const ms = ((end - start) * 1000) / this.sampleRate;
      if (db < thresholdDb) this.silentMs += ms;
      else {
        if (this.silentMs >= SNAP_MIN_MS) {
          this.silences.push({ start: this.posMs - this.silentMs, end: this.posMs });
          if (this.silences.length > SNAP_KEPT) this.silences.shift();
        }
        this.silentMs = 0;
        this.speechMs += ms;
      }
      this.posMs += ms;
    }
    return this.silentMs;
  }

  /** Le silence (terminé ou en cours) qui contient cette position du flux. */
  private silenceAt(ms: number): { start: number; end: number } | undefined {
    if (this.silentMs >= SNAP_MIN_MS && ms >= this.posMs - this.silentMs && ms <= this.posMs) return { start: this.posMs - this.silentMs, end: this.posMs };
    for (let i = this.silences.length - 1; i >= 0; i--) {
      const s = this.silences[i];
      if (s.end < ms) break;
      if (s.start <= ms) return s;
    }
    return undefined;
  }

  /** Fin d'un mot selon le STT → vraie fin de la parole, si l'horodatage tombe dans un silence. */
  speechEnd(ms: number): number {
    const s = this.silenceAt(ms);
    return s && ms - s.start <= MAX_SNAP_MS ? s.start : ms;
  }

  /**
   * Le silence qui suit une fin de parole (position du flux, déjà recalée) : sa durée, et s'il
   * dure encore. 0 si la parole a repris sans silence d'au moins 120 ms ; undefined si cette
   * position n'a pas encore été entendue.
   */
  pauseAfter(endMs: number): { ms: number; ongoing: boolean } | undefined {
    if (endMs > this.posMs) return undefined;
    const s = this.silenceAt(endMs + 1);
    if (!s || s.start > endMs + 40) return { ms: 0, ongoing: false };
    return { ms: s.end - s.start, ongoing: s.end >= this.posMs };
  }

  /** Début d'un mot selon le STT → vrai début de la parole, si l'horodatage tombe dans un silence. */
  speechStart(ms: number): number {
    const s = this.silenceAt(ms);
    return s && s.end < this.posMs && s.end - ms <= MAX_SNAP_MS ? s.end : ms;
  }

  reset(): void {
    this.silentMs = 0;
    this.speechMs = 0;
    this.posMs = 0;
    this.silences = [];
  }
}
