FROM node:24-slim AS builder

WORKDIR /app

# Build-time dependencies — we need devDependencies (TypeScript) to compile,
# then we trim node_modules to production-only in the final stage.
# package-lock.json is committed; the explicit copy fails the build if it's
# missing rather than silently masking a misconfiguration.
#
# Build context is the REPO ROOT (Railway default — verified 2026-05-08). All COPYs are
# prefixed with `periscope-scraper/` to match. The repo-root
# .dockerignore re-includes `periscope-scraper/` so its files survive
# the global tsconfig/package-lock excludes that target the main app.
COPY periscope-scraper/package.json periscope-scraper/package-lock.json ./
RUN npm ci

COPY periscope-scraper/tsconfig.json ./
COPY periscope-scraper/src ./src
RUN npm run build

# Prune devDependencies for the runtime image.
RUN npm prune --omit=dev

FROM node:24-slim

# Restart nudge: 2026-05-26
# OS packages required by Playwright's bundled Chromium.
# Reference: https://playwright.dev/docs/docker
#
# 2026-05-08: First Railway runtime failed with
#   libXfixes.so.3: cannot open shared object file
# Adding the libxfixes3 / libxext6 / libxcb1 / libnspr4 / libgtk-3-0
# canonical Playwright deps that node:24-slim doesn't ship by default.
# Switching to the explicit list maintained by Playwright is more
# reliable than hand-curating; if Chromium ever fails to launch with
# another missing .so, add it here.
#
# 2026-05-26: tini added as PID 1 reaper. Node as PID 1 doesn't reap
# zombie children, so Chromium subprocesses spawned by Playwright
# accumulate under the cgroup pids.max limit until spawn() returns
# EAGAIN and the scraper stops ticking entirely. Root cause of
# SENTRY-EMERALD-DESERT-CQ (350+ events / 19h continuous failure
# before 2026-05-26 restart). With tini as PID 1, zombies are reaped
# on exit and the limit is not approached.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        tini \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxfixes3 \
        libxext6 \
        libxcb1 \
        libgbm1 \
        libgtk-3-0 \
        libxshmfence1 \
        libpango-1.0-0 \
        libcairo2 \
        libasound2 \
        ca-certificates \
        fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 scraper && \
    adduser --system --uid 1001 --ingroup scraper scraper && \
    mkdir -p /home/scraper/.cache && \
    chown -R scraper:scraper /home/scraper

WORKDIR /app

# Layer order matters for build caching: package.json + node_modules + the
# Chromium install must precede COPY ./dist so a code-only rebuild (which
# only invalidates the dist layer) keeps the ~120MB Chromium download cached.
COPY --from=builder --chown=scraper:scraper /app/package.json ./package.json
COPY --from=builder --chown=scraper:scraper /app/node_modules ./node_modules

# Install Chromium into the scraper user's home so the runtime user owns it.
USER scraper
ENV PLAYWRIGHT_BROWSERS_PATH=/home/scraper/.cache/ms-playwright
RUN npx playwright install chromium

# Code is the most-frequently-changing input — copy it last.
COPY --from=builder --chown=scraper:scraper /app/dist ./dist

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
