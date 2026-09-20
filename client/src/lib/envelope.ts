/**
 * Enveloppe d'amplitude d'un segment audio : une valeur de 0 à 1 par tranche de
 * `binMs`. Décodage hors ligne, sans sortie audio — c'est ce qui permet à l'onde de
 * l'écran d'écoute de suivre la voix réellement entendue, segment par segment.
 */
export const BIN_MS = 50;

export async function envelope(bytes: Uint8Array, binMs = BIN_MS): Promise<Float32Array> {
  // slice() : la charge utile est une vue sur la trame WebSocket, decodeAudioData détache le buffer.
  const buf = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.slice().buffer);
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.round((buf.sampleRate * binMs) / 1000));
  const out = new Float32Array(Math.ceil(data.length / step));
  for (let i = 0; i < out.length; i++) {
    const a = i * step;
    const b = Math.min(data.length, a + step);
    let sum = 0;
    for (let j = a; j < b; j++) sum += data[j] * data[j];
    // Une voix de synthèse tient autour de 0,1 à 0,25 RMS : ×4 remplit l'échelle sans la saturer.
    out[i] = Math.min(1, Math.sqrt(sum / (b - a)) * 4);
  }
  return out;
}
