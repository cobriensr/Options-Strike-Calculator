# 0DTE SPX Strike Calculator

Single-owner 0DTE SPX options trading tool. Vite + React 19 frontend, Vercel Serverless Functions backend (TypeScript), Python ML scripts.

## Architecture

```text
src/              React 19 SPA (Tailwind CSS 4, no router)
  components/     UI components (50+ TSX files, feature-grouped folders)
  hooks/          Custom React hooks (useAppState, useMarketData, useChainData, etc.)
  utils/          Pure calculation modules (black-scholes, strikes, hedge, iron-condor)
  types/          Shared TypeScript types
  data/           Static data (market hours, VIX stats)
  constants/      App-wide constants

api/              Vercel Serverless Functions
  _lib/           Shared: db.ts (Neon), schwab.ts (OAuth + Redis), api-helpers.ts, sentry.ts, validation.ts, logger.ts
  auth/           Schwab OAuth flow (init.ts, callback.ts)
  cron/           13 scheduled jobs (market data fetching, feature building, lesson curation)
  journal/        Journal CRUD + DB init/migrate
  ml/             ML data export endpoint

ml/               Python scripts (clustering, EDA, visualization)
  plots/          Generated plots — tracked in git, do NOT gitignore

e2e/              Playwright specs (23 specs including a11y)
```

## Commands

```bash
npm run dev          # Vite dev server (frontend only)
npm run dev:full     # Full stack via vercel dev with pino-pretty
npm run build        # tsc + vite build
npm run lint         # tsc --noEmit && eslint (MUST run after code changes)
npm run test         # vitest watch mode
npm run test:run     # vitest single run
npm run test:e2e     # playwright
npm run format       # prettier --write
```

## Key Patterns

### Backend (api/)

- **Auth is single-owner** — one Schwab OAuth session via httpOnly cookie. Plaintext cookie is intentional. No multi-user auth.
- **Neon Postgres** — `@neondatabase/serverless`, lazy singleton via `getDb()`. Four tables: `market_snapshots`, `analyses`, `outcomes`, `positions`.
- **Upstash Redis** — stores Schwab OAuth tokens (access + refresh). Env vars: `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`.
- **Input validation** — Zod schemas in `api/_lib/validation.ts` validate at system boundaries before data reaches Anthropic or Postgres.
- **Cron jobs** — 13 jobs in `vercel.json`, all verify `CRON_SECRET`. Market data fetches run every 5 min during market hours (13-21 UTC, Mon-Fri).
- **Bot protection** — `botid` checks on production endpoints, skipped in local dev.
- **Logging** — `pino` logger in `api/_lib/logger.ts`.
- **Sentry** — error tracking + metrics via `@sentry/node`.

### Frontend (src/)

- **Single-page app** — no router, one `App.tsx` orchestrating all sections.
- **Tailwind CSS 4** with `prettier-plugin-tailwindcss`.
- **Theme system** — `src/themes/` with dark mode default.
- **Custom hooks** — state management via `useAppState`, data fetching via `useMarketData`, `useChainData`, `useVixData`, etc.
- **Pure calculation utils** — `src/utils/` contains Black-Scholes, strike selection, hedge sizing, iron condor P&L. These are heavily tested.
- **Sentry** — frontend error tracking via `@sentry/react`.
- **PWA** — service worker via `vite-plugin-pwa`.

### Testing

- **Unit tests** — Vitest with `@testing-library/react`. Tests live in `src/__tests__/` and `api/__tests__/`.
- **E2E tests** — Playwright with `@axe-core/playwright` for accessibility. Specs in `e2e/`.
- **Coverage** — `npm run test:coverage` for V8 coverage.
- Test files must end in `.test.ts` or `.test.tsx` (unit) or `.spec.ts` (e2e).

## Code Style

- **Prettier** — 2-space indent, single quotes, trailing commas, 80 char width.
- **ESLint** — typescript-eslint + react-hooks + react-refresh + sonarjs. Config in `eslint.config.ts`.
- Nested ternaries in JSX are allowed (`sonarjs/no-nested-conditional: off`).
- Always run `npm run lint` after making code changes.
- Use `type` imports for type-only imports (`import type { ... }`).

## Environment Variables

Required env vars (pulled via `vercel env pull .env.local`):

| Variable                                   | Source                             |
| ------------------------------------------ | ---------------------------------- |
| `DATABASE_URL`                             | Neon Postgres (Vercel Marketplace) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`     | Upstash Redis (Vercel Marketplace) |
| `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` | Schwab developer portal            |
| `ANTHROPIC_API_KEY`                        | Anthropic                          |
| `OPENAI_API_KEY`                           | OpenAI                             |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`          | Sentry                             |
| `CRON_SECRET`                              | Vercel (cron job auth)             |
| `UW_API_TOKEN`                             | Unusual Whales                     |

Never edit `.env*` files with Claude. Never commit secrets.

## Deployment

- **Platform**: Vercel (Fluid Compute, Node 24)
- **Config**: `vercel.json` — crons, security headers, CSP, bot protection rewrites, SPA fallback
- **Long-running functions**: `api/analyze.ts` (800s), `api/cron/curate-lessons.ts` (780s), `api/cron/build-features.ts` (300s)
- **DB setup**: `POST /api/journal/init` creates all tables
