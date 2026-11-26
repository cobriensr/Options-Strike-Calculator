# GEXBot Panels After the Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the cash close and until the next session's first capture, every GEXBot-fed panel shows the last session's final values with a `CLOSED · as of <time>` label instead of an empty state.

**Architecture:** When `isMarketOpen()` is false, the three endpoints anchor their windows on each ticker's newest non-replay row instead of the clock, take the session date from the newest row, and return a capture-time `asOf`. The client drops live-route data carried over from before today's 09:30 ET open once the market is open, labels closed data, refetches at the open, and fires one re-armed "final fetch" at close + 3 min. It retries a failed fetch while closed.

**Tech Stack:** TypeScript, Vercel Functions, Neon (`@neondatabase/serverless`), pglite for SQL tests, React 19, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md` (approved 2026-11-26)

## Global Constraints

- In-session windows are unchanged: 15 / 15 / 60 / 5 min, and `STALENESS_CUTOFF_MS` (5 min, `api/_lib/periscope-gexbot.ts:26`).
- Server live/closed switch: `isMarketOpen()` (`api/_lib/cron-helpers.ts:181`; zero-arg, close minute inclusive, holiday- and half-day-aware), imported through `./_lib/api-helpers.js`.
- Anchor scan: the 15 minutes up to the table's newest row.
- Client "carried over" floor: the current session's open, 09:30 ET.
- Client final fetch: close + `CLOSED_FINAL_FETCH_OFFSET_MIN` (3) min, so 16:03 ET or 13:03 ET on a half day. It is re-armed for each trading day.
  - The constant is defined once, in `src/data/marketHours.ts`, and both the server's cache window and the client's timer use it.
- Retry: a transient failure (status 0, 408, 429 or ≥ 500) of any live-route fetch while closed is retried every 30 s, at most 5 times.
- A closed response's whole cache life (`s-maxage` + `stale-while-revalidate`) ends before close + 3 min on a close day, and before the next 09:30 ET.
- Label: `CLOSED · as of Fri 3:00 PM CT`, with weekday and time in CT. Add the date when the capture is more than 6 days old: `Fri Nov 20 3:00 PM CT`.
- In the session, behavior changes in only two ways. `asOf` becomes a capture time on every path. A scrub to a session's first minute reads `no_slot`, not `no_spot`.
  - An in-session `no_slot` (stalled feed) keeps its minute list, slot list and stall message.
- Picked Periscope slots and landscape `at` scrubs are exempt from every client clock rule.
- Every endpoint keeps its owner-or-guest guard (data-licensing rule).
- At most 5 files per task. Each task is reviewed and committed on the branch. The branch goes to main once, after Task 17 (owner, 2026-11-21).
- Each task tests the spec's clock edges where they apply (spec, "Tests: clock edges").

## Review Focus

1. **A holiday followed by a half day** (2026-11-26 Thanksgiving, then 2026-11-27 closing 13:00 ET). The server stays closed all Thursday and shows Wednesday. The client's next final fetch on Thursday is `2026-11-27T18:03:00.000Z`. Owner: Task 8, with cache tests in Task 2.
2. **A tab asleep through the close** (lid shut at 14:50 CT, opened at 19:00 CT). A timer may not count sleep, and iOS freezes background tabs.
   - On `visibilitychange` (visible), `pageshow` or `focus`, the final fetch fires if the armed instant has passed.
   - It fires once, then re-arms for the next trading day.
   - Owner: Task 8.
3. **A page loaded after the close whose first fetch fails** (Friday 19:00 CT reload, a Neon blip answers 503). It retries 5 × 30 s rather than showing the error until Monday. Owners: Tasks 8, 9, 11 and 16.
4. **A browser outside Central time.** Labels must read CT whatever the runner's time zone; CI runs UTC, so a CT assertion only passes with an explicit `timeZone`. Owners: Task 8 and Task 12.
5. **The two GEXBot tables ending on different sessions.** Snapshots hold Friday while the capture table holds only Thursday. The Taker Flow header labels Friday, so the Strike Mover Ladder (capture table) must show its closed empty text rather than Thursday's rows under Friday's label. Owner: Task 10.

## Where the code differs from the spec

The spec is from 2026-11-21. The code was checked against main on 2026-11-26, and these rulings settle the drift:

| Spec says | Code today | Plan does |
|---|---|---|
| Closed-cache helper "next to `setCacheHeaders`" (`auth-helpers.ts`) | `setLiveReadCache` (`api/_lib/live-read-cache.ts`) is shared by landscape, map, `periscope-exposure` and `periscope-strikes` | Add `setClosedReadCache` in `live-read-cache.ts` and leave `setLiveReadCache` alone, so `periscope-exposure` and `periscope-strikes` keep their rule. `/api/gexbot`, landscape and map call it on the closed live route (Tasks 3, 5, 6) |
| `ScrubControls` pill is shared with DarkPoolLevels and GexTarget | Only GexLandscape uses `ScrubControls`; the others use `ScrubControlsCompact` | Keep the pill opt-in anyway (Task 13) |
| "the optional closed-bias marker in the context's Zod schema" | `analyzeBodySchema.context` is a `z.record` bag with caps; no named fields | Validate one named key, `gexLandscapeBiasClosedAsOf`, inside the existing `superRefine` (Task 12) |
| Strike Mover Ladder empty text "No winners in last 5 min" | `No {MODEL_LABEL} winners in last 5 min (0DTE)` | Closed: `No {MODEL_LABEL} winners in the session's last 5 min (0DTE)` (Task 10) |
| `index.tsx:155` clears `liveTimestamps` | The clear is the render-time reset at `GexLandscape/index.tsx:175-179`; the refill effect (205-208) only reruns on a new `timestamps` | Refetch once when the ET date rolls, so `timestamps` changes and the refill reruns (Task 11) |
| "live only when `asOf` is at or after the open" | An in-session `no_slot` carries today's `availableMinutes` with no capture of its own. `GexLandscape/index.tsx:232` and `265-274` build the "Feed stalled" text from those minutes | The client drops a response only when the newest capture it carries is before today's open: `asOf`, else the last listed minute or slot (`isCarriedOver`, Task 8). A null-`asOf` `no_slot` in the session keeps its lists |
| — | `lastCaptureAgeMs` (`useGexLandscapeData.ts:225-236`) reads a `no_slot` `asOf` as the server clock | `no_slot`'s `asOf` becomes null (Task 5). So the `no_slot` body gains a server-measured `lastMinuteAgeSec`, and Task 11 reads it. The client clock stays out, as `useGexLandscapeData.test.ts:879-926` pins |
| — | `periscope-map` sets `asOf` to `new Date()` on every path, the normal path included | Capture time on every path (Task 6) |
| Retry only for the final fetch | The spec's reason, "polling is off after the close", also covers a failed first load after the close | Retry any failed live-route fetch while closed (Tasks 8, 9, 11, 16) |
| Phase 8 in one step | The clock helpers, a shared final-fetch hook and `useGexbotData` are 6 files | Split into Task 8 (helpers and hook) and Task 9 (`useGexbotData`) |
| Phase 13 in one step | `useAnalysisContext.ts:241` ends in `satisfies AnalysisContext` (`src/components/ChartAnalysis/types.ts:77`), a sixth file | Split into Task 14 (context type and hook) and Task 15 (panel and `App.tsx`) |
| Phase 14 threads `marketOpen` to `PeriscopePanel` | The panel would carry an unused prop until Phase 15 | The `App.tsx` threading moves into Task 17, with the panel change |
| Taker Flow label source "left to the builder" | `useGexbotData` dedupes in-flight fetches per URL | `GexbotSection` reads `snapshots-latest` itself and labels from its `asOf`. It passes the ladder its session `asOf` and the SPX spot fallback (Task 10) |

