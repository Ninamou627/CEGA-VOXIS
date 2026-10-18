/**
 * AssemblyAI en streaming — STT primaire. Deux familles de modèles, mesurées le 14/10/2026
 * sur la même fixture, de la fin prononcée d'un segment à son commit (D19) :
 *
 *   - `universal-3-5-pro` (défaut) : ponctué dès les partiels, `mode` et `prompt`. Clôt une
 *     fin de phrase vite (~0,4 s), mais n'envoie qu'~1 partiel/s et ne marque aucun mot
 *     définitif avant la fin du tour : une phrase longue coupée au délai se fige ~2 s après
 *     son dernier mot (p95 ~3 s).
 *   - `universal-streaming-english` : ~3 partiels/s, chaque mot marqué définitif
 *     (`word_is_final`) ~0,5 s après avoir été prononcé : ~0,7 s partout (p95 ~1 s). Texte
 *     sans ponctuation ni majuscules, et des partiels qui montrent des fragments de mots
 *     (« part », « trans ») : le commit n'attend donc que ses mots définitifs (`finalWords`).
 *     Refuse `mode` et `prompt` (fermeture 3006) ; accepte `keyterms_prompt` et
 *     `min_end_of_turn_silence_when_confident`. `universal-streaming-multilingual` : ~0,25 s
 *     de plus par mot, mais il reconnaît le français, donc garde la détection de langue.
 *
 * Communs : `word_is_final` par mot alimente le commit verrouillé ; trames de 50–1000 ms,
 * jamais plus vite que le réel (sinon fermeture 3007) — 50 ms n'a rien gagné sur 100 ms ;
 * toujours envoyer `Terminate` (sinon la session reste facturée jusqu'à 3 h).
 *
 * Pas de `format_turns` : la version mise en forme arrive après la fin de tour (latence) et
 * peut changer le nombre de mots (« twenty five » → « 25 »), ce qui décalerait le commit
 * verrouillé, qui repère les mots par leur position dans le tour.
 *
 * Garde-fou de langue (anti-boucle, anti-intrus) : ce que le micro capte dans la
 * langue cible est presque toujours notre propre sortie ou quelqu'un d'autre. La
 * détection officielle (`language_code`) n'arrive qu'en fin de tour ; les partiels
 * sont donc filtrés par une heuristique locale (langHint), et un tour suspect est
 * abandonné sans être prononcé. Si la fin de tour le dément, il est réinjecté entier.
 * Le modèle anglais seul n'a pas de détection officielle et transcrit le français en
 * anglais approximatif : l'heuristique ne le reconnaît qu'après quelques mots (mesuré :
 * au 7e). Avec lui, le casque fermé du formateur est la vraie protection (D11, D19).
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
  /**
   * Réglages de l'administration, relus à chaque ouverture de flux : ils remplacent
   * `mode`, `keyterms` et `prompt` au prochain démarrage du micro.
   */
  live?: () => { mode: NonNullable<AssemblyAiOptions["mode"]>; keyterms: string[]; prompt?: string };
}

const CLOSE_CODES: Record<number, string> = {
  1008: "clé API invalide ou manquante",
  3005: "session annulée côté serveur",
  3006: "message ou paramètre invalide (un réglage non accepté par ce modèle ?)",
  3007: "trame audio hors 50–1000 ms, ou envoyée plus vite que le temps réel",
  3008: "session expirée (limite de 3 h)",
  3009: "trop de sessions simultanées",
};

const LANGUAGE_GATE_CONFIDENCE = 0.6;

/**
 * Modèles universal-streaming : silence exigé (ms) une fois le modèle confiant que le tour
 * est fini — la « fin de phrase » de l'administration. Rapide : 160 ms, mesuré (fin de tour
 * ~0,6 s après le dernier mot contre ~0,75 s par défaut, sans tour coupé en plus).
 * Équilibrée : le réglage d'AssemblyAI. Précise : attendre davantage avant de clore.
 */
const END_OF_TURN_SILENCE_MS: Record<NonNullable<AssemblyAiOptions["mode"]>, number | undefined> = {
  min_latency: 160,
  balanced: undefined,
  max_accuracy: 800,
};

/**
 * Paramètres d'ouverture du flux. Un paramètre que le modèle refuse ferme la session
 * (3006) au démarrage du micro : chaque famille ne reçoit que ce qu'elle accepte
 * (vérifié le 14/10/2026 sur universal-streaming : `mode` et `prompt` refusés).
 */
