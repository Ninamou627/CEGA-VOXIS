/**
 * Nom de domaine de la salle : PUBLIC_URL=https://institutcega.fr (PORT=443).
 *
 * Un certificat auto-signé ne vaut que pour les IP qu'il liste ; un certificat Let's
 * Encrypt vaut pour un nom, sur n'importe quel réseau, sans avertissement sur les
 * téléphones. Il faut alors deux choses, tenues ici par l'API DNS de Hostinger :
 *   - un enregistrement A public qui pointe vers l'IP *privée* du PC, remis à jour quand
 *     le PC change de réseau ;
 *   - le challenge DNS-01 (un TXT), le seul possible : le serveur n'est pas joignable
 *     depuis Internet. Le certificat obtenu vaut ensuite 90 jours, même hors ligne.
 * Voir docs/CERTIFICAT.md.
 */
import * as acme from "acme-client";
import type { FastifyBaseLogger } from "fastify";
import { X509Certificate } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lanIps } from "./net";

/** Hôte de l'URL s'il s'agit d'un nom de domaine (pas d'une IP, ni de localhost). */
export function domainOf(url: string | undefined): string | undefined {
  let host: string;
  try {
    host = new URL(url ?? "").hostname;
  } catch {
    return undefined;
  }
  return host.includes(".") && !isIP(host) ? host : undefined;
}

/** voxis.institutcega.fr → zone « institutcega.fr », nom « voxis » (zones à deux étiquettes : .fr, .com…). */
export function splitDomain(domain: string): { zone: string; name: string } {
  const labels = domain.split(".");
  return { zone: labels.slice(-2).join("."), name: labels.slice(0, -2).join(".") || "@" };
}

/** L'IP à publier : une vraie interface seulement (celles de WSL ou VMware sont injoignables d'un téléphone). */
export function roomIp(): string | undefined {
  return lanIps().find((i) => !i.virtual)?.address;
}

/** Noms couverts par un certificat PEM et jours avant son expiration. */
export function certInfo(pem: string | Buffer): { dnsNames: string[]; daysLeft: number } {
  const x = new X509Certificate(pem);
  return {
    dnsNames: (x.subjectAltName ?? "")
      .split(", ")
      .filter((n) => n.startsWith("DNS:"))
      .map((n) => n.slice(4)),
    daysLeft: Math.floor((Date.parse(x.validTo) - Date.now()) / 86_400_000),
  };
}

// ---- API DNS Hostinger : https://docs.hostinger.com/api-reference/endpoints/dns/zone ----
type RecordType = "A" | "AAAA" | "TXT";
type RecordSet = { name: string; type: string; records: { content: string }[] };

export class HostingerDns {
  constructor(private readonly token: string) {}

