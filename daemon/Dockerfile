# TRACE Live capture daemon — Railway deployment.
#
# This container does NOT install Chromium. The headless browser runs
# remotely on browserless.io; we just need Node + Playwright's CLIENT
# library to talk to it via WebSocket.
#
# Build context: REPO ROOT (set Railway's root directory to "/" or
# leave unset). The container mirrors the repo's directory layout so
# the daemon's imports of '../../src/data/marketHours.js' (and the two
# similar shared modules) resolve at runtime exactly as they do in
# local dev. The repo-root .dockerignore re-includes only those three
# shared TypeScript files via ! patterns; everything else under src/
# stays excluded.

FROM node:22-alpine

WORKDIR /app/daemon

# Install deps first (cached layer), then source. Use `npm ci` for
# reproducible installs.
COPY daemon/package.json daemon/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# tsx is a devDependency; we still need it at runtime for the entry
# point. Install it separately so we don't pull in the rest of the
# devDeps (eslint, types, etc.).
RUN npm install --no-save --no-audit --no-fund tsx@^4.20.6

# Daemon source + tsconfig under /app/daemon/...
COPY daemon/src ./src
COPY daemon/tsconfig.json ./

# Shared modules from the main app, copied to /app/src/... so that
# '../../src/data/marketHours.js' from /app/daemon/src/scheduler.ts
# resolves to /app/src/data/marketHours.ts at runtime.
COPY src/data/marketHours.ts /app/src/data/marketHours.ts
COPY src/utils/trace-live-tz.ts /app/src/utils/trace-live-tz.ts
COPY src/utils/gex-classification.ts /app/src/utils/gex-classification.ts

# ESM marker for /app/. Without an ancestor package.json declaring
# "type": "module", Node walks up from the shared .ts files, finds
# nothing, and falls back to CJS — breaking named-export imports
# from the ESM daemon. A minimal marker is enough; we don't need
# the main app's deps (those stay isolated under /app/daemon/).
RUN echo '{"type":"module"}' > /app/package.json

# Long-running process — Railway sends SIGTERM on redeploy; the index
# handles graceful shutdown via Sentry.close() + scheduler.stop().
CMD ["npx", "tsx", "src/index.ts"]
