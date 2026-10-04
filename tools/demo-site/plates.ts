import type { V3 } from './geometry.ts';
import { INT, UP } from './dims.ts';
import { FIXTURES } from './fixtures.ts';

// ------------------------------------------------------------------ wall plates (docs/model-format.md §8)
export interface PlateSpec {
  id: string;
  room: string;
  kind: 'switch' | 'outlet';
  /** the plate's centre on the wall face, and the face's outward normal (plan) */
  at: V3;
  normal: [number, number];
  positions: Record<string, unknown>[];
  notes?: string;
}
export const PLATES: PlateSpec[] = [
  {
    id: 'LV-S-A',
    room: 'living_room',
    kind: 'switch',
    at: [7 - INT / 2, 2.45, 1.2],
    normal: [-1, 0],
    positions: [
      {
        pos: 1,
        role: 'living room cans',
        breaker: '7',
        fixture_ids: FIXTURES.filter((f) => f.group === 'fixture.cans.living').map((f) => f.id),
        ha_entity: 'light.living_room_cans',
      },
      {
        pos: 2,
        role: 'hall pendant (three-way with HL-S-A)',
        breaker: '7',
        fixture_ids: ['hall.pendant'],
        link: { box: 'HL-S-A', pos: 2, dir: 'with' },
      },
    ],
    notes: 'Two-gang; position 2 is three-way with HL-S-A by the front door.',
  },
  {
    id: 'HL-S-A',
    room: 'hall',
    kind: 'switch',
    at: [10.35, 0, 1.2],
    normal: [0, 1],
    positions: [
      { pos: 1, role: 'porch lantern', breaker: '9', fixture_ids: ['porch.lantern'], ha_entity: 'light.porch' },
      {
        pos: 2,
        role: 'hall pendant (three-way with LV-S-A)',
        breaker: '7',
        fixture_ids: ['hall.pendant'],
        ha_entity: 'light.hall',
        link: { box: 'LV-S-A', pos: 2, dir: 'with' },
      },
    ],
  },
  {
    id: 'KT-S-A',
    room: 'kitchen',
    kind: 'switch',
    at: [4.6, 5 + INT / 2, 1.2],
    normal: [0, 1],
    positions: [
      {
        pos: 1,
        role: 'kitchen pendants',
        breaker: '11',
        fixture_ids: FIXTURES.filter((f) => f.group === 'fixture.pendants.kitchen').map((f) => f.id),
      },
    ],
  },
  {
    id: 'LV-O-A',
    room: 'living_room',
    kind: 'outlet',
    at: [0, 4.2, 0.35],
    normal: [1, 0],
    positions: [{ pos: 1, role: 'floor lamp (switched half)', breaker: '5', fixture_ids: ['living.floor_lamp'] }],
  },
  {
    id: 'BA-S-A',
    room: 'landing',
    kind: 'switch',
    at: [8.75, 3 + INT / 2, UP + 1.2],
    normal: [0, 1],
    positions: [
      {
        pos: 1,
        role: 'vanity light',
        breaker: '14',
        fixture_ids: ['bathroom.vanity'],
        ha_entity: 'switch.bathroom_vanity',
      },
    ],
  },
];
