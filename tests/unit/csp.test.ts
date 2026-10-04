// The container's Content-Security-Policy (deploy/nginx.conf, a template the image fills in) is tools/csp.ts's.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../tools/csp';

it("deploy/nginx.conf sends tools/csp.ts's policy, with ${JARVIS_PLUGIN_ORIGINS} for the extra script origins", () => {
  const conf = readFileSync(new URL('../../deploy/nginx.conf', import.meta.url), 'utf8');
  const header = /add_header Content-Security-Policy "([^"]+)" always;/.exec(conf)?.[1];
  expect(header).toBe(contentSecurityPolicy('${JARVIS_PLUGIN_ORIGINS}'));
  expect(contentSecurityPolicy()).toBe(
    "script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'",
  );
  expect(contentSecurityPolicy(' https://a.example ')).toMatch(
    /^script-src 'self' 'unsafe-eval' https:\/\/a\.example;/,
  );
});
