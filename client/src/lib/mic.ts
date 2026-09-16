/**
 * Capture du micro formateur (page ouverte sur le PC de la salle) et enregistrement
 * des questions (téléphones). Le navigateur fournit l'AGC et la suppression de bruit ;
 * on ne met rien devant le STT.
 */

export interface MicHandle {
  sampleRate: number;
  /** Libellé du périphérique réellement ouvert par le navigateur. */
  label: string;
  deviceId: string;
  setMuted(muted: boolean): void;
  stop(): void;
}

/** Micros disponibles. Les libellés ne sont visibles qu'après une première autorisation. */
export async function listMics(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
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
  await ctx.audioWorklet.addModule("/pcm-worklet.js?v=2");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-worklet");
  // Le worklet doit être relié à la destination pour être traité ; gain 0 = pas de retour.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  await ctx.resume();

  let muted = false;
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const level = rms(e.data);
    if (!muted) onFrame(e.data, level);
    else onFrame(new ArrayBuffer(0), level);
  };

  return {
    sampleRate: ctx.sampleRate,
    label: track?.label || "micro par défaut",
    deviceId: settings.deviceId ?? opts.deviceId ?? "",
    setMuted: (m) => {
      muted = m;
    },
    stop: () => {
      node.port.onmessage = null;
      node.disconnect();
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
  mime = "";

  static supported(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
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
  }

  /** Résout avec le fichier complet, une fois le dernier morceau reçu. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(new Blob([]));
      rec.onstop = () => {
        for (const t of this.stream?.getTracks() ?? []) t.stop();
        resolve(new Blob(this.chunks, { type: this.mime }));
        this.rec = undefined;
      };
      rec.stop();
    });
  }

  cancel(): void {
    this.rec?.stop();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.rec = undefined;
    this.chunks = [];
  }
}
