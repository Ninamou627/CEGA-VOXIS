import { describe, expect, it, vi } from "vitest";
import { Breaker, isTransient, retryTransient } from "./fallback";
import { FallbackTts, RetryingTts } from "./index";
import type { TtsProvider, TtsRequest } from "./types";

describe("panne passagère ou refus (D33)", () => {
  it("réseau, délai dépassé, 429 et 5xx sont passagers", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransient(new Error("ElevenLabs 503 : upstream"))).toBe(true);
    expect(isTransient(new Error("Azure TTS 429 : too many requests"))).toBe(true);
    expect(isTransient(Object.assign(new Error("boom"), { cause: { code: "ECONNRESET" } }))).toBe(true);
  });

  it("crédits épuisés, clé refusée ou requête invalide ne le sont pas", () => {
    // Le message réel du 09/11/2026 à 12:14:02.
    expect(isTransient(new Error('ElevenLabs 401 : {"detail":{"type":"invalid_request","code":"quota_exceeded"}}'))).toBe(false);
    expect(isTransient(new Error("Azure TTS 401 : invalid subscription key"))).toBe(false);
    expect(isTransient(new Error("ElevenLabs 400 : bad request"))).toBe(false);
  });

  it("une panne passagère est réessayée une fois, un refus jamais", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const flaky = vi.fn(async () => {
        if (n++ === 0) throw new Error("ElevenLabs 503 : overloaded");
        return "voix";
      });
      const p = retryTransient(flaky, 300);
      await vi.advanceTimersByTimeAsync(300);
      expect(await p).toBe("voix");
      expect(flaky).toHaveBeenCalledTimes(2);

      const refused = vi.fn(async () => {
        throw new Error("ElevenLabs 401 : quota_exceeded");
      });
      await expect(retryTransient(refused, 300)).rejects.toThrow("quota_exceeded");
      expect(refused).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("voix de secours (D33)", () => {
  const req: TtsRequest = { text: "Bonjour", lang: "fr", speed: 1 };
  const voice = (name: string, fail: () => Error | null): TtsProvider & { calls: number } => {
    const p = {
      name,
      calls: 0,
      async synthesize() {
        p.calls++;
        const e = fail();
        if (e) throw e;
        return { audio: new Uint8Array([1]), mime: "audio/mpeg", durMs: 500, voice: name };
      },
    };
    return p;
  };
  const hooks = { onFallback: vi.fn(), onRecover: vi.fn() };

  it("crédits épuisés : la phrase est dite tout de suite par le secours, sans second essai du primaire", async () => {
    const eleven = voice("elevenlabs", () => new Error("ElevenLabs 401 : quota_exceeded"));
    const azure = voice("azure-neural", () => null);
    const tts = new FallbackTts(new RetryingTts(eleven, 0, () => {}), new RetryingTts(azure, 0, () => {}), hooks);
    expect((await tts.synthesize(req)).voice).toBe("azure-neural");
    expect(eleven.calls).toBe(1);
  });

  it("panne passagère du primaire : il est réessayé et la salle garde sa voix", async () => {
    let n = 0;
    const eleven = voice("elevenlabs", () => (n++ === 0 ? new TypeError("fetch failed") : null));
    const azure = voice("azure-neural", () => null);
    const tts = new FallbackTts(new RetryingTts(eleven, 0, () => {}), new RetryingTts(azure, 0, () => {}), hooks);
    expect((await tts.synthesize(req)).voice).toBe("elevenlabs");
    expect(azure.calls).toBe(0);
  });
});

function setup() {
  let t = 0;
  const onFallback = vi.fn();
  const onRecover = vi.fn();
  const b = new Breaker(onFallback, onRecover, 1000, () => t);
  let primaryOk = false;
  const primary = vi.fn(async () => {
    if (!primaryOk) throw new Error("panne");
    return "primaire";
  });
  const backup = vi.fn(async () => "secours");
  return { b, primary, backup, onFallback, onRecover, advance: (ms: number) => (t += ms), fix: () => (primaryOk = true) };
}

describe("Breaker", () => {
  it("passe au secours à la première panne et n'appelle plus le primaire pendant le délai", async () => {
    const s = setup();
    expect(await s.b.call(s.primary, s.backup)).toBe("secours");
    expect(s.onFallback).toHaveBeenCalledTimes(1);
    s.advance(500);
    expect(await s.b.call(s.primary, s.backup)).toBe("secours");
    expect(s.primary).toHaveBeenCalledTimes(1); // pas de second essai dans la fenêtre
  });

  it("réessaie le primaire après le délai, et revient dessus s'il répond", async () => {
    const s = setup();
    await s.b.call(s.primary, s.backup);
    s.advance(1001);
    s.fix();
    expect(await s.b.call(s.primary, s.backup)).toBe("primaire");
    expect(s.onRecover).toHaveBeenCalledTimes(1);
    expect(s.b.usingBackup).toBe(false);
  });

  it("rouvre le disjoncteur si le primaire échoue encore après le délai", async () => {
    const s = setup();
    await s.b.call(s.primary, s.backup);
    s.advance(1001);
    expect(await s.b.call(s.primary, s.backup)).toBe("secours");
    expect(s.onFallback).toHaveBeenCalledTimes(2);
    expect(s.b.usingBackup).toBe(true);
  });
});
