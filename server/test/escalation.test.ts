// Escalation's decisions: the explicit cues a person may use, and what think_harder answers.
import { describe, expect, it } from 'vitest';
import { escalationChip, escalationLog, escalationStep, wantsEscalation } from '../src/core/escalation.ts';

const OPUS = { model: 'claude-opus-5-5', effort: 'high' } as const;

describe('wantsEscalation', () => {
  it('matches the explicit cues', () => {
    for (const t of [
      'Think hard: how long will the pool take to heat up?',
      'think harder about that',
      'Please think carefully before answering',
      'think really hard, why does the upstairs AC lock out?',
      'Take your time and work out the irrigation schedule',
      'can you think it through for me',
      "Let's think this through",
      'think through it step by step',
      'use Opus for this one',
      'switch to opus',
      'use your best model',
      'Give it your strongest model',
      'do a deep dive on the water heater options',
      'a deep-dive on the roof quotes please',
      'really think about whether the tank is big enough',
      'THINK HARD',
      'Could you think hard about it?',
      'Don’t rush, take your time.',
    ])
      expect(wantsEscalation(t), t).toBe(true);
  });

  it('does not match ordinary sentences that share the words', () => {
    for (const t of [
      'I think the hall light is on',
      'I think hard water is wrecking the heater',
      'do you think hard water damages the tankless?',
      'we think carefully chosen plants use less water',
      'I really think it will rain tomorrow',
      'Do you really think so?',
      'what is the best model of dehumidifier?',
      'is the pool deep enough to dive?',
      'how much time is left on the sprinkler?',
      'think of a name for the garden lights',
      'turn off the kitchen pendants',
      'the opus of the Lakewood Ranch orchestra',
      'what do you think?',
      '',
    ])
      expect(wantsEscalation(t), t).toBe(false);
  });
});

describe('escalationStep', () => {
  it('switches once per turn; off says so', () => {
    expect(escalationStep(OPUS, false)).toEqual({ switch: true });
    expect(escalationStep(OPUS, true)).toEqual({
      switch: false,
      ok: true,
      detail: 'already on claude-opus-5-5 (high effort) for this turn',
    });
    expect(escalationStep(null, false)).toEqual({
      switch: false,
      ok: false,
      detail: 'escalation is off here; answer with the current model',
    });
  });

  it('the log line and the chip', () => {
    expect(escalationLog(OPUS, 'explicit ask')).toBe('assistant: escalated to claude-opus-5-5 (high): explicit ask');
    expect(escalationLog(OPUS, 'think_harder')).toBe('assistant: escalated to claude-opus-5-5 (high): think_harder');
    expect(escalationChip(OPUS)).toBe('Thinking harder (claude-opus-5-5)');
  });
});
