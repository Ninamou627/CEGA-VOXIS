/**
 * PostgreSQL : ce qui doit survivre à un redémarrage et ne peut pas vivre dans un fichier
 * — les comptes, les sessions de connexion, le code de séance.
 *
 * Pas d'ORM : quelques tables, du SQL lisible, et des migrations numérotées appliquées au
 * démarrage dans une transaction. Les réglages de la salle restent dans `data/settings.json`
 * (`settings.ts`) : ils se rechargent à chaud et ne concernent pas la sécurité.
 */
import { Pool } from "pg";

/**
 * Migrations, dans l'ordre, jamais modifiées après coup : une base déjà migrée ne rejoue
 * pas ce qu'elle a appliqué. Pour corriger, on ajoute une migration.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001-comptes-et-seance",
    sql: `
      CREATE TABLE accounts (
        id            BIGSERIAL PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'lecturer')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );

      -- Sessions de connexion de l'administration et des formateurs. L'identifiant est un
      -- aléa opaque : rien à falsifier, et une déconnexion supprime vraiment la ligne.
      CREATE TABLE auth_sessions (
        id         TEXT PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        ua         TEXT
      );
      CREATE INDEX auth_sessions_expires_at ON auth_sessions (expires_at);

      -- Le code que les apprenants et l'écran de salle présentent. Une seule formation à la
      -- fois (D17) : la contrainte force une ligne unique, et la table deviendra « séances »
      -- le jour où plusieurs formations tourneront en parallèle.
      CREATE TABLE room_code (
        only_row   BOOLEAN PRIMARY KEY DEFAULT true CHECK (only_row),
        code       TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    name: "002-code-formateur",
    sql: `
      -- Deux codes, pas un : celui des apprenants est projeté et dicté à toute la salle,
      -- celui du formateur est remis à une seule personne et n'apparaît jamais à l'écran.
      -- Une ligne par usage ; une seule formation à la fois, donc deux lignes au plus.
      CREATE TABLE access_codes (
        kind       TEXT PRIMARY KEY CHECK (kind IN ('listener', 'lecturer')),
        code       TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO access_codes (kind, code, expires_at, updated_at)
        SELECT 'listener', code, expires_at, updated_at FROM room_code;

      DROP TABLE room_code;
    `,
  },
];

export class Db {
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000 });
    // Une erreur sur une connexion au repos ne doit pas tuer le processus de la salle.
    this.pool.on("error", () => {});
  }

  async rows<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async row<T extends object>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.rows<T>(sql, params))[0];
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.pool.query(sql, params)).rowCount ?? 0;
  }

  /** Vérifie la liaison et applique les migrations qui manquent. */
  async migrate(log: (msg: string) => void): Promise<void> {
    await this.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await this.rows<{ name: string }>(`SELECT name FROM migrations`)).map((r) => r.name));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query(`INSERT INTO migrations (name) VALUES ($1)`, [m.name]);
        await client.query("COMMIT");
        log(`migration appliquée : ${m.name}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${m.name} en échec : ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
