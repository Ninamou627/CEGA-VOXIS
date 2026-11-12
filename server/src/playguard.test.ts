import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARD_SLACK_MS, PlayGuard } from "../../shared/playguard";

/**
 * Garde de lecture (D40, F-08). D'abord la garde seule, puis le vrai `ElementPlayer` de la page
 * apprenant, branché sur un faux élément `<audio>` : un fichier corrompu doit être signalé, et la
 * voix suivante jouée.
 */

describe("PlayGuard — durée + 2 s, un nouvel essai, puis signalement (D40)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (durMs: number) => {
    const calls: string[] = [];
    const g: PlayGuard = new PlayGuard(durMs, {
      play: (attempt, after) => calls.push(`play ${attempt}${after ? ` après ${after}` : ""}`),
      fail: (reason, attempts) => calls.push(`fail ${reason} ${attempts}`),
      done: () => calls.push("done"),
    });
    return { g, calls };
  };

  it("un segment joué jusqu'au bout ne signale rien", () => {
    const { g, calls } = make(2000);
    g.start();
    g.playing(1);
    vi.advanceTimersByTime(2000);
    g.ended(1);
    vi.advanceTimersByTime(60_000);
    expect(calls).toEqual(["play 1", "done"]);
  });

  it("échec, nouvel essai, second échec : signalé avant de passer à la suite", () => {
    const { g, calls } = make(2000);
    g.start();
    g.failed("error", 1);
    g.failed("error", 2);
    expect(calls).toEqual(["play 1", "play 2 après error", "fail error 2", "done"]);
  });

  it("un événement tardif de l'essai précédent ne compte pas pour le suivant", () => {
    const { g, calls } = make(2000);
    g.start();
    g.failed("error", 1);
    g.failed("refused", 1); // le play() du premier essai, rejeté après la relance
    g.ended(1);
    expect(calls).toEqual(["play 1", "play 2 après error"]);
    g.playing(2);
    g.ended(2);
    expect(calls).toEqual(["play 1", "play 2 après error", "done"]);
  });

  it("rien ne se passe : la garde rend la main après « durée + 2 s », deux fois", () => {
    const { g, calls } = make(3000);
    g.start();
    vi.advanceTimersByTime(3000 + GUARD_SLACK_MS - 1);
    expect(calls).toEqual(["play 1"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["play 1", "play 2 après stalled"]);
    vi.advanceTimersByTime(3000 + GUARD_SLACK_MS);
    expect(calls).toEqual(["play 1", "play 2 après stalled", "fail stalled 2", "done"]);
  });

  it("téléphone lent : la marge repart du vrai départ, pas de la demande", () => {
    const { g, calls } = make(1000);
    g.start();
    vi.advanceTimersByTime(2900); // 2,9 s de chargement : la garde (3 s) n'a pas encore échu
    g.playing(1); // la voix sort enfin : 1 s de voix + 2 s de marge à partir d'ici
    vi.advanceTimersByTime(2900);
    g.ended(1);
    expect(calls).toEqual(["play 1", "done"]);
  });

  it("annulée (revenir au direct), elle ne signale plus rien", () => {
    const { g, calls } = make(1000);
    g.start();
    g.cancel();
    vi.advanceTimersByTime(60_000);
    g.failed("error", 1);
    expect(calls).toEqual(["play 1"]);
  });
});

// ---------------------------------------------------------------------------

type Behaviour = "ok" | "error" | "refuse" | "hang";

/** Un élément `<audio>` scripté : chaque URL a son comportement, essai après essai. */
class FakeAudio {
  src = "";
  muted = false;
  volume = 1;
  preload = "";
  paused = true;
  currentTime = 0;
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(private readonly script: (src: string) => Behaviour) {}
  setAttribute() {}
  load() {
    this.currentTime = 0;
    loads.push(this.src);
  }
  pause() {
    this.paused = true;
  }
  play(): Promise<void> {
    const b = this.script(this.src);
    if (b === "refuse") return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    const src = this.src;
    if (b === "error") setTimeout(() => this.src === src && this.onerror?.(), 10);
    if (b === "ok")
      setTimeout(() => {
        if (this.src !== src) return;
        this.onplaying?.();
        setTimeout(() => {
          if (this.src !== src || this.paused) return;
          this.paused = true;
          this.onended?.();
        }, durOf(src));
      }, 10);
    return Promise.resolve(); // "hang" : la lecture « démarre » et plus rien n'arrive
  }
}