**Production check (2026-11-26, read-only, session 2026-11-25):** each of the 16 tickers had 392 snapshot rows and no NULL stamps. Every ticker's last stamp change was at 21:00:50Z, and every last row was the 21:01:49Z replay. So the anchor rule labels that session 3:00 PM CT. Whether GEXBot freezes at 13:00 ET on a half day is unchecked: 2026-11-27 is the first half day in the capture history.

**Parallel work to merge with:** another session is building the GEXBot level ladder (spec `b01fcc455`, commits `ed81ca8ef`…`052de3741`). It changed `getLatestSnapshots` and the client's snapshot row. Its phase 3a also edits `src/components/Gexbot/index.tsx` and `GexbotSection.test.tsx`, which Task 10 touches. Start the branch from main at setup, and rebase before landing.

## Setup (controller, before Task 1)

- Bring `.worktrees/gexbot-after-close` (branch `feat/gexbot-after-close`, no commits of its own) up to `origin/main`. First, its untracked copy of the spec blocks the fast-forward, so remove it, but only after `git hash-object` on it matches `git rev-parse 2162f5316:docs/superpowers/specs/2026-11-20-gexbot-after-close-design.md`. Then run `git merge --ff-only origin/main` and `npm ci`.
- The worktree runs the current `.githooks/pre-commit` once it takes main.

## Task map

| Task | Spec phase | What |
|---|---|---|
| 1 | 1 | Charm Clock closed line |
| 2 | 2 | Closed-cache helper and the shared offset |
| 3 | 3 | Anchors + `snapshots-latest`, `convexity-trend`, `maxchange-winners` |
| 4 | 4 | Velocity on anchors |
| 5 | 5 | `/api/gex-landscape` |
| 6 | 6 | `/api/periscope-map` |
| 7 | 7 | Cleanup keeps the newest session |
| 8 | 8 (part) | Client clock helpers + `useFinalFetch` |
| 9 | 8 (part) | `useGexbotData` |
| 10 | 9 | Taker Flow labels |
| 11 | 10 | `useGexLandscapeData` |
| 12 | 11 | Analyze context marker (server) |
| 13 | 12 | GEX Landscape CLOSED pill |
| 14 | 13 (part) | Analysis context type and hook |
| 15 | 13 (part) | GEX Landscape bias marker and `App.tsx` |
| 16 | 14 | `usePeriscopeExposure` |
| 17 | 15 | Periscope panel + `marketOpen` threading |

---

### Task 1: Charm Clock closed line

**Files:**
- Modify: `src/components/Gexbot/CharmClock.tsx`
- Test: `src/__tests__/CharmClock.test.tsx`

**Interfaces:** Consumes `CharmClockProps { marketOpen: boolean }` (unchanged). Produces nothing.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders one closed line and no By-close cells when the market is closed', () => {
  render(<CharmClock marketOpen={false} />); // hook mocked with rows for SPX, NDX
  expect(screen.getByText('Charm Clock: closed. By-close drift resumes at the open.')).toBeInTheDocument();
  expect(screen.queryByTestId(/^charm-by-close-/)).toBeNull();
});
it('renders the table when the market is open', () => {
  render(<CharmClock marketOpen />);
  expect(screen.getByTestId('charm-by-close-SPX')).toBeInTheDocument();
});
```

- [ ] **Step 2:** Run `npx vitest run src/__tests__/CharmClock.test.tsx`. Expected: the first test FAILS.
- [ ] **Step 3:** In `CharmClock.tsx`, return the single line as the body when `!marketOpen`, before the rows render. Keep the panel frame. The existing tests at `CharmClock.test.tsx:259` and `:277` render `marketOpen={false}` and expect the table, so update them.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Show a one-line closed note in the Charm Clock after the close`.

---

### Task 2: Closed-cache helper and the shared offset

**Files:**
- Modify: `src/data/marketHours.ts` (one constant)
- Modify: `api/_lib/live-read-cache.ts`
- Test: `api/__tests__/live-read-cache.test.ts`

**Interfaces:**
- Produces:
  - `export const CLOSED_FINAL_FETCH_OFFSET_MIN = 3;` in `src/data/marketHours.ts`. That file is server-pulled, so keep it free of extension-less relative imports.
  - `export function closedCacheSeconds(now: Date): { edgeSec: number; swr: number }`
  - `export function setClosedReadCache(res: VercelResponse, now?: Date): void`, which calls `setCacheHeaders(res, edgeSec, swr)`
- `setLiveReadCache` is unchanged.
- Rule for `closedCacheSeconds`:
  - On a trading day (`isTradingDay(date)`; `getMarketCloseHourET` alone returns 16 on weekends), from the close instant (`getMarketCloseHourET(date)` ET) up to close + `CLOSED_FINAL_FETCH_OFFSET_MIN` (exclusive), it returns `{ 0, 0 }`.
  - Otherwise, let `untilOpen` be the whole seconds to the next 09:30 ET wall clock (any calendar day). Then `edgeSec = min(300, untilOpen)` and `swr = min(60, untilOpen − edgeSec)`.

- [ ] **Step 1: Write the failing tests:**

```ts
it.each([
  ['2026-11-20T21:01:30Z', 0, 0],     // Fri 16:01:30 ET, inside close..close+3
  ['2026-11-20T21:03:00Z', 300, 60],  // Fri 16:03:00 ET
  ['2026-11-27T18:02:00Z', 0, 0],     // half day 13:02 ET
  ['2026-11-26T21:02:00Z', 300, 60],  // Thanksgiving: no close window
  ['2026-11-21T21:01:00Z', 300, 60],  // Saturday 16:01 ET: no close window
  ['2026-11-23T14:24:00Z', 300, 60],  // Mon 09:24 ET, 360 s to open
  ['2026-11-23T14:25:00Z', 300, 0],   // 300 s to open
  ['2026-11-23T14:28:00Z', 120, 0],   // 120 s to open
  ['2026-11-02T14:25:00Z', 300, 0],   // the Monday after DST ends: 09:25 EST
])('closedCacheSeconds(%s) = %i / %i', (iso, edge, swr) => {
  expect(closedCacheSeconds(new Date(iso))).toEqual({ edgeSec: edge, swr });
});
it('setClosedReadCache sends the computed pair', () => {
  setClosedReadCache(res, new Date('2026-11-20T21:01:30Z'));
  expect(setCacheHeaders).toHaveBeenCalledWith(res, 0, 0);
});
```

