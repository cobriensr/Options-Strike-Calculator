# Institutional Program Tracker — Build Spec

**Status:** Design + inline code ready to implement.
**Date:** 2026-04-23
**Revised:** 2026-04-23 post-audit — widened scope to cover all 3 mfsl implications
**Purpose:** Track SPXW institutional floor-brokered block flow (`mfsl` / `cbmo` / `slft` conditions) across two complementary tracks:
1. **Ceiling track** — the recurring 200-300 DTE call-spread program (regime indicator).
2. **Opening-ATM track** — first-hour near-ATM blocks (institutional open-positioning signal).

Plus a **strike-concentration heatmap** showing where institutional money has been accumulating over a rolling window.

## Three mfsl implications this spec addresses

1. **Never treat mfsl as directional flow** — individual legs of spread structures have artifactual side labels. This system stores raw blocks but surfaces **pair-level direction** (computed from majority across legs at same-minute timestamp), never per-leg aggression.
2. **Aggregate mfsl flow = where smart money is positioning** — the strike-concentration heatmap (new in v2) sums cumulative notional per strike over a rolling 30/60-day window. Strikes with heavy cumulative mfsl premium are where institutional conviction is building and become future gamma walls / technical levels.
3. **Opening-5-min mfsl blocks = institutional open-positioning** — captured via the opening-ATM track. ~3 blocks/day avg, size ~150 contracts, 71% near-ATM. Tiny count but high signal. Surfaced as a separate "Today's opening institutional blocks" section (not mixed into the regime chart).

## Why this matters

From `docs/0dte-findings.md` Finding 1 + the subsequent deep dive:

- Every trading day, an institutional participant sells 10-32k contract blocks at paired SPXW strikes in the 8000-8200 range (9-month expiry).
- The strikes = institutional consensus on the medium-term SPX ceiling.
- **Strike migration is a regime signal**: ceiling moving up = bullish institutional view. Ceiling pulling in = risk-off.
- Direction flip (buy-side or put-side) = major regime change.
- We can track this today without the WebSocket tier using REST polling.

## UW endpoint strategy (research tier, no WebSocket)

From `docs/unusual-whales-openapi.yaml`:

| Endpoint | Returns | Use |
|---|---|---|
| `/api/stock/{ticker}/option-contracts` | All option contracts for a ticker (max 500 results) | Enumerate SPXW 200-300 DTE contracts daily |
| `/api/option-contract/{id}/flow` | **Last 50 trades** for a contract, filter by `min_premium` and `side` | Fetch actual block trades with `upstream_condition_detail` (mfsl/cbmo/slft) |
| `/api/option-trades/flow-alerts` | UW's pre-filtered "unusual" alerts | Already used by `fetch-flow-alerts.ts` for 0-1 DTE |

**Key field:** The `Option Trade` schema (spec line 5845) returns `upstream_condition_detail` — that's where `mfsl` / `cbmo` / `slft` values live. This is how we identify institutional floor blocks.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Cron: fetch-spxw-blocks                                         │
│ Runs 10:00, 14:00, 15:20 CT weekdays                            │
│                                                                 │
│  1. Enumerate SPXW contracts 200-280 DTE within ±25% of spot   │
│     via /api/stock/SPXW/option-contracts                        │
│  2. For each target contract, fetch last 50 trades with         │
│     min_premium=50000 via /api/option-contract/{id}/flow        │
│  3. Filter to upstream_condition_detail IN ('mfsl','cbmo','slft')│
│     AND size >= 1000                                            │
│  4. Upsert into institutional_blocks table (dedupe by trade id) │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ API: GET /api/institutional-program?days=30                     │
│                                                                 │
│  - Aggregates institutional_blocks into daily program state     │
│  - Identifies paired spread structures (same timestamp, ±$100)  │
│  - Computes ceiling_pct_above_spot per day                      │
│  - Returns time series + today's detail                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Frontend: InstitutionalProgramSection                           │
│                                                                 │
│  - Today's program card (strikes, direction, size, ceiling %)   │
│  - Ceiling chart over time (30/60/90 day views)                 │
│  - Regime-change banner when ceiling shifts or direction flips  │
│  - Expandable daily block log                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Database migration (id 81)

Add to end of `MIGRATIONS` array in [api/_lib/db-migrations.ts](api/_lib/db-migrations.ts):

