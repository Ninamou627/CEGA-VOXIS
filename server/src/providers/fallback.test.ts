import { describe, expect, it, vi } from "vitest";
import { Hedge, isTransient, retryTransient } from "./fallback";
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

/**
 * `Hedge` (D39) reprend les règles du disjoncteur qu'il remplace (`Breaker`) — secours seul
 * pendant le délai après une panne du primaire, retour au primaire quand il répond — et y
 * ajoute la course : secours lancé en parallèle quand le primaire tarde, échéance de l'étage.
 */
function setup(opts: { hedgeAfterMs?: number; deadlineMs?: number; primaryMs?: number; backupMs?: number } = {}) {
  const onFallback = vi.fn();
  const onRecover = vi.fn();
  const onHedge = vi.fn();
  const h = new Hedge(opts.hedgeAfterMs ?? 600, opts.deadlineMs ?? 2000, { onFallback, onRecover, onHedge }, 60_000);
  let primaryFails = false;
  const primary = vi.fn(
    () =>
      new Promise<string>((res, rej) =>
        setTimeout(() => (primaryFails ? rej(new Error("panne du primaire")) : res("primaire")), opts.primaryMs ?? 100),
      ),
  );
  const backup = vi.fn(() => new Promise<string>((res) => setTimeout(() => res("secours"), opts.backupMs ?? 100)));
  return { h, primary, backup, onFallback, onRecover, onHedge, breakPrimary: () => (primaryFails = true) };
}

describe("Hedge — secours en parallèle et disjoncteur (D39)", () => {
  it("primaire à l'heure : le secours n'est jamais appelé", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 100 });
      const p = s.h.call(s.primary, s.backup);
      await vi.advanceTimersByTimeAsync(150);
      expect(await p).toBe("primaire");
      expect(s.backup).not.toHaveBeenCalled();
      expect(s.onHedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("primaire lent : le secours part après l'attente et sa réponse est retenue, sans ouvrir le disjoncteur", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 3000, backupMs: 100 });
      const p = s.h.call(s.primary, s.backup);
      await vi.advanceTimersByTimeAsync(500);
      expect(s.backup).not.toHaveBeenCalled(); // avant l'attente, pas de course
      await vi.advanceTimersByTimeAsync(300); // 0,6 s : le secours part ; 0,7 s : il répond
      expect(await p).toBe("secours");
      expect(s.onHedge).toHaveBeenCalledTimes(1);
      expect(s.onFallback).not.toHaveBeenCalled();
      expect(s.h.usingBackup).toBe(false); // lent n'est pas en panne : le prochain segment retente le primaire
      await vi.advanceTimersByTimeAsync(5000); // la réponse tardive du primaire ne casse rien
    } finally {
      vi.useRealTimers();
    }
  });

  it("primaire plus rapide que le secours parti en course : c'est lui qui est retenu", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 800, backupMs: 1000 });
      const p = s.h.call(s.primary, s.backup);
      await vi.advanceTimersByTimeAsync(850);
      expect(await p).toBe("primaire");
      expect(s.backup).toHaveBeenCalledTimes(1); // parti à 0,6 s, arrivé trop tard : ignoré
      expect(s.onHedge).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("panne du primaire : le secours part aussitôt, puis sert seul pendant le délai, puis le primaire revient", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 100, backupMs: 100 });
      s.breakPrimary();
      const p = s.h.call(s.primary, s.backup);
      await vi.advanceTimersByTimeAsync(250); // panne à 0,1 s, secours parti aussitôt (avant 0,6 s)
      expect(await p).toBe("secours");
      expect(s.onFallback).toHaveBeenCalledTimes(1);
      expect(s.h.usingBackup).toBe(true);

      const p2 = s.h.call(s.primary, s.backup);
      await vi.advanceTimersByTimeAsync(150);
      expect(await p2).toBe("secours");
      expect(s.primary).toHaveBeenCalledTimes(1); // pas de second essai dans la fenêtre

      vi.advanceTimersByTime(61_000); // le délai écoulé, le primaire — réparé — est réessayé
      const fixed = vi.fn(async () => "primaire");
      const p3 = s.h.call(fixed, s.backup);
      await vi.advanceTimersByTimeAsync(10);
      expect(await p3).toBe("primaire");
      expect(s.onRecover).toHaveBeenCalledTimes(1);
      expect(s.h.usingBackup).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rien à l'échéance : l'étage abandonne et la panne ouvre le disjoncteur", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 10_000, backupMs: 10_000, deadlineMs: 2000 });
      const p = s.h.call(s.primary, s.backup);
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(2100);
      await expect(p).rejects.toThrow("sans réponse en 2000 ms");
      expect(s.onFallback).toHaveBeenCalledTimes(1);
      expect(s.h.usingBackup).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000); // les réponses tardives sont ignorées sans bruit
    } finally {
      vi.useRealTimers();
    }
  });

  it("le secours de la course échoue : le primaire, bien que lent, est attendu et retenu", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 1500 });
      const failing = vi.fn(async () => {
        throw new Error("secours en panne");
      });
      const p = s.h.call(s.primary, failing);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await p).toBe("primaire");
      expect(s.onFallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("primaire ET secours en panne : l'erreur du primaire repart", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ primaryMs: 100 });
      s.breakPrimary();
      const failing = vi.fn(async () => {
        throw new Error("secours en panne");
      });
      const p = s.h.call(s.primary, failing);
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(200);
      await expect(p).rejects.toThrow("panne du primaire");
    } finally {
      vi.useRealTimers();
    }
  });
});
