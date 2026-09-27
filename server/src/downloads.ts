/**
 * Distribution de l'application Windows (D18).
 *
 *   GET /telechargements/*        l'installeur et le flux de mise à jour (latest.yml)
 *   GET /api/telechargement       version, taille et empreinte SHA-256 du dernier installeur
 *
 * Public, et volontairement : un formateur doit pouvoir installer l'application avant
 * d'avoir quoi que ce soit à présenter, et l'updater de la coquille lit le même dossier.
 * Rien de sensible n'y est déposé.
 *
 * Sans certificat de signature de code, cette empreinte est ce qui permet au client de
 * vérifier que le fichier est bien celui que nous avons produit.
 */
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** `CEGA_VOXIS_Setup_1.2.3.exe` → `1.2.3` */
const VERSION = /^CEGA_VOXIS_Setup_(.+)\.exe$/i;

export interface DownloadInfo {
  version: string;
  file: string;
  url: string;
  sizeMb: number;
  sha256: string;
  publishedAt: string;
}

/** Calculer une empreinte coûte une lecture complète : on la garde tant que le fichier ne bouge pas. */
const cache = new Map<string, { key: string; sha256: string }>();

async function sha256Of(file: string, key: string): Promise<string> {
  const known = cache.get(file);
  if (known?.key === key) return known.sha256;
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject);
  });
  const sha256 = hash.digest("hex");
  cache.set(file, { key, sha256 });
  return sha256;
}

/** Le dernier installeur déposé, ou undefined tant qu'il n'y en a pas. */
export async function latestInstaller(dir: string): Promise<DownloadInfo | undefined> {
  if (!existsSync(dir)) return undefined;
  const candidates = readdirSync(dir)
    .map((name) => ({ name, match: VERSION.exec(name) }))
    .filter((c) => c.match)
    .map((c) => ({ name: c.name, version: c.match![1], stat: statSync(path.join(dir, c.name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const newest = candidates[0];
  if (!newest) return undefined;

  const full = path.join(dir, newest.name);
  return {
    version: newest.version,
    file: newest.name,
    url: `/telechargements/${encodeURIComponent(newest.name)}`,
    sizeMb: Math.round((newest.stat.size / 1_048_576) * 10) / 10,
    sha256: await sha256Of(full, `${newest.stat.mtimeMs}:${newest.stat.size}`),
    publishedAt: newest.stat.mtime.toISOString(),
  };
}

export function registerDownloads(app: FastifyInstance, dir: string): void {
  mkdirSync(dir, { recursive: true });

  void app.register(fastifyStatic, {
    root: dir,
    prefix: "/telechargements/",
    // `sendFile` est déjà décoré par le service du client compilé.
    decorateReply: false,
    index: false,
    // Un installeur porte sa version dans son nom : il ne change jamais sous la même adresse.
    maxAge: "1h",
  });

  app.get("/api/telechargement", async (_req, reply) => {
    const info = await latestInstaller(dir);
    // Pas encore d'installeur : ce n'est pas une erreur, c'est l'état d'avant la première livraison.
    if (!info) return reply.send({ current: null });
    return reply.send({ current: info });
  });
}
