# Suspicious-Flow Cluster Badge + TAKE-IT Floor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Files here are large and live (parallel sessions edit them) — RE-READ each file before editing and locate the documented anchors rather than trusting line numbers.

**Goal:** Add a descriptive "suspicious-flow cluster" badge (≥3 cheap-OTM-ask 0DTE strikes co-firing per ticker+side) to the Lottery Finder and Silent Boom feeds, a TAKE-IT floor filter chip (default 0.70) on both feeds, and rewrite the TAKE-IT tooltip in plain language.

**Architecture:** Cluster detection is feed-computed — each feed endpoint runs one extra day-scoped query (`date`, `dte=0`, minimal columns), passes the rows to a shared **pure** helper (`api/_lib/suspicious-cluster.ts`) that applies the cheap/OTM/ask membership test, dedups strikes per (ticker, side), and returns a lookup of clustered sides. Endpoints stamp `suspiciousCluster` / `clusterStrikeCount` onto each DTO. The TAKE-IT chip and tooltip are pure frontend (data already in the payload). No migration, no detector-cron change.

**Tech Stack:** Vercel Functions (TS, Node 24), Neon Postgres (`@neondatabase/serverless`), Vitest, React 19, Tailwind 4, `usePersistedState` + `persist-encoding.ts` for localStorage.

**Reference spec:** `docs/superpowers/specs/2026-05-27-suspicious-flow-and-takeit-floor-design.md`

**Constants (single source of truth, defined in Task 1):**

- `MIN_CLUSTER_STRIKES = 3`
- `MAX_CHEAP_ENTRY = 1.5`
- `MIN_CLUSTER_ASK_PCT = 0.7`
- TAKE-IT floor presets: `0` (off) `/ 0.6 / 0.7 / 0.75 / 0.8`, default `0.7`

---

## PHASE 1 — Backend cluster computation + types

### Task 1: Pure suspicious-cluster helper

**Files:**

- Create: `api/_lib/suspicious-cluster.ts`
- Test: `api/__tests__/suspicious-cluster.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// api/__tests__/suspicious-cluster.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeSuspiciousClusters,
  clusterKey,
  MIN_CLUSTER_STRIKES,
  type ClusterCandidateRow,
} from '../_lib/suspicious-cluster.js';

const row = (o: Partial<ClusterCandidateRow>): ClusterCandidateRow => ({
  underlyingSymbol: 'META',
  optionType: 'C',
  strike: 617.5,
  dte: 0,
  entryPrice: 0.34,
  spot: 613,
  askPct: 0.74,
  ...o,
});

describe('computeSuspiciousClusters', () => {
  it('flags a side with >=3 distinct cheap-OTM-ask 0DTE strikes', () => {
    const rows = [
      row({ strike: 617.5 }),
      row({ strike: 615, entryPrice: 0.91 }),
      row({ strike: 622.5, entryPrice: 1.25, askPct: 0.71 }),
    ];
    const map = computeSuspiciousClusters(rows);
    expect(map.get(clusterKey('META', 'C'))).toBe(3);
  });

  it('counts DISTINCT strikes, not rows (dedupes repeated strikes)', () => {
    const rows = [
      row({ strike: 617.5 }),
      row({ strike: 617.5 }),
      row({ strike: 615 }),
    ];
    expect(computeSuspiciousClusters(rows).has(clusterKey('META', 'C'))).toBe(
      false,
    ); // only 2 distinct
  });

  it('excludes non-members: not 0DTE, too expensive, ITM, or below ask floor', () => {
    const rows = [
      row({ strike: 617.5 }),
      row({ strike: 615 }),
      row({ strike: 600, dte: 1 }), // not 0DTE
      row({ strike: 625, entryPrice: 2.0 }), // too expensive
      row({ strike: 610, spot: 620 }), // call ITM (strike < spot)
      row({ strike: 630, askPct: 0.5 }), // below ask floor
    ];
    // only 617.5 + 615 are members -> 2 distinct -> no cluster
    expect(computeSuspiciousClusters(rows).has(clusterKey('META', 'C'))).toBe(
      false,
    );
  });

  it('treats puts OTM as strike <= spot', () => {
    const rows = [
      row({ optionType: 'P', strike: 610, spot: 613 }),
      row({ optionType: 'P', strike: 612.5, spot: 613 }),
      row({ optionType: 'P', strike: 600, spot: 613 }),
    ];
    expect(computeSuspiciousClusters(rows).get(clusterKey('META', 'P'))).toBe(
      3,
    );
  });

  it('keeps calls and puts on the same ticker as separate sides', () => {
    const rows = [
      row({ optionType: 'C', strike: 617.5 }),
      row({ optionType: 'C', strike: 615 }),
      row({ optionType: 'P', strike: 610, spot: 613 }),
    ];
    const map = computeSuspiciousClusters(rows);
    expect(map.has(clusterKey('META', 'C'))).toBe(false); // 2 calls
    expect(map.has(clusterKey('META', 'P'))).toBe(false); // 1 put
  });

  it('skips rows with null spot (cannot determine OTM)', () => {
    const rows = [
      row({ strike: 617.5, spot: null }),
      row({ strike: 615, spot: null }),
      row({ strike: 622.5, spot: null }),
    ];
    expect(computeSuspiciousClusters(rows).size).toBe(0);
  });
});

describe('MIN_CLUSTER_STRIKES', () => {
  it('is 3', () => expect(MIN_CLUSTER_STRIKES).toBe(3));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run api/__tests__/suspicious-cluster.test.ts`
