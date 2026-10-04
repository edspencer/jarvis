// Speech to text: forward one recorded utterance to an OpenAI-compatible transcription endpoint (faster-whisper via
// Speaches, whisper.cpp's server, a hosted API) and return its text. Audio never touches the WebSocket and is never
// stored (design §2.2, §7.1). The endpoint is configured by JARVIS_STT_*; unset means transcription is off.
import type { SttConfig } from './config.ts';

export interface TranscribeOptions extends SttConfig {
  /** bytes (default 10 MB: a minute of opus is well under 1 MB) */
  maxBytes?: number;
  /** ms (default 30 s) */
  timeoutMs?: number;
}

/** a failure with the HTTP status the server should answer with */
export class TranscribeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TranscribeError';
    this.status = status;
  }
}

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** the file name the endpoint sees (some servers sniff the format from its extension) */
function fileName(type: string): string {
  const sub = type.split(';')[0].split('/')[1] || 'webm';
  return `utterance.${{ mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav' }[sub] ?? sub}`;
}

export async function transcribe(
  file: Blob,
  opts: TranscribeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string }> {
  const max = opts.maxBytes ?? MAX_AUDIO_BYTES;
  const type = (file.type || '').toLowerCase();
  if (!type.startsWith('audio/')) throw new TranscribeError(415, `expected an audio/* file, got ${type || 'no type'}`);
  if (file.size === 0) throw new TranscribeError(400, 'the audio file is empty');
  if (file.size > max) throw new TranscribeError(413, `the audio file is over ${Math.round(max / 1048576)} MB`);

  const form = new FormData();
  form.append('file', file, fileName(type));
  form.append('model', opts.model || 'whisper-1');
  if (opts.language) form.append('language', opts.language);
  form.append('response_format', 'json');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetchImpl(`${opts.url.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      headers: opts.key ? { authorization: `Bearer ${opts.key}` } : {},
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) throw new TranscribeError(504, 'the transcription server did not answer in time');
    throw new TranscribeError(502, `cannot reach the transcription server: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new TranscribeError(502, `the transcription server said ${res.status}: ${body.slice(0, 200)}`);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new TranscribeError(502, 'the transcription server did not return JSON');
  }
  const text = (json as { text?: unknown })?.text;
  if (typeof text !== 'string') throw new TranscribeError(502, 'the transcription server returned no text');
  return { text: text.trim() };
}
