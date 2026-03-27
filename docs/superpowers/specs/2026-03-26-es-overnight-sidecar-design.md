# ES Overnight Futures Sidecar — Design Spec

**Date**: 2026-03-26
**Status**: Draft
**Author**: Claude (Opus 4.6) + Charles

## Problem

The strike calculator has zero visibility into overnight ES futures price action before the 9:30 AM ET cash open. ES futures trade ~23 hours/day, and the overnight session reveals institutional positioning that shapes the cash open:

- **Overnight high/low** define support/resistance for the cash session
- **Globex volume** signals conviction behind overnight moves
- **VWAP** reveals the volume-weighted institutional positioning level
- **Gap characterization** (gap size relative to overnight range + volume) predicts fill vs. extend probability

The calculator currently has `overnightGap` as a field, but it's just the cash-to-cash distance with no ES futures context. Claude's analysis lacks the data to distinguish "gap up 0.3% on light volume inside the overnight range" (likely fill) from "gap up 0.3% on heavy volume above the overnight range" (likely extend).

**Data source constraint**: Tradovate publishes ES market data exclusively via WebSocket — there is no REST polling alternative. Vercel cannot maintain WebSocket connections.

## Solution

A **sidecar architecture** with three components:

1. **Sidecar process** (Railway) — long-running Node.js process that maintains a WebSocket connection to Tradovate, aggregates quotes into 1-minute OHLCV bars, and writes them to the existing Neon Postgres database
2. **Vercel cron job** — runs at 9:35 AM ET on trading days, reads overnight bars from the database, computes summary metrics (range, VWAP, volume, gap classification), and writes a single row to `es_overnight_summaries`
3. **Analysis integration** — `api/analyze.ts` reads the pre-computed summary and injects it into Claude's context via `formatEsOvernightForClaude()`

## Architecture

```text
Tradovate WS ──> [ Sidecar on Railway ] ──> Neon Postgres (es_bars)
                  - 1-min OHLCV bars                |
                  - pg driver (TCP)                 |
                  - runs ~23 hrs/day                |
                                                    v
                  Vercel Cron (9:35 AM ET) ── reads overnight bars
                       |                     computes VWAP, range, gap
                       v
                  es_overnight_summaries table
                       |
                       v
                  api/analyze.ts reads summary
                  formatEsOvernightForClaude() -> Claude context
```

### Deployment Isolation

- **Vercel** deploys from the repo root. It sees `api/`, `src/`, `vercel.json`, `vite.config.ts`. The `sidecar/` folder is invisible to it — no config changes needed.
- **Railway** deploys from `sidecar/` only. It sees its own `package.json`, `Dockerfile`, `src/`. It has no knowledge of Vite, React, or Vercel.
- **Shared contract**: The only coupling between the two is the `es_bars` and `es_overnight_summaries` table schemas in the shared Neon database.

## Component 1: Sidecar Process

### Directory Structure

```text
sidecar/
  src/
    main.ts              # Orchestrator — startup, shutdown, reconnect loop
    tradovate-auth.ts    # Token acquire / cache / refresh lifecycle
    tradovate-ws.ts      # WebSocket connection + Tradovate protocol framing
    bar-aggregator.ts    # Tick -> 1-min OHLCV bar accumulation in memory
    db.ts                # pg connection pool + write helpers
    contract-roller.ts   # Resolves current front-month ES symbol
    health.ts            # Tiny HTTP server for Railway health checks
    logger.ts            # Pino logger (same style as api/_lib/logger.ts)
  package.json
  tsconfig.json
  Dockerfile
  .env.example
  README.md
```

### Dependencies (`sidecar/package.json`)

```json
{
  "name": "es-relay-sidecar",
  "private": true,
  "type": "module",
  "engines": { "node": "24.x" },
  "scripts": {
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "pg": "^8.x",
    "ws": "^8.x",
    "pino": "^10.x"
  },
  "devDependencies": {
    "@types/pg": "^8.x",
    "@types/ws": "^8.x",
    "tsx": "^4.x",
    "typescript": "^5.9.x"
  }
}
```

**Why these specific drivers:**

- `pg` (not `@neondatabase/serverless`): The sidecar is a long-running process. `pg` provides a persistent TCP connection pool, which is efficient for frequent writes. Neon's serverless driver uses HTTP per query — designed for ephemeral serverless functions, not persistent processes.
- `ws`: Standard WebSocket client for Node.js. Tradovate's protocol runs over standard WebSocket with custom JSON framing.

### Tradovate Authentication (`tradovate-auth.ts`)

Tradovate uses credential-based token auth. Tokens last **90 minutes** and are renewed via a dedicated endpoint that extends the session without creating a new one.

**CRITICAL — 2 concurrent session limit**: Tradovate tracks sessions server-side. Creating a 3rd session kills the oldest. The sidecar MUST:

- Request a single token at startup via `POST /auth/accesstokenrequest`
- Renew at the ~75 minute mark via `GET /auth/renewaccesstoken` (extends session, no new session created)
- Never call `accesstokenrequest` again unless the session is truly dead
- If Charles logs into Tradovate Trader web while the sidecar is running, a dedicated API-only user account is recommended