Expected: FAIL — cannot find module `../_lib/suspicious-cluster.js`.

(Note: the `strikeOverrideITM` key in one fixture is intentionally ignored by the type — remove it; it documents intent only. If TS complains, delete that property and rely on `spot: 620` to make the call ITM.)

- [ ] **Step 3: Write the helper**

```ts
// api/_lib/suspicious-cluster.ts
// Descriptive "suspicious flow" cluster detector — feed-computed, no persistence.
// A (ticker, side) is a suspicious cluster when >= MIN_CLUSTER_STRIKES distinct
// strikes co-fire that day as cheap, OTM, ask-side 0DTE options.
// NOTE: descriptive attention-flag only — the cohort is net negative-expectancy
// (see docs/superpowers/specs/2026-05-27-suspicious-flow-and-takeit-floor-design.md).

export const MIN_CLUSTER_STRIKES = 3;
export const MAX_CHEAP_ENTRY = 1.5;
export const MIN_CLUSTER_ASK_PCT = 0.7;

export interface ClusterCandidateRow {
  underlyingSymbol: string;
  optionType: 'C' | 'P';
  strike: number;
  dte: number;
  entryPrice: number;
  spot: number | null;
  askPct: number;
}

export function clusterKey(symbol: string, side: 'C' | 'P'): string {
  return `${symbol}|${side}`;
}

function isClusterMember(r: ClusterCandidateRow): boolean {
  if (r.dte !== 0) return false;
  if (r.spot == null) return false;
  if (!(r.entryPrice <= MAX_CHEAP_ENTRY)) return false;
  if (!(r.askPct >= MIN_CLUSTER_ASK_PCT)) return false;
  const otm = r.optionType === 'C' ? r.strike >= r.spot : r.strike <= r.spot;
  return otm;
}

// Returns Map<`${symbol}|${side}`, distinctStrikeCount> for sides meeting the threshold.
export function computeSuspiciousClusters(
  rows: ClusterCandidateRow[],
): Map<string, number> {
  const strikesByKey = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!isClusterMember(r)) continue;
    const key = clusterKey(r.underlyingSymbol, r.optionType);
    let set = strikesByKey.get(key);
    if (!set) {
      set = new Set<number>();
      strikesByKey.set(key, set);
    }
    set.add(r.strike);
  }
  const out = new Map<string, number>();
  for (const [key, set] of strikesByKey) {
    if (set.size >= MIN_CLUSTER_STRIKES) out.set(key, set.size);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run api/__tests__/suspicious-cluster.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/suspicious-cluster.ts api/__tests__/suspicious-cluster.test.ts
git commit -m "feat(suspicious-flow): pure cluster-detection helper"
```

