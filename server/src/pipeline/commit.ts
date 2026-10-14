/**
 * Commit verrouillé + segmentation. Le cœur du système, en logique pure et testable.
 *
 * Politique LocalAgreement-2 (Macháček et al., Whisper-Streaming) : un mot n'est
 * figé que s'il apparaît à l'identique dans deux hypothèses partielles successives,
 * et jamais s'il est le dernier mot de l'hypothèse courante (les STT révisent leur
 * queue). Tout ce qui est figé est append-only : une révision tardive d'un mot déjà
 * figé est ignorée pour la voix — c'est ce que fait un interprète humain.
 *
 * Les mots figés s'accumulent dans un tampon, découpé en segments prêts à traduire
 * selon, dans l'ordre : ponctuation terminale, frontière de proposition (à partir de
 * `clauseWords`), longueur maximale, silence (endpointing du STT), timeout anti-famine.
 *
 * Quand le fournisseur marque lui-même ses mots définitifs en cours de tour (AssemblyAI
 * universal-streaming), l'accord de deux hypothèses est coupé (`agreement`) : ce moteur
 * affiche des fragments de mots en cours de prononciation (« part », « trans ») puis les
 * corrige, et l'accord les figeait — mesuré le 14/10/2026. On n'attend alors que ses mots
 * définitifs, marqués ~0,5 s après avoir été dits.
 *
 * Chaque segment est daté deux fois : `tOrigin`, première apparition de son premier mot,
 * et `tEnd`, instant où son dernier mot a fini d'être prononcé — le départ de la latence
 * qui valide le projet (D19).
 */
import type { Word } from "../providers/types";

export type FlushReason = "punctuation" | "clause" | "maxlen" | "timeout" | "silence" | "final";

/**
 * Lien avec le flux audio, quand le fournisseur horodate ses mots depuis l'ouverture du
 * flux (AssemblyAI, Deepgram, simulateur) : `spokenAt` date une position du flux à l'heure
 * serveur.
 */
export interface AudioTiming {
  spokenAt(audioMs: number): number | undefined;
}

export interface CommitConfig {
  /** Sous ce nombre de mots, seul un silence ou une ponctuation peut produire un segment. */
  minWords: number;
  /** À partir de ce nombre de mots, une virgule / un point-virgule suffit à couper. */
  clauseWords: number;
  /** Au-delà, on coupe — à la dernière frontière de proposition si elle existe. */
  maxWords: number;
  /** Durée maximale pendant laquelle des mots figés attendent avant d'être envoyés. */
  timeoutMs: number;
  /** Ne jamais figer le dernier mot de l'hypothèse courante. */
  holdLastWord: boolean;
  /**
   * Accord de deux hypothèses successives (LocalAgreement-2). Coupé quand le fournisseur
   * marque ses mots définitifs en cours de tour : seuls ceux-là sont alors figés.
   */
  agreement: boolean;
}

export const DEFAULT_COMMIT: CommitConfig = {
  minWords: 4,
  clauseWords: 12,
  maxWords: 18,
  timeoutMs: 2500,
  holdLastWord: true,
  agreement: true,
};

export interface Segment {
  text: string;
  words: Word[];
  /** Horloge serveur (ms) de la première apparition du premier mot du segment. */
  tOrigin: number;
  /**
   * Horloge serveur (ms) de la fin prononcée du dernier mot du segment. À défaut
   * d'horodatage, l'instant où ce mot est apparu pour la première fois (plus tardif :
   * la latence mesurée est alors sous-estimée, et `tEndExact` vaut false).
   */
  tEnd: number;
  tEndExact: boolean;
  reason: FlushReason;
}

export interface GateResult {
  /** Hypothèse complète courante, révisable. Pour l'écran uniquement. */
  hypothesis: string;
  /** Segments figés, prêts à traduire, dans l'ordre. */
  segments: Segment[];
}

