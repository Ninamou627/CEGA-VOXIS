/**
 * Capture du micro formateur (page ouverte sur le PC de la salle) et enregistrement
 * des questions (téléphones). Le navigateur fournit l'AGC et la suppression de bruit ;
 * on ne met rien devant le STT.
 */
import { CaptureMeter } from "../../../shared/capture";

export interface MicHandle {
  sampleRate: number;
  /** Libellé du périphérique réellement ouvert par le navigateur. */
  label: string;
  deviceId: string;
  setMuted(muted: boolean): void;
  /** Gain appliqué avant l'envoi, en dB (réglage de l'administration). */
  setGainDb(db: number): void;
  stop(): void;
}

/** Micros disponibles. Les libellés ne sont visibles qu'après une première autorisation. */
export async function listMics(): Promise<MediaDeviceInfo[]> {
  return listDevices("audioinput");
}

/** Sorties disponibles : casque du formateur, haut-parleurs de la salle, interface USB. */
export async function listOutputs(): Promise<MediaDeviceInfo[]> {
  return listDevices("audiooutput");
}

async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === kind);
}

function rms(pcm: ArrayBuffer): number {
  const a = new Int16Array(pcm);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.min(1, Math.sqrt(s / a.length) / 6000);
}

export interface MicOptions {
  deviceId?: string;
  /**
   * Annulation d'écho du navigateur. Indispensable quand la traduction sort des
   * haut-parleurs du même PC (test sur une seule machine) : sinon le micro la capte
   * et le système se retraduit en boucle. En salle (casque fermé, écouteurs), sans effet.
   */
  echoCancellation?: boolean;
  /**
   * Toutes les 5 s de son : part du temps réel que le navigateur a vraiment livrée (1 = rien
   * de perdu). Calculée à l'arrivée des trames, pas sur une minuterie (D34).
   */
  onCapture?: (ratio: number) => void;
}

export async function startMic(onFrame: (pcm: ArrayBuffer, level: number) => void, opts: MicOptions = {}): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: opts.echoCancellation ?? true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};
  const ctx = new AudioContext({ sampleRate: 16000 });
  // Le paramètre de version évite qu'un navigateur garde en cache une ancienne version du worklet.
  await ctx.audioWorklet.addModule("/pcm-worklet.js?v=3");
  const source = ctx.createMediaStreamSource(stream);
  // Gain après le contrôle automatique du navigateur : ce que le serveur reçoit, et ce que mesure le vumètre.
  const gain = ctx.createGain();
  const node = new AudioWorkletNode(ctx, "pcm-worklet");
  // Le worklet doit être relié à la destination pour être traité ; gain 0 = pas de retour.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(gain);
  gain.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  await ctx.resume();

  let muted = false;
  // La sourdine n'arrête pas le worklet : la captation se mesure aussi pendant qu'elle est mise.
  const meter = new CaptureMeter();
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const ratio = meter.frame(performance.now(), (e.data.byteLength / 2 / ctx.sampleRate) * 1000);
    if (ratio != null) opts.onCapture?.(ratio);
    const level = rms(e.data);
    if (!muted) onFrame(e.data, level);
    else onFrame(new ArrayBuffer(0), level);
  };

  return {
    sampleRate: ctx.sampleRate,
    label: track?.label || "micro par défaut",
    deviceId: settings.deviceId ?? opts.deviceId ?? "",
    setGainDb: (db) => {
      gain.gain.value = Math.pow(10, db / 20);
    },
    setMuted: (m) => {
      muted = m;
    },
    stop: () => {
      node.port.onmessage = null;
      node.disconnect();
      gain.disconnect();
      source.disconnect();
      sink.disconnect();
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

export class QuestionRecorder {
  private rec?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private samples?: Uint8Array<ArrayBuffer>;
  mime = "";

  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  get state(): RecordingState {
    return this.rec?.state ?? "inactive";
  }

  async start(): Promise<void> {
    // Le contexte audio du vumètre se crée avant le premier await : sur iOS il doit
    // naître dans le geste de l'utilisateur. Facultatif — sans lui, l'anneau reste plat.
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      void this.ctx.resume();
    } catch {
      this.ctx = undefined;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mime = this.rec.mimeType || mime || "audio/webm";
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
    if (this.ctx) {
      try {
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
        this.samples = new Uint8Array(this.analyser.fftSize);
      } catch {
        this.analyser = undefined;
      }
    }
  }

  /** Niveau instantané du micro, 0 à 1 (RMS). 0 en pause ou sans vumètre. */
  level(): number {
    const a = this.analyser;
    const b = this.samples;
    if (!a || !b || this.rec?.state !== "recording") return 0;
    a.getByteTimeDomainData(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) {
      const v = (b[i] - 128) / 128;
      s += v * v;
    }
    return Math.min(1, Math.sqrt(s / b.length) * 4);
  }

  /** Suspend l'enregistrement sans le clore : la question reprend là où elle en était. */
  pause(): void {
    if (this.rec?.state === "recording") this.rec.pause();
  }

  resume(): void {
    if (this.rec?.state === "paused") this.rec.resume();
  }

  /** Résout avec le fichier complet, une fois le dernier morceau reçu. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(new Blob([]));
      rec.onstop = () => {
        this.release();
        resolve(new Blob(this.chunks, { type: this.mime }));
        this.rec = undefined;
      };
      rec.stop();
    });
  }

  cancel(): void {
    this.rec?.stop();
    this.release();
    this.rec = undefined;
    this.chunks = [];
  }

  private release() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.analyser = undefined;
  }
}