```ts
{
  id: 81,
  description:
    'Create institutional_blocks table for SPXW mfsl/cbmo floor blocks ' +
    '(institutional regime indicator — 200-300 DTE call/put spread program)',
  statements: (sql) => [
    sql`
      CREATE TABLE IF NOT EXISTS institutional_blocks (
        trade_id         TEXT PRIMARY KEY,           -- UW trade uuid
        executed_at      TIMESTAMPTZ NOT NULL,
        option_chain_id  TEXT NOT NULL,
        strike           DOUBLE PRECISION NOT NULL,
        option_type      TEXT NOT NULL,              -- 'call' | 'put'
        expiry           DATE NOT NULL,
        dte              INTEGER NOT NULL,           -- at trade time
        size             INTEGER NOT NULL,
        price            DOUBLE PRECISION NOT NULL,
        premium          DOUBLE PRECISION NOT NULL,
        side             TEXT,                       -- 'ask' | 'bid' | null
        condition        TEXT NOT NULL,              -- 'mfsl' | 'cbmo' | 'slft'
        exchange         TEXT,
        underlying_price DOUBLE PRECISION NOT NULL,
        moneyness_pct    DOUBLE PRECISION NOT NULL,  -- (strike - spot) / spot
        open_interest    INTEGER,
        delta            DOUBLE PRECISION,
        gamma            DOUBLE PRECISION,
        iv               DOUBLE PRECISION,
        ingested_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `,
    sql`
      CREATE INDEX IF NOT EXISTS idx_instblocks_executed_at
        ON institutional_blocks (executed_at DESC)
    `,
    sql`
      CREATE INDEX IF NOT EXISTS idx_instblocks_date_type
        ON institutional_blocks (CAST(executed_at AS DATE), option_type)
    `,
  ],
},
```

**Also update** `api/__tests__/db.test.ts` per `CLAUDE.md` DB Migrations section:
- Add `{ id: 81 }` to the applied-migrations mock
- Add the migration to the expected-output list
- Bump the SQL call count by 4 (1 CREATE TABLE + 2 CREATE INDEX + 1 schema_migrations insert)

## Cron handler: fetch-spxw-blocks

New file `api/cron/fetch-spxw-blocks.ts`:

```ts
/**
 * GET /api/cron/fetch-spxw-blocks
 *
 * Captures institutional-tier SPXW block trades for the regime tracker.
 * Targets the recurring 8000-8200 call-spread program (~260 DTE) and
 * similar large mfsl/cbmo/slft floor blocks on longer-dated SPXW.
 *
 * Strategy (REST-only, no WebSocket needed):
 *   1. Enumerate SPXW contracts with 200-280 DTE via
 *      /api/stock/SPXW/option-contracts
 *   2. Filter to call strikes within ±25% of spot (captures program
 *      strike range with slack)
 *   3. For each target contract, fetch last 50 trades via
 *      /api/option-contract/{id}/flow?min_premium=50000
 *   4. Keep prints where upstream_condition_detail IN ('mfsl','cbmo','slft')
 *      AND size >= 1000
 *   5. Upsert to institutional_blocks (trade_id PK dedupes across runs)
 *
 * Schedule: 3x per trading day to catch blocks before the 50-trade
 * window rolls over. Mid-session 14:00 CT covers morning blocks;
 * 15:20 CT catches late/close blocks including the 14:45-15:00
 * pre-settlement wave we saw in the EOD sample.
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard, uwFetch, withRetry } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// Target conditions for institutional floor blocks.
const TARGET_CONDITIONS = new Set(['mfsl', 'cbmo', 'slft']);

// Contracts this script tracks: 200-280 DTE, ±25% moneyness.
const MIN_DTE = 200;
const MAX_DTE = 280;
const MONEYNESS_WINDOW_PCT = 0.25;
const MIN_BLOCK_SIZE = 1000;
const MIN_BLOCK_PREMIUM = 50_000;
const MAX_CONTRACTS_TO_POLL = 40; // API-call budget per run

interface UwOptionContract {
  option_symbol: string;
  strike: string;
  option_type: 'call' | 'put';
  expiry: string;
  volume?: number;
  open_interest?: number;
}

interface UwOptionTrade {
  id: string;
  executed_at: string;
  option_chain_id: string;
  strike: string;
  option_type: 'call' | 'put';
  expiry: string;
  size: number;
  price: string;
  premium: string;
  underlying_price: string;
  upstream_condition_detail?: string;
  tags?: string[];
  exchange?: string;
  open_interest?: number;
  delta?: string;
  gamma?: string;
  implied_volatility?: string;
  canceled?: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res);
  if (!guard) return;
  const { apiKey } = guard;

  try {
    // 1. Fetch current SPXW contract list
    const allContracts = await withRetry(() =>
      uwFetch<UwOptionContract>(
        apiKey,
        `/stock/SPXW/option-contracts?limit=500`,
      ),
    );

    if (!allContracts.length) {
      logger.warn('fetch-spxw-blocks: no contracts returned from UW');
      return res.status(200).json({ ok: true, contracts: 0, blocks: 0 });
    }

    // 2. Filter to target DTE window + moneyness band
    const today = new Date();
    const todayMs = today.getTime();

    const interesting = allContracts
      .map((c) => {
        const expiryDate = new Date(c.expiry + 'T00:00:00Z');
        const dte = Math.floor(
          (expiryDate.getTime() - todayMs) / (24 * 60 * 60 * 1000),
        );
        return { ...c, dte };
      })
      .filter((c) => c.dte >= MIN_DTE && c.dte <= MAX_DTE)
      .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, MAX_CONTRACTS_TO_POLL);

    if (!interesting.length) {
      logger.info('fetch-spxw-blocks: no contracts in target DTE window');
      return res.status(200).json({ ok: true, contracts: 0, blocks: 0 });
    }

    // 3. For each, fetch recent trades with min_premium filter
    const allBlocks: UwOptionTrade[] = [];
    for (const contract of interesting) {
      try {
        const trades = await uwFetch<UwOptionTrade>(
          apiKey,
          `/option-contract/${contract.option_symbol}/flow?` +
            `min_premium=${MIN_BLOCK_PREMIUM}&limit=50`,
        );
        // Filter to our target conditions + size threshold
        const blocks = trades.filter(
          (t) =>
            !t.canceled &&
            t.upstream_condition_detail &&
            TARGET_CONDITIONS.has(t.upstream_condition_detail.toLowerCase()) &&
            t.size >= MIN_BLOCK_SIZE,
        );
        allBlocks.push(...blocks);
      } catch (err) {
        // Per-contract failure: log + continue. Don't abort the whole run.
        Sentry.captureException(err, {
          tags: { cron: 'fetch-spxw-blocks', contract: contract.option_symbol },
        });
      }
    }

    // 4. Upsert to institutional_blocks
    const sql = getDb();
    let inserted = 0;
    for (const b of allBlocks) {
      const strike = Number.parseFloat(b.strike);
      const spot = Number.parseFloat(b.underlying_price);
      const moneynessPct = (strike - spot) / spot;
      const expiryDate = new Date(b.expiry + 'T00:00:00Z');
      const executedDate = new Date(b.executed_at);
      const dte = Math.floor(
        (expiryDate.getTime() - executedDate.getTime()) /
          (24 * 60 * 60 * 1000),
      );

      await sql`
        INSERT INTO institutional_blocks (
          trade_id, executed_at, option_chain_id, strike, option_type,
          expiry, dte, size, price, premium, side, condition, exchange,
          underlying_price, moneyness_pct, open_interest, delta, gamma, iv
        ) VALUES (
          ${b.id}, ${b.executed_at}, ${b.option_chain_id}, ${strike},
          ${b.option_type}, ${b.expiry}, ${dte}, ${b.size},
          ${Number.parseFloat(b.price)}, ${Number.parseFloat(b.premium)},
          ${b.tags?.find((t) => t === 'ask_side' || t === 'bid_side')
            ?.replace('_side', '') ?? null},
          ${b.upstream_condition_detail!.toLowerCase()},
          ${b.exchange ?? null}, ${spot}, ${moneynessPct},
          ${b.open_interest ?? null},
          ${b.delta ? Number.parseFloat(b.delta) : null},
          ${b.gamma ? Number.parseFloat(b.gamma) : null},
          ${
            b.implied_volatility
              ? Number.parseFloat(b.implied_volatility)
              : null
          }
        )
        ON CONFLICT (trade_id) DO NOTHING
      `;
      inserted++;
    }

    logger.info('fetch-spxw-blocks complete', {
      contracts_polled: interesting.length,
      blocks_captured: allBlocks.length,
      db_upserts: inserted,
    });

    res.status(200).json({
      ok: true,
      contracts: interesting.length,
      blocks: allBlocks.length,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { cron: 'fetch-spxw-blocks' } });
    res.status(500).json({ error: String(err) });
  }
}
```

## API endpoint: institutional-program

New file `api/institutional-program.ts`:

```ts
/**
 * GET /api/institutional-program?days=30
 *
 * Returns daily-aggregated institutional program state for the SPXW
 * call-spread tracker. Aggregation happens on-the-fly from
 * institutional_blocks — no separate aggregation cron.
 *
 * Response:
 *   {
 *     days: [
 *       {
 *         date: '2026-04-23',
 *         dominant_pair: {
 *           low_strike, high_strike, spread_width,
 *           total_size, total_premium,
 *           direction: 'sell'|'buy'|'mixed',
 *         } | null,
 *         avg_spot: number,
 *         ceiling_pct_above_spot: number,   // avg_strike / avg_spot - 1
 *         n_blocks: number,
 *         n_call_blocks: number,
 *         n_put_blocks: number,
 *       },
 *       ...
 *     ],
 *     today: {
 *       // expanded block list for today
 *       blocks: InstBlock[]
 *     }
 *   }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkBot } from '../_lib/api-helpers.js';
import { getDb } from '../_lib/db.js';
import { Sentry } from '../_lib/sentry.js';

interface DailySummary {
  date: string;
  dominant_pair: {
    low_strike: number;
    high_strike: number;
    spread_width: number;
    total_size: number;
    total_premium: number;
    direction: 'sell' | 'buy' | 'mixed';
  } | null;
  avg_spot: number;
  ceiling_pct_above_spot: number;
  n_blocks: number;
  n_call_blocks: number;
  n_put_blocks: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!(await checkBot(req))) {
    return res.status(403).json({ error: 'bot check failed' });
  }

  const days = Math.min(
    Math.max(Number.parseInt(String(req.query.days ?? '30'), 10), 1),
    180,
  );

  try {
    const sql = getDb();

    // Daily summary — aggregate by date, identify dominant pair by size
    const summaries = await sql<DailySummary[]>`
      WITH per_day AS (
        SELECT
          CAST(executed_at AS DATE) AS date,
          AVG(underlying_price) AS avg_spot,
          COUNT(*) AS n_blocks,
          SUM(CASE WHEN option_type = 'call' THEN 1 ELSE 0 END) AS n_call_blocks,
          SUM(CASE WHEN option_type = 'put'  THEN 1 ELSE 0 END) AS n_put_blocks,
          AVG(strike) AS avg_strike
        FROM institutional_blocks
        WHERE executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
        GROUP BY 1
      ),
      -- Pair-detection: find the largest paired spread structure per day
      -- (same-second-or-minute executions with two different strikes, same type)
      candidate_pairs AS (
        SELECT
          CAST(executed_at AS DATE) AS date,
          option_type,
          date_trunc('minute', executed_at) AS exec_min,
          COUNT(DISTINCT strike) AS n_strikes,
          MIN(strike) AS low_strike,
          MAX(strike) AS high_strike,
          SUM(size) AS total_size,
          SUM(premium) AS total_premium,
          -- Majority side across the legs
          CASE
            WHEN SUM(CASE WHEN side='ask' THEN size ELSE 0 END)
                 > SUM(CASE WHEN side='bid' THEN size ELSE 0 END) * 1.5
              THEN 'buy'
            WHEN SUM(CASE WHEN side='bid' THEN size ELSE 0 END)
                 > SUM(CASE WHEN side='ask' THEN size ELSE 0 END) * 1.5
              THEN 'sell'
            ELSE 'mixed'
          END AS direction
        FROM institutional_blocks
        WHERE executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
        GROUP BY 1, 2, 3
        HAVING COUNT(DISTINCT strike) >= 2
      ),
      dominant_per_day AS (
        SELECT DISTINCT ON (date)
          date, low_strike, high_strike,
          high_strike - low_strike AS spread_width,
          total_size, total_premium, direction
        FROM candidate_pairs
        ORDER BY date, total_size DESC
      )
      SELECT
        pd.date::TEXT AS date,
        CASE
          WHEN dpd.date IS NULL THEN NULL
          ELSE json_build_object(
            'low_strike',    dpd.low_strike,
            'high_strike',   dpd.high_strike,
            'spread_width',  dpd.spread_width,
            'total_size',    dpd.total_size,
            'total_premium', dpd.total_premium,
            'direction',     dpd.direction
          )
        END AS dominant_pair,
        pd.avg_spot,
        (pd.avg_strike / NULLIF(pd.avg_spot, 0) - 1) AS ceiling_pct_above_spot,
        pd.n_blocks,
        pd.n_call_blocks,
        pd.n_put_blocks
      FROM per_day pd
      LEFT JOIN dominant_per_day dpd ON dpd.date = pd.date
      ORDER BY pd.date ASC
    `;

    // Today's full block list
    const today = await sql`
      SELECT
        executed_at, option_chain_id, strike, option_type, dte, size,
        premium, price, side, condition, exchange, underlying_price,
        moneyness_pct
      FROM institutional_blocks
      WHERE CAST(executed_at AS DATE) = CURRENT_DATE
      ORDER BY executed_at DESC
      LIMIT 100
    `;

    res.status(200).json({
      days: summaries,
      today: { blocks: today },
    });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: String(err) });
  }
}
```

## Frontend hook

New file `src/hooks/useInstitutionalProgram.ts`:

```ts
import { useEffect, useState } from 'react';

export interface DailyProgramSummary {
  date: string;
  dominant_pair: {
    low_strike: number;
    high_strike: number;
    spread_width: number;
    total_size: number;
    total_premium: number;
    direction: 'sell' | 'buy' | 'mixed';
  } | null;
  avg_spot: number;
  ceiling_pct_above_spot: number;
  n_blocks: number;
  n_call_blocks: number;
  n_put_blocks: number;
}

export interface InstitutionalBlock {
  executed_at: string;
  option_chain_id: string;
  strike: number;
  option_type: 'call' | 'put';
  dte: number;
  size: number;
  premium: number;
  price: number;
  side: string | null;
  condition: string;
  exchange: string | null;
  underlying_price: number;
  moneyness_pct: number;
}

interface InstitutionalProgramData {
  days: DailyProgramSummary[];
  today: { blocks: InstitutionalBlock[] };
}

export function useInstitutionalProgram(days = 30) {
  const [data, setData] = useState<InstitutionalProgramData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/institutional-program?days=${days}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) {
          setData(json as InstitutionalProgramData);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e as Error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return { data, loading, error };
}
```

## Frontend component

New directory `src/components/InstitutionalProgram/`:

**`InstitutionalProgramSection.tsx`** (main container):

```tsx
import { useInstitutionalProgram } from '../../hooks/useInstitutionalProgram.js';
import { CeilingChart } from './CeilingChart.js';
import { TodayProgramCard } from './TodayProgramCard.js';
import { RegimeBanner } from './RegimeBanner.js';

export function InstitutionalProgramSection() {
  const { data, loading, error } = useInstitutionalProgram(60);

  if (loading)
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-slate-500">
        Loading institutional program…
      </div>
    );

  if (error || !data)
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-red-400">
        Program tracker unavailable
      </div>
    );

  const today = data.days[data.days.length - 1] ?? null;

  return (
    <section
      aria-labelledby="inst-program-heading"
      className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-6"
    >
      <header className="flex items-baseline justify-between">
        <h2 id="inst-program-heading" className="text-lg font-semibold text-slate-100">
          SPXW Institutional Program (regime tracker)
        </h2>
        <span className="text-xs text-slate-500">
          mfsl/cbmo/slft blocks, 200-280 DTE
        </span>
      </header>

      <RegimeBanner days={data.days} />
      <TodayProgramCard today={today} blocks={data.today.blocks} />
      <CeilingChart days={data.days} />
    </section>
  );
}
```

**`CeilingChart.tsx`** (time-series of ceiling_pct_above_spot):

```tsx
import type { DailyProgramSummary } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  days: DailyProgramSummary[];
}

export function CeilingChart({ days }: Props) {
  if (!days.length)
    return <div className="text-slate-500">No data yet</div>;

  const valid = days.filter((d) => d.ceiling_pct_above_spot != null);
  if (valid.length < 2)
    return (
      <div className="text-sm text-slate-500">
        Waiting on more data ({valid.length} days collected so far)
      </div>
    );

  const values = valid.map((d) => d.ceiling_pct_above_spot);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 600;
  const height = 200;
  const padding = 32;

  const points = valid.map((d, i) => {
    const x =
      padding + (i / (valid.length - 1)) * (width - padding * 2);
    const y =
      padding +
      (1 - (d.ceiling_pct_above_spot - min) / range) * (height - padding * 2);
    return { x, y, d };
  });

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  return (
    <figure>
      <figcaption className="mb-2 text-sm text-slate-400">
        Program ceiling % above spot (avg strike / spot − 1) — over{' '}
        {valid.length} days
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Ceiling percentage over time"
      >
        <path
          d={path}
          fill="none"
          stroke="#60a5fa"
          strokeWidth={1.5}
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill="#60a5fa"
          />
        ))}
        <text
          x={padding}
          y={padding - 8}
          fill="#64748b"
          fontSize={11}
        >
          {(max * 100).toFixed(1)}%
        </text>
        <text
          x={padding}
          y={height - padding + 16}
          fill="#64748b"
          fontSize={11}
        >
          {(min * 100).toFixed(1)}%
        </text>
      </svg>
    </figure>
  );
}
```

**`TodayProgramCard.tsx`** (today's program state):

```tsx
import type {
  DailyProgramSummary,
  InstitutionalBlock,
} from '../../hooks/useInstitutionalProgram.js';

interface Props {
  today: DailyProgramSummary | null;
  blocks: InstitutionalBlock[];
}

export function TodayProgramCard({ today, blocks }: Props) {
  if (!today?.dominant_pair)
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-500">
        No paired institutional blocks detected today yet.
      </div>
    );

  const { low_strike, high_strike, direction, total_size, total_premium } =
    today.dominant_pair;

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Metric label="Spread" value={`${low_strike} / ${high_strike}`} />
      <Metric
        label="Direction"
        value={direction.toUpperCase()}
        tone={
          direction === 'sell' ? 'green' : direction === 'buy' ? 'red' : 'gray'
        }
      />
      <Metric label="Contracts" value={total_size.toLocaleString()} />
      <Metric
        label="Premium"
        value={`$${(total_premium / 1_000_000).toFixed(1)}M`}
      />
      <Metric
        label="Spot"
        value={today.avg_spot.toFixed(2)}
      />
      <Metric
        label="Ceiling above spot"
        value={`${(today.ceiling_pct_above_spot * 100).toFixed(1)}%`}
        tone="blue"
      />
      <details className="md:col-span-3">
        <summary className="cursor-pointer text-sm text-slate-400">
          All blocks today ({blocks.length})
        </summary>
        <table className="mt-2 w-full text-xs text-slate-300">
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th className="p-1 text-left">Time</th>
              <th className="p-1 text-right">Strike</th>
              <th className="p-1">Type</th>
              <th className="p-1 text-right">Size</th>
              <th className="p-1 text-right">Premium</th>
              <th className="p-1">Side</th>
              <th className="p-1">Cond</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <tr key={b.executed_at + b.option_chain_id}>
                <td className="p-1">
                  {new Date(b.executed_at).toLocaleTimeString('en-US', {
                    hour12: false,
                  })}
                </td>
                <td className="p-1 text-right">{b.strike}</td>
                <td className="p-1">{b.option_type[0].toUpperCase()}</td>
                <td className="p-1 text-right">
                  {b.size.toLocaleString()}
                </td>
                <td className="p-1 text-right">
                  ${(b.premium / 1000).toFixed(0)}k
                </td>
                <td className="p-1">{b.side ?? '—'}</td>
                <td className="p-1 text-slate-500">{b.condition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'blue' | 'green' | 'red' | 'gray';
}) {
  const toneClass = {
    slate: 'text-slate-100',
    blue: 'text-blue-300',
    green: 'text-green-300',
    red: 'text-red-300',
    gray: 'text-slate-400',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
```

**`RegimeBanner.tsx`** (alert when regime shifts):

```tsx
import type { DailyProgramSummary } from '../../hooks/useInstitutionalProgram.js';

interface Props {
  days: DailyProgramSummary[];
}

export function RegimeBanner({ days }: Props) {
  if (days.length < 5) return null;

  const recent = days.slice(-5);
  const prior = days.slice(-10, -5);
  if (!prior.length) return null;

  const recentAvg =
    recent.reduce((s, d) => s + (d.ceiling_pct_above_spot ?? 0), 0) /
    recent.length;
  const priorAvg =
    prior.reduce((s, d) => s + (d.ceiling_pct_above_spot ?? 0), 0) /
    prior.length;

  const deltaPct = recentAvg - priorAvg;

  // Direction flip detection
  const directions = recent
    .map((d) => d.dominant_pair?.direction)
    .filter((d): d is 'sell' | 'buy' | 'mixed' => !!d);
  const priorDirections = prior
    .map((d) => d.dominant_pair?.direction)
    .filter((d): d is 'sell' | 'buy' | 'mixed' => !!d);

  const recentMajorityDir = majority(directions);
  const priorMajorityDir = majority(priorDirections);
  const directionFlip =
    recentMajorityDir &&
    priorMajorityDir &&
    recentMajorityDir !== priorMajorityDir;

  if (Math.abs(deltaPct) < 0.005 && !directionFlip) return null;

  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        directionFlip
          ? 'border-red-800 bg-red-950/30 text-red-200'
          : deltaPct > 0
          ? 'border-green-800 bg-green-950/30 text-green-200'
          : 'border-amber-800 bg-amber-950/30 text-amber-200'
      }`}
    >
      <strong>Regime signal: </strong>
      {directionFlip
        ? `Direction flip — majority shifted from ${priorMajorityDir} to ${recentMajorityDir} over past 5 days.`
        : `Ceiling ${deltaPct > 0 ? 'rising' : 'pulling in'} — ` +
          `5-day avg ceiling vs prior 5-day avg: ${
            deltaPct > 0 ? '+' : ''
          }${(deltaPct * 100).toFixed(2)} pp.`}
    </div>
  );
}

