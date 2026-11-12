import { describe, expect, it } from "vitest";
import { decodeMicFrame, encodeMicFrame, MIC_HEADER_BYTES } from "../../shared/framing";

describe("trame du micro numérotée et datée (D37)", () => {
  it("rend le PCM, le numéro et l'instant de captation", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const framed = encodeMicFrame({ seq: 4_000_000_001, tCapture: 1_794_237_795_195.5 }, pcm);
    expect(framed.byteLength).toBe(MIC_HEADER_BYTES + 4);
    const { pcm: out, info } = decodeMicFrame(framed);
    expect([...out]).toEqual([1, 2, 3, 4]);
    expect(info).toEqual({ seq: 4_000_000_001, tCapture: 1_794_237_795_195.5 });
  });

  it("une trame sans en-tête (rejeu, test de charge, ancienne page) reste du PCM brut", () => {
    const raw = new Uint8Array(1600);
    expect(decodeMicFrame(raw)).toEqual({ pcm: raw });
    expect(decodeMicFrame(new Uint8Array(8)).info).toBeUndefined();
  });

  it("lit une trame reçue comme vue sur un tampon plus grand", () => {
    const framed = encodeMicFrame({ seq: 7, tCapture: 1000 }, new Uint8Array([9, 9]));
    const big = new Uint8Array(100);
    big.set(framed, 10);
    const view = big.subarray(10, 10 + framed.byteLength);
    expect(decodeMicFrame(view).info).toEqual({ seq: 7, tCapture: 1000 });
    expect([...decodeMicFrame(view).pcm]).toEqual([9, 9]);
  });
});
