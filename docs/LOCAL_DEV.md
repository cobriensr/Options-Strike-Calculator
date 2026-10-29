# Local Development

How to get strike-calculator running on a clean clone. Allow ~30 minutes.

## Prerequisites

- **Node.js 24.x** — see [.nvmrc](../.nvmrc) and `engines` in `package.json`. Use `nvm use` or install the matching version.
- **npm 9+**
- **Vercel CLI** — `npm i -g vercel`. Required for `npm run dev:full`.
- _(optional)_ **Python** if you intend to touch the Python code: 3.13 for `ml/`, 3.12 for `sidecar/`, `uw-stream/` and `classifier/` (matching their Docker images), each with its own `.venv`. The interpreter is `.venv/bin/python` on macOS/Linux and `.venv/Scripts/python` on Windows. The repo-root, `ml/` and `sidecar/` Makefiles pick the right one by `$(OS)`, so `make <target>` works on both without a `PYTHON=` override.

## Setup paths

Two options for where data comes from. **Pick the one that matches what you're working on.**

### A. Frontend only (calculator UI, no live data)

Fastest path. Sufficient for editing strike math, theme work, or component tweaks.

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
cp .env.example .env.local      # leave fields blank
npm install
npm run dev                      # http://localhost:5173
```

The UI loads in degraded mode — calculator works with manual inputs; market-data sections will be empty.

### B. Full stack against production data (recommended for backend work)

Pulls real `.env.local` from your linked Vercel project. Reads live Neon, Upstash, Schwab.

```bash
npm install
vercel link                      # one-time, links to your Vercel project
vercel env pull .env.local       # pulls all env vars
npm run dev:full                 # http://localhost:3000
```

**Caution:** this `.env.local` points at the production database. Crons you trigger by hand, `/api/journal/init` and `/api/journal/migrate` all write to it.

Crons do not fire locally — you'll see existing data but no fresh fetches until you hit cron endpoints directly. Crons accept only `GET`, with `CRON_SECRET` as a bearer token:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/<job-name>?force=1"
```

`?force=1` skips the market-hours window in crons that use `cronGuard`.

### Offline Postgres (not supported today)

The API can't run against a local Postgres as-is. `getDb()` in [api/\_lib/db.ts](../api/_lib/db.ts) uses the Neon serverless driver's HTTP mode (`neon(url)`), which sends queries over HTTPS to Neon's `/sql` endpoint, and a plain Postgres container serves no such endpoint. Supporting it would take a Neon-compatible local HTTP proxy in front of Postgres plus a dev-only `neonConfig.fetchEndpoint` override in `db.ts`.

[docker-compose.dev.yml](../docker-compose.dev.yml) (`npm run db:up` / `db:down` / `db:reset`) still starts a plain Postgres 17 at `postgresql://strike:strike@localhost:5432/strike_dev`. Clients that speak the Postgres wire protocol can connect to it, for example the sidecar, whose only database use is its `/health` check (a commented-out service in the same compose file). The app's schema is created through the API, so the container starts empty.

## Schwab OAuth (local)

To exercise auth-gated endpoints (`/api/analyze`, owner writes), you need a Schwab developer app:

1. Register at <https://developer.schwab.com>.
2. Create an app with **callback URL** `http://localhost:3000/api/auth/callback` (for local) and your prod origin (for prod). Schwab accepts a comma-separated list.
3. Set `SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET` in `.env.local`.
4. Set `APP_URL=http://localhost:3000`.
5. Set `OWNER_SECRET` (e.g. `openssl rand -hex 32`); the callback sets the `sc-owner` cookie to this value. Set `OWNER_SCHWAB_ACCOUNT_SHA256` to the lowercase sha256 hex of your Schwab account number (`.env.example` shows how to compute it). If it is unset, every login is refused and no tokens are stored.
6. Visit `http://localhost:3000/api/auth/init` to start the flow; you'll land back at `/api/auth/callback` which sets the `sc-owner` cookie.

