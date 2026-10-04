// Speaking replies (v1: the browser's speechSynthesis), a sentence at a time as the text streams in, so the first
// sentence is heard while the rest is still arriving. The splitter and the Markdown stripper are pure (unit-tested);
// the speaker is a thin wrapper that knows whether it is still talking (the panel's "speaking" state) and stops at
// once for barge-in.

/** abbreviations whose full stop doesn't end a sentence */
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|St|No|Fig)\.$/i;

/**
 * Split off the complete sentences at the front of `buf`: a sentence ends at . ! ? (or …) followed by white space, or
 * at a line break. A full stop inside a number (72.5), an abbreviation (e.g.) or a single initial doesn't end one.
 * Returns the sentences (trimmed, non-empty) and what's left to wait for.
 */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    let end = -1;
    if (c === '\n') end = i;
    else if ('.!?…'.includes(c)) {
      // the run of closing marks and quotes after it: 'Done!"', '...'
      let j = i;
      while (j + 1 < buf.length && '.!?…"\')]’”'.includes(buf[j + 1])) j++;
      if (j + 1 >= buf.length) break; // the end of the buffer: wait, the next delta may continue it
      if (!/\s/.test(buf[j + 1])) {
        i = j;
        continue;
      }
      // a lower-case word next continues the sentence ('He said "stop!" and left')
      const next = /\S/.exec(buf.slice(j + 1));
      if (next && /[a-z]/.test(next[0])) {
        i = j;
        continue;
      }
      const head = buf.slice(start, i + 1);
      if (c === '.' && (ABBREV.test(head) || /(?:^|\s)[A-Z]\.$/.test(head))) {
        i = j;
        continue;
      }
      end = j;
      i = j;
    }
    if (end < 0) continue;
    const s = buf.slice(start, end + 1).trim();
    if (s) sentences.push(s);
    start = end + 1;
  }
  return { sentences, rest: buf.slice(start) };
}

/** Markdown to plain words for speaking: no code, emphasis marks, headings, bullets, tables or link targets. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/°\s?F\b/g, ' degrees')
    .replace(/°\s?C\b/g, ' degrees Celsius')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Speaker {
  /** stream text in; complete sentences are spoken as they arrive */
  feed(turnId: string, delta: string): void;
  /** the turn is over: speak what's left */
  flush(turnId: string): void;
  /** stop at once and forget the queue (barge-in, toggled off) */
  stop(): void;
  readonly speaking: boolean;
  enabled: boolean;
}

/** a speaker over speechSynthesis; `say` is replaced in mock mode (records instead of speaking) */
export function createSpeaker(opts: {
  onChange(): void;
  say?: (text: string, done: () => void) => () => void;
}): Speaker {
  let buf = '';
  let turn = '';
  let queued = 0;
  const cancels = new Set<() => void>();
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  const say =
    opts.say ||
    ((text: string, done: () => void) => {
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
        done();
        return () => {};
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = document.documentElement.lang || navigator.language || 'en';
      u.onend = u.onerror = () => done();
      synth.speak(u);
      return () => synth.cancel();
    });
  const speak = (s: string) => {
    const t = speakable(s);
    if (!t || !sp.enabled) return;
    queued++;
    let finished = false;
    let cancel = () => {};
    const done = () => {
      if (finished) return;
      finished = true;
      cancels.delete(cancel);
      queued = Math.max(0, queued - 1);
      opts.onChange();
    };
    cancel = say(t, done);
    if (!finished) cancels.add(cancel);
    opts.onChange();
  };
  const sp: Speaker = {
    enabled: true,
    get speaking() {
      return queued > 0;
    },
    feed(turnId, delta) {
      if (!sp.enabled) return;
      if (turnId !== turn) {
        turn = turnId;
        buf = '';
      }
      const { sentences, rest } = takeSentences(buf + delta);
      buf = rest;
      sentences.forEach(speak);
    },
    flush(turnId) {
      if (turnId === turn && buf.trim()) speak(buf);
      buf = '';
    },
    stop() {
      buf = '';
      const was = queued > 0;
      queued = 0;
      const cs = [...cancels];
      cancels.clear();
      for (const c of cs) c();
      synth?.cancel();
      if (was) opts.onChange();
    },
  };
  return sp;
}
