/**
 * Lecteur de segments audio, avec deux implémentations derrière la même interface :
 *
 *   - WebAudioPlayer : décodage + planification précise, enchaînement sans blanc.
 *     Le meilleur rendu au premier plan. iOS le suspend à l'écran verrouillé.
 *   - ElementPlayer  : deux <audio> alternés (double tampon). C'est le chemin
 *     qu'iOS traite comme de la lecture média — à tester écran verrouillé au J1.
 *
 * Dans les deux cas : `unlock()` doit être appelé dans un geste utilisateur, et
 * `queueMs` est la profondeur de file — l'indicateur de dérive.
 */

export interface SegmentMeta {
  seq: number;
  tOrigin: number;
  durMs: number;
  text: string;
  lang: string;
  /** Réécoute : ne pas envoyer d'ack (fausserait la mesure bout-en-bout). */
  replay?: boolean;
}

/** Ce qui joue en ce moment et où on en est, pour l'onde qui suit la voix. */
export interface Playing {
  meta: SegmentMeta;
  elapsedMs: number;
}

export interface Player {
  readonly kind: "webaudio" | "element";
  readonly queueMs: number;
  readonly playing: Playing | undefined;
  onStart?: (meta: SegmentMeta) => void;
  unlock(): Promise<void>;
  enqueue(bytes: Uint8Array, mime: string, meta: SegmentMeta): Promise<void>;
  /** « Revenir au direct » : vide la file et coupe ce qui joue. */
  flush(): void;
  setMuted(muted: boolean): void;
  /** Volume d'écoute, 0 à 1. iOS l'ignore (les boutons du téléphone font foi) ; `setMuted` reste le vrai silence. */
  setVolume(volume: number): void;
  /**
   * Vitesse de lecture locale (1 = normale). Parade immédiate contre la dérive, sans
   * attendre le serveur. Seul ElementPlayer l'applique (hauteur préservée) ; sur
   * Web Audio, `playbackRate` transposerait la voix.
   */
  setRate(rate: number): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------

export class WebAudioPlayer implements Player {
  readonly kind = "webaudio" as const;
  onStart?: (meta: SegmentMeta) => void;
  private ctx?: AudioContext;
  private gain?: GainNode;
  private nextTime = 0;
  private chain: Promise<void> = Promise.resolve();
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<number>();
  private muted = false;
  private volume = 1;
  private current?: { meta: SegmentMeta; startedAt: number };

  get queueMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000);
  }

  get playing(): Playing | undefined {
    const c = this.current;
    return c ? { meta: c.meta, elapsedMs: performance.now() - c.startedAt } : undefined;
  }

  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    // iOS : un buffer muet joué dans le geste déverrouille la sortie audio.
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.gain!);
    s.start();
  }

  enqueue(bytes: Uint8Array, _mime: string, meta: SegmentMeta): Promise<void> {
    this.chain = this.chain.then(() => this.schedule(bytes, meta)).catch((err) => console.warn("décodage audio", err));
    return this.chain;
  }

  private async schedule(bytes: Uint8Array, meta: SegmentMeta) {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    // slice() : decodeAudioData détache le buffer, et la charge utile est une vue sur la trame.
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const now = ctx.currentTime;
    const start = Math.max(now + 0.03, this.nextTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(start);
    this.nextTime = start + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.current?.meta === meta) this.current = undefined;
    };
    const id = window.setTimeout(
      () => {
        this.timers.delete(id);
        this.current = { meta, startedAt: performance.now() };
        this.onStart?.(meta);
      },
      Math.max(0, (start - now) * 1000),
    );
    this.timers.add(id);
  }

  flush(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* déjà arrêté */
      }
    }
    this.sources.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.nextTime = 0;
    this.current = undefined;
    this.chain = Promise.resolve();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyGain();
  }

  private applyGain() {
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  setRate(_rate: number): void {
    /* volontairement inerte : voir l'interface */
  }

  destroy(): void {
    this.flush();
    void this.ctx?.close();
  }
}

// ---------------------------------------------------------------------------

function silentWav(ms = 50): string {
  const rate = 8000;
  const n = Math.round((rate * ms) / 1000);
  const b = new ArrayBuffer(44 + n * 2);
  const v = new DataView(b);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

export class ElementPlayer implements Player {
  readonly kind = "element" as const;
  onStart?: (meta: SegmentMeta) => void;
  private els: HTMLAudioElement[] = [new Audio(), new Audio()];
  private i = 0;
  private queue: { url: string; meta: SegmentMeta }[] = [];
  private busy = false;
  private current?: { meta: SegmentMeta; startedAt: number };
  private muted = false;
  private volume = 1;
  private rate = 1;

  get queueMs(): number {
    let ms = this.queue.reduce((a, q) => a + q.meta.durMs, 0);
    if (this.current) ms += Math.max(0, this.current.meta.durMs - (performance.now() - this.current.startedAt) * this.rate);
    return ms / this.rate;
  }

  get playing(): Playing | undefined {
    const c = this.current;
    return c ? { meta: c.meta, elapsedMs: (performance.now() - c.startedAt) * this.rate } : undefined;
  }

  async unlock(): Promise<void> {
    const url = silentWav();
    for (const el of this.els) {
      el.setAttribute("playsinline", "");
      el.preload = "auto";
      try {
        el.src = url;
        await el.play();
        el.pause();
      } catch {
        /* certains navigateurs refusent : on réessaie à la première lecture réelle */
      }
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Interprète de salle", artist: "Traduction en direct" });
    }
  }

  async enqueue(bytes: Uint8Array, mime: string, meta: SegmentMeta): Promise<void> {
    // slice() : la charge utile est une vue sur la trame WebSocket, on copie dans un ArrayBuffer propre.
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
    this.queue.push({ url, meta });
    if (!this.busy) this.next();
  }

  private next() {
    const item = this.queue.shift();
    if (!item) {
      this.busy = false;
      this.current = undefined;
      return;
    }
    this.busy = true;
    const el = this.els[this.i];
    this.i ^= 1;
    el.muted = this.muted;
    el.volume = this.volume;
    el.playbackRate = this.rate;
    if (el.src !== item.url) el.src = item.url;
    el.onplaying = () => {
      this.current = { meta: item.meta, startedAt: performance.now() };
      this.onStart?.(item.meta);
    };
    const done = () => {
      el.onplaying = null;
      el.onended = null;
      el.onerror = null;
      URL.revokeObjectURL(item.url);
      this.next();
    };
    el.onended = done;
    el.onerror = done;
    el.play().catch(done);
    // Double tampon : le segment suivant est déjà chargé dans l'autre élément.
    const peek = this.queue[0];
    if (peek) {
      const other = this.els[this.i];
      if (other.src !== peek.url) {
        other.src = peek.url;
        other.load();
      }
    }
  }

  flush(): void {
    for (const q of this.queue) URL.revokeObjectURL(q.url);
    this.queue = [];
    for (const el of this.els) {
      el.onended = null;
      el.onerror = null;
      el.onplaying = null;
      el.pause();
    }
    this.busy = false;
    this.current = undefined;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const el of this.els) el.muted = muted; // iOS ignore `volume`, pas `muted`
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    for (const el of this.els) el.volume = this.volume;
  }

  setRate(rate: number): void {
    this.rate = rate;
    for (const el of this.els) {
      (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
      el.playbackRate = rate;
    }
  }

  destroy(): void {
    this.flush();
  }
}

export function isIOS(): boolean {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