---

### Task 2: Wire cluster detection into the Lottery Finder endpoint

**Files:**

- Modify: `api/lottery-finder.ts` (import helper; add day-scoped candidate query; build lookup; stamp `toLotteryFire`)
- Test: `api/__tests__/lottery-finder-endpoint.test.ts` (add a cluster case)

Anchors (re-read to confirm): imports near top; main query / supplementary queries ~427-673; `toLotteryFire` ~1116-1396 (return block ~1201-1395).

- [ ] **Step 1: Write the failing test** — add to the existing describe block:

```ts
it('stamps suspiciousCluster=true and clusterStrikeCount on rows whose ticker+side clusters', async () => {
  // main rows (page) -> total -> ... existing supplementary mocks ...
  // The NEW cluster-candidate query returns the day's 0DTE member rows.
  mockSql
    .mockResolvedValueOnce([ROW]) // main page
    .mockResolvedValueOnce([{ total: 1 }]) // count
    // keep any other existing supplementary mocks in their current order, then:
    .mockResolvedValueOnce([
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '617.5',
        dte: 0,
        entry_price: '0.34',
        spot_at_first: '613',
        trigger_ask_pct: '0.74',
      },
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '615',
        dte: 0,
        entry_price: '0.91',
        spot_at_first: '613',
        trigger_ask_pct: '0.75',
      },
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '622.5',
        dte: 0,
        entry_price: '1.25',
        spot_at_first: '613',
        trigger_ask_pct: '0.71',
      },
    ]);
  const req = mockRequest({ method: 'GET', query: { date: '2026-05-27' } });
  const res = mockResponse();
  await handler(req, res);
  const fire = (
    res._json as {
      fires: Array<{ suspiciousCluster: boolean; clusterStrikeCount: number }>;
    }
  ).fires[0];
  expect(fire.suspiciousCluster).toBe(true);
  expect(fire.clusterStrikeCount).toBe(3);
});
```

> IMPORTANT: the executing engineer MUST re-read `lottery-finder.ts` and place the new `mockResolvedValueOnce` in the EXACT position matching where the new query runs relative to the existing supplementary queries. Adjust the existing test's mock sequence counts accordingly (see CLAUDE.md cron/endpoint mock-sequence rule).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts`
Expected: FAIL — `suspiciousCluster` is `undefined`.

- [ ] **Step 3: Add the import** (top of `api/lottery-finder.ts`, with the other `_lib` imports):

```ts
import {
  computeSuspiciousClusters,
  clusterKey,
  type ClusterCandidateRow,
} from './_lib/suspicious-cluster.js';
```

- [ ] **Step 4: Add the day-scoped candidate query + lookup** (alongside the existing supplementary queries, after the date is resolved and BEFORE rows are mapped via `toLotteryFire`). Use the same `sql`/`withDbRetry` pattern the file already uses:

```ts
// Suspicious-flow cluster lookup — full day, 0DTE only, minimal columns.
const clusterRows = (await withDbRetry(
  () =>
    sql`
    SELECT underlying_symbol, option_type, strike, dte, entry_price,
           spot_at_first, trigger_ask_pct
    FROM lottery_finder_fires
    WHERE date = ${dateStr} AND dte = 0
  `,
)) as Array<{
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string | number;
  dte: number;
  entry_price: string | number | null;
  spot_at_first: string | number | null;
  trigger_ask_pct: string | number | null;
}>;
const clusterCandidates: ClusterCandidateRow[] = clusterRows.map((r) => ({
  underlyingSymbol: r.underlying_symbol,
  optionType: r.option_type,
  strike: Number(r.strike),
  dte: Number(r.dte),
  entryPrice:
    r.entry_price == null ? Number.POSITIVE_INFINITY : Number(r.entry_price),
  spot: r.spot_at_first == null ? null : Number(r.spot_at_first),
  askPct: r.trigger_ask_pct == null ? 0 : Number(r.trigger_ask_pct),
}));
const clusterLookup = computeSuspiciousClusters(clusterCandidates);
```

