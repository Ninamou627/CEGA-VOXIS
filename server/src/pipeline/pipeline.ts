/**
 * Orchestration : audio → STT → commit → traduction → TTS, une fois par langue cible.
 *
 * Par langue, deux files ordonnées (D39, F-06) : la traduction du segment suivant part
 * pendant que la voix de celui-ci se synthétise, au lieu d'attendre dans la même chaîne.
 * La diffusion garde l'ordre des segments (la file des voix est série), un retard se voit
 * immédiatement dans `backlog` au lieu de se cacher dans de la concurrence, et c'est aussi
 * une contre-pression naturelle. Avant D39, un seul appel lent (traduction OU voix)
 * retardait tous les segments suivants des deux étages.
 */
import type { MicFrameInfo } from "../../../shared/framing";
import type { DegradedMode, Lang, PipelineStatus } from "../../../shared/protocol";
import type { Metrics } from "../metrics";
import type { Providers, SttStream, Word } from "../providers/types";
import { TypedEmitter } from "../util/emitter";
import { AudioClock } from "./audio-clock";
import { PauseDetector } from "./pause";
import { MAX_SPEED, Tempo } from "./tempo";
import { LagControl, type LagState, type LagTier } from "./lagcontrol";
import { checkTightened } from "./tighten";
import { LiveProsody, ProsodyFeed } from "../prosody";
import { VoiceProfile, type SegmentProsody } from "./voice-profile";
import { CommitGate, DEFAULT_COMMIT, isTitle, joinSegments, type CommitConfig, type Segment } from "./commit";

/** Réglages de l'administration relus en cours de séance. */
export interface PipelineTuning {
  commit: Partial<CommitConfig>;
  /** Segments précédents fournis au traducteur pour la continuité. */
  contextSegments: number;
  /**
   * Vitesse de la voix choisie par l'administration. Quand la voix suit le débit du formateur,
   * elle multiplie la vitesse calculée ; sinon, le rattrapage de la dérive s'y multiplie.
   */
  baseSpeed: number;
  /** Chaque segment dit dans le temps que le formateur a mis à le dire (D26). */
  followTempo: boolean;
  /** Seuil de parole de l'administration (dBFS) : en dessous, le formateur se tait. */
  speechThresholdDb: number;
  /** Premier morceau d'une prise de parole coupé au premier blanc entre deux mots (D25). */
  quickStart: boolean;
  /** Un morceau de trois mots ou moins part avec la suite, sauf vraie pause de l'orateur (D32). */
  joinShort: boolean;
  /** Un morceau qui s'arrête au milieu d'une phrase attend la suite et part avec elle (D33). */
  wholeSentences: boolean;
  /** Formulation resserrée dès 5 s de retard (D42), si un moteur sait le faire. Éteint par défaut. */
  tightenWhenLate?: boolean;
}

/** Ce que l'étage traduction passe à l'étage voix (D39). */
interface Translated {
  text: string;
  mtMs: number;
  ending: "continues" | "ends" | "unknown" | null;
  pauseAfterMs: number | null;
  readyAt: number;
  /** La formulation resserrée a été retenue (D42). */
  tightened: boolean;
}

export interface PipelineConfig {
  srcLang: Lang;
  targetLangs: Lang[];
  sampleRate: number;
  tuning?: () => PipelineTuning;
}

const DEFAULT_TUNING: PipelineTuning = { commit: {}, contextSegments: 2, baseSpeed: 1, followTempo: true, speechThresholdDb: -35, quickStart: true, joinShort: true, wholeSentences: true };
/**
 * Silence du formateur au-delà duquel on demande au STT de clore le tour en cours (D22) :
 * une phrase longue part en morceaux, chacun livré ~0,3 s après son dernier mot, au lieu
 * d'attendre le délai de coupe (~2 s). Les silences entre deux mots durent moins de 150 ms ;
 * 200 et 300 ms ont donné le même découpage sur la fixture.
 */
const FORCE_PAUSE_MS = 250;
/**
 * Formulation resserrée (D42) : elle a au plus 1,5 s de plus que la traduction normale. Elle ne
 * part qu'au-delà de 5 s de retard : la voix attendra de toute façon, ce délai ne s'entend pas.
 */
const TIGHTEN_GRACE_MS = 1500;
/** Le texte définitif arrive 0,17 à 0,55 s après la commande (mesuré) : le délai de coupe l'attend. */
const FORCE_HOLD_MS = 1000;
/** Parole minimale depuis la dernière coupe avant d'en demander une autre : ~4 mots. */
const MIN_SPEECH_MS = 1200;
/**
 * Premier morceau d'une prise de parole (D25). La salle n'entend rien tant que le premier
 * segment n'est pas dit : 2,7 s en médiane le 19/10/2026, plus de la moitié du délai ressenti.
 * Il part donc au premier blanc entre deux mots (120 ms : un « p » au milieu d'un mot en dure
 * 100, un blanc entre deux mots 140 à 160 sur l'enregistrement mesuré), après ~3 mots.
 * Ensuite, les règles ordinaires : quand la salle écoute déjà, couper plus court ne fait rien
 * entendre plus tôt et prive la traduction de contexte.
 */
const QUICK_PAUSE_MS = 120;
const QUICK_MIN_SPEECH_MS = 800;
/** Au-delà de ce qu'il reste à jouer sur les téléphones, un premier morceau court n'avancerait rien. */
const QUICK_IDLE_MS = 1500;
/**
 * Phrase finie ou phrase qui continue (D27). Quand le serveur clôt un tour pendant une pause,
 * AssemblyAI met un point même là où le formateur avait une virgule, et la voix française
 * conclut une phrase qui continue. Ni la mélodie de la voix (−3,3 demi-tons en fin de virgule
 * comme de phrase, voix de synthèse) ni la ponctuation du STT ne les distinguent ; la pause,
 * mesurée sur l'audio, si : 0 à 800 ms après une virgule, 540 ms et plus après un point, sur
 * deux cours enregistrés. Le formateur a repris avant 600 ms : la phrase continue.
 */
const CONTINUE_PAUSE_MS = 600;
/**
 * Morceau court (D32) : trois mots ou moins, ou fini sur un titre (« Mr. »). Il attend la suite
 * et part avec elle quand l'orateur a repris avant 600 ms — la pause qui achève une phrase
 * (D27) —, 1,5 s après un titre, dont le nom suit presque toujours ; sinon, il part seul. Le
 * 9/11/2026, 27 à 43 % des segments faisaient trois mots ou moins, dits chacun à part :
 * « Euh, bonjour, Monsieur, » puis « Président, ». Rejoué sur les quatre séances du 8 et du
 * 9/11 : 43 morceaux courts sur 111 segments → 25 ; 11 segments partent plus tard, de 2,6 s en
 * médiane, 3,9 s au plus.
 */
const SHORT_WORDS = 3;
const JOIN_PAUSE_MS = CONTINUE_PAUSE_MS;
const TITLE_PAUSE_MS = 1500;
/** Un morceau retenu n'attend jamais plus : au-delà, c'est la suite qui tarde (délai de coupe, 4 s). */
const HOLD_MAX_MS = 4000;
/**
 * Phrase coupée au milieu (D33). Le STT clôt un tour à chaque hésitation de l'orateur (D22,
 * pauses de 250 ms) : le 9/11/2026, 20 voix sur 46 s'arrêtaient au milieu d'une phrase
 * (« C'est vraiment un honneur de »… silence… « J'étudie le marketing à »…), chacune traduite
 * et dite à part, l'intonation repartant de zéro. Un morceau sans ponctuation finale, ou fini
 * sur une hésitation ou sur un mot qui annonce la suite (« to », « the », « and »…, même suivi
 * du point qu'ajoute une coupe forcée), attend la suite tant que l'orateur reprend avant 2,5 s,
 * 8 s au plus depuis le premier morceau retenu. Rejoué sur la séance : 20 → 3 voix coupées,
 * 29 voix au lieu de 46 ; 13 voix partent plus tard, de 2,9 s en médiane, 7 s au plus.
 */
