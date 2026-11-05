# Architecture

System design, project structure, data flow, security, math, and the data pipeline. For features see [FEATURES.md](FEATURES.md); for deployment see [DEPLOYMENT.md](DEPLOYMENT.md).

## Project Structure

File counts are as of 2026-10-29.

```text
├── api/                                  # Vercel Serverless Functions
│   ├── __tests__/                        # 335 test files — endpoints, cron jobs, _lib
│   ├── _lib/                             # 176 shared backend modules (+ validation/, csv-parser/)
│   │   ├── schwab.ts                     # Schwab OAuth token lifecycle (Redis + distributed lock + owner-account check)
│   │   ├── schwab-fetch.ts               # Authenticated Schwab API fetch
│   │   ├── auth-helpers.ts               # Owner cookie gate, bot check, rate limiting, cache headers
│   │   ├── guest-auth.ts                 # Guest-key read access (sc-guest cookie)
│   │   ├── secret-compare.ts             # secretEquals / bearerMatches (constant-time compares)
│   │   ├── request-scope.ts              # withRequestScope / withDbReader endpoint wrappers
│   │   ├── api-helpers.ts                # Barrel: auth-helpers, uw-fetch, cron-helpers, schwab-fetch
│   │   ├── cron-helpers.ts               # cronGuard (method + CRON_SECRET + time window)
│   │   ├── cron-instrumentation.ts       # withCronInstrumentation (Sentry + Axiom per run)
│   │   ├── axiom.ts                      # reportCronRun → Axiom cron-runs dataset (axiom-fields.ts allowlist)
│   │   ├── uw-fetch.ts                   # Unusual Whales REST client (retry, rate budget, concurrency cap)
│   │   ├── gexbot-client.ts              # GEXBot API client
│   │   ├── redis.ts                      # Upstash Redis singleton
│   │   ├── db.ts                         # Neon Postgres: getDb(), initDb() + migrateDb()
│   │   ├── db-migrations.ts              # Numbered migrations (see Database Schema)
│   │   ├── db-analyses.ts                # Analysis CRUD
│   │   ├── db-flow.ts                    # Flow data queries + formatters
│   │   ├── db-snapshots.ts               # Snapshot persistence
│   │   ├── db-positions.ts               # Position CRUD
│   │   ├── dark-pool-query.ts            # Dark pool levels from dark_pool_prints (uw-stream)
│   │   ├── db-oi-change.ts               # OI change tracking
│   │   ├── db-strike-helpers.ts          # Per-strike exposure queries
│   │   ├── db-nope.ts                    # SPY NOPE time series
│   │   ├── analyze-prompts.ts            # Static Anthropic prompt text
│   │   ├── analyze-context.ts            # Orchestrator — wires fetchers + assembles template
│   │   ├── analyze-context-fetchers.ts   # 19 per-data-source fetchers
│   │   ├── analyze-context-formatters.ts # Pure `format*` helpers (tests target these)
│   │   ├── analyze-context-helpers.ts    # numOrUndef, parseEntryTimeAsUtc + shared types
│   │   ├── analyze-calibration.ts        # Mode-specific example outputs
│   │   ├── anthropic-call.ts             # runCachedAnthropicCall (streaming, cache blocks, Opus → Sonnet fallback)
│   │   ├── build-features-*.ts           # ML feature stages: flow, gex, phase2, monitor, nope, labels, upsert, types
│   │   ├── plot-analysis-*.ts            # ML plot analysis (3 files)
│   │   ├── embeddings.ts                 # OpenAI text-embedding-3-large (2000-dim) + vector search
│   │   ├── lessons.ts                    # Lessons CRUD + curation logic
│   │   ├── darkpool.ts                   # Unusual Whales SPY dark pool fetcher (called at analysis time)
│   │   ├── max-pain.ts                   # Max pain from all SPX expirations
│   │   ├── overnight-gap.ts              # ES overnight gap analysis
│   │   ├── spx-candles.ts                # 1-min SPX candles (index_candles_1m first, UW live fallback)
│   │   ├── futures-context.ts            # Futures + VIX term-structure block for analyze
│   │   ├── anchor-legs.ts                # Spread-leg detection from the exchange multi-leg trade code on the anchor print
│   │   ├── archive-sidecar.ts            # Client for the sidecar's /archive/* routes
│   │   ├── takeit-score.ts               # Take-It XGBoost scoring in TypeScript
│   │   ├── csv-parser.ts                 # thinkorswim CSV export parser (+ csv-parser/)
│   │   ├── validation.ts                 # Barrel over validation/*.ts (Zod request schemas)
│   │   ├── logger.ts                     # Structured JSON logger (pino)
│   │   ├── sentry.ts                     # Sentry server-side init + metrics wrappers
│   │   ├── env.ts                        # Centralized env access (requireEnv / optionalEnv)
│   │   └── constants.ts                  # Timeouts, market time boundaries
│   ├── auth/                             # Schwab OAuth (init, callback) + guest-key, guest-logout, schwab-status, whoami
│   ├── journal/                          # init (tables + migrations), migrate (pending migrations), status, backfill-features
│   ├── cron/                             # Scheduled jobs (see Intraday Data Collection)
│   ├── ml/                               # ML export, plots, plot image, plot analysis, prediction
│   ├── futures/                          # Futures snapshot endpoint
│   ├── gamma-setups/                     # Gamma setup feed, export, weekly stats
│   ├── push/                             # Web Push subscribe / unsubscribe / notify (uw-stream → notify)
│   ├── tracker/                          # Contract tracker + alerts
│   ├── analyze.ts                        # POST → Claude Opus 4.7 chart analysis (Sonnet 4.6 fallback)
│   ├── analyses.ts                       # GET → browse past analyses
│   ├── chain.ts                          # GET → live option chain
│   ├── events.ts                         # GET → economic calendar
│   ├── history.ts                        # GET → historical candles
│   ├── intraday.ts                       # GET → today's OHLC + opening range
│   ├── journal.ts                        # GET → query saved analyses
│   ├── positions.ts                      # GET/POST → live/CSV positions (Zod-validated)
│   ├── quotes.ts                         # GET → real-time quotes
│   ├── snapshot.ts                       # POST → save market snapshot
│   ├── health.ts                         # GET → service health check
│   ├── alerts.ts                         # GET → active alerts
│   ├── alerts-ack.ts                     # POST → acknowledge alerts (Zod-validated)
│   ├── bwb-anchor.ts                     # GET → BWB gamma anchor
│   ├── darkpool-levels.ts                # GET → dark pool S/R levels
│   ├── gex-target-history.ts             # GET → GEX target scoring history
│   ├── iv-term-structure.ts              # GET → vol term structure
│   ├── movers.ts                         # GET → market movers
│   ├── pre-market.ts                     # GET/POST → pre-market data
│   ├── vix-ohlc.ts                       # GET → VIX OHLC from snapshots
│   ├── yesterday.ts                      # GET → prior day SPX OHLC
│   └── …                                 # More feature endpoints (periscope-*, lottery-*, silent-boom-*, gex-*, greek-*, panel-prefs, …)
├── src/                                  # React 19 SPA
│   ├── __tests__/                        # 313 unit test files (341 across src/): components, hooks, utils, data
│   │   └── setup.ts                      # Vitest setup (jsdom, mocks)
│   ├── components/                       # 240 TSX component files, grouped by feature folder
│   ├── hooks/                            # 85 custom React hooks
│   ├── utils/                            # 46 pure calculation modules + export/, gex-target/, hedge/
│   ├── lib/                              # Response guard, Sentry helpers, service-worker update prompt
│   ├── types/                            # Shared TypeScript types
│   ├── data/                             # Market calendar (holidays, early closes), VIX range stats, flow-regime baseline
│   ├── constants/                        # App-wide constants
│   ├── themes/                           # Theme definitions
│   ├── App.tsx                           # Root component
│   ├── main.tsx                          # React entry point + Sentry + BotID init
│   └── sw.ts                             # PWA service worker
├── ml/                                   # Python ML pipeline (see ml/README.md)
├── sidecar/                              # SHAP + frozen archive sidecar (see sidecar/README.md)
├── uw-stream/                            # UW websocket consumer (see uw-stream/README.md)
├── scripts/                              # Backfill + utility scripts (see scripts/README.md)
├── e2e/                                  # 43 Playwright E2E specs (see e2e/README.md)
├── docs/                                 # Design documents + superpowers specs (see docs/INDEX.md)
├── public/
│   ├── vix-data.json                     # VIX daily OHLC, 1990-01-02 → 2026-03-06 (static snapshot)
│   └── vix1d-daily.json                  # VIX1D daily, 2022-05-13 → 2026-04-10 (fallback; live data via /api/vix1d-daily)
├── .github/workflows/                    # CI, nightly E2E, ML pipeline + Take-It retrain (disabled since 2026-04-17), Neon PR branches
├── vercel.json                           # Crons, security headers, CSP, rewrites, ignoreCommand
├── vite.config.ts                        # Vite + Vitest + PWA + bundle analysis
├── .env.example                          # Environment variable template
└── .nvmrc                                # Node 24 version pin
```

