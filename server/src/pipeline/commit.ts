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
 * selon, dans l'ordre : ponctuation terminale (sauf après un titre, « Mr. »), frontière de
 * proposition (à partir de `clauseWords`), longueur maximale, silence (endpointing du STT),
 * timeout anti-famine.
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
 *
 * Le STT renvoie le tour entier à chaque message et le révise. Les mots figés ne se retrouvent
 * donc pas par leur rang, mais par alignement sur le début de la nouvelle hypothèse (D36,
 * `alignedEnd`).
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
  /** Segments du découpage réunis dans celui-ci : un morceau court parti avec la suite (D32). */
  joined?: number;
}

/**
 * Deux segments qui se suivent dans le même flux STT n'en font plus qu'un : le premier mot de
 * l'un, le dernier de l'autre (D32).
 */
export function joinSegments(a: Segment, b: Segment): Segment {
  return {
    text: `${a.text} ${b.text}`,
    words: [...a.words, ...b.words],
    tOrigin: a.tOrigin,
    tEnd: b.tEnd,
    tEndExact: b.tEndExact,
    tStart: a.tStart,
    startPos: a.startPos,
    endPos: b.endPos,
    reason: b.reason,
    joined: (a.joined ?? 1) + (b.joined ?? 1),
  };
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
/**
 * Contexte rejoué à une nouvelle session STT (D37) : autour du dernier mot parti, l'instant seul
 * ne sépare pas un mot déjà dit d'un mot nouveau, même une fois les deux sessions recalées
 * (`REPLAY_DRIFT_MS`). La fin d'un mot provisoire déborde jusqu'à ~0,6 s sur la suite (D22, D25),
 * ce qui retarde son milieu de ~0,3 s, et deux sessions ne coupent pas deux mots au même endroit.
 * Dans cette marge, de part et d'autre du milieu du dernier mot parti, un mot n'est tenu pour déjà
 * dit que si la nouvelle session y rend le texte d'un mot parti.
 */
const REPLAY_MARGIN_MS = 400;
/**
 * Deux sessions STT ne datent pas au même endroit les mots du contexte rejoué (D37). Mesuré le
 * 12/11/2026 sur la fixture, à la jonction : la session tombée avait étalé ses derniers mots vers
 * l'arrière, dans la pause qui les précédait (« Its » 1,2 s trop tôt) ; la nouvelle avait tassé ses
 * premiers mots vers le début du contexte (« is » 1,1 s trop tôt). D'une session à l'autre, un même
 * mot s'est déplacé de 0,6 à 1,1 s, et « is », dit après le dernier mot parti, semblait le précéder
 * de 0,7 s : il était perdu. Un mot que les deux sessions rendent, même texte, dans l'ordre, à moins
 * de cet écart, les recale l'une sur l'autre ; tant qu'aucun ne l'a fait, un mot n'est tenu pour
 * déjà dit par l'instant seul qu'à plus de cet écart avant le dernier mot parti.
 */
const REPLAY_DRIFT_MS = 1500;
/**
 * Le contexte rejoué commence où il peut, souvent au milieu d'un mot : la nouvelle session en
 * rend un bout (« ree » pour « three »), au texte différent. Un mot qui commence dans ses 300
 * premières ms et dont le milieu précède celui du dernier mot parti est ce mot coupé.
 */
const REPLAY_CUT_MS = 300;

const TERMINAL = /[.!?…]["»)\]]?$/;
const CLAUSE = /[,;:]["»)\]]?$/;
/**
 * Titres abrégés : leur point n'achève pas la phrase, le nom suit (D32). Le 9/11/2026,
 * « Um, hello, Mr. » est parti seul, puis « President. » : deux voix, « Monsieur, » et
 * « Président, ».
 */
const TITLE = /^(mr|mrs|ms|dr|prof|st|sr|jr|gen|gov|sen|rep|rev|capt|col|lt|sgt)\.$/i;

/** Ce mot est-il un titre abrégé (« Mr. », « Dr. ») ? */
export function isTitle(word: string): boolean {
  return TITLE.test(word);
}

/** Comparaison des hypothèses : insensible à la casse et à la ponctuation. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export function joinWords(words: Word[]): string {
  return words.map((w) => w.text).join(" ");
}

/**
 * Où s'arrêtent, dans une nouvelle hypothèse, les mots déjà figés (D36) : le rang du premier mot
 * qui ne l'est pas encore. `done` et `hyp` sont des mots sous leur forme comparée (`normalize`).
 *
 * Tant que le STT ne touche pas à ce qui est figé, c'est le nombre de mots figés. Mais il révise
 * le tour entier à chaque message : un mot retiré, ajouté ou fusionné en amont (« twenty five »
 * → « 25 » au texte définitif) décale tous les rangs suivants. Repérés par leur rang, un mot
 * retiré faisait perdre le mot suivant, un mot inséré en faisait redire un, un texte définitif
 * plus court faisait perdre le dernier mot — reproduit le 10/11/2026. Les mots figés sont donc
 * alignés sur le début de l'hypothèse (distance d'édition), et l'on reprend après le dernier.
 *
 * Entre deux alignements de même coût, on retient celui où le dernier mot figé se retrouve tel
 * quel, puis le plus proche du nombre de mots figés, puis le plus court : dans le doute, mieux
 * vaut redire un mot que d'en perdre un. `cost` : mots figés que l'hypothèse contredit.
 */
export function alignedEnd(done: readonly string[], hyp: readonly string[]): { end: number; cost: number } {
  const m = done.length;
  const n = hyp.length;
  if (!m) return { end: 0, cost: 0 };
  // Cas ordinaire : l'hypothèse commence par les mots figés, tels quels.
  let same = n >= m;
  for (let i = 0; same && i < m; i++) same = done[i] === hyp[i];
  if (same) return { end: m, cost: 0 };

  // row[j] : coût d'aligner les mots figés lus jusqu'ici sur hyp[0..j).
  let row: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const next: number[] = [i];
    for (let j = 1; j <= n; j++) {
      next[j] = Math.min(row[j - 1] + (done[i - 1] === hyp[j - 1] ? 0 : 1), row[j] + 1, next[j - 1] + 1);
    }
    row = next;
  }
  const cost = Math.min(...row);
  let end = -1;
  let endOnLast = false;
  for (let j = 0; j <= n; j++) {
    if (row[j] !== cost) continue;
    const onLast = j > 0 && hyp[j - 1] === done[m - 1];
    if (end < 0 || (onLast && !endOnLast) || (onLast === endOnLast && Math.abs(j - m) < Math.abs(end - m))) {
      end = j;
      endOnLast = onLast;
    }
  }
  return { end, cost };
}

/** Révisions du STT relevées par le découpage : ce que le rang seul aurait faussé (D36). */
export interface GateRevisions {
  /** Fois où un mot retiré ou ajouté en amont a décalé les rangs. */
  shifts: number;
  /** Mots de décalage cumulés. */
  shiftedWords: number;
  /** Mots figés que le texte définitif du tour a contredits (remplacés, retirés ou précédés d'un ajout). */
  contradicted: number;
}

export class CommitGate {
  private prev: Word[] = [];
  /** `prev` sous sa forme comparée (`normalize`), mot par mot. */
  private prevKeys: string[] = [];
  /**
   * Mots figés de l'énoncé courant (partis ou en tampon), sous leur forme comparée : le repère
   * qui dit, dans chaque nouvelle hypothèse, où reprendre (`alignedEnd`). On n'y ajoute qu'à la
   * fin : une hypothèse qui raccourcit un instant ne fait pas redire ce qu'elle a retiré.
   */
  private done: string[] = [];
  /** Rang de reprise moins nombre de mots figés : non nul dès que le STT a retiré ou ajouté un mot en amont. */
  private offset = 0;
  private revisions: GateRevisions = { shifts: 0, shiftedWords: 0, contradicted: 0 };
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
    return Math.max(0, this.prev.length - (this.done.length - this.buf.length));
  }

  /** Révisions du STT depuis le dernier relevé ; le compteur repart de zéro. */
  takeRevisions(): GateRevisions {
    const r = this.revisions;
    this.revisions = { shifts: 0, shiftedWords: 0, contradicted: 0 };
    return r;
  }

  /** Nouvelle hypothèse partielle (complète) de l'énoncé courant. */
  onPartial(words: Word[]): GateResult {
    const t = this.now();
    this.noteFirstSeen(words, t);
    const keys = words.map((w) => normalize(w.text));

    let agree = 0;
    const n = Math.min(this.prevKeys.length, keys.length);
    while (agree < n && this.prevKeys[agree] === keys[agree]) agree++;

    let stable = this.cfg.agreement ? agree : 0;
    if (this.cfg.holdLastWord) stable = Math.min(stable, words.length - 1);
    if (stable < 0) stable = 0;

    // Si le fournisseur marque lui-même ses mots comme définitifs, on le croit :
    // ça fige un partiel plus tôt, sans attendre l'hypothèse suivante.
    let providerFinal = 0;
    while (providerFinal < words.length && words[providerFinal].isFinal) providerFinal++;
    if (providerFinal > stable) stable = providerFinal;

    const from = this.resume(keys);
    if (stable > from) {
      // On prend la forme de surface la plus récente (ponctuation à jour), pas celle de prev.
      this.push(words.slice(from, stable), from, t);
    }
    this.prev = words;
    this.prevKeys = keys;
    return { hypothesis: joinWords(words), segments: this.drain() };
  }

  /** Endpointing du fournisseur : tout ce qui reste de l'énoncé est figé et envoyé. */
  onUtteranceEnd(): Segment[] {
    const t = this.now();
    const from = this.resume(this.prevKeys);
    if (this.prev.length > from) this.push(this.prev.slice(from), from, t);
    const segs = this.drain("silence");
    this.reset();
    return segs;
  }

  /** Transcription finale de l'énoncé : autoritaire pour les mots non encore figés. */
  onFinal(words: Word[]): Segment[] {
    const t = this.now();
    this.noteFirstSeen(words, t);
    const from = this.resume(words.map((w) => normalize(w.text)), true);
    if (words.length > from) this.push(words.slice(from), from, t);
    const segs = this.drain("final");
    this.reset();
    return segs;
  }

  /** Oublie l'énoncé courant sans rien émettre (autre langue, bruit). */
  discard(): void {
    this.reset();
  }

  /**
   * Nouveau flux STT : ses horodatages repartent de zéro. `replayed` : il reçoit d'abord ce que
   * le flux précédent n'avait pas rendu, précédé de quelques secondes de contexte (D37) ; ce que
   * celui-là avait fait partir ne repart pas. Sans contexte rejoué, rien ne relie les deux flux.
   */
  newStream(replayed = false): void {
    this.sent = [];
    this.replayNext = 0;
    this.replayShift = undefined;
    if (replayed) {
      this.replayedUntil = this.lastSentMid;
      // Une copie : ce que ce flux fera partir n'est pas ce qu'il réentend.
      this.replayTail = [...this.spoken];
      return;
    }
    this.spoken = [];
    this.lastSentMid = undefined;
    this.replayedUntil = undefined;
    this.replayTail = [];
  }

  /**
   * Mots partis datés à l'heure réelle (milieu prononcé, forme comparée), et le milieu du dernier
   * (D37) : ce qui relie deux flux STT quand le second reçoit les dernières secondes du premier.
   */
  private spoken: { key: string; mid: number }[] = [];
  private lastSentMid?: number;
  /** Milieu du dernier mot parti avant le flux courant, quand celui-ci a reçu un contexte rejoué. */
  private replayedUntil?: number;
  /** Mots partis avant le flux courant, quand il a reçu un contexte rejoué : ce que la nouvelle session réentend. */
  private replayTail: { key: string; mid: number }[] = [];
  /** Rang, dans `replayTail`, du mot qui suit le dernier que la nouvelle session a rendu. */
  private replayNext = 0;
  /** Datation de l'ancienne session moins celle de la nouvelle, au dernier mot rendu par les deux. */
  private replayShift?: number;

  /**
   * Déjà parti avant ce flux : un mot du contexte rejoué (D37). La nouvelle session réentend les
   * derniers mots partis : chacun qu'elle rend, même texte, dans l'ordre, ne repart pas, et l'écart
   * entre ses deux datations recale les mots suivants (`REPLAY_DRIFT_MS`). Un mot qu'elle n'a pas
   * retrouvé est jugé à l'instant, recalé : bien avant le dernier mot parti, c'est un mot déjà dit,
   * entendu autrement (« fifteen hundred » pour « 1,500 ») ; près de lui ou après, il part — dans le
   * doute, mieux vaut redire un mot que d'en perdre un. Ne repartent pas non plus le bout de mot
   * coupé au début du contexte, ni un mot relu au même endroit qu'un mot parti (D22).
   */
  private saidBefore(w: Word): boolean {
    const until = this.replayedUntil;
    if (until == null || w.startMs == null || w.endMs == null) return false;
    const mid = this.timing?.spokenAt((w.startMs + w.endMs) / 2);
    if (mid == null) return false;
    // Daté comme l'ancienne session l'aurait fait, d'après le dernier mot rendu par les deux.
    const at = mid + (this.replayShift ?? 0);
    if (at > until + REPLAY_MARGIN_MS) return false;
    if (w.startMs < REPLAY_CUT_MS && mid <= until) return true;
    const key = normalize(w.text);
    const tail = this.replayTail;
    for (let i = this.replayNext; i < tail.length; i++) {
      if (tail[i].key !== key || Math.abs(tail[i].mid - at) > REPLAY_DRIFT_MS) continue;
      this.replayNext = i + 1;
      this.replayShift = tail[i].mid - mid;
      return true;
    }
    if (tail.some((s) => s.key === key && Math.abs(s.mid - at) < SAME_WORD_MS)) return true;
    return at <= until - (this.replayShift != null ? REPLAY_MARGIN_MS : REPLAY_DRIFT_MS);
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

  /**
   * Rang, dans une hypothèse, du premier mot pas encore figé (`alignedEnd`), et relevé des
   * révisions du STT : un décalage ne compte que s'il reste des mots après la reprise — une
   * hypothèse plus courte que les mots figés n'a rien à couper. `final` : texte définitif du
   * tour, dont le désaccord avec les mots figés est compté.
   */
  private resume(keys: string[], final = false): number {
    const { end, cost } = alignedEnd(this.done, keys);
    const offset = end - this.done.length;
    if (end < keys.length && offset !== this.offset) {
      this.revisions.shifts++;
      this.revisions.shiftedWords += Math.abs(offset - this.offset);
      this.offset = offset;
    }
    if (final) this.revisions.contradicted += cost;
    return end;
  }

  private push(words: Word[], firstIdx: number, t: number) {
    words.forEach((w, k) => {
      // Figé, qu'il parte ou non : la prochaine hypothèse reprendra après lui.
      this.done.push(normalize(w.text));
      // Déjà parti dans un segment, de ce flux ou du précédent : jamais deux fois aux apprenants.
      if (this.alreadySent(w) || this.saidBefore(w)) return;
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

    const iTerm = this.buf.findIndex((b) => TERMINAL.test(b.w.text) && !isTitle(b.w.text));
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
    for (const w of words) {
      if (w.startMs == null || w.endMs == null) continue;
      this.sent.push(w);
      // À l'heure réelle, pour le flux suivant s'il reçoit ces secondes en contexte (D37).
      const mid = this.timing?.spokenAt((w.startMs + w.endMs) / 2);
      if (mid == null) continue;
      this.spoken.push({ key: normalize(w.text), mid });
      if (this.lastSentMid == null || mid > this.lastSentMid) this.lastSentMid = mid;
    }
    if (this.sent.length > SENT_KEPT) this.sent.splice(0, this.sent.length - SENT_KEPT);
    if (this.spoken.length > SENT_KEPT) this.spoken.splice(0, this.spoken.length - SENT_KEPT);
    const seg: Segment = { text: joinWords(words), words, tOrigin: this.bufOrigin, tEnd, tEndExact: spoken != null, tStart, startPos, endPos, reason };
    if (this.buf.length) {
      this.bufOrigin = this.firstSeen[this.buf[0].i] ?? this.now();
      this.bufStartedAt = this.now();
    }
    return seg;
  }

  private reset() {
    this.prev = [];
    this.prevKeys = [];
    this.done = [];
    this.offset = 0;
    this.buf = [];
    this.firstSeen = [];
    this.holdUntil = 0;
  }
}
