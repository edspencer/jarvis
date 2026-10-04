// Talking: record one utterance with the microphone (MediaRecorder; echo cancellation on, so open speakers don't feed
// the assistant its own voice), then POST it to the server's /transcribe with the socket's ticket and get { text }
// back. The whole utterance is recorded and sent at once (commands are a few seconds; no streaming STT). A level
// meter (Web Audio) drives the panel's bar and, for click-to-talk, stops after a second of quiet.
import type { TranscribeReply } from '../../../server/src/core/protocol.ts';

/** the recording formats tried, in order: Opus in WebM (Chrome, Firefox), Opus in Ogg, then MP4/AAC (Safari) */
export const MIME_PREFS = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;

/** the first format the browser records ('' lets it choose) */
export function pickMime(supported: (t: string) => boolean): string {
  return MIME_PREFS.find((t) => supported(t)) || '';
}

/** a file name the transcription server can tell the format from */
export function fileName(mime: string): string {
  return mime.includes('webm')
    ? 'speech.webm'
    : mime.includes('ogg')
      ? 'speech.ogg'
      : mime.includes('mp4')
        ? 'speech.m4a'
        : 'speech.bin';
}

/** why the microphone can't be used here, or null */
export function micUnavailable(): string | null {
  if (!isSecureContext) return 'The microphone needs a secure page (https)';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser has no microphone access';
  if (typeof MediaRecorder === 'undefined') return "This browser can't record audio";
  return null;
}

/** a message for getUserMedia's error */
export function micError(err: unknown): string {
  const n = (err as DOMException)?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone permission was denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone found';
  if (n === 'NotReadableError') return 'The microphone is in use by another program';
  return `Couldn't start the microphone (${(err as Error)?.message || n || err})`;
}

export interface Recording {
  /** 0-1, the current input level (for the meter) */
  level(): number;
  /** stop and return the audio (null if cancelled or too short) */
  stop(): Promise<{ blob: Blob; mime: string; ms: number } | null>;
  cancel(): void;
}

/** recordings shorter than this are a slip of the key, not speech */
export const MIN_MS = 350;
/** the longest utterance (then it stops by itself) */
export const MAX_MS = 30_000;

/** start recording; throws (with micError's message) if the microphone can't be had */
export async function record(opts: { onSilence?(): void; onMax?(): void } = {}): Promise<Recording> {
  const why = micUnavailable();
  if (why) throw new Error(why);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw new Error(micError(err), { cause: err });
  }
  const mime = pickMime((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  const t0 = performance.now();

  // the level meter: RMS of the waveform, smoothed; silence after speech ends click-to-talk
  let ac: AudioContext | null = null;
  let an: AnalyserNode | null = null;
  try {
    ac = new AudioContext();
    an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
  } catch {
    ac = null;
  }
  const buf = new Float32Array(512);
  let lvl = 0;
  let heard = false;
  let quietSince = 0;
  const tick = setInterval(() => {
    if (an) {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      lvl = lvl * 0.6 + Math.min(1, Math.sqrt(sum / buf.length) * 6) * 0.4;
      const now = performance.now();
      if (lvl > 0.12) {
        heard = true;
        quietSince = 0;
      } else if (heard) {
        quietSince ||= now;
        if (now - quietSince > 1100) opts.onSilence?.();
      }
    }
    if (performance.now() - t0 > MAX_MS) opts.onMax?.();
  }, 60);

  let done = false;
  const release = () => {
    clearInterval(tick);
    for (const t of stream.getTracks()) t.stop();
    void ac?.close().catch(() => {});
  };
  return {
    level: () => lvl,
    cancel() {
      if (done) return;
      done = true;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
    stop() {
      if (done) return Promise.resolve(null);
      done = true;
      const ms = performance.now() - t0;
      return new Promise((resolve) => {
        rec.onstop = () => {
          release();
          const type = rec.mimeType || mime || 'audio/webm';
          resolve(ms < MIN_MS || !chunks.length ? null : { blob: new Blob(chunks, { type }), mime: type, ms });
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      });
    },
  };
}

/** start a recording, and let go of the microphone (its tracks stop) as soon as it arrives if it is no longer
 * `wanted` then: the plugin was disposed or the talk cancelled while getUserMedia waited. null then. */
export async function recordIfWanted(
  start: () => Promise<Recording>,
  wanted: () => boolean,
): Promise<Recording | null> {
  const r = await start();
  if (wanted()) return r;
  r.cancel();
  return null;
}

/** POST the audio to <server>/transcribe (multipart `file`, the connection's ticket as the bearer) and return the
 * text */
export async function transcribe(
  url: string,
  blob: Blob,
  mime: string,
  ticket: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('file', blob, fileName(mime));
  const r = await fetch(url, {
    method: 'POST',
    body: form,
    signal,
    credentials: 'same-origin',
    headers: ticket ? { authorization: `Bearer ${ticket}` } : {},
  });
  if (!r.ok) {
    let why = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string; message?: string };
      why = j.error || j.message || why;
    } catch {}
    throw new Error(why);
  }
  const j = (await r.json()) as TranscribeReply;
  return (j.text || '').trim();
}