**Token acquisition — `POST /auth/accesstokenrequest`:**

```typescript
// Request body (from OpenAPI spec)
interface AccessTokenRequest {
  name: string; // username (required, max 64 chars)
  password: string; // password (required, max 64 chars)
  appId?: string; // application name (max 64 chars)
  appVersion?: string; // e.g., "1.0" (max 64 chars)
  deviceId?: string; // unique device ID (max 64 chars)
  cid?: string; // client ID (max 64 chars)
  sec?: string; // API secret key (max 8192 chars)
}

// Response body
interface AccessTokenResponse {
  accessToken?: string; // JWT/session token (max 8192 chars)
  expirationTime?: string; // ISO 8601 datetime (~90 min from now)
  userId?: number; // user ID
  name?: string; // username
  userStatus?:
    | 'Active'
    | 'Closed'
    | 'Initiated'
    | 'TemporaryLocked'
    | 'UnconfirmedEmail';
  hasLive?: boolean; // has live trading account
  errorText?: string; // non-empty if auth failed
}
```

**Base URLs:**

- Demo: `https://demo.tradovateapi.com/v1`
- Live: `https://live.tradovateapi.com/v1`
- Configurable via `TRADOVATE_BASE_URL` env var

**Token renewal — `GET /auth/renewaccesstoken`:**

- Send `Authorization: Bearer {accessToken}` header
- Returns same `AccessTokenResponse` with new `expirationTime`
- Does NOT create a new session (critical for session limit)

**Token lifecycle implementation:**

```typescript
interface TradovateTokenState {
  accessToken: string;
  mdAccessToken: string; // separate market data token
  expiresAt: number; // Unix ms (parsed from expirationTime)
  userId: number;
}

const RENEW_BUFFER_MS = 15 * 60 * 1000; // 15 minutes before expiry
let tokenState: TradovateTokenState | null = null;
let renewInFlight: Promise<TradovateTokenState> | null = null;

export async function getAccessToken(): Promise<string> {
  if (tokenState && tokenState.expiresAt > Date.now() + RENEW_BUFFER_MS) {
    return tokenState.accessToken;
  }
  // Renew existing session (not re-acquire)
  if (tokenState) {
    if (!renewInFlight) {
      renewInFlight = renewToken(tokenState.accessToken).finally(() => {
        renewInFlight = null;
      });
    }
    tokenState = await renewInFlight;
    return tokenState.accessToken;
  }
  // First-time acquisition only
  tokenState = await acquireToken();
  return tokenState.accessToken;
}

async function renewToken(currentToken: string): Promise<TradovateTokenState> {
  const res = await fetch(`${BASE_URL}/auth/renewaccesstoken`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
    },
  });
  const body: AccessTokenResponse = await res.json();
  if (body.errorText) throw new Error(`Renewal failed: ${body.errorText}`);
  return parseTokenResponse(body);
}
```

**Environment variables required:**

- `TRADOVATE_BASE_URL` — `https://demo.tradovateapi.com/v1` or `https://live.tradovateapi.com/v1`
- `TRADOVATE_MD_URL` — Market data WebSocket: `wss://md.tradovateapi.com/v1/websocket` (demo: `wss://md-demo.tradovateapi.com/v1/websocket`)
- `TRADOVATE_USERNAME` — Tradovate account username (max 64 chars)
- `TRADOVATE_PASSWORD` — Tradovate account password (max 64 chars)
- `TRADOVATE_APP_ID` — Application name, e.g., "strike-calculator-sidecar"
- `TRADOVATE_APP_VERSION` — e.g., "1.0"
- `TRADOVATE_DEVICE_ID` — Unique device identifier (e.g., UUID)
- `TRADOVATE_CID` — Client ID from Tradovate developer portal
- `TRADOVATE_SECRET` — API secret key from Tradovate developer portal

### Tradovate WebSocket Protocol (`tradovate-ws.ts`)

Tradovate uses a custom framing protocol over WebSocket with SockJS-style frame types.

**WebSocket URLs:**

- Demo market data: `wss://md-demo.tradovateapi.com/v1/websocket`
- Live market data: `wss://md.tradovateapi.com/v1/websocket`
- Replay: `wss://replay.tradovateapi.com/v1/websocket`

**Frame types (inbound from server):**

| Frame             | Meaning                | Action                      |
| ----------------- | ---------------------- | --------------------------- |
| `o`               | Connection open        | Send authorization          |
| `h`               | Server heartbeat       | No action (server is alive) |
| `a[...]`          | Array of JSON messages | Parse and process           |
| `c[code, reason]` | Connection close       | Reconnect with backoff      |

**CRITICAL — Client heartbeat every 2.5 seconds**: The sidecar MUST send an empty array `[]` on the WebSocket every 2.5 seconds. If the server doesn't receive a heartbeat within this window, it closes the connection. This heartbeat must continue even during active data streaming.

