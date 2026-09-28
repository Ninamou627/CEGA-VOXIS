/**
 * Rend les icônes de l'application depuis la géométrie du logo (src/ui/Logo.tsx).
 *
 *   npm run icons -w client
 *
 * Écrites plutôt que dessinées à la main : le logo définitif n'est pas encore fourni, et le
 * jour où il arrivera, une seule description à changer ici régénère les cinq tailles — celles
 * de la PWA, d'iOS et de l'installateur Windows.
 *
 * Sans dépendance : un encodeur PNG tient en quelques lignes avec `zlib`, et l'anticrénelage
 * s'obtient en échantillonnant chaque pixel plusieurs fois.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const racine = fileURLToPath(new URL("..", import.meta.url));

/** Le logo, dans son repère d'origine de 32 × 32 (identique à Logo.tsx). */
const FOND = "#2563eb";
const BARRES = [
  { x: 6.5, y: 12, w: 3, h: 8, r: 1.5, couleur: "#dbe1ff" },
  { x: 12, y: 8, w: 3, h: 16, r: 1.5, couleur: "#ffffff" },
  { x: 17.5, y: 5, w: 3, h: 22, r: 1.5, couleur: "#4edea3" },
  { x: 23, y: 11, w: 3, h: 10, r: 1.5, couleur: "#dbe1ff" },
];

/** Échantillons par côté de pixel : 4 × 4 suffisent pour des bords nets. */
const SOUS_PIXELS = 4;

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Un point est-il dans un rectangle à coins arrondis ? */
function dansRect(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/**
 * Dessine le logo dans un tampon RVBA.
 * `masquable` : Android rogne jusqu'à un cercle de 80 % du côté, donc fond plein et logo
 * réduit au centre — sinon les coins du carré arrondi seraient coupés.
 */
function dessiner(taille, masquable) {
  const px = Buffer.alloc(taille * taille * 4); // transparent par défaut
  const [fr, fg, fb] = rgb(FOND);

  const interieur = masquable ? taille * 0.55 : taille;
  const decalage = (taille - interieur) / 2;
  const k = interieur / 32;
  const versCanvas = (f) => ({ x: decalage + f.x * k, y: decalage + f.y * k, w: f.w * k, h: f.h * k, r: f.r * k });

  const fondForme = masquable ? null : versCanvas({ x: 0, y: 0, w: 32, h: 32, r: 8 });
  const barres = BARRES.map((b) => ({ forme: versCanvas(b), couleur: rgb(b.couleur) }));
  const pas = 1 / SOUS_PIXELS;
  const parEchantillon = 1 / (SOUS_PIXELS * SOUS_PIXELS);

  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      // Couverture et couleur moyennes du pixel, échantillon par échantillon.
      let couvert = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SOUS_PIXELS; sy++) {
        for (let sx = 0; sx < SOUS_PIXELS; sx++) {
          const px0 = x + (sx + 0.5) * pas;
          const py0 = y + (sy + 0.5) * pas;
          let couleur = null;
          // La dernière forme qui contient le point gagne : les barres sont au-dessus du fond.
          if (masquable) couleur = [fr, fg, fb];
          else if (dansRect(px0, py0, fondForme)) couleur = [fr, fg, fb];
          for (const barre of barres) if (dansRect(px0, py0, barre.forme)) couleur = barre.couleur;
          if (!couleur) continue;
          couvert += parEchantillon;
          r += couleur[0] * parEchantillon;
          g += couleur[1] * parEchantillon;
          b += couleur[2] * parEchantillon;
        }
      }
      if (couvert === 0) continue;
      const i = (y * taille + x) * 4;
      // Couleur non prémultipliée : on divise par la couverture.
      px[i] = Math.round(r / couvert);
      px[i + 1] = Math.round(g / couvert);
      px[i + 2] = Math.round(b / couvert);
      px[i + 3] = Math.round(couvert * 255);
    }
  }
  return px;
}

// ---- encodage PNG --------------------------------------------------------------------
const TABLE_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function morceau(type, donnees) {
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(donnees.length);
  const corps = Buffer.concat([Buffer.from(type, "ascii"), donnees]);
  const somme = Buffer.alloc(4);
  somme.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, somme]);
}

function encoderPng(taille, rgba) {
  const parLigne = taille * 4;
  // Chaque ligne est précédée de son octet de filtre (0 = aucun).
  const brut = Buffer.alloc((parLigne + 1) * taille);
  for (let y = 0; y < taille; y++) {
    rgba.copy(brut, y * (parLigne + 1) + 1, y * parLigne, (y + 1) * parLigne);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(taille, 0);
  ihdr.writeUInt32BE(taille, 4);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RVBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    morceau("IHDR", ihdr),
    morceau("IDAT", deflateSync(brut, { level: 9 })),
    morceau("IEND", Buffer.alloc(0)),
  ]);
}

// ---- production ----------------------------------------------------------------------
const ICONES = [
  { fichier: "public/icons/icon-192.png", taille: 192, masquable: false },
  { fichier: "public/icons/icon-512.png", taille: 512, masquable: false },
  { fichier: "public/icons/icon-maskable-512.png", taille: 512, masquable: true },
  // iOS ignore le manifeste pour l'écran d'accueil et rogne lui-même les coins.
  { fichier: "public/icons/apple-touch-icon.png", taille: 180, masquable: false },
  // L'installeur Windows (electron-builder en tire le .ico).
  { fichier: "../desktop/build/icon.png", taille: 256, masquable: false },
];

for (const { fichier, taille, masquable } of ICONES) {
  const chemin = path.resolve(racine, fichier);
  mkdirSync(path.dirname(chemin), { recursive: true });
  const png = encoderPng(taille, dessiner(taille, masquable));
  writeFileSync(chemin, png);
  console.log(`${path.relative(racine, chemin).replace(/\\/g, "/").padEnd(40)} ${taille}×${taille}${masquable ? " masquable" : ""}  ${(png.length / 1024).toFixed(1)} Ko`);
}
