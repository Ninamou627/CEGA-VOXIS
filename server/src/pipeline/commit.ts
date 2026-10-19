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
  /** Recale la fin d'un mot sur la fin réelle de la parole (silence qui suit), si elle est connue. */
  speechEnd?(audioMs: number): number;
  /** Recale le début d'un mot sur le début réel de la parole (silence qui précède). */
  speechStart?(audioMs: number): number;
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
  // Filet de sécurité pour l'orateur qui ne s'arrête pas : les phrases longues se coupent à
  // leurs pauses (D22), ~0,3 s après le dernier mot ; une coupe au délai en coûte ~2 à 3 s.
  // À 2,5 s, le délai tranchait encore la phrase juste avant sa pause (4 segments sur 17).
  timeoutMs: 4000,
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
  /**
   * Horloge serveur (ms) du début prononcé du premier mot : le départ du « début de parole →
   * premier son », ce que l'apprenant ressent. À défaut d'horodatage, `tOrigin` (plus tardif).
   */
  tStart: number;
  /** Début et fin réels de la parole, en positions du flux STT (recalées sur l'audio) : la pause qui suit (D27) et la voix du segment (D28) s'y lisent. */
  startPos?: number;
  endPos?: number;
  reason: FlushReason;
}

export interface GateResult {
  /** Hypothèse complète courante, révisable. Pour l'écran uniquement. */
  hypothesis: string;
  /** Segments figés, prêts à traduire, dans l'ordre. */
  segments: Segment[];
}

/**
 * Deux occurrences d'un même mot dont les milieux sont à moins de cet écart sont le même mot
 * relu par le STT ; au-delà, c'est une vraie répétition (« no, no »), qui dure un mot (~0,3 s).
 */
const SAME_WORD_MS = 250;
/** Mots envoyés gardés en mémoire : largement de quoi couvrir un tour repris. */
const SENT_KEPT = 60;

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
  /** Mots figés pas encore partis, avec leur position dans l'énoncé (`i`). */
  private buf: { w: Word; i: number }[] = [];
  private bufStartedAt = 0;
  private bufOrigin = 0;
  /** Instant de première apparition de chaque index de mot de l'énoncé courant. */
  private firstSeen: number[] = [];
  /**
   * Derniers mots envoyés, avec leurs horodatages, pour le flux STT en cours. Après une fin de
   * tour forcée (D22), le STT reprend parfois au tour suivant des mots déjà partis (mesuré) :
   * un mot de même texte, au même endroit de l'audio, n'est pas envoyé une seconde fois. Le
   * texte compte autant que l'instant : les horodatages des derniers mots d'une hypothèse sont
   * provisoires, et une comparaison sur l'instant seul écartait des mots nouveaux (mesuré).
   */
  private sent: Word[] = [];
  /** Une fin de tour a été demandée au STT : le délai de coupe attend son texte définitif. */
  private holdUntil = 0;

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
    return joinWords(this.buf.map((b) => b.w));
  }
  get pendingCount(): number {
    return this.buf.length;
  }
  /** Mots de l'énoncé courant pas encore partis en segment, hypothèse non figée comprise. */
  get unsentCount(): number {
    return Math.max(0, this.prev.length - (this.committedCount - this.buf.length));
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

  /** Nouveau flux STT : ses horodatages repartent de zéro. */
  newStream(): void {
    this.sent = [];
  }

  /** Ce mot est-il déjà parti (même texte, au même endroit de l'audio) ? */
  private alreadySent(w: Word): boolean {
    if (w.startMs == null || w.endMs == null) return false;
    const mid = (w.startMs + w.endMs) / 2;
    const text = normalize(w.text);
    return this.sent.some((s) => normalize(s.text) === text && Math.abs((s.startMs! + s.endMs!) / 2 - mid) < SAME_WORD_MS);
  }

  /**
   * Une fin de tour vient d'être demandée au STT (D22) : pendant `ms`, le délai de coupe ne
   * tranche pas la phrase — le texte définitif, qui arrive en ~0,3 s, la coupera à la pause.
   */
  holdTimeout(ms: number): void {
    this.holdUntil = this.now() + ms;
  }

  /** À appeler toutes les ~100 ms : flush anti-famine pour l'orateur qui ne s'arrête jamais. */
  tick(): Segment[] {
    if (this.now() < this.holdUntil) return [];
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
    words.forEach((w, k) => {
      // Déjà parti dans un segment : jamais deux fois aux apprenants.
      if (this.alreadySent(w)) return;
      if (!this.buf.length) {
        this.bufStartedAt = t;
        this.bufOrigin = this.firstSeen[firstIdx + k] ?? t;
      }
      this.buf.push({ w, i: firstIdx + k });
    });
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

    const iTerm = this.buf.findIndex((b) => TERMINAL.test(b.w.text));
    if (iTerm >= 0) return this.flush(iTerm + 1, "punctuation");

    if (n >= this.cfg.clauseWords) {
      for (let i = this.cfg.clauseWords - 1; i < n; i++) {
        if (CLAUSE.test(this.buf[i].w.text)) return this.flush(i + 1, "clause");
      }
    }

    if (n >= this.cfg.maxWords) {
      for (let i = this.cfg.maxWords - 1; i >= this.cfg.minWords - 1; i--) {
        if (CLAUSE.test(this.buf[i].w.text)) return this.flush(i + 1, "clause");
      }
      return this.flush(this.cfg.maxWords, "maxlen");
    }
    return;
  }

  private flush(count: number, reason: FlushReason): Segment {
    const entries = this.buf.splice(0, count);
    const words = entries.map((b) => b.w);
    const last = entries[entries.length - 1];
    const endPos = last.w.endMs != null ? (this.timing?.speechEnd?.(last.w.endMs) ?? last.w.endMs) : undefined;
    const spoken = endPos != null ? this.timing?.spokenAt(endPos) : undefined;
    const tEnd = spoken ?? this.firstSeen[last.i] ?? this.now();
    const startPos = words[0].startMs != null ? (this.timing?.speechStart?.(words[0].startMs) ?? words[0].startMs) : undefined;
    const started = startPos != null ? this.timing?.spokenAt(startPos) : undefined;
    const tStart = Math.min(started ?? this.bufOrigin, tEnd);
    for (const w of words) if (w.startMs != null && w.endMs != null) this.sent.push(w);
    if (this.sent.length > SENT_KEPT) this.sent.splice(0, this.sent.length - SENT_KEPT);
    const seg: Segment = { text: joinWords(words), words, tOrigin: this.bufOrigin, tEnd, tEndExact: spoken != null, tStart, startPos, endPos, reason };
    if (this.buf.length) {
      this.bufOrigin = this.firstSeen[this.buf[0].i] ?? this.now();
      this.bufStartedAt = this.now();
    }
    return seg;
  }

  private reset() {
    this.prev = [];
    this.committedCount = 0;
    this.buf = [];
    this.firstSeen = [];
    this.holdUntil = 0;
  }
}
