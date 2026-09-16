/**
 * Durée d'un flux MP3 (MPEG-1 / 2 / 2.5, Layer III) par comptage des trames.
 * Précision ±1 trame (26 ms) — largement suffisant pour piloter la file audio.
 * Sans dépendance : les TTS renvoient du MP3, et le client a besoin de `durMs`.
 */

const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// bits de version : 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = réservé
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function mp3DurationMs(buf: Uint8Array): number {
  let i = 0;
  let samples = 0;
  let rate = 0;

  // En-tête ID3v2 éventuel
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }

  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bitrateIdx = buf[i + 2] >> 4;
    const srIdx = (buf[i + 2] >> 2) & 3;
    const padding = (buf[i + 2] >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      i++;
      continue;
    }
    const mpeg1 = version === 3;
    const kbps = (mpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[bitrateIdx];
    const sr = SAMPLE_RATES[version][srIdx];
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const frameLen = Math.floor(((samplesPerFrame / 8) * kbps * 1000) / sr) + padding;
    if (frameLen <= 4) {
      i++;
      continue;
    }
    samples += samplesPerFrame;
    rate = sr;
    i += frameLen;
  }
  return rate ? Math.round((samples / rate) * 1000) : 0;
}
