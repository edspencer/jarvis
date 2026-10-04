// The transcription proxy against a fake fetch: the multipart it sends, and its errors.
import { describe, expect, it } from 'vitest';
import { TranscribeError, transcribe } from '../src/core/transcribe.ts';

const audio = (bytes = 100, type = 'audio/webm;codecs=opus') => new Blob([new Uint8Array(bytes)], { type });

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  return { f, calls };
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TranscribeError);
    return (e as TranscribeError).status;
  }
  return 0;
};

describe('transcribe', () => {
  it('posts the file, model and language with the bearer key, and returns the text', async () => {
    const { f, calls } = fakeFetch(() => Response.json({ text: ' Turn off the kitchen lights. ' }));
    const r = await transcribe(audio(), { url: 'http://stt:8000/v1/', model: 'small', key: 'k', language: 'en' }, f);
    expect(r).toEqual({ text: 'Turn off the kitchen lights.' });
    expect(calls[0].url).toBe('http://stt:8000/v1/audio/transcriptions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('small');
    expect(form.get('language')).toBe('en');
    const file = form.get('file') as File;
    expect(file.size).toBe(100);
    expect(file.name).toBe('utterance.webm');
  });

  it('sends no key when none is set, and a default model', async () => {
    const { f, calls } = fakeFetch(() => Response.json({ text: 'hi' }));
    await transcribe(audio(10, 'audio/mp4'), { url: 'http://stt/v1' }, f);
    expect(calls[0].init.headers).toEqual({});
    expect((calls[0].init.body as FormData).get('model')).toBe('whisper-1');
    expect(((calls[0].init.body as FormData).get('file') as File).name).toBe('utterance.mp4');
  });

  it('refuses what is not audio, empty or too big', async () => {
    const { f, calls } = fakeFetch(() => Response.json({ text: 'x' }));
    expect(await status(transcribe(audio(10, 'text/plain'), { url: 'http://stt' }, f))).toBe(415);
    expect(await status(transcribe(audio(0), { url: 'http://stt' }, f))).toBe(400);
    expect(await status(transcribe(audio(2000), { url: 'http://stt', maxBytes: 1000 }, f))).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('upstream errors, garbage and silence are 502s; a hang is a 504', async () => {
    const url = { url: 'http://stt' };
    expect(await status(transcribe(audio(), url, fakeFetch(() => new Response('boom', { status: 500 })).f))).toBe(502);
    expect(await status(transcribe(audio(), url, fakeFetch(() => new Response('<html>')).f))).toBe(502);
    expect(await status(transcribe(audio(), url, fakeFetch(() => Response.json({ nope: 1 })).f))).toBe(502);
    const refused = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await status(transcribe(audio(), url, refused))).toBe(502);
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as never;
    expect(await status(transcribe(audio(), { ...url, timeoutMs: 20 }, hang))).toBe(504);
  });
});
