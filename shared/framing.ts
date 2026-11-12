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

/**
 * Trame du micro du formateur (D37) : chaque trame PCM porte son numéro et l'instant de sa
 * captation, estimé à l'horloge du serveur (horloge de la page + décalage mesuré au `hello`).
 *
 *   [u16 magie « VX »] [u8 version = 1] [u8 réservé] [u32 BE : numéro] [f64 BE : captation, ms] [PCM]
 *
 * Le numéro permet au serveur d'écarter une trame renvoyée deux fois et de compter celles qui
 * manquent ; l'instant de captation date la parole sans supposer la liaison instantanée, et
 * mesure le retard montant. Une trame sans cet en-tête (ancienne page, rejeu, test de charge)
 * reste du PCM brut : `decodeMicFrame` la rend telle quelle.
 */
const MIC_MAGIC = 0x5658;
const MIC_VERSION = 1;
export const MIC_HEADER_BYTES = 16;

export interface MicFrameInfo {
  seq: number;
  /** Instant de captation de la fin de la trame, à l'horloge du serveur (ms). */
  tCapture: number;
}

export function encodeMicFrame(info: MicFrameInfo, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(MIC_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, MIC_MAGIC, false);
  dv.setUint8(2, MIC_VERSION);
  dv.setUint32(4, info.seq >>> 0, false);
  dv.setFloat64(8, info.tCapture, false);
  out.set(pcm, MIC_HEADER_BYTES);
  return out;
}

/** Trame du micro : son PCM et, si elle en porte un, son en-tête. */
export function decodeMicFrame(buf: Uint8Array): { pcm: Uint8Array; info?: MicFrameInfo } {
  if (buf.byteLength < MIC_HEADER_BYTES) return { pcm: buf };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, false) !== MIC_MAGIC || dv.getUint8(2) !== MIC_VERSION) return { pcm: buf };
  return { pcm: buf.subarray(MIC_HEADER_BYTES), info: { seq: dv.getUint32(4, false), tCapture: dv.getFloat64(8, false) } };
}
