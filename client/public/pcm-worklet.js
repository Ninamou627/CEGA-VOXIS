/**
 * Convertit le flux micro (Float32, à la fréquence du contexte audio) en trames PCM
 * 16 bits de 50 ms à 16 kHz — ce que la reconnaissance attend.
 *
 * Contexte à 16 kHz (réglage « convertie par le navigateur ») : conversion directe ;
 * c'est le navigateur qui rééchantillonne le micro (48 kHz en général) vers le contexte.
 * Au test 7 (D34), il jetait des paquets entiers du micro avant même ce worklet, jusqu'à
 * 26 % du son certains jours (F-03).
 *
 * Contexte à la fréquence native (D38) : le navigateur ne rééchantillonne plus rien, la
 * conversion se fait ici — passe-bas à 7,2 kHz (sinc fenêtré, phases précalculées) puis
 * lecture aux positions 16 kHz. Toute fréquence d'entrée convient (48 ou 44,1 kHz).
 *
 * 50 ms, le minimum d'AssemblyAI : le serveur ne peut demander la fin d'un tour qu'à la
 * réception d'une trame, et un blanc de 150 ms entre deux mots n'est vu en entier qu'avec
 * des trames plus courtes que lui (D25).
 *
 * Attention au transfert : une fois `frame.buffer` transféré au thread principal,
 * `frame.length` vaut 0. La taille est donc gardée à part.
 */
const OUT_RATE = 16000;

class Resampler {
  constructor(inRate) {
    this.inRate = inRate;
    this.ratio = inRate / OUT_RATE;
    /** Demi-largeur du noyau, en échantillons d'entrée (12 à 48 kHz). */
    this.half = Math.ceil(4 * this.ratio);
    /** Coupure en cycles par échantillon d'entrée : 7,2 kHz, sous le Nyquist de la sortie. */
    this.fc = 0.45 / this.ratio;
    this.buf = new Float32Array(0);
    /**
     * Position du prochain échantillon de sortie, en 1/16000ᵉ d'échantillon d'entrée : un
     * entier, qui avance de `inRate` par échantillon produit. En flottant, la position
     * dérivait d'un ulp selon la taille des blocs reçus, et deux découpages du même signal
     * ne donnaient pas les mêmes échantillons.
     */
    this.posNum = this.half * OUT_RATE;
    /** Noyau par phase, la position quantifiée au 1/64 d'échantillon : calculé une fois. */
    this.tables = new Map();
  }

  kernel(frac) {
    const key = Math.round(frac * 64);
    let t = this.tables.get(key);
    if (t) return t;
    const q = key / 64;
    const n = 2 * this.half + 1;
    t = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - this.half - q; // distance du tap à la position de sortie
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / (this.half + 1)); // Hann
      const s = x === 0 ? 1 : Math.sin(2 * Math.PI * this.fc * x) / (2 * Math.PI * this.fc * x);
      sum += t[i] = 2 * this.fc * s * win;
    }
    for (let i = 0; i < n; i++) t[i] /= sum; // gain exactement 1 en continu
    this.tables.set(key, t);
    return t;
  }

  /** Avale un bloc d'entrée ; appelle `out(v)` pour chaque échantillon à 16 kHz. */
  push(ch, out) {
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf);
    merged.set(ch, this.buf.length);
    this.buf = merged;
    let posNum = this.posNum;
    while (posNum < (this.buf.length - this.half) * OUT_RATE) {
      const base = Math.floor(posNum / OUT_RATE);
      const t = this.kernel((posNum - base * OUT_RATE) / OUT_RATE);
      let v = 0;
      for (let i = 0, j = base - this.half; i < t.length; i++, j++) v += this.buf[j] * t[i];
      out(v);
      posNum += this.inRate;
    }
    // L'entrée déjà consommée (dont le prochain échantillon n'a plus besoin) est oubliée.
    const drop = Math.min(Math.floor(posNum / OUT_RATE) - this.half, this.buf.length);
    if (drop > 0) {
      this.buf = this.buf.slice(drop);
      posNum -= drop * OUT_RATE;
    }
    this.posNum = posNum;
  }
}

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = OUT_RATE / 20; // 800 échantillons = 50 ms à 16 kHz
    this.frame = new Int16Array(this.size);
    this.n = 0;
    this.resampler = sampleRate === OUT_RATE ? null : new Resampler(sampleRate);
    this.emit = (s) => {
      const v = Math.max(-1, Math.min(1, s));
      this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.size) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(this.size);
        this.n = 0;
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.resampler) this.resampler.push(ch, this.emit);
    else for (let i = 0; i < ch.length; i++) this.emit(ch[i]);
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