- [ ] **Step 2:** Run `npx vitest run api/__tests__/live-read-cache.test.ts`. Expected: FAIL (no export).
- [ ] **Step 3:** Implement with `etWallClockToUtcIso` and `getMarketCloseHourET`.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(cache): Add the closed-market cache rule that ends before the final fetch and the open`.

---

### Task 3: Anchors and the three `/api/gexbot` views

**Files:**
- Modify: `api/_lib/gexbot-queries.ts`, `api/gexbot.ts`
- Create: `api/__tests__/gexbot-anchors-pglite.test.ts`
- Test: `api/__tests__/gexbot-endpoint.test.ts`, and `api/__tests__/gexbot-queries.test.ts` only if its row mapping changes

**Interfaces:**

```ts
export type GexbotAnchorTable = 'gexbot_snapshots' | 'gexbot_api_capture';
export interface ClosedAnchors {
  /** ET date (YYYY-MM-DD) of the table's newest row. */
  sessionDate: string;
  /** ticker → ISO capture time of that ticker's anchor row. */
  byTicker: ReadonlyMap<string, string>;
}
/** null when the table is empty. */
export async function getClosedAnchors(table: GexbotAnchorTable): Promise<ClosedAnchors | null>;
export async function getLatestSnapshots(anchors?: ClosedAnchors): Promise<SnapshotsLatestRow[]>;
export async function getConvexityTrend(windowMinutes?: number, anchors?: ClosedAnchors): Promise<ConvexityTrendRow[]>;
export async function getMaxchangeWinners(anchors?: ClosedAnchors): Promise<MaxchangeWinnerRow[]>;
```

- **Anchor rule:**
  - On `gexbot_snapshots`: per ticker, the newest row in `[newest − 15 min, newest]` whose `source_timestamp` is non-NULL and `IS DISTINCT FROM` that ticker's previous row's. The previous row may lie outside the 15 minutes.
  - On `gexbot_api_capture`: the newest row with a non-NULL `source_timestamp` in the same 15 minutes.
  - A ticker with no qualifying row is absent. `sessionDate` is the ET date of the table's newest row.
- **With `anchors`, every window ends at the ticker's anchor** (`captured_at <= anchor`):
  - snapshots: `anchor − 15 min`, with the existing `source_timestamp >= day_start` rule kept and `day_start` = ET midnight of `sessionDate`;
  - convexity: `anchor − windowMinutes`;
  - maxchange: `anchor − 5 min`.
- Without `anchors`, the SQL is exactly today's.
- **`api/gexbot.ts`:**
  - It computes `const closed = !isMarketOpen()`.
  - For the three views when closed, it calls `getClosedAnchors` (snapshots table for `snapshots-latest` and `convexity-trend`, capture table for `maxchange-winners`). A null result gives `rows: []`.
  - The body becomes `{ rows, asOf }`. `asOf` is the latest capture time in the returned payload (the max `capturedAt`, or for convexity the max series timestamp), or null when the payload is empty. This holds in both modes and for these views only; `velocity` gets the same in Task 4.
  - Cache: closed → `setClosedReadCache(res)`; live → `setCacheHeaders(res, 15)` (unchanged).

- [ ] **Step 1: Write the failing pglite tests.** Use `applyMigration(pg, 156)` and the `seed` and `epoch(iso)` style of `gexbot-velocity-pglite.test.ts`. Stamps are vendor epoch seconds, so they must fall inside the session to pass the `day_start` rule. The session is 2026-11-20 (EST).

```ts
// seed snapshots (capture → stamp):
//  SPX    20:58:49Z → epoch('20:58:00Z') · 20:59:49Z → epoch('20:59:00Z') · 21:00:49Z → epoch('21:00:00Z') · 21:01:49Z → epoch('21:00:00Z') (replay)
//  NDX    20:59:50Z → epoch('20:59:01Z') · 21:00:50Z → epoch('21:00:01Z') · 21:01:50Z → epoch('21:00:01Z') (replay)
//  ES_SPX 21:00:55Z → epoch('21:00:05Z') · 21:01:55Z → epoch('21:01:05Z') (late updater, new stamp)
//  QQQ    20:40:00Z → epoch('20:39:00Z') (older than newest − 15 min)
//  IWM    21:00:30Z → epoch('20:59:40Z') · 21:01:30Z → NULL
it('anchors each ticker on its newest non-replay row', async () => {
  const a = await getClosedAnchors('gexbot_snapshots');
  expect(a?.sessionDate).toBe('2026-11-20');
  expect(Object.fromEntries(a!.byTicker)).toEqual({
    SPX: '2026-11-20T21:00:49.000Z', NDX: '2026-11-20T21:00:50.000Z',
    ES_SPX: '2026-11-20T21:01:55.000Z', IWM: '2026-11-20T21:00:30.000Z',
  });
});
it('returns null on an empty table', async () => { /* DELETE all */ expect(await getClosedAnchors('gexbot_snapshots')).toBeNull(); });
it('getLatestSnapshots(anchors) returns the anchor row, not the replay', async () => {
  const rows = await getLatestSnapshots((await getClosedAnchors('gexbot_snapshots'))!);
  expect(rows.find((r) => r.ticker === 'SPX')?.capturedAt).toBe('2026-11-20T21:00:49.000Z');
  expect(rows.some((r) => r.ticker === 'QQQ')).toBe(false);
});
it('gexbot_api_capture anchors skip NULL stamps', async () => { /* SPX 21:00:49Z stamp epoch('21:00:00Z') · 21:01:49Z NULL → 21:00:49Z */ });
it('getConvexityTrend(60, anchors) ends each series at the anchor and starts it 60 min before', async () => {
  // SPX zcvr rows 19:59:49Z … 21:01:49Z (replay) → series first point 20:00:49Z, last 21:00:49Z
});
it('getMaxchangeWinners(anchors) reads the 5 min up to the anchor only', async () => {
  // capture rows for SPX maxchange at 20:55:30Z, 20:56:49Z, 21:00:49Z → newest per (endpoint, category) is 21:00:49Z; 20:55:30Z excluded
});
```

  Add endpoint tests (mock style) with `isMarketOpen` mocked through `api-helpers`. `vi.resetAllMocks()` wipes the mock's factory value, so set `isMarketOpen.mockReturnValue(true)` in `beforeEach`; an `undefined` would now read as closed.
  - closed `snapshots-latest` calls `getClosedAnchors('gexbot_snapshots')` and passes its result through;
  - closed `maxchange-winners` uses `'gexbot_api_capture'`;
  - null anchors give `{ rows: [], asOf: null }`;
  - closed calls `setClosedReadCache`, live calls `setCacheHeaders(res, 15)`;
  - live `asOf` is the max `capturedAt`;
  - `getClosedAnchors` rejecting → 500 with the Sentry capture, as the file's other failure cases do (R4).
- [ ] **Step 2:** Run `npx vitest run api/__tests__/gexbot-anchors-pglite.test.ts api/__tests__/gexbot-endpoint.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. One probe query per table is the expected shape: a window over the 15 minutes plus enough earlier rows for `LAG`. The readers join the anchors through `unnest(${tickers}::text[], ${anchorIsos}::timestamptz[])`.
- [ ] **Step 4:** Run the same files plus `api/__tests__/gexbot-queries.test.ts`. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Anchor the snapshot, convexity and mover views on each ticker's last capture when closed`.

