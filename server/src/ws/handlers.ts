/**
 * Liaison WebSocket ↔ salle ↔ pipeline.
 *
 * Un participant commence par un `join` (validé par zod). Ensuite :
 *   - formateur  : binaire = PCM du micro → pipeline ; reçoit l'audio des questions ;
 *   - apprenant  : reçoit texte + audio de sa langue ; envoie ack / ask / resync ;
 *   - tableau de bord : reçoit tout le texte et les stats, jamais l'audio ;
 *   - écran de salle : comme le tableau de bord, sans jeton (sous-titres projetés).
 */
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { encodeFrame } from "../../../shared/framing";
import { ClientEventSchema, PROTOCOL_VERSION, type AudioHeader, type Lang, type ServerEvent } from "../../../shared/protocol";
import type { Config } from "../config";
import type { Metrics } from "../metrics";
import type { Pipeline } from "../pipeline/pipeline";
import type { Providers } from "../providers/types";
import type { Participant, Room } from "../room";

export interface WsContext {
  room: Room;
  pipeline: Pipeline;
  providers: Providers;
  metrics: Metrics;
  config: Config;
  log: { info(o: object, msg?: string): void; warn(o: object, msg?: string): void; error(o: object, msg?: string): void };
}

function toBytes(data: RawData): Uint8Array {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Messages binaires reçus, tous rôles confondus (diagnostic). */
export let binaryFrames = 0;

/** Derniers segments diffusés, pour retrouver ce qu'un apprenant signale. */
const RECENT_SEGMENTS = 60;
interface RecentSegment {
  seq: number;
  srcText: string;
  tOrigin: number;
  tgt: Partial<Record<Lang, string>>;
}

export function attachWs(wss: WebSocketServer, ctx: WsContext): void {
  const { room, pipeline, providers, metrics, config, log } = ctx;

  const recent = new Map<number, RecentSegment>();
  function remember(seq: number, patch: Partial<RecentSegment>) {
    const cur = recent.get(seq) ?? { seq, srcText: "", tOrigin: Date.now(), tgt: {} };
    recent.set(seq, { ...cur, ...patch, tgt: { ...cur.tgt, ...patch.tgt } });
    while (recent.size > RECENT_SEGMENTS) recent.delete(recent.keys().next().value!);
  }

  // ---- pipeline → salle -----------------------------------------------------
  pipeline.on("src.partial", (e) => room.broadcast({ t: "src.partial", text: e.text }, (p) => p.role !== "listener" || p.lang === room.srcLang));
  pipeline.on("src.commit", (e) => {
    remember(e.seq, { srcText: e.text, tOrigin: e.tOrigin });
    room.broadcast({ t: "src.commit", ...e });
  });
  pipeline.on("tr.segment", (e) => {
    remember(e.seq, { tgt: { [e.lang]: e.text } });
    room.broadcast({ t: "tr.segment", ...e }, (p) => p.role !== "listener" || p.lang === e.lang);
  });
  pipeline.on("audio", (e) => {
    const header: AudioHeader = {
      t: "audio",
      seq: e.seq,
      lang: e.lang,
      mime: e.mime,
      durMs: e.durMs,
      tOrigin: e.tOrigin,
      srcSeq: e.srcSeq,
      text: e.text,
      kind: "translation",
    };
    const frame = encodeFrame(header, e.bytes);
    room.broadcastBinary(frame, (p) => p.role === "listener" && p.lang === e.lang);
  });
  pipeline.on("degraded", (e) => room.broadcast({ t: "degraded", ...e }));
  pipeline.on("error", (e) => {
    log.warn({ stage: e.stage, err: e.error.message }, "erreur pipeline");
    // Le formateur et le tableau de bord doivent voir les pannes, pas seulement le journal.
    room.broadcast({ t: "error", code: `${e.stage}_error`, msg: `${e.stage.toUpperCase()} : ${e.error.message.slice(0, 200)}` }, (p) => p.role !== "listener");
  });

  // ---- stats périodiques ------------------------------------------------------
  const statsTimer = setInterval(() => {
    const snap = metrics.snapshot();
    room.broadcast({
      t: "stats",
      stats: { listeners: room.count("listener"), byLang: room.listenersByLang(), ...snap, pipeline: pipeline.status },
    });
  }, 2000);
  wss.on("close", () => clearInterval(statsTimer));

  // ---- connexions -------------------------------------------------------------
  wss.on("connection", (ws: WebSocket, req) => {
    const id = randomUUID().slice(0, 8);
    let me: Participant | undefined;
    let questionAudio: Uint8Array[] = [];
    let questionMime = "audio/webm";
    const remote = req.socket.remoteAddress;

    const sendErr = (code: string, msg: string) => ws.send(JSON.stringify({ t: "error", code, msg } satisfies ServerEvent));

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        binaryFrames++;
        if (!me) return;
        if (me.role === "lecturer") {
          pipeline.pushAudio(toBytes(data));
        } else if (me.role === "listener" && room.floor.state === "question" && room.floor.who === me.id) {
          questionAudio.push(new Uint8Array(toBytes(data))); // copie : le Buffer de ws peut être recyclé
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return sendErr("bad_json", "message illisible");
      }
      const r = ClientEventSchema.safeParse(parsed);
      if (!r.success) return sendErr("bad_event", r.error.issues.map((i) => i.message).join("; "));
      const evt = r.data;

      // -- join --------------------------------------------------------------
      if (evt.t === "join") {
        if (me) return sendErr("already_joined", "déjà connecté");
        if ((evt.role === "lecturer" || evt.role === "dashboard") && evt.token !== config.SESSION_TOKEN) {
          sendErr("unauthorized", "jeton invalide");
          return ws.close(4401, "unauthorized");
        }
        if (evt.session && evt.session !== room.sessionId) {
          sendErr("bad_session", `session inconnue : ${evt.session}`);
          return ws.close(4404, "bad_session");
        }
        if (evt.role === "lecturer" && room.count("lecturer") > 0) {
          sendErr("lecturer_exists", "un formateur est déjà connecté");
          return ws.close(4409, "lecturer_exists");
        }
        const lang: Lang = evt.role === "listener" ? (evt.lang ?? room.langs[0]) : room.srcLang;
        if (evt.role === "listener" && !room.langs.includes(lang)) return sendErr("bad_lang", `langue non diffusée : ${lang}`);

        me = { id, role: evt.role, lang, ws, ua: evt.ua, joinedAt: Date.now() };
        room.add(me);
        log.info({ id, role: evt.role, lang, remote }, "participant connecté");
        metrics.event("join", { id, role: evt.role, lang, ua: evt.ua });

        if (evt.role === "lecturer") {
          const sampleRate = evt.sampleRate ?? 16000;
          pipeline
            .start()
            .then(() => log.info({ sampleRate }, "pipeline démarré"))
            .catch((err: Error) => {
              log.error({ err: err.message }, "démarrage du pipeline impossible");
              sendErr("pipeline_start", err.message);
            });
        }

        room.send(me, {
          t: "hello",
          v: PROTOCOL_VERSION,
          sessionId: room.sessionId,
          role: me.role,
          participantId: me.id,
          langs: room.langs,
          srcLang: room.srcLang,
          tServer: Date.now(),
          floor: room.floor,
          pipeline: pipeline.status,
        });
        return;
      }

      if (!me) return sendErr("not_joined", "envoyez join d'abord");

      // -- apprenant -----------------------------------------------------------
      if (evt.t === "ack") {
        const e2e = metrics.ack(me.id, evt.seq, evt.tOrigin, evt.queueMs);
        if (e2e > 8000) log.warn({ id: me.id, e2e, queueMs: evt.queueMs }, "client très en retard");
        return;
      }
      if (evt.t === "resync") {
        metrics.event("resync", { id: me.id, droppedMs: evt.droppedMs });
        return;
      }
      if (evt.t === "ask") {
        if (me.role !== "listener") return sendErr("not_listener", "réservé aux apprenants");
        if (evt.phase === "start") {
          if (!room.takeFloor(me.id)) return sendErr("floor_busy", "quelqu'un parle déjà");
          questionAudio = [];
          questionMime = evt.mime ?? "audio/webm";
          room.broadcast({ t: "floor", floor: room.floor });
          metrics.event("ask.start", { id: me.id });
          return;
        }
        // phase "end"
        if (!room.releaseFloor(me.id)) return;
        const chunks = questionAudio;
        questionAudio = [];
        const asker = me;
        room.broadcast({ t: "floor", floor: room.floor });
        void handleVoiceQuestion(asker, chunks, evt.mime ?? questionMime);
        return;
      }
      /** Question écrite : rien à transcrire, et elle ne prend la parole à personne. */
      if (evt.t === "ask.text") {
        if (me.role !== "listener") return sendErr("not_listener", "réservé aux apprenants");
        void deliverQuestion(me, evt.text.trim(), "text", Date.now());
        return;
      }
      if (evt.t === "report") {
        if (me.role !== "listener") return sendErr("not_listener", "réservé aux apprenants");
        const lang = me.lang ?? room.langs[0];
        // Le serveur retrouve le contexte : l'apprenant ne ressaisit jamais la phrase.
        const seg = evt.seq != null ? recent.get(evt.seq) : undefined;
        const report = {
          t: "report" as const,
          who: me.id,
          kind: evt.kind,
          lang,
          at: Date.now(),
          seq: seg?.seq,
          srcText: seg?.srcText,
          text: seg?.tgt[lang],
          e2eMs: evt.e2eMs ?? null,
        };
        room.broadcast(report, (p) => p.role === "lecturer" || p.role === "dashboard");
        // Le JSONL est la mémoire longue : c'est là qu'on relira les signalements
        // pour régler la segmentation, enrichir le glossaire ou changer de voix.
        metrics.event("report", {
          id: me.id,
          kind: evt.kind,
          lang,
          seq: seg?.seq ?? null,
          srcText: seg?.srcText ?? null,
          text: seg?.tgt[lang] ?? null,
          e2eMs: evt.e2eMs ?? null,
          pipeline: pipeline.status,
        });
        log.info({ id: me.id, kind: evt.kind, seq: seg?.seq ?? null }, "signalement d'un apprenant");
        return;
      }

      // -- formateur -----------------------------------------------------------
      if (evt.t === "lecturer.mute") {
        if (me.role !== "lecturer") return sendErr("not_lecturer", "réservé au formateur");
        pipeline.setMuted(evt.muted);
        metrics.event("mute", { muted: evt.muted });
        return;
      }
    });

    ws.on("close", () => {
      if (!me) return;
      const hadFloor = room.floor.state === "question" && room.floor.who === me.id;
      room.remove(me.id);
      metrics.forget(me.id);
      metrics.event("leave", { id: me.id, role: me.role });
      log.info({ id: me.id, role: me.role }, "participant déconnecté");
      if (hadFloor) room.broadcast({ t: "floor", floor: room.floor });
      if (me.role === "lecturer") {
        pipeline.stop().catch((err: Error) => log.error({ err: err.message }, "arrêt du pipeline"));
      }
    });

    ws.on("error", (err) => log.warn({ id, err: err.message }, "erreur socket"));
  });

  // ---- flux inverse : question d'un apprenant, en batch --------------------------
  /** Question parlée : on transcrit d'abord, puis c'est le même chemin qu'une question écrite. */
  async function handleVoiceQuestion(asker: Participant, chunks: Uint8Array[], mime: string) {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    if (!total) return;
    const audio = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      audio.set(c, off);
      off += c.byteLength;
    }
    const srcLang = asker.lang ?? room.langs[0];
    const t0 = Date.now();
    try {
      const srcText = await providers.stt.transcribeOnce(audio, mime, srcLang);
      if (!srcText.trim()) {
        room.send(asker, { t: "question", who: asker.id, srcLang, srcText: "", lang: room.srcLang, text: "", delivered: false, mode: "voice" });
        metrics.event("question.empty", { id: asker.id, bytes: total, mime });
        return;
      }
      await deliverQuestion(asker, srcText, "voice", t0, { bytes: total, mime });
    } catch (err) {
      log.error({ err: (err as Error).message }, "traitement de la question");
      room.send(asker, { t: "error", code: "question_failed", msg: "la question n'a pas pu être transmise" });
    }
  }

  /**
   * Traduit la question vers la langue du formateur, la synthétise et l'envoie.
   * Le son part dans les deux cas ; seule une question parlée se joue d'elle-même
   * dans le casque (`autoplay`), une question écrite attend que le formateur la lance.
   */
  async function deliverQuestion(asker: Participant, srcText: string, mode: "voice" | "text", t0: number, extra: Record<string, unknown> = {}) {
    const srcLang = asker.lang ?? room.langs[0];
    try {
      const text = await providers.mt.translate({ text: srcText, from: srcLang, to: room.srcLang, context: [] });
      const tts = await providers.tts.synthesize({ text, lang: room.srcLang });

      const delivered = room.count("lecturer") > 0;
      room.broadcast({ t: "question", who: asker.id, srcLang, srcText, lang: room.srcLang, text, delivered, mode }, (p) => p.role !== "listener" || p.id === asker.id);
      log.info({ id: asker.id, mode, srcText: srcText.slice(0, 80), delivered }, "question traitée");
      const header: AudioHeader = {
        t: "audio",
        seq: 0,
        lang: room.srcLang,
        mime: tts.mime,
        durMs: tts.durMs,
        tOrigin: t0,
        srcSeq: 0,
        text,
        kind: "question",
        autoplay: mode === "voice",
      };
      room.broadcastBinary(encodeFrame(header, tts.audio), (p) => p.role === "lecturer");

      if (mode === "voice") {
        // Pendant que la question sort dans le casque du formateur, son micro n'alimente
        // plus le STT — sinon on retranscrit la question et on boucle.
        const wasMuted = pipeline.status.muted;
        pipeline.setMuted(true);
        setTimeout(() => pipeline.setMuted(wasMuted), tts.durMs + 300);
      }

      metrics.event("question", { id: asker.id, mode, totalMs: Date.now() - t0, chars: srcText.length, delivered, ...extra });
    } catch (err) {
      log.error({ err: (err as Error).message }, "traitement de la question");
      room.send(asker, { t: "error", code: "question_failed", msg: "la question n'a pas pu être transmise" });
    }
  }
}
