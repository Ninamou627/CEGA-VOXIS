/**
 * Certificat Let's Encrypt pour le nom de la salle : aucun avertissement sur les téléphones,
 * quel que soit le réseau. Voir docs/CERTIFICAT.md.
 *
 *   npm run cert:domain -- institutcega.fr   # la première fois
 *   npm run cert:domain                      # ensuite : le nom vient de PUBLIC_URL
 *   npm run cert:domain -- --staging         # répétition sur l'environnement de test de Let's Encrypt
 *   npm run cert:domain -- --force           # refaire le certificat même s'il reste plus de 30 jours
 *
 * Avec HOSTINGER_API_TOKEN dans .env, le script pointe le nom vers l'IP du PC et pose le TXT
 * du challenge tout seul ; le serveur renouvelle ensuite sans aide. Sans jeton, il affiche
 * les enregistrements à créer dans hPanel et attend qu'ils soient visibles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, repoPath } from "../src/config";
import { certInfo, domainOf, HostingerDns, issueCertificate, pointDomain, roomIp, splitDomain } from "../src/domain";
import { origin } from "../src/net";

const cfg = loadConfig();
const args = process.argv.slice(2);
const staging = args.includes("--staging");
const force = args.includes("--force");
const named = args.find((a) => !a.startsWith("--"));
const domain = named ? domainOf(`https://${named}`) : domainOf(cfg.PUBLIC_URL);
if (!domain) {
  console.error("Quel nom ? npm run cert:domain -- institutcega.fr (ou PUBLIC_URL=https://institutcega.fr dans .env)");
  process.exit(1);
}

const { zone, name } = splitDomain(domain);
const api = cfg.HOSTINGER_API_TOKEN ? new HostingerDns(cfg.HOSTINGER_API_TOKEN) : undefined;
const certFile = repoPath(`certs/${domain}.pem`);
const keyFile = repoPath(`certs/${domain}-key.pem`);

// 1. Le nom pointe vers le PC.
const ip = roomIp();
if (!ip) console.warn("Aucune interface réseau réelle : l'enregistrement A n'est pas modifié.");
else if (api) console.log(`${domain} → ${ip}${(await pointDomain(api, domain, ip)) ? " (mis à jour)" : " (déjà à jour)"}`);
else console.log(`Sans HOSTINGER_API_TOKEN : dans hPanel, DNS de ${zone}, l'enregistrement A « ${name} » doit valoir ${ip}.`);

// 2. Le certificat.
const days = existsSync(certFile) ? certInfo(readFileSync(certFile)).daysLeft : -1;
if (days > 30 && !force && !staging) {
  console.log(`Certificat encore valable ${days} jours : rien à renouveler (--force pour le refaire).`);
} else {
  const { cert, key } = await issueCertificate({ domain, api, accountKeyFile: repoPath("certs/letsencrypt-account.pem"), staging, log: console.log });
  if (staging) {
    console.log("\nRépétition réussie (certificat de test, non enregistré). Relancez sans --staging.");
    process.exit(0);
  }
  mkdirSync(path.dirname(certFile), { recursive: true });
  writeFileSync(certFile, cert);
  writeFileSync(keyFile, key, { mode: 0o600 });
  console.log(`\nCertificat Let's Encrypt écrit, valable ${certInfo(cert).daysLeft} jours.`);
}

// En salle, le port HTTPS standard : l'adresse n'a pas de numéro de port.
const rel = (p: string) => path.relative(repoPath("."), p).replace(/\\/g, "/");
console.log(`
À mettre dans .env, puis redémarrer le serveur :

PORT=443
PUBLIC_URL=${origin(true, domain, 443)}
TLS_CERT=${rel(certFile)}
TLS_KEY=${rel(keyFile)}`);
if (!api) console.log("\nEt pour que le DNS suive le PC et que le certificat se renouvelle seul : HOSTINGER_API_TOKEN (hPanel → Profil → API).");
process.exit(0);
