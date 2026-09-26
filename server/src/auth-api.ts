/**
 * Routes de connexion, et les gardes que l'administration réutilise.
 *
 *   POST /api/auth/login    { username, password } → dépose le cookie de session
 *   POST /api/auth/logout   ferme la session courante
 *   GET  /api/auth/me       qui est connecté (jamais 401 : l'interface a besoin de savoir)
 *
 * La logique est dans `auth.ts` ; ici, seulement le HTTP.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { LoginSchema, type MeResponse } from "../../shared/auth";
import { type Account, type Auth, COOKIE_NAME } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    /** Compte connecté, posé par la garde d'une route. */
    account?: Account;
  }
}

export interface AuthApiContext {
  auth: Auth;
  /** `secure` sur le cookie : impossible en HTTP, indispensable en HTTPS. */
  tls: boolean;
  log: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void };
}

function cookieOptions(tls: boolean, expires?: Date) {
  return { httpOnly: true, sameSite: "lax" as const, secure: tls, path: "/", expires };
}

/** Le compte connecté, ou `undefined`. À utiliser dans un `preHandler`. */
export async function accountOf(auth: Auth, req: FastifyRequest): Promise<Account | undefined> {
  return auth.accountOf(req.cookies[COOKIE_NAME]);
}

/**
 * Garde d'une route : exige une session valide, et le rôle d'administration si demandé.
 * Renvoie le compte, ou répond 401/403 et renvoie undefined.
 */
export async function requireAccount(auth: Auth, req: FastifyRequest, reply: FastifyReply, adminOnly = false): Promise<Account | undefined> {
  const account = await accountOf(auth, req);
  if (!account) {
    await reply.code(401).send({ error: "connexion requise" });
    return undefined;
  }
  if (adminOnly && account.role !== "admin") {
    await reply.code(403).send({ error: "réservé à l'administration" });
    return undefined;
  }
  return account;
}

export function registerAuth(app: FastifyInstance, ctx: AuthApiContext): void {
  const { auth, tls, log } = ctx;

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "identifiant ou mot de passe manquant" });

    if (!auth.logins.allow(req.ip)) {
      log.warn({ ip: req.ip }, "connexion : trop d'essais, adresse freinée");
      return reply.code(429).send({ error: "trop d'essais. Réessayez dans quelques minutes." });
    }

    const ua = req.headers["user-agent"];
    const session = await auth.login(parsed.data.username, parsed.data.password, ua);
    if (!session) {
      auth.logins.fail(req.ip);
      log.warn({ ip: req.ip, username: parsed.data.username }, "connexion refusée");
      // Un seul message : ne pas dire lequel des deux champs est faux.
      return reply.code(401).send({ error: "identifiant ou mot de passe incorrect" });
    }

    auth.logins.succeed(req.ip);
    log.info({ username: session.account.username, role: session.account.role }, "connexion");
    void reply.setCookie(COOKIE_NAME, session.sessionId, cookieOptions(tls, session.expiresAt));
    const body: MeResponse = { account: session.account };
    return body;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await auth.logout(req.cookies[COOKIE_NAME]);
    void reply.clearCookie(COOKIE_NAME, cookieOptions(tls));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req): Promise<MeResponse> => {
    const account = await accountOf(auth, req);
    return { account: account ?? null };
  });
}