let loads: string[] = [];
let urls = 0;
const DUR = 1500;
const durOf = (_src: string) => DUR;

/** player.ts est du code de navigateur : chargé à l'exécution, hors du typage du serveur. */
const PLAYER = new URL("../../client/src/lib/player.ts", import.meta.url).href;
interface Meta {
  seq: number;
  tOrigin: number;
  durMs: number;
  text: string;
  lang: string;
}
interface ElementPlayerLike {
  onStart?: (m: Meta) => void;
  onFail?: (m: Meta, reason: string, attempts: number) => void;
  enqueue(bytes: Uint8Array, mime: string, meta: Meta): Promise<void>;
  flush(): void;
}
type PlayerCtor = new (make: () => unknown) => ElementPlayerLike;

describe("ElementPlayer sous garde : fichier corrompu, lecture bloquée (D40)", () => {
  let ElementPlayer: PlayerCtor;
  let revoked: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    loads = [];
    urls = 0;
    revoked = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:seg-${++urls}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => void revoked.push(u));
    ({ ElementPlayer } = (await import(/* @vite-ignore */ PLAYER)) as { ElementPlayer: PlayerCtor });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Joue trois segments ; `plan` : le comportement de chaque segment, essai par essai. */
  async function run(plan: Record<number, Behaviour[]>, after?: (p: ElementPlayerLike) => void) {
    const tries: Record<string, number> = {};
    const script = (src: string) => {
      const n = Number(src.split("-")[1]);
      const k = (tries[src] = (tries[src] ?? 0) + 1);
      const steps = plan[n] ?? ["ok"];
      return steps[Math.min(k, steps.length) - 1];
    };
    const p = new ElementPlayer(() => new FakeAudio(script));
    const started: number[] = [];
    const failed: [number, string, number][] = [];
    p.onStart = (m) => started.push(m.seq);
    p.onFail = (m, reason, attempts) => failed.push([m.seq, reason, attempts]);
    for (const seq of [1, 2, 3]) await p.enqueue(new Uint8Array(8), "audio/mpeg", { seq, tOrigin: 0, durMs: DUR, text: `s${seq}`, lang: "fr" });
    after?.(p);
    await vi.advanceTimersByTimeAsync(60_000);
    return { started, failed, tries };
  }

  it("fichier corrompu : échec visible après un nouvel essai, la voix suivante est jouée", async () => {
    const { started, failed, tries } = await run({ 2: ["error", "error"] });
    expect(failed).toEqual([[2, "error", 2]]);
    expect(started).toEqual([1, 3]);
    expect(tries["blob:seg-2"]).toBe(2);
    // Le nouvel essai recharge le fichier, et son URL est libérée une fois abandonné.
    expect(loads.filter((u) => u === "blob:seg-2").length).toBeGreaterThanOrEqual(2);
    expect(revoked).toContain("blob:seg-2");
  });

  it("une erreur passagère : le nouvel essai la joue, rien n'est signalé", async () => {
    const { started, failed } = await run({ 1: ["error", "ok"] });
    expect(failed).toEqual([]);
    expect(started).toEqual([1, 2, 3]);
  });

  it("lecture bloquée (ni fin, ni erreur) : la file ne reste plus figée", async () => {
    const { started, failed } = await run({ 1: ["hang", "hang"] });
    expect(failed).toEqual([[1, "stalled", 2]]);
    expect(started).toEqual([2, 3]);
  });

  it("lecture refusée par le téléphone : signalée, la suite est jouée", async () => {
    const { started, failed } = await run({ 3: ["refuse", "refuse"] });
    expect(failed).toEqual([[3, "refused", 2]]);
    expect(started).toEqual([1, 2]);
  });

  it("revenir au direct pendant un blocage : rien n'est signalé", async () => {
    const { failed } = await run({ 1: ["hang", "hang"] }, (p) => p.flush());
    expect(failed).toEqual([]);
  });
});