  private async call(method: "GET" | "PUT" | "DELETE", zone: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`https://developers.hostinger.com/api/dns/v1/zones/${zone}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`API Hostinger (${method} ${zone}) : HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /** Tous les enregistrements de la zone, groupés par nom + type. */
  async records(zone: string): Promise<RecordSet[]> {
    return (await this.call("GET", zone)) as RecordSet[];
  }

  /** Remplace l'enregistrement nom + type. `overwrite` ne touche que ce couple : le reste de la zone ne bouge pas. */
  async set(zone: string, name: string, type: RecordType, contents: string[], ttl = 120): Promise<void> {
    await this.call("PUT", zone, { overwrite: true, zone: [{ name, type, ttl, records: contents.map((content) => ({ content })) }] });
  }

  async remove(zone: string, name: string, type: RecordType): Promise<void> {
    await this.call("DELETE", zone, { filters: [{ name, type }] });
  }
}

/** Fait pointer le nom vers l'IP, et seulement vers elle ; true si la zone a changé. */
export async function pointDomain(api: HostingerDns, domain: string, ip: string): Promise<boolean> {
  const { zone, name } = splitDomain(domain);
  const sets = await api.records(zone);
  const contents = (type: RecordType) => sets.find((s) => s.name === name && s.type === type)?.records.map((r) => r.content) ?? [];
  let changed = false;
  // Un AAAA (l'IPv6 de la page de parking Hostinger, par exemple) passerait avant l'IPv4 du PC
  // sur un téléphone en IPv6 : il mènerait ailleurs que dans la salle.
  if (contents("AAAA").length) {
    await api.remove(zone, name, "AAAA");
    changed = true;
  }
  const a = contents("A");
  if (a.length !== 1 || a[0] !== ip) {
    await api.set(zone, name, "A", [ip]);
    changed = true;
  }
  return changed;
}

// ---- Let's Encrypt, challenge DNS-01 ------------------------------------------------------
export interface IssueOptions {
  domain: string;
  /** Sans API, le TXT s'affiche pour être créé à la main dans hPanel. */
  api?: HostingerDns;
  accountKeyFile: string;
  /** Environnement de test de Let's Encrypt : certificat non reconnu, quotas larges. */
  staging?: boolean;
  log: (msg: string) => void;
}

/** Certificat Let's Encrypt pour le nom : chaîne complète et clé privée, en PEM. */
export async function issueCertificate(o: IssueOptions): Promise<{ cert: string; key: string }> {
  const { zone, name } = splitDomain(o.domain);
  const txt = name === "@" ? "_acme-challenge" : `_acme-challenge.${name}`;
  const client = new acme.Client({
    directoryUrl: o.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey: await accountKey(o.accountKeyFile),
  });
  const [key, csr] = await acme.crypto.createCsr({ altNames: [o.domain] });
  const cert = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    // Vérifié par waitForTxt, sur les serveurs qui font autorité : ce sont eux que Let's Encrypt interroge.
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, _challenge, value) => {
      if (o.api) await o.api.set(zone, txt, "TXT", [value]);
      else o.log(`À créer dans hPanel, DNS de ${zone} : enregistrement TXT, nom « ${txt} », valeur « ${value} »`);
      await waitForTxt(`_acme-challenge.${o.domain}`, zone, value, o.log);
    },
    challengeRemoveFn: async () => {
      if (o.api) await o.api.remove(zone, txt, "TXT");
      else o.log(`L'enregistrement TXT « ${txt} » peut être supprimé de hPanel.`);
    },
  });
  return { cert, key: key.toString() };
}