---

### Task 4: Velocity on anchors

**Files:**
- Modify: `api/_lib/gexbot-queries.ts`, `api/gexbot.ts` (velocity case)
- Test: `api/__tests__/gexbot-velocity-pglite.test.ts`, `api/__tests__/gexbot-endpoint.test.ts`

**Interfaces:**
- `export async function getVelocityTape(anchors?: ClosedAnchors): Promise<VelocityRow[]>`.
- With `anchors`:
  - each ticker's `now_ts` is its anchor;
  - `day_start` = ET midnight of `anchors.sessionDate`;
  - the 3-minute gap, stale-source and 15-minute rules are unchanged, measured from the anchor.
- `api/gexbot.ts` velocity: when closed, it uses `getClosedAnchors('gexbot_snapshots')` and returns `{ rows, asOf }`, with the same `asOf` and cache rules as Task 3.

- [ ] **Step 1: Write the failing tests** (in the pglite file, fake time `2026-11-21T15:00:00Z`, Saturday):

```ts
it('closed: SPX delta is anchor minus previous minute, not nulled by the replay', async () => {
  // seed SPX 20:59:49Z agg 100 stamp epoch('20:59:00Z') · 21:00:49Z agg 130 epoch('21:00:00Z') · 21:01:49Z agg 130 epoch('21:00:00Z')
  const rows = await getVelocityTape((await getClosedAnchors('gexbot_snapshots'))!);
  const spx = rows.find((r) => r.ticker === 'SPX')!;
  expect(spx.capturedAt).toBe('2026-11-20T21:00:49.000Z');
  expect(spx.dAggDex).toBe(30);
});
it('closed: a ticker absent from the anchors is absent from the tape', async () => { /* QQQ old row only */ });
it('live call with no anchors is unchanged', async () => { /* existing cases keep passing */ });
```

- [ ] **Step 2:** Run `npx vitest run api/__tests__/gexbot-velocity-pglite.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement per-ticker bounds by joining the anchors' `unnest` in place of the single `bounds` row when `anchors` is given.
- [ ] **Step 4:** Run the pglite file and `gexbot-endpoint.test.ts`. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Measure the velocity tape from each ticker's last capture when closed`.

---

### Task 5: `/api/gex-landscape`

**Files:**
- Modify: `api/gex-landscape.ts`
- Test: `api/__tests__/gex-landscape.test.ts`

**Interfaces:**
- Consumes `getClosedAnchors('gexbot_api_capture')` (Task 3), mocked through a partial `vi.mock('../_lib/gexbot-queries.js')`, and `setClosedReadCache` (Task 2).
- **The test's `src/utils/timezone.js` mock** (lines 65-67) must spread `await importOriginal()`. It stubs only `getETDateStr`, and the closed path and `live-read-cache.ts` need the real `etWallClockToUtcIso`.
- **Closed live read:**
  - The SPX anchor is `anchors.byTicker.get('SPX')`; check the ticker name against `GEXBOT_TICKERS`.
  - Each panel's row is the newest with `captured_at <= anchor` and `captured_at >= ET midnight of anchors.sessionDate`.
  - No anchor, or a panel with no row, gives `no_slot`.
  - `fetchAvailableMinutes(sessionDate)` and `fetchSpxSpot(sessionDate, latest)`.
  - The cache call is `setClosedReadCache(res)`.
- **`?at=` scrub, live or closed:**
  - The session date is `getETDateStr(new Date(at))`.
  - Each panel's row is the newest with `captured_at <= at` and `>= ET midnight of that date`.
  - Minutes and spot use that date.
  - The cache call is `setLiveReadCache` (unchanged).
- **`asOf`:** the normal and `no_spot` paths give `latestCapturedAt.toISOString()`; `no_slot` gives `null`.
- **`no_slot` gains `lastMinuteAgeSec`:** server now minus the last `availableMinutes` entry, in whole seconds, or absent when the list is empty. It keeps the stall age on the server's clock now that `asOf` is null (Task 11).
- Live in-session reads keep the staleness floor, today's date and `setLiveReadCache`.
- `vi.resetAllMocks()` wipes the `isMarketOpen: vi.fn(() => true)` factory value, so add `isMarketOpen.mockReturnValue(true)` to `beforeEach`. Otherwise every existing case (lines 128-431) takes the closed path.

- [ ] **Step 1: Write the failing tests:**

```ts
it('closed: reads panels at or before the SPX anchor on the session date', async () => {
  isMarketOpen.mockReturnValue(false);
  getClosedAnchors.mockResolvedValue({ sessionDate: '2026-11-20', byTicker: new Map([['SPX', '2026-11-20T21:00:49.000Z']]) });
  // queue: availableMinutes, gamma, charm, vanna rows at 21:00:49Z, spot
  const body = await call();
  expect(body.asOf).toBe('2026-11-20T21:00:49.000Z');
  expect(sqlValues()).toContain('2026-11-20T21:00:49.000Z'); // the anchor bound
  expect(sqlValues()).toContain('2026-11-20T05:00:00.000Z'); // ET midnight bound
  expect(setClosedReadCache).toHaveBeenCalledWith(res);
});
it('closed with no SPX anchor returns no_slot with asOf null', async () => { /* ... */ });
it('a scrub to a session first minute reads no_slot, not the prior session', async () => {
  // at=2026-11-23T14:30:00Z with the real getETDateStr (the stub returns one fixed date); bounded panel queries return []
  expect(body).toMatchObject({ reason: 'no_slot', asOf: null });
  expect(sqlValues()).toContain('2026-11-23T05:00:00.000Z'); // the session lower bound
});
it('no_spot carries the capture time', async () => { /* asOf === latest capture ISO */ });
it('an in-session no_slot lists the day\'s minutes and their server-measured age', async () => {
  // now 2026-11-23T16:06:00Z, last minute 16:00:00Z → availableMinutes non-empty, asOf null, lastMinuteAgeSec 360
});
it('getClosedAnchors rejecting → 500 with the Sentry capture (R4)', async () => { /* ... */ });
```

- [ ] **Step 2:** Run `npx vitest run api/__tests__/gex-landscape.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Thread a `{ upper, lower }` bound into `fetchPanelSlot`, and pick the date per mode as above. Update the file's closed-market cache-header cases to `setClosedReadCache`.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gex-landscape): Serve the last session after the close, bound every read to one session`.

---

### Task 6: `/api/periscope-map`

**Files:**
- Modify: `api/periscope-map.ts`
- Test: `api/__tests__/periscope-map.test.ts`

**Interfaces:**
- **Closed:** the same SPX anchor and per-panel bound as Task 5, inside `fetchLatestGexbotSlot`.
- **Every date use moves to `sessionDate`:**
  - `fetchAvailableSlots`;
  - the `expiry` stamp in `fetchLatestGexbotSlot` and `fetchPriorGexbotSlot`;
  - `fetchSpxSpot`;
  - `fetchConeLevels`;
  - `fetchConeBreaches`.
