# Deploying

JARVIS is static files: the viewer (`dist/`, from `npm run build` or a release tarball) and a **site folder** with your
building's `site.json`, model and data files. Serve both from one web server, at the same base URL, and the viewer reads
`site.json` next to the page. No backend, no database; the Home Assistant connection goes straight from the browser to
Home Assistant.

Read [SECURITY.md](../SECURITY.md) first: a site folder is a floor plan of a building and its devices, and the viewer has
no access control of its own. Keep it on your LAN or VPN, or put it behind your reverse proxy's authentication.

## The container image

`ghcr.io/edspencer/jarvis` is nginx serving the viewer, set up as below. It ships with the demo house as its site;
mount your own site folder over it at `/usr/share/nginx/html/site`:

```sh
docker run -d --name jarvis -p 8080:80 \
  -v ./my-site:/usr/share/nginx/html/site:ro \
  ghcr.io/edspencer/jarvis:latest
```

Then open `http://localhost:8080/`. `my-site/` is any folder that passes `npm run validate-site -- my-site`: `site.json`
and the files it names (models, parts files, the Home Assistant map, blueprints…), in their subfolders as the manifest
gives them. Files are served from the viewer first, then from the site folder, at the same paths, so `site.json` is at
`/site.json` and `model.glb` at `/model.glb`.

With Docker Compose:

```yaml
services:
  jarvis:
    image: ghcr.io/edspencer/jarvis:latest # or pin a version, e.g. :0.2
    restart: unless-stopped
    ports: ['8080:80']
    volumes:
      - ./my-site:/usr/share/nginx/html/site:ro
```

Updating the site needs no restart: replace the files (write a new model under a temporary name and rename it, so no
browser gets half a file). Every response carries `Cache-Control: no-cache`, so a reload revalidates and picks up the
change. To update the viewer, pull a newer image.

Tags: `<version>` (e.g. `0.2.0`), `<major>.<minor>` (the newest patch of that minor) and `latest`. Images are built
for linux/amd64 and linux/arm64.

### External plugins and the Content-Security-Policy

The image sends `Content-Security-Policy: script-src 'self' 'unsafe-eval'; worker-src 'self' blob:;
object-src 'none'; base-uri 'self'`: scripts run only from the viewer's own origin. A site whose external plugins load
from another origin (one its manifest lists in `pluginOrigins`) needs that origin in the policy too: set
`JARVIS_PLUGIN_ORIGINS` to a space-separated list of origins (scheme, host and port; no paths) when you start the
container:

```sh
docker run -d -p 8080:80 -e JARVIS_PLUGIN_ORIGINS="https://plugins.example.org" \
  -v ./my-site:/usr/share/nginx/html/site:ro ghcr.io/edspencer/jarvis:latest
```

**Why `'unsafe-eval'`.** A model's KTX2 (Basis Universal) textures are transcoded by three.js's `basis_transcoder.js`,
an Emscripten build whose glue code creates functions with `new Function`, in a `blob:` worker that inherits the page's
policy. Without `'unsafe-eval'` such a model never loads. It lets code already on the page evaluate strings; it doesn't
let a script from another origin run, which is what the origin list is for.

The policy is what stops a hostile manifest or a redirect from bringing script onto the viewer's origin, whatever the
viewer's own checks miss ([trust](plugins.md#external-plugins)). An origin is the whole host: a viewer under a
sub-path trusts every script on it.

### Home Assistant

The browser talks to Home Assistant directly, so add the viewer's origin (e.g. `http://jarvis.example.lan:8080`) to
Home Assistant's `http: cors_allowed_origins`, and set `plugins["home-assistant"].url` in `site.json` to the Home
Assistant URL the browser uses. Home Assistant's OAuth login uses the viewer's origin as the client id: nothing has to
be registered in Home Assistant.

## Any other static server

Download `jarvis-<version>.tgz` from a [release](https://github.com/edspencer/jarvis/releases) (or build `dist/` with
`npm run build`), unpack it, and serve it with your site folder's files merged into the same directory, or the two
directories at the same URL path. Alternatively serve the site folder anywhere and open the viewer with
`?site=<url of its site.json>` (another origin needs CORS headers for the manifest and every file it names).

What the server must do:

- serve `.glb` as `model/gltf-binary` and `.wasm` as `application/wasm` (the KTX2 / Basis texture transcoder is
  compiled while streaming, which needs that type); `.ktx2` as `image/ktx2` if the site has loose textures;
- not cache stale models: `Cache-Control: no-cache` (with ETags or Last-Modified, so a reload is cheap);
- ideally gzip JSON, JavaScript and WebAssembly (parts files and device maps shrink 4–8×);
- for a private building, send `X-Robots-Tag: noindex` and a `robots.txt` that disallows everything;
- send the Content-Security-Policy above (`tools/csp.ts` prints it: `script-src 'self' 'unsafe-eval'` plus your
  plugin origins; the Basis transcoder runs in `blob:` workers and needs `'unsafe-eval'`, see below).

The image's nginx configuration, [`deploy/nginx.conf`](../deploy/nginx.conf), does all of that with the viewer in
`/usr/share/nginx/html` and the site folder in `/usr/share/nginx/html/site` (it is a template: replace
`${JARVIS_PLUGIN_ORIGINS}` with your plugin origins, or nothing). In short:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    add_header Cache-Control "no-cache" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Content-Security-Policy "script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'" always;
    location = /robots.txt { default_type text/plain; return 200 "User-agent: *\nDisallow: /\n"; }

    location / { try_files $uri $uri/ @site; }                      # the viewer first,
    location @site { root /usr/share/nginx/html/site; try_files $uri =404; }   # then the site folder

    include /etc/nginx/mime.types;
    types { model/gltf-binary glb; model/gltf+json gltf; image/ktx2 ktx2; }
    gzip on;
    gzip_types text/css text/javascript application/javascript application/json application/wasm model/gltf-binary;
}
```

Check a deployment from a browser on the same network: `site.json` returns JSON, the model returns
`model/gltf-binary`, `/assets/basis_transcoder-*.wasm` returns `application/wasm`, and the page shows the loading
screen, then the first viewpoint. A missing or invalid manifest is listed field by field on the loading screen.

## Building the image yourself

```sh
docker build -t jarvis .
docker run -p 8080:80 -v ./my-site:/usr/share/nginx/html/site:ro jarvis
```
