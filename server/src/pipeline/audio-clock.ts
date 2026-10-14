/**
 * Horloge de l'audio envoyé au STT : relie une position dans le flux (en ms d'audio, celle
 * des horodatages de mots du fournisseur) à l'heure serveur où le formateur l'a prononcée.
 *
 * C'est elle qui date la fin parlée d'un segment, point de départ de la latence qui compte
 * (D19) : du dernier mot prononcé au premier son traduit.
 *
 * Le micro livre chaque trame à la fin de son intervalle : une trame reçue à `at` couvre
 * l'audio prononcé jusqu'à `at`, moins l'aller simple formateur → serveur (non mesurable
 * sans horloge commune, de l'ordre de quelques dizaines de ms : la latence est donc
 * légèrement sous-estimée). Le Wi-Fi groupe parfois des trames : la dernière d'un groupe
 * arrive « en retard ». Une trame ne pouvant pas arriver avant d'avoir été dite, on retient,
 * parmi les trames qui suivent la position cherchée, l'estimation la plus précoce.
 *
 * Une horloge vaut pour une session STT : les horodatages repartent de zéro à chaque
 * réouverture du flux, et `reset()` aussi.
 */

/** Au-delà, une trame arrivée plus tard ne renseigne plus sur l'instant cherché. */
const LOOKAHEAD_MS = 2000;

export class AudioClock {
  /** `end` : position (ms d'audio) à la fin de la trame ; `at` : heure serveur de réception. */
  private frames: { end: number; at: number }[] = [];
  private samples = 0;
  /** Fin de la plus récente trame oubliée : en deçà, la position n'est plus datable. */
  private forgotten = 0;

  /** `keep` trames gardées : 3 000 trames de 100 ms, cinq minutes d'audio. */
  constructor(
    private readonly sampleRate: number,
    private readonly keep = 3000,
  ) {}

  reset(): void {
    this.frames = [];
    this.samples = 0;
    this.forgotten = 0;
  }

  /** Audio envoyé au STT depuis l'ouverture du flux (ms). */
  get audioMs(): number {
    return (this.samples * 1000) / this.sampleRate;
  }

  /** Une trame PCM 16 bits mono vient d'être transmise au STT. */
  push(bytes: number, at: number): void {
    this.samples += bytes >> 1;
    this.frames.push({ end: this.audioMs, at });
    if (this.frames.length > this.keep + 500) {
      const dropped = this.frames.splice(0, this.frames.length - this.keep);
      this.forgotten = dropped[dropped.length - 1].end;
    }
  }

  /** Heure serveur à laquelle la position `audioMs` du flux a été prononcée, si elle est encore connue. */
  spokenAt(audioMs: number): number | undefined {
    const f = this.frames;
    if (!f.length || audioMs < this.forgotten) return undefined;
    const last = f[f.length - 1];
    // Un horodatage un peu au-delà de l'audio reçu (arrondi du fournisseur) : on prolonge.
    if (audioMs >= last.end) return last.at - (last.end - audioMs);
    // Première trame qui couvre la position (recherche dichotomique).
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].end < audioMs) lo = mid + 1;
      else hi = mid;
    }
    let best = Infinity;
    for (let i = lo; i < f.length && f[i].end - audioMs <= LOOKAHEAD_MS; i++) {
      best = Math.min(best, f[i].at - (f[i].end - audioMs));
    }
    return best;
  }
}
