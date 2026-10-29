# 0DTE SPX Strike Calculator

Single-owner 0DTE SPX options trading tool. Vite + React 19 frontend, Vercel Serverless Functions backend (TypeScript), Python ML scripts, Railway Python services: uw-stream (Unusual Whales websocket ingestion, including futures bars), the sidecar (Take-It SHAP scoring, frozen historical archive) and nightly (cron job that lands the UW Full Tape in R2). Multi-leg trades are flagged from the exchange's own trade code on the anchor print (`api/_lib/anchor-legs.ts`); the Railway multileg classifier is retired.

## Architecture

```text
src/              React 19 SPA (Tailwind CSS 4, no router)
  components/     UI components (feature-grouped folders)
  hooks/          Custom React hooks (useSpotInputs, useTimeInputs, useMarketData, useChainData, etc.)
  utils/          Pure calculation modules (black-scholes, strikes, hedge, iron-condor, pin-risk, etc.)
  types/          Shared TypeScript types
  data/           Static data (market hours, VIX range stats, flow-regime baseline). VIX OHLC lives in
                  public/vix-data.json, which has a cutoff date
  constants/      App-wide constants

api/              Vercel Serverless Functions
  _lib/           Shared modules (see "Backend Modules" below)
  auth/           Schwab OAuth flow (init.ts, callback.ts), guest-key login/logout, whoami, schwab-status
  cron/           Scheduled jobs registered in vercel.json `crons` (market data, features, lessons)
  journal/        DB init/migrate/status + backfill-features (journal CRUD is api/journal.ts)
  ml/             ML plot carousel (plots, plot-image), plot analysis, prediction, export
  futures/        Futures snapshot
  gamma-setups/   Gamma-node setup feeds (active, weekly stats, export)
  push/           Web Push subscribe/unsubscribe/notify
  tracker/        Contract tracker (contracts, alerts)

sidecar/          Railway Python service (NOT Vercel). Ingests no market data (Databento removed 2026-09-29)
  src/            Serves Take-It SHAP (/takeit/explain, /takeit/health) and read-only /archive/* DuckDB
                  queries over the frozen archive on the /data volume. Writes nothing to Neon: DATABASE_URL
                  (psycopg2) backs only the /health db check, and the boot DB check is non-fatal.
                  Theta Data Terminal + /takeit/multileg-classify fallback removed 2026-10-02.
                  Own requirements.txt (runtime) + requirements-dev.txt (test/lint), Dockerfile. Sentry SDK for error tracking
                  vercel.json ignoreCommand skips deploys for sidecar/, uw-stream/, nightly/, ml/, scripts/, pine/, docs/, *.md changes

uw-stream/        UnusualWhales websocket consumer (Python, Railway, NOT Vercel)
                  asyncio + websockets + asyncpg (NOT psycopg2 — different from sidecar). Connector → router →
                  per-channel handler queues → chunked multi-row INSERT ... ON CONFLICT DO NOTHING → Neon. Subscribes to flow-alerts (note hyphen,
                  not flow_alerts), option_trades:<TICKER> for the Lottery Finder universe (86 tickers), and futures_trades.
                  Writes to ws_flow_alerts (api migration #108; also uw-stream/sql/001) and ws_option_trades
                  (api migration #109); cron-fed flow_alerts table is NOT touched and runs in parallel during the soak window.
                  Also has handlers for net_flow → ws_net_flow_per_ticker, gex_strike_expiry → ws_gex_strike_expiry,
                  off_lit_trades → dark_pool_prints and Interval B/A (option_trades SPY/SPXW/QQQ) → interval_ba_alerts.
                  WS_CHANNELS picks the channels, sharded at ≤45 per connection. Holds an Upstash connection lease
                  and pushes alerts to /api/push/notify with INTERNAL_NOTIFY_SECRET.
                  futures_trades → 1-min bars in futures_bars (ES, NQ, RTY, CL, GC, ZN): the only live futures
                  source since 2026-09-29; backfill-futures-gaps cron repairs holes from UW REST candles.
                  No DX, VX, ES options or TBBO/OFI (VIX term structure: VIX/VIX3M).
                  Sentry tagged server_name=uw-stream; UW_API_KEY required (Advanced tier for WS access).
                  Own Dockerfile, README.md, requirements.txt (runtime) + requirements-dev.txt (test/lint), conftest.py — own pytest suite under tests/.

nightly/          Full Tape lander (Python, Railway cron service `nightly`, NOT Vercel). Tue–Sat 07:15 UTC
                  (railway.toml cronSchedule, the morning after each session) it downloads each missing session's UW options Full Tape, converts it
                  to Parquet with polars and uploads one object per day to Cloudflare R2
                  (fulltape/{date}-fulltape.parquet), newest missing day first, up to 30 days of catch-up. Re-lands a
                  recent day whose UW ETag changed, and marks a day unavailable only on UW's own evidence. Runs once
                  and exits: 0 ok, 1 a day did not land, 2 bad config, 3 watchdog. Sentry server_name=nightly plus
                  the `nightly-tape` cron monitor. Writes nothing to Neon. Env: UW_API_KEY, R2_*, SENTRY_DSN.
                  Own Dockerfile, README.md (runbook and alert meanings), requirements.txt + requirements-dev.txt,
                  conftest.py — own pytest suite under tests/. Spec: docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md.

scripts/          Backfill, probe and analysis scripts (backfill-etf-tide.mjs, backfill-greek-exposure.mjs, etc.),
                  plus build/coverage tooling (check-build-output.mjs, check-coverage-floor.mjs, _lib/)

ml/               Python ML pipeline (clustering, EDA, classification, visualization)
  src/            Source modules (utils, clustering, eda, phase2_early, pin_analysis, etc.)
  tests/          Pytest test files (test_clustering, test_phase2, etc.)
  docs/           Phase specs and design docs (ROADMAP.md, PHASE-*.md)
  plots/          Generated plots — tracked in git, do NOT gitignore
  experiments/    JSON experiment results (phase2_early runs)
  .venv/          Python venv — run scripts with `ml/.venv/bin/python` (macOS/Linux) or `ml/.venv/Scripts/python`
                  (Windows), not system python3
  conftest.py     Adds ml/src/ to sys.path for test imports

docs/             Design artifacts
  superpowers/    specs/ and plans/ for feature design documents

e2e/              Playwright specs, including a11y
```

