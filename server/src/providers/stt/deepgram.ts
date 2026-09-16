/**
 * Deepgram Nova-3 — STT de secours, et STT batch des questions (multilingue, FR inclus).
 *
 * Particularité : Deepgram finalise PAR TRANCHES. Un message `is_final` couvre une
 * fenêtre de quelques secondes, et l'intérim suivant repart de zéro. Le pipeline
 * attend l'hypothèse COMPLÈTE de l'énoncé courant : on concatène donc les tranches
 * finales et on y ajoute l'intérim en cours, jusqu'à `speech_final` / `UtteranceEnd`.
 */
import WebSocket from "ws";
import type { Lang } from "../../../../shared/protocol";
import type { SttEvents, SttProvider, SttStream, Word } from "../types";

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
}

export class DeepgramStt implements SttProvider {
  readonly name = "deepgram:nova-3";

  constructor(private opts: { apiKey: string }) {
    if (!opts.apiKey) throw new Error("DEEPGRAM_API_KEY manquant");
  }

  async start(opts: { lang: Lang; sampleRate: number }, ev: SttEvents): Promise<SttStream> {
    const params = new URLSearchParams({
      model: "nova-3",
      language: opts.lang,
      encoding: "linear16",
      sample_rate: String(opts.sampleRate),
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
    });

    let finals: Word[] = [];
    let closed = false;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`Deepgram ${res.statusCode}`)));
    });

    const keepAlive = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);

    const toWords = (ws: DgWord[] | undefined): Word[] =>
      (ws ?? []).map((w) => ({ text: w.punctuated_word ?? w.word, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) }));

    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.type === "Results") {
        const alt = m.channel?.alternatives?.[0];
        if (!alt) return;
        const words = toWords(alt.words);
        if (m.is_final) {
          finals = finals.concat(words);
          if (m.speech_final) {
            if (finals.length) ev.onPartial({ words: finals, isFinal: true });
            ev.onUtteranceEnd();
            finals = [];
          } else if (finals.length) {
            ev.onPartial({ words: finals, isFinal: false });
          }
        } else if (finals.length || words.length) {
          ev.onPartial({ words: finals.concat(words), isFinal: false });
        }
      } else if (m.type === "UtteranceEnd") {
        if (finals.length) {
          ev.onPartial({ words: finals, isFinal: true });
          finals = [];
        }
        ev.onUtteranceEnd();
      } else if (m.type === "Error") {
        ev.onError(new Error(`Deepgram : ${m.description ?? m.message ?? "erreur"}`));
      }
    });
    ws.on("error", (err) => ev.onError(err));
    ws.on("close", (code, reason) => {
      clearInterval(keepAlive);
      if (!closed) ev.onError(new Error(`Deepgram fermé (${code} ${reason.toString()})`));
    });

    return {
      sendAudio: (pcm) => {
        if (ws.readyState === ws.OPEN) ws.send(pcm);
      },
      close: async () => {
        closed = true;
        clearInterval(keepAlive);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
        ws.close();
      },
    };
  }

  async transcribeOnce(audio: Uint8Array, mime: string, lang: Lang): Promise<string> {
    const params = new URLSearchParams({ model: "nova-3", language: lang, smart_format: "true" });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.opts.apiKey}`, "Content-Type": mime },
      body: audio,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Deepgram ${res.status} : ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    return j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
}