```typescript
// Heartbeat implementation
const HEARTBEAT_INTERVAL_MS = 2_500;
let heartbeatTimer: NodeJS.Timeout;

function startHeartbeat(ws: WebSocket) {
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('[]');
    }
  }, HEARTBEAT_INTERVAL_MS);
}
```

**Shutdown events**: Watch for `"e": "shutdown"` messages with `reasonCode` of `"ConnectionQuotaReached"` or `"IPQuotaReached"`. These indicate Tradovate is actively closing the connection due to limits — back off longer before reconnecting.

**Outbound message format:**

```text
endpoint\nrequestId\n\n{json_body}
```

Example — authorize:

```text
authorize\n1\n\n{"token":"..."}
```

Example — subscribe to quotes:

```text
md/subscribeQuote\n2\n\n{"symbol":"ESU6"}
```

**Inbound event format (inside `a[...]` frames):**

```json
{
  "e": "md",
  "d": {
    "quotes": [
      {
        "timestamp": "2026-03-26T02:15:00.123Z",
        "contractId": 123456,
        "entries": {
          "Bid": { "price": 5825.5, "size": 7 },
          "Offer": { "price": 5826.0, "size": 12 },
          "Trade": { "price": 5825.75, "size": 2 },
          "TotalTradeVolume": { "size": 41180 },
          "OpeningPrice": { "price": 5815.0 },
          "HighPrice": { "price": 5830.25 },
          "LowPrice": { "price": 5810.5 },
          "SettlementPrice": { "price": 5820.0 }
        }
      }
    ]
  }
}
```

**Key protocol details:**

- `TotalTradeVolume.size` is **cumulative for the session**, not per-tick. Per-bar volume is computed as the delta between consecutive cumulative values.
- `HighPrice` and `LowPrice` are **session** highs/lows, not per-tick. Per-bar high/low must be tracked from `Trade.price` locally.
- The sidecar subscribes to `md/subscribeQuote` and unsubscribes via `md/unsubscribeQuote` on shutdown.

**Message parser:**
The parser must handle Tradovate's two-layer framing:

1. **Frame layer**: Check the first character — `o` (open), `h` (heartbeat), `a` (data), `c` (close). For `a` frames, strip the `a` prefix and parse the JSON array inside.
2. **Message layer**: Each element in the array is a JSON string. Parse it and check for `e` (event type) or `s` (response status). Response messages have `{ s: 200, i: requestId, d: data }`.
3. For `e: "md"`, extract `d.quotes` array and process each quote.
4. For `e: "shutdown"`, check `d.reasonCode` — if `"ConnectionQuotaReached"` or `"IPQuotaReached"`, use longer backoff before reconnecting.

### Bar Aggregation (`bar-aggregator.ts`)

The aggregator holds exactly **one partial bar** in memory at any time. It converts a stream of quote events into 1-minute OHLCV bars.

**Aggregation logic:**

```text
On each quote event:
  1. Extract Trade.price, TotalTradeVolume.size, timestamp
  2. Compute minute boundary: floor(timestamp) to the minute
  3. If minute boundary matches current bar:
     - Update: high = max(high, price), low = min(low, price), close = price
     - Update: volume = currentCumVolume - barStartCumVolume
     - Increment tick_count
  4. If minute boundary is a NEW minute:
     - Flush current bar to Postgres
     - Start new bar: open = price, high = price, low = price, close = price
     - Record barStartCumVolume = previousCumVolume (for delta calc)
     - tick_count = 1
```

**Flush triggers:**

1. **Minute boundary crossed** — next quote's timestamp is in a new minute
2. **Safety timer** — a 60-second `setInterval` flushes even if no quotes arrive (writes bar with last known state)
3. **Disconnect** — WebSocket close event flushes the partial bar
4. **Shutdown** — SIGTERM handler flushes before exit

**Cumulative volume handling:**

- Tradovate sends `TotalTradeVolume.size` as a session cumulative
- Per-bar volume = `currentCumulative - previousCumulative`
- On session reset (maintenance break 5-6 PM ET), cumulative resets to 0
- The aggregator detects this (current < previous) and treats the current value as the bar's volume

### Contract Rolling (`contract-roller.ts`)

ES futures roll quarterly: March (H), June (M), September (U), December (Z). The front-month contract changes ~1 week before expiry (third Friday of the expiry month).

**Contract symbol format:** `ES` + month code + last digit of year

- Example: `ESM6` = June 2026, `ESU6` = September 2026
- Month codes: H (Mar), M (Jun), U (Sep), Z (Dec)

**Resolution strategy — use the Tradovate API instead of manual date math:**

The `ContractMaturity` schema has an `isFront: boolean` field that tells us which contract is the current front-month. The resolution flow:

```text
1. GET /contract/find?name=ESM6 → returns Contract { id, name, contractMaturityId }
2. GET /contractMaturity/item?id={contractMaturityId} → returns { isFront, expirationDate }
3. If isFront === true → use this contract
4. If isFront === false → compute next quarter symbol and try again
```

**Fallback**: If the API approach is unreliable (e.g., `isFront` updates lag), fall back to manual date math:

```text
Given today's date:
  1. Find the current quarter's expiry (third Friday of Mar/Jun/Sep/Dec)
  2. If today is within 7 calendar days of expiry, use the NEXT quarter
  3. Otherwise, use the current quarter
  4. Construct symbol: "ES" + monthCode + yearDigit
```

**Roll detection:** On startup, resolve the contract symbol. Every 24 hours (or on reconnect), re-resolve and compare. If the symbol changed, unsubscribe from the old contract and subscribe to the new one. Log the roll event.

### Lifecycle & Resilience (`main.ts`)

#### Startup Sequence

```text
1. Validate env vars (fail fast if DATABASE_URL or Tradovate creds missing)
2. Initialize pg connection pool (verify with SELECT 1)
3. Acquire Tradovate access token (REST call)
4. Resolve front-month ES contract symbol (contract-roller)
5. Open WebSocket -> authorize -> subscribe md/subscribeQuote
6. Start health HTTP server on $PORT
7. Log "sidecar ready" — begin processing quotes
```

If any step fails, the process exits with a non-zero code. Railway auto-restarts it, which retries the whole sequence.

#### Reconnection Strategy

The WebSocket will disconnect — Tradovate has a daily maintenance window (5-6 PM ET), plus network blips.

```text
On WebSocket close/error:
  1. Flush partial bar to Postgres (don't lose the last minute of data)
  2. Log the disconnect reason and duration
  3. Wait with exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (cap)
  4. Check if token is still valid (refresh if needed)
  5. Reconnect -> re-authorize -> re-subscribe
  6. Reset backoff on successful reconnect
  7. Log "reconnected" with gap duration
```

#### Graceful Shutdown

On SIGTERM (Railway sends this during deploys/restarts):

```text
1. Unsubscribe from md/subscribeQuote (clean Tradovate-side cleanup)
2. Close WebSocket
3. Flush partial bar to Postgres
4. Drain pg connection pool
5. Exit 0
```

#### Health Check (`health.ts`)

Railway pings a health endpoint to determine process liveness:

```text
GET /health -> 200 if:
  - WebSocket is connected (ws.readyState === OPEN)
  - Last quote received < 120 seconds ago (during market hours only)
  - pg pool has available connections

GET /health -> 503 if any of the above fail
```

**Market-hours-aware staleness**: The 120-second quote freshness check only applies during active ES trading hours. During the daily maintenance break (5-6 PM ET, Sunday-Friday) and weekends, the health check skips the staleness check and only verifies WebSocket connection state and pg pool health.

### Logger (`logger.ts`)

Same pino configuration style as `api/_lib/logger.ts`:

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'es-relay' },
});

export default logger;
```

The `base.service` field distinguishes sidecar logs from Vercel function logs if both are routed to the same drain.

### Dockerfile

```dockerfile
FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

Two-stage build: compile TypeScript in the builder stage, copy only the compiled JS and production `node_modules` to the runtime image.

### Environment Variables (`.env.example`)

```bash
# Database (same Neon instance as Vercel app)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Tradovate API
TRADOVATE_BASE_URL=https://live.tradovateapi.com/v1
TRADOVATE_MD_URL=wss://md.tradovateapi.com/v1/websocket
TRADOVATE_USERNAME=
TRADOVATE_PASSWORD=
TRADOVATE_APP_ID=strike-calculator-sidecar
TRADOVATE_APP_VERSION=1.0
TRADOVATE_DEVICE_ID=
TRADOVATE_CID=
TRADOVATE_SECRET=

# Runtime
PORT=8080
LOG_LEVEL=info
```

The `DATABASE_URL` is the same connection string used by the Vercel app (copied from Vercel env vars). Railway manages these via its environment variable UI.

## Component 2: Database Schema

### Migration #12 — `es_bars` Table

Added to the existing `MIGRATIONS` array in `api/_lib/db.ts` (next available ID: 12):

