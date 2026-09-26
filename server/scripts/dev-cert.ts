/**
 * Certificat auto-signé pour tester en HTTPS sur le LAN (micro des téléphones).
 *
 *   npm run cert:dev            # toutes les IP locales + localhost
 *   npm run cert:dev -- 192.168.1.50
 *
 * Écrit certs/dev-cert.pem et certs/dev-key.pem (ignorés par git), et affiche les
 * lignes à mettre dans .env. Le téléphone affichera UN avertissement à accepter.
 * Pour la salle, ce n'est pas la solution : voir docs/CERTIFICAT.md (Let's Encrypt
 * DNS-01 sur un nom de domaine, sans avertissement).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config";
import { lanIps, origin } from "../src/net";

const root = process.env.INIT_CWD ?? process.cwd();
const dir = path.resolve(root, "certs");
const cert = path.join(dir, "dev-cert.pem");
const key = path.join(dir, "dev-key.pem");
const cnf = path.join(dir, "openssl.cnf");

const ips = process.argv[2] ? [process.argv[2]] : lanIps().map((i) => i.address);

if (!ips.length) {
  console.error("Aucune IP locale détectée. Passez-la en argument : npm run cert:dev -- 192.168.1.50");
  process.exit(1);
}

const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => `IP:${ip}`)].join(",");
mkdirSync(dir, { recursive: true });
// Config minimale : certaines machines ont un OPENSSL_CONF qui pointe dans le vide.
writeFileSync(cnf, "[req]\ndistinguished_name = dn\n[dn]\n");

try {
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "365", "-keyout", key, "-out", cert, "-subj", "/CN=interprete-salle-dev", "-addext", `subjectAltName=${san}`, "-config", cnf],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, OPENSSL_CONF: cnf } },
  );
} catch (e) {
  console.error("openssl introuvable ou en échec :", (e as Error).message);
  console.error("Sous Windows, openssl est fourni avec Git (Git Bash). Sinon : winget install ShiningLight.OpenSSL.Light");
  process.exit(1);
}

console.log(`Certificat auto-signé écrit (valable 365 jours) pour : ${ips.join(", ")}, localhost\n`);
console.log("À mettre dans .env, puis redémarrer le serveur :\n");
console.log(`TLS_CERT=${path.relative(root, cert).replace(/\\/g, "/")}`);
console.log(`TLS_KEY=${path.relative(root, key).replace(/\\/g, "/")}`);
console.log(`PUBLIC_URL=${origin(true, ips[0], loadConfig().PORT)}`);
console.log(`
Ensuite : npm run build, npm start, et sur le téléphone ${origin(true, ips[0], loadConfig().PORT)}/
  → avertissement « connexion non privée » : Détails → Visiter le site (une seule fois).
  → si le micro reste refusé sur iPhone, installez le certificat : envoyez-vous certs/dev-cert.pem,
    ouvrez-le sur le téléphone, Réglages → Général → VPN et gestion de l'appareil → Installer,
    puis Réglages → Général → Informations → Réglages des certificats → activer la confiance.`);
if (existsSync(path.resolve(root, ".env"))) {
  console.log("\n(le .env existe : ces lignes sont à ajouter ou remplacer à la main)");
}