For the per-folder breakdown of `src/components/` and `src/utils/`, see the folder names directly — they mirror the feature taxonomy in [FEATURES.md](FEATURES.md).

## Architecture Data Flow

```text
                    ┌─── Schwab API (owner or guest; positions owner-only) ──────┐
                    │  /api/quotes → SPY, SPX, VIX, VIX1D, VIX9D, VVIX           │
                    │  /api/intraday → today OHLC + opening range                │
                    │  /api/yesterday → prior 5 days SPX OHLC                    │
                    │  /api/chain → live 0DTE option chain deltas                │
                    │  /api/history → historical 5-min candles                   │
                    │  /api/positions → live SPX 0DTE positions (owner)          │
                    └──────────────────┬─────────────────────────────────────────┘
                                       │ (auto-populate)
                    ┌─── Vercel crons: Unusual Whales REST + GEXBot ─────────────┐
                    │  ~30 UW crons → flow_data, greek_exposure,                 │
                    │    spot_exposures, strike_exposures, oi_*, vol_*, …        │
                    │  GEXBot crons → gexbot_snapshots, gexbot_api_capture,      │
                    │    periscope_snapshots                                     │
                    └──────────────────┬─────────────────────────────────────────┘
                                       │
                    ┌─── Railway: uw-stream (UW websocket → Neon) ───────────────┐
                    │  flow-alerts            → ws_flow_alerts                   │
                    │  option_trades:<T>      → ws_option_trades                 │
                    │    SPY/SPXW/QQQ B/A     → interval_ba_alerts               │
                    │                           → POST /api/push/notify          │
                    │  off_lit_trades         → dark_pool_prints                 │
                    │  futures_trades         → futures_bars (ES NQ RTY CL       │
                    │                           GC ZN); the backfill-futures-    │
                    │                           gaps cron repairs holes from     │
                    │                           UW REST candles                  │
                    │  gex_strike_expiry:<T>  → ws_gex_strike_expiry             │
                    │  net_flow:<T>           → ws_net_flow_per_ticker           │
                    │  (WS_CHANNELS on Railway picks which handlers run)         │
                    └──────────────────┬─────────────────────────────────────────┘
                                       ▼
SPY + VIX + Time ──→ useCalculation() ──→ results (strikes, premiums, ICs, BWBs)
                                            │
            useComputedSignals() ◄──────────┤ ← VIX, spot, T, skew, clusterMult
                    │                       │
                    ├──→ useSnapshotSave() ──→ POST /api/snapshot ──→ Neon Postgres
                    │                       │
                    ├──→ ChartAnalysis ──→ GET /api/positions ──→ Schwab Trader API
                    │        context      │
                    │                     └──→ POST /api/analyze ──→ Claude Opus 4.7
                    │                              │             (Sonnet 4.6 fallback)
                    │                              ├─── lessons injection ←── lessons table
                    │                              ├─── flow/GEX/candles ←── market data tables
                    │                              └─── save analysis ───→ Neon Postgres
                    │
                    ├──→ Display components (DeltaRegimeGuide, OpeningRangeCheck, etc.)
                    │
                    └──→ MLInsights ──→ GET /api/ml/* ──→ Vercel Blob plots + findings

                    ┌─── Nightly ────────────────────────────────────────────────┐
                    │  build-features cron → training_features + day_labels      │
                    │  embed-yesterday cron → day_embeddings (OpenAI)            │
                    │  GH Actions ml-pipeline (disabled since 2026-04-17):       │
                    │    ml/ scripts → plots → Blob → Claude vision →            │
                    │    findings.json; takeit-retrain → model bundles           │
                    └────────────────────────────────────────────────────────────┘

                    ┌─── Railway: sidecar ───────────────────────────────────────┐
                    │  takeit-fill-shap cron → sidecar /takeit/explain           │
                    │  embed-yesterday → sidecar /archive/* (DuckDB archive      │
                    │    frozen at 2026-04-17; Postgres fallback after)          │
                    └────────────────────────────────────────────────────────────┘

                    ┌─── Historical Data ────────────────────────────────────────┐
                    │  useHistoryData() → candles                                │
                    │  useVix1dData() → /api/vix1d-daily (CBOE VIX1D)            │
                    │  Built-in VIX OHLC (1990 → 2026-03-06)                     │
                    └──────────────────┬─────────────────────────────────────────┘
                                       │ (backtesting)
                                       ▼
                    Same pipeline as live, with historySnapshot
                    replacing live quotes. is_backtest = true.
```

## Key Design Patterns

