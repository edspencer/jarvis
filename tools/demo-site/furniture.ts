import { Model } from './model.ts';
import { AREAS } from './areas/index.ts';
import { lightFixtures } from './main-model.ts';

// ------------------------------------------------------------------ furniture (an extra model, layer: furniture)
/** each area's furniture, then the light fixtures that live in this model (lamps) */
export function buildFurniture(): Model {
  const m = new Model('jarvis tools/make-demo-site.ts (furniture)');
  for (const a of AREAS) a.buildFurniture?.(m);
  lightFixtures(m, 'furniture');
  return m;
}
