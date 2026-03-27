# ES Overnight Futures Sidecar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a sidecar process that captures ES futures overnight data via Tradovate WebSocket, stores 1-minute bars in Neon Postgres, computes overnight analytics via a Vercel cron job, and injects the results into Claude's analysis context.

**Architecture:** Sidecar on Railway (long-running Node.js, `pg` driver) writes to shared Neon DB. Vercel cron at 9:35 AM ET reads overnight bars, computes 6 gap-analysis calculations, writes summary. `api/analyze.ts` reads summary and formats for Claude.

**Tech Stack:** Node.js 24, TypeScript, `pg` (sidecar DB), `ws` (WebSocket), `pino` (logging), Vitest (testing), `@neondatabase/serverless` (Vercel cron DB), Docker (Railway deploy)

**Spec:** `docs/superpowers/specs/2026-03-26-es-overnight-sidecar-design.md`

**Parallelization:** Tasks 1 is a prerequisite. After Task 1, the sidecar tasks (2-10) and Vercel tasks (11-13) can run in parallel since they only share the DB schema.

---

## Task 1: Database Migrations

**Files:**

- Modify: `api/_lib/db.ts` (add migrations #12 and #13 to MIGRATIONS array)

- [ ] **Step 1: Add migration #12 — `es_bars` table**

In `api/_lib/db.ts`, add to the `MIGRATIONS` array after the last entry (migration #11, around line 605):

```typescript
  {
    id: 12,
    description:
      'Create es_bars table for ES futures 1-minute OHLCV bars from sidecar',
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

- [ ] **Step 2: Add migration #13 — `es_overnight_summaries` table**

Immediately after migration #12 in the same array:

```typescript
  {
    id: 13,
    description:
      'Create es_overnight_summaries table for pre-computed overnight ES metrics',
    run: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS es_overnight_summaries (
          id                  SERIAL PRIMARY KEY,
          trade_date          DATE NOT NULL UNIQUE,
          globex_open         NUMERIC(10,2),
          globex_high         NUMERIC(10,2),
          globex_low          NUMERIC(10,2),
          globex_close        NUMERIC(10,2),
          vwap                NUMERIC(10,2),
          total_volume        INTEGER,
          bar_count           INTEGER,
          range_pts           NUMERIC(10,2),
          range_pct           NUMERIC(6,4),
          cash_open           NUMERIC(10,2),
          prev_cash_close     NUMERIC(10,2),
          gap_pts             NUMERIC(10,2),
          gap_pct             NUMERIC(6,4),
          gap_direction       TEXT,
          gap_size_class      TEXT,
          cash_open_pct_rank  NUMERIC(6,2),
          position_class      TEXT,
          vol_20d_avg         INTEGER,
          vol_ratio           NUMERIC(6,2),
          vol_class           TEXT,
          gap_vs_vwap_pts     NUMERIC(10,2),
          vwap_signal         TEXT,
          fill_score          INTEGER,
          fill_probability    TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    },
  },
```

- [ ] **Step 3: Run migrations**

Run the dev server and hit the init endpoint:

```bash
npm run dev:full &
sleep 5
curl -X POST -H "Cookie: sc-owner=$(grep OWNER_SECRET .env.local | cut -d= -f2)" http://localhost:3000/api/journal/init
```

Expected: Response includes `"migrated": ["#12: Create es_bars...", "#13: Create es_overnight_summaries..."]`

- [ ] **Step 4: Verify tables exist**

Connect to Neon and check:

```bash
npx dotenv -e .env.local -- node -e "
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  sql\`SELECT table_name FROM information_schema.tables WHERE table_name IN ('es_bars', 'es_overnight_summaries')\`.then(r => console.log(r));
"
```

Expected: Both tables listed.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/db.ts
git commit -m "feat: add es_bars and es_overnight_summaries migrations (#12, #13)"
```

---

## Task 2: Sidecar Scaffold

**Files:**

- Create: `sidecar/package.json`
- Create: `sidecar/tsconfig.json`
- Create: `sidecar/.env.example`
- Create: `sidecar/Dockerfile`
- Create: `sidecar/src/logger.ts`
- Create: `sidecar/.gitignore`

- [ ] **Step 1: Create sidecar directory and package.json**

```bash
mkdir -p sidecar/src
```

Create `sidecar/package.json`:

```json
{
  "name": "es-relay-sidecar",
  "private": true,
  "type": "module",
  "engines": {
    "node": "24.x"
  },
  "scripts": {
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "pg": "^8.16.0",
    "pino": "^10.3.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "@types/ws": "^8.18.0",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `sidecar/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create .env.example**

Create `sidecar/.env.example`:

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

- [ ] **Step 4: Create .gitignore**

Create `sidecar/.gitignore`:

```
node_modules/
dist/
.env
.env.local
```

- [ ] **Step 5: Create Dockerfile**

Create `sidecar/Dockerfile`:

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

- [ ] **Step 6: Create logger**

Create `sidecar/src/logger.ts`:

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

- [ ] **Step 7: Install dependencies**

```bash
cd sidecar && npm install && cd ..
```

Expected: `package-lock.json` created, `node_modules/` populated.

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd sidecar && npx tsc --noEmit && cd ..
```

Expected: No errors (logger.ts is the only source file).

- [ ] **Step 9: Commit**

```bash
git add sidecar/
git commit -m "feat: scaffold sidecar directory with package.json, Dockerfile, logger"
```

---

## Task 3: Bar Aggregator (TDD)

The bar aggregator is pure logic — no I/O. Ideal for TDD.

**Files:**

- Create: `sidecar/src/bar-aggregator.ts`
- Create: `sidecar/src/__tests__/bar-aggregator.test.ts`

- [ ] **Step 1: Write failing tests for bar aggregation**

Create `sidecar/src/__tests__/bar-aggregator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BarAggregator, type Bar } from '../bar-aggregator.js';

describe('BarAggregator', () => {
  let flushed: Bar[];
  let aggregator: BarAggregator;

  beforeEach(() => {
    flushed = [];
    aggregator = new BarAggregator((bar) => {
      flushed.push(bar);
    });
  });

  it('creates a bar from the first tick', () => {
    aggregator.onTick({
      price: 5825.5,
      cumulativeVolume: 1000,
      timestamp: new Date('2026-03-26T02:15:30Z'),
    });
    const current = aggregator.getCurrentBar();
    expect(current).not.toBeNull();
    expect(current!.open).toBe(5825.5);
    expect(current!.high).toBe(5825.5);
    expect(current!.low).toBe(5825.5);
    expect(current!.close).toBe(5825.5);
    expect(current!.tickCount).toBe(1);
  });

  it('updates OHLC within the same minute', () => {
    const base = new Date('2026-03-26T02:15:00Z');
    aggregator.onTick({ price: 5825.0, cumulativeVolume: 1000, timestamp: new Date(base.getTime() + 10_000) });
    aggregator.onTick({ price: 5830.0, cumulativeVolume: 1005, timestamp: new Date(base.getTime() + 20_000) });
    aggregator.onTick({ price: 5820.0, cumulativeVolume: 1010, timestamp: new Date(base.getTime() + 30_000) });
    aggregator.onTick({ price: 5827.5, cumulativeVolume: 1015, timestamp: new Date(base.getTime() + 40_000) });

    const current = aggregator.getCurrentBar();
    expect(current!.open).toBe(5825.0);
    expect(current!.high).toBe(5830.0);
    expect(current!.low).toBe(5820.0);
    expect(current!.close).toBe(5827.5);
    expect(current!.tickCount).toBe(4);
  });

  it('flushes when minute boundary is crossed', () => {
    aggregator.onTick({ price: 5825.0, cumulativeVolume: 1000, timestamp: new Date('2026-03-26T02:15:10Z') });
    aggregator.onTick({ price: 5826.0, cumulativeVolume: 1005, timestamp: new Date('2026-03-26T02:15:30Z') });
    // New minute
    aggregator.onTick({ price: 5828.0, cumulativeVolume: 1010, timestamp: new Date('2026-03-26T02:16:05Z') });

    expect(flushed).toHaveLength(1);
    expect(flushed[0].open).toBe(5825.0);
    expect(flushed[0].close).toBe(5826.0);
    expect(flushed[0].ts.toISOString()).toBe('2026-03-26T02:15:00.000Z');
  });

  it('computes volume as delta of cumulative values', () => {
    aggregator.onTick({ price: 5825.0, cumulativeVolume: 1000, timestamp: new Date('2026-03-26T02:15:10Z') });
    aggregator.onTick({ price: 5826.0, cumulativeVolume: 1050, timestamp: new Date('2026-03-26T02:15:30Z') });
    aggregator.onTick({ price: 5828.0, cumulativeVolume: 1070, timestamp: new Date('2026-03-26T02:16:05Z') });

    expect(flushed[0].volume).toBe(50); // 1050 - 1000
  });

  it('handles session reset (cumulative drops to lower value)', () => {
    aggregator.onTick({ price: 5825.0, cumulativeVolume: 500000, timestamp: new Date('2026-03-26T02:15:10Z') });
    aggregator.onTick({ price: 5826.0, cumulativeVolume: 500050, timestamp: new Date('2026-03-26T02:15:30Z') });
    // New minute — cumulative reset (maintenance break)
    aggregator.onTick({ price: 5828.0, cumulativeVolume: 100, timestamp: new Date('2026-03-26T02:16:05Z') });

    expect(flushed[0].volume).toBe(50); // 500050 - 500000
    // New bar starts fresh with the reset cumulative
    const current = aggregator.getCurrentBar();
    expect(current!.tickCount).toBe(1);
  });

  it('flush() writes partial bar and resets', () => {
    aggregator.onTick({ price: 5825.0, cumulativeVolume: 1000, timestamp: new Date('2026-03-26T02:15:10Z') });
    aggregator.flush();

    expect(flushed).toHaveLength(1);
    expect(flushed[0].close).toBe(5825.0);
    expect(aggregator.getCurrentBar()).toBeNull();
  });

  it('flush() is a no-op when no bar exists', () => {
    aggregator.flush();
    expect(flushed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npx vitest run && cd ..
```

Expected: All tests FAIL (module `../bar-aggregator.js` not found).

- [ ] **Step 3: Implement bar aggregator**

Create `sidecar/src/bar-aggregator.ts`:

```typescript
export interface Tick {
  price: number;
  cumulativeVolume: number;
  timestamp: Date;
}

export interface Bar {
  symbol: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickCount: number;
}

type FlushCallback = (bar: Bar) => void;

function minuteFloor(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export class BarAggregator {
  private currentBar: Bar | null = null;
  private currentMinute: number = 0;
  private barStartCumVolume: number = 0;
  private lastCumVolume: number = 0;
  private readonly onFlush: FlushCallback;
  private readonly symbol: string;

  constructor(onFlush: FlushCallback, symbol = 'ES') {
    this.onFlush = onFlush;
    this.symbol = symbol;
  }

  onTick(tick: Tick): void {
    const minuteTs = minuteFloor(tick.timestamp).getTime();

    if (this.currentBar && minuteTs !== this.currentMinute) {
      // Finalize volume for the completed bar
      this.currentBar.volume = this.lastCumVolume - this.barStartCumVolume;
      this.onFlush(this.currentBar);
      this.currentBar = null;
    }

    if (!this.currentBar) {
      // Detect session reset: cumulative dropped below previous
      const isReset =
        this.lastCumVolume > 0 &&
        tick.cumulativeVolume < this.lastCumVolume;

      this.currentMinute = minuteTs;
      this.barStartCumVolume = isReset
        ? 0
        : (this.lastCumVolume || tick.cumulativeVolume);
      this.currentBar = {
        symbol: this.symbol,
        ts: minuteFloor(tick.timestamp),
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: 0,
        tickCount: 1,
      };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, tick.price);
      this.currentBar.low = Math.min(this.currentBar.low, tick.price);
      this.currentBar.close = tick.price;
      this.currentBar.tickCount++;
    }

    this.lastCumVolume = tick.cumulativeVolume;
  }

  flush(): void {
    if (!this.currentBar) return;
    this.currentBar.volume = this.lastCumVolume - this.barStartCumVolume;
    this.onFlush(this.currentBar);
    this.currentBar = null;
  }

  getCurrentBar(): Bar | null {
    return this.currentBar;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npx vitest run && cd ..
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/bar-aggregator.ts sidecar/src/__tests__/bar-aggregator.test.ts
git commit -m "feat(sidecar): add bar aggregator with TDD tests"
```

---

## Task 4: Tradovate Message Parser (TDD)

Pure function that parses Tradovate's two-layer framing.

**Files:**

- Create: `sidecar/src/tradovate-parser.ts`
- Create: `sidecar/src/__tests__/tradovate-parser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `sidecar/src/__tests__/tradovate-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFrame, type TradovateFrame } from '../tradovate-parser.js';

describe('parseFrame', () => {
  it('parses open frame', () => {
    const result = parseFrame('o');
    expect(result).toEqual({ type: 'open' });
  });

  it('parses heartbeat frame', () => {
    const result = parseFrame('h');
    expect(result).toEqual({ type: 'heartbeat' });
  });

  it('parses close frame', () => {
    const result = parseFrame('c[1000,"Normal closure"]');
    expect(result).toEqual({ type: 'close', code: 1000, reason: 'Normal closure' });
  });

  it('parses data frame with market data quote', () => {
    const payload = JSON.stringify([JSON.stringify({
      e: 'md',
      d: {
        quotes: [{
          timestamp: '2026-03-26T02:15:00Z',
          contractId: 123456,
          entries: {
            Trade: { price: 5825.5, size: 2 },
            TotalTradeVolume: { size: 41180 },
            HighPrice: { price: 5830.25 },
            LowPrice: { price: 5810.5 },
          },
        }],
      },
    })]);
    const result = parseFrame('a' + payload);
    expect(result.type).toBe('data');
    if (result.type === 'data') {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].e).toBe('md');
      expect(result.messages[0].d.quotes[0].entries.Trade.price).toBe(5825.5);
    }
  });

  it('parses data frame with response message', () => {
    const payload = JSON.stringify([JSON.stringify({ s: 200, i: 1, d: {} })]);
    const result = parseFrame('a' + payload);
    expect(result.type).toBe('data');
    if (result.type === 'data') {
      expect(result.messages[0].s).toBe(200);
    }
  });

  it('parses shutdown event', () => {
    const payload = JSON.stringify([JSON.stringify({
      e: 'shutdown',
      d: { reasonCode: 'ConnectionQuotaReached' },
    })]);
    const result = parseFrame('a' + payload);
    if (result.type === 'data') {
      expect(result.messages[0].e).toBe('shutdown');
      expect(result.messages[0].d.reasonCode).toBe('ConnectionQuotaReached');
    }
  });

  it('returns unknown for unrecognized frames', () => {
    const result = parseFrame('x[garbage]');
    expect(result).toEqual({ type: 'unknown', raw: 'x[garbage]' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npx vitest run src/__tests__/tradovate-parser.test.ts && cd ..
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement parser**

Create `sidecar/src/tradovate-parser.ts`:

```typescript
export type TradovateFrame =
  | { type: 'open' }
  | { type: 'heartbeat' }
  | { type: 'close'; code: number; reason: string }
  | { type: 'data'; messages: TradovateMessage[] }
  | { type: 'unknown'; raw: string };

export interface TradovateMessage {
  // Event message
  e?: string;
  d?: Record<string, unknown>;
  // Response message
  s?: number;
  i?: number;
}

export function parseFrame(raw: string): TradovateFrame {
  if (!raw || raw.length === 0) return { type: 'unknown', raw: '' };

  const prefix = raw[0];

  switch (prefix) {
    case 'o':
      return { type: 'open' };

    case 'h':
      return { type: 'heartbeat' };

    case 'c': {
      try {
        const arr = JSON.parse(raw.slice(1)) as [number, string];
        return { type: 'close', code: arr[0], reason: arr[1] };
      } catch {
        return { type: 'close', code: 0, reason: raw.slice(1) };
      }
    }

    case 'a': {
      try {
        const outerArray = JSON.parse(raw.slice(1)) as string[];
        const messages: TradovateMessage[] = outerArray.map(
          (jsonStr) => JSON.parse(jsonStr) as TradovateMessage,
        );
        return { type: 'data', messages };
      } catch {
        return { type: 'unknown', raw };
      }
    }

    default:
      return { type: 'unknown', raw };
  }
}

/**
 * Build an outbound Tradovate WebSocket message.
 * Format: endpoint\nrequestId\n\n{json_body}
 */
export function buildMessage(
  endpoint: string,
  requestId: number,
  body: Record<string, unknown>,
): string {
  return `${endpoint}\n${requestId}\n\n${JSON.stringify(body)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npx vitest run src/__tests__/tradovate-parser.test.ts && cd ..
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/tradovate-parser.ts sidecar/src/__tests__/tradovate-parser.test.ts
git commit -m "feat(sidecar): add Tradovate WebSocket frame parser with tests"
```

---

## Task 5: Contract Roller (TDD)

Resolves the current front-month ES futures symbol.

**Files:**

- Create: `sidecar/src/contract-roller.ts`
- Create: `sidecar/src/__tests__/contract-roller.test.ts`

- [ ] **Step 1: Write failing tests**

Create `sidecar/src/__tests__/contract-roller.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveContractSymbol } from '../contract-roller.js';

describe('resolveContractSymbol', () => {
  // ES rolls quarterly: H(Mar), M(Jun), U(Sep), Z(Dec)
  // Roll happens ~7 days before 3rd Friday of expiry month

  it('returns ESM6 in early April 2026 (June is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-04-15'))).toBe('ESM6');
  });

  it('returns ESU6 in early July 2026 (September is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-07-01'))).toBe('ESU6');
  });

  it('returns ESZ6 in early October 2026 (December is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2026-10-15'))).toBe('ESZ6');
  });

  it('returns ESH7 in early January 2027 (March 2027 is next expiry)', () => {
    expect(resolveContractSymbol(new Date('2027-01-10'))).toBe('ESH7');
  });

  it('rolls to next quarter within 7 days of expiry', () => {
    // June 2026 expiry: 3rd Friday = June 19, 2026
    // 7 days before = June 12
    // On June 13 (within 7 days), should roll to ESU6
    expect(resolveContractSymbol(new Date('2026-06-13'))).toBe('ESU6');
  });

  it('stays on current quarter when > 7 days from expiry', () => {
    // On June 10 (>7 days before June 19), still ESM6
    expect(resolveContractSymbol(new Date('2026-06-10'))).toBe('ESM6');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sidecar && npx vitest run src/__tests__/contract-roller.test.ts && cd ..
```

Expected: FAIL.

- [ ] **Step 3: Implement contract roller**

Create `sidecar/src/contract-roller.ts`:

```typescript
const QUARTER_MONTHS = [3, 6, 9, 12] as const;
const MONTH_CODES: Record<number, string> = {
  3: 'H',
  6: 'M',
  9: 'U',
  12: 'Z',
};

/**
 * Find the third Friday of a given month/year.
 */
function thirdFriday(year: number, month: number): Date {
  // month is 1-indexed
  const firstDay = new Date(year, month - 1, 1);
  const dayOfWeek = firstDay.getDay();
  // First Friday: if day 0 is Sunday(0), first Friday is day 5
  // Formula: (5 - dayOfWeek + 7) % 7 gives days until first Friday
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7);
  const third = firstFriday + 14;
  return new Date(year, month - 1, third);
}

/**
 * Resolve the current front-month ES contract symbol using local date math.
 * Falls back to this when the Tradovate API is unavailable.
 */
export function resolveContractSymbol(now: Date = new Date()): string {
  const year = now.getFullYear();

  for (const month of QUARTER_MONTHS) {
    const expiryYear = month < (now.getMonth() + 1) ? year + 1 : year;
    const adjustedMonth = month < (now.getMonth() + 1) ? month : month;
    const adjustedYear = month < (now.getMonth() + 1) ? year + 1 : year;

    const expiry = thirdFriday(adjustedYear, adjustedMonth);
    const rollDate = new Date(expiry);
    rollDate.setDate(rollDate.getDate() - 7);

    if (now < rollDate) {
      const code = MONTH_CODES[adjustedMonth];
      const yearDigit = adjustedYear % 10;
      return `ES${code}${yearDigit}`;
    }
  }

  // If past all this year's roll dates, use Q1 next year
  const nextYear = year + 1;
  return `ESH${nextYear % 10}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sidecar && npx vitest run src/__tests__/contract-roller.test.ts && cd ..
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/contract-roller.ts sidecar/src/__tests__/contract-roller.test.ts
git commit -m "feat(sidecar): add ES contract roller with quarterly roll logic"
```

---

## Task 6: Tradovate Auth Module

**Files:**

- Create: `sidecar/src/tradovate-auth.ts`

- [ ] **Step 1: Implement auth module**

Create `sidecar/src/tradovate-auth.ts`:

```typescript
import logger from './logger.js';

interface AccessTokenResponse {
  accessToken?: string;
  expirationTime?: string;
  userId?: number;
  name?: string;
  errorText?: string;
}

interface TokenState {
  accessToken: string;
  expiresAt: number;
  userId: number;
}

const RENEW_BUFFER_MS = 15 * 60 * 1000; // 15 min before expiry
let tokenState: TokenState | null = null;
let renewInFlight: Promise<TokenState> | null = null;

function getBaseUrl(): string {
  const url = process.env.TRADOVATE_BASE_URL;
  if (!url) throw new Error('TRADOVATE_BASE_URL not configured');
  return url;
}

function parseTokenResponse(body: AccessTokenResponse): TokenState {
  if (body.errorText) {
    throw new Error(`Tradovate auth error: ${body.errorText}`);
  }
  if (!body.accessToken || !body.expirationTime) {
    throw new Error('Tradovate auth: missing accessToken or expirationTime');
  }
  return {
    accessToken: body.accessToken,
    expiresAt: new Date(body.expirationTime).getTime(),
    userId: body.userId ?? 0,
  };
}

async function acquireToken(): Promise<TokenState> {
  const baseUrl = getBaseUrl();
  logger.info('Acquiring Tradovate access token');

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      appId: process.env.TRADOVATE_APP_ID ?? 'strike-calculator-sidecar',
      appVersion: process.env.TRADOVATE_APP_VERSION ?? '1.0',
      deviceId: process.env.TRADOVATE_DEVICE_ID,
      cid: process.env.TRADOVATE_CID,
      sec: process.env.TRADOVATE_SECRET,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body: AccessTokenResponse = await res.json();
  const state = parseTokenResponse(body);
  logger.info(
    { userId: state.userId, expiresAt: new Date(state.expiresAt).toISOString() },
    'Tradovate token acquired',
  );
  return state;
}

async function renewToken(currentToken: string): Promise<TokenState> {
  const baseUrl = getBaseUrl();
  logger.info('Renewing Tradovate access token');

  const res = await fetch(`${baseUrl}/auth/renewaccesstoken`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });

  const body: AccessTokenResponse = await res.json();
  const state = parseTokenResponse(body);
  logger.info(
    { expiresAt: new Date(state.expiresAt).toISOString() },
    'Tradovate token renewed',
  );
  return state;
}

export async function getAccessToken(): Promise<string> {
  // Token still valid
  if (tokenState && tokenState.expiresAt > Date.now() + RENEW_BUFFER_MS) {
    return tokenState.accessToken;
  }

  // Token exists but nearing expiry — renew (not re-acquire)
  if (tokenState) {
    if (!renewInFlight) {
      renewInFlight = renewToken(tokenState.accessToken)
        .catch(async (err) => {
          logger.warn({ err }, 'Token renewal failed, re-acquiring');
          return acquireToken();
        })
        .finally(() => {
          renewInFlight = null;
        });
    }
    tokenState = await renewInFlight;
    return tokenState.accessToken;
  }

  // No token — first-time acquisition
  tokenState = await acquireToken();
  return tokenState.accessToken;
}

/** Force clear token state (e.g., on auth errors) */
export function clearTokenState(): void {
  tokenState = null;
  renewInFlight = null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd sidecar && npx tsc --noEmit && cd ..
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/tradovate-auth.ts
git commit -m "feat(sidecar): add Tradovate auth with 90-min token lifecycle and renewal"
```

---

## Task 7: Database Writer

**Files:**

- Create: `sidecar/src/db.ts`

- [ ] **Step 1: Implement pg pool and upsert helper**

Create `sidecar/src/db.ts`:

```typescript
import pg from 'pg';
import type { Bar } from './bar-aggregator.js';
import logger from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not configured');
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function verifyConnection(): Promise<void> {
  const p = getPool();
  const result = await p.query('SELECT 1 AS ok');
  if (result.rows[0]?.ok !== 1) {
    throw new Error('Database connection verification failed');
  }
  logger.info('Database connection verified');
}

export async function upsertBar(bar: Bar): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO es_bars (symbol, ts, open, high, low, close, volume, tick_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (symbol, ts) DO UPDATE SET
       open       = es_bars.open,
       high       = GREATEST(es_bars.high, EXCLUDED.high),
       low        = LEAST(es_bars.low, EXCLUDED.low),
       close      = EXCLUDED.close,
       volume     = GREATEST(es_bars.volume, EXCLUDED.volume),
       tick_count = GREATEST(es_bars.tick_count, EXCLUDED.tick_count)`,
    [bar.symbol, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.tickCount],
  );
}

export async function drainPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool drained');
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd sidecar && npx tsc --noEmit && cd ..
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/db.ts
git commit -m "feat(sidecar): add pg connection pool and bar upsert helper"
```

---

## Task 8: WebSocket Client

**Files:**

- Create: `sidecar/src/tradovate-ws.ts`

- [ ] **Step 1: Implement WebSocket client**

Create `sidecar/src/tradovate-ws.ts`:

```typescript
import WebSocket from 'ws';
import { parseFrame, buildMessage, type TradovateMessage } from './tradovate-parser.js';
import logger from './logger.js';

const HEARTBEAT_INTERVAL_MS = 2_500;

export interface WsCallbacks {
  onQuote: (quote: TradovateQuote) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
}

export interface TradovateQuote {
  timestamp: string;
  contractId: number;
  entries: Record<string, { price?: number; size?: number }>;
}

export class TradovateWsClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private requestId = 0;
  private readonly wsUrl: string;
  private readonly callbacks: WsCallbacks;
  private subscribedSymbol: string | null = null;

  constructor(wsUrl: string, callbacks: WsCallbacks) {
    this.wsUrl = wsUrl;
    this.callbacks = callbacks;
  }

  connect(accessToken: string, symbol: string): void {
    this.subscribedSymbol = symbol;
    logger.info({ url: this.wsUrl, symbol }, 'Connecting to Tradovate WebSocket');

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString();
      const frame = parseFrame(raw);

      switch (frame.type) {
        case 'open':
          logger.info('WebSocket open, sending authorization');
          this.send(buildMessage('authorize', this.nextId(), { token: accessToken }));
          this.startHeartbeat();
          break;

        case 'heartbeat':
          // Server is alive, no action needed
          break;

        case 'data':
          this.handleMessages(frame.messages, symbol);
          break;

        case 'close':
          logger.warn({ code: frame.code, reason: frame.reason }, 'WebSocket close frame received');
          this.cleanup();
          this.callbacks.onDisconnected(frame.reason);
          break;

        case 'unknown':
          logger.debug({ raw: frame.raw?.slice(0, 100) }, 'Unknown frame');
          break;
      }
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.cleanup();
      this.callbacks.onDisconnected(reason.toString() || `code ${code}`);
    });
  }

  private handleMessages(messages: TradovateMessage[], symbol: string): void {
    for (const msg of messages) {
      // Auth response
      if (msg.s !== undefined) {
        if (msg.s === 200) {
          logger.info('Authorized, subscribing to quotes');
          this.send(buildMessage('md/subscribeQuote', this.nextId(), { symbol }));
          this.callbacks.onConnected();
        } else {
          logger.error({ status: msg.s, data: msg.d }, 'Auth/subscribe failed');
        }
        continue;
      }

      // Shutdown event
      if (msg.e === 'shutdown') {
        const reasonCode = (msg.d as Record<string, string>)?.reasonCode ?? 'unknown';
        logger.warn({ reasonCode }, 'Tradovate shutdown event');
        this.cleanup();
        this.callbacks.onDisconnected(`shutdown: ${reasonCode}`);
        return;
      }

      // Market data quotes
      if (msg.e === 'md' && msg.d) {
        const quotes = (msg.d as { quotes?: TradovateQuote[] }).quotes;
        if (quotes) {
          for (const quote of quotes) {
            this.callbacks.onQuote(quote);
          }
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('[]');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private send(message: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect(): void {
    if (this.subscribedSymbol && this.ws?.readyState === WebSocket.OPEN) {
      this.send(
        buildMessage('md/unsubscribeQuote', this.nextId(), { symbol: this.subscribedSymbol }),
      );
    }
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd sidecar && npx tsc --noEmit && cd ..
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/tradovate-ws.ts
git commit -m "feat(sidecar): add Tradovate WebSocket client with heartbeat and quote parsing"
```

---

## Task 9: Health Check Server

**Files:**

- Create: `sidecar/src/health.ts`

- [ ] **Step 1: Implement health endpoint**

Create `sidecar/src/health.ts`:

```typescript
import http from 'node:http';
import logger from './logger.js';

interface HealthDeps {
  isWsConnected: () => boolean;
  lastQuoteAt: () => number;
  isDbHealthy: () => Promise<boolean>;
}

/**
 * ES maintenance break is 5:00-6:00 PM ET daily.
 * Weekends: no quotes expected.
 */
function isQuoteExpected(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false; // weekend
  const hour = et.getHours();
  // Maintenance break: 5:00 PM (17) to 6:00 PM (18) ET
  if (hour === 17) return false;
  return true;
}

export function startHealthServer(deps: HealthDeps): http.Server {
  const port = parseInt(process.env.PORT ?? '8080', 10);

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const checks = {
      ws: deps.isWsConnected(),
      quoteFresh: true,
      db: false,
    };

    // Only check quote freshness during expected trading hours
    if (isQuoteExpected()) {
      const staleness = Date.now() - deps.lastQuoteAt();
      checks.quoteFresh = staleness < 120_000; // 2 minutes
    }

    try {
      checks.db = await deps.isDbHealthy();
    } catch {
      checks.db = false;
    }

    const healthy = checks.ws && checks.quoteFresh && checks.db;
    const status = healthy ? 200 : 503;

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks }));
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });

  return server;
}
```

- [ ] **Step 2: Commit**

```bash
git add sidecar/src/health.ts
git commit -m "feat(sidecar): add health check server with market-hours-aware staleness"
```

---

## Task 10: Main Orchestrator

**Files:**

- Create: `sidecar/src/main.ts`

- [ ] **Step 1: Implement main entry point**

Create `sidecar/src/main.ts`:

```typescript
import { getAccessToken, clearTokenState } from './tradovate-auth.js';
import { TradovateWsClient, type TradovateQuote } from './tradovate-ws.js';
import { BarAggregator, type Tick } from './bar-aggregator.js';
import { resolveContractSymbol } from './contract-roller.js';
import { upsertBar, verifyConnection, drainPool, getPool } from './db.js';
import { startHealthServer } from './health.js';
import logger from './logger.js';

// ── State ───────────────────────────────────────────────────

let lastQuoteTime = 0;
let wsClient: TradovateWsClient | null = null;
let aggregator: BarAggregator | null = null;
let safetyFlushTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

// ── Quote handler ───────────────────────────────────────────

function handleQuote(quote: TradovateQuote): void {
  const trade = quote.entries.Trade;
  const totalVol = quote.entries.TotalTradeVolume;
  if (!trade?.price) return; // Skip quotes without trade data

  lastQuoteTime = Date.now();

  const tick: Tick = {
    price: trade.price,
    cumulativeVolume: totalVol?.size ?? 0,
    timestamp: new Date(quote.timestamp),
  };

  aggregator?.onTick(tick);
}

// ── Reconnect loop ──────────────────────────────────────────

async function connectWithRetry(): Promise<void> {
  let backoff = 1000;
  const MAX_BACKOFF = 30_000;

  while (!isShuttingDown) {
    try {
      const token = await getAccessToken();
      const symbol = resolveContractSymbol();

      const wsUrl = process.env.TRADOVATE_MD_URL;
      if (!wsUrl) throw new Error('TRADOVATE_MD_URL not configured');

      aggregator = new BarAggregator(async (bar) => {
        try {
          await upsertBar(bar);
          logger.debug(
            { ts: bar.ts.toISOString(), o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume },
            'Bar flushed',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to upsert bar');
        }
      }, symbol);

      // Safety flush: ensure partial bar is written even if no new quotes
      safetyFlushTimer = setInterval(() => {
        aggregator?.flush();
      }, 60_000);

      return await new Promise<void>((resolve) => {
        wsClient = new TradovateWsClient(wsUrl, {
          onQuote: handleQuote,
          onConnected: () => {
            backoff = 1000; // reset on successful connection
            logger.info({ symbol }, 'Sidecar ready — receiving quotes');
          },
          onDisconnected: (reason) => {
            logger.warn({ reason }, 'Disconnected');
            // Flush partial bar before reconnecting
            aggregator?.flush();
            if (safetyFlushTimer) clearInterval(safetyFlushTimer);
            resolve(); // Exit promise so retry loop continues
          },
        });

        wsClient.connect(token, symbol);
      });
    } catch (err) {
      logger.error({ err, backoff }, 'Connection attempt failed');
    }

    if (isShuttingDown) break;
    logger.info({ backoff }, 'Reconnecting after backoff');
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
}

// ── Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('ES relay sidecar starting');

  // Validate required env vars
  const required = ['DATABASE_URL', 'TRADOVATE_BASE_URL', 'TRADOVATE_MD_URL', 'TRADOVATE_USERNAME', 'TRADOVATE_PASSWORD'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error({ key }, 'Missing required environment variable');
      process.exit(1);
    }
  }

  // Verify database connection
  await verifyConnection();

  // Start health server
  startHealthServer({
    isWsConnected: () => wsClient?.isConnected ?? false,
    lastQuoteAt: () => lastQuoteTime,
    isDbHealthy: async () => {
      try {
        await getPool().query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  });

  // Enter reconnect loop (runs indefinitely)
  while (!isShuttingDown) {
    await connectWithRetry();
  }
}

// ── Graceful shutdown ───────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Shutting down gracefully');

  wsClient?.disconnect();
  aggregator?.flush();
  if (safetyFlushTimer) clearInterval(safetyFlushTimer);

  // Give the last flush a moment to complete
  await new Promise((r) => setTimeout(r, 1000));
  await drainPool();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error({ err }, 'Fatal error in main');
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd sidecar && npx tsc --noEmit && cd ..
```

Expected: No errors.

- [ ] **Step 3: Run all sidecar tests**

```bash
cd sidecar && npx vitest run && cd ..
```

Expected: All tests pass (bar-aggregator, tradovate-parser, contract-roller).

- [ ] **Step 4: Commit**

```bash
git add sidecar/src/main.ts
git commit -m "feat(sidecar): add main orchestrator with reconnect loop and graceful shutdown"
```

---

## Task 11: Claude Formatter (TDD)

**Files:**

- Create: `api/es-overnight.ts`
- Create: `api/__tests__/es-overnight.test.ts`

- [ ] **Step 1: Write failing tests**

Create `api/__tests__/es-overnight.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatEsOvernightForClaude,
  type EsOvernightSummaryRow,
} from '../es-overnight.js';

const baseSummary: EsOvernightSummaryRow = {
  trade_date: '2026-03-26',
  globex_open: '6520.50',
  globex_high: '6548.25',
  globex_low: '6520.50',
  globex_close: '6545.00',
  vwap: '6536.80',
  total_volume: '487000',
  bar_count: '1042',
  range_pts: '27.75',
  range_pct: '0.0043',
  cash_open: '6545.00',
  prev_cash_close: '6530.00',
  gap_pts: '15.00',
  gap_pct: '0.2300',
  gap_direction: 'UP',
  gap_size_class: 'MODERATE',
  cash_open_pct_rank: '91.00',
  position_class: 'AT_GLOBEX_HIGH',
  vol_20d_avg: '465000',
  vol_ratio: '1.05',
  vol_class: 'NORMAL',
  gap_vs_vwap_pts: '8.20',
  vwap_signal: 'SUPPORTED',
  fill_score: '35',
  fill_probability: 'MODERATE',
};

describe('formatEsOvernightForClaude', () => {
  it('returns null for null input', () => {
    expect(formatEsOvernightForClaude(null as unknown as EsOvernightSummaryRow)).toBeNull();
  });

  it('includes range line with high and low', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('6520.50');
    expect(result).toContain('6548.25');
    expect(result).toContain('27.75 pts');
  });

  it('includes volume with classification', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('487K');
    expect(result).toContain('NORMAL');
    expect(result).toContain('1.05x');
  });

  it('includes gap analysis', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('+15.0');
    expect(result).toContain('UP');
    expect(result).toContain('MODERATE');
    expect(result).toContain('91');
    expect(result).toContain('AT GLOBEX HIGH');
  });

  it('includes fill probability', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).toContain('MODERATE');
    expect(result).toContain('35');
  });

  it('adds cone comparison when cone bounds provided', () => {
    const result = formatEsOvernightForClaude(baseSummary, 6600, 6460)!;
    // coneWidth = 140, rangePts = 27.75, pct = 19.8%
    expect(result).toContain('straddle cone');
  });

  it('omits cone line when no cone bounds', () => {
    const result = formatEsOvernightForClaude(baseSummary)!;
    expect(result).not.toContain('straddle cone');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run api/__tests__/es-overnight.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement formatter**

Create `api/es-overnight.ts`:

```typescript
/**
 * Formats pre-computed ES overnight summary for Claude analysis context.
 * Follows the same pattern as formatIvTermStructureForClaude() in iv-term-structure.ts.
 */

export interface EsOvernightSummaryRow {
  trade_date: string;
  globex_open: string;
  globex_high: string;
  globex_low: string;
  globex_close: string;
  vwap: string;
  total_volume: string;
  bar_count: string;
  range_pts: string;
  range_pct: string;
  cash_open: string;
  prev_cash_close: string;
  gap_pts: string;
  gap_pct: string;
  gap_direction: string;
  gap_size_class: string;
  cash_open_pct_rank: string;
  position_class: string;
  vol_20d_avg: string;
  vol_ratio: string;
  vol_class: string;
  gap_vs_vwap_pts: string;
  vwap_signal: string;
  fill_score: string;
  fill_probability: string;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${Math.round(vol / 1_000)}K`;
  return String(vol);
}

export function formatEsOvernightForClaude(
  row: EsOvernightSummaryRow,
  coneUpper?: number | null,
  coneLower?: number | null,
): string | null {
  if (!row) return null;

  const rangePts = parseFloat(row.range_pts);
  const totalVol = parseInt(row.total_volume);
  const volRatio = parseFloat(row.vol_ratio);
  const gapPts = parseFloat(row.gap_pts);
  const gapPct = parseFloat(row.gap_pct);
  const pctRank = parseFloat(row.cash_open_pct_rank);
  const vwapPts = parseFloat(row.gap_vs_vwap_pts);
  const fillScore = parseInt(row.fill_score);

  const lines: string[] = [];

  // Header with range
  let rangeSuffix = '';
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    if (coneWidth > 0) {
      const conePct = (rangePts / coneWidth) * 100;
      rangeSuffix = `, ${conePct.toFixed(0)}% of straddle cone`;
    }
  }
  lines.push('ES Overnight Session (Globex 6:00 PM – 9:30 AM ET):');
  lines.push(
    `  Range: ${parseFloat(row.globex_low).toFixed(2)} – ${parseFloat(row.globex_high).toFixed(2)} (${rangePts.toFixed(2)} pts${rangeSuffix})`,
  );
  lines.push(
    `  Volume: ${formatVolume(totalVol)} contracts (${row.vol_class}, ${volRatio.toFixed(2)}x 20-day avg)`,
  );
  lines.push(`  VWAP: ${parseFloat(row.vwap).toFixed(2)}`);

  // Gap analysis
  lines.push('');
  lines.push('  Gap Analysis:');
  const sign = gapPts >= 0 ? '+' : '';
  lines.push(
    `    Cash Open: ${parseFloat(row.cash_open).toFixed(2)} | Previous Close: ${parseFloat(row.prev_cash_close).toFixed(2)} | Gap: ${sign}${gapPts.toFixed(1)} pts ${row.gap_direction} (${gapPct.toFixed(2)}%)`,
  );
  lines.push(`    Gap Size: ${row.gap_size_class}`);

  const positionLabel = row.position_class.replace(/_/g, ' ');
  lines.push(
    `    Open Position: ${pctRank.toFixed(0)}th percentile of overnight range (${positionLabel})`,
  );

  const vwapDir = vwapPts >= 0 ? 'above' : 'below';
  const vwapLabel =
    row.vwap_signal === 'SUPPORTED'
      ? 'gap has support'
      : 'fade likely';
  lines.push(
    `    Open vs VWAP: ${vwapPts >= 0 ? '+' : ''}${vwapPts.toFixed(1)} pts ${vwapDir} overnight VWAP (${vwapLabel})`,
  );

  // Fill probability
  lines.push('');
  lines.push(`  Gap Fill Probability: ${row.fill_probability} (score: ${fillScore})`);

  // 0DTE implications
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    if (coneWidth > 0) {
      const conePct = (rangePts / coneWidth) * 100;
      const remaining = 100 - conePct;
      lines.push('');
      lines.push('  Implication for 0DTE:');
      lines.push(
        `    Overnight range consumed ${conePct.toFixed(0)}% of straddle cone — ${remaining.toFixed(0)}% remaining.`,
      );
      if (row.gap_direction === 'UP') {
        lines.push(
          '    Gap direction (UP) aligns with bullish flow if confirmed at open.',
        );
      } else if (row.gap_direction === 'DOWN') {
        lines.push(
          '    Gap direction (DOWN) aligns with bearish flow if confirmed at open.',
        );
      }
      if (row.fill_probability === 'HIGH') {
        lines.push(
          '    Watch for gap fill in first 30 min — consider fade structures.',
        );
      } else if (row.fill_probability === 'LOW') {
        lines.push(
          '    Gap extension likely — favor directional structures with the gap.',
        );
      }
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run api/__tests__/es-overnight.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add api/es-overnight.ts api/__tests__/es-overnight.test.ts
git commit -m "feat: add formatEsOvernightForClaude with TDD tests"
```

---

## Task 12: Cron Handler — compute-es-overnight

**Files:**

- Create: `api/cron/compute-es-overnight.ts`

- [ ] **Step 1: Implement the cron handler**

Create `api/cron/compute-es-overnight.ts`:

```typescript
/**
 * GET /api/cron/compute-es-overnight
 *
 * Runs at 9:35 AM ET on weekdays. Reads overnight ES bars (6:00 PM ET
 * previous trading day → 9:30 AM ET today), computes gap analysis
 * metrics, and writes a summary row for Claude context injection.
 *
 * Schedule: 35 13,14 * * 1-5 (DST-safe: skips if before 9:30 AM ET)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../_lib/db.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { schwabFetch } from '../_lib/api-helpers.js';

// ── Time helpers ────────────────────────────────────────────

function getETNow(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
  );
}

function isAfterCashOpen(): boolean {
  const et = getETNow();
  const totalMin = et.getHours() * 60 + et.getMinutes();
  return totalMin >= 570; // 9:30 AM
}

function getTodayET(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
}

/**
 * Get previous trading day's 6:00 PM ET as a UTC timestamp.
 * On Monday → Friday 6:00 PM ET. On Tue-Fri → yesterday 6:00 PM ET.
 */
function getOvernightStart(todayET: string): Date {
  const today = new Date(todayET + 'T00:00:00');
  const dayOfWeek = today.getDay();
  const daysBack = dayOfWeek === 1 ? 3 : 1; // Monday → go back to Friday
  const prevDay = new Date(today);
  prevDay.setDate(prevDay.getDate() - daysBack);
  // 6:00 PM ET = 22:00 or 23:00 UTC depending on DST
  // Use toLocaleString trick to get proper offset
  const dateStr = prevDay.toISOString().slice(0, 10);
  return new Date(`${dateStr}T18:00:00-04:00`); // EDT; adjust for EST if needed
}

function getOvernightEnd(todayET: string): Date {
  return new Date(`${todayET}T09:30:00-04:00`); // EDT
}

// ── Gap classification helpers ──────────────────────────────

function classifyGapSize(absGap: number): string {
  if (absGap < 5) return 'NEGLIGIBLE';
  if (absGap < 15) return 'SMALL';
  if (absGap < 30) return 'MODERATE';
  if (absGap < 50) return 'LARGE';
  return 'EXTREME';
}

function classifyPosition(pctRank: number): string {
  if (pctRank > 90) return 'AT_GLOBEX_HIGH';
  if (pctRank > 70) return 'NEAR_HIGH';
  if (pctRank > 30) return 'MID_RANGE';
  if (pctRank > 10) return 'NEAR_LOW';
  return 'AT_GLOBEX_LOW';
}

function classifyVolume(
  totalVolume: number,
  avg20d: number | null,
): { volRatio: number; volClass: string } {
  if (avg20d && avg20d > 0) {
    const ratio = totalVolume / avg20d;
    let cls: string;
    if (ratio < 0.6) cls = 'LIGHT';
    else if (ratio < 1.0) cls = 'NORMAL';
    else if (ratio < 1.5) cls = 'ELEVATED';
    else cls = 'HEAVY';
    return { volRatio: ratio, volClass: cls };
  }
  // Absolute fallback
  let cls: string;
  if (totalVolume < 300_000) cls = 'LIGHT';
  else if (totalVolume < 500_000) cls = 'NORMAL';
  else if (totalVolume < 700_000) cls = 'ELEVATED';
  else cls = 'HEAVY';
  return { volRatio: 0, volClass: cls };
}

function classifyVwapSignal(
  gapUp: boolean,
  gapVsVwapPts: number,
): string {
  if (gapUp && gapVsVwapPts > 0) return 'SUPPORTED';
  if (gapUp && gapVsVwapPts <= 0) return 'OVERSHOOT_FADE';
  if (!gapUp && gapVsVwapPts < 0) return 'SUPPORTED';
  return 'OVERSHOOT_FADE';
}

function computeFillScore(
  absGap: number,
  volRatio: number,
  pctRank: number,
  vwapSignal: string,
): { score: number; probability: string } {
  let score = 0;

  // Size factor
  if (absGap < 10) score += 30;
  else if (absGap < 20) score += 15;
  else if (absGap >= 40) score -= 20;

  // Volume factor
  if (volRatio < 0.6) score += 25;
  else if (volRatio < 1.0) score += 10;
  else if (volRatio < 1.5) score -= 10;
  else score -= 25;

  // Position factor
  if (pctRank > 90 || pctRank < 10) score += 20;
  else if (pctRank > 70 || pctRank < 30) score += 5;
  else score -= 10;

  // VWAP factor
  if (vwapSignal === 'OVERSHOOT_FADE') score += 20;
  else score -= 15;

  let probability: string;
  if (score > 50) probability = 'HIGH';
  else if (score > 20) probability = 'MODERATE';
  else probability = 'LOW';

  return { score, probability };
}

// ── Handler ─────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // DST-safe guard
  if (!isAfterCashOpen()) {
    return res
      .status(200)
      .json({ skipped: true, reason: 'Before cash open (9:30 AM ET)' });
  }

  const sql = getDb();
  const tradeDate = getTodayET();

  try {
    // 1. Query overnight bars
    const overnightStart = getOvernightStart(tradeDate);
    const overnightEnd = getOvernightEnd(tradeDate);

    const bars = await sql`
      SELECT
        (ARRAY_AGG(open ORDER BY ts ASC))[1]        AS globex_open,
        MAX(high)                                     AS globex_high,
        MIN(low)                                      AS globex_low,
        (ARRAY_AGG(close ORDER BY ts DESC))[1]        AS globex_close,
        SUM(((high + low + close) / 3) * volume) / NULLIF(SUM(volume), 0) AS vwap,
        SUM(volume)                                   AS total_volume,
        COUNT(*)                                      AS bar_count
      FROM es_bars
      WHERE symbol = 'ES'
        AND ts >= ${overnightStart.toISOString()}
        AND ts <  ${overnightEnd.toISOString()}
    `;

    if (!bars[0]?.globex_open) {
      logger.info({ tradeDate }, 'No overnight ES bars found');
      return res.status(200).json({ skipped: true, reason: 'No overnight bars' });
    }

    const overnight = bars[0];
    const globexHigh = parseFloat(overnight.globex_high);
    const globexLow = parseFloat(overnight.globex_low);
    const vwap = parseFloat(overnight.vwap);
    const totalVolume = parseInt(overnight.total_volume);
    const rangePts = globexHigh - globexLow;

    // 2. Get previous SPX settlement
    const prevOutcome = await sql`
      SELECT settlement FROM outcomes
      WHERE date < ${tradeDate}
      ORDER BY date DESC LIMIT 1
    `;
    const prevCashClose = prevOutcome[0]?.settlement
      ? parseFloat(prevOutcome[0].settlement)
      : null;

    // 3. Get today's SPX open from Schwab intraday candles
    let cashOpen: number | null = null;
    try {
      const intradayResult = await schwabFetch<{
        candles?: Array<{ open: number; datetime: number }>;
      }>(
        `/marketdata/v1/pricehistory?symbol=$SPX&periodType=day&period=1&frequencyType=minute&frequency=5`,
      );
      if ('data' in intradayResult && intradayResult.data.candles?.length) {
        cashOpen = intradayResult.data.candles[0].open;
      }
    } catch (err) {
      logger.warn({ err }, 'Could not fetch SPX open from Schwab');
    }

    // Fallback: if no Schwab data, use globex close as approximation
    if (!cashOpen) cashOpen = parseFloat(overnight.globex_close);

    // 4. Compute all classifications
    const gapPts = prevCashClose ? cashOpen - prevCashClose : 0;
    const gapPct = prevCashClose ? (gapPts / prevCashClose) * 100 : 0;
    const gapDirection = gapPts >= 0 ? 'UP' : 'DOWN';
    const gapSizeClass = classifyGapSize(Math.abs(gapPts));

    const globexRange = globexHigh - globexLow;
    const cashOpenPctRank =
      globexRange > 0 ? ((cashOpen - globexLow) / globexRange) * 100 : 50;
    const positionClass = classifyPosition(cashOpenPctRank);

    // 20-day rolling volume average
    const histVol = await sql`
      SELECT total_volume FROM es_overnight_summaries
      WHERE trade_date < ${tradeDate}
      ORDER BY trade_date DESC LIMIT 20
    `;
    const avg20d =
      histVol.length > 0
        ? histVol.reduce(
            (sum: number, r: { total_volume: number }) => sum + r.total_volume,
            0,
          ) / histVol.length
        : null;

    const { volRatio, volClass } = classifyVolume(totalVolume, avg20d);

    const gapVsVwapPts = cashOpen - vwap;
    const vwapSignal = classifyVwapSignal(gapPts >= 0, gapVsVwapPts);

    const { score: fillScore, probability: fillProbability } =
      computeFillScore(
        Math.abs(gapPts),
        volRatio,
        cashOpenPctRank,
        vwapSignal,
      );

    const rangePct = prevCashClose ? rangePts / prevCashClose : 0;

    // 5. Upsert summary
    await sql`
      INSERT INTO es_overnight_summaries (
        trade_date, globex_open, globex_high, globex_low, globex_close,
        vwap, total_volume, bar_count, range_pts, range_pct,
        cash_open, prev_cash_close, gap_pts, gap_pct, gap_direction,
        gap_size_class, cash_open_pct_rank, position_class,
        vol_20d_avg, vol_ratio, vol_class,
        gap_vs_vwap_pts, vwap_signal, fill_score, fill_probability
      ) VALUES (
        ${tradeDate}, ${overnight.globex_open}, ${overnight.globex_high},
        ${overnight.globex_low}, ${overnight.globex_close},
        ${overnight.vwap}, ${totalVolume}, ${overnight.bar_count},
        ${rangePts}, ${rangePct},
        ${cashOpen}, ${prevCashClose}, ${gapPts}, ${gapPct}, ${gapDirection},
        ${gapSizeClass}, ${cashOpenPctRank}, ${positionClass},
        ${avg20d ? Math.round(avg20d) : null}, ${volRatio}, ${volClass},
        ${gapVsVwapPts}, ${vwapSignal}, ${fillScore}, ${fillProbability}
      )
      ON CONFLICT (trade_date) DO UPDATE SET
        globex_open = EXCLUDED.globex_open,
        globex_high = EXCLUDED.globex_high,
        globex_low = EXCLUDED.globex_low,
        globex_close = EXCLUDED.globex_close,
        vwap = EXCLUDED.vwap,
        total_volume = EXCLUDED.total_volume,
        bar_count = EXCLUDED.bar_count,
        range_pts = EXCLUDED.range_pts,
        range_pct = EXCLUDED.range_pct,
        cash_open = EXCLUDED.cash_open,
        prev_cash_close = EXCLUDED.prev_cash_close,
        gap_pts = EXCLUDED.gap_pts,
        gap_pct = EXCLUDED.gap_pct,
        gap_direction = EXCLUDED.gap_direction,
        gap_size_class = EXCLUDED.gap_size_class,
        cash_open_pct_rank = EXCLUDED.cash_open_pct_rank,
        position_class = EXCLUDED.position_class,
        vol_20d_avg = EXCLUDED.vol_20d_avg,
        vol_ratio = EXCLUDED.vol_ratio,
        vol_class = EXCLUDED.vol_class,
        gap_vs_vwap_pts = EXCLUDED.gap_vs_vwap_pts,
        vwap_signal = EXCLUDED.vwap_signal,
        fill_score = EXCLUDED.fill_score,
        fill_probability = EXCLUDED.fill_probability
    `;

    logger.info(
      {
        tradeDate,
        gapPts,
        gapDirection,
        gapSizeClass,
        fillScore,
        fillProbability,
        volClass,
        positionClass,
      },
      'ES overnight summary computed',
    );

    return res.status(200).json({
      stored: true,
      tradeDate,
      gap: `${gapPts >= 0 ? '+' : ''}${gapPts.toFixed(1)} ${gapDirection}`,
      fillProbability,
      fillScore,
      barCount: parseInt(overnight.bar_count),
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'compute-es-overnight failed');
    return res.status(500).json({ error: 'Internal error' });
  }
}
```

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: No errors on the new file.

- [ ] **Step 3: Commit**

```bash
git add api/cron/compute-es-overnight.ts
git commit -m "feat: add compute-es-overnight cron handler with 6 gap calculations"
```

---

## Task 13: Wire Into analyze.ts + vercel.json

**Files:**

- Modify: `api/analyze.ts` (~lines 58, 707, 810, 904)
- Modify: `vercel.json` (crons array)

- [ ] **Step 1: Add import to analyze.ts**

At the top of `api/analyze.ts`, after the IV term structure imports (around line 59):

```typescript
import type { EsOvernightSummaryRow } from './es-overnight.js';
import { formatEsOvernightForClaude } from './es-overnight.js';
```

- [ ] **Step 2: Add variable declaration**

Around line 707 (near the other context variables like `ivTermStructureContext`):

```typescript
let esOvernightContext: string | null = null;
```

- [ ] **Step 3: Add fetch logic**

After the IV term structure fetch block (around line 810), add:

```typescript
// On-demand ES overnight summary from DB
try {
  const esDate = analysisDate ?? new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  const esRows = await sql`
    SELECT * FROM es_overnight_summaries
    WHERE trade_date = ${esDate}
    LIMIT 1
  `;
  if (esRows.length > 0) {
    esOvernightContext = formatEsOvernightForClaude(
      esRows[0] as unknown as EsOvernightSummaryRow,
      context.straddleConeUpper as number | undefined,
      context.straddleConeLower as number | undefined,
    );
  }
} catch (esErr) {
  logger.error({ err: esErr }, 'Failed to fetch ES overnight summary');
}
```

- [ ] **Step 4: Add context injection into Claude prompt**

After the IV term structure injection (around line 904), add:

```typescript
${esOvernightContext ? `\n## ES Futures Overnight Context\nThe following ES futures overnight session data provides institutional positioning context for gap analysis. Use this to assess gap fill probability and overnight volume conviction.\n\n${esOvernightContext}\n` : ''}
```

- [ ] **Step 5: Add cron entry to vercel.json**

Add to the `crons` array in `vercel.json`:

```json
{
  "path": "/api/cron/compute-es-overnight",
  "schedule": "35 13,14 * * 1-5"
}
```

- [ ] **Step 6: Run lint**

```bash
npm run lint
```

Expected: No errors.

- [ ] **Step 7: Run existing tests to check for regressions**

```bash
npm run test:run
```

Expected: All existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add api/analyze.ts api/es-overnight.ts vercel.json
git commit -m "feat: wire ES overnight context into Claude analysis pipeline"
```

---

## Post-Implementation: Railway Deployment

These steps are done manually after all code is merged:

1. **Railway dashboard**: Create a new service pointing to `sidecar/` subdirectory of the GitHub repo
2. **Set root directory**: `sidecar/` in Railway service settings
3. **Environment variables**: Add all vars from `sidecar/.env.example` in Railway's env var UI (copy `DATABASE_URL` from Vercel env vars)
4. **Health check**: Configure Railway to ping `/health` on port 8080
5. **Deploy**: Railway auto-deploys on push. Verify logs show "Sidecar ready — receiving quotes"
6. **Verify bars**: After 2-3 minutes, check `es_bars` table for new rows
7. **Trigger cron manually**: `curl -H "Authorization: Bearer $CRON_SECRET" https://your-vercel-app.vercel.app/api/cron/compute-es-overnight`
8. **Verify summary**: Check `es_overnight_summaries` table for the computed row
9. **Run analysis**: Trigger a full analysis and verify Claude's response includes ES overnight context
