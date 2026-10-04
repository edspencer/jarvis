# JARVIS: nginx serving the built viewer, with a site folder at /usr/share/nginx/html/site (the demo house unless you
# mount your own). See docs/deploy.md.
#
#   docker run -p 8080:80 -v ./my-site:/usr/share/nginx/html/site:ro ghcr.io/edspencer/jarvis

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
LABEL org.opencontainers.image.source="https://github.com/edspencer/jarvis" \
      org.opencontainers.image.description="JARVIS: a browser walkthrough for a building's digital twin" \
      org.opencontainers.image.licenses="MIT"
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY examples/demo-site/ /usr/share/nginx/html/site/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
