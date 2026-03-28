FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-slim
RUN addgroup --system --gid 1001 sidecar && \
    adduser --system --uid 1001 --ingroup sidecar sidecar
WORKDIR /app
COPY --from=deps --chown=sidecar:sidecar /app/node_modules ./node_modules
COPY --from=builder --chown=sidecar:sidecar /app/dist ./dist
COPY --chown=sidecar:sidecar package.json ./
ENV NODE_ENV=production
USER sidecar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)throw r})" || exit 1
CMD ["node", "dist/main.js"]
