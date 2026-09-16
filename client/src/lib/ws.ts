/**
 * Client WebSocket de salle : reconnexion automatique avec backoff, rejoint la
 * session à chaque ouverture, sépare les messages texte (événements) des trames
 * binaires (audio). À la reconnexion on reprend au direct — jamais de rattrapage.
 */
import { decodeFrame } from "../../../shared/framing";
import type { AudioHeader, ClientEvent, JoinEvent, ServerEvent } from "../../../shared/protocol";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

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

  constructor(
    private join: JoinEvent,
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

    ws.onopen = () => {
      this.attempt = 0;
      this.h.onState("open");
      this.send(this.join);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.h.onEvent(JSON.parse(ev.data) as ServerEvent);
      } else {
        const { header, payload } = decodeFrame<AudioHeader>(new Uint8Array(ev.data as ArrayBuffer));
        this.h.onAudio(header, payload);
      }
    };
    ws.onclose = (ev) => {
      this.h.onState("closed");
      // 44xx = refus applicatif (jeton, session) : inutile d'insister.
      if (!this.closedByUser && !(ev.code >= 4400 && ev.code < 4500)) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose suit toujours */
    };
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
    this.ws?.close();
  }
}
