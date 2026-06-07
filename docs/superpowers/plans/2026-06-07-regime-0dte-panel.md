# 0DTE Gamma Regime Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a live intraday SPX 0DTE "gamma regime" panel — graded gamma gate + down-only triggers (mostly-red, IV-surface-break, midday deep-neg re-measure) — that scores itself nightly.

**Architecture:** Pure evaluator (`api/_lib/regime-0dte.ts`) ← thin owner/guest endpoint reading 3 existing Neon tables → market-hours-gated polling hook → rich React panel. A nightly cron persists the daily verdict + realized outcome to a new `flow_regime_0dte_daily` table.

**Tech Stack:** Vercel Functions (Node 24, TS), Neon Postgres (`@neondatabase/serverless`), Zod, Vitest, React 19 + Tailwind 4, `usePolling`. Mirrors the Opening Flow Signal triad and `withCronInstrumentation` cron pattern.

**Spec:** `docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md` (read first).

---

## File Structure

**Create**
- `api/_lib/regime-0dte.ts` — pure evaluator: types, constants, `evaluateRegime0dte(input)`.
- `api/_lib/regime-0dte-queries.ts` — DB read helpers (the only I/O for the live read path).
- `api/regime-0dte.ts` — GET endpoint (owner/guest), reads tables → evaluator → JSON.
- `api/cron/capture-regime-0dte.ts` — nightly self-scoring cron.
- `src/hooks/useRegime0dte.ts` — market-hours-gated polling hook.
- `src/components/Regime0dte/{index,GammaProfileMini,IvSparkline,CandleStrip,TriggerLights}.tsx`.
- Tests: `api/__tests__/regime-0dte.test.ts`, `api/__tests__/regime-0dte-endpoint.test.ts`, `api/__tests__/capture-regime-0dte.test.ts`, `src/__tests__/useRegime0dte.test.ts`, `src/__tests__/Regime0dte.test.tsx`, `e2e/regime-0dte.spec.ts`.

**Modify**
- `api/_lib/db-migrations.ts` — append migration creating `flow_regime_0dte_daily`.
- `api/__tests__/db.test.ts` — migration checklist (id, expected output, SQL count).
- `vercel.json` — cron entry for `capture-regime-0dte`.
- `src/constants/index.ts` — `POLL_INTERVALS.REGIME_0DTE`.
- `src/App.tsx` — render `<Regime0dte />` near `MarketRegimeSection`.

**Boundaries:** the evaluator is pure (no DB, no Date.now — time passed in). All DB reads live in `regime-0dte-queries.ts`. The endpoint orchestrates; the cron reuses the same queries + evaluator.

---

## Phase 1 — Pure evaluator (no wiring)

### Task 1: Types + constants

**Files:** Create `api/_lib/regime-0dte.ts`

- [ ] **Step 1: Write types + constants at top of file**

