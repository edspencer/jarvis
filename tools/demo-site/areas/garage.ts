// The garage wing: the garage (garage) and the laundry / mudroom (laundry): docs/demo-house.md#garage-garage
import { WING } from '../dims.ts';
import { PANEL } from '../panel.ts';
import type { Area } from '../area.ts';

export const garage: Area = {
  id: 'garage',
  pins: [
    {
      id: 'elec.panel',
      name: 'Main panel',
      category: 'elec',
      room: 'garage',
      // on the east wall, back to back with the utility meter outside
      at: [WING.x1 - 0.02, 5.0, 1.5],
      make: 'Example Electric',
      model: 'LP-40',
      specs: [
        ['main', `${PANEL.main_amps} A`],
        ['spaces', String(PANEL.spaces)],
      ],
    },
    {
      id: 'plumb.water-heater',
      name: 'Water heater',
      category: 'plumb',
      room: 'garage',
      at: [12.7, 6.0, 1.0],
      make: 'Example Water',
      model: 'WH-50',
      specs: [['capacity', '50 gal']],
      breaker: '10+12',
    },
    {
      id: 'plumb.stopcock',
      name: 'Main shut-off valve',
      category: 'plumb',
      room: 'garage',
      at: [WING.x0 + 0.05, 5.3, 0.3],
    },
  ],
};