export function streamParams(o: {
  model: string;
  sampleRate: number;
  lang: Lang;
  gate: boolean;
  mode: NonNullable<AssemblyAiOptions["mode"]>;
  keyterms: string[];
  prompt?: string;
  voiceFocus?: AssemblyAiOptions["voiceFocus"];
}): URLSearchParams {
  const params = new URLSearchParams({ sample_rate: String(o.sampleRate), encoding: "pcm_s16le", speech_model: o.model });
  if (o.model.startsWith("universal-3")) {
    params.set("mode", o.mode);
    if (o.prompt) params.set("prompt", o.prompt.slice(0, 1500));
    // Non vérifié sur universal-streaming : on ne risque pas une fermeture 3006 en séance.
    if (o.voiceFocus) params.set("voice_focus", o.voiceFocus);
  } else {
    const silence = END_OF_TURN_SILENCE_MS[o.mode];
    if (silence != null) params.set("min_end_of_turn_silence_when_confident", String(silence));
  }
  // Le modèle anglais seul n'a ni détection de langue, ni épinglage.
  if (!o.model.includes("english")) {
    if (o.gate) params.set("language_detection", "true");
    else params.set("language_code", o.lang);
  }
  if (o.keyterms.length) params.set("keyterms_prompt", JSON.stringify(o.keyterms.slice(0, 100)));
  return params;
}

export class AssemblyAiStt implements SttProvider {
  private readonly model: string;
  private readonly restBase: string;
  private readonly wsBase: string;
  /** U3.x : `mode`, `prompt`, ponctuation dès les partiels, ~1 partiel/s. */
  private readonly universal3: boolean;

  constructor(private opts: AssemblyAiOptions) {
    if (!opts.apiKey) throw new Error("ASSEMBLYAI_API_KEY manquant");
    this.model = opts.model ?? "universal-3-5-pro";
    this.universal3 = this.model.startsWith("universal-3");
    const region = opts.region ?? "eu";
    this.restBase = region === "eu" ? "https://api.eu.assemblyai.com" : "https://api.assemblyai.com";
    this.wsBase = region === "edge" ? "wss://streaming.assemblyai.com/v3/ws" : `wss://streaming.${region}.assemblyai.com/v3/ws`;
  }

  get name(): string {
    return this.universal3 ? `assemblyai:${this.model}:${this.tuning().mode}` : `assemblyai:${this.model}`;
  }

  /** universal-streaming marque ses mots définitifs en cours de tour ; U3.5 Pro, seulement en fin de tour. */
  get finalWords(): boolean {
    return !this.universal3;
  }

  private tuning() {
    return this.opts.live?.() ?? { mode: this.opts.mode ?? "balanced", keyterms: this.opts.keyterms ?? [], prompt: this.opts.prompt };
  }

  async start(opts: { lang: Lang; sampleRate: number }, ev: SttEvents): Promise<SttStream> {
    const gate = this.opts.languageGate ?? true;
    const gateLangs = (this.opts.gateLangs ?? ["fr", "es", "pt", "ar", "en"]).filter((l) => l !== opts.lang);

    const params = streamParams({ model: this.model, ...opts, gate, voiceFocus: this.opts.voiceFocus, ...this.tuning() });
    const ws = new WebSocket(`${this.wsBase}?${params}`, { headers: { Authorization: this.opts.apiKey } });

    let closed = false;
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
      (m.words ?? []).map((w: any) => ({
        text: String(w.text),
        startMs: w.start,
        endMs: w.end,
        isFinal: w.word_is_final === true,
        confidence: typeof w.confidence === "number" ? w.confidence : undefined,
      }));

    const finalize = (words: Word[]) => {
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
      // Fin de tour : le texte est définitif (U3.5 Pro le ponctue ; universal-streaming,
      // sans format_turns, le laisse brut — on n'attend pas de seconde version).
      finalize(words);
    });
    ws.on("error", (err) => ev.onError(err));
    ws.on("close", (code, reason) => {
      if (!closed) ev.onError(new Error(`AssemblyAI fermé (${code} — ${CLOSE_CODES[code] ?? (reason.toString() || "sans motif")})`));
    });

    return {
      sendAudio: (pcm) => {
        if (ws.readyState === ws.OPEN) ws.send(pcm);
      },
      // Mesuré : le tour définitif arrive 0,17 à 0,34 s après la commande (D22).
      forceEndpoint: () => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "ForceEndpoint" }));
      },
      close: async () => {
        closed = true;
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
    const keyterms = this.tuning().keyterms;
    if (keyterms.length) body.keyterms_prompt = keyterms.slice(0, 1000);
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
