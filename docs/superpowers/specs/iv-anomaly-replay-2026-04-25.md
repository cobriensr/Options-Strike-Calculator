# IV-Anomaly Replay (Date + Time Scrubber)

## Goal

Add a date picker + time scrubber to the Strike IV Anomalies section
so the user can review what alerts were active at any past timestamp.
Mirrors the existing `useDarkPoolLevels` UX and URL-param pattern
exactly so a trader can flip between sections without learning two
mental models.

## Replay semantics (confirmed: snapshot mode)

At time T, the panel shows the active set as the live UI would have
shown it at T:

- Alert is "active at T" if `firstSeenTs <= T` AND
  `lastFiredTs + ANOMALY_SILENCE_MS >= T`.
- Compound-key aggregation runs identically to live (same
  `useIVAnomalies` reconcile path) — only `Date.now()` eviction is
  swapped for the scrub time.
- `phase` (active/cooling/distributing) and `exitReason` are
  recomputed exactly as they would have been live.

This is what matches the trader's real-time experience and supports
fine-tuning gates by reviewing what was on screen at known good /
bad moments.

## Architecture

```
                     ┌─────────────────────────────────────────────┐
                     │ GET /api/iv-anomalies?at=2026-04-21T14:30Z  │
                     │   filter: ts <= at AND ts >= at - 24h       │
                     │   returns same { latest, history } shape    │
                     └─────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────┐
│ useIVAnomalies(isOwner, marketOpen,                        │
│                selectedDate?, scrubTime?)                  │
│                                                            │
│  isLive = (selectedDate is today AND scrubTime null)       │
│  past   = !isLive                                          │
│                                                            │
│  - Past: one-shot fetch w/ ?at=. No polling.               │
│  - nowMs replaced with scrub time → silence eviction       │
│    correct as of T.                                        │
│  - Aggregation reconcile reuses existing logic verbatim.   │
└────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────┐
│ IVAnomaliesSection                                         │
│                                                            │
│  [date input] [< prev] [HH:MM] [next >] [Live]            │
│                                                            │
│  Date input — ET calendar date (defaults to today)         │
│  Scrubber — 5-min slots 08:30–15:00 CT                     │
│  "Live" button — clears scrubTime + sets date=today        │
└────────────────────────────────────────────────────────────┘
```

## Sub-phases

### Phase 1 — Backend (~2h)

**Files:**

- `api/iv-anomalies.ts` — accept `?at=ISO` parameter, filter rows
  in list mode
- `api/_lib/validation.ts` — extend `ivAnomaliesQuerySchema` with
  optional `at: z.string().datetime({ offset: true })`
- `api/__tests__/iv-anomalies.test.ts` (or similar) — test the new
  filter semantics

Endpoint behavior:

- `?at=` absent → existing behavior (live, no filter)
- `?at=ISO` present → list-mode filter:
  ```sql
  SELECT ... FROM iv_anomalies
  WHERE ticker = $t
    AND ts <= $at
    AND ts >= $at - INTERVAL '24 hours'
  ORDER BY ts DESC
  LIMIT $limit
  ```
  The 24h window is wide enough to capture all rows that could still
  be "active at T" given `ANOMALY_SILENCE_MS` and the typical alert
  lifecycle, while still hitting the `(ticker, ts)` index.
- Cache: when `at=` is present and is in the past, server can cache
  longer (5 min like darkpool past-mode). When live, 30s.
- History mode (`strike` + `side` + `expiry`) is unaffected — the
  per-strike chart already filters by compound key.

### Phase 2 — Hook (~2h)

**Files:**

- `src/hooks/useIVAnomalies.ts` — add scrub state
- `src/__tests__/hooks/useIVAnomalies.test.ts` — tests (mirror
  `useDarkPoolLevels` test patterns)

API change to the hook:

```ts
// Before:
useIVAnomalies(isOwner, marketOpen): { anomalies, loading, error }

// After:
useIVAnomalies(isOwner, marketOpen): {
  anomalies, loading, error,
  selectedDate: string,
  setSelectedDate: (d: string) => void,
  scrubTime: string | null,
  isLive: boolean,
  isScrubbed: boolean,
  canScrubPrev: boolean,
  canScrubNext: boolean,
  scrubPrev: () => void,
  scrubNext: () => void,
  scrubTo: (time: string) => void,
  scrubLive: () => void,
  timeGrid: readonly string[],
}
```