- **`useComputedSignals`**: Single hook that computes ALL derived signals (regime zone, DOW multipliers, delta ceilings, range thresholds, opening range, term structure + curve shape including hump detection, directional cluster multipliers with post-2020 weights, 5-day rolling Parkinson RV/IV ratio, price context, events). Feeds display components, Claude analysis context, and database writer from one source of truth. It composes three sub-hooks: `useRegimeClassification`, `useTermStructure` and `useRangeAnalysis`.
- **Backtest isolation**: When `historySnapshot` exists, all volatility values (VIX1D, VIX9D, VVIX) come from historical data, never from live quotes. Prevents data contamination.
- **Fire-and-forget snapshots**: `useSnapshotSave` sends snapshots via fetch with error-caught promises. UI never blocks on DB writes. Deduplication via `savedRef` + DB UNIQUE constraint.
- **Awaited analysis saves**: `/api/analyze` streams NDJSON, with keepalive pings while Claude runs. The analysis is saved with `await` before the final line is written and `res.end()` is called, because Vercel ends the function once the response finishes.
- **Reader endpoints**: GET data readers wrap their handler in `withDbReader(path, label, auth, handler)` ([api/\_lib/request-scope.ts](../api/_lib/request-scope.ts)). The wrapper owns the Sentry scope, request metrics, the 405 method check, the auth guard (`auth` is required: `'owner'`, `'owner-or-guest'` or `'public'`) and the transient-Neon 503 / genuine-error 500 split.
- **Polling gates**: All data-fetching hooks gate refresh on `marketOpen` — no unconditional polling during closed hours.

---

## Live Market Data API

Core endpoints only. As of 2026-10-29, `api/` holds 92 endpoint files outside `_lib/`, `cron/` and `__tests__/`.

| Endpoint                     | Source                                                              | Returns                                     | Cache (market)        | Cache (closed)                            |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | --------------------- | ----------------------------------------- |
| `GET /api/quotes`            | Schwab (`getQuotes`)                                                | Real-time SPY, SPX, VIX, VIX1D, VIX9D, VVIX | 60s                   | 5 min                                     |
| `GET /api/intraday`          | Schwab (`priceHistory`, 5-min)                                      | Today's OHLC + 30-min opening range         | 2 min                 | 10 min                                    |
| `GET /api/yesterday`         | Schwab (`priceHistory`, daily)                                      | Prior 5 days SPX OHLC for rolling RV        | 1 hour                | 1 day                                     |
| `GET /api/chain`             | Schwab (`chains`, 0DTE)                                             | Live option chain with per-strike deltas    | 30s                   | 5 min                                     |
| `GET /api/history`           | Schwab (`priceHistory`, 5-min SPX/VIX/VIX1D/VIX9D/VVIX)             | Historical candles for backtesting          | 120s (today/partial)  | 1 day browser + 90 days Redis (past days) |
| `GET /api/movers`            | Schwab (`movers`)                                                   | Market movers                               | 2 min                 | 10 min                                    |
| `GET/POST /api/positions`    | Schwab Trader API / CSV upload                                      | Live SPX 0DTE positions + spreads           | —                     | —                                         |
| `GET /api/events`            | FRED + Finnhub                                                      | Economic calendar events                    | 5 min edge + 7d Redis | 5 min edge + 7d Redis                     |
| `GET /api/darkpool-levels`   | Neon `dark_pool_prints` (uw-stream)                                 | Dark pool support/resistance                | no-store (polled 60s) | no-store                                  |
| `GET /api/iv-term-structure` | Unusual Whales                                                      | Volatility term structure                   | 5 min                 | 5 min                                     |
| `GET /api/bwb-anchor`        | Neon `strike_exposures` (0DTE + 1DTE gamma, charm-adjusted)         | BWB gamma anchor level                      | 30–60s                | 30–60s                                    |
| `POST /api/analyze`          | Anthropic Messages API                                              | Claude chart analysis (NDJSON stream)       | —                     | —                                         |
| `GET /api/analyses`          | Neon Postgres                                                       | Browse past analyses                        | —                     | —                                         |
| `POST /api/snapshot`         | Neon Postgres                                                       | Save market snapshot                        | —                     | —                                         |
| `GET /api/journal`           | Neon Postgres                                                       | Query saved analyses                        | —                     | —                                         |
| `GET /api/journal/status`    | Neon Postgres                                                       | DB connection + table counts                | —                     | —                                         |
| `POST /api/journal/init`     | Neon Postgres                                                       | Create tables + run migrations              | —                     | —                                         |
| `POST /api/journal/migrate`  | Neon Postgres                                                       | Apply pending numbered migrations           | —                     | —                                         |
| `GET /api/health`            | Postgres + Redis + Schwab                                           | Service health check                        | —                     | —                                         |
| `GET /api/alerts`            | Neon Postgres                                                       | Active market alerts                        | —                     | —                                         |
| `POST /api/alerts-ack`       | Neon Postgres                                                       | Acknowledge alerts                          | —                     | —                                         |
| `GET/POST /api/pre-market`   | Neon (`auto-prefill-premarket` cron from `futures_bars`, or manual) | ES overnight Globex H/L/C/VWAP              | 2 min                 | 2 min                                     |
| `GET /api/vix-ohlc`          | Neon Postgres                                                       | VIX OHLC from snapshots                     | 1 hour                | 1 hour                                    |

`/api/history` caches by date rather than market state: today, or a day with a failed symbol, gets 120s; a complete past day is kept 90 days in Redis and 1 day in the browser.

### Access Levels

Every endpoint has one of three access levels:

- **Owner**: the HttpOnly `sc-owner` cookie, set by the Schwab OAuth callback. Required for every client-initiated write, for `/api/analyze` (it spends Anthropic budget) and for `/api/positions`.
- **Owner or guest**: the owner cookie, or an HttpOnly `sc-guest` cookie holding one of the comma-separated keys in `GUEST_ACCESS_KEYS`. Read endpoints use this level, including everything that carries Unusual Whales or GEXBot data. A guest's only write is its own panel layout (`/api/panel-prefs`).
- **Public**: no cookie. Used only for data that doesn't come from Unusual Whales or GEXBot.

Visitors without a cookie still get the full calculator with manual input.

Handlers enforce the level with `guardOwnerEndpoint` ([api/\_lib/auth-helpers.ts](../api/_lib/auth-helpers.ts)), `guardOwnerOrGuestEndpoint` ([api/\_lib/guest-auth.ts](../api/_lib/guest-auth.ts)), or `withDbReader(path, label, auth, handler)` ([api/\_lib/request-scope.ts](../api/_lib/request-scope.ts)), whose `auth` argument is required. Both guards run the bot check first. Cron routes check `CRON_SECRET` with `bearerMatches`.

**Data-licensing rule:** Schwab data may be served to anyone. Data from Unusual Whales or GEXBot, including values computed from it, requires owner or guest auth. The one exception, by owner decision, is the ML research plot carousel, which serves aggregate test results and plots rather than market data.

### Authentication Flow

