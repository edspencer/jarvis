// A scripted stand-in for the model: keyword rules that call the real house tools (through the same ToolRunner, so the
// policy gate, confirmations, view commands and audit all run for real) and stream a short answer. No model, no
// network: for demos without a credential, and for the end-to-end tests. Not clever, on purpose; it handles
//   turn on/off <thing> · set the thermostat to <n> · run <script or scene> · show me / where is <thing> ·
//   is <thing> on / what's the <thing> · remember <fact> · what do you remember
import type { Agent, AgentEvent, ToolRunner, TurnInfo } from './core/types.ts';

export interface ScriptedOptions {
  /** ms between streamed chunks (default 10; 0 in tests) */
  chunkDelayMs?: number;
}

interface FindMatch {
  entity_id: string;
  name: string;
  state: string;
  subject?: string;
  policy?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};
const clean = (s: string) =>
  s
    .replace(/[?.!]+$/, '')
    .replace(/^(the|my|our)\s+/i, '')
    .trim();

export function createScriptedAgent(opts: ScriptedOptions = {}): Agent {
  const delay = opts.chunkDelayMs ?? 10;
  let stop = false;

  return {
    name: 'scripted',

    async run(_prompt: string, turn: TurnInfo, emit: (e: AgentEvent) => void, tools: ToolRunner) {
      stop = false;
      const say = async (text: string) => {
        for (const chunk of text.match(/\S+\s*/g) ?? []) {
          if (stop) return;
          emit({ type: 'text', delta: chunk });
          if (delay) await sleep(delay);
        }
      };
      const find = async (query: string, domain?: string): Promise<FindMatch[]> => {
        const r = await tools.call('ha_find', domain ? { query, domain } : { query });
        return json<{ matches?: FindMatch[] }>(r.text)?.matches ?? [];
      };
      const finish = () => emit(stop ? { type: 'done', interrupted: true } : { type: 'done' });
      const text = turn.text.trim();
      let m: RegExpMatchArray | null;

      try {
        // set the thermostat / heating to N
        if ((m = text.match(/\bset (?:the )?(.*?)\s*(?:to|at)\s+(\d+(?:\.\d+)?)\s*(?:°|degrees?)?\s*[a-z]*\W*$/i))) {
          const what = clean(m[1]) || 'thermostat';
          const target = Number(m[2]);
          const found = await find(what, 'climate');
          if (stop) return finish();
          if (!found.length) {
            await say(`I couldn't find a thermostat called ${what}.`);
            return finish();
          }
          const r = await tools.call('ha_act', {
            entity_ids: [found[0].entity_id],
            service: 'set_temperature',
            data: { temperature: target },
          });
          await say(answer(r.text, `${found[0].name} is set to ${target}.`));
          return finish();
        }

        // turn on / off <thing>, switch <thing> off, …
        if (
          (m = text.match(/\b(?:turn|switch|put)\s+(on|off)\s+(.+)$/i)) ||
          (m = text.match(/\b(?:turn|switch|put)\s+(.+?)\s+(on|off)\W*$/i))
        ) {
          const onOff = /^(on|off)$/i.test(m[1]) ? m[1].toLowerCase() : m[2].toLowerCase();
          const what = clean(/^(on|off)$/i.test(m[1]) ? m[2] : m[1]);
          const service = onOff === 'on' ? 'turn_on' : 'turn_off';
          const found = (await find(what)).filter((x) => /^(light|switch|fan|input_boolean)\./.test(x.entity_id));
          if (stop) return finish();
          if (!found.length) {
            await say(`I couldn't find anything called ${what} to switch ${onOff}.`);
            return finish();
          }
          const domain = found[0].entity_id.split('.')[0];
          const ids = found.filter((x) => x.entity_id.startsWith(domain + '.')).map((x) => x.entity_id);
          const r = await tools.call('ha_act', { entity_ids: ids, service });
          await say(answer(r.text, `${what} ${ids.length > 1 ? 'are' : 'is'} ${onOff}.`));
          return finish();
        }

        // run / start <script or scene>
        if ((m = text.match(/\b(?:run|start|activate)\s+(.+)$/i))) {
          const what = clean(m[1]);
          const found = [...(await find(what, 'script')), ...(await find(what, 'scene'))];
          if (stop) return finish();
          if (!found.length) {
            await say(`I couldn't find a script or scene called ${what}.`);
            return finish();
          }
          const r = await tools.call('ha_act', { entity_ids: [found[0].entity_id], service: 'turn_on' });
          await say(answer(r.text, `${found[0].name} is running.`));
          return finish();
        }

        // show me / where is <thing>
        if ((m = text.match(/\b(?:show me|where(?:'s| is| are)|take me to|fly to)\s+(.+)$/i))) {
          const what = clean(m[1]);
          const hits = json<{ name: string; subject: string | null; room: string | null }[]>(
            (await tools.call('site_search', { query: what })).text,
          );
          const hit = Array.isArray(hits) ? hits.find((h) => h.subject) : undefined;
          if (stop) return finish();
          if (!hit) {
            await say(`I don't know where ${what} is.`);
            return finish();
          }
          const r = await tools.call('view_fly', { subject: hit.subject });
          const where = hit.room ? ` It's in the ${hit.room.toLowerCase()}.` : '';
          await say(
            r.text.startsWith('showing') ? `Here's the ${hit.name.toLowerCase()}.${where}` : `${hit.name}.${where}`,
          );
          return finish();
        }

        // remember <fact>
        if ((m = text.match(/^remember(?: that)?\s+(.+)$/i))) {
          const fact = m[1].replace(/[.!]+$/, '');
          const name = fact.split(/\s+/).slice(0, 5).join('-');
          await tools.call('memory_save', { name, text: fact });
          await say("Got it, I'll remember that.");
          return finish();
        }
        if (/\bwhat do you remember\b/i.test(text)) {
          const r = await tools.call('memory_search', {});
          const notes = json<{ text: string }[]>(r.text);
          await say(Array.isArray(notes) && notes.length ? notes.map((n) => n.text).join('. ') + '.' : 'Nothing yet.');
          return finish();
        }

        // is <thing> on? / what's the <thing>? / status of <thing>
        if (
          (m = text.match(
            /^(?:is|are|what(?:'s| is| are)|status of|how is|how's)\s+(.+?)(?:\s+(?:on|off|at|set to|doing))?\W*$/i,
          ))
        ) {
          const what = clean(m[1]);
          const found = await find(what);
          if (stop) return finish();
          if (!found.length) {
            await say(`I couldn't find ${what}.`);
            return finish();
          }
          const ids = found.slice(0, 5).map((x) => x.entity_id);
          const states = json<{ entity_id: string; state: string; friendly_name?: string; temperature?: number }[]>(
            (await tools.call('ha_state', { entity_ids: ids })).text,
          );
          const parts = (Array.isArray(states) ? states : []).map(
            (s) =>
              `${s.friendly_name ?? s.entity_id} is ${s.state}${typeof s.temperature === 'number' ? `, set to ${s.temperature}` : ''}`,
          );
          await say(parts.length ? parts.join('; ') + '.' : `I couldn't read ${what}.`);
          return finish();
        }

        await say(
          "I'm the scripted assistant, without a model. I can turn things on and off, set the thermostat, run scripts, show you where things are, and tell you what's on.",
        );
        finish();
      } catch (e) {
        emit({ type: 'done', error: (e as Error).message });
      }
    },

    async interrupt() {
      stop = true;
    },
    async reset() {
      stop = true;
    },
    async close() {
      stop = true;
    },
  };
}

/** what to say for ha_act's result */
function answer(result: string, ok: string): string {
  if (result.startsWith('done')) return `Done. ${ok}`;
  if (result.startsWith('refused:')) return `I can't do that: ${result.slice(8).trim()}.`;
  if (result.startsWith('the person declined')) return "OK, I won't.";
  if (result.startsWith('nobody confirmed')) return 'Nobody confirmed, so I left it.';
  return `That didn't work: ${result}.`;
}