> Use the file's actual resolved-date variable name (the value passed as `date` to the main query) in place of `dateStr`, and match the file's existing `withDbRetry`/`sql` invocation style.

- [ ] **Step 5: Stamp the DTO** — pass the lookup into `toLotteryFire` (add a parameter) and add the two fields to the returned object. In the `toLotteryFire` signature add `clusterLookup: Map<string, number>`, and in the return block (near the existing `directionGated` / `dualFlag` fields) add:

```ts
suspiciousCluster: clusterLookup.has(clusterKey(r.underlying_symbol, r.option_type)),
clusterStrikeCount: clusterLookup.get(clusterKey(r.underlying_symbol, r.option_type)) ?? 0,
```

Update every call site of `toLotteryFire(...)` to pass `clusterLookup`.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/lottery-finder.ts api/__tests__/lottery-finder-endpoint.test.ts
git commit -m "feat(lottery): stamp suspicious-flow cluster on feed rows"
```

---

### Task 3: Wire cluster detection into the Silent Boom feed endpoint

**Files:**

- Modify: `api/silent-boom-feed.ts` (import helper; add day-scoped candidate query; build lookup; stamp the inline mapping)
- Test: `api/__tests__/silent-boom-feed.test.ts` (add a cluster case)

Anchors: imports near top; queries ~396-666; inline `.map()` DTO ~669-753.

- [ ] **Step 1: Write the failing test** — add to the existing describe block:

```ts
it('stamps suspiciousCluster + clusterStrikeCount from the day cluster query', async () => {
  mockSql
    .mockResolvedValueOnce([{ n: 1 }]) // count
    .mockResolvedValueOnce([
      makeAlert({ underlying_symbol: 'META', option_type: 'C', strike: 617.5 }),
    ]) // page
    .mockResolvedValueOnce([
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '617.5',
        dte: 0,
        entry_price: '0.34',
        underlying_price_at_spike: '613',
        ask_pct: '0.74',
      },
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '615',
        dte: 0,
        entry_price: '0.91',
        underlying_price_at_spike: '613',
        ask_pct: '0.75',
      },
      {
        underlying_symbol: 'META',
        option_type: 'C',
        strike: '622.5',
        dte: 0,
        entry_price: '1.25',
        underlying_price_at_spike: '613',
        ask_pct: '0.71',
      },
    ]);
  const req = mockRequest({ method: 'GET', query: { date: '2026-05-27' } });
  const res = mockResponse();
  await handler(req, res);
  const alert = (
    res._json as {
      alerts: Array<{ suspiciousCluster: boolean; clusterStrikeCount: number }>;
    }
  ).alerts[0];
  expect(alert.suspiciousCluster).toBe(true);
  expect(alert.clusterStrikeCount).toBe(3);
});
```

> Re-read `silent-boom-feed.ts`: the count query runs first, then ONE of four sort-branch page queries. Place the new cluster query AFTER the page query and add the `mockResolvedValueOnce` in that exact position. Update the other existing tests' mock sequences if the new query is unconditional.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run api/__tests__/silent-boom-feed.test.ts`
Expected: FAIL — `suspiciousCluster` undefined.

- [ ] **Step 3: Add the import:**

```ts
import {
  computeSuspiciousClusters,
  clusterKey,
  type ClusterCandidateRow,
} from './_lib/suspicious-cluster.js';
```

- [ ] **Step 4: Add the candidate query + lookup** (after the page query resolves, before the `.map()`):

```ts
const clusterRows = (await withDbRetry(
  () =>
    sql`
    SELECT underlying_symbol, option_type, strike, dte, entry_price,
           underlying_price_at_spike, ask_pct
    FROM silent_boom_alerts
    WHERE date = ${dateStr} AND dte = 0
  `,
)) as Array<{
  underlying_symbol: string;
  option_type: 'C' | 'P';
  strike: string | number;
  dte: number;
  entry_price: string | number | null;
  underlying_price_at_spike: string | number | null;
  ask_pct: string | number | null;
}>;
const clusterCandidates: ClusterCandidateRow[] = clusterRows.map((r) => ({
  underlyingSymbol: r.underlying_symbol,
  optionType: r.option_type,
  strike: Number(r.strike),
  dte: Number(r.dte),
  entryPrice:
    r.entry_price == null ? Number.POSITIVE_INFINITY : Number(r.entry_price),
  spot:
    r.underlying_price_at_spike == null
      ? null
      : Number(r.underlying_price_at_spike),
  askPct: r.ask_pct == null ? 0 : Number(r.ask_pct),
}));
const clusterLookup = computeSuspiciousClusters(clusterCandidates);
```