## Commands

```bash
npm run dev          # Vite dev server (frontend only)
npm run dev:full     # Full stack via vercel dev with pino-pretty
npm run build        # build-info + tsc (src, api) + vite build
npm run lint         # type-check (src, api, scripts) && eslint (MUST run after code changes)
npm run review       # full gate (see "Verify" below)
npm run test         # vitest watch mode
npm run test:run     # vitest single run
npm run test:e2e     # playwright
npm run format       # prettier --write
```

## Development Workflow (Get It Right)

Every code change follows this implement-verify-review loop. No exceptions. This applies to the main session and all subagents that write code.

### Execution Mode — Always Subagent-Driven

**Always execute implementation plans via `superpowers:subagent-driven-development` — never inline, and never ask which mode to use.** When the writing-plans handoff (or any skill) offers a "subagent-driven vs inline" choice, silently pick subagent-driven. The main session orchestrates and quality-gates; it does not write the code itself.

The required loop for any multi-task plan:

1. **Decompose** the plan and **dispatch sub-agents**. Run **one implementer stream at a time**: queue the rest and tell the owner the order. Read-only investigators and reviewers can run in parallel (a single message with multiple `Agent` calls).
2. **Load each sub-agent with the skills its task needs** — name them in the prompt (e.g. `react-expert`, `backend-development`, `test-master`, `postgres-pro`, `playwright-expert`) per the task domain.
3. Sub-agents do the work.
4. **The main session reviews** every sub-agent's output (spec compliance, then code quality via the `code-reviewer` agent) **before presenting results.** The user sees reviewed output, not raw sub-agent dumps.

