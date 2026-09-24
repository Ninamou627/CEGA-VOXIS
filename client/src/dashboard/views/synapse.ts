/**
 * Le ciel de la constellation, sur un <canvas> derrière les orbes : les liaisons entre
 * étages, les paquets qui y circulent, et en sombre quelques étoiles qui scintillent.
 *
 * Les paquets ne partent que sur un signal réel : un battement de la salle (pulse.ts) ou
 * la parole reçue par le micro. Une liaison s'illumine quand un paquet la traverse, puis
 * s'éteint doucement ; vers un étage en difficulté elle passe en pointillés orange ou
 * rouges, et un étage en panne ne laisse plus rien passer.
 *
 * Sobre à dessein, le tableau de bord reste ouvert des heures : 30 images/s au plus quand
 * des paquets circulent, 12 pour le seul scintillement, un halo pré-rendu plutôt qu'une
 * ombre recalculée, et aucune image dessinée pour rien quand la page n'est pas à l'écran ;
 * si l'appareil demande moins d'animations, une image fixe suffit.
 */

export type LinkState = "ok" | "idle" | "warn" | "crit";

type Rgb = [number, number, number];
interface Point {
  x: number;
  y: number;
}
interface Packet {
  link: number;
  /** Position sur la liaison, de 0 à 1 ; négative tant que le paquet attend son départ. */
  t: number;
  /** Fraction de liaison parcourue par milliseconde. */
  speed: number;
  size: number;
  hue: 0 | 1 | 2;
}
interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
  s: number;
  p: number;
}

const BUSY_FRAME_MS = 1000 / 30;
const IDLE_FRAME_MS = 1000 / 12;
/** Pendant que le formateur parle, un paquet part sur chaque liaison concernée toutes les… */
const STREAM_EVERY_MS = 380;

const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;

function readRgb(cs: CSSStyleDeclaration, name: string, fallback: Rgb): Rgb {
  const v = cs.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
  return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2]] : fallback;
}

/** Halo d'un paquet, dessiné une fois pour toutes. */
function halo(c: Rgb): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d");
  if (g) {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(c, 0.55));
    gr.addColorStop(0.4, rgba(c, 0.2));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
  }
  return cv;
}

