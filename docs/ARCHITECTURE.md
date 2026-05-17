# Architecture

System design, project structure, data flow, security, math, and the data pipeline. For features see [FEATURES.md](FEATURES.md); for deployment see [DEPLOYMENT.md](DEPLOYMENT.md).

## Project Structure

```text
├── api/                                  # Vercel Serverless Functions
│   ├── __tests__/                        # 130 test files — endpoints, cron jobs, _lib
│   ├── _lib/                             # 63 shared backend modules
│   │   ├── schwab.ts                     # Schwab OAuth token lifecycle (Redis + distributed lock)
│   │   ├── api-helpers.ts                # Shared fetch, cache, owner-gate, rate limiting, bot check
│   │   ├── db.ts                         # Neon Postgres: initDb() + migrateDb() (77+ migrations)
│   │   ├── db-migrations.ts              # Numbered migration definitions (50+ tables)
│   │   ├── db-analyses.ts                # Analysis CRUD
│   │   ├── db-flow.ts                    # Flow data queries + formatters
│   │   ├── db-snapshots.ts               # Snapshot persistence
│   │   ├── db-positions.ts               # Position CRUD
│   │   ├── db-darkpool.ts                # Dark pool snapshot storage
│   │   ├── db-oi-change.ts               # OI change tracking
│   │   ├── db-strike-helpers.ts          # Per-strike exposure queries
│   │   ├── db-nope.ts                    # SPY NOPE time series
│   │   ├── analyze-prompts.ts            # Static Anthropic prompt text
│   │   ├── analyze-context.ts            # Orchestrator — wires fetchers + assembles template
│   │   ├── analyze-context-fetchers.ts   # 13 focused per-data-source fetchers
│   │   ├── analyze-context-formatters.ts # Pure `format*` helpers (tests target these)
│   │   ├── analyze-context-helpers.ts    # numOrUndef, parseEntryTimeAsUtc + shared types
│   │   ├── analyze-calibration.ts        # Mode-specific example outputs
│   │   ├── build-features-flow.ts        # ML: flow checkpoint features
│   │   ├── build-features-gex.ts         # ML: GEX + Greek exposure features
│   │   ├── build-features-phase2.ts      # ML: prev day, realized vol, dark pool, options
│   │   ├── build-features-monitor.ts     # ML: IV monitor + flow ratio dynamics
│   │   ├── build-features-types.ts       # FeatureRow, featureNum() narrow helper
│   │   ├── plot-analysis-*.ts            # ML plot analysis (3 files)
│   │   ├── embeddings.ts                 # OpenAI text-embedding-3-large + vector search
│   │   ├── lessons.ts                    # Lessons CRUD + curation logic
│   │   ├── darkpool.ts                   # Unusual Whales dark pool fetcher (Sentry visibility)
│   │   ├── max-pain.ts                   # Max pain from all SPX expirations
│   │   ├── overnight-gap.ts              # ES overnight gap analysis
│   │   ├── spx-candles.ts                # 5-min SPX candles via SPY translation
│   │   ├── futures-context.ts            # Reads futures_snapshots w/ Zod row validation
│   │   ├── csv-parser.ts                 # thinkorswim CSV export parser
│   │   ├── validation.ts                 # Zod schemas (all API request bodies + position CSV)
│   │   ├── logger.ts                     # Structured JSON logger (pino)
│   │   ├── sentry.ts                     # Sentry server-side init + metrics wrappers
│   │   ├── env.ts                        # Centralized env access (requireEnv / optionalEnv)
│   │   └── constants.ts                  # Hard-coded values
│   ├── auth/
│   │   ├── init.ts                       # GET → redirect to Schwab login
│   │   └── callback.ts                   # GET → exchange code for tokens
│   ├── journal/
│   │   ├── init.ts                       # POST → create tables + run migrations
│   │   ├── migrate.ts                    # POST → add new columns (idempotent)
│   │   └── status.ts                     # GET → DB connection diagnostics
│   ├── cron/                             # 38 scheduled jobs (39 schedules in vercel.json)
│   ├── ml/                               # ML data export + plot analysis endpoints
│   ├── options-flow/                     # Whale positioning + options flow endpoints
│   ├── market-internals/                 # Breadth indicators (TICK/ADD/VOLD/TRIN)
│   ├── analyze.ts                        # POST → Claude Opus 4.7 chart analysis
│   ├── analyses.ts                       # GET → browse past analyses (public)
│   ├── chain.ts                          # GET → live option chain
│   ├── events.ts                         # GET → economic calendar (public)
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
│   └── yesterday.ts                      # GET → prior day SPX OHLC
├── src/                                  # React 19 SPA
│   ├── __tests__/                        # 161 unit test files (components, hooks, utils, data)
│   │   └── setup.ts                      # Vitest setup (jsdom, mocks)
│   ├── components/                       # 138 TSX component files, grouped by feature folder
│   ├── hooks/                            # 32 custom React hooks
│   ├── utils/                            # ~30 pure calculation modules
│   ├── types/                            # Shared TypeScript types
│   ├── data/                             # Static data (event calendar, VIX range stats)
│   ├── constants/                        # App-wide constants
│   ├── themes/                           # Light/dark theme definitions
│   ├── App.tsx                           # Root component
│   └── main.tsx                          # React entry point + Sentry init
├── ml/                                   # Python ML pipeline (see ml/README.md)
├── sidecar/                              # Databento + Theta sidecar (see sidecar/README.md)
├── uw-stream/                            # UW websocket consumer (see uw-stream/README.md)
├── scripts/                              # Backfill + utility scripts (see scripts/README.md)
├── e2e/                                  # 32 Playwright E2E specs (see e2e/README.md)
├── docs/                                 # Design documents + superpowers specs (see docs/INDEX.md)
├── public/
│   ├── vix-data.json                     # VIX OHLC history (1990–present)
│   └── vix1d-daily.json                  # VIX1D daily history (May 2022–present)
├── .github/workflows/                    # CI, nightly ML pipeline, takeit retrain
├── vercel.json                           # Crons, security headers, CSP, rewrites, ignoreCommand
├── vite.config.ts                        # Vite + Vitest + PWA + bundle analysis
├── .env.example                          # Environment variable template
└── .nvmrc                                # Node 24 version pin
```