Internal changes:

- `scrubTime: HH:MM | null` (null = live)
- `selectedDate: ET YYYY-MM-DD`
- `nowMs` for eviction:
  - Live: `Date.now()` (existing)
  - Scrubbed: `Date.parse(${selectedDate}T${scrubTime}:00-05:00)` (CT)
  - Past date, no scrub: `Date.parse(${selectedDate}T15:00:00-05:00)` (3pm CT close)
- `useEffect` dispatch (mirror useDarkPoolLevels):
  1. Not owner → no fetch
  2. Past date → one-shot fetch w/ `?at=`
  3. Today, market open, live → existing polling
  4. Today, market closed → one-shot fetch (no polling)
  5. Today, scrubbed → one-shot fetch w/ `?at=`
- All existing tests stay green; new tests cover scrub-mode `at`
  param and silence-eviction-at-T semantics.

### Phase 3 — UI (~1h)

**Files:**

- `src/components/IVAnomalies/IVAnomaliesSection.tsx` — add
  scrubber bar above the ticker tabs

Use existing button/input styles from `useDarkPoolLevels`-paired UI.
Rough layout:

```
┌──────────────────────────────────────────────────────────────────┐
│ STRIKE IV ANOMALIES                                              │
├──────────────────────────────────────────────────────────────────┤
│ [date: 2026-04-23 ▾] [◀ 11:35] [11:40] [11:45 ▶] [Live] [scrub] │
├──────────────────────────────────────────────────────────────────┤
│ [SPXW] [NDXP] [SPY] [QQQ] [IWM] ...                              │
│                                                                  │
│ rows...                                                          │
└──────────────────────────────────────────────────────────────────┘
```

When `isScrubbed`:

- Header text: "Showing alerts active at 11:40 CT on 2026-04-23"
- Scrubber buttons enabled per `canScrubPrev` / `canScrubNext`
- "Live" button visible to jump back

When `isLive`:

- Header text: existing
- Scrubber present; clicking `prev` enters scrub mode at last grid
  slot before now

## Constraints

- **Read-only.** Replay never writes to `iv_anomalies`. Scrubbing
  doesn't trigger Anthropic calls or any other side effects.
- **No regression of live behavior.** The hook's existing reconcile
  / eviction logic is preserved verbatim; we only swap the time
  source for eviction.
- **Owner-only.** Public visitors can't replay (same auth gate as
  live).
- **Shape stability.** The `/api/iv-anomalies` response shape is
  unchanged when `?at=` is omitted; existing consumers (none yet
  besides the hook) keep working.

## Out of scope

- **Cross-asset pills in replay mode.** Phase F's
  `useAnomalyCrossAsset` polls live too; replay context would need
  the cross-asset endpoint to also accept `?at=`. Defer — not
  needed for the date/time picker feature alone.
- **Calendar of "alert-rich days".** Highlighting which calendar
  dates have lots of alerts vs none. Could be a Phase 2 polish.
- **Scrub through firing-by-firing events.** This spec uses 5-min
  grid slots (matching darkpool). Per-firing event navigation is
  a different feature.

## Time estimate

**~5h total** — backend (~2h) + hook (~2h) + UI (~1h). Each phase
ends in a code-reviewer subagent pass before commit.

## Open questions (defaults if no override)

- **Default scrub time when entering scrub from live:** last grid
  slot at or before `now` — matches darkpool.
- **Default time when picking a past date:** `15:00` (close) — most
  natural anchor for "what was the day's final state."
- **Persisted across ticker tabs:** yes (date+time stay when switching
  ticker tab).
- **Scrubbing across midnight:** disallowed; `selectedDate` is the
  authoritative day, scrubTime is HH:MM within that day.

## Deliverables

| Phase | Files                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 1     | `api/iv-anomalies.ts` (modified), `api/_lib/validation.ts` (extended), `api/__tests__/iv-anomalies-replay.test.ts` (new) |
| 2     | `src/hooks/useIVAnomalies.ts` (modified), `src/__tests__/hooks/useIVAnomalies-replay.test.ts` (new)                      |
| 3     | `src/components/IVAnomalies/IVAnomaliesSection.tsx` (modified)                                                           |