- **Cache:** the closed cache call is `setClosedReadCache(res)`. The test's `timezone.js` mock spreads `importOriginal()`, as in Task 5.
- **`asOf`, both modes:** normal and `no_spot` give `latest.capturedAt`; `no_slot` gives `null`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('closed on Saturday uses the session date everywhere', async () => {
  isMarketOpen.mockReturnValue(false);
  getClosedAnchors.mockResolvedValue({ sessionDate: '2026-11-20', byTicker: new Map([['SPX', '2026-11-20T21:00:49.000Z']]) });
  const body = await call();
  expect(body.data.expiry).toBe('2026-11-20');
  expect(dateArgsOfEveryDateQuery()).toEqual(['2026-11-20', '2026-11-20', '2026-11-20', '2026-11-20']); // slots, spot, cone, breaches
  expect(setClosedReadCache).toHaveBeenCalledWith(res);
});
it('closed: each panel read is bounded by the anchor and the session\'s ET midnight', async () => {
  expect(sqlValues()).toContain('2026-11-20T21:00:49.000Z'); // upper bound in fetchLatestGexbotSlot
  expect(sqlValues()).toContain('2026-11-20T05:00:00.000Z'); // lower bound: no Thursday panel under Friday's label
});
it('normal-path asOf is the capture time in the session too', async () => { /* asOf === latest.capturedAt */ });
it('no_slot asOf is null', async () => { /* ... */ });
it('getClosedAnchors rejecting → 500 with the Sentry capture (R4)', async () => { /* ... */ });
// beforeEach: isMarketOpen.mockReturnValue(true), as in Task 5.
```

- [ ] **Step 2:** Run `npx vitest run api/__tests__/periscope-map.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and update the file's closed-market cache-header cases.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(periscope): Serve the last session's map after the close with its own date and capture time`.

---

### Task 7: Cleanup keeps the newest session

**Files:**
- Modify: `api/cron/cleanup-gexbot.ts`
- Test: `api/__tests__/cleanup-gexbot.test.ts`

**Interfaces:**
- The per-table query in `runCleanup` (lines 105-112) also returns `newest_cutoff`: the ET date of `max(captured_at)` minus one day, or NULL on an empty table.
- `cutoff = min(yesterday, gate_cutoff, newest_cutoff)`, ignoring NULLs.
- `scriptDates(yesterday, gate)` gains a `newest` argument.

- [ ] **Step 1: Write the failing tests:**

```ts
it('Monday keeps Friday', async () => {
  // 2026-11-23T12:15Z; yesterday 2026-11-22, gate null, newest_cutoff 2026-11-19
  expect(deleteCutoffs()).toEqual(['2026-11-19', '2026-11-19']);
});
it('Tuesday removes Friday', async () => { /* yesterday 11-23, gate 11-22, newest 11-22 → 11-22 */ });
it('a weekday with the previous session archived still keeps it', async () => { /* gate null, newest 11-19 < yesterday 11-20 → 11-19 */ });
it('the archive gate wins when lower', async () => { /* gate 11-17 → 11-17 */ });
it('the Friday after Thanksgiving keeps Wednesday', async () => { /* 2026-11-27: yesterday 11-26, gate null, newest 11-24 → 11-24 */ });
```

- [ ] **Step 2:** Run `npx vitest run api/__tests__/cleanup-gexbot.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `fix(cleanup-gexbot): Never delete a table's newest session`.

---

### Task 8: Client clock helpers and the final fetch

**Files:**
- Create: `src/utils/closed-session.ts`, `src/__tests__/utils/closed-session.test.ts`
- Create: `src/hooks/useFinalFetch.ts`, `src/__tests__/hooks/useFinalFetch.test.ts`

**Interfaces:**

```ts
// src/utils/closed-session.ts
/** Epoch ms of 09:30 ET on etDate; null on a non-trading day. */
export function sessionOpenMs(etDate: string): number | null;
/**
 * True when the market is open and `newestCapture` (the newest capture a
 * live-route response carries: its asOf, else its last listed minute or slot)
 * is before today's (ET) session open. null → false.
 */
export function isCarriedOver(newestCapture: string | null, marketOpen: boolean, now: Date): boolean;
/** Epoch ms of the first close + CLOSED_FINAL_FETCH_OFFSET_MIN strictly after `after`, searching up to 14 days; null if none. */
export function nextFinalFetchMs(after: Date): number | null;
/** "Fri 3:00 PM CT", or "Fri Nov 20 3:00 PM CT" when now − asOf > 6 days. America/Chicago always. */
export function formatClosedLabel(asOf: string, now: Date): string;
/** 0, 408, 429 or >= 500. Moved from useGexbotData. */
export function isTransientStatus(status: number): boolean;

// src/hooks/useFinalFetch.ts
export type FinalFetchOutcome = 'ok' | 'transient' | 'failed';
export const CLOSED_RETRY_MS = 30_000;
export const CLOSED_MAX_RETRIES = 5;
/**
 * While enabled: arms one timeout for nextFinalFetchMs(now) and runs `run`
 * when it fires, or on visibilitychange (visible) / pageshow / focus once the
 * armed instant has passed. After a run it re-arms from max(now, armed).
 * Returns retryAfterFailure: the caller passes a failed live-route fetch's
 * outcome while closed, and a 'transient' one is retried every
 * CLOSED_RETRY_MS, at most CLOSED_MAX_RETRIES times (the final fetch's own
 * transient outcome goes through the same path).
 */
export function useFinalFetch(
  run: () => Promise<FinalFetchOutcome>,
  enabled: boolean,
): (outcome: FinalFetchOutcome) => void;
```

- **Close instant:** `etWallClockToUtcIso(date, getMarketCloseHourET(date) * 60)`, on days where `isTradingDay(date)` holds. Don't use `getETCloseUtcIso`: it is fixed at 16:00 and ignores half days.
- **`formatClosedLabel`:** build it on `formatSchwabExpiryCt(ms)` (`src/utils/schwab-expiry.ts`). That already gives `Fri 3:00 PM CT` with Node 24's U+202F before AM/PM normalized to a space. Insert `Nov 20 ` after the weekday for the dated form.
- **Imports:** `src/utils/**` is in `API_COMPILED_SRC` (`eslint.config.ts:14-20`), so `closed-session.ts` uses `.js` extensions on its relative imports.
- **One retry series at a time:**
  - The final fetch and its retries report through their own outcome. A consumer passes `retryAfterFailure` only failures of its own fetches: mount, open edge, date roll.
  - A report that arrives while a series is running is ignored. It doesn't reset the count.
  - A series ends on `'ok'`, on `'failed'`, or after `CLOSED_MAX_RETRIES` retries.

- [ ] **Step 1: Write the failing tests:**

