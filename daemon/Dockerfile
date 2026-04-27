# TRACE Live capture daemon — Railway deployment.
#
# This container does NOT install Chromium. The headless browser runs
# remotely on browserless.io; we just need Node + Playwright's CLIENT
# library to talk to it via WebSocket.
#
# Build context: daemon/ subdirectory of the repo. Set Railway's root
# directory to `daemon` so this Dockerfile sees package.json at /app.

FROM node:22-alpine

WORKDIR /app

# Install deps first (cached layer), then source. Use `npm ci` for
# reproducible installs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# tsx is a devDependency; we still need it at runtime for the entry
# point. Install it separately so we don't pull in the rest of the
# devDeps (eslint, types, etc.).
RUN npm install --no-save --no-audit --no-fund tsx@^4.20.6

COPY src ./src
COPY tsconfig.json ./

# Long-running process — Railway sends SIGTERM on redeploy; the index
# handles graceful shutdown via Sentry.close() + scheduler.stop().
CMD ["npx", "tsx", "src/index.ts"]
