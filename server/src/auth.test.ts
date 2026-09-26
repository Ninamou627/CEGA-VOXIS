import { describe, expect, it } from "vitest";
import { COOKIE_NAME, cookieValue, hashPassword, newRoomCode, normalizeCode, Throttle, verifyPassword } from "./auth";

describe("mots de passe", () => {
  it("accepte le bon mot de passe et refuse tous les autres", () => {
    const stored = hashPassword("un mot de passe de formation");
    expect(verifyPassword("un mot de passe de formation", stored)).toBe(true);
    expect(verifyPassword("un mot de passe de formatio", stored)).toBe(false);
    expect(verifyPassword("Un mot de passe de formation", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("ne stocke jamais le mot de passe, et deux empreintes du même mot diffèrent", () => {
    const a = hashPassword("azerty-azerty");
    const b = hashPassword("azerty-azerty");
    expect(a).not.toContain("azerty");
    expect(a).not.toBe(b); // sel aléatoire
    expect(verifyPassword("azerty-azerty", a)).toBe(true);
    expect(verifyPassword("azerty-azerty", b)).toBe(true);
  });

  it("refuse une empreinte illisible au lieu de lever", () => {
    for (const bad of ["", "pas-une-empreinte", "scrypt$1$2$3", "bcrypt$1$1$1$c2Vs$Y2xl", "scrypt$x$y$z$@@@$@@@"]) {
      expect(verifyPassword("azerty-azerty", bad)).toBe(false);
    }
  });

  it("normalise l'unicode : le même mot de passe tapé sur deux claviers ouvre la session", () => {
    // « é » en un seul point de code, puis en « e » + accent combinant.
    const stored = hashPassword("café-de-la-gare");
    expect(verifyPassword("café-de-la-gare", stored)).toBe(true);
  });
});

describe("code de séance", () => {
  it("six caractères, sans I, O, 0 ni 1 — il se dicte à voix haute", () => {
    for (let i = 0; i < 200; i++) {
      const code = newRoomCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("ne rend pas deux fois le même code", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newRoomCode()));
    expect(seen.size).toBeGreaterThan(190);
  });

  it("pardonne la casse, les espaces et les tirets de ce qu'un apprenant tape", () => {
    expect(normalizeCode(" a7k-p2m ")).toBe("A7KP2M");
    expect(normalizeCode("A7K P2M")).toBe("A7KP2M");
    expect(normalizeCode("a7kp2m")).toBe("A7KP2M");
  });
});

describe("Throttle", () => {
  function setup(max = 3) {
    let t = 1000;
    return { t: new Throttle(max, 60_000, () => t), advance: (ms: number) => (t += ms) };
  }

  it("laisse passer les premiers essais, puis ferme", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      expect(s.t.allow("1.2.3.4")).toBe(true);
      s.t.fail("1.2.3.4");
    }
    expect(s.t.allow("1.2.3.4")).toBe(false);
  });

  it("ne punit qu'une adresse à la fois", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.t.fail("1.2.3.4");
    expect(s.t.allow("1.2.3.4")).toBe(false);
    expect(s.t.allow("5.6.7.8")).toBe(true);
  });

  it("rouvre après la fenêtre", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.t.fail("1.2.3.4");
    expect(s.t.allow("1.2.3.4")).toBe(false);
    s.advance(60_001);
    expect(s.t.allow("1.2.3.4")).toBe(true);
  });

  it("une réussite efface les échecs : un formateur qui se trompe deux fois n'est pas bloqué ensuite", () => {
    const s = setup();
    s.t.fail("1.2.3.4");
    s.t.fail("1.2.3.4");
    s.t.succeed("1.2.3.4");
    for (let i = 0; i < 3; i++) {
      expect(s.t.allow("1.2.3.4")).toBe(true);
      s.t.fail("1.2.3.4");
    }
    expect(s.t.allow("1.2.3.4")).toBe(false);
  });
});

describe("cookieValue", () => {
  it("retrouve le cookie de session dans un en-tête brut", () => {
    expect(cookieValue(`${COOKIE_NAME}=abc`, COOKIE_NAME)).toBe("abc");
    expect(cookieValue(`autre=1; ${COOKIE_NAME}=abc; encore=2`, COOKIE_NAME)).toBe("abc");
    expect(cookieValue(`autre=1;${COOKIE_NAME}=abc`, COOKIE_NAME)).toBe("abc");
  });

  it("rend undefined quand il n'y est pas", () => {
    expect(cookieValue(undefined, COOKIE_NAME)).toBeUndefined();
    expect(cookieValue("", COOKIE_NAME)).toBeUndefined();
    expect(cookieValue("autre=1", COOKIE_NAME)).toBeUndefined();
    // Un nom qui contient le nôtre ne doit pas passer pour le nôtre.
    expect(cookieValue(`x_${COOKIE_NAME}=abc`, COOKIE_NAME)).toBeUndefined();
  });
});
