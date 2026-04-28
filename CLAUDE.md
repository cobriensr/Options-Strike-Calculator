# 0DTE SPX Strike Calculator

Single-owner 0DTE SPX options trading tool. Vite + React 19 frontend, Vercel Serverless Functions backend (TypeScript), Python ML scripts, Railway Python sidecar for Databento futures + ES options ingestion.

## Architecture

```text
src/              React 19 SPA (Tailwind CSS 4, no router)
  components/     UI components (50+ TSX files, feature-grouped folders)
  hooks/          Custom React hooks (useAppState, useMarketData, useChainData, etc.)
  utils/          Pure calculation modules (black-scholes, strikes, hedge, iron-condor, pin-risk, etc.)
  types/          Shared TypeScript types
  data/           Static data (market hours, VIX stats — VIX OHLC has a cutoff date)
  constants/      App-wide constants

api/              Vercel Serverless Functions
  _lib/           21+ shared modules (see "Backend Modules" below)
  auth/           Schwab OAuth flow (init.ts, callback.ts)
  cron/           35 scheduled jobs (market data fetching, feature building, lesson curation)
  journal/        Journal CRUD + DB init/migrate
  ml/             ML data export endpoint

sidecar/          Databento futures data ingestion (Python, Railway, NOT Vercel)
  src/            Python 3 service using databento SDK + psycopg2
                  Ingests 7 futures symbols (ES, NQ, ZN, RTY, CL, GC, DX) + ES options
                  Own requirements.txt, pyproject.toml, Dockerfile
                  Uses psycopg2 (not @neondatabase/serverless) for Neon Postgres
                  Sentry SDK for error tracking; VX deferred pending Databento availability
                  vercel.json ignoreCommand skips deploys for sidecar/, ml/, scripts/, pine/, docs/, *.md changes

ml-sweep/         PAC backtest runner (Python, Railway, NOT Vercel — sibling to sidecar)
                  FastAPI + bearer auth gating /run, /status/{id}, /logs/{id}, /hydrate, /hydrate/status
                  Spawns whitelisted sweep scripts (pac_backtest CPCV + Optuna) as subprocesses
                  5 GB volume at /data hydrated from Vercel Blob archive (parquet per year)
                  Heartbeat (30s) + orphan recovery on container restart; uploads JSON to Blob
                  Own Dockerfile, README.md, TEARDOWN.md — auto-deploys on ml-sweep/** or ml/** pushes
                  Do NOT enable scale-to-zero (kills sweeps mid-flight — HTTP idle counter is
                  blind to subprocess CPU)

scripts/          Backfill scripts (backfill-etf-tide.mjs, backfill-greek-exposure.mjs, etc.)

ml/               Python ML pipeline (clustering, EDA, classification, visualization)
  src/            Source modules (utils, clustering, eda, phase2_early, pin_analysis, etc.)
  tests/          Pytest test files (test_clustering, test_phase2, etc.)
  docs/           Phase specs and design docs (ROADMAP.md, PHASE-*.md)
  plots/          Generated plots — tracked in git, do NOT gitignore
  experiments/    JSON experiment results (phase2_early runs)
  .venv/          Python venv — run scripts with `ml/.venv/bin/python`, not system python3
  conftest.py     Adds ml/src/ to sys.path for test imports

docs/             Design artifacts
  superpowers/    specs/ and plans/ for feature design documents

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

## Development Workflow (Get It Right)

Every code change follows this implement-verify-review loop. No exceptions. This applies to the main session and all subagents that write code.

### Plan First (Large Changes)

For any change that spans **3+ files, introduces a new feature end-to-end, or was scoped across multiple conversation turns**, write a plan doc to `docs/superpowers/specs/` BEFORE starting the Get It Right loop. Context compaction can silently drop the scoping conversation — the plan doc is the durable handoff to the next session (or this session post-compaction).

The plan must include:

- **Goal** — one sentence on what this feature does and why
- **Phases** — numbered, each independently shippable, with rough scope estimates
- **Files to create/modify** — concrete list, grouped by phase
- **Data dependencies** — new tables, migrations, env vars, external APIs
- **Open questions** — anything undecided, with default picks noted
- **Thresholds / constants** — any magic numbers agreed on during scoping

Skip the plan doc only for:

- Bug fixes within a single file
- Refactors contained to one module
- Config-only changes (`.json`, `.md`, ESLint/Prettier tweaks)

When in doubt, write the plan. A plan doc is ~10 minutes; rediscovering scope is much more.

### The Loop

**1. Implement** — Write the code. Investigate first, understand existing patterns, then make changes.

**2. Verify** — Run `npm run review`. Fix any failures. If it still fails after 2 fix attempts, proceed to step 3 with the failure details.

**3. Self-Review** — Launch a **reviewer subagent** to evaluate the implementation with fresh eyes. The subagent must:

- Run `git diff` to read every changed file
- Evaluate against: correctness, pattern adherence (CLAUDE.md conventions), code quality, test coverage, side effects
- Return a verdict: `pass`, `continue`, or `refactor`
- Write detailed feedback (this is the ONLY bridge to the next iteration if not passing)

**Reviewer subagent verdict meanings:**

- **pass** — Correct and complete. Commit the changes.
- **continue** — Approach is sound but has fixable issues. Apply the feedback, re-run verify, and re-review. Do NOT start over.
- **refactor** — Approach is fundamentally wrong. Launch a **refactor subagent** to undo the problematic work (revert, do NOT reimplement), then restart from step 1 with the reviewer's feedback guiding a fresh approach.

**4. Act** — On `pass`: stage and commit. On `continue` or `refactor`: loop back (max 3 total iterations). After 3 iterations, commit what you have and report honestly what's unresolved.

### When to skip the review subagent

- Single-line config changes, typo fixes, or comment edits
- Changes that only touch `.md` files, `.json` config, or `ml/` Python scripts

Everything else gets the full loop.

## Key Patterns

### Backend (api/)

- **Auth is single-owner + optional guest keys** — one Schwab OAuth session via httpOnly cookie. Plaintext cookie is intentional. The owner can hand out comma-separated guest keys via `GUEST_ACCESS_KEYS`; guests get read-only access to owner-gated data endpoints (dark pool, GEX, TRACE Live, etc.) but **not** to the Anthropic-backed `api/analyze.ts`. See `api/_lib/guest-auth.ts` (`rejectIfNotOwnerOrGuest`, `guardOwnerOrGuestEndpoint`) and `src/utils/auth.ts` (`getAccessMode`).
- **Neon Postgres** — `@neondatabase/serverless`, lazy singleton via `getDb()`. 40+ tables managed by numbered migrations in `migrateDb()` (tracked in `schema_migrations`).
- **Upstash Redis** — stores Schwab OAuth tokens (access + refresh). Env vars: `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`.
- **Input validation** — Zod schemas in `api/_lib/validation.ts` validate at system boundaries before data reaches Anthropic or Postgres.
- **Cron jobs** — 35 jobs in `vercel.json`, all verify `CRON_SECRET`. Market data fetches run every 5 min during market hours (13-21 UTC, Mon-Fri).
- **Bot protection** — `botid` checks on production endpoints, skipped in local dev. **When adding a new endpoint that calls `checkBot(req)`, also add its path to the `protect` array in `src/main.tsx`'s `initBotId()` call.**
- **Logging** — `pino` logger in `api/_lib/logger.ts`.
- **Sentry** — error tracking + metrics via `@sentry/node`.

#### Backend Modules (`api/_lib/`)

Key modules beyond the basics:

- `db.ts` — `initDb()` (base tables) + `migrateDb()` (69 numbered migrations, stored in `api/_lib/db-migrations.ts`). New tables go in `migrateDb()` only, never `initDb()`.
- `db-analyses.ts`, `db-flow.ts`, `db-snapshots.ts`, `db-positions.ts`, `db-strike-helpers.ts` — query modules split from db.ts.
- `analyze-prompts.ts` — static Anthropic prompt text (system prompt parts, rules, chart type descriptions).
- `analyze-context.ts` — dynamic context assembly; calls formatters from `db-flow.ts` (e.g. `formatSpotExposuresForClaude()`).
- `lessons.ts` — lesson curation logic.
- `overnight-gap.ts`, `spx-candles.ts`, `max-pain.ts`, `darkpool.ts`, `embeddings.ts`, `csv-parser.ts` — domain-specific modules.
- `schwab.ts`, `api-helpers.ts`, `sentry.ts`, `validation.ts`, `logger.ts`, `constants.ts` — infrastructure.

#### Chain Data Boundary

Chain data (per-strike OI, IV, skew) lives in **frontend state only** via `useChainData`. To use it in the analyze endpoint, it must be explicitly passed in the `AnalysisContext` payload. Formatters for server-side data live in `db-flow.ts`.

#### DB Migrations

When adding a migration to `migrateDb()` in `db.ts`, you must also update `api/__tests__/db.test.ts`:

- Add `{ id: N }` to the applied-migrations mock
- Add the migration to the expected-output list
- Update the SQL call count (each migration = 1 CREATE/ALTER + 1 INSERT INTO schema_migrations)

### Frontend (src/)

- **Single-page app** — no router, one `App.tsx` orchestrating all sections.
- **Tailwind CSS 4** with `prettier-plugin-tailwindcss`.
- **Theme system** — `src/themes/` with dark mode default.
- **Custom hooks** — state management via `useAppState`, data fetching via `useMarketData`, `useChainData`, `useVixData`, etc. Polling hooks gate refresh on `marketOpen` — do not add unconditional polling.
- **Market hours time init** — `useAppState` defaults time to 10:00 AM CT outside market hours to keep `useCalculation` valid. The calculator produces no results if given an out-of-hours time.
- **Pure calculation utils** — `src/utils/` contains Black-Scholes, strike selection, hedge sizing, iron condor P&L, pin risk, and more. These are heavily tested.
- **Sentry** — frontend error tracking via `@sentry/react`.
- **PWA** — service worker via `vite-plugin-pwa`. Dynamic `import()` calls must include `.catch()` with a reload prompt for stale-chunk resilience. `cleanupOutdatedCaches: true` is set in `vite.config.ts`.

### Testing

- **Unit tests** — Vitest with `@testing-library/react`. Frontend tests in `src/__tests__/`, backend tests in `api/__tests__/`.
- **E2E tests** — Playwright with `@axe-core/playwright` for accessibility. Specs in `e2e/`. Use semantic selectors (`getByRole`, `getByLabel`, `data-testid`).
- **Coverage** — `npm run test:coverage` for V8 coverage.
- Test files must end in `.test.ts` or `.test.tsx` (unit) or `.spec.ts` (e2e).
- **Cron test pattern** — mock `getDb` via `vi.mocked(getDb)`. Use `mockResolvedValueOnce` in the same sequence as the handler's DB queries. Provide `CRON_SECRET` in `process.env`.

## Code Style

- **Prettier** — 2-space indent, single quotes, trailing commas, 80 char width.
- **ESLint** — typescript-eslint + react-hooks + react-refresh + sonarjs. Config in `eslint.config.ts`.
- Nested ternaries in JSX are allowed (`sonarjs/no-nested-conditional: off`).
- **SonarJS rules to remember**: use `Number.parseFloat`/`Number.parseInt` (not globals), use `.at(-1)` not `[arr.length - 1]`, no nested template literals (extract to variable).
- Run `npm run lint` before reporting any task complete. Lint covers root project only — `sidecar/` and `playwright-report/` are in the ESLint ignores list.
- Use `type` imports for type-only imports (`import type { ... }`).
- **Explicit `.js` extensions in relative imports from `src/` that are imported by `api/`** — any file in `src/` that an `api/*` handler imports (directly or transitively) must use explicit `.js` extensions on all relative imports, e.g. `import { x } from './foo.js'` not `'./foo'`. Vite rewrites extension-less imports for the browser bundle, but Vercel Functions run Node's strict ESM resolver which does not. Failure mode: production Function crashes with `ERR_MODULE_NOT_FOUND` for the extension-less path while local dev + tests still pass. Type-only imports (`import type { ... }`) are erased at compile time and do NOT need `.js`. Examples of server-pulled `src/` files in this repo: `src/utils/max-pain.ts`, `src/utils/timezone.ts`, `src/utils/futures-gamma/{alerts,playbook,basis,triggers,tradeBias,types}.ts`. When adding a new `src/` module that `api/` will import, add `.js` to every non-type relative import inside it and inside its transitive deps.

### Optional props policy (`exactOptionalPropertyTypes` is OFF — intentional)

The codebase treats `foo?: T` as "the field may be absent **or explicitly set to undefined**". The two are semantically equivalent everywhere we care:

- **React props** — `<Foo prop={undefined} />` and `<Foo />` are runtime-identical.
- **JSON.stringify** — undefined values are omitted, so network / DB / cache paths coalesce both forms.
- **Zod `.optional()`** — accepts both missing keys and `{key: undefined}`.
- **Anthropic/OpenAI SDKs** — serialize through JSON, so same coalescing.

Because of this, we do **not** write code that distinguishes "absent" from "undefined":

- ❌ Do not use `'foo' in obj` or `Object.hasOwnProperty(obj, 'foo')` to test whether a typed prop was set. (The `'error' in row` pattern for discriminated-union narrowing is fine — different use case.)
- ❌ Do not rely on `Object.keys(obj).length` on typed object shapes for the same reason.
- ✅ Use `obj.foo != null` / `obj.foo !== undefined` / optional chaining. These coalesce the distinction, which matches React/JSON semantics.

If you need genuine set-vs-unset semantics (rare — no production code in this repo does), model it explicitly: an `'unset'` sentinel string, a `null` sentinel, or a discriminated loading state (`{ status: 'loading' } | { status: 'loaded'; value: T }`). Don't rely on `undefined`.

Turning on `exactOptionalPropertyTypes` was evaluated during the 2026-04-16 TypeScript audit (Phase 1B) and rejected: 119 type errors to fix, zero runtime bugs prevented in this codebase (verified by grepping for `in`/`hasOwnProperty` patterns). See `docs/superpowers/specs/react-ts-audit-2026-04-16.md`.

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
| `UW_API_KEY`                               | Unusual Whales                     |
| `GUEST_ACCESS_KEYS`                        | Comma-separated guest keys (opt.)  |
| `THETA_EMAIL`, `THETA_PASSWORD`            | Theta Data (Railway sidecar only)  |
| `BLOB_READ_WRITE_TOKEN`                    | Vercel Blob (also on Railway)      |
| `ARCHIVE_MANIFEST_URL`                     | Archive manifest (Railway only)    |
| `ARCHIVE_SEED_TOKEN`                       | Gates seed POST (Railway only)     |
| `ARCHIVE_ROOT`                             | Volume path; default /data/archive |
| `AUTH_TOKEN`                               | ml-sweep bearer (Railway only)     |
| `RAILWAY_RUN_UID`                          | `0` on Railway for volume write    |

Never edit `.env*` files with Claude. Never commit secrets.

The `ARCHIVE_*` and `BLOB_READ_WRITE_TOKEN` vars wire up the persistent
Databento archive on the Railway sidecar's `/data` volume.
`POST /admin/seed-archive` is a one-shot, SHA-resumable pull from Blob —
see `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.

The `ml-sweep` service reuses `ARCHIVE_MANIFEST_URL`, `ARCHIVE_ROOT`,
and `BLOB_READ_WRITE_TOKEN` to pull the archive onto its own separate
volume, plus `AUTH_TOKEN` to gate `/run`, `/status/{id}`, `/logs/{id}`,
and `/hydrate*`. See `ml-sweep/README.md` for the full operational
playbook and `ml-sweep/TEARDOWN.md` for shutdown / cleanup.

## Deployment

- **Platform**: Vercel (Fluid Compute, Node 24)
- **Config**: `vercel.json` — crons, security headers, CSP, bot protection rewrites, SPA fallback, `ignoreCommand` skips builds when only `sidecar/`, `ml/`, `scripts/`, `pine/`, `docs/`, or `*.md` files change
- **Long-running functions**: `api/analyze.ts` (800s), `api/cron/curate-lessons.ts` (780s), `api/cron/build-features.ts` (300s)
- **DB setup**: `POST /api/journal/init` creates all tables and runs all migrations
- **Sidecar**: Python service deployed separately to Railway (own Dockerfile). Env vars (`DATABENTO_API_KEY`, `DATABASE_URL`, `SENTRY_DSN`, and optionally `THETA_EMAIL` / `THETA_PASSWORD` for the co-resident Theta Data Terminal jar) are in Railway, not Vercel.

## Anthropic Integration

- The analyze endpoint uses a split system prompt: `SYSTEM_PROMPT_PART1` + `SYSTEM_PROMPT_PART2` + `lessonsBlock` (~23K tokens).
- Static prompt parts should use `cache_control: { type: 'ephemeral' }` for Anthropic prompt caching (~90% cost reduction opportunity).
