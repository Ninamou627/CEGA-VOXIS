/**
 * Authentification (D17). Deux portes, deux mécanismes.
 *
 *   Administration et formateur — un compte (identifiant + mot de passe) et une session de
 *   connexion déposée dans un cookie `httpOnly`. Remplace le jeton dans l'URL : une adresse
 *   se retrouve dans un historique, une capture d'écran ou par-dessus l'épaule, et
 *   l'application de bureau a besoin d'un écran de connexion, pas d'un lien à coller.
 *
 *   Apprenant et écran de salle — un code de séance court, à durée limitée, encodé dans le
 *   QR code. C'est un secret de salle partagé par tout le monde, pas une identité : il ferme
 *   la porte à qui n'est pas de la formation, et il expire pour qu'une capture d'écran de la
 *   veille ne serve à rien.
 *
 * Le mot de passe est dérivé par scrypt (`node:crypto`, aucune dépendance) ; la vérification
 * est à temps constant. Les essais répétés sont freinés par adresse (`Throttle`).
 */
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";

export const COOKIE_NAME = "voxis_session";

export type AccountRole = "admin" | "lecturer";

/** À qui s'adresse un code d'accès : la salle entière, ou le formateur seul. */
export type CodeKind = "listener" | "lecturer";

export interface Account {
  /** PostgreSQL rend un BIGSERIAL sous forme de chaîne : on ne le convertit pas. */
  id: string;
  username: string;
  role: AccountRole;
}

// ---- mots de passe ------------------------------------------------------------------------
// N = 2^14 : ~16 Mo et quelques dizaines de millisecondes par essai — invisible à la
// connexion, coûteux pour qui essaierait un dictionnaire.
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

/** Le mot de passe n'est jamais stocké : on garde « scrypt$N$r$p$sel$empreinte ». */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { ...SCRYPT, maxmem: MAXMEM });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, key] = parts;
  try {
    const expected = Buffer.from(key, "base64url");
    const actual = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    // Empreinte illisible ou paramètres hors limites : on refuse, sans détailler.
    return false;
  }
}

// ---- codes d'accès ------------------------------------------------------------------------
/** Sans I, O, 0 ni 1 : un code se dicte à voix haute et se tape sans hésiter. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Deux usages, deux longueurs. Celui des apprenants est projeté et dicté à toute la salle :
 * six caractères, pour qu'il se tape vite. Celui du formateur est remis à une seule personne
 * et n'est jamais affiché : huit caractères ne coûtent rien et valent mille fois plus cher
 * à deviner.
 */
export const CODE_LENGTH: Record<CodeKind, number> = { listener: 6, lecturer: 8 };

export function newRoomCode(kind: CodeKind): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH[kind]; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Ce qu'un apprenant a tapé : majuscules, sans espaces ni tirets. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---- essais répétés -----------------------------------------------------------------------
/**
 * Un mot de passe ou un code de six caractères ne doit pas pouvoir être trouvé par essais.
 * En mémoire : le serveur est une instance unique (une formation à la fois, D17).
 */
export class Throttle {
  private readonly hits = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** true si l'adresse a droit à un essai. */
  allow(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return true;
    if (this.now() > h.until) {
      this.hits.delete(key);
      return true;
    }
    return h.n < this.max;
  }

  fail(key: string): void {
    const h = this.hits.get(key);
    const until = this.now() + this.windowMs;
    if (!h || this.now() > h.until) this.hits.set(key, { n: 1, until });
    else this.hits.set(key, { n: h.n + 1, until });
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}

// ---- cookies ------------------------------------------------------------------------------
/** Lecture d'un cookie dans un en-tête brut : la poignée de main WebSocket n'a pas Fastify. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// ---- l'ensemble ---------------------------------------------------------------------------
export interface AuthOptions {
  /** Durée d'une session de connexion : une journée de formation, sans se reconnecter. */
  sessionHours: number;
  /** Durée par défaut d'un code de séance. */
  codeHours: number;
}

export interface RoomCode {
  code: string;
  expiresAt: Date;
}

export class Auth {
  readonly logins = new Throttle();
  readonly codes = new Throttle(30);

  constructor(
    private readonly db: Db,
    private readonly opts: AuthOptions,
  ) {}

