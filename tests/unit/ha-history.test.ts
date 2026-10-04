import { describe, expect, it } from 'vitest';
import { historyMessage, parseHistory } from '../../src/plugins/home-assistant/history';

describe("Home Assistant's recorder history", () => {
  it('asks for one entity over a period, minimal and without attributes', () => {
    const m = historyMessage('sensor.kwh', Date.parse('2026-10-03T00:00:00Z'), Date.parse('2026-10-03T12:00:00Z'));
    expect(m).toEqual({
      type: 'history/history_during_period',
      start_time: '2026-10-03T00:00:00.000Z',
      end_time: '2026-10-03T12:00:00.000Z',
      entity_ids: ['sensor.kwh'],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
  });

  it('reads the compressed answer into points, oldest first; non-numbers are gaps', () => {
    const resp = {
      'sensor.kwh': [
        { s: '2.5', lu: 1759500000.5 },
        { s: 'unavailable', lu: 1759496400 },
        { s: '1.25', lc: 1759492800 },
        { lu: 1759490000 }, // no state: skipped
      ],
    };
    expect(parseHistory(resp, 'sensor.kwh')).toEqual([
      { t: 1759492800000, state: '1.25', v: 1.25 },
      { t: 1759496400000, state: 'unavailable', v: null },
      { t: 1759500000500, state: '2.5', v: 2.5 },
    ]);
    expect(parseHistory({}, 'sensor.kwh')).toEqual([]);
    expect(parseHistory(null, 'sensor.kwh')).toEqual([]);
  });
});
