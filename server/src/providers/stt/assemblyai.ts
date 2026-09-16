/**
 * AssemblyAI Universal-3.5 Pro Realtime — STT primaire recommandé.
 *
 * Aligné sur le document « AssemblyAI Integration — Coding Agent Instructions » :
 *   - `mode` est le réglage principal (min_latency / balanced / max_accuracy) ;
 *   - sur U3.5 Pro, `end_of_turn:true` est finalisé ET ponctué en un seul message
 *     (`format_turns` n'existe pas sur ce modèle ; un garde-fou reste pour les anciens) ;
 *   - `prompt` (description de la séance) et `keyterms_prompt` (≤ 100 termes) portent
 *     le vocabulaire de la formation côté STT ;
 *   - `word_is_final` par mot alimente le commit verrouillé ;
 *   - trames de 50–1000 ms, jamais plus vite que le réel (sinon fermeture 3007) ;
 *   - toujours envoyer `Terminate` (sinon la session reste facturée jusqu'à 3 h).
 *
 * Garde-fou de langue (anti-boucle, anti-intrus) : ce que le micro capte dans la
 * langue cible est presque toujours notre propre sortie ou quelqu'un d'autre. La
 * détection officielle (`language_code`) n'arrive qu'en fin de tour ; les partiels
 * sont donc filtrés par une heuristique locale (langHint), et un tour suspect est
 * abandonné sans être prononcé. Si la fin de tour le dément, il est réinjecté entier.
 */
import WebSocket from "ws";
import type { Lang } from "../../../../shared/protocol";
import type { SttEvents, SttProvider, SttStream, Word } from "../types";
import { looksLike } from "./langHint";

export interface AssemblyAiOptions {
  apiKey: string;
  model?: string;
  /** Résidence des données : eu (RGPD), us, ou edge (au plus près, non garanti). */
  region?: "eu" | "us" | "edge";
  mode?: "min_latency" | "balanced" | "max_accuracy";
  /** Description de la séance en langage naturel (≤ ~1500 caractères). */
  prompt?: string;
  /** Termes techniques, noms propres, acronymes (≤ 100). */
  keyterms?: string[];
  voiceFocus?: "near-field" | "far-field";
  /**
   * Garde-fou de langue : ignore les tours reconnus dans une autre langue que celle
   * attendue. Quand il est actif, la langue n'est pas épinglée (sinon le français
   * serait transcrit comme de l'anglais approximatif au lieu d'être reconnu).
   */
  languageGate?: boolean;
  /** Langues à écarter (par défaut : toutes celles que le pipeline diffuse). */
  gateLangs?: Lang[];
}

const CLOSE_CODES: Record<number, string> = {
  1008: "clé API invalide ou manquante",
  3005: "session annulée côté serveur",
  3006: "message invalide",
  3007: "trame audio hors 50–1000 ms, ou envoyée plus vite que le temps réel",
  3008: "session expirée (limite de 3 h)",
  3009: "trop de sessions simultanées",
};

const FORMATTED_GRACE_MS = 400;
const LANGUAGE_GATE_CONFIDENCE = 0.6;

export class AssemblyAiStt implements SttProvider {
  readonly name: string;
  private readonly model: string;
  private readonly restBase: string;
  private readonly wsBase: string;

  constructor(private opts: AssemblyAiOptions) {
    if (!opts.apiKey) throw new Error("ASSEMBLYAI_API_KEY manquant");
    this.model = opts.model ?? "universal-3-5-pro";
    const region = opts.region ?? "eu";
    this.restBase = region === "eu" ? "https://api.eu.assemblyai.com" : "https://api.assemblyai.com";
    this.wsBase = region === "edge" ? "wss://streaming.assemblyai.com/v3/ws" : `wss://streaming.${region}.assemblyai.com/v3/ws`;
    this.name = `assemblyai:${this.model}:${opts.mode ?? "balanced"}`;
  }

