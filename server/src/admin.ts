/**
 * API de l'administration (tableau de bord). Toutes les routes exigent un compte
 * d'administration connecté (cookie de session, voir `auth.ts` et D17).
 *
 *   GET    /api/admin/settings          réglages, valeurs d'installation, options possibles
 *   PUT    /api/admin/settings          enregistrer (validé) ; dit ce qui s'applique quand
 *   POST   /api/admin/settings/reset    revenir aux valeurs d'installation (les voix restent)
 *   GET    /api/admin/overview          compteurs de long terme, qualité, voix, incidents
 *   GET    /api/admin/voices/catalog    voix du compte ElevenLabs
 *   POST   /api/admin/voices            ajouter une voix { id, lang }
 *   DELETE /api/admin/voices/:id        retirer une voix (?lang=)
 *   POST   /api/admin/voices/preview    écoute d'essai { id, lang, text? } → audio/mpeg
 *   GET    /api/admin/code              codes apprenant et formateur (null avant la séance)
 *   POST   /api/admin/code              nouveau code { kind, hours? } — l'ancien ne vaut plus
 *   GET    /api/admin/accounts          comptes
 *   POST   /api/admin/accounts          créer { username, password, role }
 *   POST   /api/admin/accounts/:id/password   changer un mot de passe { password }
 *   DELETE /api/admin/accounts/:id      supprimer (jamais le dernier administrateur)
 */
import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { OverviewResponse, Quality, SaveResponse, SettingsResponse, VoiceStats } from "../../shared/admin";
import { CreateAccountSchema, PasswordSchema, RotateCodeSchema, type AccountView, type CodeKind, type CurrentCodeResponse, type RoomCodeResponse } from "../../shared/auth";
import { LangSchema, type Lang } from "../../shared/protocol";
import type { Auth } from "./auth";
import { requireAccount } from "./auth-api";
import type { Config } from "./config";
import type { RoomProviders } from "./providers";
import { CLAUDE_MODELS } from "./providers/mt/claude-models";
import { ElevenLabsTts } from "./providers/tts/elevenlabs";
import { appliesAt, type Settings, type SettingsStore, type VoiceEntry } from "./settings";
import type { DayTotals, Totals } from "./totals";
import { VoiceNotFound, type VoiceCatalog } from "./voices/elevenlabs";

export interface AdminContext {
  cfg: Config;
  store: SettingsStore;
  totals: Totals;
  providers: RoomProviders;
  catalog?: VoiceCatalog;
  auth: Auth;
  /** Adresse publique de la salle, pour composer le lien du QR code. */
  publicUrl: () => string;
}

/** Phrase d'essai dans la langue de la voix : on juge une voix sur ce qu'elle dira en séance. */
const SAMPLE: Record<Lang, string> = {
  fr: "Bonjour à toutes et à tous. Je suis la voix qui vous accompagnera pendant cette formation.",
  en: "Hello everyone. I am the voice that will interpret this training session for you.",
  es: "Hola a todos. Soy la voz que les acompañará durante esta formación.",
  pt: "Olá a todos. Sou a voz que vai acompanhá-los durante esta formação.",
  ar: "مرحبًا بكم جميعًا. أنا الصوت الذي سيرافقكم طوال هذا التدريب.",
};

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
const reportsOf = (d: DayTotals, k: "transcription" | "translation" | "slow" | "voice" | "audio") => d.reports[k] ?? 0;

/** Les quatre piliers de la qualité, chacun avec sa mesure et son échantillon. */
function quality(d: DayTotals, e2e: { p95: number | null }): Quality {
  return {
    speed: { meanMs: d.e2eN ? Math.round(d.e2eSum / d.e2eN) : null, p95Ms: e2e.p95, n: d.e2eN, reports: reportsOf(d, "slow") },
    transcription: { confidence: ratio(d.confSum, d.confN), n: d.confN, reports: reportsOf(d, "transcription"), segments: d.translated },
    translation: {
      ok: d.translated ? 1 - (reportsOf(d, "translation") + d.untranslated) / d.translated : null,
      n: d.translated,
      reports: reportsOf(d, "translation"),
      untranslated: d.untranslated,
    },
    voice: { natural: d.spoken ? 1 - reportsOf(d, "voice") / d.spoken : null, n: d.spoken, reports: reportsOf(d, "voice"), audioReports: reportsOf(d, "audio") },
  };
}