For the per-folder breakdown of `src/components/` and `src/utils/`, see the folder names directly — they mirror the feature taxonomy in [FEATURES.md](FEATURES.md).

## Architecture Data Flow

```text
                    ┌─── Schwab API (owner-only) ──────────────────┐
                    │  /api/quotes → SPY,SPX,VIX,VIX1D,VIX9D,VVIX │
                    │  /api/intraday → today OHLC + opening range  │
                    │  /api/yesterday → prior day OHLC             │
                    │  /api/chain → live option chain deltas        │
                    │  /api/history → historical candles            │
                    │  /api/positions → live SPX 0DTE positions     │
                    └──────────────────┬───────────────────────────┘
                                       │ (auto-populate)
                    ┌─── Unusual Whales ──────────────────────────┐
                    │  35 cron jobs → flow, GEX, dark pool, etc.  │
                    │  → flow_data, greek_exposure, spot_exposures │
                    │  → strike_exposures, training_features       │
                    └──────────────────┬───────────────────────────┘
                                       │
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
                    │                              │                      │
                    │                              ├─── lessons injection ←── lessons table
                    │                              ├─── flow/GEX/candles ←── market data tables
                    │                              └─── save analysis ───→ Neon Postgres
                    │
                    ├──→ Display components (DeltaRegimeGuide, OpeningRangeCheck, etc.)
                    │
                    └──→ MLInsights ──→ GET /api/ml/* ──→ Vercel Blob plots + findings

                    ┌─── Nightly Pipeline ─────────────────────────┐
                    │  build-features cron → training_features     │
                    │  GH Actions → ml/ scripts → plots → Blob    │
                    │  Claude vision → findings.json → frontend    │
                    └──────────────────────────────────────────────┘

                    ┌─── Railway Sidecar ─────────────────────────┐
                    │  Databento Live → futures_bars, ES options   │
                    │  Theta Terminal → SPX EOD chains             │
                    │  DuckDB → /archive/* endpoints (analog/OFI)  │
                    └──────────────────────────────────────────────┘

                    ┌─── Historical Data ─────────────┐
                    │  useHistoryData() → candles      │
                    │  useVix1dData() → CBOE VIX1D     │
                    │  Built-in VIX OHLC (1990–2026)   │
                    └──────────────┬───────────────────┘
                                   │ (backtesting)
                                   ▼
                    Same pipeline as live, with historySnapshot
                    replacing live quotes. is_backtest = true.
```

## Key Design Patterns