  async start(opts: { lang: Lang; sampleRate: number }, ev: SttEvents): Promise<SttStream> {
    const gate = this.opts.languageGate ?? true;
    const gateLangs = (this.opts.gateLangs ?? ["fr", "es", "pt", "ar", "en"]).filter((l) => l !== opts.lang);

    const params = new URLSearchParams({
      sample_rate: String(opts.sampleRate),
      encoding: "pcm_s16le",
      speech_model: this.model,
      mode: this.opts.mode ?? "balanced",
    });
    if (gate) params.set("language_detection", "true");
    else params.set("language_code", opts.lang);
    if (this.opts.prompt) params.set("prompt", this.opts.prompt.slice(0, 1500));
    if (this.opts.keyterms?.length) params.set("keyterms_prompt", JSON.stringify(this.opts.keyterms.slice(0, 100)));
    if (this.opts.voiceFocus) params.set("voice_focus", this.opts.voiceFocus);
    // Anciens modèles universal-streaming : le formatage est une option séparée.
    if (!this.model.startsWith("universal-3")) params.set("format_turns", "true");

    const ws = new WebSocket(`${this.wsBase}?${params}`, { headers: { Authorization: this.opts.apiKey } });

    let closed = false;
    let pendingFinal: Word[] | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    /** Tour courant jugé suspect par l'heuristique : ses partiels sont retenus. */
    let suspectTurn: number | null = null;
    let ignoredTurns = 0;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => reject(new Error(`AssemblyAI ${res.statusCode} : ${body.slice(0, 200)}`)));
      });
    });

    const toWords = (m: any): Word[] =>
      (m.words ?? []).map((w: any) => ({ text: String(w.text), startMs: w.start, endMs: w.end, isFinal: w.word_is_final === true }));

    const finalize = (words: Word[]) => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = undefined;
      pendingFinal = undefined;
      if (words.length) ev.onPartial({ words: words.map((w) => ({ ...w, isFinal: true })), isFinal: true });
      ev.onUtteranceEnd();
    };

    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type !== "Turn") {
        if (m.type === "Termination") closed = true;
        else if (m.error) ev.onError(new Error(`AssemblyAI : ${m.error}`));
        return;
      }

      const text: string = m.transcript ?? "";
      if (gate) {
        // Verdict officiel, disponible en fin de tour.
        const detectedOther =
          typeof m.language_code === "string" && m.language_code !== opts.lang && (m.language_confidence ?? 1) >= LANGUAGE_GATE_CONFIDENCE;
        if (m.end_of_turn && detectedOther) {
          ignoredTurns++;
          ev.onDiscard();
          suspectTurn = null;
          return;
        }
        if (!m.end_of_turn) {
          if (suspectTurn === m.turn_order) return; // déjà retenu
          if (gateLangs.some((l) => looksLike(text, l, opts.lang))) {
            suspectTurn = m.turn_order;
            ev.onDiscard(); // ce qui a pu être figé avant le verdict n'est pas prononcé
            return;
          }
        } else if (suspectTurn === m.turn_order) {
          // L'heuristique s'était méfiée, la fin de tour dit « langue attendue » : on
          // réinjecte le tour entier, d'un bloc. Latence perdue, contenu conservé.
          suspectTurn = null;
        }
      }

      const words = toWords(m);
      if (!m.end_of_turn) {
        ev.onPartial({ words, isFinal: false });
        return;
      }
      // U3.5 Pro : fin de tour = finalisé et ponctué. Anciens modèles : la version
      // ponctuée suit ; on lui laisse 400 ms.
      if (m.turn_is_formatted !== false) return finalize(words);
      pendingFinal = words;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => pendingFinal && finalize(pendingFinal), FORMATTED_GRACE_MS);
    });
    ws.on("error", (err) => ev.onError(err));
    ws.on("close", (code, reason) => {
      if (graceTimer) clearTimeout(graceTimer);
      if (!closed) ev.onError(new Error(`AssemblyAI fermé (${code} — ${CLOSE_CODES[code] ?? (reason.toString() || "sans motif")})`));
    });

    return {
      sendAudio: (pcm) => {
        if (ws.readyState === ws.OPEN) ws.send(pcm);
      },
      close: async () => {
        closed = true;
        if (graceTimer) clearTimeout(graceTimer);
        if (ignoredTurns) console.info(`[assemblyai] ${ignoredTurns} tour(s) écarté(s) : autre langue que « ${opts.lang} »`);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "Terminate" }));
        // Laisser partir Terminate avant de fermer le socket.
        await new Promise((r) => setTimeout(r, 200));
        ws.close();
      },
    };
  }

  /** Batch : upload → transcript → polling. 2–5 s pour une question, ce qui convient. */
  async transcribeOnce(audio: Uint8Array, _mime: string, lang: Lang): Promise<string> {
    const H = { Authorization: this.opts.apiKey };
    const up = await fetch(`${this.restBase}/v2/upload`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/octet-stream" },
      body: audio,
      signal: AbortSignal.timeout(20_000),
    });
    if (!up.ok) throw new Error(`AssemblyAI upload ${up.status} : ${(await up.text()).slice(0, 200)}`);
    const { upload_url } = (await up.json()) as { upload_url: string };

    const body: Record<string, unknown> = {
      audio_url: upload_url,
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_code: lang,
    };
    if (this.opts.keyterms?.length) body.keyterms_prompt = this.opts.keyterms.slice(0, 1000);
    const tr = await fetch(`${this.restBase}/v2/transcript`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!tr.ok) throw new Error(`AssemblyAI transcript ${tr.status} : ${(await tr.text()).slice(0, 300)}`);
    const { id } = (await tr.json()) as { id: string };

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const r = await fetch(`${this.restBase}/v2/transcript/${id}`, { headers: H, signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json();
      if (j.status === "completed") return j.text ?? "";
      if (j.status === "error") throw new Error(`AssemblyAI : ${j.error}`);
    }
    throw new Error("AssemblyAI : transcription trop longue");
  }
}