export class Synapse {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private centers: Point[] = [];
  private links: LinkState[] = [];
  private streams: boolean[] = [];
  private heat: number[] = [];
  private lastSpawn: number[] = [];
  private packets: Packet[] = [];
  private stars: Star[] = [];
  private hues: [Rgb, Rgb, Rgb] = [
    [56, 189, 248],
    [99, 102, 241],
    [52, 211, 153],
  ];
  private warn: Rgb = [255, 185, 95];
  private crit: Rgb = [255, 180, 171];
  private dark = true;
  private halos: HTMLCanvasElement[] = [];
  private raf = 0;
  private last = 0;
  private visible = true;
  private still = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2D indisponible");
    this.ctx = ctx;
    this.halos = this.hues.map(halo);
  }

  /** Couleurs du thème courant, lues sur l'élément : jetons --cz-*, --tertiary, --error. */
  readColors(el: Element): void {
    const cs = getComputedStyle(el);
    this.hues = [readRgb(cs, "--cz-sky", this.hues[0]), readRgb(cs, "--cz-indigo", this.hues[1]), readRgb(cs, "--cz-emerald", this.hues[2])];
    this.warn = readRgb(cs, "--tertiary", this.warn);
    this.crit = readRgb(cs, "--error", this.crit);
    const dark = cs.getPropertyValue("--cz-stars").trim() === "1";
    if (dark !== this.dark || !this.stars.length) {
      this.dark = dark;
      this.seedStars();
    }
    this.halos = this.hues.map(halo);
    this.refresh();
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seedStars();
    this.refresh();
  }

  /** Position des étages (centres des orbes) et état de chaque liaison. */
  layout(centers: Point[], links: LinkState[]): void {
    this.centers = centers;
    this.links = links;
    if (this.heat.length !== links.length) {
      this.heat = new Array<number>(links.length).fill(0);
      this.lastSpawn = new Array<number>(links.length).fill(0);
    }
    // Un paquet en route vers un étage tombé en panne disparaît.
    this.packets = this.packets.filter((p) => this.passes(p.link));
    this.refresh();
  }

  /** Liaisons où circule un flux continu (la parole, du micro à la reconnaissance). */
  setStreams(streams: boolean[]): void {
    this.streams = streams;
    this.refresh();
  }

  /** Quelques paquets d'un coup sur une liaison : un segment qui passe à l'étage suivant. */
  burst(link: number, n = 4): void {
    if (!this.animating() || !this.passes(link)) return;
    for (let k = 0; k < n; k++) this.packets.push(this.packet(link, -k * 0.09));
    this.heat[link] = 1;
    this.refresh();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.refresh();
  }

  setStill(s: boolean): void {
    this.still = s;
    if (s) this.packets = [];
    this.refresh();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private passes(link: number): boolean {
    const s = this.links[link];
    return s === "ok" || s === "warn";
  }

  private animating(): boolean {
    return this.visible && !this.still;
  }

  private busy(): boolean {
    return this.packets.length > 0 || this.streams.some((on, i) => on && this.passes(i)) || this.heat.some((h) => h > 0.01);
  }

  private wantsLoop(): boolean {
    return this.animating() && (this.busy() || (this.dark && this.stars.length > 0));
  }

  /** Relance la boucle s'il y a quelque chose à animer, sinon dessine une image fixe. */
  private refresh(): void {
    if (this.wantsLoop()) {
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      }
      return;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.draw(performance.now());
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = now - this.last;
    if (dt < (this.busy() ? BUSY_FRAME_MS : IDLE_FRAME_MS)) return;
    this.last = now;
    this.step(Math.min(dt, 100), now);
    this.draw(now);
    if (!this.wantsLoop()) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  private packet(link: number, t = 0): Packet {
    return { link, t, speed: 0.00055 + Math.random() * 0.0004, size: 1.8 + Math.random() * 1.6, hue: Math.floor(Math.random() * 3) as 0 | 1 | 2 };
  }

  private step(dt: number, now: number): void {
    this.streams.forEach((on, i) => {
      if (on && this.passes(i) && now - (this.lastSpawn[i] ?? 0) > STREAM_EVERY_MS) {
        this.packets.push(this.packet(i));
        this.lastSpawn[i] = now;
      }
    });
    for (const p of this.packets) {
      p.t += p.speed * dt;
      if (p.t > 0 && p.t <= 1) this.heat[p.link] = Math.max(this.heat[p.link] ?? 0, 0.7);
    }
    this.packets = this.packets.filter((p) => p.t <= 1);
    this.heat = this.heat.map((h) => Math.max(0, h - dt / 1600));
  }

  /** Une courbe douce entre deux étages, bombée vers le haut (vers la gauche s'ils s'empilent). */
  private curve(i: number): { a: Point; b: Point; c: Point } {
    const a = this.centers[i];
    const b = this.centers[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { a, b, c: { x: (a.x + b.x) / 2 + (dy / len) * 14, y: (a.y + b.y) / 2 - (dx / len) * 14 } };
  }

  private at(i: number, t: number): Point {
    const { a, b, c } = this.curve(i);
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.dark) {
      const twinkle = this.animating();
      for (const s of this.stars) {
        ctx.fillStyle = `rgba(255,255,255,${Math.max(0.05, twinkle ? s.a + 0.22 * Math.sin(now * s.s + s.p) : s.a).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const n = Math.min(this.centers.length - 1, this.links.length);
    for (let i = 0; i < n; i++) this.beam(i);
    for (const p of this.packets) if (p.t >= 0 && p.link < n) this.drawPacket(p);
  }

  private beam(i: number): void {
    const ctx = this.ctx;
    const { a, b, c } = this.curve(i);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    };
    const state = this.links[i];
    ctx.save();
    ctx.lineCap = "round";
    if (state === "warn" || state === "crit") {
      ctx.setLineDash(state === "warn" ? [6, 7] : [3, 6]);
      ctx.strokeStyle = rgba(state === "warn" ? this.warn : this.crit, 0.6);
      ctx.lineWidth = 1.5;
      path();
      ctx.stroke();
    } else if (state === "idle") {
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, rgba(this.hues[1], 0.2));
      g.addColorStop(1, rgba(this.hues[0], 0.14));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.1;
      path();
      ctx.stroke();
    } else {
      const heat = this.heat[i] ?? 0;
      const laser = (alpha: number) => {
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, rgba(this.hues[1], alpha));
        g.addColorStop(0.5, rgba(this.hues[0], alpha));
        g.addColorStop(1, rgba(this.hues[2], alpha));
        return g;
      };
      if (heat > 0.02) {
        ctx.strokeStyle = laser(0.16 * heat);
        ctx.lineWidth = 7;
        path();
        ctx.stroke();
      }
      ctx.strokeStyle = laser(0.32 + 0.6 * heat);
      ctx.lineWidth = 1.3 + 1.1 * heat;
      path();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawPacket(p: Packet): void {
    const ctx = this.ctx;
    const col = this.hues[p.hue];
    const cur = this.at(p.link, p.t);
    const prev = this.at(p.link, Math.max(0, p.t - 0.06));
    ctx.save();
    ctx.strokeStyle = rgba(col, 0.5);
    ctx.lineWidth = p.size * 0.7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    const r = p.size * 3.2;
    ctx.drawImage(this.halos[p.hue], cur.x - r, cur.y - r, r * 2, r * 2);
    ctx.fillStyle = this.dark ? "#ffffff" : rgba(col, 1);
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, p.size * (this.dark ? 0.75 : 0.9), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private seedStars(): void {
    this.stars = [];
    if (!this.dark || !this.w || !this.h) return;
    const n = Math.round(Math.min(60, (this.w * this.h) / 9000));
    for (let i = 0; i < n; i++) {
      this.stars.push({ x: Math.random() * this.w, y: Math.random() * this.h, r: 0.2 + Math.random() * 1.3, a: 0.15 + Math.random() * 0.4, s: 0.0008 + Math.random() * 0.0025, p: Math.random() * Math.PI * 2 });
    }
  }
}