const MID_PAUSE_MS = 2500;
const MID_HOLD_MAX_MS = 8000;
/** Mots qui ne finissent pas une phrase anglaise, même suivis d'un point (coupe forcée, D27). */
const OPEN_END = new Set([
  "and", "or", "but", "because", "the", "a", "an", "of", "to", "in", "on", "with", "for", "at", "by", "from", "into",
  "than", "if", "our", "your", "their", "its", "my", "about",
]);
/**
 * Auxiliaires et modaux : « the truth is the world is. », « in a place where it can. » (D34).
 * Au test 7, ces faux points cassaient le sens (« le monde est ainsi, » / « il peut l'être, »).
 * Sur les deux séances étiquetées avec le texte officiel, aucune vraie fin de phrase n'y finit.
 */
const AUXILIARIES = new Set(["is", "are", "was", "were", "am", "can", "could", "will", "would", "should", "must", "shall", "may", "might"]);
const FILLERS = new Set(["uh", "um", "er", "erm", "uhm", "hmm", "mm"]);
/** Un segment qui finit sur l'un de ces mots n'est pas fini, quelle que soit la pause. */
const DANGLING = new Set([
  "and", "or", "but", "because", "so", "the", "a", "an", "of", "to", "in", "on", "with", "for", "that", "which", "who",
  "is", "are", "was", "were", "will", "would", "can", "could", "if", "as", "at", "by", "from", "than", "into",
  "our", "your", "their", "its", "my", "this", "these", "those",
]);
/** Cadence à laquelle on demande aux fournisseurs s'ils ont besoin d'être réchauffés (D20). */
const WARM_EVERY_MS = 5000;
/**
 * Silence entre deux segments au-delà duquel le second ouvre une nouvelle prise de parole :
 * la salle n'entend plus rien, et ce qui compte est le temps avant le premier son.
 */
const TURN_GAP_MS = 1500;
/**
 * Audio gardé en attendant que le STT (r)ouvre, ou que la page réadmise renvoie son tampon de
 * 30 s (D37). Mesuré le 11/11/2026 : une panne de 20 s du STT ne le rouvre qu'après 25 s (recul
 * 1, 2, 4, 8 s) ; 15 s en jetaient 10. Au-delà, c'est une panne, et le plus ancien cède la place.
 */
const PENDING_MAX_MS = 40_000;
/**
 * Relève de la session STT (D37). AssemblyAI ferme une session au bout de 3 h (3008), au milieu
 * d'une phrase s'il le faut, et ce qu'il n'avait pas encore rendu est perdu. Passé 2 h 50, la
 * session est remplacée pendant une pause où plus rien n'attend : rien en vol, rien à perdre.
 */
const STT_ROTATE_AFTER_MS = 170 * 60_000;
const ROTATE_PAUSE_MS = 600;
const ROTATE_RETRY_MS = 60_000;
/**
 * Contexte rejoué à une nouvelle session STT en cours de captation, avant ce que la précédente
 * n'avait pas rendu (D37). Mesuré le 11/11/2026 :
 * une session neuve qui commence sur « liters per minute at 1,500 revolutions per minute » y
 * entend du français (confiance 0,81) et le garde-fou de langue écarte la phrase ; précédée des
 * 2 à 3 s d'avant, elle entend de l'anglais et rend la phrase entière. Les mots de ce contexte,
 * déjà partis, ne repartent pas (`CommitGate.saidBefore`).
 */
const WARMUP_MS = 3000;
/**
 * Ce qu'une nouvelle session reçoit de la précédente, au plus (D37) : la parole que celle-ci
 * n'avait pas encore rendue, précédée de `WARMUP_MS` de contexte. Mesuré le 11/11/2026 : une
 * session coupée du réseau à 30 s n'avait pas rendu ses 3,5 dernières secondes ; les 3 s
 * rejouées n'en couvraient que la fin, sans amorce en anglais, et 9 mots se sont perdus
 * (« A10VSO, and it was installed on March 14, 2019. »). Le même jour, une liaison figée vers
 * le STT a retenu jusqu'à 30 s d'audio dans la connexion. Au-delà de 40 s, le plus ancien cède.
 */
const REPLAY_MAX_MS = 40_000;
/**
 * Arrêt du micro : ce que le STT a reçu sans l'avoir encore rendu arrive encore, et part (D37).
 * Mesuré le 11/11/2026 sur AssemblyAI U3.5 Pro : après `Terminate`, il rend tout ce qu'il a reçu,
 * au rythme où il le transcrit, puis envoie `Termination` — le dernier tour 0,2 s après Terminate
 * en temps réel, 21,5 s après une rafale de 30 s. Fermé en 200 ms, le flux perdait ce retard : la
 * fin du texte quand le formateur s'arrêtait peu après une coupure de 20 s.
 *
 * L'attente est bornée par ce qui reste à entendre — l'audio envoyé au-delà du dernier mot rendu
 * et du silence qui le suit, au rythme du temps réel (le STT rattrape plus vite : ×1,2 à 1,3
 * mesuré) — plus une marge.
 */
const DRAIN_MARGIN_MS = 5000;
const DRAIN_MAX_MS = 60_000;
/**
 * Relève (D37) : le STT doit avoir rendu la parole d'avant la pause, sinon l'ancienne session
 * emporterait ce retard. Ses fins de mots précèdent de peu la fin d'énergie que voit `PauseDetector`.
 */
const CAUGHT_UP_SLACK_MS = 1500;

export interface PipelineEvents extends Record<string, unknown> {
  "src.partial": { text: string };
  "src.commit": {
    seq: number;
    text: string;
    tOrigin: number;
    tEnd: number;
    /** Début prononcé du premier mot (horloge serveur). */
    tStart: number;
    /** Premier segment d'une prise de parole. */
    turnStart: boolean;
    reason: string;
    confidence?: number;
    /** Flux STT qui a reconnu le segment, et ses mots datés dans ce flux (enregistreur). */
    stream: number;
    words: Word[];
    /** La voix du formateur sur ce segment, comparée à ses habitudes (D28). */
    prosody?: SegmentProsody;
  };
  /** Le micro du formateur démarre ou s'arrête. */
  mic: { on: boolean };
  /** Un flux STT vient de s'ouvrir : ses horodatages partent de la prochaine trame. */
  /**
   * `warmupMs` : audio rejoué en tête du flux — ce que le flux d'avant n'avait pas rendu, et son
   * contexte —, la fin de ce qui est déjà enregistré (D37).
   */
  "stt.stream": { stream: number; warmupMs: number };
  /** Une trame transmise au STT, telle quelle. */
  "stt.audio": { pcm: Uint8Array };
  /**
   * Ce que le STT vient d'envoyer, tel quel (enregistreur) : hypothèse du tour, texte définitif,
   * fin de tour ou tour écarté. De quoi rejouer le découpage hors ligne, mot pour mot (D36).
   */
  "stt.turn": { stream: number; kind: "partial" | "final" | "end" | "discard"; words: Word[] };
  "tr.segment": { seq: number; lang: Lang; text: string; srcSeq: number; untranslated?: boolean };
  audio: {
    seq: number;
    lang: Lang;
    mime: string;
    durMs: number;
    tOrigin: number;
    srcSeq: number;
    text: string;
    bytes: Uint8Array;
    voice?: string;
    /** Silence du formateur avant ce segment, que le téléphone reprend en partie (D26). */
    pauseMs?: number;
  };
  degraded: { mode: DegradedMode; reason: string };
  /** Le palier du contrôleur de retard d'une langue change (D42). */
  lag: { lang: Lang; tier: LagTier; from: LagTier; retardMs: number };
  status: PipelineStatus;
  error: { stage: "stt" | "mt" | "tts"; error: Error };
}