- **`useComputedSignals`**: Single hook that computes ALL derived signals (regime zone, DOW multipliers, delta ceilings, range thresholds, opening range, term structure + curve shape including hump detection, directional cluster multipliers with post-2020 weights, 5-day rolling Parkinson RV/IV ratio, price context, events). Feeds display components, Claude analysis context, and database writer from one source of truth.
- **Backtest isolation**: When `historySnapshot` exists, all volatility values (VIX1D, VIX9D, VVIX) come from historical data, never from live quotes. Prevents data contamination.
- **Fire-and-forget snapshots**: `useSnapshotSave` sends snapshots via fetch with error-caught promises. UI never blocks on DB writes. Deduplication via `savedRef` + DB UNIQUE constraint.
- **Awaited analysis saves**: Unlike snapshots, analysis saves are `await`ed before `res.json()` because Vercel kills functions after response.
- **Polling gates**: All data-fetching hooks gate refresh on `marketOpen` — no unconditional polling during closed hours.

---

## Live Market Data API

| Endpoint                     | Source                                | Returns                                     | Cache (market) | Cache (closed) |
| ---------------------------- | ------------------------------------- | ------------------------------------------- | -------------- | -------------- |
| `GET /api/quotes`            | Schwab (`getQuotes`)                  | Real-time SPY, SPX, VIX, VIX1D, VIX9D, VVIX | 60s            | 5 min          |
| `GET /api/intraday`          | Schwab (`priceHistory`, 5-min)        | Today's OHLC + 30-min opening range         | 2 min          | 10 min         |
| `GET /api/yesterday`         | Schwab (`priceHistory`, daily)        | Prior 5 days SPX OHLC for rolling RV        | 1 hour         | 1 day          |
| `GET /api/chain`             | Schwab (`chains`, 0DTE)               | Live option chain with per-strike deltas    | 30s            | —              |
| `GET /api/history`           | Schwab (`priceHistory`, multi-symbol) | Historical candles for backtesting          | 1 hour         | 1 day          |
| `GET /api/movers`            | Schwab (`movers`)                     | Market movers                               | 5 min          | 10 min         |
| `GET /api/positions`         | Schwab Trader API                     | Live SPX 0DTE positions + spreads           | —              | —              |
| `GET /api/events`            | FRED + Finnhub                        | Economic calendar events                    | 7d Redis       | 7d Redis       |
| `GET /api/darkpool-levels`   | Unusual Whales                        | Dark pool support/resistance                | 60s            | —              |
| `GET /api/iv-term-structure` | Unusual Whales                        | Volatility term structure                   | —              | —              |
| `GET /api/bwb-anchor`        | Internal (GEX + charm)                | BWB gamma anchor level                      | —              | —              |
| `POST /api/analyze`          | Anthropic Messages API                | Claude chart analysis                       | —              | —              |
| `GET /api/analyses`          | Neon Postgres                         | Browse past analyses (public)               | —              | —              |
| `POST /api/snapshot`         | Neon Postgres                         | Save market snapshot                        | —              | —              |
| `GET /api/journal`           | Neon Postgres                         | Query saved analyses                        | —              | —              |
| `GET /api/journal/status`    | Neon Postgres                         | DB connection + table counts                | —              | —              |
| `POST /api/journal/init`     | Neon Postgres                         | Create tables + run migrations              | —              | —              |
| `POST /api/journal/migrate`  | Neon Postgres                         | Add new columns (idempotent)                | —              | —              |
| `GET /api/health`            | Postgres + Redis + Schwab             | Service health check                        | —              | —              |
| `GET /api/alerts`            | Neon Postgres                         | Active market alerts                        | —              | —              |
| `POST /api/alerts-ack`       | Neon Postgres                         | Acknowledge alerts                          | —              | —              |
| `GET /api/pre-market`        | ES sidecar / manual                   | Overnight gap analysis                      | —              | —              |
| `GET /api/snapshot`          | Neon Postgres                         | Retrieve market snapshot                    | —              | —              |
| `GET /api/vix-ohlc`          | Neon Postgres                         | VIX OHLC from snapshots                     | —              | —              |

### Owner Gating

All data, analysis, and database endpoints are gated behind an HTTP-only session cookie (`sc-owner`) set during the Schwab OAuth flow, except `/api/analyses` (public read-only access to past analyses) and `/api/events` (public economic calendar). Public visitors get the full calculator with manual input. See [api/\_lib/guest-auth.ts](../api/_lib/guest-auth.ts) for the guest-key read-only model.

### Authentication Flow