- [ ] **Step 5: Stamp the inline DTO** — inside the `.map()` returned object, add:

```ts
suspiciousCluster: clusterLookup.has(clusterKey(r.underlying_symbol, r.option_type)),
clusterStrikeCount: clusterLookup.get(clusterKey(r.underlying_symbol, r.option_type)) ?? 0,
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run api/__tests__/silent-boom-feed.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/silent-boom-feed.ts api/__tests__/silent-boom-feed.test.ts
git commit -m "feat(silent-boom): stamp suspicious-flow cluster on feed rows"
```

---

### Task 4: Add the new fields to frontend types

**Files:**

- Modify: `src/components/LotteryFinder/types.ts` (add to `LotteryFire`)
- Modify: `src/components/SilentBoom/types.ts` (add to the alert interface)

- [ ] **Step 1: Add to `LotteryFire`** (near `directionGated`):

```ts
  /** True when this row's ticker+side has >=3 cheap-OTM-ask 0DTE strikes co-firing today (descriptive only). */
  suspiciousCluster?: boolean;
  /** Distinct cheap-OTM-ask 0DTE strike count for this row's ticker+side (0 when not a cluster). */
  clusterStrikeCount?: number;
```

- [ ] **Step 2: Add the same two fields** to the Silent Boom alert interface in `src/components/SilentBoom/types.ts`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (optional fields, no consumers yet).

- [ ] **Step 4: Commit**

```bash
git add src/components/LotteryFinder/types.ts src/components/SilentBoom/types.ts
git commit -m "feat(types): add suspiciousCluster + clusterStrikeCount to feed types"
```

---

## PHASE 2 — Frontend (badge, TAKE-IT chip, tooltip)

### Task 5: Cluster badge on both ticker-group headers

**Files:**

- Modify: `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`
- Modify: `src/components/SilentBoom/SilentBoomTickerGroup.tsx`
- Test: `src/__tests__/LotteryFinderSection.test.tsx` (or the ticker-group test) — add a render assertion

Badge label/color must be DISTINCT from the existing ✦ conviction (amber) and ⚡ storm (rose) chips. Use **violet** + label `🎰 OTM SWEEP ×N`.

- [ ] **Step 1: Write the failing test** — render a group whose fires include `suspiciousCluster: true, clusterStrikeCount: 3` and assert the chip:

```ts
expect(screen.getByTestId(`lottery-ticker-cluster-META`)).toHaveTextContent(
  'OTM SWEEP ×3',
);
```

