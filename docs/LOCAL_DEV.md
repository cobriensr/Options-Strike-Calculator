# Local Development

How to get strike-calculator running on a clean clone. Allow ~30 minutes.

## Prerequisites

- **Node.js 24+** — see [.nvmrc](../.nvmrc). Use `nvm use` or install matching version.
- **npm 9+**
- **Vercel CLI** — `npm i -g vercel`. Required for `npm run dev:full`.
- _(optional)_ **Python 3.12** + `.venv` if you intend to touch `ml/`, `sidecar/`, or `uw-stream/`.
- _(optional)_ **Docker** if you want a fully offline DB (see Path C below).

## Setup paths

Three options for where data comes from. **Pick the one that matches what you're working on.**

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

Crons do not fire locally — you'll see existing data but no fresh fetches until you hit cron endpoints directly:

```bash
curl -X POST "http://localhost:3000/api/cron/<job-name>?secret=$CRON_SECRET"
```

### C. Local Postgres (offline)

For backend changes that touch schema. Uses `docker-compose.dev.yml` for an isolated DB.

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env.local
# Edit .env.local:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/strike_dev
#   OWNER_SECRET=<openssl rand -hex 32>
npm install
npm run dev:full
curl -X POST http://localhost:3000/api/journal/init \
  -b "sc-owner=$OWNER_SECRET"
```

UI loads but every market-data section is empty. Useful for testing migrations and Zod schemas; not useful for visual development.

## Schwab OAuth (local)

To exercise auth-gated endpoints (`/api/analyze`, owner writes), you need a Schwab developer app:

1. Register at <https://developer.schwab.com>.
2. Create an app with **callback URL** `http://localhost:3000/api/auth/callback` (for local) and your prod origin (for prod). Schwab accepts a comma-separated list.
3. Set `SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET` in `.env.local`.
4. Set `APP_URL=http://localhost:3000`.
5. Visit `http://localhost:3000/api/auth/init` to start the flow; you'll land back at `/api/auth/callback` which sets the `sc-owner` cookie.

Without OAuth setup, market-data endpoints will 404 and `/api/analyze` will reject with 401.

## Database init

Once `DATABASE_URL` is set in `.env.local` (either pulled from Vercel or pointed at your local Postgres):

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
- `npm run review` — full pipeline: tsc + eslint + prettier + vitest with coverage. Run before any commit.

## Pitfalls

1. **`.js` extensions in `src/` files imported by `api/`** — Vite rewrites extension-less imports for the browser bundle, but Node's strict ESM resolver does not. Vercel functions will crash with `ERR_MODULE_NOT_FOUND` in production while local dev passes. Files in this category: `src/utils/max-pain.ts`, `src/utils/timezone.ts`, `src/utils/futures-gamma/*`. Use `import { x } from './foo.js'`, not `'./foo'`. Type-only imports (`import type`) are erased at compile time and don't need the extension.

2. **`npm run dev` (frontend only) can't reach the API** — Vite proxies `/api/*` to `http://localhost:3000`, which doesn't exist unless `vercel dev` is running. Use `npm run dev:full` for the integrated experience, or run the two in separate terminals.

3. **Empty UI is normal offline** — crons don't fire in local dev. The frontend will show "no data" placeholders. Polling hooks gate on `marketOpen` to avoid spam.

4. **Guest mode partial functionality** — if `GUEST_ACCESS_KEYS` is set and a non-owner visits with `?key=<value>`, they get read-only access to data endpoints but **not** to `/api/analyze` (owner-only). See [api/\_lib/guest-auth.ts](../api/_lib/guest-auth.ts).

5. **Bot protection in production rewrites paths** — `vercel.json` rewrites protected paths through `botid`. If you add a new public endpoint, also add its path to the `protect` array in [src/main.tsx](../src/main.tsx).

## Going further

- [README.md](../README.md) — feature reference, architecture, deployment.
- [CLAUDE.md](../CLAUDE.md) — project conventions, dev workflow, AI agent guidance.
- [docs/INDEX.md](INDEX.md) — map of design specs and runbooks.
- [sidecar/README.md](../sidecar/README.md), [ml/README.md](../ml/README.md), [uw-stream/README.md](../uw-stream/README.md) — Python services and pipeline.
