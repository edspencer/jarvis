# Security

## Reporting a vulnerability

Please report security issues privately, through
[GitHub's private vulnerability reporting](https://github.com/edspencer/jarvis/security/advisories/new), not in a public
issue. Say what is affected (the viewer, the site tools, the container image), how to reproduce it, and what an attacker
could do with it. You should get a reply within a week. Fixes go into the latest release; there are no back-ports.

## What to know before you deploy

- **Home Assistant acts with your login.** The live connection logs in through Home Assistant's own OAuth flow, as the
  user who signs in, and keeps the tokens in that browser's `localStorage`. Anything that can run script on the viewer's
  origin can use them, with that user's rights in Home Assistant. Serve the viewer from an origin you trust, don't
  add third-party scripts, and use a Home Assistant user with only the rights it needs. Every service call the viewer
  makes goes through one allowlist (`src/plugins/home-assistant/policy.ts`): lights and switches on, off or toggled,
  scripts and scenes run. Locks, covers, alarms, climate and the rest are refused, and wall plates never switch live
  Home Assistant. Changes to that allowlist are security-relevant.
- **A site folder describes a building.** Its model, equipment registry, device map and blueprints amount to a floor
  plan of a home with its devices. The viewer has no access control of its own: put it behind your reverse proxy's
  authentication, or keep it on your LAN or VPN. The container sends `X-Robots-Tag: noindex` and a `robots.txt` that
  disallows everything, which keeps out well-behaved crawlers and nothing else.
- **`?site=<url>`** loads a manifest from any URL the browser can reach (with CORS). The manifest is data, not code,
  but a hostile one can point the Home Assistant plugin at a server of its choosing, which would then get the OAuth
  redirect. Don't follow viewer links with a `?site=` you don't trust.