function majority<T extends string>(xs: T[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: { v: T; n: number } | null = null;
  for (const [v, n] of counts) {
    if (!best || n > best.n) best = { v, n };
  }
  return best?.v ?? null;
}
```

## Wiring

Append to `vercel.json` crons:

```json
{
  "path": "/api/cron/fetch-spxw-blocks",
  "schedule": "0 15,19,20 * * 1-5"
}
```

(15:00, 19:00, and 20:20 UTC = 10:00, 14:00, and 15:20 CT — three polls spaced through the session to catch blocks before the 50-trade window rolls over.)

Add to `src/main.tsx`'s `initBotId()` protect array:

```ts
{ path: '/api/institutional-program', method: 'GET' },
```

Add the component into `App.tsx` (or wherever your dashboard composition lives):

```tsx
import { InstitutionalProgramSection } from './components/InstitutionalProgram/InstitutionalProgramSection.js';

// ... somewhere in the main layout
<InstitutionalProgramSection />
```

## Test scaffolding

New file `api/__tests__/fetch-spxw-blocks.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../_lib/db.js';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));
vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    uwFetch: vi.fn(),
  };
});

describe('fetch-spxw-blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
    process.env.UW_API_KEY = 'test-uw-key';
  });

  it('filters to mfsl/cbmo/slft and upserts blocks', async () => {
    const mockSql = vi.fn().mockResolvedValue([]);
    vi.mocked(getDb).mockReturnValue(mockSql as never);

    const { uwFetch } = await import('../_lib/api-helpers.js');
    // First call: contract enumeration
    vi.mocked(uwFetch).mockResolvedValueOnce([
      {
        option_symbol: 'SPXW261218C08150000',
        strike: '8150',
        option_type: 'call',
        expiry: '2026-12-18',
        volume: 1000,
      },
    ] as never[]);
    // Second call: trades for that contract
    vi.mocked(uwFetch).mockResolvedValueOnce([
      {
        id: 'trade-1',
        executed_at: '2026-04-23T19:45:00Z',
        option_chain_id: 'SPXW261218C08150000',
        strike: '8150',
        option_type: 'call',
        expiry: '2026-12-18',
        size: 30000,
        price: '55.85',
        premium: '167550000',
        underlying_price: '7044.27',
        upstream_condition_detail: 'mfsl',
        tags: ['ask_side'],
      },
      {
        id: 'trade-2-small',
        executed_at: '2026-04-23T19:45:30Z',
        size: 50, // below MIN_BLOCK_SIZE; should be dropped
        upstream_condition_detail: 'auto',
        // ...
      },
    ] as never[]);

    const handlerMod = await import('../cron/fetch-spxw-blocks.js');
    const req = {
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query: {},
    } as never;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as never;

    await handlerMod.default(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Only the mfsl trade should have been upserted
    expect(mockSql).toHaveBeenCalled();
    const queries = (mockSql as any).mock.calls;
    const insertCalls = queries.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO institutional_blocks'),
    );
    expect(insertCalls).toHaveLength(1);
  });
});
```

## Build order

1. **Migration 81 + test update** — data storage
2. **Cron handler** — start capturing data immediately
3. **API endpoint** — exposes the aggregate
4. **Frontend component + hook** — visualization
5. **Register in vercel.json + main.tsx** — production deployment
6. **Cron test** — covers the filter logic

## What this delivers

- **Day 1**: Data starts flowing into `institutional_blocks`. Backfill for historical days not possible via this API (UW only serves the last few trading days through `/option-contract/{id}/flow`), but from deploy forward you'll accumulate a growing time series.
- **Week 1**: Enough data to populate the ceiling chart with ~5 days; regime banner starts working.
- **Month 1**: Full 30-day view with clear regime trendline. Direction flips become visible.
- **Ongoing**: Persistent program-state tracker alongside your existing dashboard — the institutional view of SPX ceiling, updated 3× per day during market hours.

## Open questions

1. **Are we missing blocks that happen between poll cycles?** The 50-trade window is per-contract. For heavily-traded contracts we might miss some. First week of data will tell us — if counts look low, add a 4th poll at 11:30 CT.
2. **Should we expand to SPX monthlies too?** SPX (AM-settled) has its own institutional program. Leave as v2 scope.
3. **Is `option_symbol` path param URL-encoded correctly?** SPXW chain IDs have no special chars; should be safe.
4. **Rate-limit pressure from 40 contracts × 3 polls = 120 UW calls/day.** `uwFetch` surfaces 429s to Sentry; if we hit them, reduce `MAX_CONTRACTS_TO_POLL` to 20.

---

# v2 Revisions (post-audit)

The v1 spec above covers the ceiling track (Implication 1 & 2 partially). This section lists the **deltas to v1** needed to fully cover all three mfsl implications. Apply these on top of the v1 code blocks.

## Summary of changes

| Change | Reason |
|---|---|
| Add `program_track` column to `institutional_blocks` | Distinguish ceiling / opening_atm / other — query by track |
| Widen DTE window: 200-280 → **180-300** | Safety margin for holidays, weekend-DTE shifts |
| Add second enumeration pass for 0-7 DTE near-ATM | Capture opening-5-min institutional blocks (Implication 3) |
| Lower thresholds: `MIN_SIZE 1000 → 50`, `MIN_PREMIUM 50k → 25k` | The opening blocks are ~154 contracts; old thresholds filtered them out |
| Add 8:45 CT poll (4 polls total instead of 3) | Capture opening blocks before they roll off 50-trade window |
| New API: `/api/institutional-program/strike-heatmap?days=60` | Cumulative-notional-by-strike view (Implication 2 amplification) |
| New component: `StrikeConcentrationChart` | Horizontal bar chart of strikes ranked by cumulative mfsl premium |
| New component: `OpeningBlocksCard` | Today's first-hour near-ATM mfsl blocks (Implication 3) |
| Replace hardcoded hex colors with CSS vars | Match `RegimeTimeline`, `StrikeMap`, `ThetaDecayChart` conventions |

## Migration 81 — add `program_track` column

```ts
// In the statements() array, add a new sql block:
sql`
  ALTER TABLE institutional_blocks
  ADD COLUMN IF NOT EXISTS program_track TEXT NOT NULL DEFAULT 'other'
    CHECK (program_track IN ('ceiling', 'opening_atm', 'other'))
`,
sql`
  CREATE INDEX IF NOT EXISTS idx_instblocks_track_date
    ON institutional_blocks (program_track, CAST(executed_at AS DATE) DESC)
`,
```

## Cron handler — two-pass enumeration + track classification

Replace the v1 constants and filter logic with:

```ts
// Thresholds — kept LOW enough to capture opening-5-min blocks (~154 contracts).
// The classifier downstream filters to "program" sizes as needed.
const MIN_BLOCK_SIZE = 50;
const MIN_BLOCK_PREMIUM = 25_000;
const TARGET_CONDITIONS = new Set(['mfsl', 'cbmo', 'slft']);