```ts
// All GEX values are "net GEX within +/-1% of spot" in the LIVE gex_strike_0dte units
// (sum of call_gamma_oi - put_gamma_oi over the band). DEEP_NEG is calibrated in Phase 2;
// until then lean_down uses sign + a placeholder magnitude that Task 12 overwrites.
export const REGIME_0DTE = {
  GATE_BAND_PCT: 0.01,
  GATE_DEEP_NEG: -0.15, // PLACEHOLDER (study units) — recalibrated to live units in Task 12
  IVBREAK_REL: 1.02,
  IVBREAK_REF_START: 510, IVBREAK_REF_END: 600,   // 08:30–10:00 CT, minutes from midnight
  IVBREAK_WIN_START: 600, IVBREAK_WIN_END: 750,    // 10:00–12:30 CT
  MOSTLY_RED_MAX_GREEN: 1, MOSTLY_RED_MIN_RED: 4,
  PERSIST_END_MIN: 660,    // 11:00 CT
  MIDDAY_AFTER_MIN: 750,   // 12:30 CT
  MIN_STRIKES: 5,
  OPEN_MIN: 510, CLOSE_MIN: 900, // 08:30 / 15:00 CT
} as const;

export type Gate = 'calm' | 'big_move' | 'lean_down' | 'unknown';

export interface GexStrike { strike: number; netGex: number; } // call_gamma_oi - put_gamma_oi
export interface IvPoint { ctMin: number; iv: number; }         // nearest-ATM put iv per minute
export interface Candle30 { ctMin: number; open: number; close: number; } // 30-min bucket

export interface Regime0dteInput {
  nowCtMin: number;             // minutes from CT midnight (e.g. 11:07 -> 667)
  spot: number;                 // current SPX spot
  openSpot: number | null;      // first stable spot (~08:35), null pre-open
  gexStrikes: GexStrike[];      // latest-minute net GEX by strike
  putIv: IvPoint[];             // SPXW 0DTE nearest-ATM put IV series, today
  candles30: Candle30[];        // 30-min SPX candles, today, regular session
}

export interface TriggerState { fired: boolean; atCtMin: number | null; }
export interface Regime0dteState {
  asOfCtMin: number;
  gate: Gate;
  gexNearSpot: number | null;
  gexAtOpen: number | null;
  flipStrike: number | null;
  flipMinusOpenPct: number | null;
  triggers: {
    mostlyRed: TriggerState & { green: number; red: number };
    ivBreak: TriggerState & { magPct: number | null; refHi: number | null };
    middayDeepNeg: TriggerState & { gexMid: number | null };
  };
  note: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add api/_lib/regime-0dte.ts
git commit -m 'feat(regime-0dte): types + constants for pure evaluator'
```

### Task 2: `gexNear` + gate grading (TDD)

**Files:** Modify `api/_lib/regime-0dte.ts`; Test `api/__tests__/regime-0dte.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { gexNear, gradeGate, REGIME_0DTE } from '../_lib/regime-0dte';

const strikes = [
  { strike: 7400, netGex: -0.2 }, { strike: 7450, netGex: -0.1 },
  { strike: 7500, netGex: 0.05 }, { strike: 7600, netGex: 0.3 },
];

describe('gexNear', () => {
  it('sums net GEX within +/-1% of spot', () => {
    // spot 7450, band +/-74.5 -> strikes 7400,7450,7500 in band
    expect(gexNear(strikes, 7450)).toBeCloseTo(-0.25, 5);
  });
});

describe('gradeGate', () => {
  it('positive -> calm', () => expect(gradeGate(0.1)).toBe('calm'));
  it('mild negative -> big_move', () => expect(gradeGate(-0.05)).toBe('big_move'));
  it('deep negative -> lean_down', () => expect(gradeGate(REGIME_0DTE.GATE_DEEP_NEG - 0.01)).toBe('lean_down'));
  it('null -> unknown', () => expect(gradeGate(null)).toBe('unknown'));
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm run test:run -- regime-0dte.test.ts` → "gexNear is not a function".

- [ ] **Step 3: Implement**

```ts
export function gexNear(strikes: GexStrike[], spot: number): number | null {
  if (!spot || strikes.length < REGIME_0DTE.MIN_STRIKES) return null;
  const band = REGIME_0DTE.GATE_BAND_PCT * spot;
  return strikes
    .filter((s) => Math.abs(s.strike - spot) <= band)
    .reduce((a, s) => a + s.netGex, 0);
}

export function gradeGate(gex: number | null): Gate {
  if (gex == null) return 'unknown';
  if (gex > 0) return 'calm';
  if (gex > REGIME_0DTE.GATE_DEEP_NEG) return 'big_move';
  return 'lean_down';
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m 'feat(regime-0dte): gexNear + gate grading'`

### Task 3: flip strike + persistence + IV-break + midday + note + top-level evaluator (TDD)

**Files:** Modify `api/_lib/regime-0dte.ts`; Test `api/__tests__/regime-0dte.test.ts`