1. Owner visits `/api/auth/init` → redirects to Schwab login
2. After login, Schwab redirects to `/api/auth/callback` → tokens stored in Upstash Redis + owner cookie set
3. All subsequent API calls auto-refresh the access token using the refresh token
4. After 7 days, the refresh token expires → owner re-authenticates

**Token management:** Distributed lock in Redis prevents concurrent token refresh across parallel serverless invocations. In-memory fallback cache mitigates Redis blips during active invocation.

### Token Storage

Upstash Redis (via Vercel Marketplace). REST-based client, serverless-compatible.

---

## Security

### Headers (vercel.json)

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-XSS-Protection: 1; mode=block`
- `Content-Security-Policy`: `default-src 'self'`, strict `script-src` (with Sentry CDN), `frame-ancestors 'self'`, `connect-src` limited to self + Schwab + Vercel Analytics + Sentry ingest

### Authentication

- Owner cookie: HttpOnly, Secure, 7-day expiry, matched against `OWNER_SECRET` env var
- Hint cookie: Non-HttpOnly `sc-hint=1` for frontend page-load detection
- All API endpoints: `rejectIfNotOwner()` returns 401 for unauthenticated requests
- All API keys (Schwab, Anthropic, Postgres) are server-side only, never in client bundle
- Bot protection: `botid` checks on production endpoints, skipped in local dev. New endpoints must be added to the `protect` array in [src/main.tsx](../src/main.tsx).

### Rate Limiting

All owner-gated endpoints are rate-limited via Upstash Redis:

| Endpoint         | Limit  | Purpose                               |
| ---------------- | ------ | ------------------------------------- |
| `/api/analyze`   | 3/min  | Prevent Opus cost abuse (~$0.30/call) |
| `/api/analyses`  | 30/min | Public browse endpoint                |
| `/api/positions` | 20/min | Auto-fetched before each analysis     |
| `/api/snapshot`  | 30/min | Generous for normal use               |
| `/api/journal`   | 20/min | Query endpoint                        |
| `/api/auth/init` | 5/min  | OAuth flow protection                 |

### Input Validation

- Image payload: Max 4 images, max 5MB per image (base64), validated by Zod schemas
- Anthropic errors: Sanitized to generic messages, full details logged server-side only
- DB errors: Sanitized, never expose connection details to client
- SQL injection: Neon tagged templates auto-parameterize all queries
- All request bodies: Validated via Zod schemas in `api/_lib/validation.ts` at system boundaries

---

## The Math

### Strike Calculation Formula

For a delta target D with z-score z = N⁻¹(1 − D/100):

```text
drift  = −σ²/2 × T                          # negative drift correction for log-normal diffusion
K_put  = S × e^(drift − z × σ_put  × √T)
K_call = S × e^(drift + z × σ_call × √T)
```

Where S = SPX spot, T = hours remaining ÷ 1638, r = 0.

Skew model (convex put, dampened call):

```text
σ_put  = σ × (1 + skew × (z / z_ref)^1.35)     # convex: far OTM puts get disproportionately more IV
σ_call = σ × (1 − skew × (z / z_ref) × dampen)  # dampened: call skew flattens further OTM
dampen = 1 / (1 + 0.5 × max(0, z/z_ref − 1))
```

IV acceleration (applied to premiums and Greeks, not strike placement):

```text
σ_effective = σ × (1 + 0.6 × (1/hours_remaining − 1/6.5))   # capped at 1.8×
```

### Option Pricing (Black-Scholes)

```text
d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

Call = S·N(d1) − K·N(d2)
Put  = K·N(−d2) − S·N(−d1)
```

CDF implemented via Abramowitz & Stegun 26.2.17 rational approximation (error < 7.5 × 10⁻⁸).

### Iron Condor P&L

```text
Credit      = (short_put − long_put) + (short_call − long_call)
Put credit  = short_put − long_put
Call credit = short_call − long_call
Max Loss    = wing_width − credit
BE Low      = short_put − put_credit     # per-side credit, not total
BE High     = short_call + call_credit   # per-side credit, not total
PoP         = P(S_T > BE_low) + P(S_T < BE_high) − 1

Fat-tail adjustment (VIX-regime-dependent via getKurtosisFactor):
  kurtosis = 1.5 (VIX<15) / 2.0 (15-20) / 2.5 (20-25) / 3.0 (25-30) / 3.5 (30+)
  P_adj(breach_low)  = min(1, P(S_T < BE_low)  × kurtosis)
  P_adj(breach_high) = min(1, P(S_T > BE_high) × kurtosis)
  PoP_adjusted       = 1 − P_adj(breach_low) − P_adj(breach_high)