/** Le même compte Let's Encrypt d'un renouvellement à l'autre. */
async function accountKey(file: string): Promise<Buffer> {
  if (existsSync(file)) return readFileSync(file);
  const key = await acme.crypto.createPrivateKey();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/** Attend que chaque serveur de la zone serve la valeur : Let's Encrypt les interroge depuis plusieurs points du monde. */
async function waitForTxt(fqdn: string, zone: string, value: string, log: (msg: string) => void): Promise<void> {
  const resolvers = await Promise.all(
    (await dns.resolveNs(zone)).map(async (ns) => {
      const r = new dns.Resolver({ timeout: 3000, tries: 2 });
      r.setServers(await dns.resolve4(ns));
      return r;
    }),
  );
  log(`attente du TXT ${fqdn} sur les serveurs DNS de ${zone}…`);
  const deadline = Date.now() + 10 * 60_000;
  for (let unreachable = 0; ; ) {
    // undefined : serveur injoignable ; [] : joignable, mais le TXT n'y est pas encore.
    const seen = await Promise.all(
      resolvers.map((r) =>
        r.resolveTxt(fqdn).then(
          (rows) => rows.map((chunks) => chunks.join("")),
          (e: NodeJS.ErrnoException): string[] | undefined => (e.code === "ETIMEOUT" || e.code === "ECONNREFUSED" ? undefined : []),
        ),
      ),
    );
    if (seen.every((values) => values?.includes(value))) break;
    if (seen.every((values) => values === undefined) && ++unreachable >= 3) {
      log("serveurs DNS injoignables depuis ce réseau (port 53 filtré ?) : 2 min de propagation, sans vérification");
      await sleep(120_000);
      return;
    }
    if (Date.now() > deadline) throw new Error(`le TXT ${fqdn} n'est toujours pas visible au bout de 10 min`);
    await sleep(10_000);
  }
  // Les serveurs de Hostinger sont en anycast : quelques secondes de plus pour les autres points du monde.
  await sleep(15_000);
}

// ---- Dans le serveur -----------------------------------------------------------------------
/**
 * Le nom suit l'IP du PC, le certificat se renouvelle 30 jours avant l'échéance, et la
 * fonction renvoyée dit au tableau de bord ce qui empêcherait un téléphone d'entrer.
 * Sans jeton API, rien n'est modifié : les mêmes vérifications, et un message.
 */
export function keepDomain(o: {
  domain: string;
  api?: HostingerDns;
  tls: { cert: Buffer; key: Buffer };
  files: { cert: string; key: string; account: string };
  /** Recharge le certificat dans le serveur HTTPS, sans couper les connexions ouvertes. */
  reload: () => void;
  log: FastifyBaseLogger;
}): () => string | undefined {
  let resolved: string[] | undefined; // ce que le DNS de ce réseau répond pour le nom
  let pointedIp: string | undefined; // IP confirmée auprès de Hostinger
  let pointedAt = 0;
  let renewing = false;

  async function followIp() {
    const ip = roomIp();
    if (o.api && ip && ip !== pointedIp) {
      try {
        if (await pointDomain(o.api, o.domain, ip)) {
          pointedAt = Date.now();
          o.log.info({ domain: o.domain, ip }, "DNS : le nom de la salle pointe vers la nouvelle IP du PC");
        }
        pointedIp = ip;
      } catch (err) {
        o.log.warn({ err: (err as Error).message }, "DNS : impossible de mettre à jour l'enregistrement A");
      }
    }
    resolved = await dns.resolve4(o.domain).catch(() => []);
  }

  async function renew() {
    if (!o.api || renewing || certInfo(o.tls.cert).daysLeft > 30) return;
    renewing = true;
    try {
      o.log.info({ domain: o.domain }, "certificat : renouvellement Let's Encrypt");
      const { cert, key } = await issueCertificate({ domain: o.domain, api: o.api, accountKeyFile: o.files.account, log: (m) => o.log.info(m) });
      writeFileSync(o.files.cert, cert);
      writeFileSync(o.files.key, key, { mode: 0o600 });
      o.tls.cert = Buffer.from(cert);
      o.tls.key = Buffer.from(key);
      o.reload();
      o.log.info({ days: certInfo(cert).daysLeft }, "certificat renouvelé et rechargé");
    } catch (err) {
      o.log.warn({ err: (err as Error).message }, "certificat : renouvellement impossible, nouvel essai dans 12 h");
    } finally {
      renewing = false;
    }
  }

  void followIp();
  void renew();
  setInterval(() => void followIp(), 60_000).unref();
  setInterval(() => void renew(), 12 * 3_600_000).unref();

  return () => {
    const { dnsNames, daysLeft } = certInfo(o.tls.cert);
    const refused = "les téléphones refuseront la connexion. Relancez : npm run cert:domain";
    if (!dnsNames.includes(o.domain)) return `le certificat ne couvre pas ${o.domain} — ${refused}`;
    if (daysLeft < 0) return `le certificat de ${o.domain} a expiré — ${refused}`;
    if (daysLeft < 14) return `le certificat de ${o.domain} expire dans ${daysLeft} jour(s) — relancez : npm run cert:domain`;
    const ip = roomIp();
    if (!ip || !resolved || resolved.includes(ip)) return undefined;
    // Les résolveurs gardent l'ancienne réponse, ou l'absence de réponse, jusqu'à 10 min (SOA de la zone).
    if (Date.now() - pointedAt < 10 * 60_000) return `${o.domain} vient d'être pointé vers ${ip} : les caches DNS suivent d'ici quelques minutes`;
    const hPanel = `l'enregistrement A « ${splitDomain(o.domain).name} » → ${ip} dans hPanel`;
    if (!resolved.length) return `${o.domain} ne se résout pas sur ce réseau : ${o.api ? "" : `${hPanel} manque, ou `}le DNS du réseau filtre les IP privées (voir docs/CERTIFICAT.md)`;
    return `${o.domain} pointe vers ${resolved.join(", ")}, or le PC est en ${ip} — ${o.api ? "voir les journaux du serveur" : `corrigez ${hPanel}, ou donnez au serveur de salle un jeton d'API Hostinger`}`;
  };
}
