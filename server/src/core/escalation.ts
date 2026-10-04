// Escalation: a turn runs on the default model (fast, low effort) unless the person explicitly asks for more thought
// or the model calls think_harder; then that turn runs on the escalation model and effort, and the next one starts on
// the default again. The decisions live here, pure; agent-sdk.ts makes the switch (Query.setModel/applyFlagSettings).
import type { Escalation } from './config.ts';

export type EscalationTrigger = 'explicit ask' | 'think_harder';

/** a statement about someone's own thinking ("I think…", "we really think…") is not a request ("can you think…" is) */
const NOT_A_SUBJECT = String.raw`(?<!\b(?:i|we|they|he|she)\s+(?:really\s+|do\s+|don't\s+)?)`;

/** the explicit cues, on lower-cased text with plain apostrophes */
const CUES: readonly RegExp[] = [
  // "think hard", "think harder about…", "think really carefully": not "I think hard water…" or "think hard drives…"
  new RegExp(
    String.raw`${NOT_A_SUBJECT}\bthink\s+(?:really\s+|very\s+)?(?:hard(?:er)?|carefully)` +
      String.raw`(?=\s*(?:$|[.,!?;:]|about\b|on\b|and\b|before\b|here\b|this\b|for\b|first\b|now\b|please\b))`,
  ),
  new RegExp(String.raw`${NOT_A_SUBJECT}\bthink\s+(?:it|this|that)\s+through\b`),
  new RegExp(String.raw`${NOT_A_SUBJECT}\bthink\s+through\s+(?:it|this|that)\b`),
  // "really think about…", not "I really think…" or "do you really think so?"
  new RegExp(String.raw`(?<!\b(?:i|we|they|he|she|you)\s+)\breally\s+think\b`),
  /\btake\s+your\s+time\b/,
  /\b(?:use|switch\s+to|try)\s+(?:the\s+)?opus\b/,
  /\byour\s+(?:very\s+)?(?:best|strongest|smartest|most\s+capable)\s+model\b/,
  /\bdeep[\s-]dive\b/,
];

/** Did the person explicitly ask for careful thought ("think hard", "take your time", "use opus", …)? */
export function wantsEscalation(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  return CUES.some((re) => re.test(t));
}

/** what to do when escalation is asked for: switch now, or say why not (the think_harder tool's answer) */
export function escalationStep(
  escalation: Escalation | null,
  escalated: boolean,
): { switch: true } | { switch: false; ok: boolean; detail: string } {
  if (!escalation) return { switch: false, ok: false, detail: 'escalation is off here; answer with the current model' };
  if (escalated)
    return {
      switch: false,
      ok: true,
      detail: `already on ${escalation.model} (${escalation.effort} effort) for this turn`,
    };
  return { switch: true };
}

/** the log line for one escalation */
export const escalationLog = (e: Escalation, why: EscalationTrigger) =>
  `assistant: escalated to ${e.model} (${e.effort}): ${why}`;

/** the chip the panel shows */
export const escalationChip = (e: Escalation) => `Thinking harder (${e.model})`;
