# Security

## Reporting a vulnerability

Please report security issues privately, through
[GitHub's private vulnerability reporting](https://github.com/edspencer/jarvis/security/advisories/new), not in a public
issue. Say what is affected (the viewer, the site tools, the container image), how to reproduce it, and what an attacker
could do with it. You should get a reply within a week. Please don't include a real building's site data (models,
addresses, hostnames, tokens) unless the issue needs it.

## Supported versions

The latest release (the `latest` container image and release tarball) and `main`. Fixes go into the next release;
there are no back-ports to older versions.

## What to know before you deploy

- **Home Assistant acts with your login.** The live connection logs in through Home Assistant's own OAuth flow, as the
  user who signs in, and keeps the tokens in that browser's `localStorage`. Anything that can run script on the viewer's
  origin can use them, with that user's rights in Home Assistant. Serve the viewer from an origin you trust, don't
  add third-party scripts, and log the viewer in as a dedicated, non-admin Home Assistant user. Every service call the
  viewer makes goes through one choke point (`send()` in `src/plugins/home-assistant/policy.ts`): only lights and
  switches on, off or toggled, scripts and scenes run (locks, covers, alarms, climate and the rest are refused), and
  only for entities the site's own controls file and fixture map name; an action across domains is checked whole
  first. Plugins can't widen the list, and the console hook is read-only. But plugins run on the same origin and can
  read the tokens like any other script: the allowlist protects against bugs and misclicks, not hostile code. Wall
  plates never switch live Home Assistant. Changes to that allowlist are security-relevant.
- **A site folder describes a building.** Its model, equipment registry, device map and blueprints amount to a floor
  plan of a home with its devices. The viewer has no access control of its own: put it behind your reverse proxy's
  authentication, or keep it on your LAN or VPN. The container sends `X-Robots-Tag: noindex` and a `robots.txt` that
  disallows everything, which keeps out well-behaved crawlers and nothing else.
- **External plugins are code the site owner chooses.** A manifest section with a `module` loads that ES module into the
  viewer, with the viewer's full rights (the tokens above included); JARVIS doesn't sandbox it. The viewer imports a
  module only from its own origin, or from an origin the manifest lists in `pluginOrigins`, and that list counts only
  for a manifest on the viewer's own origin. Review a plugin's code as you would anything you deploy there.
  `npm run validate-site` imports a site's local plugin modules in Node to check them (`--no-plugin-code` doesn't).
- **`?site=<url>`** loads a manifest from any URL the browser can reach (with CORS). The manifest is data, not code (its
  plugins load only from the viewer's own origin), but a hostile one can point the Home Assistant plugin at a server of its choosing, which would then get the OAuth
  redirect. Don't follow viewer links with a `?site=` you don't trust.