export class Pipeline extends TypedEmitter<PipelineEvents> {
  private gate: CommitGate;
  /** Relie les horodatages de mots du STT à l'heure où le formateur les a prononcés. */
  private clock: AudioClock;
  /** Silences du formateur : le moment où clore un tour sans couper un mot (D22). */
  private pause: PauseDetector;
  /** La pause en cours a déjà servi à clore un tour. */
  private forcedThisPause = false;
  private stt?: SttStream;
  /** Flux du formateur qui s'arrête, le temps qu'il rende son retard (`DRAIN_*`) : ses tours comptent encore. */
  private draining?: SttStream;
  /** Fin du dernier mot rendu par le flux (ms du flux) : jusqu'où le STT a entendu. */
  private heardMs = 0;
  /** Le même, prolongé du silence qui suit ce mot (`heardThrough`). */
  private heardThroughMs = 0;
  private seq = 0;
  private muted = false;
  private tickTimer?: NodeJS.Timeout;
  /** Par langue, la file des traductions : celle du segment suivant part pendant la voix (D39). */
  private mtChains = new Map<Lang, Promise<unknown>>();
  /** Par langue, la file des synthèses : la diffusion garde l'ordre des segments. */
  private ttsChains = new Map<Lang, Promise<void>>();
  private context = new Map<Lang, { src: string; tgt: string }[]>();
  private backlog = 0;
  private degraded: DegradedMode = "none";
  private degradedReason = "";
  private started = false;
  private speed = 1;
  /** Flux STT ouverts depuis le lancement : chacun a ses propres horodatages. */
  private streams = 0;
  /** Fin prononcée du segment précédent, depuis le démarrage du micro. */
  private prevEnd?: number;
  /** Une prise de parole commence : son premier morceau n'est pas encore coupé. */
  private turnOpen = true;
  /** Par langue, l'heure estimée où les téléphones auront fini de jouer ce qui leur a été envoyé. */
  private roomFreeAt = new Map<Lang, number>();
  /** Débit de la voix traduite, appris segment après segment (D26). */
  private tempo = new Tempo();
  /** Contrôleur du retard de chaque langue (D42). */
  private lag = new LagControl();
  private ticks = 0;
  /** Hauteur et énergie de la voix du formateur, analysées au fil de l'audio (D28). */
  private live: LiveProsody;
  /**
   * L'alimente par tranches bornées (D39) : le rejeu d'une réouverture STT, passé d'un bloc
   * par l'analyse, figeait la boucle d'événements jusqu'à 3,4 s, pour toutes les salles.
   */
  private liveFeed: ProsodyFeed;
  /** Ses habitudes depuis le démarrage du micro, auxquelles chaque segment se compare. */
  private voice: VoiceProfile;
  /** Morceau court qui attend la suite (D32) ; `since` : depuis quand, pour ne pas attendre sans fin. */
  private held?: { seg: Segment; stream: number; since: number };

  constructor(
    private readonly providers: Providers,
    private readonly cfg: PipelineConfig,
    private readonly metrics: Metrics,
  ) {
    super();
    this.clock = new AudioClock(cfg.sampleRate);
    this.pause = new PauseDetector(cfg.sampleRate);
    this.live = new LiveProsody(cfg.sampleRate);
    this.liveFeed = new ProsodyFeed(this.live, cfg.sampleRate);
    this.voice = new VoiceProfile(cfg.srcLang);
    this.gate = new CommitGate(this.commitConfig(), undefined, {
      spokenAt: (ms) => this.clock.spokenAt(ms),
      speechEnd: (ms) => this.pause.speechEnd(ms),
      speechStart: (ms) => this.pause.speechStart(ms),
    });
  }

  private get tuning(): PipelineTuning {
    return this.cfg.tuning?.() ?? DEFAULT_TUNING;
  }

  /** Segmentation de l'administration ; un fournisseur qui marque ses mots définitifs se passe de l'accord. */
  private commitConfig(): CommitConfig {
    return { ...DEFAULT_COMMIT, ...this.tuning.commit, agreement: !this.providers.stt.finalWords };
  }

  /** L'administration a changé la segmentation : prise en compte dès le prochain mot. */
  retune(): void {
    this.gate.configure(this.commitConfig());
  }

  get status(): PipelineStatus {
    return {
      stt: this.providers.stt.name,
      mt: this.providers.mt.name,
      tts: this.providers.tts.name,
      backlog: this.backlog,
      muted: this.muted,
      degraded: this.degraded,
      speed: this.speed,
      lag: Object.keys(this.lag.snapshot()).length ? this.lag.snapshot() : undefined,
    };
  }

  /**
   * Retard de la file d'une langue (D42) : combien de temps une voix prête maintenant attendrait
   * avant d'être entendue. Le modèle du serveur (chaque voix occupe la salle pendant sa durée) ou
   * les accusés des téléphones (ack + leur file, médiane), le plus grand des deux : le modèle
   * ignore les pauses gardées, les téléphones lents et les nouveaux essais (D40).
   */
  private retardMs(lang: Lang): number {
    const free = Math.max(this.roomFreeAt.get(lang) ?? 0, this.metrics.phonesFreeAt(lang) ?? 0);
    return Math.max(0, free - Date.now());
  }

  /**
   * Palier du contrôleur pour une langue, réévalué maintenant ; un changement est journalisé et
   * diffusé. `rise` faux : relevé de chaque seconde, qui ne fait que descendre (voir LagControl).
   */
  private lagTier(lang: Lang, rise = true): LagState {
    const retardMs = this.retardMs(lang);
    const { tier, from } = this.lag.update(lang, retardMs, rise);
    if (tier !== from) {
      this.metrics.event("lag.tier", { lang, from, to: tier, retardMs: Math.round(retardMs) });
      this.emit("lag", { lang, tier, from, retardMs: Math.round(retardMs) });
      this.emitStatus();
    }
    return this.lag.get(lang);
  }

  /**
   * Rattrapage de la dérive (§09 de la revue), quand la voix ne suit pas le débit du formateur.
   * La langue cible est plus longue que la source ; sans parade, la file des clients grandit
   * dès que l'orateur ne fait pas de pause. Quand la file médiane mesurée dans les acks
   * s'allonge, la voix accélère, jusqu'au plafond de la synthèse (×1,1, D32). Le téléphone ne
   * saute plus rien : le reste du retard se résorbe pendant les pauses de l'orateur.
   */
  private speedForQueue(queueMs: number | null): number {
    if (queueMs == null || queueMs < 2000) return 1;
    if (queueMs < 4000) return 1.08;
    if (queueMs < 6000) return 1.15;
    return 1.25;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.accepting = true;
    // Sans captation identifiée, rien ne dit que ce micro continue le précédent : pas de contexte (D37).
    if (!this.capture) {
      this.recent = [];
      this.recentBytes = 0;
    }
    this.prevEnd = undefined;
    this.turnOpen = true;
    this.voice = new VoiceProfile(this.cfg.srcLang);
    this.metrics.micReset();
    this.emit("mic", { on: true });
    // Les connexions vers la traduction et la voix s'ouvrent pendant que le STT se connecte,
    // et restent chaudes pendant les pauses du formateur (D20).
    this.warmProviders(true);
    this.warmTimer = setInterval(() => this.warmProviders(false), WARM_EVERY_MS);
    try {
      await this.openStt();
    } catch (error) {
      // Le STT refuse ou ne répond pas (plafond de sessions, réseau) : l'audio attend dans le
      // tampon et l'on réessaie avec recul. Sans cela, le micro restait ouvert sans reconnaissance.
      this.emit("error", { stage: "stt", error: error as Error });
      if (this.started) {
        this.setDegraded("stt-lost", `reconnaissance vocale injoignable — ${(error as Error).message.slice(0, 160)}`);
        this.scheduleSttRestart();
      }
    }
    if (!this.started) return; // arrêté pendant l'ouverture
    this.tickTimer = setInterval(() => {
      this.handle(this.gate.tick());
      this.checkHeld();
      // Le retard se résorbe aussi sans nouveau segment (pause de l'orateur) : réévalué chaque seconde.
      if (++this.ticks % 10 === 0) for (const lang of this.cfg.targetLangs) this.lagTier(lang, false);
    }, 100);
    this.emitStatus();
  }

