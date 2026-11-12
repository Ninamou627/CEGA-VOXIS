/**
 * Liaison montante du micro, côté page formateur (D37). Chaque trame part numérotée et datée, et
 * les 30 dernières secondes restent en réserve.
 *
 * Rien ne part tant que la page n'est pas admise : le serveur jette ce qui arrive avant son
 * `hello`, et une trame récente arrivée la première ferait prendre les plus anciennes, renvoyées
 * ensuite, pour des doublons. À chaque admission, la réserve repart à partir de la dernière trame
 * que le serveur dit avoir, puis le direct reprend, dans l'ordre :
 *   - première admission : le serveur ne connaît pas la captation, tout part — y compris ce que
 *     le formateur a dit pendant que la page se connectait ;
 *   - même serveur, liaison reprise : il dit où il en est (`resumeSeq`), seul le manquant part ;
 *   - serveur redémarré : il ne connaît plus la captation ; part ce qui suit la dernière trame
 *     qu'il avait confirmée (`micSeq` des stats, toutes les 2 s) — au pire 2 s redites, plutôt
 *     que tout ce qui s'est dit pendant le redémarrage perdu.
 */
import { encodeMicFrame } from "./framing";

/**
 * 30 s de trames de 50 ms. Mesuré le 11/11/2026 : une coupure réseau de 20 s se repère en 6 s et
 * la page n'est réadmise qu'après 21,8 s ; 10 s de réserve en perdaient 11,75.
 */
export const RING_FRAMES = 600;

export class MicUplink {
  private seq = 0;
  private ring: { seq: number; frame: Uint8Array }[] = [];
  private admitted = false;
  private confirmed = 0;

  constructor(
    private readonly send: (frame: Uint8Array) => void,
    /** Heure de captation, à l'horloge du serveur si possible. */
    private readonly now: () => number = Date.now,
    private readonly ringFrames = RING_FRAMES,
  ) {}

  /** Numéro de la dernière trame captée. */
  get lastSeq(): number {
    return this.seq;
  }

  /** Une trame du micro : numérotée, datée, gardée ; envoyée tout de suite si la page est admise. */
  push(pcm: Uint8Array): void {
    const seq = ++this.seq;
    const frame = encodeMicFrame({ seq, tCapture: this.now() }, pcm);
    this.ring.push({ seq, frame });
    if (this.ring.length > this.ringFrames) this.ring.splice(0, this.ring.length - this.ringFrames);
    if (this.admitted) this.send(frame);
  }

  /** Le socket tombe ou se rouvre : plus rien ne part avant la prochaine admission. */
  detach(): void {
    this.admitted = false;
  }

  /** Le serveur confirme avoir reçu jusqu'à `seq`. */
  confirm(seq: number | null | undefined): void {
    if (typeof seq === "number" && seq > this.confirmed && seq <= this.seq) this.confirmed = seq;
  }

  /**
   * Admission (`hello`). `resumeSeq` : dernière trame que le serveur a de cette captation, absent
   * s'il ne la connaît pas. Renvoie la suite, dans l'ordre, puis reprend le direct. Rend le nombre
   * de trames renvoyées.
   */
  admit(resumeSeq?: number): number {
    const from = resumeSeq ?? this.confirmed;
    let n = 0;
    for (const f of this.ring) {
      if (f.seq <= from) continue;
      this.send(f.frame);
      n++;
    }
    this.admitted = true;
    return n;
  }
}
