import { afterEach, describe, expect, it, vi } from "vitest";
import { domainOf, HostingerDns, pointDomain, splitDomain } from "./domain";
import { origin } from "./net";

describe("domainOf", () => {
  it("garde les noms de domaine, écarte les IP et localhost", () => {
    expect(domainOf("https://institutcega.fr")).toBe("institutcega.fr");
    expect(domainOf("https://voxis.institutcega.fr:8787")).toBe("voxis.institutcega.fr");
    expect(domainOf("https://172.16.2.194:8787")).toBeUndefined();
    expect(domainOf("https://localhost:8787")).toBeUndefined();
    expect(domainOf("https://[::1]:8787")).toBeUndefined();
    expect(domainOf(undefined)).toBeUndefined();
    expect(domainOf("institutcega.fr")).toBeUndefined(); // sans schéma, ce n'est pas une URL
  });
});

describe("splitDomain", () => {
  it("sépare la zone Hostinger du nom de l'enregistrement", () => {
    expect(splitDomain("institutcega.fr")).toEqual({ zone: "institutcega.fr", name: "@" });
    expect(splitDomain("voxis.institutcega.fr")).toEqual({ zone: "institutcega.fr", name: "voxis" });
    expect(splitDomain("salle.voxis.institutcega.fr")).toEqual({ zone: "institutcega.fr", name: "salle.voxis" });
  });
});

describe("origin", () => {
  it("n'écrit pas le port standard du schéma", () => {
    expect(origin(true, "institutcega.fr", 443)).toBe("https://institutcega.fr");
    expect(origin(true, "172.16.2.194", 8787)).toBe("https://172.16.2.194:8787");
    expect(origin(false, "172.16.2.194", 80)).toBe("http://172.16.2.194");
    expect(origin(false, "172.16.2.194", 443)).toBe("http://172.16.2.194:443");
  });
});

/** Une zone Hostinger simulée : GET la renvoie, PUT et DELETE sont enregistrés. */
function stubHostinger(zone: unknown[] = []) {
  const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method!,
        auth: (init.headers as Record<string, string>).authorization,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return Response.json(init.method === "GET" ? zone : { message: "Request accepted" });
    }),
  );
  return { calls, writes: () => calls.filter((c) => c.method !== "GET").map(({ method, body }) => ({ method, body })) };
}

describe("HostingerDns", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("remplace un seul couple nom + type, au format de l'API", async () => {
    const { calls } = stubHostinger();
    await new HostingerDns("jeton").set("institutcega.fr", "_acme-challenge", "TXT", ["abc"]);
    expect(calls).toEqual([
      {
        url: "https://developers.hostinger.com/api/dns/v1/zones/institutcega.fr",
        method: "PUT",
        auth: "Bearer jeton",
        body: { overwrite: true, zone: [{ name: "_acme-challenge", type: "TXT", ttl: 120, records: [{ content: "abc" }] }] },
      },
    ]);
  });

  it("supprime par filtre nom + type", async () => {
    const { writes } = stubHostinger();
    await new HostingerDns("jeton").remove("institutcega.fr", "_acme-challenge", "TXT");
    expect(writes()).toEqual([{ method: "DELETE", body: { filters: [{ name: "_acme-challenge", type: "TXT" }] } }]);
  });

  it("remonte l'erreur de l'API avec son code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"Unauthenticated"}', { status: 401 })));
    await expect(new HostingerDns("faux").records("institutcega.fr")).rejects.toThrow(/HTTP 401.*Unauthenticated/);
  });
});

describe("pointDomain", () => {
  afterEach(() => vi.unstubAllGlobals());

  const record = (name: string, type: string, content: string) => ({ name, type, ttl: 120, records: [{ content, is_disabled: false }] });

  it("n'écrit rien si le nom pointe déjà vers l'IP, et vers elle seule", async () => {
    const { writes } = stubHostinger([record("@", "A", "172.16.2.194"), record("www", "CNAME", "institutcega.com.")]);
    expect(await pointDomain(new HostingerDns("jeton"), "institutcega.fr", "172.16.2.194")).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("remplace la page de parking par l'IP du PC", async () => {
    const { writes } = stubHostinger([record("@", "A", "2.57.91.91"), record("www", "CNAME", "institutcega.com.")]);
    expect(await pointDomain(new HostingerDns("jeton"), "institutcega.fr", "172.16.2.194")).toBe(true);
    expect(writes()).toEqual([
      { method: "PUT", body: { overwrite: true, zone: [{ name: "@", type: "A", ttl: 120, records: [{ content: "172.16.2.194" }] }] } },
    ]);
  });

  it("retire l'IPv6 du nom : un téléphone en IPv6 la préférerait à l'IP du PC", async () => {
    const { writes } = stubHostinger([record("@", "A", "172.16.2.194"), record("@", "AAAA", "2a02:4780::1")]);
    expect(await pointDomain(new HostingerDns("jeton"), "institutcega.fr", "172.16.2.194")).toBe(true);
    expect(writes()).toEqual([{ method: "DELETE", body: { filters: [{ name: "@", type: "AAAA" }] } }]);
  });

  it("repointe un sous-domaine sans toucher au reste de la zone", async () => {
    const { writes } = stubHostinger([record("@", "A", "2.57.91.91"), record("voxis", "A", "192.168.10.221")]);
    expect(await pointDomain(new HostingerDns("jeton"), "voxis.institutcega.fr", "172.16.2.194")).toBe(true);
    expect(writes()).toEqual([
      { method: "PUT", body: { overwrite: true, zone: [{ name: "voxis", type: "A", ttl: 120, records: [{ content: "172.16.2.194" }] }] } },
    ]);
  });
});