```

### Delta Guide — Range-to-Delta Mapping

```text
1. putStrike = spot × (1 − threshold/100)
2. z ≈ threshold / (σ × √T)
3. putSigma = σ × (1 + skew × min(z, 3) / 1.28)
4. putDelta = N(d1) from BS(spot, putStrike, putSigma, T)
5. maxDelta = min(putDelta, callDelta) × 100
```

σ is always VIX × 1.15 / 100 (independent of IV mode). Range thresholds adjusted by DOW × clustering multipliers.

### Time-to-Expiry

```text
T = hours_remaining / (6.5 × 252)
```

Early close days use reduced hours (e.g., 3.5 hours on day-before-holiday sessions).

---

## Observability

### Structured Logging

All API routes use [pino](https://github.com/pinojs/pino) for structured JSON logging. Each log entry includes severity level, timestamp, and contextual fields (error objects, request metadata, usage metrics). Logs are searchable and filterable in Vercel function logs.

For local development with human-readable output, pipe through `pino-pretty`:

```bash
vercel dev 2>&1 | npx pino-pretty
```

### Error Tracking (Sentry)

Client-side errors are automatically captured via `@sentry/react` with browser tracing (20% sample rate, production only). The `ErrorBoundary` component forwards caught errors to Sentry with component stack traces. Server-side: `@sentry/node` with isolation scope helpers for per-request context.

### Performance Analytics

Core Web Vitals (LCP, FID, CLS, TTFB) are reported to the Vercel dashboard via `@vercel/speed-insights`, alongside page view analytics from `@vercel/analytics`.

### Bundle Analysis

Generate an interactive treemap of the production bundle:

```bash
npm run build:analyze    # Opens dist/bundle-stats.html
```

---

## Data Collection & ML Pipeline

### Database Schema (50+ Tables, 77+ numbered migrations)

**Core Trading Tables:**

| Table              | Purpose                                 | Key Fields                                           | Constraint             |
| ------------------ | --------------------------------------- | ---------------------------------------------------- | ---------------------- |
| `market_snapshots` | Complete calculator state (50+ columns) | Prices, vol surface, regime, strikes JSONB, events   | UNIQUE(date, time)     |
| `analyses`         | Claude chart analysis responses         | mode, structure, confidence, delta, full_response    | FK → snapshots         |
| `outcomes`         | End-of-day settlement data              | OHLC, range, close_vs_open, vix_close, vix1d_close   | UNIQUE(date)           |
| `positions`        | Live SPX 0DTE position snapshots        | legs JSONB, net greeks, unrealized P&L               | UNIQUE(date, time)     |
| `lessons`          | Self-improving trading compendium       | text, status, embedding vector(2000), category, tags | UNIQUE(analysis, text) |
| `lesson_reports`   | Weekly curation changelog               | reviews processed, adds/supersedes/skips, report     | UNIQUE(week_ending)    |

**Market Data Tables (intraday time series):**

| Table              | Purpose                          | Key Fields                               | Granularity     |
| ------------------ | -------------------------------- | ---------------------------------------- | --------------- |
| `flow_data`        | Market Tide & net flow by source | ncp, npp, net_volume, source             | 5-minute        |
| `greek_exposure`   | MM Greek exposure per expiration | gamma, charm, delta, vanna (call/put)    | Daily by expiry |
| `spot_exposures`   | Aggregate GEX per timestamp      | gamma/charm/vanna (oi/vol/dir)           | 5-minute        |
| `strike_exposures` | Per-strike Greek profile         | gamma/charm/delta/vanna by strike+expiry | 5-minute        |

**ML Tables:**

| Table               | Purpose                                   | Key Fields                                            | Granularity       |
| ------------------- | ----------------------------------------- | ----------------------------------------------------- | ----------------- |
| `training_features` | Engineered feature vectors (100+ columns) | Flow checkpoints, GEX, Greeks, dark pool, options     | 1 row/trading day |
| `day_labels`        | ML training labels from review analyses   | structure_correct, flow signals, settlement direction | 1 row/trading day |
| `economic_events`   | FRED + Finnhub calendar                   | event_name, event_time, type, forecast, previous      | Per event         |

### Intraday Data Collection (38 Cron Jobs)

All cron jobs are guarded by `CRON_SECRET` and run during market hours (13–21 UTC, Mon–Fri) unless otherwise noted.

**Every 5 minutes (market hours):**

| Cron                    | Source         | Target Table       | Data                           |
| ----------------------- | -------------- | ------------------ | ------------------------------ |
| `fetch-flow`            | Unusual Whales | `flow_data`        | Market Tide (all-in + OTM)     |
| `fetch-net-flow`        | Unusual Whales | `flow_data`        | SPX, SPY, QQQ net flow         |
| `fetch-etf-tide`        | Unusual Whales | `flow_data`        | SPY, QQQ ETF fund flow         |
| `fetch-zero-dte-flow`   | Unusual Whales | `flow_data`        | 0DTE-specific flow             |
| `fetch-greek-flow`      | Unusual Whales | `flow_data`        | Delta flow per symbol          |
| `fetch-greek-exposure`  | Unusual Whales | `greek_exposure`   | Agg + by-expiry Greek exposure |
| `fetch-spot-gex`        | Unusual Whales | `spot_exposures`   | Aggregate GEX snapshot         |
| `fetch-strike-exposure` | Unusual Whales | `strike_exposures` | Per-strike Greeks (0DTE)       |
| `fetch-strike-all`      | Unusual Whales | `strike_exposures` | All-strike composite data      |

**Every minute (market hours):**

| Cron                 | Source         | Target Table        | Data                          |
| -------------------- | -------------- | ------------------- | ----------------------------- |
| `monitor-iv`         | Internal       | `training_features` | IV snapshots + crush rate     |
| `monitor-flow-ratio` | Internal       | `training_features` | Flow ratio dynamics           |
| `fetch-darkpool`     | Unusual Whales | (DB)                | $5M+ dark pool block tracking |

**Post-close and daily:**

| Cron                      | Schedule          | Data                                   |
| ------------------------- | ----------------- | -------------------------------------- |
| `fetch-outcomes`          | 4:25, 5:25 PM ET  | SPX OHLC settlement + VIX close        |
| `fetch-oi-change`         | 5:30 PM ET        | Open interest changes                  |
| `fetch-oi-per-strike`     | 10:00 AM ET       | Per-strike OI snapshot                 |
| `fetch-vol-surface`       | 5:35 PM ET        | IV term structure by strike/expiry     |
| `fetch-economic-calendar` | 9:25, 10:25 AM ET | FRED + Finnhub events                  |
| `compute-es-overnight`    | 9:35, 10:35 AM ET | ES futures overnight session summary   |
| `build-features`          | 4:45, 5:45 PM ET  | ML feature engineering (100+ features) |
| `curate-lessons`          | Sat 3:00 AM UTC   | Weekly lessons curation pipeline       |
| `backup-tables`           | Sun 5:00 AM UTC   | Database backup to Vercel Blob         |
| `health`                  | Mon 9:25 AM ET    | Postgres + Redis + Schwab token check  |

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

- **Phase B — Text-Embedding Day Analogs** ✅ Shipped. OpenAI `text-embedding-3-large` (2000-dim) over sidecar-generated session text; analog search via pgvector.
- **Phase C — Engineered-Feature Analog Backend** ✅ Shipped. 60-dim numeric feature vector alternative; `DAY_ANALOG_BACKEND` env switches backends.
- **Phase 3a — TBBO DBN → Parquet Converter** ✅ Shipped. Sidecar-side conversion producing the persistent archive under `year=YYYY/part.parquet`.
- **Phase 4b — TBBO Archive + 1-Year OFI Percentile** ✅ Shipped. Archive seeded from Vercel Blob; rank today's OFI against 1-yr historical distribution.
- **Analog Range Forecast — Cohort-Conditional Range + Asymmetric Excursion** ✅ Shipped. Strike-placement hints from 15 text-embedding-nearest historical mornings; replaces the fixed-%-of-spot heuristic.
- **VIX-Regime-Stratified Analog Retrieval** ✅ Shipped. Cohort filtered to same-VIX-bucket mornings; adaptively corrects vol-regime miscalibration on elevated/crisis-VIX days.

**Microstructure (OFI / TBBO / spread) phases:**

- **Phase 4c — Microstructure Feature Engineering** ✅ Shipped. Per-day OFI (Order Flow Imbalance), spread-widening aggregates, volume imbalances from TBBO.
- **Phase 4c1 — MAX-based Spread Aggregator** ✅ Shipped. Switched spread-widening stat from median to max for tail-event sensitivity.
- **Phase 4d — Microstructure EDA + Signal Validation** ✅ Shipped (validated). ES OFI: no signal. **NQ 1h OFI: ρ=0.313, p<0.001, n=312** — Bonferroni-significant predictor of next-day NQ return.
- **Phase 5a — Dual-Symbol Microstructure in Analyze** ✅ Shipped. ES + NQ OFI wired into `<microstructure_signals_rules>` in the analyze prompt.
- **Phase 5b — UW Deltas Context** ✅ Shipped. Dark pool velocity, GEX delta, whale net, ETF divergence — all delta-based vs absolute.
- **Phase 5c — tbbo-ofi-percentile Pre-Warm Cron** ✅ Shipped. Daily 13:00 UTC warm so analyze's first call of the day hits a warm Parquet cache.

**Other phases (accumulating):**

| Phase   | Name                           | Status          | Purpose                                                  |
| ------- | ------------------------------ | --------------- | -------------------------------------------------------- |
| Phase 3 | Charm Divergence Predictor     | 📊 Accumulating | Predict when naive charm chart misleads vs. Periscope    |
| Phase 4 | Intraday Range Regression      | 📊 Accumulating | Predict daily H-L range, beating VIX baseline            |
| Phase 5 | Optimal Exit Timing            | ⏸ Blocked       | Survival analysis — requires timestamped entry/exit data |
| Phase 6 | Flow-Price Divergence Detector | 📊 Accumulating | Automate Rule 10 with learned thresholds                 |

**Source modules (`ml/src/`):**

Core pipeline scripts: `utils.py`, `eda.py`, `clustering.py`, `phase2_early.py`, `visualize.py`, `backtest.py`, `pin_analysis.py`, `health.py`, `milestone_check.py`, `explore.py`.

Microstructure pipeline (`ml/src/features/`): OFI feature engineering, TBBO conversion, Parquet writer. Uses DuckDB with its own `_new_connection()` that mirrors the sidecar's UTC-TimeZone + memory-limit safety.

PAC engine scaffold (`ml/src/pac/`): DuckDB-backed order-blocks + structure detection for a future price-action-confirmation backtester.

**Feature Engineering Pipeline (`build-features` cron):**

Runs 4 phases after market close:

1. **Flow checkpoints** — NCP/NPP agreement at T1–T8 intervals across 6 sources
2. **GEX features** — Gamma OI/vol/dir at checkpoints, slopes, Greek exposure, per-strike gamma walls + charm slopes
3. **Phase 2 temporal** — Previous day metrics, realized vol, max pain, dark pool, options volume/premium/PCR
4. **Monitor dynamics** — IV crush rate, spike counts, flow ratio trends from minute-level data

Output: One row per trading day in `training_features` (100+ columns) + `day_labels`.

### Nightly Automation (GitHub Actions)

**Workflow:** `.github/workflows/ml-pipeline.yml`

- **Schedule:** 01:45 UTC Tue–Sat (9:45 PM ET, after `build-features` completes)
- **Trigger:** Cron + manual dispatch
- **Pipeline:**
  1. Setup Python 3.13 + Node 24
  2. Run `make -C ml all` (health → EDA → clustering → visualize → phase2 → backtest → pin)
  3. Upload all plots to Vercel Blob (`ml-plots/latest/`)
  4. Trigger Claude vision analysis (`POST /api/ml/analyze-plots`) for AI interpretation of each plot
  5. Commit `findings.json` if changed

---

## Futures + ES Options Sidecar (Railway)

A full Python data-platform service deployed separately on Railway, combining four distinct responsibilities: (1) real-time Databento Live ingestion of 6 futures symbols + ES options, (2) end-of-day Theta Data backfill of SPX option chains, (3) a persistent TBBO Parquet archive (distributed from Vercel Blob to Railway volume), and (4) a DuckDB query layer exposing microstructure + analog-day endpoints back to the Vercel side. Runs outside Vercel because it holds long-lived streaming connections and queries GB-scale Parquet archives — neither fits a serverless cold-start model.

See [sidecar/README.md](../sidecar/README.md) for the deployment + local-dev path. Architecture summary:

```text
Databento Live (streaming)         Theta Data Terminal (nightly backfill)
  ↓ databento SDK                    ↓ theta_client.py