```typescript
{
  id: 12,
  description: 'Create es_bars table for ES futures 1-minute OHLCV bars',
  run: async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS es_bars (
        id          BIGSERIAL PRIMARY KEY,
        symbol      TEXT NOT NULL DEFAULT 'ES',
        ts          TIMESTAMPTZ NOT NULL,
        open        NUMERIC(10,2) NOT NULL,
        high        NUMERIC(10,2) NOT NULL,
        low         NUMERIC(10,2) NOT NULL,
        close       NUMERIC(10,2) NOT NULL,
        volume      INTEGER NOT NULL DEFAULT 0,
        tick_count  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_es_bars_sym_ts
      ON es_bars (symbol, ts)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_es_bars_ts
      ON es_bars (ts DESC)
    `;
  },
},
```

**Schema notes:**

- `NUMERIC(10,2)` — ES futures trade in 0.25 increments; two decimal places captures all precision without floating-point artifacts in SQL aggregations.
- `BIGSERIAL` — at ~1,380 bars/day (23 hours \* 60 minutes), this accumulates ~500K rows/year. `BIGSERIAL` provides headroom; `SERIAL` would also work but `BIGSERIAL` is defensive.
- `UNIQUE INDEX ON (symbol, ts)` — enables the `ON CONFLICT` upsert pattern for idempotent writes. Also serves as the primary query index for overnight range computation.
- `ts DESC` index — optimizes "latest N bars" queries and the cron job's time-range scan.

**Data volume**: ~1,380 rows/day, ~500K rows/year, ~50MB/year at this row size. Negligible for Neon.

### Migration #13 — `es_overnight_summaries` Table

```typescript
{
  id: 13,
  description: 'Create es_overnight_summaries table for pre-computed overnight ES metrics',
  run: async (sql) => {
    await sql`
      CREATE TABLE IF NOT EXISTS es_overnight_summaries (
        id                  SERIAL PRIMARY KEY,
        trade_date          DATE NOT NULL UNIQUE,
        -- Raw overnight metrics
        globex_open         NUMERIC(10,2),
        globex_high         NUMERIC(10,2),
        globex_low          NUMERIC(10,2),
        globex_close        NUMERIC(10,2),
        vwap                NUMERIC(10,2),
        total_volume        INTEGER,
        bar_count           INTEGER,
        -- Derived range metrics
        range_pts           NUMERIC(10,2),
        range_pct           NUMERIC(6,4),
        -- Gap analysis (requires SPX data from outcomes/quotes)
        cash_open           NUMERIC(10,2),
        prev_cash_close     NUMERIC(10,2),
        gap_pts             NUMERIC(10,2),
        gap_pct             NUMERIC(6,4),
        gap_direction       TEXT,
        gap_size_class      TEXT,
        -- Position analysis
        cash_open_pct_rank  NUMERIC(6,2),
        position_class      TEXT,
        -- Volume analysis
        vol_20d_avg         INTEGER,
        vol_ratio           NUMERIC(6,2),
        vol_class           TEXT,
        -- VWAP analysis
        gap_vs_vwap_pts     NUMERIC(10,2),
        vwap_signal         TEXT,
        -- Composite score
        fill_score          INTEGER,
        fill_probability    TEXT,
        -- Metadata
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  },
},
```

**Schema notes:**

- `trade_date` is the **SPX cash session date** (not the calendar date of the overnight session). This makes joins to `market_snapshots` and `outcomes` natural — everything keys off the same trading day.
- `UNIQUE(trade_date)` — one summary per trading day. The cron job uses `ON CONFLICT (trade_date) DO UPDATE` so re-runs are idempotent.
- The schema stores both raw metrics and derived classifications so the formatter doesn't recompute.
- `vol_20d_avg` is computed from historical `es_overnight_summaries` rows (rolling lookback). During the first 20 days of data collection, the ratio falls back to absolute thresholds.
- `fill_score` and `fill_probability` are the composite gap fill prediction. The score is 0-100, probability is `HIGH`/`MODERATE`/`LOW`.

### Write Pattern (Sidecar -> `es_bars`)

```sql
INSERT INTO es_bars (symbol, ts, open, high, low, close, volume, tick_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (symbol, ts) DO UPDATE SET
  open       = es_bars.open,                        -- preserve original open
  high       = GREATEST(es_bars.high, EXCLUDED.high),
  low        = LEAST(es_bars.low, EXCLUDED.low),
  close      = EXCLUDED.close,
  volume     = GREATEST(es_bars.volume, EXCLUDED.volume),
  tick_count = GREATEST(es_bars.tick_count, EXCLUDED.tick_count);
```

The `ON CONFLICT` upsert means reconnections that replay the same minute merge data rather than creating duplicates. `open = es_bars.open` preserves the first-seen open price. `GREATEST`/`LEAST` ensure the high/low are correct even if a partial bar was flushed on disconnect and then completed after reconnect. Volume and tick_count use `GREATEST` since the final flush should have the complete values.

## Component 3: Vercel Cron Job

### `api/cron/compute-es-overnight.ts`

**Schedule**: `35 13 * * 1-5` (9:35 AM ET, weekdays — 5 minutes after cash open to allow the sidecar to flush its last pre-open bar)

**Added to `vercel.json` crons array:**

```json
{
  "path": "/api/cron/compute-es-overnight",
  "schedule": "35 13 * * 1-5"
}
```

> Note: Vercel cron schedules are in UTC. 9:35 AM ET = 13:35 UTC (during EDT) or 14:35 UTC (during EST). The schedule `35 13 * * 1-5` covers EDT. During EST months (Nov-Mar), this runs at 8:35 AM ET — 55 minutes before cash open. To handle both, the cron should run at `35 13,14 * * 1-5` (both 13:35 and 14:35 UTC) with a market-hours guard that skips if it's before 9:30 AM ET.

**Revised schedule**: `35 13,14 * * 1-5`

The handler checks `isMarketOpen()` (or a simpler "is it after 9:30 AM ET today?") and skips if the market hasn't opened yet. This makes the cron DST-safe.

### Handler Structure

Follows the exact patterns from existing cron jobs (e.g., `fetch-flow.ts`):

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 0. Method check (same pattern as all crons)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth check (same pattern as all crons)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2. Time guard — skip if before 9:30 AM ET (DST-safe)
  //    (implementation uses getETTime() from existing helpers)

  // 3. Compute overnight window boundaries
  //    - Previous cash close: yesterday 4:00 PM ET (or last trading day)
  //    - Today cash open: 9:30 AM ET

  // 4. Query es_bars for overnight window
  //    SQL aggregation: globex_open, high, low, pre_cash_close, VWAP, volume

  // 5. Fetch previous day's SPX settlement from outcomes table
  //    for gap calculation

  // 6. Classify gap (Charles implements classifyGap())

  // 7. Write to es_overnight_summaries (ON CONFLICT upsert)

  // 8. Return success with summary
}
```

### Overnight Window SQL

```sql
SELECT
  (ARRAY_AGG(open ORDER BY ts ASC))[1]        AS globex_open,
  MAX(high)                                     AS globex_high,
  MIN(low)                                      AS globex_low,
  (ARRAY_AGG(close ORDER BY ts DESC))[1]        AS pre_cash_close,
  SUM(((high + low + close) / 3) * volume) / NULLIF(SUM(volume), 0) AS vwap,
  SUM(volume)                                   AS total_volume,
  COUNT(*)                                      AS bar_count
FROM es_bars
WHERE symbol = 'ES'
  AND ts >= $1   -- previous cash close (4:00 PM ET)
  AND ts <  $2   -- today cash open (9:30 AM ET)
```

**Time boundary computation:**

- `$1` (overnight start): The previous trading day's 4:00 PM ET. On Monday, this is Friday 4:00 PM ET. On Tuesday-Friday, this is yesterday 4:00 PM ET. Must account for holidays via the existing `getMarketCloseHourET()` helper.
- `$2` (overnight end): Today's 9:30 AM ET.

### Six Calculations in the Cron Handler

The cron handler runs these six calculations using overnight bar data + SPX cash data from Schwab:

**Data sources at 9:35 AM ET:**

- `es_bars` table → overnight OHLCV (6:00 PM ET previous day to 9:30 AM ET today)
- `outcomes` table → `prevCashClose` (previous SPX settlement)
- Schwab API (existing `schwabFetch`) → `cashOpen` (SPX open at 9:30 AM ET)
- `es_overnight_summaries` table → historical rows for 20-day volume average

#### Calculation 1: Gap Size & Direction

```typescript
const gapPts = cashOpen - prevCashClose;
const gapPct = (gapPts / prevCashClose) * 100;
const gapDirection = gapPts >= 0 ? 'UP' : 'DOWN';

// SPX-scaled thresholds:
let gapSizeClass: string;
const absGap = Math.abs(gapPts);
if (absGap < 5)
  gapSizeClass = 'NEGLIGIBLE'; // no gap trade implications
else if (absGap < 15)
  gapSizeClass = 'SMALL'; // normal drift, gap fill likely
else if (absGap < 30)
  gapSizeClass = 'MODERATE'; // institutional positioning, 50/50
else if (absGap < 50)
  gapSizeClass = 'LARGE'; // news-driven, fill unlikely same session
else gapSizeClass = 'EXTREME'; // macro event, fill may take days
```

#### Calculation 2: Gap Position Relative to Overnight Range

The most important calculation — tells whether cash opened at the extreme of overnight activity or mid-range.

```typescript
const globexRange = globexHigh - globexLow;
const cashOpenPctRank = ((cashOpen - globexLow) / globexRange) * 100;

let positionClass: string;
if (cashOpenPctRank > 90)
  positionClass = 'AT_GLOBEX_HIGH'; // overnight rally extended to cash, fill risk HIGH
else if (cashOpenPctRank > 70)
  positionClass = 'NEAR_HIGH'; // bullish overnight, moderate fill risk
else if (cashOpenPctRank > 30)
  positionClass = 'MID_RANGE'; // no strong overnight directional bias
else if (cashOpenPctRank > 10)
  positionClass = 'NEAR_LOW'; // bearish overnight, moderate extension risk
else positionClass = 'AT_GLOBEX_LOW'; // overnight selloff extended, short-covering likely
```

#### Calculation 3: Overnight Volume Classification

```typescript
// 20-day rolling average from historical summaries
const historicalRows = await sql`
  SELECT total_volume FROM es_overnight_summaries
  WHERE trade_date < ${tradeDate}
  ORDER BY trade_date DESC LIMIT 20
`;
const vol20dAvg =
  historicalRows.length > 0
    ? historicalRows.reduce((sum, r) => sum + r.total_volume, 0) /
      historicalRows.length
    : null;

let volRatio: number;
let volClass: string;
if (vol20dAvg && vol20dAvg > 0) {
  // Relative to rolling average (preferred)
  volRatio = totalVolume / vol20dAvg;
  if (volRatio < 0.6) volClass = 'LIGHT';
  else if (volRatio < 1.0) volClass = 'NORMAL';
  else if (volRatio < 1.5) volClass = 'ELEVATED';
  else volClass = 'HEAVY';
} else {
  // Absolute fallback (first 20 days of data)
  volRatio = 0;
  if (totalVolume < 300_000) volClass = 'LIGHT';
  else if (totalVolume < 500_000) volClass = 'NORMAL';
  else if (totalVolume < 700_000) volClass = 'ELEVATED';
  else volClass = 'HEAVY';
}
```

#### Calculation 4: Overnight Range as Straddle Cone Percent

This is computed at analysis time by the formatter (not the cron), since it needs the calculator's straddle cone width from the frontend context.

```typescript
// In formatEsOvernightForClaude(), if cone bounds provided:
const coneWidth = coneUpper - coneLower;
const overnightAsConePercent = (rangePts / coneWidth) * 100;

// < 20% = QUIET overnight — full cone available for cash session
// 20-40% = NORMAL — some range consumed
// 40-60% = ACTIVE — significant range used, tighten expectations
// > 60% = VOLATILE — most of expected move happened overnight
```

#### Calculation 5: Gap vs Overnight VWAP

```typescript
const gapVsVwapPts = cashOpen - overnightVWAP;

let vwapSignal: string;
const gapUp = gapPts >= 0;
if (gapUp && gapVsVwapPts > 0)
  vwapSignal = 'SUPPORTED'; // institutions bought overnight AND held → gap has support
else if (gapUp && gapVsVwapPts <= 0)
  vwapSignal = 'OVERSHOOT_FADE'; // gap up is above where institutions positioned → fade likely
else if (!gapUp && gapVsVwapPts < 0)
  vwapSignal = 'SUPPORTED'; // institutions sold overnight AND held → gap extension likely
else vwapSignal = 'OVERSHOOT_FADE'; // gap down is shallow, institutions bought dip → fill likely
```

#### Calculation 6: Composite Gap Fill Probability Score

```typescript
let fillScore = 0;

// Size factor: larger gaps fill less often
if (absGap < 10) fillScore += 30;
else if (absGap < 20) fillScore += 15;
else if (absGap < 40) fillScore += 0;
else fillScore -= 20;

// Volume factor: light volume gaps fill more
if (volRatio < 0.6) fillScore += 25;
else if (volRatio < 1.0) fillScore += 10;
else if (volRatio < 1.5) fillScore -= 10;
else fillScore -= 25;

// Position factor: opens at range extremes fill more
if (cashOpenPctRank > 90 || cashOpenPctRank < 10) fillScore += 20;
else if (cashOpenPctRank > 70 || cashOpenPctRank < 30) fillScore += 5;
else fillScore -= 10;

// VWAP factor: opens away from VWAP fill more
if (vwapSignal === 'OVERSHOOT_FADE') fillScore += 20;
else fillScore -= 15;

// Classification
let fillProbability: string;
if (fillScore > 50) fillProbability = 'HIGH';
else if (fillScore > 20) fillProbability = 'MODERATE';
else fillProbability = 'LOW';
```

## Component 4: Analysis Integration

### Context Injection in `api/analyze.ts`

**Injection point**: After the IV term structure section (around line 810 in the current file), following the identical pattern.

**New variable:**

```typescript
let esOvernightContext: string | null = null;
```

**Fetch logic** (added to the parallel fetch block around line 700):

```typescript
// Fetch pre-computed ES overnight summary from DB
try {
  const sql = getDb();
  const tradeDate = analysisDate ?? getETDateStr(new Date());
  const rows = await sql`
    SELECT * FROM es_overnight_summaries
    WHERE trade_date = ${tradeDate}
    LIMIT 1
  `;
  if (rows.length > 0) {
    esOvernightContext = formatEsOvernightForClaude(
      rows[0],
      context.straddleConeUpper as number | undefined,
      context.straddleConeLower as number | undefined,
    );
  }
} catch (esErr) {
  logger.error({ err: esErr }, 'Failed to fetch ES overnight summary');
}
```

**Context text injection** (after IV term structure section):

```typescript
${esOvernightContext ? `
## ES Futures Overnight Context
The following ES futures overnight session data provides institutional positioning context for gap analysis.

${esOvernightContext}
` : ''}
```

### `formatEsOvernightForClaude()` Function

Located in a new file: `api/es-overnight.ts` (exported, imported by `analyze.ts`).

The formatter reads pre-computed fields from `es_overnight_summaries` and adds the straddle cone comparison (Calculation 4) which requires live calculator context.

```typescript
export function formatEsOvernightForClaude(
  row: EsOvernightSummaryRow,
  coneUpper?: number | null,
  coneLower?: number | null,
): string | null {
  if (!row) return null;
  // ... parse all fields from row ...
  // ... format the output below ...
}
```

**Output format** (matches Charles's exact specification):

```text
ES Overnight Session (Globex 6:00 PM – 9:30 AM ET):
  Range: 6520.50 – 6548.25 (27.75 pts, 38% of straddle cone)
  Volume: 487K contracts (NORMAL, 1.05x 20-day avg)
  VWAP: 6536.80

  Gap Analysis:
    Cash Open: 6545.00 | Previous Close: 6530.00 | Gap: +15.0 pts UP (0.23%)
    Gap Size: MODERATE
    Open Position: 91st percentile of overnight range (AT GLOBEX HIGH)
    Open vs VWAP: +8.2 pts above overnight VWAP (gap has support)

  Gap Fill Probability: MODERATE (score: 35)
    Gap is moderate-sized with normal volume, but cash opened at the
    globex high — profit-taking at open could fill 5-10 pts. The open
    above VWAP suggests institutional support for the gap.

  Implication for 0DTE:
    Overnight range consumed 38% of straddle cone — 62% remaining.
    Gap direction (UP) aligns with bullish flow if confirmed at open.
    Watch for gap fill in first 30 min as overnight longs take profit.
```

The "Implication for 0DTE" section is generated dynamically based on the computed metrics:

- **Cone consumption** from Calculation 4 (only if `coneUpper`/`coneLower` provided)
- **Gap direction alignment** from Calculations 1 + 5
- **Fill watch** from Calculation 6 score and position class

## Data Retention

**`es_bars`**: No automatic cleanup initially. At ~500K rows/year and ~50MB/year, this is negligible for Neon. If it grows, add a monthly cron that deletes bars older than 90 days (overnight summaries preserve the computed metrics permanently).

**`es_overnight_summaries`**: Retained indefinitely. One row per trading day (~252 rows/year) — trivial storage. Useful for backtesting overnight pattern correlations.

## Verification Plan

### Sidecar Verification

1. Start sidecar locally (`npm run dev`) with Tradovate demo/paper account
2. Verify WebSocket connects and quotes arrive (check logs)
3. Verify bars appear in `es_bars` table after 1-2 minutes
4. Kill the process (Ctrl+C) — verify partial bar is flushed
5. Restart — verify reconnection and no duplicate bars
6. Wait for daily maintenance window — verify reconnect after maintenance

### Cron Verification

1. After collecting 1+ hour of bars, manually trigger the cron: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/compute-es-overnight`
2. Verify `es_overnight_summaries` row is created with correct aggregates
3. Manually verify VWAP: `SUM(close * volume) / SUM(volume)` against raw bars
4. Re-trigger — verify idempotent upsert (row count doesn't increase)

### Analysis Integration Verification

1. Trigger an analysis with overnight data present
2. Verify Claude's response references ES overnight context
3. Trigger an analysis with NO overnight data — verify graceful fallback (section omitted, no error)

## Implementation Order

1. **Database migrations** — Add migrations #12 and #13 to `api/_lib/db.ts`, run via `POST /api/journal/init`
2. **Sidecar scaffold** — Create `sidecar/` directory with `package.json`, `tsconfig.json`, `Dockerfile`, logger
3. **Tradovate auth** — Implement `tradovate-auth.ts` (token acquire/cache/refresh)
4. **Tradovate WebSocket** — Implement `tradovate-ws.ts` (connect, authorize, subscribe, parse messages)
5. **Bar aggregator** — Implement `bar-aggregator.ts` (tick accumulation, minute-boundary flush)
6. **Database writer** — Implement `db.ts` (pg pool, upsert helper)
7. **Main orchestrator** — Implement `main.ts` (startup sequence, reconnection loop, graceful shutdown)
8. **Health check** — Implement `health.ts`
9. **Contract roller** — Implement `contract-roller.ts`
10. **Vercel cron** — Create `api/cron/compute-es-overnight.ts` with overnight SQL aggregation
11. **Gap classifier** — Charles implements `classifyGap()` in the cron handler
12. **Claude formatter** — Create `api/es-overnight.ts` with `formatEsOvernightForClaude()`
13. **Analysis integration** — Wire formatter into `api/analyze.ts`
14. **vercel.json** — Add cron entry
15. **Railway deployment** — Deploy sidecar to Railway from `sidecar/` subdirectory
16. **End-to-end test** — Verify full flow: Tradovate -> bars -> cron -> summary -> Claude context

## Resolved from OpenAPI Spec

- **Auth endpoint**: `POST {BASE_URL}/auth/accesstokenrequest` with `name`, `password`, `appId`, `appVersion`, `deviceId`, `cid`, `sec`
- **Token lifetime**: 90 minutes. Renew at 75-minute mark via `GET /auth/renewaccesstoken`.
- **Session limit**: 2 concurrent sessions max. Renewal does NOT create a new session.
- **WebSocket heartbeat**: Client must send `[]` every 2.5 seconds.
- **Frame format**: SockJS-style — `o` (open), `h` (heartbeat), `a[...]` (data), `c` (close).
- **Contract lookup**: `GET /contract/find?name=ESM6` + `ContractMaturity.isFront` field.
- **Server URLs**: Demo `https://demo.tradovateapi.com/v1`, Live `https://live.tradovateapi.com/v1`.

## Resolved Questions

All questions resolved:

- **Account type**: Live. Base URLs: `https://live.tradovateapi.com/v1` and `wss://md.tradovateapi.com/v1/websocket`.
- **Dedicated API user**: Not needed. Charles doesn't log into Tradovate web at night, so the 2-session limit won't conflict with the sidecar.
- **Overnight session start**: Confirmed 6:00 PM ET (5:00 PM CT). ES resumes after the 5:00-6:00 PM ET daily maintenance break.
- **Gap classification thresholds**: Fully specified in the Six Calculations section above.