```ts
expect(nextFinalFetchMs(new Date('2026-11-20T20:00:00Z'))).toBe(Date.parse('2026-11-20T21:03:00Z')); // Fri
expect(nextFinalFetchMs(new Date('2026-11-26T15:00:00Z'))).toBe(Date.parse('2026-11-27T18:03:00Z')); // Thanksgiving → half day
expect(nextFinalFetchMs(new Date('2026-11-28T15:00:00Z'))).toBe(Date.parse('2026-11-30T21:03:00Z')); // Sat → Mon
expect(nextFinalFetchMs(new Date('2026-11-20T21:03:00Z'))).toBe(Date.parse('2026-11-23T21:03:00Z')); // strictly after
const now = new Date('2026-11-23T14:30:05Z');
expect(isCarriedOver('2026-11-20T21:00:49Z', true, now)).toBe(true);
expect(isCarriedOver('2026-11-23T14:29:59Z', true, now)).toBe(true);
expect(isCarriedOver('2026-11-23T14:30:00Z', true, now)).toBe(false);
expect(isCarriedOver(null, true, now)).toBe(false);
expect(isCarriedOver('2026-11-20T21:00:49Z', false, now)).toBe(false);
expect(formatClosedLabel('2026-11-20T21:00:49Z', new Date('2026-11-21T15:00:00Z'))).toBe('Fri 3:00 PM CT');
expect(formatClosedLabel('2026-10-30T20:00:49Z', new Date('2026-11-02T13:00:00Z'))).toBe('Fri 3:00 PM CT'); // CDT capture, CST now
expect(formatClosedLabel('2026-11-20T21:00:49Z', new Date('2026-11-26T21:00:49Z'))).toBe('Fri 3:00 PM CT');        // exactly 6 days
expect(formatClosedLabel('2026-11-20T21:00:49Z', new Date('2026-11-26T21:00:50Z'))).toBe('Fri Nov 20 3:00 PM CT'); // 6 days + 1 s
```

  `useFinalFetch` tests use fake timers and `vi.setSystemTime`:
  - it fires once at 21:03:00Z;
  - a `'transient'` outcome retries at +30 s up to 5 times, then stops;
  - `'failed'` doesn't retry;
  - `retryAfterFailure('transient')` called by the consumer starts the same retry;
  - it re-arms for the next trading day after firing;
  - with the system time moved 3 days past the armed instant and timers not advanced (a sleeping or frozen tab), a `visibilitychange` to visible fires it exactly once, and the stale timer doesn't fire it again;
  - a timer that fires 1 ms early by `Date.now()` re-arms for the next day, not the same instant;
  - `enabled: false` arms nothing and ignores visibility events.
- [ ] **Step 2:** Run both new test files. Expected: FAIL.
- [ ] **Step 3:** Implement. Don't keep a second `isTransientStatus` in `useGexbotData.ts`: Task 9 deletes the local copy.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Add the client session clock helpers and the re-armed final fetch`.

---

### Task 9: `useGexbotData`

**Files:**
- Modify: `src/hooks/useGexbotData.ts`
- Test: `src/__tests__/useGexbotData.test.tsx`

**Interfaces:**
- `UseGexbotDataResult<V>` gains `asOf: string | null`, read from the body's `asOf`. It is null for views whose body has none.
- In-scope views: `snapshots-latest`, `velocity`, `convexity-trend`, `maxchange-winners`. For them:
  - `isCarriedOver(asOf, marketOpen, now)` → `rows` is empty and `asOf` null. The children then show "awaiting first GEXBot tick".
  - The existing open-edge effect (lines 360-366) stays.
  - `const retryAfterFailure = useFinalFetch(run, inScope)`, where `inScope` is true only for the four views above. Hooks can't be called conditionally, and a literal `true` would arm one final fetch per mounted `sibling-confirm` row. `run` maps the fetch result to an outcome with `isTransientStatus` (now imported from `closed-session.ts`; delete the local copy).
  - Any failed fetch while `!marketOpen` is passed to `retryAfterFailure`.
  - With rows held, a failed fetch while `!marketOpen` keeps them with `error: null`. With none held, the error shows while the retries run.
- Out-of-scope views (`expected-move`, `sibling-confirm`) are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `asOf` passes through;
  - a closed-session body arriving with `marketOpen` true at 09:30:05 ET → `rows: []`;
  - at 16:03:00 ET one more fetch fires;
  - a 503 on that fetch keeps the held rows, sets `error` null, and retries at +30 s;
  - a closed mount fetch that fails with 503 retries at +30 s and shows the rows once one succeeds;
  - a closed fetch that keeps returning 503 makes exactly 1 + 5 requests, then stops;
  - a mounted `sibling-confirm` hook makes no request at 16:03 ET;
  - `sibling-confirm` behavior is unchanged (existing tests).
- [ ] **Step 2:** Run `npx vitest run src/__tests__/useGexbotData.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Keep the last session in the GEXBot hook after the close and drop it at the open`.

---

### Task 10: Taker Flow labels

**Files:**
- Modify: `src/components/Gexbot/index.tsx`, `src/components/Gexbot/StrikeMoverLadder.tsx`
- Test: `src/__tests__/GexbotSection.test.tsx`, `src/__tests__/StrikeMoverLadder.test.tsx`

**Interfaces:**
- **`GexbotSection`:**
  - It reads `useGexbotData({ view: 'snapshots-latest' }, marketOpen)`, deduped with its children.
  - It passes `headerRight={<span data-testid="gexbot-closed-label">CLOSED · as of {formatClosedLabel(asOf, new Date())}</span>}` to `SectionBox` when `!marketOpen && asOf != null`.
  - It passes the ladder `sessionAsOf={asOf}` and `fallbackSpot={rows.find((r) => r.ticker === 'SPX')?.spot ?? null}`. Check the ticker name against `GEXBOT_TICKERS`.
- **`StrikeMoverLadder`:** new props `sessionAsOf: string | null` and `fallbackSpot: number | null`. When closed:
  - The empty text is `No {MODEL_LABEL[tab]} winners in the session's last 5 min (0DTE)`.
  - Spot is `spxSpot ?? fallbackSpot`.
  - Its rows render only when the ladder's own `asOf` falls on the same ET date as `sessionAsOf` (Review Focus 5). A null `sessionAsOf` (the section's read still loading, failed, or an empty table) shows the closed empty text too.
  - In the session, nothing changes and `fallbackSpot` is unused.

- [ ] **Step 1: Write the failing tests:**

```tsx
it('labels the section CLOSED with the capture time', () => {
  // snapshots-latest body { rows:[...], asOf:'2026-11-20T21:00:49.000Z' }, marketOpen false, now Sat
  expect(screen.getByTestId('gexbot-closed-label')).toHaveTextContent('CLOSED · as of Fri 3:00 PM CT');
});
it('no label while open', () => { expect(screen.queryByTestId('gexbot-closed-label')).toBeNull(); });
it('ladder: closed empty text', () => {
  expect(screen.getByTestId('strike-mover-ladder-empty')).toHaveTextContent("No Classic GEX winners in the session's last 5 min (0DTE)");
});
it('ladder: uses fallbackSpot when the quote is missing after hours', () => { /* spxSpot null, fallbackSpot 6600 → rows render */ });
it('ladder: ignores fallbackSpot in the session', () => { /* marketOpen, spxSpot null → empty, as today */ });
it('ladder: hides rows from another session than the header', () => { /* ladder asOf 2026-11-19, sessionAsOf 2026-11-20 → empty text */ });
```

- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gexbot): Label the Taker Flow section CLOSED after the close`.

---

### Task 11: `useGexLandscapeData`

**Files:**
- Modify: `src/hooks/useGexLandscapeData.ts`
- Test: `src/__tests__/hooks/useGexLandscapeData.test.ts`, and `src/__tests__/components/GexLandscape.freshness.integration.test.tsx` if it pins the `no_slot` age math

**Interfaces:**
- `GexLandscapeResponse.asOf` becomes `string | null`.
- `UseGexLandscapeDataReturn` gains `asOf: string | null`: the live-route response's `asOf`, null when `at != null`.
- **Live route only (`at == null`):**
  - `isCarriedOver(asOf ?? availableMinutes.at(-1) ?? null, marketOpen, now)` → empty derived data (strikes `[]`, timestamps `[]`).
    - This is checked at render, inside the derive memo with `marketOpen` in its deps, not when a response arrives. A response held across the 09:30 ET flip is dropped on the flip's own render, before the refetch lands, so the pill never reads LIVE over Friday's strikes.
  - An in-session `no_slot` (`asOf` null, today's minutes) keeps its timestamps, so the "Feed stalled" text and the scrub stepper still work.
  - Keep today's refetch on a `marketOpen` flip.
  - `const retryAfterFailure = useFinalFetch(run, at == null)`, and pass a failed fetch while `!marketOpen` to it.
  - When `!marketOpen`, a failed fetch with a response held keeps it and returns `error: null`. The panel renders `if (error)` before the rows (`GexLandscape/index.tsx:521-529`), so an error would hide the held strikes.
  - One refetch when the ET date rolls (the hook's second argument changes), so the scrub list refills.
- **`lastCaptureAgeMs`:** for `no_slot`, read the body's `lastMinuteAgeSec` (Task 5) plus the edge age, as today's formula does with `asOf`. The client clock stays out, and the test "does not depend on the client clock" (`useGexLandscapeData.test.ts:879-926`) keeps passing.

- [ ] **Step 1: Write the failing tests:**
  - closed body: `asOf` is exposed and the strikes render;
  - a closed body with `marketOpen` true at 09:30:05 ET → strikes and timestamps `[]`;
  - a closed response held across the flip: rerender with `marketOpen` true at 09:30:00 ET, refetch still pending → strikes `[]` on that same render;
  - an in-session `no_slot` at 10:00 CT with `asOf: null` and today's minutes keeps the timestamps;
  - a scrub (`at` set) ignores all of these;
  - the final fetch fires at 16:03 ET;
  - a closed fetch failing with 503 keeps the held strikes with `error: null`, retries at +30 s, and makes exactly 1 + 5 requests if it keeps failing;
  - an ET-midnight roll of the date argument triggers one fetch;
  - a `no_slot` body with `asOf: null` and `lastMinuteAgeSec: 360` yields `lastCaptureAgeMsAtReceipt` = 360 000 ms plus the edge age, whatever the client clock says.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/hooks/useGexLandscapeData.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the hook test and the freshness integration test. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gex-landscape): Keep the last session in the landscape hook after the close`.

---

### Task 12: Analyze context marker (server)

**Files:**
- Modify: `api/_lib/analyze-context.ts` (line 458 block), `api/_lib/validation/snapshot.ts`
- Test: `api/__tests__/analyze-context.test.ts`, `api/__tests__/validation/snapshot.test.ts`

**Interfaces:**
- **Context key `gexLandscapeBiasClosedAsOf`:** an ISO datetime string, optional. In `analyzeBodySchema`'s `superRefine`, a present value that isn't a string or doesn't parse as an ISO datetime is an issue at that path.
- **With the marker**, the heading is `## GEX Landscape Structural Bias (last session's close, as of <label>)`. `<label>` is `formatSchwabExpiryCt(Date.parse(asOf))` from `src/utils/schwab-expiry.ts`, followed by `, <CT date YYYY-MM-DD>`. The first sentence reads `This is the structural bias verdict from the last session's close as of <label>, not live. It was computed from the per-strike GEX panel, …` followed by today's text from "using GEXBot's 1-minute capture" on.
- Without the marker, the block is byte-for-byte today's.
- This task gets the `analyze-prompt-reviewer` agent (spec). The block is outside the cached system prompt.

- [ ] **Step 1: Write the failing tests:**

```ts
it('labels a closed bias with its capture time', async () => {
  const out = await buildAnalysisContext([], { mode: 'entry', selectedDate: '2026-11-21', gexLandscapeBias: 'BIAS-BODY', gexLandscapeBiasClosedAsOf: '2026-11-20T21:00:49.000Z' });
  expect(textOf(out)).toContain("## GEX Landscape Structural Bias (last session's close, as of Fri 3:00 PM CT, 2026-11-20)");
  expect(textOf(out)).toContain('not live');
  expect(textOf(out)).toContain("GEXBot's 1-minute capture");
  expect(textOf(out)).toContain('taker-side sign');
});
it('without the marker the block is unchanged', async () => { /* toContain the exact current heading and first sentence */ });
it('schema rejects a malformed marker', () => {
  expect(analyzeBodySchema.safeParse(body({ gexLandscapeBiasClosedAsOf: 'yesterday' })).success).toBe(false);
});
it('schema accepts an ISO marker or none', () => { /* ... */ });
```

- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Run the gate and the `analyze-prompt-reviewer`, then commit: `feat(analyze): Label a closed GEX Landscape bias as the last session's close`.

---

### Task 13: GEX Landscape CLOSED pill

**Files:**
- Modify: `src/components/GexLandscape/index.tsx`, `src/components/ScrubControls.tsx`
- Test: `src/__tests__/components/GexLandscape.test.tsx`, `src/__tests__/components/GexLandscape-HeaderControls.test.tsx`

**Interfaces:**
- `ScrubControlsProps` gains `closedAsOf?: string | null`, default `undefined`. When it's non-null and `!isScrubbed`, the badge slot renders `<span data-testid="scrub-closed-badge">CLOSED · as of {formatClosedLabel(closedAsOf, new Date())}</span>` in place of LIVE or DELAYED.
- `GexLandscape` passes `closedAsOf={!marketOpen && at == null ? asOf : null}`.
- The `<select>` value is unchanged (`liveTimestamps.at(-1)`, a minute option). `asOf` is used for the label only.

- [ ] **Step 1: Write the failing tests:**
  - a closed landscape renders `scrub-closed-badge` with `CLOSED · as of Fri 3:00 PM CT` and its strikes;
  - no LIVE badge;
  - a scrubbed view shows SCRUBBED, not CLOSED;
  - `ScrubControls` without `closedAsOf` renders exactly as today.
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(gex-landscape): Show a CLOSED pill with the capture time after the close`.

---

### Task 14: Analysis context type and hook

**Files:**
- Modify: `src/components/ChartAnalysis/types.ts` (`AnalysisContext`, line 77), `src/hooks/useAnalysisContext.ts`
- Test: `src/__tests__/hooks/useAnalysisContext.test.ts`

**Interfaces:**
- `AnalysisContext` gains `gexLandscapeBiasClosedAsOf?: string | null` next to `gexLandscapeBias`.
- `UseAnalysisContextParams.gexLandscapeBiasClosedAsOf?: string | null` → context `gexLandscapeBiasClosedAsOf: value ?? undefined`, added to the memo deps. The object keeps its `satisfies AnalysisContext`.

- [ ] **Step 1: Write the failing tests:**
  - with the param set, the context carries `gexLandscapeBiasClosedAsOf: '2026-11-20T21:00:49.000Z'`;
  - with it null or absent, the key is undefined.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/hooks/useAnalysisContext.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(analyze): Carry the landscape's closed capture time in the analysis context`.

