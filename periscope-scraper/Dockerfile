FROM node:24-slim AS builder

WORKDIR /app

# Build-time dependencies — we need devDependencies (TypeScript) to compile,
# then we trim node_modules to production-only in the final stage.
# package-lock.json is committed; the explicit copy fails the build if it's
# missing rather than silently masking a misconfiguration.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune devDependencies for the runtime image.
RUN npm prune --omit=dev

FROM node:24-slim

# OS packages required by Playwright's bundled Chromium.
# Reference: https://playwright.dev/docs/docker
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libgbm1 \
        libxshmfence1 \
        libpango-1.0-0 \
        libcairo2 \
        libasound2 \
        ca-certificates \
        fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 scraper && \
    adduser --system --uid 1001 --ingroup scraper scraper

WORKDIR /app

COPY --from=builder --chown=scraper:scraper /app/node_modules ./node_modules
COPY --from=builder --chown=scraper:scraper /app/dist ./dist
COPY --from=builder --chown=scraper:scraper /app/package.json ./package.json

# Install Chromium into the scraper user's home so the runtime user owns it.
USER scraper
ENV PLAYWRIGHT_BROWSERS_PATH=/home/scraper/.cache/ms-playwright
RUN npx playwright install chromium

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