- [ ] **Step 1: Write failing tests** (append)

```ts
import { flipStrike, countCandles, ivBreak, evaluateRegime0dte } from '../_lib/regime-0dte';

describe('flipStrike', () => {
  it('nearest sign-change to spot', () => {
    expect(flipStrike([
      { strike: 7450, netGex: -0.1 }, { strike: 7500, netGex: 0.05 },
    ], 7470)).toBeCloseTo(7475, 0);
  });
});

describe('countCandles', () => {
  it('counts green/red up to a CT minute', () => {
    const c = [
      { ctMin: 510, open: 100, close: 99 }, { ctMin: 540, open: 99, close: 98 },
      { ctMin: 570, open: 98, close: 97 }, { ctMin: 600, open: 97, close: 96 },
      { ctMin: 630, open: 96, close: 97 }, // 1 green, 4 red by 11:00
    ];
    expect(countCandles(c, 660)).toEqual({ green: 1, red: 4 });
  });
});

describe('ivBreak', () => {
  const series = [
    { ctMin: 520, iv: 0.20 }, { ctMin: 580, iv: 0.21 }, // ref range hi 0.21
    { ctMin: 620, iv: 0.219 },                          // <2% over -> no break
    { ctMin: 650, iv: 0.25 },                           // break at 650
  ];
  it('fires when IV exceeds morning range by >2% within the window', () => {
    const r = ivBreak(series, 700);
    expect(r.fired).toBe(true); expect(r.atCtMin).toBe(650);
  });
  it('ignores breaks after 12:30 (EOD blowup)', () => {
    expect(ivBreak([{ ctMin: 520, iv: 0.2 }, { ctMin: 800, iv: 0.9 }], 820).fired).toBe(false);
  });
});

describe('evaluateRegime0dte', () => {
  it('lean_down + mostly_red on a crash-shaped day', () => {
    const s = evaluateRegime0dte({
      nowCtMin: 700, spot: 7450, openSpot: 7530,
      gexStrikes: [{ strike: 7440, netGex: -0.3 }, { strike: 7450, netGex: -0.2 },
                   { strike: 7460, netGex: -0.2 }, { strike: 7470, netGex: -0.1 },
                   { strike: 7480, netGex: -0.1 }],
      putIv: [{ ctMin: 520, iv: 0.20 }, { ctMin: 650, iv: 0.26 }],
      candles30: [{ ctMin: 510, open: 7530, close: 7520 }, { ctMin: 540, open: 7520, close: 7510 },
                  { ctMin: 570, open: 7510, close: 7500 }, { ctMin: 600, open: 7500, close: 7480 },
                  { ctMin: 630, open: 7480, close: 7470 }],
    });
    expect(s.gate).toBe('lean_down');
    expect(s.triggers.mostlyRed.fired).toBe(true);
    expect(s.triggers.ivBreak.fired).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** the helpers + evaluator

```ts
export function flipStrike(strikes: GexStrike[], spot: number): number | null {
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if ((a.netGex < 0) !== (b.netGex < 0) && Math.abs(a.strike - spot) <= 0.05 * spot) {
      const mid = (a.strike + b.strike) / 2, d = Math.abs(mid - spot);
      if (d < bestD) { bestD = d; best = mid; }
    }
  }
  return best;
}

export function countCandles(c: Candle30[], untilCtMin: number) {
  const upto = c.filter((x) => x.ctMin < untilCtMin);
  return {
    green: upto.filter((x) => x.close > x.open).length,
    red: upto.filter((x) => x.close < x.open).length,
  };
}