[sidecar/src/]
  ├─ main.py                       — entry point, signal handlers, shutdown barrier
  ├─ databento_client.py           — Live session: OHLCV-1m, TBBO, ES.OPT trades/stats/definitions
  ├─ symbol_manager.py             — parent-symbology + ATM strike window re-centering
  ├─ trade_processor.py            — ES options trade buffering + periodic flush thread
  ├─ quote_processor.py            — ES/NQ TBBO → TopOfBook + TradeTick writers
  ├─ theta_launcher.py             — co-resident Theta Terminal JVM subprocess
  ├─ theta_fetcher.py              — nightly APScheduler + SPX EOD chain backfill
  ├─ archive_seeder.py             — one-shot pull from Vercel Blob → /data/archive (SHA-resumable)
  ├─ archive_query.py              — DuckDB layer over the TBBO Parquet archive
  ├─ health.py                     — /health + /archive/* + /admin/seed-archive HTTP server
  ├─ db.py                         — psycopg2 upserts (not @neondatabase/serverless)
  └─ sentry_setup.py               — Sentry init (separate DSN from Vercel side)
  ↓
Neon Postgres + Railway Volume [/data/archive/tbbo/year=*/part.parquet]
```

**Four concurrent responsibilities:**

1. **Real-time Databento Live** — 6 futures symbols (ES, NQ, ZN, RTY, CL, GC) on OHLCV-1m plus ES+NQ TBBO for microstructure, plus full ES.OPT chain (definition snapshot at session open with `start=0`, statistics for EOD OI/IV/delta, and trades filtered to an ATM ±10 strike window). Writes to `futures_bars`, `futures_options_trades`, `futures_options_daily`, and TopOfBook/TradeTick Parquet.
2. **Theta Data backfill** — nightly SPX option chain EOD fetcher via the co-resident Theta Terminal Java subprocess. Optional — disabled when `THETA_EMAIL`/`THETA_PASSWORD` are unset.
3. **Archive seeder** — one-shot `POST /admin/seed-archive` pulls the 3.9 GB TBBO archive from Vercel Blob into the `/data/archive` Railway volume on a first deploy (SHA-resumable, single-flight-locked). After seeding, an EOD process keeps the archive fresh.
4. **DuckDB query layer** — thread-local connections against the Parquet archive, cap'd at 500 MB memory with spill to `/tmp/duckdb`. Serves archive endpoints that the Vercel side consumes on analyze and ML-feature paths.

**HTTP endpoints (consumed by Vercel):**

| Endpoint                                           | Returns                                                |
| -------------------------------------------------- | ------------------------------------------------------ |
| `GET /health`                                      | Liveness + DB + Theta status                           |
| `GET /archive/day-summary?date=YYYY-MM-DD`         | Deterministic session text for embedding pipeline      |
| `GET /archive/day-features?date=YYYY-MM-DD`        | 60-dim numeric vector for engineered-analog retrieval  |
| `GET /archive/day-summary-batch?from&to`           | Batched summaries for backfill (capped 3 yrs)          |
| `GET /archive/day-features-batch?from&to`          | Batched vectors for backfill                           |
| `GET /archive/day-summary-prediction?date`         | Leakage-free prediction summary (no outcome fields)    |
| `GET /archive/analog-days?date&k`                  | k-nearest historical mornings by window similarity     |
| `GET /archive/tbbo-day-microstructure?date&symbol` | Per-day OFI + spread-widening aggregates (front month) |
| `GET /archive/tbbo-ofi-percentile?symbol&value`    | 1-year percentile rank of current OFI value            |
| `POST /admin/seed-archive`                         | One-shot seed trigger (token-gated)                    |

**Consumed by the Vercel side via:**

- `api/_lib/futures-context.ts` — reads `futures_snapshots` + `futures_options_daily` into Claude's analysis context
- `api/_lib/archive-sidecar.ts` — typed client for all `/archive/*` endpoints
- `api/cron/warm-tbbo-percentile.ts` — daily pre-warm so analyze's first-call latency is sub-2s (Phase 5c)
- `api/cron/refresh-current-snapshot.ts` — every 5 min in RTH, materializes today's summary+features into Neon so analyze never pays DuckDB cold-scan on hot path
- `api/cron/embed-yesterday.ts` — nightly, pulls yesterday's summary + stores OpenAI text-embedding-3-large (2000-dim) into `day_embeddings` for analog cohort retrieval
- `api/cron/backfill-futures-gaps.ts` — fills weekend/holiday gaps when Databento backfills late
