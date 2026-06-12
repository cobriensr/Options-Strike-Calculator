# Guest Feedback UI Fixes (2026-06-12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three guest-feedback fixes: persistent BacktestDiag dismissal, equal-size expanded-row chart panels, and a diagnosed/fixed early-session net-flow gap.

**Architecture:** Task 1 moves BacktestDiag dismissal from in-memory App state to a localStorage-backed hook (deliberately reversing the existing reset-on-date-change behavior — owner requested "closes it for good"). Task 2 pins both expanded-row charts to one shared pixel height; ContractTapeChart gains a `pixelHeight` mode that derives its viewBox height from measured container width so SVG units stay square (no text distortion). Task 3 is a gated diagnosis of the 2026-06-12 morning net-flow gap (prod read-only queries + Railway/Sentry logs), with a default-pick fix of scheduling the existing idempotent REST backfill cron intraday as a self-heal.

**Tech Stack:** React 19, Tailwind CSS 4, lightweight-charts v5, hand-rolled SVG, Vitest + Testing Library, Neon Postgres, Vercel crons, uw-stream (Python/Railway).

**Origin:** Discord guest feedback (Wonce) 2026-06-12; scoped with owner same day. Item 4 from that conversation (ITM treatment) was explicitly dropped ("Ignore").

---

## Task 1: Persistent BacktestDiag dismissal