function formatZod(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "réglages"} : ${i.message}`).join(" ; ");
}

export function registerAdmin(app: FastifyInstance, ctx: AdminContext): void {
  const { cfg, store, totals, providers, catalog, auth } = ctx;
  // Écoutes d'essai : l'instance de la salle si ElevenLabs y sert, sinon une instance à part —
  // on peut choisir ses voix avant de basculer la voix de séance sur ElevenLabs.
  const previewer =
    providers.elevenlabs ??
    (cfg.ELEVENLABS_API_KEY ? new ElevenLabsTts({ apiKey: cfg.ELEVENLABS_API_KEY, voiceId: cfg.ELEVENLABS_VOICE_ID ?? "essai", model: cfg.ELEVENLABS_MODEL }) : undefined);

  void app.register(
    async (admin) => {
      // L'administration est réservée au rôle « admin » : un compte de formateur ouvre la
      // page Formateur, pas les réglages de la salle.
      admin.addHook("preHandler", async (req, reply) => {
        req.account = await requireAccount(auth, req, reply, true);
      });

      // ---- réglages -------------------------------------------------------------
      admin.get("/settings", async (): Promise<SettingsResponse> => ({
        settings: store.get(),
        defaults: store.defaults,
        options: {
          mtEngines: providers.mtEngines,
          models: CLAUDE_MODELS,
          stt: providers.stt.name,
          sttTunable: cfg.STT_PROVIDER === "assemblyai",
          sttPrompt: cfg.STT_PROVIDER === "assemblyai" && cfg.ASSEMBLYAI_MODEL.startsWith("universal-3"),
          tts: providers.tts.name,
          voicesEnabled: Boolean(catalog),
          /** La voix de séance est-elle ElevenLabs ? Sinon les voix choisies attendront la bascule. */
          elevenlabsInUse: Boolean(providers.elevenlabs),
          srcLang: cfg.SRC_LANG,
          targetLangs: cfg.TARGET_LANGS,
          nextMic: ["speech.endpointing", "speech.keyterms", "speech.prompt"].filter((k) => appliesAt(k) === "next-mic"),
          azure: cfg.AZURE_SPEECH_KEY ? { fr: cfg.AZURE_TTS_VOICE, en: cfg.AZURE_TTS_VOICE_EN } : null,
        },
      }));

      admin.put("/settings", async (req, reply) => {
        try {
          const { settings, changed } = store.update(req.body);
          const res: SaveResponse = {
            settings,
            changed,
            live: changed.filter((k) => appliesAt(k) === "live"),
            nextMic: changed.filter((k) => appliesAt(k) === "next-mic"),
          };
          return res;
        } catch (err) {
          if (err instanceof ZodError) return reply.code(400).send({ error: formatZod(err) });
          throw err;
        }
      });

      admin.post("/settings/reset", async (): Promise<SaveResponse> => {
        const { settings, changed } = store.reset();
        return { settings, changed, live: changed.filter((k) => appliesAt(k) === "live"), nextMic: changed.filter((k) => appliesAt(k) === "next-mic") };
      });

      // ---- vue d'ensemble : ce qui ne tient pas dans les stats en direct --------
      admin.get("/overview", async (): Promise<OverviewResponse> => {
        const all = totals.all();
        const today = totals.today();
        const e2e = { p50: totals.e2ePercentile(50), p95: totals.e2ePercentile(95) };
        const voices: Record<string, VoiceStats> = {};
        for (const [id, v] of Object.entries(totals.voices())) {
          voices[id] = { ...v, natural: ratio(v.spoken - v.unnatural, v.spoken) };
        }
        return {
          since: totals.since,
          all,
          today,
          availability: ratio(all.availableMs, all.sessionMs),
          availabilityToday: ratio(today.availableMs, today.sessionMs),
          e2e,
          end: { p50: totals.endPercentile(50), p95: totals.endPercentile(95), n: totals.endCount() },
          quality: quality(all, e2e),
          qualityToday: quality(today, { p95: null }),
          days: totals.lastDays(14).map(({ day, totals: d }) => ({
            day,
            translatedMs: d.translatedMs,
            sessionMs: d.sessionMs,
            availability: ratio(d.availableMs, d.sessionMs),
            e2eMean: d.e2eN ? Math.round(d.e2eSum / d.e2eN) : null,
            confidence: ratio(d.confSum, d.confN),
            translationOk: d.translated ? 1 - (reportsOf(d, "translation") + d.untranslated) / d.translated : null,
            voiceNatural: d.spoken ? 1 - reportsOf(d, "voice") / d.spoken : null,
            reports: Object.values(d.reports).reduce((a, b) => a + (b ?? 0), 0),
          })),
          voices,
          lastErrors: totals.lastErrors,
          reports: totals.recentReports.slice(-50).reverse(),
        };
      });

      // ---- voix -------------------------------------------------------------------
      admin.get("/voices/catalog", async (req, reply) => {
        if (!catalog) return reply.code(409).send({ error: "ElevenLabs n'est pas configuré sur le serveur de salle : sa clé d'API manque." });
        const force = (req.query as { refresh?: string }).refresh === "1";
        try {
          return { voices: await catalog.list(force) };
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });

      const AddVoice = z.object({ id: z.string().trim().min(1).max(64), lang: LangSchema });

      admin.post("/voices", async (req, reply) => {
        if (!catalog) return reply.code(409).send({ error: "ElevenLabs n'est pas configuré." });
        const body = AddVoice.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: formatZod(body.error) });
        const { id, lang } = body.data;
        try {
          const v = await catalog.get(id);
          const s = store.get();
          const entry: VoiceEntry = {
            id: v.id,
            name: v.name.slice(0, 80),
            lang,
            provider: "elevenlabs",
            gender: v.gender?.slice(0, 24),
            accent: v.accent?.slice(0, 40),
            age: v.age?.slice(0, 24),
            description: v.description?.slice(0, 200),
            previewUrl: v.previewUrl?.slice(0, 500),
            addedAt: Date.now(),
          };
          const next: Settings = {
            ...s,
            voices: [...s.voices.filter((x) => !(x.id === id && x.lang === lang)), entry],
            // La première voix d'une langue en devient la voix par défaut.
            voice: s.voice.defaults[lang] ? s.voice : { ...s.voice, defaults: { ...s.voice.defaults, [lang]: id } },
          };
          return { settings: store.update(next).settings, voice: entry };
        } catch (err) {
          if (err instanceof VoiceNotFound) return reply.code(404).send({ error: err.message });
          if (err instanceof ZodError) return reply.code(400).send({ error: formatZod(err) });
          return reply.code(502).send({ error: (err as Error).message });
        }
      });

      admin.delete("/voices/:id", async (req) => {
        const { id } = req.params as { id: string };
        const { lang } = req.query as { lang?: Lang };
        const s = store.get();
        const voices = s.voices.filter((x) => !(x.id === id && (!lang || x.lang === lang)));
        const defaults = { ...s.voice.defaults };
        for (const l of Object.keys(defaults) as Lang[]) {
          // Une voix retirée n'est plus la voix par défaut : la langue revient à celle du .env.
          if (defaults[l] === id && (!lang || l === lang)) delete defaults[l];
        }
        return { settings: store.update({ ...s, voices, voice: { ...s.voice, defaults } }).settings };
      });

      const Preview = z.object({ id: z.string().trim().min(1).max(64), lang: LangSchema, text: z.string().trim().max(300).optional() });

      admin.post("/voices/preview", async (req, reply) => {
        if (!previewer) return reply.code(409).send({ error: "ElevenLabs n'est pas configuré." });
        const body = Preview.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: formatZod(body.error) });
        const { id, lang, text } = body.data;
        try {
          const a = await previewer.synthesize({ text: text || SAMPLE[lang], lang, voice: id, speed: store.get().voice.speed });
          return reply.type(a.mime).send(Buffer.from(a.audio));
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });

      // ---- codes d'accès ----------------------------------------------------------
      // Seule route qui expose les codes : `/api/session`, publique, n'en dit rien.
      const codeResponse = (kind: CodeKind, c: { code: string; expiresAt: Date }): RoomCodeResponse => ({
        kind,
        code: c.code,
        expiresAt: c.expiresAt.toISOString(),
        // Pas de lien pour le code formateur : il ne doit jamais finir dans un QR projeté.
        joinUrl: kind === "listener" ? `${ctx.publicUrl()}/?c=${c.code}` : undefined,
      });

      // Pas de code, ou expiré : ce n'est pas une erreur, c'est l'état d'avant la séance.
      admin.get("/code", async (): Promise<CurrentCodeResponse> => {
        const [listener, lecturer] = await Promise.all([auth.roomCode("listener"), auth.roomCode("lecturer")]);
        return {
          listener: listener ? codeResponse("listener", listener) : null,
          lecturer: lecturer ? codeResponse("lecturer", lecturer) : null,
        };
      });

      admin.post("/code", async (req, reply) => {
        const body = RotateCodeSchema.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: formatZod(body.error) });
        const { kind, hours } = body.data;
        const next = await auth.rotateRoomCode(kind, hours);
        app.log.info({ kind, expiresAt: next.expiresAt }, "nouveau code d'accès");
        return codeResponse(kind, next);
      });

      // ---- comptes ----------------------------------------------------------------
      admin.get("/accounts", async (): Promise<{ accounts: AccountView[] }> => ({ accounts: await auth.accounts() }));

      admin.post("/accounts", async (req, reply) => {
        const body = CreateAccountSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: formatZod(body.error) });
        const { username, password, role } = body.data;
        if ((await auth.accounts()).some((a) => a.username === username)) {
          return reply.code(409).send({ error: `le compte « ${username} » existe déjà` });
        }
        return { account: await auth.createAccount(username, password, role) };
      });

      admin.post("/accounts/:id/password", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z.object({ password: PasswordSchema }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: formatZod(body.error) });
        if (!(await auth.accounts()).some((a) => a.id === id)) return reply.code(404).send({ error: "compte inconnu" });
        await auth.setPassword(id, body.data.password);
        // Les sessions de ce compte sont fermées : il se reconnecte avec le nouveau mot de passe.
        return { ok: true };
      });

      admin.delete("/accounts/:id", async (req, reply) => {
        const { id } = req.params as { id: string };
        const accounts = await auth.accounts();
        const target = accounts.find((a) => a.id === id);
        if (!target) return reply.code(404).send({ error: "compte inconnu" });
        if (req.account?.id === id) return reply.code(409).send({ error: "on ne supprime pas le compte avec lequel on est connecté" });
        if (target.role === "admin" && accounts.filter((a) => a.role === "admin").length <= 1) {
          return reply.code(409).send({ error: "c'est le dernier compte d'administration : en créer un autre d'abord" });
        }
        await auth.deleteAccount(id);
        return { ok: true };
      });
    },
    { prefix: "/api/admin" },
  );
}