export function ivBreak(series: IvPoint[], nowCtMin: number) {
  const ref = series.filter((p) => p.ctMin >= REGIME_0DTE.IVBREAK_REF_START && p.ctMin <= REGIME_0DTE.IVBREAK_REF_END);
  const refHi = ref.length ? Math.max(...ref.map((p) => p.iv)) : null;
  if (refHi == null) return { fired: false, atCtMin: null, magPct: null, refHi: null };
  for (const p of series) {
    if (p.ctMin >= REGIME_0DTE.IVBREAK_WIN_START && p.ctMin <= Math.min(nowCtMin, REGIME_0DTE.IVBREAK_WIN_END)
        && p.iv > refHi * REGIME_0DTE.IVBREAK_REL) {
      return { fired: true, atCtMin: p.ctMin, magPct: ((p.iv - refHi) / refHi) * 100, refHi };
    }
  }
  return { fired: false, atCtMin: null, magPct: null, refHi };
}

export function evaluateRegime0dte(input: Regime0dteInput): Regime0dteState {
  const { nowCtMin, spot, openSpot, gexStrikes, putIv, candles30 } = input;
  const gexNearSpot = gexNear(gexStrikes, spot);
  const gexAtOpen = openSpot ? gexNear(gexStrikes, openSpot) : null;
  const gate = gradeGate(gexNearSpot);
  const flip = flipStrike(gexStrikes, spot);

  const { green, red } = countCandles(candles30, REGIME_0DTE.PERSIST_END_MIN);
  const mostlyRedFired = nowCtMin >= REGIME_0DTE.PERSIST_END_MIN
    && green <= REGIME_0DTE.MOSTLY_RED_MAX_GREEN && red >= REGIME_0DTE.MOSTLY_RED_MIN_RED;

  const iv = ivBreak(putIv, nowCtMin);

  const middayFired = nowCtMin >= REGIME_0DTE.MIDDAY_AFTER_MIN
    && gexNearSpot != null && gexNearSpot <= REGIME_0DTE.GATE_DEEP_NEG;

  const downConfirmed = mostlyRedFired || iv.fired || middayFired;
  const note = gate === 'lean_down' && !downConfirmed
    ? 'deep negative gamma, no downside confirmation yet — up-ambush risk'
    : gate === 'calm' ? 'positive gamma — mean-revert / tight range likely'
    : downConfirmed ? 'downside confirmed by intraday trigger(s)'
    : 'big move likely, direction unconfirmed';

  return {
    asOfCtMin: nowCtMin, gate, gexNearSpot, gexAtOpen, flipStrike: flip,
    flipMinusOpenPct: flip && openSpot ? ((flip - openSpot) / openSpot) * 100 : null,
    triggers: {
      mostlyRed: { fired: mostlyRedFired, atCtMin: mostlyRedFired ? REGIME_0DTE.PERSIST_END_MIN : null, green, red },
      ivBreak: { fired: iv.fired, atCtMin: iv.atCtMin, magPct: iv.magPct, refHi: iv.refHi },
      middayDeepNeg: { fired: middayFired, atCtMin: middayFired ? nowCtMin : null, gexMid: middayFired ? gexNearSpot : null },
    },
    note,
  };
}
```

- [ ] **Step 4: Run full file, expect PASS** — `npm run test:run -- regime-0dte.test.ts`.

- [ ] **Step 5: `npm run lint`, fix, commit** — `git commit -m 'feat(regime-0dte): full pure evaluator + tests'`

---

## Phase 2 — Backend (table, queries, endpoint, cron, calibration)

### Task 4: Migration — `flow_regime_0dte_daily`

**Files:** Modify `api/_lib/db-migrations.ts` (append after the current highest-id migration); `api/__tests__/db.test.ts`

- [ ] **Step 1:** Find the current highest migration id: `grep -n "id:" api/_lib/db-migrations.ts | tail -3`. Use `N = that + 1`.

- [ ] **Step 2: Append the migration** (use the real next id for `N`)

```ts
{
  id: N,
  name: 'create_flow_regime_0dte_daily',
  statements: [
    `CREATE TABLE IF NOT EXISTS flow_regime_0dte_daily (
      date DATE PRIMARY KEY,
      gate TEXT NOT NULL,
      gex_open NUMERIC, gex_mid NUMERIC, flip_minus_open_pct NUMERIC,
      mostly_red BOOLEAN NOT NULL DEFAULT false, mostly_red_at TEXT,
      iv_break BOOLEAN NOT NULL DEFAULT false, iv_break_at TEXT, iv_break_mag_pct NUMERIC,
      midday_deep_neg BOOLEAN NOT NULL DEFAULT false,
      oc_ret_pct NUMERIC, range_pct NUMERIC, dir_eff NUMERIC,
      big_down BOOLEAN, big_up BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],
},
```

- [ ] **Step 3: Update `api/__tests__/db.test.ts`** — add `{ id: N }` to the applied-migrations mock, add `create_flow_regime_0dte_daily` to the expected-output list, bump the SQL call-count by 2 (1 CREATE + 1 INSERT INTO schema_migrations). Mirror the existing entries exactly.

- [ ] **Step 4: Run** `npm run test:run -- db.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m 'feat(regime-0dte): migration for flow_regime_0dte_daily'`

### Task 5: DB read helpers

**Files:** Create `api/_lib/regime-0dte-queries.ts`. Reference patterns: `api/_lib/postgres-day-summary.ts`, `api/cron/fetch-gex-0dte.ts` (column names), `api/_lib/db.ts` (`getDb`), `api/_lib/api-helpers.ts` (`withRetry`).

- [ ] **Step 1:** Implement three functions returning the evaluator's input shapes. Convert CT date/time via the same approach the repo uses (`AT TIME ZONE 'America/Chicago'`). Coerce NUMERIC→Number.

```ts
import { getDb } from './db.js';
import { withRetry } from './api-helpers.js';
import type { GexStrike, IvPoint, Candle30 } from './regime-0dte.js';

const ctMinExpr = (col: string) =>
  `(extract(hour from ${col} AT TIME ZONE 'America/Chicago')*60
    + extract(minute from ${col} AT TIME ZONE 'America/Chicago'))::int`;

export async function getGexStrikes(dateIso: string): Promise<{ strikes: GexStrike[]; spot: number | null }> {
  const sql = getDb();
  // latest minute's rows for today
  const rows = await withRetry(() => sql`
    WITH latest AS (
      SELECT max(timestamp) ts FROM gex_strike_0dte WHERE date = ${dateIso}
    )
    SELECT strike, call_gamma_oi, put_gamma_oi, price
    FROM gex_strike_0dte, latest
    WHERE date = ${dateIso} AND timestamp = latest.ts
  `);
  const strikes = rows.map((r: any) => ({ strike: Number(r.strike), netGex: Number(r.call_gamma_oi) - Number(r.put_gamma_oi) }));
  const spot = rows.length ? Number(rows[0].price) : null;
  return { strikes, spot };
}

export async function getPutIvSeries(dateIso: string): Promise<IvPoint[]> {
  const sql = getDb();
  // nearest-to-spot put per minute, SPXW 0DTE today
  const rows = await withRetry(() => sql`
    SELECT DISTINCT ON (${sql.unsafe(ctMinExpr('ts'))})
      ${sql.unsafe(ctMinExpr('ts'))} AS ct_min, iv_mid
    FROM strike_iv_snapshots
    WHERE ticker = 'SPXW' AND side = 'put' AND expiry = ${dateIso} AND date(ts AT TIME ZONE 'America/Chicago') = ${dateIso}
    ORDER BY ${sql.unsafe(ctMinExpr('ts'))}, abs(strike - spot)
  `);
  return rows.map((r: any) => ({ ctMin: Number(r.ct_min), iv: Number(r.iv_mid) })).filter((p) => p.iv > 0 && p.iv < 3);
}

export async function getCandles30(dateIso: string): Promise<Candle30[]> {
  const sql = getDb();
  const rows = await withRetry(() => sql`
    WITH b AS (
      SELECT (${sql.unsafe(ctMinExpr('timestamp'))} / 30)*30 AS ct_min,
             ${sql.unsafe(ctMinExpr('timestamp'))} AS m, open, close
      FROM index_candles_1m
      WHERE symbol = 'SPX' AND date = ${dateIso} AND market_time = 'r'
    )
    SELECT ct_min,
      (array_agg(open ORDER BY m ASC))[1] AS bopen,
      (array_agg(close ORDER BY m DESC))[1] AS bclose
    FROM b GROUP BY ct_min ORDER BY ct_min
  `);
  return rows.map((r: any) => ({ ctMin: Number(r.ct_min), open: Number(r.bopen), close: Number(r.bclose) }));
}
```

- [ ] **Step 2:** No unit test (thin DB layer; covered by endpoint/cron tests with mocked `getDb`). `npm run lint`.

- [ ] **Step 3: Commit** — `git commit -m 'feat(regime-0dte): neon read helpers for the 3 live tables'`

### Task 6: GET endpoint (TDD)

**Files:** Create `api/regime-0dte.ts`; Test `api/__tests__/regime-0dte-endpoint.test.ts`. Mirror `api/opening-flow-signal.ts` (guard + Zod + cache headers).

- [ ] **Step 1: Write failing test** — mock `regime-0dte-queries`, assert 200 + `gate` in body, and that missing owner/guest auth → 401. Mock `guardOwnerOrGuestEndpoint` to return true/false.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../_lib/regime-0dte-queries', () => ({
  getGexStrikes: vi.fn().mockResolvedValue({ strikes: [
    { strike: 7450, netGex: -0.3 }, { strike: 7460, netGex: -0.2 }, { strike: 7470, netGex: -0.2 },
    { strike: 7480, netGex: -0.1 }, { strike: 7490, netGex: -0.1 }], spot: 7460 }),
  getPutIvSeries: vi.fn().mockResolvedValue([{ ctMin: 520, iv: 0.2 }, { ctMin: 650, iv: 0.27 }]),
  getCandles30: vi.fn().mockResolvedValue([]),
}));
vi.mock('../_lib/guest-auth', () => ({ guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(true) }));
import handler from '../regime-0dte';