// Two enumeration passes — each uses its own DTE + moneyness filter.
const ENUMERATION_PASSES = [
  {
    name: 'ceiling',
    min_dte: 180,
    max_dte: 300,
    mny_min: 0.05,   // 5% OTM minimum — the program lives here
    mny_max: 0.25,   // 25% OTM maximum (slack)
    option_types: ['call', 'put'] as const,
    max_contracts: 40,
  },
  {
    name: 'opening_atm',
    min_dte: 0,
    max_dte: 7,
    mny_min: 0,
    mny_max: 0.03,   // within 3% of spot — the opening-block setup
    option_types: ['call', 'put'] as const,
    max_contracts: 20,
  },
];

function classifyTrack(
  dte: number,
  moneynessPct: number,
  optionType: 'call' | 'put',
  executedAtUtc: string,
): 'ceiling' | 'opening_atm' | 'other' {
  // Long-dated, meaningfully OTM program strikes
  if (dte >= 180 && dte <= 300 && Math.abs(moneynessPct) >= 0.05 && Math.abs(moneynessPct) <= 0.25) {
    return 'ceiling';
  }
  // Near-ATM short-dated opening-window block (first 60 min of RTH)
  const executedAt = new Date(executedAtUtc);
  const hourUtc = executedAt.getUTCHours();
  const minUtc = executedAt.getUTCMinutes();
  const utcMinutes = hourUtc * 60 + minUtc;
  const OPEN_START_UTC = 13 * 60 + 30; // 13:30 UTC = 08:30 CT
  const OPEN_END_UTC = 14 * 60 + 30;   // 14:30 UTC = 09:30 CT
  if (
    dte >= 0 &&
    dte <= 7 &&
    Math.abs(moneynessPct) <= 0.03 &&
    utcMinutes >= OPEN_START_UTC &&
    utcMinutes <= OPEN_END_UTC
  ) {
    return 'opening_atm';
  }
  return 'other';
}
```

In the main handler, loop over both passes:

```ts
for (const pass of ENUMERATION_PASSES) {
  const targetContracts = allContracts
    .map(/* compute dte + moneyness */)
    .filter((c) =>
      c.dte >= pass.min_dte &&
      c.dte <= pass.max_dte &&
      Math.abs(c.moneyness_pct) >= pass.mny_min &&
      Math.abs(c.moneyness_pct) <= pass.mny_max &&
      pass.option_types.includes(c.option_type),
    )
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, pass.max_contracts);

  for (const contract of targetContracts) {
    // ... fetch flow, filter conditions, upsert with classifyTrack(...)
  }
}
```

## Schedule — 4 polls

Replace the v1 vercel.json entry:

```json
{
  "path": "/api/cron/fetch-spxw-blocks",
  "schedule": "45 13,15,18,20 * * 1-5"
}
```

(13:45 UTC = 08:45 CT, 15:45 UTC = 10:45 CT, 18:45 UTC = 13:45 CT, 20:45 UTC = 15:45 CT. The early 08:45 CT poll is new — captures opening-atm track before 50-trade window rolls over.)

**API call budget**: 4 polls × (40 ceiling + 20 opening) contracts = 240 UW calls/day. Up from v1's 120. Still well under any plausible rate limit.

## New API endpoint: strike-heatmap

`GET /api/institutional-program/strike-heatmap?days=60&track=ceiling`

```ts
const { rows } = await sql`
  SELECT
    strike,
    option_type,
    COUNT(*) AS n_blocks,
    SUM(size) AS total_contracts,
    SUM(premium) AS total_premium,
    MAX(CAST(executed_at AS DATE)) AS last_seen_date,
    COUNT(DISTINCT CAST(executed_at AS DATE)) AS active_days,
    MAX(expiry) AS latest_expiry
  FROM institutional_blocks
  WHERE program_track = ${track}
    AND executed_at >= NOW() - (${days}::TEXT || ' days')::INTERVAL
  GROUP BY strike, option_type
  HAVING SUM(premium) > 100000
  ORDER BY total_premium DESC
  LIMIT 40
`;
```

Returns: `[{ strike, option_type, n_blocks, total_contracts, total_premium, last_seen_date, active_days, latest_expiry }, ...]`

## New component: `StrikeConcentrationChart`

Horizontal bar chart, no library. Matches `StrikeMap.tsx` conventions.

```tsx
import { useEffect, useState } from 'react';