---

### Task 15: GEX Landscape bias marker and `App.tsx`

**Files:**
- Modify: `src/components/GexLandscape/index.tsx`, `src/App.tsx`
- Test: `src/__tests__/components/GexLandscape.test.tsx`

**Interfaces:**
- `GexLandscapeProps.onBiasChange?: (summary: string | null, closedAsOf: string | null) => void`. `closedAsOf` is the Task 13 value, null when live or scrubbed.
- `App.tsx` holds `gexBiasClosedAsOf` next to `gexBiasContext`, set by one stable `useCallback` handler. That handler takes `setGexBiasContext`'s place in the `panelMap` deps.
- `App.tsx` passes `gexLandscapeBiasClosedAsOf: gexBiasClosedAsOf` to `useAnalysisContext` (Task 14).

- [ ] **Step 1: Write the failing tests:**
  - closed: `onBiasChange` is called with `(summary, '2026-11-20T21:00:49.000Z')`;
  - live and scrubbed: `(summary, null)`.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/components/GexLandscape.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same file and `src/__tests__/App.market-open-gate.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(analyze): Send the landscape's closed capture time with its bias`.

---

### Task 16: `usePeriscopeExposure`

**Files:**
- Modify: `src/hooks/usePeriscopeExposure.ts`
- Test: `src/__tests__/usePeriscopeExposure.test.ts`

**Interfaces:**
- `PeriscopeExposureResponse.asOf` becomes `string | null`.
- **Live route only** (`selectedSlot == null`):
  - `isCarriedOver(asOf ?? availableSlots.at(-1) ?? null, marketOpen, now)` → `view: null`, `emptyReason: 'no_slot'`, `availableSlots: []`.
  - An in-session `no_slot` keeps its slots.
  - On a `marketOpen` false → true flip, drop the held view and fetch at once (there is no edge fetch today).
  - `const retryAfterFailure = useFinalFetch(run, selectedSlot == null && canFetch)`, and pass a failed fetch while `!marketOpen` to it.
  - When `!marketOpen`, a failed fetch with a view held keeps it, with `error: null`.
- A picked slot is untouched.

- [ ] **Step 1: Write the failing tests:**
  - a closed view is held and exposed;
  - a closed body at 09:30:05 ET with `marketOpen` true → `view: null` and no slots;
  - an in-session `no_slot` keeps today's slots;
  - an open flip fetches once immediately;
  - the final fetch fires at 16:03 ET;
  - a 503 on it keeps the view;
  - a closed mount fetch failing with 503 retries at +30 s, and makes exactly 1 + 5 requests if it keeps failing;
  - a selected slot ignores all of these.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/usePeriscopeExposure.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(periscope): Keep the last session's map in the hook after the close`.

---

### Task 17: Periscope panel and `marketOpen` threading

**Files:**
- Modify: `src/components/Periscope/PeriscopePanel.tsx`, `src/components/Periscope/SlotPicker.tsx`, `src/App.tsx`
- Test: `src/__tests__/PeriscopePanel.test.tsx`
- Create: `src/__tests__/SlotPicker.test.tsx`

**Interfaces:**
- `PeriscopePanelProps` gains `marketOpen: boolean`. `App.tsx` passes `marketOpen={liveMarketOpen}`.
- On the live route with `!marketOpen` and a view, the body header reads `Slot {formatClosedLabel(view.capturedAt, new Date())} · CLOSED` (my call: the weekday is kept, so a Saturday view says "Fri").
- The slot list is the response's `availableSlots`, which is the session's after Task 6. The date shown and the date sent on a pick are the CT date of `view.capturedAt`.
- **`SlotPickerProps` gains `marketOpen: boolean`.** That is the whole `SlotPicker` change: on the live route when closed, the live toggle reads `live` without the `●` (the dot means streaming), and the `asOf` time beside it is hidden, since the header carries the capture time.

- [ ] **Step 1: Write the failing tests:**
  - closed Saturday with Friday's view: the header contains `Slot Fri 3:00 PM CT · CLOSED`;
  - the slot `<select aria-label="Periscope slot time">` lists Friday's slots;
  - picking `14:50` calls `onSelectSlot({ date: '2026-11-20', time: '14:50' })`. This pins today's behavior: `PeriscopePanel.tsx:114-116` already sends `isoToCtDate(iso)`;
  - closed live route: the toggle reads `live` with no `●`, and no `asOf` time shows;
  - open: the header and the `● live` toggle are unchanged;
  - a picked slot never says CLOSED.
- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both files. Expected: PASS.
- [ ] **Step 5:** Run the gate, then commit: `feat(periscope): Label the live Periscope view CLOSED after the close`.

---

## Landing (controller, after Task 17)

- [ ] Run the final whole-branch review (SDD final review).
- [ ] Rebase onto `origin/main` (the level-ladder work will have moved `gexbot-queries.ts`), re-run the gate, and push to main once. No Railway or nightly watch paths are touched, so any hour is fine. Vercel deploys the app.
- [ ] **Live check, read-only:** run `getClosedAnchors`' snapshot SQL through the read-only Neon MCP for the last session. Expected: one anchor per ticker at about `21:00:50Z` (EST), none on a 16:01 replay row. Also check the first half day's (2026-11-27) freeze time.
- [ ] Add an "As built" note to the spec with Edit.

## Review rounds (CLAUDE.md, Plan First)

- **Round 1** settled:
  - an in-session `no_slot` blanked by a null-`asOf` rule, replaced by `isCarriedOver`;
  - the shared `setLiveReadCache` left alone;
  - the `AnalysisContext` type split;
  - in-session epoch stamps in the seeds;
  - the waking-tab check;
  - retries for any failed fetch while closed;
  - the ladder's spot prop;
  - the re-arm from `max(now, armed)`;
  - the DST-Monday cache case;
  - one shared close + 3 constant.
- **Round 2** settled:
  - the landscape error view over held strikes (`error: null` while closed);
  - one retry series at a time (1 + 5 requests);
  - the stall age kept on the server's clock (`lastMinuteAgeSec`);
  - the final fetch armed only for in-scope views;
  - pglite tests for the convexity and mover bounds, plus bound assertions in Tasks 5 and 6 and R4 reject cases;
  - the drop checked at render on the open flip;
  - the `resetAllMocks`/`isMarketOpen` and CharmClock test traps;
  - `formatSchwabExpiryCt` for the label, `.js` imports, and `isTradingDay` for the close window;
  - the `SlotPicker` change;
  - a null `sessionAsOf`.
- **Still open (not checkable before the build):**
  - whether GEXBot freezes at 13:00 ET on a half day (first one: 2026-11-27; check it read-only after that close);
  - whether Vercel's edge treats `s-maxage=0, stale-while-revalidate=0` as uncacheable;
  - the size of the rebase against the level-ladder work.