1. Owner visits `/api/auth/init`. It stores a one-time OAuth `state` nonce in Redis (10-minute TTL) and redirects to the Schwab login.
2. After login, Schwab redirects to `/api/auth/callback`. The callback consumes the `state` nonce with one atomic `GETDEL` and exchanges the code for tokens. It stores them in Upstash Redis only if the login owns the account whose SHA-256 is `OWNER_SCHWAB_ACCOUNT_SHA256`; any other login gets a 403, nothing is stored and no cookie is set. On success it sets the owner cookie.
3. Access tokens last 30 minutes and are refreshed automatically with the refresh token.
4. The refresh token expires 7 days after the original login (refreshing doesn't extend it), so the owner re-authenticates weekly.

**Token management:** A Redis lock (`SET NX`, 60-second TTL, fenced release) serializes token refreshes across parallel serverless invocations, and the refreshed record is written by compare-and-set so a re-login during a refresh isn't overwritten. An in-memory fallback cache covers Redis blips within one invocation.

### Token Storage

Upstash Redis (via Vercel Marketplace). REST-based client, serverless-compatible.

---

## Security

### Headers (vercel.json)

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=()`
- `X-XSS-Protection: 0` (the legacy filter is disabled; the CSP does the work)
- `Content-Security-Policy`: `default-src 'self'`, `object-src 'none'`, `script-src` limited to self + Vercel Analytics + Sentry CDN + Vercel toolbar, `connect-src` limited to self + Vercel Analytics + Sentry ingest + Google Fonts + Vercel toolbar (Schwab is called only server-side), `frame-ancestors 'self'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`

### Authentication

- Owner cookie (`sc-owner`): HttpOnly, Secure, SameSite=Strict, 7-day expiry, compared in constant time (`secretEquals`) against `OWNER_SECRET`
- Guest cookie (`sc-guest`): HttpOnly, Secure, SameSite=Strict, 30-day expiry, checked in constant time against each key in `GUEST_ACCESS_KEYS`
- Hint cookies: non-HttpOnly `sc-hint=1` and `sc-guest-hint` let the UI decide which controls to render; the server never reads them for authorization
- Secret comparison: `secretEquals` / `bearerMatches` ([api/\_lib/secret-compare.ts](../api/_lib/secret-compare.ts)) hash both sides with SHA-256 and compare them with `timingSafeEqual`; an empty or missing value never matches
- Endpoints call `guardOwnerEndpoint` / `guardOwnerOrGuestEndpoint` (bot check, then 401 without a valid cookie) or declare `auth` in `withDbReader`; see [Access Levels](#access-levels)
- All API keys (Schwab, Anthropic, Postgres) are server-side only, never in client bundle
- Bot protection: `botid` checks on production endpoints, skipped in local dev. New endpoints must be added to the `protect` array in [src/main.tsx](../src/main.tsx).

### Rate Limiting

These endpoints are rate-limited per client IP via Upstash Redis:

| Endpoint              | Limit  | Purpose                           |
| --------------------- | ------ | --------------------------------- |
| `/api/analyze`        | 3/min  | Anthropic cost control            |
| `/api/analyses`       | 30/min | Browse endpoint                   |
| `/api/positions`      | 20/min | Auto-fetched before each analysis |
| `/api/snapshot`       | 30/min | Generous for normal use           |
| `/api/journal`        | 20/min | Query endpoint                    |
| `/api/auth/init`      | 5/min  | OAuth flow protection             |
| `/api/auth/callback`  | 5/min  | OAuth flow protection             |
| `/api/auth/guest-key` | 5/min  | Guest-key guessing protection     |

### Input Validation

- Image payload: `/api/analyze` accepts 1–2 images (≤5 MB base64 each; JPEG, PNG, GIF or WebP) and caps its context object at 200 keys and 8,000 characters per string; Periscope chat accepts up to 3 images (≤10 MB each). All validated by Zod.
- Anthropic errors: Sanitized to generic messages, full details logged server-side only
- DB errors: Sanitized (a transient Neon blip returns 503, anything else 500), never expose connection details to client
- SQL injection: Neon tagged templates bind every interpolated value as a parameter; SQL built at runtime goes through `sql.query(text, params)`
- All request bodies: Validated via Zod schemas in `api/_lib/validation/*.ts` (re-exported from `api/_lib/validation.ts`) at system boundaries

---

## The Math

### Strike Calculation Formula

For a delta target D, from `calcStrikes` in `src/utils/strikes.ts`:

```text
z      = DELTA_Z_SCORES[D] ≈ N⁻¹(1 − D/100)        # 5Δ 1.645, 8Δ 1.405, 10Δ 1.28, 12Δ 1.175, 15Δ 1.036, 20Δ 0.842
K_put  = S × e^(−z × σ_put  × √T + σ_put²/2  × T)   # drift correction pulls the put toward spot
K_call = S × e^(+z × σ_call × √T − σ_call²/2 × T)   # and the call toward spot
```

Where S = SPX spot, T = hours remaining ÷ 1638 (6.5 × 252), r = 0. Each strike is rounded, then snapped to the 5-point grid (`DEFAULTS.STRIKE_INCREMENT`).

Skew model (convex put, dampened call), with z_ref = 1.28 (the 10Δ z-score):

```text
σ_put  = σ × (1 + skew × (z / z_ref)^1.35)     # convex: far OTM puts get disproportionately more IV
σ_call = σ × (1 − skew × (z / z_ref) × dampen)  # dampened: call skew flattens further OTM
dampen = 1 / (1 + 0.5 × max(0, z/z_ref − 1))
```

The 1.35 and 0.5 are `DEFAULTS.SKEW_PUT_CONVEXITY` and `DEFAULTS.SKEW_CALL_DAMPENING` in `src/constants/index.ts`. When a separate call-skew input is set, it replaces `skew` on the call side.

IV acceleration (applied to premiums and Greeks, not to strike placement or PoP), from `calcIVAcceleration` in `src/utils/black-scholes.ts`:

```text
mult        = min(1.8, 1 + 0.6 × (1/hours_remaining − 1/6.5))   # 1 at ≥ 6.5 h left, 1.8 at 0 h
σ_effective = σ × mult
```

### Option Pricing (Black-Scholes)

```text
d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

Call = S·N(d1) − K·N(d2)
Put  = K·N(−d2) − S·N(−d1)
```

CDF implemented via Abramowitz & Stegun 26.2.17 rational approximation (error < 7.5 × 10⁻⁸). Put delta is reported as |Δ| = N(−d1).

### Iron Condor P&L

From `buildIronCondor` and `adjustICPoPForKurtosis` in `src/utils/iron-condor.ts`:

```text
Credit      = (short_put − long_put) + (short_call − long_call)
Put credit  = short_put − long_put
Call credit = short_call − long_call
Max Loss    = max(0, wing_width − credit)
BE Low      = short_put − put_credit     # per-side credit, not total
BE High     = short_call + call_credit   # per-side credit, not total
PoP         = P(S_T > BE_low) + P(S_T < BE_high) − 1   # put σ for BE_low, call σ for BE_high

Fat-tail adjustment (asymmetric, VIX-regime-dependent via getKurtosisFactor):
  VIX < 15:   crash 1.8, rally 1.2      VIX 15–20: crash 2.5, rally 1.5
  VIX 20–25:  crash 3.0, rally 2.0      VIX 25–30: crash 3.5, rally 2.5
  VIX 30+:    crash 4.0, rally 3.0      no VIX:    crash 2.5, rally 1.5
  P_adj(breach_low)  = min(1, P(S_T < BE_low)  × crash)   # put side
  P_adj(breach_high) = min(1, P(S_T > BE_high) × rally)   # call side
  PoP_adjusted       = clamp(1 − P_adj(breach_low) − P_adj(breach_high), 0, 1)
```

PoP uses the base σ (no IV acceleration), so it measures the full-session settlement probability. Degenerate inputs (T ≤ 0, σ ≤ 0, a non-positive breakeven) return 0 rather than NaN.

### Delta Guide — Range-to-Delta Mapping

From `useRegimeClassification` in `src/hooks/useRegimeClassification.ts`. The thresholds come from `estimateRange(vix)` (90th-percentile open→close % and high−low %), scaled by the DOW multiplier × the clustering multiplier.

```text
For each threshold (p90 open→close % → IC ceiling; p90 high−low % → moderate delta):
1. putStrike = spot × (1 − threshold/100);  callStrike = spot × (1 + threshold/100)
2. z ≈ (threshold/100) / (σ × √T), capped at 3
3. putSigma  = σ × (1 + skew × (z/1.28)^1.35)        # same convex put skew as strikes
   callSigma = σ × (1 − skew × (z/1.28) × dampen)    # same dampened call skew
4. putDelta = N(−d1), callDelta = N(d1) from BS(spot, strike, sideSigma, T)
5. ceiling = floor(min(putDelta, callDelta) × 100)
   conservative = max(1, floor(0.6 × IC ceiling))
```

The open→close pass also gives the per-side spread ceilings, `floor(putDelta × 100)` and `floor(callDelta × 100)`. σ is always VIX × 1.15 / 100 (`DEFAULTS.IV_PREMIUM_FACTOR`), independent of IV mode.

### Time-to-Expiry

```text
T = hours_remaining / (6.5 × 252)
```

Early close days use reduced hours (e.g., 3.5 hours on day-before-holiday sessions, which close at 1:00 PM ET).

---

## Observability

### Structured Logging

All API routes use [pino](https://github.com/pinojs/pino) for structured JSON logging. Each log entry includes severity level, timestamp, and contextual fields (error objects, request metadata, usage metrics). Logs are searchable and filterable in Vercel function logs.

For local development with human-readable output, pipe through `pino-pretty`, or run `npm run dev:full`, which does this for you:

```bash
vercel dev 2>&1 | npx pino-pretty
```

### Error Tracking (Sentry)

Client-side errors are automatically captured via `@sentry/react` with browser tracing (20% sample rate, production only). The `ErrorBoundary` component forwards caught errors to Sentry with component stack traces (through `captureUnlessAuth`, which skips 401s). Server-side: `@sentry/node`, with `withRequestScope` / `withDbReader` giving each request its own isolation scope.

### Cron Telemetry (Axiom)

Most crons run inside `withCronInstrumentation` (`api/_lib/cron-instrumentation.ts`), which runs the cron guard, captures errors in Sentry, and sends one event per run to the Axiom `cron-runs` dataset through `reportCronRun` (`api/_lib/axiom.ts`). Only allowlisted names (`api/_lib/axiom-fields.ts`) go out as top-level fields; everything else is JSON-encoded into one `meta` string, queried with `parse_json(meta)`. Reporting is a no-op when `AXIOM_API_KEY` or `AXIOM_DATASET` is unset.

### Performance Analytics

Core Web Vitals (LCP, FID, CLS, TTFB) are reported to the Vercel dashboard via `@vercel/speed-insights`, alongside page view analytics from `@vercel/analytics`.

### Bundle Analysis

Generate an interactive treemap of the production bundle:

```bash
npm run build:analyze    # Opens dist/bundle-stats.html
```

---

## Data Collection & ML Pipeline

### Database Schema

As of 2026-10-29: 200 numbered migrations and about 90 live tables.

**Core Trading Tables:**

| Table              | Purpose                                 | Key Fields                                           | Constraint               |
| ------------------ | --------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `market_snapshots` | Complete calculator state (50+ columns) | Prices, vol surface, regime, strikes JSONB, events   | UNIQUE(date, entry_time) |
| `analyses`         | Claude chart analysis responses         | mode, structure, confidence, delta, full_response    | FK → snapshots           |
| `outcomes`         | End-of-day settlement data              | OHLC, range, close_vs_open, vix_close, vix1d_close   | UNIQUE(date)             |
| `positions`        | Live SPX 0DTE position snapshots        | legs JSONB, net greeks, unrealized P&L               | UNIQUE(date, fetch_time) |
| `lessons`          | Self-improving trading compendium       | text, status, embedding vector(2000), category, tags | UNIQUE(analysis, text)   |
| `lesson_reports`   | Weekly curation changelog               | reviews processed, adds/supersedes/skips, report     | UNIQUE(week_ending)      |

**Market Data Tables (intraday time series):**

| Table              | Purpose                          | Key Fields                               | Granularity     |
| ------------------ | -------------------------------- | ---------------------------------------- | --------------- |
| `flow_data`        | Market Tide & net flow by source | ncp, npp, net_volume, source             | 5-minute        |
| `greek_exposure`   | MM Greek exposure per expiration | gamma, charm, delta, vanna (call/put)    | Daily by expiry |
| `spot_exposures`   | Aggregate GEX per timestamp      | gamma/charm/vanna (oi/vol/dir)           | 1-minute        |
| `strike_exposures` | Per-strike Greek profile         | gamma/charm/delta/vanna by strike+expiry | 5-minute        |

**Live-ingest tables:**

| Table                 | Purpose                                   | Writer                                | Granularity |
| --------------------- | ----------------------------------------- | ------------------------------------- | ----------- |
| `dark_pool_prints`    | Raw dark pool prints                      | uw-stream `off_lit_trades`            | Per print   |
| `ws_flow_alerts`      | UW flow alerts                            | uw-stream `flow-alerts`               | Per alert   |
| `ws_option_trades`    | Option trades for the Lottery universe    | uw-stream `option_trades:<T>`         | Per trade   |
| `futures_bars`        | ES/NQ/RTY/CL/GC/ZN 1-min bars             | uw-stream `futures_trades`            | 1-minute    |
| `index_candles_1m`    | SPX + NDX 1-min candles (SPY/QQQ × ratio) | `fetch-spx-candles-1m` cron           | 1-minute    |
| `gexbot_snapshots`    | GEXBot scalar snapshots                   | `fetch-gexbot-fast` cron              | 1-minute    |
| `periscope_snapshots` | Periscope-style MM GEX by strike          | `populate-periscope-from-gexbot` cron | 10-minute   |
| `flow_ratio_monitor`  | Put/call flow ratio                       | `monitor-flow-ratio` cron             | 1-minute    |

**ML Tables:**

| Table               | Purpose                                   | Key Fields                                             | Granularity       |
| ------------------- | ----------------------------------------- | ------------------------------------------------------ | ----------------- |
| `training_features` | Engineered feature vectors (100+ columns) | Flow checkpoints, GEX, Greeks, dark pool, options      | 1 row/trading day |
| `day_labels`        | ML training labels from review analyses   | structure_correct, flow signals, settlement direction  | 1 row/trading day |
| `economic_events`   | UW economic calendar                      | event_name, event_time, event_type, forecast, previous | Per event         |

### Intraday Data Collection

As of 2026-10-29: 79 cron handlers in `api/cron/` plus `/api/health`, on 87 schedules in `vercel.json` (some jobs have more than one).

Every handler in `api/cron/` checks `CRON_SECRET` (with `bearerMatches`). Most run during market hours (13–21 UTC, Mon–Fri). Dark pool data no longer comes from a cron: uw-stream's `off_lit_trades` handler writes `dark_pool_prints` over the websocket.

**Every 5 minutes (market hours):**

| Cron                    | Source         | Target Table       | Data                           |
| ----------------------- | -------------- | ------------------ | ------------------------------ |
| `fetch-flow`            | Unusual Whales | `flow_data`        | Market Tide (all-in + OTM)     |
| `fetch-net-flow`        | Unusual Whales | `flow_data`        | SPX, SPY, QQQ net flow         |
| `fetch-etf-tide`        | Unusual Whales | `flow_data`        | SPY, QQQ ETF fund flow         |
| `fetch-zero-dte-flow`   | Unusual Whales | `flow_data`        | 0DTE-specific flow             |
| `fetch-greek-flow`      | Unusual Whales | `flow_data`        | SPX 0DTE delta + vega flow     |
| `fetch-greek-exposure`  | Unusual Whales | `greek_exposure`   | Agg + by-expiry Greek exposure |
| `fetch-strike-exposure` | Unusual Whales | `strike_exposures` | Per-strike Greeks (0DTE)       |
| `fetch-strike-all`      | Unusual Whales | `strike_exposures` | All-strike composite data      |

**Every minute (market hours):**

| Cron                           | Source         | Target Table           | Data                               |
| ------------------------------ | -------------- | ---------------------- | ---------------------------------- |
| `fetch-spot-gex`               | Unusual Whales | `spot_exposures`       | Aggregate GEX snapshot             |
| `fetch-gex-0dte`               | Unusual Whales | `gex_strike_0dte`      | Per-strike SPX 0DTE Greek exposure |
| `fetch-gex-strike-expiry-etfs` | Unusual Whales | `ws_gex_strike_expiry` | Per-strike GEX for SPY, QQQ, NDX   |
| `fetch-spx-candles-1m`         | Unusual Whales | `index_candles_1m`     | SPX + NDX candles (via SPY/QQQ)    |
| `fetch-etf-candles-1m`         | Unusual Whales | `etf_candles_1m`       | SPY, QQQ candles                   |
| `fetch-greek-flow-etf`         | Unusual Whales | `vega_flow_etf`        | SPY, QQQ delta + vega flow         |
| `fetch-nope`                   | Unusual Whales | `nope_ticks`           | SPY NOPE                           |
| `fetch-strike-iv`              | Unusual Whales | `strike_iv_snapshots`  | Per-strike implied volatility      |
| `fetch-strike-trade-volume`    | Unusual Whales | `strike_trade_volume`  | Per-strike tape-side volume        |
| `fetch-flow-alerts`            | Unusual Whales | `flow_alerts`          | 0–1 DTE SPXW flow alerts           |
| `monitor-flow-ratio`           | Unusual Whales | `flow_ratio_monitor`   | Put/call flow ratio dynamics       |
| `fetch-market-internals`       | Schwab         | `market_internals`     | $TICK, $ADD, $VOLD, $TRIN bars     |

**Post-close and daily:**

Schedules are UTC, with the ET time in EDT. Jobs that must land at a fixed ET time run on two UTC slots an hour apart, so one of them is on time in both EDT and EST; the other run skips itself or repeats idempotently.

| Cron                          | Schedule (UTC)                                   | Data                                                                                                                 |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `fetch-outcomes`              | 20:25, 21:25 (4:25 PM)                           | SPX OHLC settlement + VIX close                                                                                      |
| `fetch-oi-change`             | 21:30 (5:30 PM)                                  | Open interest changes                                                                                                |
| `fetch-oi-per-strike`         | 14:30 (10:30 AM)                                 | Per-strike OI snapshot                                                                                               |
| `fetch-vol-surface`           | 21:35 (5:35 PM)                                  | IV term structure + realized vol                                                                                     |
| `fetch-economic-calendar`     | 13:25, 14:25 (9:25 AM)                           | UW economic calendar → `economic_events`                                                                             |
| `fetch-greek-exposure-strike` | 13:30, 14:30 (9:30 AM)                           | Per-strike SPX 0DTE Greek exposure → `greek_exposure_strike`                                                         |
| `build-features`              | 20:45, 21:45 (4:45 PM)                           | ML feature engineering (100+ features)                                                                               |
| `fetch-net-flow-history`      | 21:25 (5:25 PM)                                  | Lottery Finder universe per-minute net flow → `net_flow_per_ticker_history`, before `enrich-lottery-outcomes`        |
| `capture-flow-regime-daily`   | 21:55 (5:55 PM)                                  | Fills the flow-regime slots the live cron missed (normally the last, 3:30–4:00 PM)                                   |
| `fetch-futures-session-stats` | Tue–Sat 12:30 (8:30 AM), Mon–Fri 21:30 (5:30 PM) | CME settlement, open interest and session volume, front two contracts of each futures root → `futures_session_stats` |
| `repair-futures-blocks`       | 22:15 (6:15 PM)                                  | Repairs `futures_blocks` from UW REST for blocks the websocket dropped                                               |
| `fetch-day-ohlc`              | Tue–Sat 23:00 (7:00 PM)                          | OHLC + excursions on the prior trading day's `day_embeddings` row                                                    |
| `audit-gexbot-eod`            | 19:45 (3:45 PM)                                  | Alarms when a GEXBot EOD report is missing from `gexbot_eod_reports`, in time for a manual rescue run                |
| `archive-gexbot-eod`          | Daily 02:00, 12:00, 19:00, 23:00                 | GEXBot end-of-day report ZIPs (60 tickers) → private R2, indexed in `gexbot_eod_reports`                             |
| `curate-lessons`              | Sat 03:00                                        | Weekly lessons curation pipeline                                                                                     |
| `backup-tables`               | Sun 05:00                                        | Database backup to Vercel Blob                                                                                       |
| `health`                      | Mon–Fri 13:25 (9:25 AM)                          | Postgres + Redis + Schwab token check                                                                                |

**Other jobs, by group (examples):**

| Group                 | Crons                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEXBot                | `fetch-gexbot-fast`, `fetch-gexbot-strikes`, `populate-periscope-from-gexbot`, `archive-gexbot`, `cleanup-gexbot`, `audit-gexbot-health`                                                                      |
| Lottery / Silent Boom | `detect-lottery-fires`, `detect-silent-boom`, `detect-periscope-call-lottery`, `detect-periscope-put-lottery`, `enrich-*-outcomes`, `refit-lottery-ticker-stats`, `wave2-confirmation`, `evaluate-round-trip` |
| Take-It               | `takeit-fill-shap`, `audit-takeit-calibration`, `audit-takeit-health`                                                                                                                                         |
| Futures / VIX         | `fetch-futures-snapshot`, `backfill-futures-gaps`, `auto-prefill-premarket`, `refresh-vix1d`                                                                                                                  |
| Gamma / cone          | `compute-zero-gamma`, `compute-cone`, `check-cone-breach`, `detect-gamma-setups`, `backfill-gamma-setup-outcomes`, `check-gamma-setup-drift`                                                                  |
| Flow regime / signals | `capture-flow-regime`, `capture-opening-flow-signal`, `capture-regime-0dte`, `monitor-vega-spike`, `enrich-vega-spike-returns`, `refresh-tracker-contracts`                                                   |
| uw-stream upkeep      | `cleanup-ws-option-trades`, `cleanup-ws-gex-strike-expiry`, `rollup-ws-gex-strike-expiry`, `reconcile-greek-flow-etf`                                                                                         |
| Housekeeping          | `embed-yesterday`, `schwab-reauth-reminder`, `audit-migration-drift`, `backup-tables`, `curate-periscope-lessons`                                                                                             |

### ML Pipeline (Python)

A multi-phase ML system that augments the rule-based analyze endpoint with statistical validation, analog-day retrieval, and microstructure signal engineering. Located in `ml/`. Uses its own venv (`ml/.venv`), pyproject, and pytest suite — isolated from the Node app.

**Core (structure / range / divergence) phases:**

| Phase     | Name                      | Status      | Purpose                                                                                     |
| --------- | ------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Phase 0   | Data Infrastructure       | ✅ Complete | 100+ feature columns, daily engineering, feature tracking                                   |
| Phase 1   | Day Type Clustering       | ✅ Complete | K-Means, GMM, hierarchical clustering with PCA                                              |
| Phase 1.5 | Exploratory Data Analysis | ✅ Complete | 9 analysis sections: rule validation, feature importance, flow reliability, dark pool, etc. |
| Phase 2   | Structure Classification  | 🔄 Early    | 5-model comparison (XGBoost, LR, RF, NB, DT) with walk-forward validation                   |

**Analog-retrieval (historical-similar-day) phases:**

- **Phase B — Text-Embedding Day Analogs** ✅ Shipped. OpenAI `text-embedding-3-large` (2000-dim) over sidecar-generated session text; analog search via pgvector. Dates after the archive freeze (2026-04-17) fall back to Postgres-built session text.
- **Phase C — Engineered-Feature Analog Backend** ✅ Shipped. 60-dim numeric feature vector alternative; `DAY_ANALOG_BACKEND` env switches backends.
- **Phase 3a — TBBO DBN → Parquet Converter** ✅ Shipped, since retired. Produced the persistent archive under `year=YYYY/part.parquet`; the DBN converters were removed 2026-09-30 with Databento, so the archive is frozen.
- **Phase 4b — TBBO Archive + 1-Year OFI Percentile** ✅ Shipped, percentile since removed. Archive seeded from Vercel Blob; the live OFI percentile route went with Databento (no live TBBO).
- **Analog Range Forecast — Cohort-Conditional Range + Asymmetric Excursion** ✅ Shipped. Strike-placement hints from 15 text-embedding-nearest historical mornings; replaces the fixed-%-of-spot heuristic.
- **VIX-Regime-Stratified Analog Retrieval** ✅ Shipped. Cohort filtered to same-VIX-bucket mornings; adaptively corrects vol-regime miscalibration on elevated/crisis-VIX days.

**Microstructure (OFI / TBBO / spread) phases:**

- **Phase 4c — Microstructure Feature Engineering** ✅ Shipped. Per-day OFI (Order Flow Imbalance), spread-widening aggregates, volume imbalances from TBBO.
- **Phase 4c1 — MAX-based Spread Aggregator** ✅ Shipped. Switched spread-widening stat from median to max for tail-event sensitivity.
- **Phase 4d — Microstructure EDA + Signal Validation** ✅ Shipped (validated). ES OFI: no signal. **NQ 1h OFI: ρ=0.313, p<0.001, n=312** — a Bonferroni-significant correlate of the same-day NQ return (partly contemporaneous), not a next-day predictor. A point-in-time retest on 2026-10-28 found no predictive signal ([ml/docs/OFI-POINT-IN-TIME-2026-10-28.md](../ml/docs/OFI-POINT-IN-TIME-2026-10-28.md)).
- **Phase 5a — Dual-Symbol Microstructure in Analyze** ❌ Removed 2026-09-30. ES + NQ OFI fed `<microstructure_signals_rules>` in the analyze prompt until Databento (the only TBBO source) was cancelled; a UW `futures_trades` trade-side proxy is open research.
- **Phase 5b — UW Deltas Context** ✅ Shipped. Dark pool velocity, GEX delta, whale net, ETF divergence — all delta-based vs absolute.
- **Phase 5c — tbbo-ofi-percentile Pre-Warm Cron** ❌ Removed 2026-10-01 with the `warm-tbbo-percentile` cron.

**Other phases (accumulating):**

| Phase   | Name                           | Status          | Purpose                                                  |
| ------- | ------------------------------ | --------------- | -------------------------------------------------------- |
| Phase 3 | Charm Divergence Predictor     | 📊 Accumulating | Predict when naive charm chart misleads vs. Periscope    |
| Phase 4 | Intraday Range Regression      | 📊 Accumulating | Predict daily H-L range, beating VIX baseline            |
| Phase 5 | Optimal Exit Timing            | ⏸ Blocked       | Survival analysis — requires timestamped entry/exit data |
| Phase 6 | Flow-Price Divergence Detector | 📊 Accumulating | Automate Rule 10 with learned thresholds                 |

**Source modules (`ml/src/`):**

Core pipeline scripts: `utils/` (package), `eda.py`, `clustering.py`, `phase2_early.py`, `visualize.py`, `backtest.py`, `pin_analysis.py`, `nope_eda.py`, `flow_eda.py`, `calibration.py`, `health.py`, `milestone_check.py`, `explore.py`.

Microstructure pipeline (`ml/src/features/`): OFI feature engineering over the frozen TBBO archive (research only; the DBN → Parquet converters were removed 2026-09-30). Uses DuckDB through its own `_new_connection()`, which forces session `TimeZone = 'UTC'` like the sidecar.

**Feature Engineering Pipeline (`build-features` cron):**

Runs 5 stages after market close:

1. **Flow checkpoints** — NCP/NPP agreement at T1–T8 intervals across 6 sources
2. **GEX features** — Gamma OI/vol/dir at checkpoints, slopes, Greek exposure, per-strike gamma walls + charm slopes
3. **Phase 2 temporal** — Previous day metrics, realized vol, max pain, dark pool, options volume/premium/PCR
4. **Monitor dynamics** — IV crush rate, spike counts, flow ratio trends from minute-level data
5. **NOPE** — SPY NOPE features from `nope_ticks`

The IV inputs to stages 3 and 4 read `iv_monitor`, which no live cron has written since `monitor-iv` was removed.

Output: One row per trading day in `training_features` (100+ columns), then labels from the day's review analysis into `day_labels`.

### Nightly Automation (GitHub Actions)

**Workflow:** `.github/workflows/ml-pipeline.yml`, **disabled in GitHub since 2026-04-17** (re-enable from the Actions tab).

- **Schedule:** 01:45 UTC Tue–Sat (9:45 PM EDT / 8:45 PM EST, after `build-features`)
- **Trigger:** Cron + manual dispatch
- **Job `pipeline`:**
  1. Setup Python 3.13 + Node 24
  2. `make lint`, then `make all` (health → eda → cluster → visualize → early → backtest → pin → nope → flow → calibration)
  3. Upload plots to Vercel Blob (`ml-plots/latest/`, private)
  4. Trigger Claude vision analysis (`POST /api/ml/analyze-plots`)
  5. Commit `findings.json` + plots if changed
- **Job `takeit-retrain`** (after `pipeline`): build the Take-It training set from Neon, train + calibrate, warn if the out-of-fold Brier score is above 0.27, upload model bundles to Blob

---

## Railway Sidecar (SHAP + Archive)

A Python service deployed separately on Railway. It ingests no market data: the Databento subscription was cancelled and its ingestion path (futures OHLCV-1m, ES/NQ TBBO, ES options) was removed on 2026-09-29. Live futures bars now come from the `uw-stream` service's `futures_trades` handler (see [uw-stream/README.md](../uw-stream/README.md)). The co-resident Theta Data Terminal (never run in production) and the `/takeit/multileg-classify` fallback were removed on 2026-10-02. The sidecar runs outside Vercel because it holds model bundles warm and queries GB-scale Parquet on a persistent volume — neither fits a serverless cold-start model.

See [sidecar/README.md](../sidecar/README.md) for the deployment + local-dev path. Architecture summary:

```text
                                  Vercel Blob (archive manifest)
                                    ↓ archive_seeder.py
[sidecar/src/]
  ├─ main.py             — entry point, signal handlers, shutdown
  ├─ takeit_server.py    — Take-It SHAP explainer (/takeit/*)
  ├─ archive_seeder.py   — one-shot pull from Vercel Blob → /data/archive (SHA-resumable)
  ├─ archive_query.py    — DuckDB layer over the frozen Parquet archive
  ├─ front_month.py      — shared front-month-contract CTE builder for archive_query
  ├─ health.py           — /health + /takeit/* + /archive/* + /admin/seed-archive HTTP server
  ├─ db.py               — psycopg2 pool for the /health db check only
  ├─ config.py           — env settings
  ├─ logger_setup.py     — logging setup
  └─ sentry_setup.py     — Sentry init (separate DSN from Vercel side)
  ↓
Railway Volume [/data/archive]
```

**Responsibilities:**

1. **Take-It SHAP** — `/takeit/explain` + `/takeit/health` for the `takeit-fill-shap` cron. Enabled per deployment with `TAKEIT_SERVER_ENABLED=1`.
2. **Frozen archive** — one-shot `POST /admin/seed-archive` pulls the Parquet archive (originally built from Databento) from Vercel Blob into the `/data/archive` Railway volume (SHA-resumable, single-flight-locked). Nothing appends to it any more. DuckDB serves it read-only through thread-local connections capped at 500 MB memory with spill to `/tmp/duckdb`.

Boot requires only `DATABASE_URL`, which now backs nothing but the `/health` db check (the sidecar writes nothing to Neon). The boot-time DB check is non-fatal, so SHAP and `/archive/*` stay up through a Neon outage while `/health` reports 503.

**HTTP endpoints (consumed by Vercel):**

| Endpoint                                            | Returns                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| `GET /health`                                       | Liveness + DB status (`{status, checks: {db}}`)       |
| `GET /takeit/health`, `POST /takeit/explain`        | Take-It SHAP readiness + top-K explanations           |
| `GET /archive/day-summary?date=YYYY-MM-DD`          | Deterministic session text for embedding pipeline     |
| `GET /archive/day-features?date=YYYY-MM-DD`         | 60-dim numeric vector for engineered-analog retrieval |
| `GET /archive/day-summary-batch?from&to`            | Batched summaries for backfill (capped 3 yrs)         |
| `GET /archive/day-features-batch?from&to`           | Batched vectors for backfill                          |
| `GET /archive/day-summary-prediction?date`          | Leakage-free prediction summary (no outcome fields)   |
| `GET /archive/day-summary-prediction-batch?from&to` | Batched leakage-free prediction summaries             |
| `GET /archive/analog-days?date&k`                   | k-nearest historical mornings by window similarity    |
| `GET /archive/es-range?date=YYYY-MM-DD`             | ES day summary from the archive                       |
| `POST /admin/seed-archive`                          | One-shot archive seed trigger                         |

The TBBO microstructure routes (`/archive/tbbo-day-microstructure`, `/archive/tbbo-ofi-percentile`) were removed with Databento, and `POST /takeit/multileg-classify` was removed with the F4 strip; all three now return 404.

**Consumed by the Vercel side via:**

- `api/_lib/archive-sidecar.ts` — typed client for `/archive/day-summary` + `/archive/day-features`
- `api/cron/embed-yesterday.ts` — nightly, pulls yesterday's summary + stores OpenAI text-embedding-3-large (2000-dim) into `day_embeddings` for analog cohort retrieval; falls back to Postgres (`api/_lib/postgres-day-summary.ts`) for dates past the archive freeze
- `api/cron/takeit-fill-shap.ts` — SHAP explanations for Take-It fires

Multi-leg detection is not a sidecar concern either: the `detect-lottery-fires` and `detect-silent-boom` crons read the exchange's multi-leg trade code on the anchor print in `api/_lib/anchor-legs.ts` and store five spread-leg columns (migration 197), which the Lottery Finder and Silent Boom panels show as a "spread leg" badge. The former Railway classifier is retired ([design](superpowers/specs/2026-10-28-classifier-replacement-design.md)).

Futures bars are not a sidecar concern any more: `uw-stream` writes `futures_bars` live, and `api/cron/backfill-futures-gaps.ts` repairs holes daily from UW REST 1-minute candles.