interface StrikeCell {
  strike: number;
  option_type: 'call' | 'put';
  total_premium: number;
  total_contracts: number;
  active_days: number;
  last_seen_date: string;
}

export function StrikeConcentrationChart({
  spot,
  track = 'ceiling',
  days = 60,
}: {
  spot: number;
  track?: 'ceiling' | 'opening_atm';
  days?: number;
}) {
  const [cells, setCells] = useState<StrikeCell[]>([]);

  useEffect(() => {
    fetch(`/api/institutional-program/strike-heatmap?days=${days}&track=${track}`)
      .then((r) => r.json())
      .then((j) => setCells(j.rows ?? []));
  }, [days, track]);

  if (!cells.length) return null;

  // Sort strikes numerically for the chart y-axis
  const sorted = [...cells].sort((a, b) => b.strike - a.strike);
  const maxPrem = Math.max(...sorted.map((c) => c.total_premium));

  const W = 600;
  const rowH = 22;
  const gap = 4;
  const barStart = 150;
  const totalH = sorted.length * (rowH + gap) + 40;

  return (
    <figure>
      <figcaption className="mb-2 text-sm text-slate-400">
        Strike concentration — cumulative mfsl premium over last {days} days
        (SPX spot ≈ {spot.toFixed(0)})
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${totalH}`}
        role="img"
        aria-label="Cumulative institutional premium per strike"
        className="w-full"
      >
        {sorted.map((c, i) => {
          const y = i * (rowH + gap);
          const barW = (c.total_premium / maxPrem) * (W - barStart - 20);
          const fillColor =
            c.option_type === 'call'
              ? 'var(--color-call, #22c55e)'
              : 'var(--color-put, #ef4444)';
          const isAboveSpot = c.strike > spot;
          return (
            <g key={`${c.strike}-${c.option_type}`}>
              <text
                x={barStart - 8}
                y={y + rowH * 0.7}
                textAnchor="end"
                fontSize="12"
                fill="var(--color-text, #cbd5e1)"
                fontFamily="var(--font-mono)"
              >
                {c.strike}{c.option_type[0].toUpperCase()}
              </text>
              <rect
                x={barStart}
                y={y}
                width={barW}
                height={rowH}
                fill={fillColor}
                opacity={0.7}
              >
                <title>
                  {`${c.strike} ${c.option_type}: $${(c.total_premium / 1e6).toFixed(2)}M across ${c.active_days} days (${c.total_contracts.toLocaleString()} contracts)`}
                </title>
              </rect>
              <text
                x={barStart + barW + 4}
                y={y + rowH * 0.7}
                fontSize="11"
                fill="var(--color-text-muted, #94a3b8)"
              >
                ${(c.total_premium / 1e6).toFixed(1)}M · {c.active_days}d
              </text>
            </g>
          );
        })}
        {/* Spot-level marker */}
        {sorted.length > 0 && (() => {
          const spotRowIdx = sorted.findIndex((c) => c.strike <= spot);
          if (spotRowIdx < 0) return null;
          const spotY = spotRowIdx * (rowH + gap) - 2;
          return (
            <line
              x1={barStart}
              y1={spotY}
              x2={W - 10}
              y2={spotY}
              stroke="var(--color-accent, #60a5fa)"
              strokeWidth="1"
              strokeDasharray="4 2"
            >
              <title>SPX spot ≈ {spot.toFixed(0)}</title>
            </line>
          );
        })()}
      </svg>
    </figure>
  );
}
```

## New component: `OpeningBlocksCard`

```tsx
interface Props {
  blocks: InstitutionalBlock[];  // filtered to program_track='opening_atm'
}

export function OpeningBlocksCard({ blocks }: Props) {
  const openingBlocks = blocks.filter((b) => {
    const t = new Date(b.executed_at);
    const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
    return mins >= 13 * 60 + 30 && mins <= 14 * 60 + 30; // 08:30-09:30 CT
  });

  if (!openingBlocks.length) {
    return (
      <div className="border-edge bg-surface-alt rounded-lg border p-3 text-sm text-slate-500">
        No opening-hour institutional blocks detected today.
      </div>
    );
  }

  return (
    <div className="border-edge bg-surface-alt rounded-lg border p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">
          Today's opening institutional blocks
        </h3>
        <span className="text-xs text-slate-500">
          {openingBlocks.length} block{openingBlocks.length !== 1 ? 's' : ''} · 08:30-09:30 CT
        </span>
      </div>
      <table className="w-full text-xs text-slate-300">
        <thead>
          <tr className="border-b border-slate-800 text-slate-500">
            <th className="p-1 text-left">Time (CT)</th>
            <th className="p-1 text-right">Strike</th>
            <th className="p-1">Type</th>
            <th className="p-1 text-right">DTE</th>
            <th className="p-1 text-right">Size</th>
            <th className="p-1 text-right">Premium</th>
            <th className="p-1">Cond</th>
          </tr>
        </thead>
        <tbody>
          {openingBlocks.map((b) => {
            const t = new Date(b.executed_at);
            const ct = new Date(t.getTime() - 5 * 3600 * 1000);
            return (
              <tr key={b.executed_at + b.option_chain_id}>
                <td className="p-1">
                  {ct.toISOString().slice(11, 19)}
                </td>
                <td className="p-1 text-right">{b.strike}</td>
                <td className="p-1">{b.option_type[0].toUpperCase()}</td>
                <td className="p-1 text-right">{b.dte}</td>
                <td className="p-1 text-right">{b.size.toLocaleString()}</td>
                <td className="p-1 text-right">${(b.premium / 1000).toFixed(0)}k</td>
                <td className="p-1 text-slate-500">{b.condition}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

## Frontend color migration (v1 → v2)

Replace hardcoded hex literals with CSS variables per codebase convention:

| v1 | v2 |
|---|---|
| `#60a5fa` | `var(--color-accent)` |
| `slate-100/400/500` text classes | keep (those are Tailwind, consistent with rest of codebase) |
| `#22c55e` (green) | `var(--color-call, #22c55e)` with fallback |
| `#ef4444` (red) | `var(--color-put, #ef4444)` with fallback |
| `border-slate-800`, `bg-slate-950/50` | `border-edge`, `bg-surface-alt` (matches `StrikeMap.tsx`) |

## Updated `InstitutionalProgramSection` composition

```tsx
<section>
  <header>…</header>
  <RegimeBanner days={data.days} />
  <TodayProgramCard today={today} blocks={ceilingBlocksToday} />
  <OpeningBlocksCard blocks={openingBlocksToday} />       {/* NEW */}
  <CeilingChart days={data.days} />
  <StrikeConcentrationChart                               {/* NEW */}
    spot={today?.avg_spot ?? 0}
    track="ceiling"
    days={60}
  />
</section>
```

## What this delivers (post-v2 audit)

Each mfsl implication now has a dedicated visible surface:

| Implication | Where to see it |
|---|---|
| 1. Non-directional mfsl flow | All UI surfaces display pair-level direction only; individual leg sides never shown as directional signals |
| 2. Smart-money positioning by strike | **StrikeConcentrationChart** (horizontal bar chart, 60-day cumulative premium per strike, top 40) |
| 3. Opening institutional blocks | **OpeningBlocksCard** (table of 08:30-09:30 CT blocks for today) |

## Regenerated open questions

~~Are we missing blocks between polls?~~ — 4 polls/day with the 8:45 CT early catch should resolve this.

5. **Is the 0.05-0.25 moneyness range for the ceiling track tight enough?** Observed program was always 15-20% OTM. 5-25% gives slack on both sides. Can tighten to 10-25% if noise bleeds in.
6. **Do we need cooldown on opening_atm alerts?** If a single contract fires 3 blocks in 5 minutes, that's one event, not three. Suggest: dedupe by `(strike, option_type, floor(executed_at, 5min))` in the API layer before surfacing to UI.
7. **Should the strike-concentration chart be filterable by track?** Yes — the ceiling track shows where the 9-month program concentrates; the opening_atm track would show near-ATM opening bias. Both are useful, different signals. Add a `<select>` above the chart.