(Use the existing `makeFire` factory; set `suspiciousCluster: true`, `clusterStrikeCount: 3` on the group's fires. Follow the test file's existing render+mock setup.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`
Expected: FAIL — testid not found.

- [ ] **Step 3: Derive cluster state in the group component.** In `LotteryFinderTickerGroup.tsx`, near where `conviction`/`storm` are computed, derive from the group's fires:

```tsx
const clusterStrikes = Math.max(
  0,
  ...fires.map((f) => (f.suspiciousCluster ? (f.clusterStrikeCount ?? 0) : 0)),
);
const showClusterBadge = clusterStrikes >= 3;
```

> Use the actual prop name for the group's fire array (re-read; likely `fires` or `rows`).

- [ ] **Step 4: Render the chip** — after the storm badge block, following the exact existing badge `<span>` pattern (violet, distinct from amber/rose):

```tsx
{
  showClusterBadge && (
    <span
      className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[11px] font-bold text-violet-200 ring-1 ring-violet-400/60"
      title="≥3 cheap, OTM, ask-side 0DTE strikes co-fired on this ticker today — the smart-money lottery-sweep profile. Descriptive context only, NOT a conviction signal (the cohort is net negative-expectancy). Use TAKE-IT for conviction."
      data-testid={`lottery-ticker-cluster-${ticker}`}
    >
      🎰 OTM SWEEP ×{clusterStrikes}
    </span>
  );
}
```

- [ ] **Step 5: Mirror in `SilentBoomTickerGroup.tsx`** — same derivation + chip, `data-testid={`silent-boom-ticker-cluster-${ticker}`}`.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/LotteryFinder/LotteryFinderTickerGroup.tsx src/components/SilentBoom/SilentBoomTickerGroup.tsx src/__tests__/LotteryFinderSection.test.tsx
git commit -m "feat(feeds): OTM-sweep cluster badge on ticker-group headers"
```

---

### Task 6: TAKE-IT floor chip — Lottery Finder

**Files:**

- Modify: `src/components/LotteryFinder/index.tsx`
- Test: `src/__tests__/LotteryFinderSection.test.tsx`

- [ ] **Step 1: Write the failing test** — assert the chip group renders and a non-default preset hides a low-score fire:

```ts
expect(screen.getByTestId('takeit-floor-0.7')).toBeInTheDocument();
// with two fires (takeitProb 0.8 and 0.3) and default floor 0.70, only the 0.8 fire shows
```

(Follow existing filter-chip tests; the default floor is 0.70 so this also verifies default-on behavior.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the preset constant** (near `MIN_FIRE_COUNT_OPTIONS`):

```tsx
const TAKEIT_FLOOR_OPTIONS: Array<{
  value: number;
  label: string;
  tooltip: string;
}> = [
  { value: 0, label: 'all', tooltip: 'No TAKE-IT floor.' },
  {
    value: 0.6,
    label: '≥0.60',
    tooltip: 'Hide fires below 0.60 calibrated P(peak ≥ +20%).',
  },
  {
    value: 0.7,
    label: '≥0.70',
    tooltip:
      'Default. ~0.70 is where historical realized return stops being negative.',
  },
  {
    value: 0.75,
    label: '≥0.75',
    tooltip: 'Stricter — clearly positive expectancy historically.',
  },
  { value: 0.8, label: '≥0.80', tooltip: 'Rare elite tail (≈1–4% of fires).' },
];
const TAKEIT_FLOOR_LS_KEY = 'lottery.takeitFloor';
```

- [ ] **Step 4: Add persisted state** (near the other `usePersistedState` calls). Import `floatPersistOpts` from `../../hooks/persist-encoding.js` if not already imported:

```tsx
const [takeitFloor, setTakeitFloor] = usePersistedState<number>(
  TAKEIT_FLOOR_LS_KEY,
  0.7,
  floatPersistOpts,
);
```

- [ ] **Step 5: Add the filter to `applyClientFilters`** — append:

```tsx
if (takeitFloor > 0) {
  out = out.filter((f) => f.takeitProb != null && f.takeitProb >= takeitFloor);
}
```

Add `takeitFloor` to the `useCallback` dependency array.

- [ ] **Step 6: Add the hidden-count derivation + display.** Near the other `hiddenXCount` derivations:

```tsx
const hiddenTakeitCount =
  takeitFloor > 0
    ? fires.filter((f) => f.takeitProb == null || f.takeitProb < takeitFloor)
        .length
    : 0;
```

In the hidden-count info row (with the other `({n} ... hidden)` spans):

```tsx
{
  takeitFloor > 0 && hiddenTakeitCount > 0 && (
    <span className="ml-2 text-sky-300/80">
      ({hiddenTakeitCount} hidden below TAKE-IT {takeitFloor.toFixed(2)})
    </span>
  );
}
```

- [ ] **Step 7: Render the chip group** (after the burst-filter chip group), following the `FilterChip` pattern:

```tsx
<span className={SECTION_LABEL}>TAKE-IT</span>;
{
  TAKEIT_FLOOR_OPTIONS.map((o) => {
    const active = takeitFloor === o.value;
    return (
      <FilterChip
        key={o.value}
        active={active}
        activeColor="sky"
        onClick={() => setTakeitFloor(o.value)}
        title={o.tooltip}
        ariaPressed={active}
        testId={`takeit-floor-${o.value}`}
      >
        {o.label}
      </FilterChip>
    );
  });
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/__tests__/LotteryFinderSection.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/LotteryFinder/index.tsx src/__tests__/LotteryFinderSection.test.tsx
git commit -m "feat(lottery): TAKE-IT floor filter chip (default 0.70)"
```

---

### Task 7: TAKE-IT floor chip — Silent Boom

**Files:**

- Modify: `src/components/SilentBoom/index.tsx`
- Test: `src/__tests__/SilentBoomSection.test.tsx`

- [ ] **Step 1: Write the failing test** — mirror Task 6 Step 1 with `silent-boom` testids and the `makeAlert` factory.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/__tests__/SilentBoomSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3–7: Repeat Task 6 Steps 3–7** in `SilentBoom/index.tsx` with:
  - `TAKEIT_FLOOR_LS_KEY = 'silentBoom.takeitFloor'`
  - same `TAKEIT_FLOOR_OPTIONS` array (copy it — do not import across feature folders)
  - the Silent Boom filter predicate location (the file's client-filter function or the `useMemo` that derives the rendered list)
  - testId `takeit-floor-${o.value}` (kept identical; tests are scoped per section render)

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/__tests__/SilentBoomSection.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/SilentBoom/index.tsx src/__tests__/SilentBoomSection.test.tsx
git commit -m "feat(silent-boom): TAKE-IT floor filter chip (default 0.70)"
```

---

### Task 8: TAKE-IT tooltip rewrite

**Files:**

- Modify: `src/components/TakeItScore/TakeItScore.tsx` (~line 174-177)
- Test: `src/components/TakeItScore/TakeItScore.test.tsx` (create if absent) — assert the new title text

- [ ] **Step 1: Write the failing test:**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TakeItScore } from './TakeItScore';

describe('TakeItScore tooltip', () => {
  it('uses plain-language tooltip for a scored chip', () => {
    render(<TakeItScore prob={0.78} topFeatures={null} />);
    expect(screen.getByTestId('takeit-score-chip')).toHaveAttribute(
      'title',
      expect.stringContaining('reaches at least +20%'),
    );
  });
  it('uses a plain null-state tooltip', () => {
    render(<TakeItScore prob={null} topFeatures={null} />);
    expect(
      screen.getByTestId('takeit-score-chip').getAttribute('title'),
    ).toContain('model bundle was unavailable');
  });
});
```

> `toHaveAttribute('title', expect.stringContaining(...))` requires jest-dom asymmetric-matcher support; if the matcher errors, use `screen.getByTestId('takeit-score-chip').getAttribute('title')` + `toContain(...)` in both cases.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/TakeItScore/TakeItScore.test.tsx`
Expected: FAIL — current title is the old XGBoost copy.

- [ ] **Step 3: Replace the `title` expression:**

```tsx
title={
  prob == null
    ? 'No score — the model bundle was unavailable when this alert fired.'
    : 'How confident the model is this trade reaches at least +20% above entry. 0–1, higher is better; ~0.70+ is where the historical edge concentrates.'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/TakeItScore/TakeItScore.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TakeItScore/TakeItScore.tsx src/components/TakeItScore/TakeItScore.test.tsx
git commit -m "feat(takeit): plain-language tooltip"
```

---

## Final verification (after all tasks)

- [ ] Run the full gate: `npm run review` (tsc + eslint + prettier + vitest --coverage). Fix every failure before declaring done — type/lint breakage from these edits commonly surfaces in unrelated files.
- [ ] Manual smoke (optional): load the Lottery + Silent Boom feeds, confirm the TAKE-IT chip defaults to ≥0.70 with a visible "hidden below TAKE-IT 0.70" note, and that a known cluster day (e.g. META 2026-05-27) shows the 🎰 OTM SWEEP ×3 chip.

## Out of scope (separate spec)

The TAKE-IT-conditioned gate fix lives in `docs/superpowers/specs/2026-05-27-takeit-conditioned-gate-fix-design.md` and is NOT part of this plan.
