/**
 * Trame binaire pour l'audio sur WebSocket, identique côté Node et navigateur.
 *
 *   [u32 BE : longueur de l'en-tête] [en-tête JSON UTF-8] [charge utile]
 *
 * Un seul message par segment audio : l'en-tête et les octets voyagent ensemble,
 * ce qui évite toute désynchronisation entre un message texte et un message binaire.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(header: unknown, payload: Uint8Array): Uint8Array {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length, false);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export function decodeFrame<T = unknown>(buf: Uint8Array): { header: T; payload: Uint8Array } {
  if (buf.byteLength < 4) throw new Error("trame trop courte");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hl = dv.getUint32(0, false);
  if (4 + hl > buf.byteLength) throw new Error("en-tête de trame invalide");
  const header = JSON.parse(dec.decode(buf.subarray(4, 4 + hl))) as T;
  return { header, payload: buf.subarray(4 + hl) };
}
