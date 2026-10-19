/**
 * Convertit le flux micro (Float32) en trames PCM 16 bits de 50 ms.
 * Le contexte audio est créé à 16 kHz : 800 échantillons par trame.
 *
 * 50 ms, le minimum d'AssemblyAI : le serveur ne peut demander la fin d'un tour qu'à la
 * réception d'une trame, et un blanc de 150 ms entre deux mots n'est vu en entier qu'avec
 * des trames plus courtes que lui (D25).
 *
 * Attention au transfert : une fois `frame.buffer` transféré au thread principal,
 * `frame.length` vaut 0. La taille est donc gardée à part.
 */
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 20);
    this.frame = new Int16Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
