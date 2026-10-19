/**
 * Silence du formateur, mesuré sur l'audio reçu par fenêtres de 20 ms : de quoi forcer la fin
 * d'un tour du STT pendant une pause, entre deux mots (D22).
 *
 * Ce n'est pas une segmentation maison (D10) : le STT reste seul juge du texte. Le silence dit
 * seulement *quand* lui demander de clore le tour en cours. Forcer à un instant quelconque
 * coupait un mot en deux (« partial transfers » + « scripts », mesuré) ; pendant une pause,
 * aucun mot n'est en cours.
 */
export class PauseDetector {
  private silentMs = 0;
  /** Parole entendue depuis la dernière coupe (ms). */
  private speechMs = 0;

  constructor(private readonly sampleRate: number) {}

  /**
   * Parole depuis la dernière coupe. Jugée sur l'audio, pas sur l'hypothèse du STT : quand
   * le STT prend du retard (2 s mesurées), ses mots n'ont pas encore été vus à la pause, et
   * une condition sur eux laissait passer la phrase entière d'un bloc.
   */
  get speechSinceCut(): number {
    return this.speechMs;
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
        this.silentMs = 0;
        this.speechMs += ms;
      }
    }
    return this.silentMs;
  }

  reset(): void {
    this.silentMs = 0;
    this.speechMs = 0;
  }
}