**Context:** BacktestDiag already has a working × button ([src/components/BacktestDiag/index.tsx:102-137](../../src/components/BacktestDiag/index.tsx)). The gap: `backtestDiagDismissed` lives in App state and an effect resets it to `false` on every `vix.selectedDate` change (App.tsx ~496–507, with a comment saying that reset is intentional). Owner now wants the opposite: dismiss once, gone for good. Re-enable path: `localStorage.removeItem('backtestDiag.dismissed')` in devtools (documented in the hook's JSDoc).

**Files:**
- Create: `src/hooks/usePersistedFlag.ts`
- Create: `src/__tests__/hooks/usePersistedFlag.test.ts`
- Modify: `src/App.tsx` (~lines 496–507 state block; ~1618–1628 mount untouched except no changes needed to onDismiss)

- [ ] **Step 1: Write the failing hook test**

`src/__tests__/hooks/usePersistedFlag.test.ts`:

```tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePersistedFlag } from '../../hooks/usePersistedFlag';

const KEY = 'test.flag';

describe('usePersistedFlag', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to false when no stored value', () => {
    const { result } = renderHook(() => usePersistedFlag(KEY));
    expect(result.current[0]).toBe(false);
  });

  it('initializes true from a stored "1"', () => {
    localStorage.setItem(KEY, '1');
    const { result } = renderHook(() => usePersistedFlag(KEY));
    expect(result.current[0]).toBe(true);
  });

  it('persists set(true) to localStorage and updates state', () => {
    const { result } = renderHook(() => usePersistedFlag(KEY));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('degrades to in-memory state when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => usePersistedFlag(KEY));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/hooks/usePersistedFlag.test.ts`
Expected: FAIL — `Cannot find module '../../hooks/usePersistedFlag'`

- [ ] **Step 3: Write the hook**

`src/hooks/usePersistedFlag.ts`:

```ts
import { useCallback, useState } from 'react';

/**
 * Boolean flag persisted to localStorage ('1' / '0'). Storage failures
 * (private mode, quota) degrade to in-memory state for the session.
 *
 * To reset a persisted flag manually:
 * `localStorage.removeItem('<key>')` in devtools.
 */
export function usePersistedFlag(
  key: string,
): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  const set = useCallback(
    (v: boolean) => {
      try {
        localStorage.setItem(key, v ? '1' : '0');
      } catch {
        // localStorage unavailable — keep in-memory value only.
      }
      setValue(v);
    },
    [key],
  );

  return [value, set];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/hooks/usePersistedFlag.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire into App.tsx**

In `src/App.tsx`, REPLACE this block (~lines 496–507):

```tsx
  // BacktestDiag dismiss state lives here (not in the component) so it resets
  // when the user scrubs to a new backtest date — otherwise dismissing once
  // would hide the diagnostic for every subsequent date, defeating its purpose.
  const [backtestDiagDismissed, setBacktestDiagDismissed] = useState(false);

  // Re-show the diagnostic whenever the backtest date changes (and when leaving
  // backtest mode, since selectedDate changes back to today). Keyed on the date
  // string, not the snapshot object identity, so unrelated re-renders don't
  // reset it.
  useEffect(() => {
    setBacktestDiagDismissed(false);
  }, [vix.selectedDate]);
```

WITH:

```tsx
  // BacktestDiag dismissal is permanent (guest feedback 2026-06-12):
  // dismiss once and the overlay never returns, across dates and
  // sessions. Reset path: localStorage.removeItem('backtestDiag.dismissed').
  const [backtestDiagDismissed, setBacktestDiagDismissed] = usePersistedFlag(
    'backtestDiag.dismissed',
  );
```

Add the import alongside the other hook imports in App.tsx:

```tsx
import { usePersistedFlag } from './hooks/usePersistedFlag';
```

The mount at ~1618–1628 (`onDismiss={() => setBacktestDiagDismissed(true)}`) needs no change. If `useEffect`/`useState` become unused in App.tsx after this edit they won't (App uses both elsewhere) — do NOT remove those imports.

- [ ] **Step 6: Verify no orphaned references**

Run: `grep -n "backtestDiagDismissed" src/App.tsx`
Expected: exactly the new state line + the two mount references (condition + onDismiss). No leftover reset effect.

- [ ] **Step 7: Run the existing BacktestDiag component test (unchanged contract)**

Run: `npx vitest run src/__tests__/components/BacktestDiag.test.tsx`
Expected: PASS — the component still only calls `onDismiss`; the existing test asserting BacktestDiag itself writes no localStorage keys must stay green (the write now happens in App via the hook).

- [ ] **Step 8: Commit**

```bash
git add src/hooks/usePersistedFlag.ts src/__tests__/hooks/usePersistedFlag.test.ts src/App.tsx
git commit -m 'feat(backtest-diag): persist dismissal for good via localStorage (guest feedback)'
```

(Single quotes — commit message contains no backticks but follow the zsh single-quote convention anyway.)

---

## Task 2: Equal-size expanded-row chart panels

**Context:** All three expanded rows use `md:grid-cols-2` (equal widths already). Heights diverge: ContractTapeChart is an SVG (`viewBox 0 0 200 130`, `w-full`) whose rendered height = 0.65 × column width — huge on a maximized window; TickerNetFlowChart is fixed 220px. Fix: shared `EXPANDED_ROW_CHART_HEIGHT = 280` px constant; ContractTapeChart gets a `pixelHeight` mode (fixed CSS height, viewBox height derived from measured width so SVG units stay square and text doesn't distort); TickerNetFlowChart receives `height={280}`.

280px rationale: Wonce asked for left "a little smaller" (it renders ~450px+ maximized) and right "a little bigger" than 220px. The constant is the single tuning knob.

**Files:**
- Create: `src/constants/chart-layout.ts`
- Modify: `src/components/charts/ContractTapeChart.tsx` (props ~line 54, measure effect ~135–148, layout ~150–163, tooltip ~440–448, svg ~459–464)
- Modify: `src/components/LotteryFinder/LotteryRow.tsx` (~1340, ~1363)
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx` (~1033, ~1053)
- Modify: `src/components/IntervalBAFeed/IntervalBARow.tsx` (~453, ~473)
- Test: `src/__tests__/ContractTapeChart.test.tsx` (extend existing)

- [ ] **Step 1: Create the shared constant**

`src/constants/chart-layout.ts`:

```ts
/**
 * Shared on-screen height (CSS px) for the two expanded-row chart
 * panels — ContractTapeChart (left) and TickerNetFlowChart (right) —
 * in LotteryRow / SilentBoomRow / IntervalBARow.
 *
 * Guest feedback 2026-06-12: the left SVG scaled with column width
 * (~450px+ tall on a maximized window) while the right chart was fixed
 * at 220px. Pin both to one height; tune here only.
 */
export const EXPANDED_ROW_CHART_HEIGHT = 280;
```

- [ ] **Step 2: Write the failing helper test**

Append to `src/__tests__/ContractTapeChart.test.tsx`:

```tsx
import { viewBoxHeightFor } from '../components/charts/ContractTapeChart';

describe('viewBoxHeightFor', () => {
  it('falls back when width is unmeasured or zero (jsdom)', () => {
    expect(viewBoxHeightFor(280, null, 130)).toBe(130);
    expect(viewBoxHeightFor(280, 0, 130)).toBe(130);
  });

  it('derives viewBox height so SVG units stay square', () => {
    // 800px-wide column at 280px tall: 200 viewBox units across 800px
    // = 0.25 units/px, so 280px tall = 70 viewBox units.
    expect(viewBoxHeightFor(280, 800, 130)).toBe(70);
    // Narrower column → taller viewBox (same px height, fewer px/unit).
    expect(viewBoxHeightFor(280, 400, 130)).toBe(140);
  });
});
```

(Match the existing test file's import style — if it imports the component default, add a named import for the helper. Run the existing file first to confirm conventions before editing.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ContractTapeChart.test.tsx`
Expected: FAIL — `viewBoxHeightFor` is not exported.

- [ ] **Step 4: Implement `pixelHeight` mode in ContractTapeChart**

In `src/components/charts/ContractTapeChart.tsx`:

(a) Add to the props interface, directly below the existing `height?: number` prop (~line 54):

```tsx
  /**
   * Fixed on-screen height (CSS px). When set, the SVG renders at this
   * exact pixel height and the viewBox height is derived from the
   * measured container width so SVG units stay square (no text
   * distortion). Takes precedence over `height`. Falls back to the
   * `height` viewBox default until the container is measured (and
   * permanently in environments without layout, e.g. jsdom).
   */
  pixelHeight?: number;
```

(b) Add the exported pure helper next to the other module-level helpers (near `formatHM`):

```tsx
/**
 * ViewBox height for a fixed-pixel-height render: keeps SVG units
 * square by matching the viewBox aspect to the rendered CSS box.
 */
export function viewBoxHeightFor(
  pixelHeight: number,
  measuredWidth: number | null,
  fallback: number,
): number {
  if (measuredWidth == null || measuredWidth <= 0) return fallback;
  return (VIEW_W * pixelHeight) / measuredWidth;
}
```

(c) Destructure `pixelHeight` in `ContractTapeChartInner` props.

(d) Track measured width as state. The component already has a measure effect (~lines 135–148) writing `rectRef.current`; extend it:

```tsx
  const [measuredW, setMeasuredW] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    rectRef.current = el.getBoundingClientRect();
    setMeasuredW(rectRef.current.width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      rectRef.current = el.getBoundingClientRect();
      setMeasuredW(rectRef.current.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```

(This replaces the existing effect body — same structure, two added `setMeasuredW` calls. React bails out of re-renders when the width is unchanged, so the RO callback stays cheap.)

(e) Compute the effective viewBox height before the `layout` memo and use it everywhere `height` was used for geometry:

```tsx
  const viewH =
    pixelHeight != null
      ? viewBoxHeightFor(pixelHeight, measuredW, height)
      : height;
```

- In the `layout` useMemo: `const innerH = viewH - PAD_Y * 2 - AXIS_H;` and add `viewH` to the memo's dependency array (replacing `height` if listed).
- Tooltip scale (~line 445): `const scaleY = rect.height / viewH;`
- SVG element (~459–464):

```tsx
      <svg
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        className="block w-full"
        style={pixelHeight != null ? { height: pixelHeight } : undefined}
        role="img"
        aria-label={ariaLabel}
      >
```

Search the file for every other `height` usage in geometry (e.g. marker/fire-line y-extents, axis label y) and switch them to `viewH`. The `height` prop remains only as the fallback/legacy viewBox mode.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/ContractTapeChart.test.tsx`
Expected: PASS — new helper tests green, all existing rendering tests still green (jsdom measures width 0 → fallback path → identical geometry to before).

- [ ] **Step 6: Wire the three call sites**

In each of the three rows, the change is identical. Add the import:

```tsx
import { EXPANDED_ROW_CHART_HEIGHT } from '../../constants/chart-layout';
```

(LotteryRow/SilentBoomRow/IntervalBARow are all two levels below src/, so `../../constants/chart-layout` is correct for all three.)

- `src/components/LotteryFinder/LotteryRow.tsx` ~1340: add `pixelHeight={EXPANDED_ROW_CHART_HEIGHT}` to `<ContractTapeChart`; ~1363: add `height={EXPANDED_ROW_CHART_HEIGHT}` to `<TickerNetFlowChart`.
- `src/components/SilentBoom/SilentBoomRow.tsx` ~1033 and ~1053: same two props.
- `src/components/IntervalBAFeed/IntervalBARow.tsx` ~453 and ~473: same two props.

- [ ] **Step 7: Run the row tests**

Run: `npx vitest run src/__tests__/LotteryRow.test.tsx src/__tests__/SilentBoomRow.test.tsx src/__tests__/IntervalBARow.test.tsx src/__tests__/TickerNetFlowChart.test.tsx`
Expected: PASS. If a snapshot/DOM assertion pins the old 220px height in TickerNetFlowChart tests, update it to expect the prop-driven height.

- [ ] **Step 8: Visual check in dev**

Run: `npm run dev`, expand a Lottery row at a maximized window width.
Expected: both panels ~280px tall, side by side, text in the left chart NOT stretched or squashed; hover tooltip still tracks the cursor (tooltip math uses `viewH`).

- [ ] **Step 9: Commit**

```bash
git add src/constants/chart-layout.ts src/components/charts/ContractTapeChart.tsx src/components/LotteryFinder/LotteryRow.tsx src/components/SilentBoom/SilentBoomRow.tsx src/components/IntervalBAFeed/IntervalBARow.tsx src/__tests__/ContractTapeChart.test.tsx
git commit -m 'feat(charts): equal-height expanded-row chart panels (guest feedback)'
```

---

## Task 3: Net-flow early-session gap — diagnose, then fix

**Context:** On 2026-06-12 between ~10:22 and ~11:24 CT, expanded-row net-flow panes showed essentially one bar; by 11:29 CT the same panes had a full session of data. Data path: `useNetFlowHistory` → `GET /api/net-flow-history` → UNION of `ws_net_flow_per_ticker` (live, uw-stream daemon) and `net_flow_per_ticker_history` (REST backfill — **post-close only**, 21:25 UTC cron). So intraday the chart is 100% WS-dependent: any daemon gap = empty chart, no fallback. Known prior art: the UW 50-channel cap incident (2026-06-02) left `net_flow` channels silently dead; sharding was added (`PER_CONN_MAX = 45`), but the same symptom shape is back.

**GATE:** Step 1 reads the production Neon DB (read-only). Requires explicit owner approval per session policy. Steps 2–3 (Railway logs, Sentry) are read-only service queries and need no DB access.

- [ ] **Step 1 (gated — owner must approve prod read): row-presence queries**

```bash
DB_URL=$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
psql "$DB_URL" <<'SQL'
-- A. Per-hour WS row counts today for the screenshot tickers
SELECT ticker, date_trunc('hour', ts) AS hour_utc, count(*) AS rows,
       min(ts) AS first_ts, max(ts) AS last_ts
FROM ws_net_flow_per_ticker
WHERE ts >= '2026-06-12T13:00:00Z' AND ts < '2026-06-12T21:00:00Z'
  AND ticker IN ('SPY','QQQ','SNDK')
GROUP BY 1,2 ORDER BY 1,2;

-- B. Daemon-level first/last tick today across the universe
SELECT min(ts) AS first_ts, max(ts) AS last_ts,
       count(*) AS rows, count(DISTINCT ticker) AS tickers
FROM ws_net_flow_per_ticker
WHERE ts >= '2026-06-12T13:00:00Z';

-- C. Timezone-shift fingerprint: future-dated rows
SELECT ticker, ts FROM ws_net_flow_per_ticker
WHERE ts > now() ORDER BY ts DESC LIMIT 20;
SQL
```

- [ ] **Step 2: uw-stream service logs**

```bash
cd uw-stream && railway logs | grep -iE 'net_flow|subscribe|lease|reconcil|restart|error' | head -100
```

Look for: daemon restarts this morning, `net_flow:` join confirmations vs. silence, lease-acquire delays, reconcile heals.

- [ ] **Step 3: Sentry events**

Query Sentry (server_name=uw-stream) for events 2026-06-12 13:00–17:00 UTC. Note any malformed-frame samples mentioning channel limits (the 50-cap fingerprint lives in `extra.sample`).

- [ ] **Step 4: Decision gate — interpret**

| Finding | Conclusion | Action |
|---|---|---|
| Query A shows a gap 13:30→~16:2x UTC, then rows | WS daemon/channel outage (restart, lease death, dead joins) | Root-cause in uw-stream from Step 2/3 evidence; ship Step 5 self-heal regardless |
| Query A shows full data all morning | Data existed; endpoint or chart bug | Reproduce: `curl '/api/net-flow-history?ticker=QQQ&date=2026-06-12&from=08:30&to=11:30'` against prod, compare to chart render; fix frontend/endpoint (new mini-plan) |
| Query C returns rows | Writer-side timezone bug | Fix uw-stream `net_flow.py` ts handling (new mini-plan) |

If the cause is a uw-stream daemon death, also cross-check against the known lease-death failure mode (Lottery + Silent Boom frozen together → `railway redeploy -y` in uw-stream/).

- [ ] **Step 5 (default-pick fix — execute if Step 4 confirms a WS gap): intraday self-heal backfill**

The existing `api/cron/fetch-net-flow-history.ts` fetches UW REST `/stock/{t}/net-prem-ticks?date={today}` for the full universe, filters to session (08:30–14:59 CT), and inserts with `ON CONFLICT (ticker, ts, source) DO NOTHING` — fully idempotent, no close-time guard. UW's endpoint returns the day-so-far intraday. So the fix is **schedule-only**: run the same path hourly during the session so any WS gap self-heals within ≤60 min.

(a) In `vercel.json`, next to the existing entry for this path (schedule `25 21 * * 1-5`), add:

```json
{
  "path": "/api/cron/fetch-net-flow-history",
  "schedule": "35 14-20 * * 1-5"
}
```

(7 intraday runs/day × ~55 tickers ≈ 385 extra UW REST calls/day — well within REST limits; the post-close run remains the authoritative final sweep.)

(b) Check for a cron-registry test: `grep -rn "fetch-net-flow-history" api/__tests__/ src/__tests__/` and `grep -rn "crons" api/__tests__/`. If a test asserts the cron list/count, add the new schedule entry there.

(c) Update the header comment in `api/cron/fetch-net-flow-history.ts` to document the dual schedule (post-close authoritative + intraday self-heal), and update the CLAUDE.md "35 scheduled jobs" count if a new cron *entry* changes it.

(d) Run: `npx vitest run api/__tests__` (cron tests) — expected PASS.

- [ ] **Step 6: Commit (diagnosis findings + fix)**

```bash
git add vercel.json api/cron/fetch-net-flow-history.ts CLAUDE.md
git commit -m 'fix(net-flow): intraday self-heal backfill schedule for ws gaps (guest feedback)'
```

Record diagnosis findings in `docs/tmp/` if substantial (per scratch-file convention), and write a memory entry if the root cause is a new failure mode.

---

## Data dependencies

- Prod Neon read (Task 3 Step 1) — **owner approval required**.
- Railway CLI access to uw-stream service logs.
- No new tables, no migrations, no new env vars.

## Open questions (with default picks)

1. `EXPANDED_ROW_CHART_HEIGHT` value — default **280px** (right chart grows from 220, left shrinks from ~450+ maximized). One-line tunable.
2. Intraday backfill cadence — default **hourly at :35 UTC, 14–20** (≤60 min self-heal). Could be 30-min if a faster heal is wanted.
3. Task 3 Step 5 only ships if the diagnosis confirms a WS-side gap; if the data was present all along, the fix is a frontend/endpoint bug hunt instead (scoped after findings).

## Verification (every task)

`npm run review` (tsc + eslint + prettier + vitest --coverage) must be green before any commit. Code-reviewer subagent reviews each task before commit per the per-phase loop.