Without OAuth setup, Schwab-backed endpoints return 401 ("No tokens found") and `/api/analyze` rejects non-owners with 401.

## Database init

Once `DATABASE_URL` is set in `.env.local` (pulled from Vercel, or a Neon database or branch of your own):

```bash
# Creates base tables + runs all migrations
curl -X POST http://localhost:3000/api/journal/init \
  -b "sc-owner=$OWNER_SECRET"

# Safe to repeat — adds new columns to existing tables
curl -X POST http://localhost:3000/api/journal/migrate \
  -b "sc-owner=$OWNER_SECRET"
```

Migrations live in [api/\_lib/db-migrations.ts](../api/_lib/db-migrations.ts). When you add one, update [api/\_\_tests\_\_/db.test.ts](../api/__tests__/db.test.ts) mock counts — see CLAUDE.md §"DB Migrations".

## Tests

- `npm run test:run` — vitest unit tests. **Runs without env vars** (Neon and Schwab are mocked).
- `npm run test:e2e` — Playwright. Auto-manages the dev server. Includes a11y suites via `@axe-core/playwright`.
- `npm run review` — full pipeline: type-check (src, api, scripts) + eslint + `prettier --write` + `vite build` + build-output check + vitest with coverage + coverage floors. Run before any commit.

## Pitfalls

1. **`.js` extensions in `src/` files imported by `api/`** — Vite rewrites extension-less imports for the browser bundle, but Node's strict ESM resolver does not. Vercel functions will crash with `ERR_MODULE_NOT_FOUND` in production while local dev passes. Files in this category include `src/utils/timezone.ts`, `src/data/marketHours.ts`, `src/components/LotteryFinder/ct-window.ts`, `src/utils/gex-target/`, `src/utils/zero-gamma.ts` and `src/utils/black-scholes.ts`. Use `import { x } from './foo.js'`, not `'./foo'`. Type-only imports (`import type`) are erased at compile time and don't need the extension.

2. **`npm run dev` (frontend only) can't reach the API** — Vite proxies `/api/*` to `http://localhost:3000` (override the target with `VITE_API_TARGET`), which doesn't exist unless `vercel dev` is running. Use `npm run dev:full` for the integrated experience, or run the two in separate terminals.

3. **Empty UI is normal offline** — crons don't fire in local dev. The frontend will show "no data" placeholders. Polling hooks gate on `marketOpen` to avoid spam.

4. **Guest mode partial functionality** — if `GUEST_ACCESS_KEYS` is set and a non-owner enters one of the keys in the access-key form (`POST /api/auth/guest-key`, which sets a 30-day `sc-guest` cookie), they get read access to data endpoints and can save their own panel layout, but **not** `/api/analyze` (owner-only). See [api/\_lib/guest-auth.ts](../api/_lib/guest-auth.ts).

5. **Bot protection** — endpoints that call `checkBot(req)` must also be listed in the `protect` array of `initBotId()` in [src/main.tsx](../src/main.tsx). `vercel.json` only proxies BotID's challenge script. BotID is skipped in local dev.

6. **Windows** — several npm scripts use POSIX syntax (`VAR=value cmd`, e.g. `dev:full`), and npm runs scripts through `cmd.exe` on Windows by default. Run them from Git Bash or WSL and point npm at bash: `npm config set script-shell 'C:\Program Files\Git\bin\bash.exe'`.

## Going further

- [README.md](../README.md) — entry-point index; features, architecture and deployment live in [FEATURES.md](FEATURES.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [DEPLOYMENT.md](DEPLOYMENT.md).
- [CLAUDE.md](../CLAUDE.md) — project conventions, dev workflow, AI agent guidance.
- [docs/INDEX.md](INDEX.md) — map of design specs and runbooks.
- [sidecar/README.md](../sidecar/README.md), [ml/README.md](../ml/README.md), [uw-stream/README.md](../uw-stream/README.md), [classifier/README.md](../classifier/README.md) — Python services and pipeline.
