/**
 * Garde de lecture d'un segment sur la page apprenant (D40, F-08). Partagée pour être testée
 * hors navigateur, comme `playback.ts`.
 *
 * Avant : le lecteur passait à la voix suivante sur `onerror` et sur un `play()` refusé, sans
 * rien dire à personne ; et rien ne gardait la lecture : un élément audio qui ne finit jamais
 * (ni `ended`, ni `error`) bloquait toute la file, et le téléphone se taisait jusqu'à
 * « Revenir au direct ».
 *
 * Désormais : un segment a « durée + 2 s » pour finir, comptées depuis son vrai départ
 * (`playing`) — le temps de chargement n'est pas pris sur la marge. Un échec (erreur, refus,
 * garde échue) vaut un nouvel essai ; un second échec est signalé au serveur, et la file passe
 * à la suite.
 *
 * Chaque essai a son numéro : un événement tardif de l'essai précédent (une erreur qui arrive
 * après la relance) ne compte pas pour le suivant.
 */

/** Marge au-delà de la durée annoncée du segment. */
export const GUARD_SLACK_MS = 2000;
/** Un segment très court garde au moins ce délai : un départ lent ne doit pas le condamner. */
const GUARD_MIN_MS = 1000;
/** Premier essai, puis un nouvel essai. */
export const PLAY_ATTEMPTS = 2;

import type { PlayFailReason } from "./protocol";

/** `error` : fichier illisible ; `refused` : `play()` refusé ; `stalled` : rien dans le délai. */
export type { PlayFailReason };

export interface GuardHooks {
  /** Lance (essai 1) ou relance la lecture ; `after` : ce qui a fait échouer l'essai précédent. */
  play(attempt: number, after?: PlayFailReason): void;
  /** Second échec : à signaler. Appelé avant `done`. */
  fail(reason: PlayFailReason, attempts: number): void;
  /** Le segment est fini — joué, ou abandonné : la file passe à la suite. */
  done(): void;
}

export interface GuardTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const realTimers: GuardTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class PlayGuard {
  private attempt = 0;
  private timer: unknown;
  private over = false;

  constructor(
    private readonly durMs: number,
    private readonly hooks: GuardHooks,
    private readonly timers: GuardTimers = realTimers,
  ) {}

  /** Essai en cours (1, puis 2). */
  get current(): number {
    return this.attempt;
  }

  start(): void {
    this.launch();
  }

  /** La voix sort vraiment : la marge repart de là. */
  playing(attempt: number): void {
    if (this.stale(attempt)) return;
    this.arm();
  }

  ended(attempt: number): void {
    if (this.stale(attempt)) return;
    this.finish();
  }

  failed(reason: PlayFailReason, attempt: number): void {
    if (this.stale(attempt)) return;
    if (this.attempt < PLAY_ATTEMPTS) return this.launch(reason);
    const attempts = this.attempt;
    this.stop();
    this.hooks.fail(reason, attempts);
    this.hooks.done();
  }

  /** « Revenir au direct », pause, changement de langue : plus rien de ce segment ne compte. */
  cancel(): void {
    this.stop();
  }

  private stale(attempt: number): boolean {
    return this.over || attempt !== this.attempt;
  }

  private launch(after?: PlayFailReason) {
    this.attempt++;
    this.arm();
    this.hooks.play(this.attempt, after);
  }

  private arm() {
    this.timers.clear(this.timer);
    const attempt = this.attempt;
    this.timer = this.timers.set(() => this.failed("stalled", attempt), Math.max(GUARD_MIN_MS, this.durMs) + GUARD_SLACK_MS);
  }

  private stop() {
    this.over = true;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private finish() {
    this.stop();
    this.hooks.done();
  }
}
