/**
 * État de la salle : participants, langues, contrôle de la parole.
 * Tout est en mémoire — rien ici ne mérite d'être durable. Si le serveur
 * redémarre, les clients se reconnectent et reprennent au direct.
 */
import type { WebSocket } from "ws";
import type { FloorState, Lang, Role, ServerEvent } from "../../shared/protocol";

export interface Participant {
  id: string;
  role: Role;
  lang?: Lang;
  ws: WebSocket;
  ua?: string;
  joinedAt: number;
}

export class Room {
  readonly participants = new Map<string, Participant>();
  floor: FloorState = { state: "lecturer" };

  constructor(
    readonly sessionId: string,
    readonly srcLang: Lang,
    readonly langs: Lang[],
  ) {}

  add(p: Participant): void {
    this.participants.set(p.id, p);
  }

  remove(id: string): Participant | undefined {
    const p = this.participants.get(id);
    this.participants.delete(id);
    if (this.floor.state === "question" && this.floor.who === id) this.floor = { state: "lecturer" };
    return p;
  }

  count(role: Role): number {
    let n = 0;
    for (const p of this.participants.values()) if (p.role === role) n++;
    return n;
  }

  /** Auditeurs par langue d'écoute. */
  listenersByLang(): Partial<Record<Lang, number>> {
    const out: Partial<Record<Lang, number>> = {};
    for (const p of this.participants.values()) {
      if (p.role === "listener" && p.lang) out[p.lang] = (out[p.lang] ?? 0) + 1;
    }
    return out;
  }

  send(p: Participant, evt: ServerEvent): void {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(evt));
  }

  sendBinary(p: Participant, frame: Uint8Array): void {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(frame, { binary: true });
  }

  broadcast(evt: ServerEvent, filter?: (p: Participant) => boolean): void {
    const data = JSON.stringify(evt);
    for (const p of this.participants.values()) {
      if (filter && !filter(p)) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }

  broadcastBinary(frame: Uint8Array, filter?: (p: Participant) => boolean): void {
    for (const p of this.participants.values()) {
      if (filter && !filter(p)) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(frame, { binary: true });
    }
  }

  /** Mutex de parole : premier arrivé, premier servi. */
  takeFloor(id: string): boolean {
    if (this.floor.state !== "lecturer") return false;
    this.floor = { state: "question", who: id };
    return true;
  }

  releaseFloor(id: string): boolean {
    if (this.floor.state !== "question" || this.floor.who !== id) return false;
    this.floor = { state: "lecturer" };
    return true;
  }
}
