/**
 * Client WebSocket de salle : reconnexion automatique avec backoff, rejoint la
 * session à chaque ouverture, sépare les messages texte (événements) des trames
 * binaires (audio). À la reconnexion, la voix reprend au direct — jamais de rattrapage
 * audio ; le texte manqué, lui, est renvoyé (D40) : `join` peut être une fonction, relue à
 * chaque ouverture, pour dire au serveur où la page en était.
 *
 * Liaison figée (D35) : une coupure réseau peut laisser le socket ouvert sans que plus
 * rien n'arrive. Le navigateur ne le ferme alors pas avant plusieurs minutes, puis livre
 * d'un coup tout ce qui attendait — au test 8, 39 voix jouées 4 minutes en retard. Le
 * serveur parle au moins toutes les 2 s (stats) : passé `STALE_AFTER_MS` sans rien, on
 * lâche ce socket — ce qu'il livrerait encore est du passé — et on en rouvre un.
 */
import { decodeFrame } from "../../../shared/framing";
import type { AudioHeader, ClientEvent, JoinEvent, ServerEvent } from "../../../shared/protocol";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

/** Trois stats manquées d'affilée ; vaut aussi pour une ouverture qui n'aboutit pas. */
export const STALE_AFTER_MS = 6000;
const CHECK_EVERY_MS = 1000;

export interface SocketHandlers {
  onEvent(e: ServerEvent): void;
  onAudio(header: AudioHeader, bytes: Uint8Array): void;
  onState(s: ConnState): void;
}

export class SalleSocket {
  private ws?: WebSocket;
  private attempt = 0;
  private closedByUser = false;
  private timer?: number;
  /** Dernier signe du serveur (ouverture ou message), en ms. */
  private lastHeard = 0;
  private watch?: number;

  constructor(
    private join: JoinEvent | (() => JoinEvent),
    private h: SocketHandlers,
  ) {}

  static url(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    this.h.onState(this.attempt ? "reconnecting" : "connecting");
    const ws = new WebSocket(SalleSocket.url());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastHeard = Date.now();
    this.startWatch();

    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = Date.now();
      this.h.onState("open");
      this.send(typeof this.join === "function" ? this.join() : this.join);
    };
    ws.onmessage = (ev) => {
      this.lastHeard = Date.now();
      if (typeof ev.data === "string") {
        this.h.onEvent(JSON.parse(ev.data) as ServerEvent);
      } else {
        const { header, payload } = decodeFrame<AudioHeader>(new Uint8Array(ev.data as ArrayBuffer));
        this.h.onAudio(header, payload);
      }
    };
    ws.onclose = (ev) => {
      this.stopWatch();
      this.h.onState("closed");
      // 44xx = refus applicatif (jeton, session) : inutile d'insister.
      if (!this.closedByUser && !(ev.code >= 4400 && ev.code < 4500)) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose suit toujours */
    };
  }

  private startWatch() {
    this.stopWatch();
    this.watch = window.setInterval(() => {
      if (Date.now() - this.lastHeard > STALE_AFTER_MS) this.dropStale();
    }, CHECK_EVERY_MS);
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = undefined;
  }

  /**
   * Socket figé : on le débranche avant de le fermer, pour que rien de ce qu'il livrerait
   * encore n'atteigne la page, puis on en rouvre un comme après une fermeture.
   */
  private dropStale() {
    this.stopWatch();
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(4000, "stale");
    } catch {
      /* déjà fermé */
    }
    this.ws = undefined;
    this.h.onState("closed");
    if (!this.closedByUser) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const base = Math.min(8000, 500 * 2 ** this.attempt);
    const delay = base * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.timer = window.setTimeout(() => this.open(), delay);
  }

  send(e: ClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(e));
  }

  sendBinary(b: ArrayBuffer | Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(b);
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.stopWatch();
    this.ws?.close();
  }
}