  private warmTimer?: NodeJS.Timeout;

  /** Chaque fournisseur ne réchauffe que s'il est resté inactif (ou toujours, avec `force`). */
  private warmProviders(force: boolean) {
    void this.providers.mt.warm?.(force).catch(() => {});
    void this.providers.tts.warm?.(force).catch(() => {});
  }

  /**
   * `drain: false` : fermer le STT sans attendre ce qu'il n'a pas encore rendu. Pour l'arrêt du
   * serveur : Docker le tue 10 s après SIGTERM, et la salle se déconnecte avant d'entendre la suite.
   */
  async stop(opts: { drain?: boolean } = {}): Promise<void> {
    this.started = false;
    this.accepting = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const s = this.stt;
    this.stt = undefined;
    // Micro arrêté : ce qui attendait le STT n'a plus de destinataire.
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingDroppedMs = 0;
    this.audio.buffered = 0;
    if (s) await this.closeStt(s, opts.drain ?? true);
    // Ce qui restait de la dernière phrase part ; le prochain démarrage du micro repart de
    // zéro, sans hériter des mots (ni de leurs instants) de cette prise.
    this.handle(this.gate.onUtteranceEnd());
    this.releaseHeld();
    // Micro arrêté : plus rien à rattraper ni d'alerte à donner au formateur.
    this.lag.reset();
    this.emit("mic", { on: false });
    this.emitStatus();
  }

  /**
   * Ferme le flux du formateur qui s'arrête, après l'avoir laissé rendre ce qu'il a reçu
   * (`DRAIN_*`) : ses tours arrivent pendant l'attente et partent comme les autres.
   */
  private async closeStt(s: SttStream, drain: boolean): Promise<void> {
    if (!drain) {
      await s.close();
      return;
    }
    const behindMs = Math.max(0, this.clock.audioMs - this.heardThrough());
    const waitMs = Math.min(DRAIN_MAX_MS, behindMs + DRAIN_MARGIN_MS);
    const t0 = Date.now();
    this.draining = s;
    const complete = await s.close(waitMs).catch(() => false);
    if (this.draining === s) this.draining = undefined;
    this.metrics.event("stt.drain", { behindMs: Math.round(behindMs), waitMs: Math.round(waitMs), ms: Date.now() - t0, complete: complete === true });
  }

  /** Les tours de ce flux comptent : c'est le flux en cours, ou celui qui rend son retard. */
  private hears(stream: SttStream): boolean {
    return stream === this.stt || stream === this.draining;
  }

  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;

  /** Ouverture de la session STT en cours, pour la relever avant la limite de 3 h. */
  private sttOpenedAt = 0;
  private rotating = false;
  /** Sessions tombées (erreur ou fermeture) : une relève refusée ne rend pas la main à l'une d'elles. */
  private lost = new WeakSet<SttStream>();

  private async openStt(): Promise<void> {
    const stream = await this.providers.stt.start(
      { lang: this.cfg.srcLang, sampleRate: this.cfg.sampleRate },
      {
        onPartial: (p) => {
          if (!this.hears(stream)) return; // session remplacée
          for (const w of p.words) if (w.endMs != null && w.endMs > this.heardMs) this.heardMs = w.endMs;
          this.emit("stt.turn", { stream: this.streams, kind: p.isFinal ? "final" : "partial", words: p.words });
          if (p.isFinal) {
            this.handle(this.gate.onFinal(p.words));
          } else {
            const r = this.gate.onPartial(p.words);
            this.emit("src.partial", { text: r.hypothesis });
            this.handle(r.segments);
          }
        },
        onUtteranceEnd: () => {
          if (!this.hears(stream)) return;
          this.emit("stt.turn", { stream: this.streams, kind: "end", words: [] });
          this.handle(this.gate.onUtteranceEnd());
          // Le STT a clos le tour de lui-même : la parole se recompte à partir d'ici.
          this.pause.cut();
          // Une fin de tour reçue pendant un long silence clôt la parole d'avant, pas la prochaine.
          if (this.pause.silence < TURN_GAP_MS) this.turnOpen = false;
        },
        onDiscard: () => {
          if (!this.hears(stream)) return;
          this.emit("stt.turn", { stream: this.streams, kind: "discard", words: [] });
          this.gate.discard();
          this.emit("src.partial", { text: "" });
        },
        onError: (error) => {
          this.emit("error", { stage: "stt", error });
          this.lost.add(stream);
          if (this.stt !== stream) return;
          // Session STT perdue : on le dit à la salle, et on rouvre avec un léger recul.
          this.stt = undefined;
          this.handle(this.gate.onUtteranceEnd());
          this.releaseHeld();
          this.setDegraded("stt-lost", `reconnaissance vocale interrompue — ${error.message.slice(0, 160)}`);
          this.scheduleSttRestart();
        },
      },
    );
    // Le micro s'est arrêté pendant l'ouverture : personne pour ce flux, il ne doit pas rester ouvert.
    if (!this.started) {
      void stream.close().catch(() => {});
      return;
    }
    // Le nouveau flux reçoit d'abord ce que le flux d'avant avait reçu sans le rendre, précédé de
    // 3 s de contexte pour la reconnaissance (D37). Ce qui en était déjà parti ne repart pas
    // (`CommitGate.saidBefore`) ; le reste part, comme s'il venait d'être dit.
    this.trimRecent();
    const warm = this.recent;
    const behindMs = warm.length ? Math.max(0, warm[warm.length - 1].end - this.heardThrough()) : 0;
    this.gate.newStream(warm.length > 0);
    this.clock.reset();
    this.heardMs = 0;
    this.heardThroughMs = 0;
    this.pause.reset();
    this.liveFeed.reset();
    // Un flux qui rendait encore son retard s'efface : ses mots se mêleraient à ceux du nouveau.
    this.draining = undefined;
    this.stt = stream;
    this.sttOpenedAt = Date.now();
    const warmupMs = Math.round((warm.reduce((a, f) => a + f.pcm.byteLength, 0) * 1000) / 2 / this.cfg.sampleRate);
    this.emit("stt.stream", { stream: ++this.streams, warmupMs });
    for (const f of warm) {
      stream.sendAudio(f.pcm);
      this.clock.push(f.pcm.byteLength, f.at);
      this.pause.push(f.pcm, this.tuning.speechThresholdDb);
      this.liveFeed.push(f.pcm);
      // Rejouées, les trames restent à rejouer si ce flux tombe à son tour : datées dans celui-ci.
      f.end = this.clock.audioMs;
    }
    if (warm.length) {
      // Une fin de tour forcée attend de la parole neuve : le contexte reste dans le même tour qu'elle.
      this.pause.cut();
      this.metrics.event("stt.warmup", { ms: warmupMs, behindMs: Math.round(behindMs) });
    }
    this.restartAttempts = 0;
    if (this.degraded === "stt-lost") this.setDegraded("none", "reconnaissance vocale rétablie");
    this.flushPending();
  }