  // -- comptes ------------------------------------------------------------------------------
  /**
   * Premier démarrage : crée le compte d'administration, et seulement s'il n'y a aucun
   * compte. Renvoie true s'il vient d'être créé — l'appelant n'affiche un mot de passe
   * qu'à ce moment-là.
   */
  async seedAdmin(username: string, password: string): Promise<boolean> {
    const { count } = (await this.db.row<{ count: string }>(`SELECT count(*)::text AS count FROM accounts`))!;
    if (Number(count) > 0) return false;
    await this.createAccount(username, password, "admin");
    return true;
  }

  async accounts(): Promise<Account[]> {
    return this.db.rows<Account>(`SELECT id::text, username, role FROM accounts ORDER BY username`);
  }

  async createAccount(username: string, password: string, role: AccountRole): Promise<Account> {
    const row = await this.db.row<Account>(
      `INSERT INTO accounts (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id::text, username, role`,
      [username.trim().toLowerCase(), hashPassword(password), role],
    );
    return row!;
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.db.exec(`UPDATE accounts SET password_hash = $2 WHERE id = $1`, [id, hashPassword(password)]);
    // Un mot de passe changé ferme les sessions ouvertes ailleurs.
    await this.db.exec(`DELETE FROM auth_sessions WHERE account_id = $1`, [id]);
  }

  async deleteAccount(id: string): Promise<boolean> {
    return (await this.db.exec(`DELETE FROM accounts WHERE id = $1`, [id])) > 0;
  }

  // -- sessions de connexion ----------------------------------------------------------------
  /** Identifiants justes : une session, son cookie et sa date d'expiration. Sinon undefined. */
  async login(username: string, password: string, ua?: string): Promise<{ account: Account; sessionId: string; expiresAt: Date } | undefined> {
    const row = await this.db.row<Account & { password_hash: string }>(
      `SELECT id::text, username, role, password_hash FROM accounts WHERE username = $1`,
      [username.trim().toLowerCase()],
    );
    // Même coût de calcul quand le compte n'existe pas : l'échec ne dit pas lequel des deux est faux.
    const hash = row?.password_hash ?? hashPassword(randomBytes(16).toString("hex"));
    if (!verifyPassword(password, hash) || !row) return undefined;

    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.opts.sessionHours * 3_600_000);
    await this.db.exec(`INSERT INTO auth_sessions (id, account_id, expires_at, ua) VALUES ($1, $2, $3, $4)`, [
      sessionId,
      row.id,
      expiresAt,
      ua?.slice(0, 300) ?? null,
    ]);
    await this.db.exec(`UPDATE accounts SET last_login_at = now() WHERE id = $1`, [row.id]);
    return { account: { id: row.id, username: row.username, role: row.role }, sessionId, expiresAt };
  }

  /** Le compte derrière un cookie, ou undefined si la session est inconnue ou expirée. */
  async accountOf(sessionId: string | undefined): Promise<Account | undefined> {
    if (!sessionId) return undefined;
    return this.db.row<Account>(
      `SELECT a.id::text, a.username, a.role
         FROM auth_sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sessionId],
    );
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.db.exec(`DELETE FROM auth_sessions WHERE id = $1`, [sessionId]);
  }

  // -- codes d'accès ------------------------------------------------------------------------
  /** Le code courant d'un usage, ou undefined s'il n'y en a pas ou s'il a expiré. */
  async roomCode(kind: CodeKind): Promise<RoomCode | undefined> {
    const row = await this.db.row<{ code: string; expires_at: Date }>(
      `SELECT code, expires_at FROM access_codes WHERE kind = $1 AND expires_at > now()`,
      [kind],
    );
    return row && { code: row.code, expiresAt: row.expires_at };
  }

  /** Nouveau code : l'ancien ne vaut plus rien — pour les apprenants, l'ancien QR non plus. */
  async rotateRoomCode(kind: CodeKind, hours = this.opts.codeHours): Promise<RoomCode> {
    const code = newRoomCode(kind);
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    await this.db.exec(
      `INSERT INTO access_codes (kind, code, expires_at, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (kind) DO UPDATE SET code = $2, expires_at = $3, updated_at = now()`,
      [kind, code, expiresAt],
    );
    return { code, expiresAt };
  }

  async checkRoomCode(kind: CodeKind, input: string | undefined): Promise<boolean> {
    if (!input) return false;
    const current = await this.roomCode(kind);
    return Boolean(current && sameCode(normalizeCode(input), current.code));
  }

  /** Sessions de connexion périmées : rien à garder. */
  async purgeExpired(): Promise<void> {
    await this.db.exec(`DELETE FROM auth_sessions WHERE expires_at < now()`);
  }
}
