import { describe, expect, it, vi } from "vitest";
import { Breaker } from "./fallback";

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