function mockRes() { const r: any = {}; r.status = vi.fn(() => r); r.json = vi.fn(() => r); r.setHeader = vi.fn(() => r); return r; }

describe('GET /api/regime-0dte', () => {
  it('returns gate + triggers', async () => {
    const res = mockRes();
    await handler({ method: 'GET', query: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toHaveProperty('gate');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — guard → Zod parse `?date?` (default today CT) → compute `nowCtMin` from CT now → call queries → `evaluateRegime0dte` → JSON. Derive `openSpot` from the first candle/gex minute. Set cache headers like `opening-flow-signal.ts`.

- [ ] **Step 4: Run, expect PASS.** `npm run lint`.

- [ ] **Step 5: Commit** — `git commit -m 'feat(regime-0dte): GET endpoint'`

### Task 7: Nightly self-scoring cron (TDD)

**Files:** Create `api/cron/capture-regime-0dte.ts`; Test `api/__tests__/capture-regime-0dte.test.ts`; Modify `vercel.json`. Mirror `api/cron/capture-opening-flow-signal.ts` + `withCronInstrumentation`.

- [ ] **Step 1: Write failing test** — provide `CRON_SECRET`, mock `getDb`/queries; assert: wrong secret → 401; happy path → one `INSERT INTO flow_regime_0dte_daily ... ON CONFLICT (date) DO UPDATE`. Mirror the cron test pattern (mock `getDb` via `vi.mocked`).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — `withCronInstrumentation('capture-regime-0dte', …)`: read the 3 tables for `ctx.today`, evaluate at `nowCtMin = CLOSE_MIN`, compute realized outcome (open/close/hi/lo from `index_candles_1m`; `oc_ret_pct`, `range_pct`, `dir_eff`, `big_down`=oc≤−1, `big_up`=oc≥+1), upsert one row.

- [ ] **Step 4: Add to `vercel.json` crons** — `{ "path": "/api/cron/capture-regime-0dte", "schedule": "30 21 * * 1-5" }`.

- [ ] **Step 5: Run test PASS, `npm run lint`, commit** — `git commit -m 'feat(regime-0dte): nightly self-scoring cron'`

### Task 12 (do in Phase 2, gates the threshold): Calibrate `GATE_DEEP_NEG` to live units

**Files:** Modify `api/_lib/regime-0dte.ts` (the one constant), `docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md` (record the fitted value).

- [ ] **Step 1:** Against prod Neon (read-only), compute, per day with `gex_strike_0dte` history: `gexNear` at that day's ~13:00 spot, in live units. Query sketch:

```sql
-- per (date), latest-minute net GEX within +/-1% of that minute's price
WITH m AS (SELECT date, max(timestamp) ts FROM gex_strike_0dte GROUP BY date)
SELECT g.date,
  sum(CASE WHEN abs(g.strike - g.price) <= 0.01*g.price THEN g.call_gamma_oi - g.put_gamma_oi END) AS gex_near
FROM gex_strike_0dte g JOIN m USING(date, timestamp)... -- group by date
```

- [ ] **Step 2:** Set `GATE_DEEP_NEG` to the value at the **~12th percentile** (most-negative ~12% of days, matching 13/106 from the study). If `gex_strike_0dte` history is too short (<~30 days), set `GATE_DEEP_NEG` to the median of the negative-GEX days as an interim and add a `// TODO recalibrate at 30+ days` note with a concrete date.

- [ ] **Step 3:** Re-run the Task 3 evaluator test (adjust the fixture if the unit scale flips sign expectations — it should not; signs are scale-invariant). `npm run test:run -- regime-0dte.test.ts`.

- [ ] **Step 4: Commit** — `git commit -m 'fit(regime-0dte): calibrate GATE_DEEP_NEG to live gex_strike_0dte units'`

---

## Phase 3 — Frontend (hook + rich panel)

### Task 8: Poll interval + hook (TDD)

**Files:** Modify `src/constants/index.ts`; Create `src/hooks/useRegime0dte.ts`; Test `src/__tests__/useRegime0dte.test.ts`. Mirror `src/hooks/useOpeningFlowSignal.ts` + `usePolling` + `inPollingWindow`.

- [ ] **Step 1:** Add `REGIME_0DTE: 45_000` to `POLL_INTERVALS` in `src/constants/index.ts`.

- [ ] **Step 2: Write failing test** — render the hook with `@testing-library/react`'s `renderHook`, mock `fetch`; assert `displayData.gate` populates after a tick, and that outside the CT window `isWindowOpen === false` and no fetch fires. Mirror `useOpeningFlowSignal` test if one exists.

- [ ] **Step 3: Implement** — copy the structure of `useOpeningFlowSignal`: `usePolling(tick, POLL_INTERVALS.REGIME_0DTE, [isLive])`, gate on `inPollingWindow(now)` for 08:30–15:00 CT, `AbortController`, localStorage last-good cache key `regime0dte:lastgood`, return `{ data, displayData, loading, error, isWindowOpen, refresh }`.

- [ ] **Step 4: Run test PASS. Commit** — `git commit -m 'feat(regime-0dte): polling hook'`

### Task 9: Sub-viz components (smoke tests)

**Files:** Create `src/components/Regime0dte/{GammaProfileMini,IvSparkline,CandleStrip,TriggerLights}.tsx`. SVG, Tailwind 4, theme colors. No new chart lib.

- [ ] **Step 1:** `GammaProfileMini` — props `{ strikes, flipStrike, spot, bandPct }`; render horizontal bars (negative left/red, positive right/green), a flip line, a spot marker, highlight the ±band. `IvSparkline` — props `{ series, refHi, breakAtCtMin }`; polyline + range band + break dot. `CandleStrip` — props `{ candles, persistEndCtMin }`; row of green/red squares + an 11:00 divider. `TriggerLights` — props `{ triggers }`; three dots with labels + `atCtMin` formatted to CT clock.

- [ ] **Step 2:** One smoke test per component in `src/__tests__/Regime0dte.test.tsx` (renders with sample props, asserts a key element present). `npm run test:run -- Regime0dte`.

- [ ] **Step 3: Commit** — `git commit -m 'feat(regime-0dte): gamma/iv/candle/trigger sub-viz'`

### Task 10: Panel shell

**Files:** Create `src/components/Regime0dte/index.tsx`; extend `src/__tests__/Regime0dte.test.tsx`. Mirror `SectionBox` usage in `src/components/MarketRegimeSection.tsx`.

- [ ] **Step 1: Write failing test** — render `<Regime0dte />` with a mocked `useRegime0dte` returning a `lean_down` state; assert the gate label text and that the four sub-viz render; and that `isWindowOpen=false` shows the "waiting for open" placeholder.

- [ ] **Step 2: Implement** — `SectionBox` with title "0DTE Gamma Regime"; gate chip (color by gate), note line, `<TriggerLights>`, `<GammaProfileMini>`, `<IvSparkline>`, `<CandleStrip>`. Pull state from `useRegime0dte()`. Placeholder when `!isWindowOpen`.

- [ ] **Step 3: Run PASS. `npm run lint`. Commit** — `git commit -m 'feat(regime-0dte): panel shell'`

---

## Phase 4 — Wire-in + e2e + history backfill

### Task 11: Render in App + e2e

**Files:** Modify `src/App.tsx`; Create `e2e/regime-0dte.spec.ts`.

- [ ] **Step 1:** Import and render `<Regime0dte />` near `<MarketRegimeSection />` in `src/App.tsx` (match the surrounding section layout).

- [ ] **Step 2: e2e** — `e2e/regime-0dte.spec.ts`: load the app, assert the "0DTE Gamma Regime" section heading is visible, run `@axe-core/playwright` and assert no violations. Mirror an existing section spec.

- [ ] **Step 3:** `npm run build` (ensure App compiles), `npm run test:e2e -- regime-0dte` (or note if e2e needs a running server). Commit — `git commit -m 'feat(regime-0dte): wire panel into App + e2e'`

### Task 13 (optional): Seed scorecard history

**Files:** Create `scripts/seed-regime-0dte-history.mjs` (one-off).

- [ ] **Step 1:** Read `docs/tmp/crash-autopsy/master_scorecard.csv`, map each row to a `flow_regime_0dte_daily` insert (gate from `gex_pm1pct_b` sign+magnitude, triggers from the csv flags, outcomes from `oc_ret_pct`/`range_pct`/`dir_eff`). Note: csv GEX is in study units — store `gate` (label) which is scale-invariant, leave `gex_open/gex_mid` NULL or mark provenance, so live-units rows aren't mixed with study-units magnitudes.

- [ ] **Step 2:** Run against prod with explicit confirmation. Commit the script — `git commit -m 'chore(regime-0dte): optional history seed script'`

---

## Final verification
- [ ] `npm run review` (tsc + eslint + prettier + vitest --coverage) green.
- [ ] code-reviewer subagent on the full diff.
- [ ] Confirm `vercel.json` cron + migration + App wiring all present.

## Self-review notes (spec coverage)
- Gate grading + magnitude → Tasks 2, 12. Triggers (mostly-red/iv-break/midday) → Task 3. GEX calibration ⚠️ → Task 12 (gates Task 7 trust). Table + nightly scoring → Tasks 4, 7. Endpoint → Task 6. Hook + rich panel (4 sub-viz) → Tasks 8–10. Wire-in + e2e → Task 11. History backfill → Task 13. Honesty constraints (symmetric gate, down-only, no fake up, amber midday) → evaluator `note` logic in Task 3. Owner/guest, no botid → Task 6 (mirror opening-flow-signal).
