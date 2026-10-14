import { describe, expect, it } from "vitest";
import { WarmLink } from "./http";

function link(idleMs = 15_000) {
  let t = 100_000;
  let pings = 0;
  const l = new WarmLink(async () => void pings++, idleMs, () => t);
  return { l, advance: (ms: number) => (t += ms), pings: () => pings };
}

describe("WarmLink", () => {
  it("réchauffe toujours avec force (ouverture du micro)", async () => {
    const { l, pings } = link();
    await l.warm(true);
    await l.warm(true);
    expect(pings()).toBe(2);
  });

  it("n'envoie rien tant que la liaison sert : la séance elle-même la garde chaude", async () => {
    const { l, advance, pings } = link();
    l.used();
    advance(10_000);
    await l.warm();
    l.used();
    advance(10_000);
    await l.warm();
    expect(pings()).toBe(0);
  });

  it("réchauffe une liaison restée inactive, une fois par période", async () => {
    const { l, advance, pings } = link();
    l.used();
    advance(15_000);
    await l.warm();
    await l.warm();
    expect(pings()).toBe(1);
    advance(15_000);
    await l.warm();
    expect(pings()).toBe(2);
  });

  it("n'échoue jamais : un réchauffage raté ne gêne pas la séance", async () => {
    const l = new WarmLink(async () => {
      throw new Error("réseau coupé");
    });
    await expect(l.warm(true)).resolves.toBeUndefined();
  });
});
