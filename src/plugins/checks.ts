// The site files a plugin's manifest section names, and how `npm run validate-site` checks them: one entry per plugin
// id, each naming the file (a resolved URL from the plugin's section) and its checker. check-site.ts iterates this
// registry, so the core validator doesn't depend on any one plugin; a plugin with a mapping file adds itself here.
// (The older plugins' files, faults / pins / blueprints, are still checked in check-site.ts itself.)
import type { ValidationResult } from '../site/validate.ts';
import { checkEnergyMap, type EnergyMap, type MeterSpec } from './energy/map.ts';

export interface SiteFileCheck {
  /** shown before each issue: 'energy map' */
  what: string;
  /** the file's URL from the plugin's resolved section (undefined: none) */
  file(section: Record<string, unknown>): string | undefined;
  /** the file is required (missing: an error, else a warning) */
  required?: boolean;
  check(json: unknown): ValidationResult & { notes?: string[] };
}

export const PLUGIN_FILE_CHECKS: Record<string, SiteFileCheck[]> = {
  energy: [
    {
      what: 'energy map',
      file: (s) => s.map as string | undefined,
      required: true,
      check(json) {
        const v = checkEnergyMap(json);
        if (!v.ok) return v;
        let n = 0,
          low = 0;
        const count = (ms: MeterSpec[]) =>
          ms.forEach((x) => {
            n++;
            if (x.conf === 'low') low++;
            count(x.children || []);
          });
        count((json as EnergyMap).meters);
        return { ...v, notes: [`${n} meters${low ? ` (${low} low confidence)` : ''}`] };
      },
    },
  ],
};