  private scheduleSttRestart() {
    if (!this.started || this.restartTimer) return;
    const delay = Math.min(10_000, 1000 * 2 ** this.restartAttempts++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.started) return;
      this.openStt().catch((error: Error) => {
        this.emit("error", { stage: "stt", error });
        this.scheduleSttRestart();
      });
    }, delay);
  }

  /**
   * Compteurs de diagnostic : trames reçues du formateur, transmises au STT, dernière réception ;
   * et, pour les trames numérotées (D37), celles reçues deux fois, celles jamais reçues, celles
   * en attente que le STT rouvre, et les millisecondes jetées faute de STT au-delà de 15 s.
   */
  readonly audio = { received: 0, forwarded: 0, bytes: 0, lastAt: 0, duplicates: 0, missing: 0, buffered: 0, dropped: 0 };
  /** Captation en cours (identifiant de la page) et dernier numéro de trame reçu. */
  private capture?: { id: string; lastSeq: number };
  /**
   * Un formateur est admis : son audio est attendu, même si le pipeline n'a pas encore démarré.
   * Après une liaison figée (D35), la page réadmise renvoie son tampon pendant que l'ancienne
   * prise s'arrête encore (fermeture du STT : 200 ms chez AssemblyAI) ; ces trames étaient
   * jetées, et comptées comme reçues, donc jamais rattrapées.
   */
  private accepting = false;
  /**
   * Trames reçues pendant que le STT n'est pas ouvert : au démarrage du micro (la page envoie dès
   * son admission, le flux s'ouvre en ~0,5 s) et pendant une réouverture après panne (1 à 10 s).
   * Elles partaient à la poubelle (`pushAudio` ignorait tout sans STT) : des mots perdus. Elles
   * attendent désormais et partent d'un bloc à l'ouverture. Mesuré le 11/11/2026 : AssemblyAI
   * U3.5 Pro accepte une rafale de 6,5 s d'audio et la transcrit en 2,3 s, sans fermer la session.
   */
  private pending: { pcm: Uint8Array; at: number }[] = [];
  private pendingBytes = 0;
  /** Ce que l'attente en cours a dû jeter, faute de place (ms). */
  private pendingDroppedMs = 0;

  /**
   * Un formateur vient d'être admis : son audio est attendu dès maintenant. Même captation
   * (liaison reprise) : rend la dernière trame déjà reçue, pour que la page ne renvoie que la
   * suite. Captation inconnue (page rouverte, ou serveur redémarré) : les numéros repartent, rien
   * n'est rendu.
   */
  setCapture(id: string | undefined): number | undefined {
    this.accepting = true;
    if (id && this.capture?.id === id) return this.capture.lastSeq;
    // Autre captation : son audio n'a rien à voir avec celui d'avant, pas de contexte à rejouer.
    this.recent = [];
    this.recentBytes = 0;
    this.capture = id ? { id, lastSeq: 0 } : undefined;
    return undefined;
  }

  /** Dernière trame reçue de la captation en cours, confirmée à la page par les stats. */
  get micSeq(): number | null {
    return this.capture?.lastSeq ?? null;
  }

  /** Au-delà, l'attente est une panne, pas une réouverture : on garde les plus récentes. */
  private get maxPendingBytes(): number {
    return (PENDING_MAX_MS / 1000) * this.cfg.sampleRate * 2;
  }

  /**
   * Une trame du micro. `info` (trame numérotée, D37) : une trame déjà reçue est écartée, une
   * trame qui saute des numéros compte celles qui manquent, et l'instant de captation date la
   * parole — sans jamais être postérieur à la réception.
   */
  pushAudio(pcm: Uint8Array, info?: MicFrameInfo): void {
    const now = Date.now();
    this.audio.lastAt = now;
    // Personne n'attend cet audio (formateur parti) : la trame ne compte pas comme reçue, et la
    // même trame renvoyée plus tard ne sera pas prise pour un doublon.
    if (!this.accepting) return;
    let at = now;
    if (info && this.capture) {
      const c = this.capture;
      if (c.lastSeq && info.seq <= c.lastSeq) {
        this.audio.duplicates++;
        return;
      }
      if (c.lastSeq && info.seq > c.lastSeq + 1) {
        const missing = info.seq - c.lastSeq - 1;
        this.audio.missing += missing;
        const ms = Math.round((missing * pcm.byteLength * 1000) / 2 / this.cfg.sampleRate);
        this.metrics.audioGap(ms);
        this.metrics.event("audio.gap", { frames: missing, ms, seq: info.seq });
      }
      c.lastSeq = info.seq;
      if (Number.isFinite(info.tCapture)) {
        this.metrics.uplink(Math.max(0, now - info.tCapture));
        at = Math.min(now, info.tCapture);
      }
    }
    this.audio.received++;
    this.audio.bytes += pcm.byteLength;
    if (this.muted) return;
    if (!this.stt) {
      this.pending.push({ pcm, at });
      this.pendingBytes += pcm.byteLength;
      let dropped = 0;
      while (this.pendingBytes > this.maxPendingBytes) {
        const old = this.pending.shift()!;
        this.pendingBytes -= old.pcm.byteLength;
        dropped += old.pcm.byteLength;
      }
      // Panne trop longue : le plus ancien ne sera jamais reconnu. Il se compte comme un trou.
      if (dropped) {
        const ms = Math.round((dropped * 1000) / 2 / this.cfg.sampleRate);
        this.audio.dropped += ms;
        this.pendingDroppedMs += ms;
        this.metrics.audioGap(ms);
      }
      this.audio.buffered = this.pending.length;
      return;
    }
    this.forward(pcm, at);
  }

  /** Les trames reçues pendant que le STT était fermé partent d'un bloc, dans l'ordre. */
  private flushPending() {
    const frames = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.audio.buffered = 0;
    if (frames.length) {
      const ms = Math.round((frames.reduce((a, f) => a + f.pcm.byteLength, 0) * 1000) / 2 / this.cfg.sampleRate);
      this.metrics.event("audio.flush", { frames: frames.length, ms, droppedMs: this.pendingDroppedMs });
    }
    this.pendingDroppedMs = 0;
    for (const f of frames) this.forward(f.pcm, f.at);
  }

  private forward(pcm: Uint8Array, at: number) {
    if (!this.stt) return;
    this.audio.forwarded++;
    this.metrics.audio(pcm);
    this.stt.sendAudio(pcm);
    this.liveFeed.push(pcm);
    this.emit("stt.audio", { pcm });
    this.clock.push(pcm.byteLength, at);
    const silentMs = this.pause.push(pcm, this.tuning.speechThresholdDb);
    this.remember(pcm, at, silentMs >= this.msOf(pcm.byteLength) - 0.01);
    this.endTurnOnPause(silentMs);
  }

  private msOf(bytes: number): number {
    return (bytes * 1000) / 2 / this.cfg.sampleRate;
  }

  /**
   * Ce que le flux en cours a reçu et qu'il faudrait rejouer au suivant (D37) : tout ce qui suit
   * son dernier mot rendu — la parole qu'il n'a pas encore rendue —, plus `WARMUP_MS` de
   * contexte ; `REPLAY_MAX_MS` au plus. `end` : position dans le flux à la fin de la trame ;
   * `silent` : la trame entière sous le seuil de parole.
   */
  private recent: { pcm: Uint8Array; at: number; end: number; silent: boolean }[] = [];
  private recentBytes = 0;
  private remember(pcm: Uint8Array, at: number, silent: boolean) {
    this.recent.push({ pcm, at, end: this.clock.audioMs, silent });
    this.recentBytes += pcm.byteLength;
    this.trimRecent();
  }

  /** Oublie ce qui précède de plus de `WARMUP_MS` ce que le STT a tout rendu, et ce qui dépasse `REPLAY_MAX_MS`. */
  private trimRecent() {
    const keep = (WARMUP_MS / 1000) * this.cfg.sampleRate * 2;
    const max = (REPLAY_MAX_MS / 1000) * this.cfg.sampleRate * 2;
    const from = this.heardThrough() - WARMUP_MS;
    while (this.recent.length > 1) {
      const rest = this.recentBytes - this.recent[0].pcm.byteLength;
      if (rest < keep || (rest < max && this.recent[0].end > from)) break;
      this.recentBytes -= this.recent.shift()!.pcm.byteLength;
    }
  }

  /**
   * Jusqu'où le flux a tout rendu (ms du flux) : son dernier mot rendu, et le silence qui le suit,
   * qui n'a pas de mots à rendre. Sans ce silence, une session tombée au milieu d'une longue pause
   * rejouerait toute la pause, et la parole d'après arriverait d'autant en retard.
   */
  private heardThrough(): number {
    let heard = Math.max(this.heardMs, this.heardThroughMs);
    const r = this.recent;
    let i = 0;
    while (i < r.length && r[i].end <= heard) i++;
    // Le tampon ne remonte plus jusque-là (STT en retard de plus de `REPLAY_MAX_MS`) : rien ne dit
    // ce qu'il y avait entre les deux.
    if (i === 0 && r.length && r[0].end - this.msOf(r[0].pcm.byteLength) > heard) return heard;
    for (; i < r.length && r[i].silent; i++) heard = r[i].end;
    // Gardé : ce silence quitte le tampon quand il dépasse `WARMUP_MS`, et reste entendu.
    this.heardThroughMs = heard;
    return heard;
  }

  /**
   * Pendant une pause du formateur, après au moins ~4 mots de parole depuis la dernière coupe,
   * on demande au STT de clore le tour : ces mots partent aussitôt, au lieu d'attendre le délai
   * de coupe. Une fois par pause. `silentMs` : silence en cours à la fin de la trame.
   */
  private endTurnOnPause(silentMs: number) {
    if (silentMs === 0) {
      this.forcedThisPause = false;
      return;
    }
    if (silentMs >= ROTATE_PAUSE_MS && this.rotationDue(silentMs)) {
      void this.rotateStt();
      return;
    }
    // Un silence assez long pour que la salle ait tout entendu : la prochaine parole ouvre une
    // prise de parole, et seule elle compte pour son premier morceau.
    if (silentMs >= TURN_GAP_MS && !this.turnOpen) {
      this.turnOpen = true;
      this.pause.cut();
    }
    if (this.forcedThisPause || !this.stt?.forceEndpoint) return;
    const quick = this.turnOpen && this.tuning.quickStart && this.roomIdleSoon();
    if (silentMs < (quick ? QUICK_PAUSE_MS : FORCE_PAUSE_MS)) return;
    const speechMs = this.pause.speechSinceCut;
    if (speechMs < (quick ? QUICK_MIN_SPEECH_MS : MIN_SPEECH_MS)) return;
    this.forcedThisPause = true;
    this.turnOpen = false;
    this.pause.cut();
    this.gate.holdTimeout(FORCE_HOLD_MS);
    this.stt.forceEndpoint();
    this.metrics.event("endpoint", { speechMs: Math.round(speechMs), words: this.gate.unsentCount, silentMs: Math.round(silentMs), quick });
  }

  /**
   * La session approche de la limite, et rien n'attend : ni parole que le STT n'a pas encore rendue
   * (retard après une coupure), ni mot à figer, ni morceau retenu.
   */
  private rotationDue(silentMs: number): boolean {
    return (
      !!this.stt &&
      !this.rotating &&
      Date.now() - this.sttOpenedAt >= STT_ROTATE_AFTER_MS &&
      Date.now() >= this.rotateRetryAt &&
      this.heardMs >= this.clock.audioMs - silentMs - CAUGHT_UP_SLACK_MS &&
      this.gate.unsentCount === 0 &&
      !this.held
    );
  }

  /** Après une relève refusée, la suivante attend : la session en place sert encore. */
  private rotateRetryAt = 0;

  /**
   * Relève : l'audio attend la nouvelle session dans le tampon, l'ancienne se ferme ensuite. Si la
   * nouvelle est refusée, l'ancienne reprend le tampon : il lui reste dix minutes avant la limite.
   */
  private async rotateStt(): Promise<void> {
    const old = this.stt;
    if (!old) return;
    this.rotating = true;
    this.stt = undefined;
    this.metrics.event("stt.rotate", { ageMs: Date.now() - this.sttOpenedAt });
    try {
      await this.openStt();
      void old.close().catch(() => {});
    } catch (error) {
      this.emit("error", { stage: "stt", error: error as Error });
      this.rotateRetryAt = Date.now() + ROTATE_RETRY_MS;
      if (!this.started || this.stt) void old.close().catch(() => {});
      else if (!this.lost.has(old)) {
        this.stt = old;
        this.flushPending();
      } else {
        // L'ancienne est tombée pendant la tentative : plus de session du tout, on rouvre avec recul.
        this.setDegraded("stt-lost", `reconnaissance vocale interrompue — ${(error as Error).message.slice(0, 160)}`);
        this.scheduleSttRestart();
      }
    } finally {
      this.rotating = false;
    }
  }

  /** Les téléphones auront fini, ou presque, quand le premier morceau sera prêt. */
  private roomIdleSoon(): boolean {
    const busyUntil = Math.max(0, ...this.roomFreeAt.values());
    return this.backlog === 0 && busyUntil - Date.now() < QUICK_IDLE_MS;
  }

  get sttOpen(): boolean {
    return Boolean(this.stt);
  }

  /**
   * Audio en attente d'envoi vers le STT (ms). Au-delà d'une seconde, la connexion montante
   * du poste ne suit plus : la reconnaissance reçoit la parole en retard, quoi qu'il arrive
   * ensuite chez le fournisseur.
   */
  get sttBacklogMs(): number {
    const bytes = this.stt?.backlogBytes?.() ?? 0;
    return Math.round((bytes / 2 / this.cfg.sampleRate) * 1000);
  }

  /**
   * Sourdine du formateur. Pendant la sourdine, le STT ne reçoit plus rien : dans son flux,
   * l'audio d'avant et celui d'après se touchent. Le 07/11/2026, des mots dits juste avant une
   * sourdine sont restés en attente au STT, puis sont partis 20 minutes plus tard avec la
   * première phrase d'après, datée de la sourdine (« parole » de 1 208 s, voix à ×0,85).
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      // Ce qui a été dit part maintenant, au lieu d'attendre la reprise.
      this.releaseHeld();
      if (this.pause.speechSinceCut > 0) {
        this.pause.cut();
        this.stt?.forceEndpoint?.();
      }
    } else {
      // La salle a tout entendu pendant la sourdine : la reprise ouvre une prise de parole.
      this.resumedAt = Date.now();
      this.turnOpen = true;
    }
    this.emitStatus();
  }

  /** Fin de la dernière sourdine : un segment entendu depuis n'a pas commencé avant. */
  private resumedAt?: number;

  /** Signalement externe (ex. bascule du TTS de secours). */
  reportDegraded(mode: DegradedMode, reason: string): void {
    this.setDegraded(mode, reason);
  }

  // ---------------------------------------------------------------------------

  private handle(segments: Segment[]) {
    for (const s of segments) this.join(s);
  }

  /**
   * Un segment sort du découpage : un morceau court (D32) ou une phrase coupée au milieu (D33)
   * attend la suite, le reste part.
   */
  private join(seg: Segment) {
    const h = this.held;
    let since = Date.now();
    if (h) {
      this.held = undefined;
      if (h.stream === this.streams && seg.tStart - h.seg.tEnd < this.joinPauseMs(h.seg) && since - h.since < this.holdMaxMs(h.seg)) {
        // Le point d'une phrase coupée n'en est pas un : la traduction doit lire une seule phrase (D34).
        const head = this.midSentence(h.seg) ? { ...h.seg, text: h.seg.text.replace(/\.\s*$/, "") } : h.seg;
        seg = joinSegments(head, seg);
        since = h.since;
      } else {
        this.dispatch(h.seg, since - h.since);
      }
    }
    if (this.holds(seg)) this.held = { seg, stream: this.streams, since };
    else this.dispatch(seg, Date.now() - since);
  }

  private holds(seg: Segment): boolean {
    if (!this.started || this.muted) return false;
    if (this.midSentence(seg)) return true;
    if (!this.tuning.joinShort) return false;
    return seg.words.length <= SHORT_WORDS || this.endsOnTitle(seg);
  }

  private endsOnTitle(seg: Segment): boolean {
    const last = seg.words.at(-1)?.text;
    return last != null && isTitle(last);
  }

  /** La phrase n'est pas finie : pas de ponctuation finale, hésitation, ou mot qui annonce la suite (D33). */
  private midSentence(seg: Segment): boolean {
    if (!this.tuning.wholeSentences || this.cfg.srcLang !== "en") return false;
    const text = seg.text.trim();
    if (/[?!]["”»)]*$/.test(text)) return false;
    if (!/[.…]["”»)]*$/.test(text)) return true;
    const last = (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).at(-1);
    return last != null && (OPEN_END.has(last) || AUXILIARIES.has(last) || FILLERS.has(last));
  }

  private joinPauseMs(seg: Segment): number {
    if (this.endsOnTitle(seg)) return TITLE_PAUSE_MS;
    return this.midSentence(seg) ? MID_PAUSE_MS : JOIN_PAUSE_MS;
  }

  private holdMaxMs(seg: Segment): number {
    return this.midSentence(seg) ? MID_HOLD_MAX_MS : HOLD_MAX_MS;
  }

  /** Le morceau retenu part seul : l'orateur a vraiment marqué une pause, ou la suite tarde. */
  private checkHeld() {
    const h = this.held;
    if (!h) return;
    if (h.stream !== this.streams || this.muted || h.seg.endPos == null || Date.now() - h.since >= this.holdMaxMs(h.seg)) return this.releaseHeld();
    const p = this.pause.pauseAfter(h.seg.endPos);
    if (p && p.ms >= this.joinPauseMs(h.seg)) this.releaseHeld();
  }

  private releaseHeld() {
    const h = this.held;
    this.held = undefined;
    if (h) this.dispatch(h.seg, Date.now() - h.since);
  }

  /** `heldMs` : temps passé à attendre la suite (D32, D33), journalisé avec la coupe. */
  private dispatch(seg: Segment, heldMs = 0) {
    // Un segment qui finit après la reprise commence au plus tôt à la reprise : collé dans le
    // flux à l'audio d'avant la sourdine, son premier mot y serait daté.
    if (this.resumedAt != null && seg.tEnd >= this.resumedAt && seg.tStart < this.resumedAt) seg = { ...seg, tStart: this.resumedAt };
    const seq = ++this.seq;
    const tCommit = Date.now();
    // Confiance moyenne du moteur de reconnaissance sur les mots du segment, s'il la donne.
    const conf = seg.words.map((w) => w.confidence).filter((c): c is number => typeof c === "number");
    const confidence = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : undefined;
    // Le formateur se taisait avant ce segment : il ouvre une prise de parole.
    const gapMs = this.prevEnd != null ? seg.tStart - this.prevEnd : null;
    const turnStart = gapMs == null || gapMs > TURN_GAP_MS;
    this.prevEnd = Math.max(this.prevEnd ?? 0, seg.tEnd);
    // Le premier segment de la prise de parole est parti, par quelque chemin que ce soit.
    if (turnStart) this.turnOpen = false;
    // La voix du formateur sur ce segment (D28) : l'audio du flux en cours, entre ses bornes réelles.
    let prosody: SegmentProsody | undefined;
    if (seg.startPos != null && seg.endPos != null) {
      // L'analyse a pu être mise en file (rejeu d'une réouverture, D39) : complétée jusqu'à
      // la fin du segment avant de le décrire — le STT, plus lent qu'elle, arrive après.
      this.liveFeed.drainTo(seg.endPos);
      prosody = this.voice.describe(this.live.between(seg.startPos, seg.endPos), seg.startPos, seg.endPos, seg.words, seg.text, this.tuning.speechThresholdDb);
    }
    this.emit("src.commit", {
      seq,
      text: seg.text,
      tOrigin: seg.tOrigin,
      tEnd: seg.tEnd,
      tStart: seg.tStart,
      turnStart,
      reason: seg.reason,
      confidence,
      stream: this.streams,
      words: seg.words,
      prosody,
    });
    this.metrics.stage("commit", tCommit - seg.tOrigin);
    // Fin prononcée → segment figé : la part de la reconnaissance dans la latence de D19.
    this.metrics.stage("endCommit", tCommit - seg.tEnd);
    // Début de chaque mot depuis le début du segment, d'après le STT : le décalage se mesure mot
    // par mot (D41). Null si un mot n'est pas daté.
    const base = seg.startPos ?? seg.words[0]?.startMs;
    const wordStarts = base != null && seg.words.length && seg.words.every((w) => w.startMs != null) ? seg.words.map((w) => Math.max(0, Math.round(w.startMs! - base))) : null;
    this.metrics.segmentEnd(seq, { tOrigin: seg.tOrigin, tEnd: seg.tEnd, tStart: seg.tStart, turnStart, words: seg.words.length, wordStarts });
    // Retard d'affichage du STT : du premier mot prononcé à sa première apparition.
    const first = seg.words[0]?.endMs;
    const firstSpoken = first != null ? this.clock.spokenAt(first) : undefined;
    const sttLagMs = firstSpoken != null ? seg.tOrigin - firstSpoken : null;
    if (sttLagMs != null) this.metrics.stage("sttLag", sttLagMs);
    // Révisions du STT depuis le segment précédent : ce que le découpage a dû réaligner (D36).
    const revised = this.gate.takeRevisions();
    this.metrics.event("commit", {
      sttLagMs,
      seq,
      tOrigin: seg.tOrigin,
      commitMs: tCommit - seg.tOrigin,
      tEnd: seg.tEnd,
      endCommitMs: tCommit - seg.tEnd,
      tEndExact: seg.tEndExact,
      tStart: seg.tStart,
      turnStart,
      gapMs,
      words: seg.words.length,
      wordStarts,
      reason: seg.reason,
      joined: seg.joined ?? 1,
      heldMs: Math.round(heldMs),
      sttShifts: revised.shifts,
      sttShiftedWords: revised.shiftedWords,
      sttContradicted: revised.contradicted,
      confidence: confidence != null ? Math.round(confidence * 1000) / 1000 : null,
      voice: prosody
        ? {
            arousal: prosody.arousal,
            rate: prosody.rate,
            rateZ: prosody.rateZ,
            rangeZ: prosody.rangeZ,
            energyZ: prosody.energyZ,
            finalMoveSt: prosody.finalMoveSt,
            emphasized: prosody.emphasized,
          }
        : null,
    });

    for (const lang of this.cfg.targetLangs) {
      this.backlog++;
      // Deux files ordonnées (D39) : la traduction s'enchaîne derrière la précédente, la voix
      // derrière la précédente ET derrière sa propre traduction. Un appel lent ne bloque plus
      // que sa file ; l'ordre de diffusion reste celui des segments.
      const prevMt = this.mtChains.get(lang) ?? Promise.resolve();
      const translated = prevMt
        .then(() => this.translateStage(seq, seg, lang, this.streams))
        .catch((error: Error) => {
          this.emit("error", { stage: "mt", error });
          return undefined;
        });
      this.mtChains.set(lang, translated);
      const prevTts = this.ttsChains.get(lang) ?? Promise.resolve();
      const next = Promise.all([prevTts, translated])
        .then(([, tr]) => (tr ? this.speakStage(seq, seg, lang, tr, gapMs, turnStart) : undefined))
        .catch((error: Error) => this.emit("error", { stage: "tts", error }))
        .finally(() => {
          this.backlog--;
          this.emitStatus();
        });
      this.ttsChains.set(lang, next);
    }
    this.emitStatus();
  }

  /**
   * La phrase continue-t-elle après ce segment (D27) ? Lu au retour de la traduction, ~0,7 s
   * après le début de la pause : on sait déjà si le formateur a repris. `unknown` si la pause
   * dure encore sans avoir atteint le seuil, ou si le flux STT a changé depuis.
   */
  private sentenceGoesOn(seg: Segment, stream: number): { verdict: "continues" | "ends" | "unknown"; pauseMs: number | null } {
    const last = (seg.text.toLowerCase().match(/[\p{L}']+/gu) ?? []).at(-1);
    if (this.cfg.srcLang === "en" && last && DANGLING.has(last)) return { verdict: "continues", pauseMs: null };
    if (seg.endPos == null || stream !== this.streams) return { verdict: "unknown", pauseMs: null };
    const p = this.pause.pauseAfter(seg.endPos);
    if (!p) return { verdict: "unknown", pauseMs: null };
    if (p.ms < CONTINUE_PAUSE_MS) return { verdict: p.ongoing ? "unknown" : "continues", pauseMs: Math.round(p.ms) };
    return { verdict: "ends", pauseMs: Math.round(p.ms) };
  }

  /**
   * Étage traduction (file MT, D39) : moteur, verdict « la phrase continue » (D27), contexte
   * de séance. Rend `undefined` quand la traduction a échoué : le texte source est déjà
   * affiché, il n'y aura pas de voix pour ce segment.
   */
  private async translateStage(
    seq: number,
    seg: Segment,
    lang: Lang,
    stream: number,
  ): Promise<Translated | undefined> {
    const ctx = this.context.get(lang) ?? [];
    const t0 = Date.now();
    const req = { text: seg.text, from: this.cfg.srcLang, to: lang, context: ctx };
    // Formulation resserrée (D42) : 5 s de retard ou plus, et l'administration l'a permis. Elle
    // part en même temps que la traduction normale, qui reste la référence et le recours.
    const mt = this.providers.mt;
    const tight =
      this.tuning.tightenWhenLate && mt.tighten && this.lagTier(lang).tier >= 2
        ? mt.tighten(req).then(
            (t): { text?: string; error?: string; ms: number } => ({ text: t, ms: Date.now() - t0 }),
            (e: Error) => ({ error: e.message.slice(0, 160), ms: Date.now() - t0 }),
          )
        : undefined;

    let text: string;
    try {
      text = await mt.translate(req);
    } catch (error) {
      this.emit("error", { stage: "mt", error: error as Error });
      // Mieux vaut le texte source à l'écran que rien : pas de voix pour ce segment.
      this.emit("tr.segment", { seq, lang, text: seg.text, srcSeq: seq, untranslated: true });
      this.setDegraded("text-only", `traduction indisponible — ${(error as Error).message.slice(0, 200)}`);
      return undefined;
    }
    let tMt = Date.now();
    this.metrics.stage("mt", tMt - t0);
    let tightened = false;
    if (tight) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<{ error: string; ms: number }>((resolve) => {
        timer = setTimeout(() => resolve({ error: "trop lente", ms: Date.now() - t0 }), TIGHTEN_GRACE_MS);
      });
      const r: { text?: string; error?: string; ms: number } = await Promise.race([tight, late]);
      clearTimeout(timer);
      const check = r.text != null ? checkTightened(text, r.text, lang) : undefined;
      tightened = Boolean(check?.ok);
      this.metrics.event("tighten", {
        seq,
        lang,
        used: tightened,
        reason: r.error ?? check?.reason ?? null,
        normalChars: text.length,
        tightChars: r.text?.length ?? null,
        ms: r.ms,
        numbers: check?.numbers ?? null,
        names: check?.names ?? null,
        negations: check?.negations ?? null,
      });
      if (tightened) text = r.text!;
      tMt = Date.now();
    }
    // Le point d'une phrase qui continue redevient une virgule : la voix ne conclut pas (D27).
    const goesOn = /[.]\s*$/.test(seg.text) ? this.sentenceGoesOn(seg, stream) : { verdict: "unknown" as const, pauseMs: null };
    if (goesOn.verdict === "continues") text = text.replace(/\.\s*$/, ",");
    this.emit("tr.segment", { seq, lang, text, srcSeq: seq });

    ctx.push({ src: seg.text, tgt: text });
    const keep = this.tuning.contextSegments;
    while (ctx.length > keep) ctx.shift();
    this.context.set(lang, ctx);
    return { text, mtMs: tMt - t0, ending: /[.]\s*$/.test(seg.text) ? goesOn.verdict : null, pauseAfterMs: goesOn.pauseMs, readyAt: Date.now(), tightened };
  }

  /**
   * Étage voix (file TTS, D39) : vitesse, synthèse, diffusion. Il commence quand sa traduction
   * est prête ET que la voix du segment précédent est partie — `chainWaitMs` mesure cette
   * seconde attente, celle que l'audit demande de surveiller (p95 < 0,2 s).
   */
  private async speakStage(
    seq: number,
    seg: Segment,
    lang: Lang,
    tr: Translated,
    gapMs: number | null,
    turnStart: boolean,
  ): Promise<void> {
    const tSpeak = Date.now();
    const chainWaitMs = Math.max(0, tSpeak - tr.readyAt);
    const text = tr.text;
    try {
      const queueMs = this.metrics.snapshot().queueP50Ms;
      const aheadMs = Math.max(0, (this.roomFreeAt.get(lang) ?? 0) - Date.now());
      // Dès 3 s de retard (D42, palier 1) : plus de pause gardée, débit porté vers ×1,1.
      const lag = this.lagTier(lang);
      const catchUp = lag.tier >= 1;
      const sourceMs = seg.tEnd - seg.tStart;
      let speed: number;
      let tempo: { predictedMs: number; budgetMs: number; target: number } | undefined;
      if (this.tuning.followTempo) {
        // Le segment dans le temps du formateur, file des téléphones comprise (D26).
        // Après un long silence, la pause n'appartient pas au temps du segment : la salle l'a déjà eue.
        const d = this.tempo.speedFor(lang, { chars: text.length, sourceMs, gapMs: turnStart ? null : gapMs, aheadMs, preference: this.tuning.baseSpeed, catchUp });
        speed = d.speed;
        tempo = d;
      } else {
        // La vitesse choisie par l'administration, et le rattrapage de la dérive par-dessus.
        const drift = this.speedForQueue(queueMs);
        speed = catchUp ? MAX_SPEED : Math.min(MAX_SPEED, Math.max(0.7, this.tuning.baseSpeed * drift));
      }
      if (speed !== this.speed) {
        this.speed = speed;
        this.emitStatus();
      }
      const a = await this.providers.tts.synthesize({ text, lang, speed, continuation: true });
      const tTts = Date.now();
      this.metrics.stage("tts", tTts - tSpeak);
      this.tempo.learn(lang, text.length, a.durMs, speed);
      this.metrics.voice(seq, lang, a.durMs);
      this.roomFreeAt.set(lang, Math.max(this.roomFreeAt.get(lang) ?? 0, tTts) + a.durMs);
      this.emit("audio", {
        seq,
        lang,
        mime: a.mime,
        durMs: a.durMs,
        tOrigin: seg.tOrigin,
        srcSeq: seq,
        text,
        bytes: a.audio,
        voice: a.voice,
        // En retard, la pause du formateur n'est plus rendue : le téléphone enchaîne (D42).
        pauseMs: gapMs != null && !catchUp ? Math.max(0, Math.round(gapMs)) : undefined,
      });
      this.metrics.event("segment", {
        seq,
        lang,
        tOrigin: seg.tOrigin,
        mtMs: tr.mtMs,
        ttsMs: tTts - tSpeak,
        chainWaitMs: Math.round(chainWaitMs),
        readyMs: tTts - seg.tOrigin,
        endReadyMs: tTts - seg.tEnd,
        durMs: a.durMs,
        chars: text.length,
        speed,
        targetSpeed: tempo?.target ?? null,
        voice: a.voice ?? null,
        queueMs,
        sourceMs,
        gapMs,
        aheadMs,
        predictedMs: tempo?.predictedMs ?? null,
        budgetMs: tempo?.budgetMs ?? null,
        ending: tr.ending,
        pauseAfterMs: tr.pauseAfterMs,
        lagTier: lag.tier,
        retardMs: lag.retardMs,
        tightened: tr.tightened,
      });
      if (this.degraded === "text-only") this.setDegraded("none", "synthèse rétablie");
    } catch (error) {
      this.emit("error", { stage: "tts", error: error as Error });
      // Le motif réel doit arriver jusqu'au tableau de bord : un 402 ne se devine pas.
      this.setDegraded("text-only", `synthèse vocale indisponible — ${(error as Error).message.slice(0, 200)}`);
    }
  }

  private setDegraded(mode: DegradedMode, reason: string) {
    if (this.degraded === mode && this.degradedReason === reason) return;
    this.degraded = mode;
    this.degradedReason = reason;
    this.emit("degraded", { mode, reason });
    this.metrics.degraded(mode, reason);
    this.emitStatus();
  }

  private emitStatus() {
    this.emit("status", this.status);
  }
}

export type { Word };