const TERMINAL = /[.!?…]["»)\]]?$/;
const CLAUSE = /[,;:]["»)\]]?$/;

/** Comparaison des hypothèses : insensible à la casse et à la ponctuation. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export function joinWords(words: Word[]): string {
  return words.map((w) => w.text).join(" ");
}

export class CommitGate {
  private prev: Word[] = [];
  /** Nombre de mots figés dans l'énoncé courant (flushés + en tampon). */
  private committedCount = 0;
  private buf: Word[] = [];
  private bufStartedAt = 0;
  private bufOrigin = 0;
  /** Instant de première apparition de chaque index de mot de l'énoncé courant. */
  private firstSeen: number[] = [];

  constructor(
    private cfg: CommitConfig = DEFAULT_COMMIT,
    private readonly now: () => number = () => Date.now(),
    private readonly timing?: AudioTiming,
  ) {}

  /** Nouveaux seuils de segmentation, pris en compte dès le prochain mot. */
  configure(cfg: Partial<CommitConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get pendingText(): string {
    return joinWords(this.buf);
  }
  get pendingCount(): number {
    return this.buf.length;
  }

  /** Nouvelle hypothèse partielle (complète) de l'énoncé courant. */
  onPartial(words: Word[]): GateResult {
    const t = this.now();
    this.noteFirstSeen(words, t);

    let agree = 0;
    const n = Math.min(this.prev.length, words.length);
    while (agree < n && normalize(this.prev[agree].text) === normalize(words[agree].text)) agree++;

    let stable = this.cfg.agreement ? agree : 0;
    if (this.cfg.holdLastWord) stable = Math.min(stable, words.length - 1);
    if (stable < 0) stable = 0;

    // Si le fournisseur marque lui-même ses mots comme définitifs, on le croit :
    // ça fige un partiel plus tôt, sans attendre l'hypothèse suivante.
    let providerFinal = 0;
    while (providerFinal < words.length && words[providerFinal].isFinal) providerFinal++;
    if (providerFinal > stable) stable = providerFinal;

    if (stable > this.committedCount) {
      // On prend la forme de surface la plus récente (ponctuation à jour), pas celle de prev.
      this.push(words.slice(this.committedCount, stable), this.committedCount, t);
      this.committedCount = stable;
    }
    this.prev = words;
    return { hypothesis: joinWords(words), segments: this.drain() };
  }

  /** Endpointing du fournisseur : tout ce qui reste de l'énoncé est figé et envoyé. */
  onUtteranceEnd(): Segment[] {
    const t = this.now();
    if (this.prev.length > this.committedCount) {
      this.push(this.prev.slice(this.committedCount), this.committedCount, t);
      this.committedCount = this.prev.length;
    }
    const segs = this.drain("silence");
    this.reset();
    return segs;
  }

  /** Transcription finale de l'énoncé : autoritaire pour les mots non encore figés. */
  onFinal(words: Word[]): Segment[] {
    const t = this.now();
    this.noteFirstSeen(words, t);
    if (words.length > this.committedCount) {
      this.push(words.slice(this.committedCount), this.committedCount, t);
      this.committedCount = words.length;
    }
    const segs = this.drain("final");
    this.reset();
    return segs;
  }

  /** Oublie l'énoncé courant sans rien émettre (autre langue, bruit). */
  discard(): void {
    this.reset();
  }

  /** À appeler toutes les ~100 ms : flush anti-famine pour l'orateur qui ne s'arrête jamais. */
  tick(): Segment[] {
    if (this.buf.length >= this.cfg.minWords && this.now() - this.bufStartedAt >= this.cfg.timeoutMs) {
      return [this.flush(this.buf.length, "timeout")];
    }
    return [];
  }

  // ---------------------------------------------------------------------------

  private noteFirstSeen(words: Word[], t: number) {
    for (let i = this.firstSeen.length; i < words.length; i++) this.firstSeen[i] = t;
  }

  private push(words: Word[], firstIdx: number, t: number) {
    if (!words.length) return;
    if (!this.buf.length) {
      this.bufStartedAt = t;
      this.bufOrigin = this.firstSeen[firstIdx] ?? t;
    }
    this.buf.push(...words);
  }

  /** Applique les règles de coupe tant qu'elles produisent un segment ; `force` vide le reste. */
  private drain(force?: FlushReason): Segment[] {
    const out: Segment[] = [];
    for (;;) {
      const s = this.check();
      if (!s) break;
      out.push(s);
    }
    if (force && this.buf.length) out.push(this.flush(this.buf.length, force));
    return out;
  }

  private check(): Segment | undefined {
    const n = this.buf.length;
    if (!n) return;

    const iTerm = this.buf.findIndex((w) => TERMINAL.test(w.text));
    if (iTerm >= 0) return this.flush(iTerm + 1, "punctuation");

    if (n >= this.cfg.clauseWords) {
      for (let i = this.cfg.clauseWords - 1; i < n; i++) {
        if (CLAUSE.test(this.buf[i].text)) return this.flush(i + 1, "clause");
      }
    }

    if (n >= this.cfg.maxWords) {
      for (let i = this.cfg.maxWords - 1; i >= this.cfg.minWords - 1; i--) {
        if (CLAUSE.test(this.buf[i].text)) return this.flush(i + 1, "clause");
      }
      return this.flush(this.cfg.maxWords, "maxlen");
    }
    return;
  }

  private flush(count: number, reason: FlushReason): Segment {
    // Index, dans l'énoncé, du dernier mot qui part (avant de le retirer du tampon).
    const lastIdx = this.committedCount - this.buf.length + count - 1;
    const words = this.buf.splice(0, count);
    const last = words[words.length - 1];
    const spoken = last.endMs != null ? this.timing?.spokenAt(last.endMs) : undefined;
    const tEnd = spoken ?? this.firstSeen[lastIdx] ?? this.now();
    const seg: Segment = { text: joinWords(words), words, tOrigin: this.bufOrigin, tEnd, tEndExact: spoken != null, reason };
    if (this.buf.length) {
      const firstRemaining = this.committedCount - this.buf.length;
      this.bufOrigin = this.firstSeen[firstRemaining] ?? this.now();
      this.bufStartedAt = this.now();
    }
    return seg;
  }

  private reset() {
    this.prev = [];
    this.committedCount = 0;
    this.buf = [];
    this.firstSeen = [];
  }
}