This is a standing, non-negotiable preference. Don't second-guess it or offer alternatives.

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

### Tests Are Mandatory (TDD Preferred)

Every new feature, endpoint, hook, component, cron, or pure utility ships with tests **in the same commit**. No exceptions for "I'll add tests later" — later never comes, and untested code masquerading as shipped code is how silent failures land in production.

**Prefer TDD when feasible.** Write the failing test first, watch it fail, then make it pass. TDD is required when:

- Adding a new endpoint (`api/**/*.ts`) — write the request/response shape test first.
- Adding a new hook (`src/hooks/*.ts`) — write the state-transition test first.
- Adding a new cron handler (`api/cron/*.ts`) — write the auth-guard + happy-path test first.
- Adding a pure utility in `src/utils/` or `api/_lib/` — write the input/output table test first.

TDD is **optional but encouraged** for UI components and refactors. For pure styling/layout work where the behavior under test is "it renders", a single smoke test is fine.

**When tests are not required:**

- `.md` doc edits
- `.json` config tweaks (ESLint, Prettier, Vercel routes that don't add code)
- Comment-only changes
- Strict refactors with zero behavior change AND existing test coverage that exercises the refactored path

If you're unsure whether a change needs a test: it does. The cost of writing one is ~10 minutes; the cost of a silent production regression is much more.

### The Loop

**1. Implement** — Write the failing test first (see "Tests Are Mandatory" above), then the code. Investigate first, understand existing patterns, then make changes.

**2. Verify** — Run `npm run review` (which chains `node scripts/review-gate.mjs clear && npm run type-check` (tsc for src, api and scripts) `&& eslint . && prettier --write && vite build && node scripts/check-build-output.mjs && vitest run --coverage && node scripts/check-coverage-floor.mjs && node scripts/review-gate.mjs seal`). **NEVER report a task as finished without running this full pipeline first.** Running tests on the files you touched is not enough — type errors and lint violations from your changes regularly surface in unrelated files (transitive type narrowing, prettier reformatting, etc.). Fix any failures. If it still fails after 2 fix attempts, proceed to step 3 with the failure details.

**Commit gate:** Claude's commits are gated. `.githooks/pre-commit` blocks a commit whose staged files differ from what the last passing `npm run review` sealed, and names them. The fix is to re-run `npm run review` and commit again. Design: `docs/superpowers/specs/commit-gate-2026-10-28.md`.

- One-time setup per clone: `git config core.hooksPath .githooks`.
- A Claude hook denies `--no-verify`. The owner makes any unreviewed commit from their own terminal, which isn't gated.

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

- **Auth is single-owner + optional guest keys** — one Schwab OAuth session via httpOnly cookie. Plaintext cookie is intentional. The owner can hand out comma-separated guest keys via `GUEST_ACCESS_KEYS`. Guests can read owner-gated data endpoints (dark pool, GEX, TRACE Live, etc.). Every client-initiated write is owner-only (`guardOwnerEndpoint`) except a guest's own panel layout (`api/panel-prefs.ts`, keyed per guest key). The Anthropic-backed `api/analyze.ts` stays owner-only. See `api/_lib/guest-auth.ts` (`rejectIfNotOwnerOrGuest`, `guardOwnerOrGuestEndpoint`) and `src/utils/auth.ts` (`getAccessMode`).
- **Data-licensing rule** — Schwab data may be served to anyone, with no auth. Data from Unusual Whales or GEXBot, including values computed from it, must require owner or guest auth: `guardOwnerOrGuestEndpoint`, or `withDbReader(..., 'owner-or-guest')`. Never serve it from a `'public'` or unguarded endpoint. One exception, by owner decision (2026-10-25): the ML research carousel (`/api/ml/plots`, `/api/ml/plot-image`) stays public. It serves aggregate tests and plots, not market data.
- **Neon Postgres** — `@neondatabase/serverless`, lazy singleton via `getDb()` (HTTP driver, `neon(url)`). Tables managed by numbered migrations in `migrateDb()` (tracked in `schema_migrations`).
- **Upstash Redis** — stores Schwab OAuth tokens (access + refresh). Env vars: `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`.
- **Input validation** — Zod schemas in `api/_lib/validation/` (re-exported by `api/_lib/validation.ts`) validate at system boundaries before data reaches Anthropic or Postgres.
- **Cron jobs** — every job is registered in `vercel.json` `crons` and verifies `CRON_SECRET`. Most market data fetches run every 1–5 min during market hours (13-21 UTC, Mon-Fri).
- **Unusual Whales: websocket over REST (owner rule, 2026-10-28)** — when a UW websocket channel carries the same data as a UW REST endpoint, ingest it in `uw-stream/`. Don't add a polling cron for it, and retire an existing one once the websocket writer is live and checked against it. Why: every cron costs Vercel compute plus its own Sentry and Axiom monitoring, and the websocket is fresher.
  - Exception, gap repair: the websocket has no replay, so a REST job may fill holes after the fact (after the close or on a detected gap, like `api/cron/backfill-futures-gaps.ts`), never on an intraday polling schedule.
  - Exception, no channel: data with no websocket channel stays on REST.
  - Before writing a UW cron, check the channel list at `https://api.unusualwhales.com/docs/websocket.md`. This rule overrules "Tier 3 — DO NOT migrate" in `docs/superpowers/specs/uw-cron-to-websocket-migration-2026-05-02.md`.
- **Bot protection** — `botid` checks on production endpoints, skipped in local dev. **When adding a new endpoint that calls `checkBot(req)`, also add its path to the `protect` array in `src/main.tsx`'s `initBotId()` call.**
- **Logging** — `pino` logger in `api/_lib/logger.ts`.
- **Sentry** — error tracking + metrics via `@sentry/node`.
- **Axiom cron events** — `reportCronRun` (`api/_lib/axiom.ts`) sends `job` plus, as top-level primitives, only the names in `AXIOM_TOP_LEVEL_KEYS` (`api/_lib/axiom-fields.ts`: the 111 top-level columns that already exist in the dataset, snapshot 2026-10-25). It JSON-stringifies every other key, and any non-primitive value, into one `meta` string. The dataset has a 257-column cap and is already at it, so never add top-level keys, and never add a name to the allowlist unless the column already exists in Axiom. Query per-cron fields with `parse_json(meta)`. A rejected ingest (`ingested === 0`) retries without `meta` and raises one Sentry warning per instance.
- **Reader endpoints use `withDbReader`** — a new GET data-reader endpoint (single-JSON response, 405-gated) should wrap its handler in `withDbReader(path, label, auth, handler, opts?)` from `api/_lib/request-scope.ts` instead of hand-rolling the envelope. The wrapper owns the Sentry isolation scope + transaction name + `endpoint` tag, `metrics.request`/`done`, the 405 method check, the auth guard (`auth` is required: `'owner'` | `'owner-or-guest'` | `'public'` — so it can't be forgotten), and the `try/catch → sendDbErrorResponse` soft-degrade (transient Neon blip → 503, genuine → 500 + Sentry). The handler body is just rate-limit/zod-validation/logic + `done({ status: 200 })` + `res.json`. Do NOT adopt it for mixed GET+write handlers, CSV/binary responses, or no-method-gate readers (those keep their own `sendDbErrorResponse` call).

#### Backend Modules (`api/_lib/`)

Key modules beyond the basics:

- `db.ts` — `initDb()` (base tables) + `migrateDb()` (numbered migrations, stored in `api/_lib/db-migrations.ts`). New tables go in `migrateDb()` only, never `initDb()`.
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
- **Custom hooks** — state management via `useTheme`, `useSpotInputs`, `useIvInputs`, `useTimeInputs` and `useStrategyInputs`, data fetching via `useMarketData`, `useChainData`, `useVixData`, etc. Polling hooks gate refresh on `marketOpen` — do not add unconditional polling.
- **Market hours time init** — `useTimeInputs` defaults time to 10:00 AM CT outside market hours to keep `useCalculation` valid. The calculator produces no results if given an out-of-hours time.
- **Pure calculation utils** — `src/utils/` contains Black-Scholes, strike selection, hedge sizing, iron condor P&L, pin risk, and more. These are heavily tested.
- **Sentry** — frontend error tracking via `@sentry/react`.
- **PWA** — service worker via `vite-plugin-pwa` (`injectManifest`, custom `src/sw.ts`). Dynamic `import()` calls must include `.catch()` with a reload prompt for stale-chunk resilience. `src/sw.ts` calls `cleanupOutdatedCaches()`.

### Testing

- **Tests ship with the feature** — see "Tests Are Mandatory (TDD Preferred)" above. Code without tests is not done.
- **Unit tests** — Vitest with `@testing-library/react`. Frontend tests mostly in `src/__tests__/` (some in colocated `__tests__/` folders), backend tests in `api/__tests__/`.
- **E2E tests** — Playwright with `@axe-core/playwright` for accessibility. Specs in `e2e/`. Use semantic selectors (`getByRole`, `getByLabel`, `data-testid`).
- **Coverage** — `npm run test:coverage` for V8 coverage.
- **Coverage floors** — `npm run review` fails when any file drops below the per-file floor (`FLOORS` in `scripts/_lib/coverage-floor.mjs`, checked from `coverage/lcov.info` by `scripts/check-coverage-floor.mjs`) or any folder's aggregate drops below its glob floor (branches + lines per folder in `vite.config.ts` `coverage.thresholds`). Raise them by hand after a test pass lands; never lower one to make a run pass. A folder glob that matches no files passes silently, so `scripts/_lib/coverage-thresholds.test.mjs` fails on one: rename the key when you rename the folder, and update its key counts when you add or remove a folder floor.
- Test files must end in `.test.ts` or `.test.tsx` (unit) or `.spec.ts` (e2e).
- **Cron test pattern** — mock `getDb` via `vi.mocked(getDb)`. Use `mockResolvedValueOnce` in the same sequence as the handler's DB queries. Provide `CRON_SECRET` in `process.env`.

## Code Style

- **Prettier** — 2-space indent, single quotes, trailing commas, 80 char width.
- **ESLint** — typescript-eslint + react-hooks + react-refresh + sonarjs. Config in `eslint.config.ts`.
- Nested ternaries in JSX are allowed (`sonarjs/no-nested-conditional: off`).
- **SonarJS rules to remember**: use `Number.parseFloat`/`Number.parseInt` (not globals), use `.at(-1)` not `[arr.length - 1]`, no nested template literals (extract to variable).
- Run `npm run lint` before reporting any task complete. Lint covers root project only — `sidecar/` and `playwright-report/` are in the ESLint ignores list.
- Use `type` imports for type-only imports (`import type { ... }`).
- **Explicit `.js` extensions in relative imports from `src/` that are imported by `api/`** — any file in `src/` that an `api/*` handler imports (directly or transitively) must use explicit `.js` extensions on all relative imports, e.g. `import { x } from './foo.js'` not `'./foo'`. Vite rewrites extension-less imports for the browser bundle, but Vercel Functions run Node's strict ESM resolver which does not. Failure mode: production Function crashes with `ERR_MODULE_NOT_FOUND` for the extension-less path while local dev + tests still pass. Type-only imports (`import type { ... }`) are erased at compile time and do NOT need `.js`. Examples of server-pulled `src/` files in this repo: `src/utils/timezone.ts`, `src/data/marketHours.ts`, `src/components/LotteryFinder/ct-window.ts`, `src/utils/gex-target/index.ts`, `src/utils/zero-gamma.ts`, `src/utils/black-scholes.ts`. When adding a new `src/` module that `api/` will import, add `.js` to every non-type relative import inside it and inside its transitive deps.

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

### Anti-patterns the reviewer rejects (R1–R7)

Checkable text lives in `.claude/agents/code-reviewer.md` (local-only: `.claude/` is gitignored, so it is not in the public repo); rationale, the 2026-09-08 audit, and the fix plan in `docs/superpowers/specs/llm-antipattern-audit-2026-09-08.md`. Short form:

- **R1** Module-level state in `api/` persists across requests (Fluid Compute). Cap it or evict on write (a read-time TTL is not a bound), drop in-flight markers on rejection. No derived or prop-mirrored `useState`; every subscribing or polling effect returns a cleanup.
- **R2** Secrets compare via `secretEquals` / `bearerMatches`; crypto only from `node:crypto`. No hand-rolled hashing, signing, tokens, or copied compare blocks. A service split carries its auth gate.
- **R3** Mock at the module boundary (`vi.mock`). No `deps` params, factories, or single-implementation interfaces that exist for tests. "So tests can" in a comment is the trigger to look for a double seam.
- **R4** Tests cover failure modes: upstream error, malformed payload, DB reject, each asserting the surfacing by name. A cron whose write fails must not report `success`. Happy-path-only is not tested.
- **R5** Batch data-driven DB writes (~500 rows, `unnest`); no per-row `await` over >50 rows/run. Stream or page anything unbounded; page by rows and bytes. Diff cumulative payloads against a high-water mark.
- **R6** Idempotent writes over locks: `ON CONFLICT` on a source-derived or bucketed key (never `NOW()`), conditional `UPDATE … RETURNING`, or a lease row. Document renew / fail / expire and the TTL arithmetic; fence releases. Client: key ingests on a response-echoed identity and abort superseded fetches.
- **R7** No env var, flag, or constant for one call site unless it is a deploy-free operational knob with a stated reason. New env vars: read in code + `env.ts` + the table below + `.env.example`, same commit.

## Environment Variables

Required env vars (pulled via `vercel env pull .env.local`):

| Variable                                                 | Source                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`                                           | Neon Postgres (Vercel Marketplace)                          |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`                   | Upstash Redis (Vercel Marketplace)                          |
| `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`               | Schwab developer portal                                     |
| `OWNER_SCHWAB_ACCOUNT_SHA256`                            | sha256 of owner's Schwab acct number                        |
| `OWNER_SECRET`                                           | Owner session cookie value                                  |
| `APP_URL`                                                | Public origin (OAuth redirect URI)                          |
| `ANTHROPIC_API_KEY`                                      | Anthropic                                                   |
| `OPENAI_API_KEY`                                         | OpenAI                                                      |
| `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`                        | Sentry                                                      |
| `CRON_SECRET`                                            | Vercel (cron job auth)                                      |
| `UW_API_KEY`                                             | Unusual Whales                                              |
| `GEXBOT_API_KEY`                                         | GEXBot (Orderflow tier key; Periscope + GEXBot crons)       |
| `GUEST_ACCESS_KEYS`                                      | Comma-separated guest keys (opt.)                           |
| `AXIOM_API_KEY`                                          | Axiom (opt.; cron-run events)                               |
| `AXIOM_DATASET`                                          | Axiom dataset name (opt.)                                   |
| `UW_PER_MINUTE_CAP`                                      | UW limiter override (opt., def 2000)                        |
| `SIDECAR_URL`                                            | Railway sidecar (archive queries)                           |
| `SIDECAR_TAKEIT_URL`, `SIDECAR_TAKEIT_SECRET`            | Sidecar SHAP (= `TAKEIT_SIDECAR_SHARED_SECRET`)             |
| `INTERNAL_NOTIFY_SECRET`                                 | uw-stream → `/api/push/notify` (also on Railway)            |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (opt.)                                             |
| `VITE_VAPID_PUBLIC_KEY`, `VITE_SENTRY_DSN`               | Frontend build-time (opt.)                                  |
| `SENTRY_ORG`, `SENTRY_PROJECT`                           | Source-map upload at build (opt.)                           |
| `FRED_API_KEY`, `FINNHUB_API_KEY`                        | Event calendar (opt.)                                       |
| `TWILIO_*`, `ALERT_PHONE_TO`                             | SMS alerts (opt.)                                           |
| `DAY_ANALOG_BACKEND`                                     | Analog-day backend (opt.; `features`, else text embeddings) |
| `LOG_LEVEL`                                              | pino log level (opt.)                                       |
| `WS_CHANNELS`, `VERCEL_NOTIFY_URL`                       | uw-stream (Railway only)                                    |
| `R2_ACCOUNT_ID`                                          | Cloudflare R2 (local tape scripts only; api/ ignores it)    |
| `R2_ACCESS_KEY_ID`                                       | Cloudflare R2 (Railway nightly, local tape scripts)         |
| `R2_SECRET_ACCESS_KEY`                                   | Cloudflare R2 (Railway nightly, local tape scripts)         |
| `R2_ENDPOINT_URL`                                        | Cloudflare R2 (Railway nightly, local tape scripts)         |
| `R2_BUCKET_FULLTAPE`                                     | Cloudflare R2 (Railway nightly, local tape scripts)         |
| `BLOB_READ_WRITE_TOKEN`                                  | Vercel Blob (also on Railway)                               |
| `ARCHIVE_MANIFEST_URL`                                   | Archive manifest (Railway only)                             |
| `ARCHIVE_SEED_TOKEN`                                     | Gates seed POST (Railway only)                              |
| `ARCHIVE_ROOT`                                           | Volume path; default /data/archive                          |
| `RAILWAY_RUN_UID`                                        | `0` on Railway for volume write                             |

Never edit `.env*` files with Claude. Never commit secrets.

The `ARCHIVE_*` and `BLOB_READ_WRITE_TOKEN` vars wire up the frozen
historical archive (Parquet queried by DuckDB, originally built from
Databento and no longer updated) on the Railway sidecar's `/data` volume.
`POST /admin/seed-archive` is a one-shot, SHA-resumable pull from Blob —
see `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.

## Deployment

- **Platform**: Vercel (Fluid Compute, Node 24)
- **Config**: `vercel.json` — crons, security headers, CSP, bot protection rewrites, SPA fallback, `ignoreCommand` skips builds when only `sidecar/`, `uw-stream/`, `nightly/`, `ml/`, `scripts/`, `pine/`, `docs/`, or `*.md` files change
- **Long-running functions**: `api/analyze.ts`, `api/cron/curate-lessons.ts` and `api/cron/curate-periscope-lessons.ts` (780s), `api/cron/backfill-futures-gaps.ts` (800s), and 300s crons such as `api/cron/build-features.ts`. Full list: `vercel.json` `functions`.
- **DB setup**: `POST /api/journal/init` creates all tables and runs all migrations
- **Railway services**: `sidecar/`, `uw-stream/` and `nightly/` (a cron service: `railway.toml` `cronSchedule`, runs once and exits), each with its own Dockerfile, `railway.toml` `watchPatterns` and env vars in Railway, not Vercel. Sidecar env: `DATABASE_URL` (only for its `/health` db check), `SENTRY_DSN`, `TAKEIT_*`, `ARCHIVE_*`. Nightly env: `UW_API_KEY`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`, optional `SENTRY_DSN`.

## Anthropic Integration

- The analyze endpoint's system prompt is one stable block (`SYSTEM_PROMPT_PART1` + `MARKET_MECHANICS_CONTEXT` + `SPOTGAMMA_MECHANICS_CONTEXT` + a per-mode calibration example + `SYSTEM_PROMPT_PART2`), followed by the `lessonsBlock` and similar-analyses blocks.
- The stable block carries `cache_control: { type: 'ephemeral', ttl: '1h' }` for Anthropic prompt caching; the lessons and similar-analyses blocks sit outside the cache boundary.
