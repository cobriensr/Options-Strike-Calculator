# Never-vanish union: hard-floor + cross-day retain guard

**Date:** 2026-06-10
**Trigger:** With min-premium = 20K set, QQQ 684P rendered in the regular ticker group showing **$15K** premium. Confirmed via prod DB + localStorage dump: the chain has two fires today — fire #1 $28,623 (≥20K, the server's correct rep under the filter) and fire #2 $14,976 (the no-filter rep). The **$15K fire #2 was pinned in multiple main-feed union slots** and never replaced.

## Root cause (confirmed, not theorized)

`useStickyUnion` never deletes a pinned row except via `tombstones`. The never-vanish guarantee was built to bridge a chain that *transiently* drops out of a single poll. But it has **no awareness of hard user filters**:

- A chain pinned while the premium floor was off/lower (rep = fire #2, $15K) stays pinned after the floor tightens to 20K.
- The server correctly returns the chain as fire #1 ($28K) under 20K, but if that qualifying rep isn't on **page 0** of the current poll, there's nothing to upsert over the stale fire #2 — so the sub-floor row renders indefinitely.

Server is correct (verified: rep under 20K = fire #1 $28,623). This is purely client-side. Same class as the earlier cross-day leak (a pinned row surviving a constraint it should be re-scoped by).

## Fix

### `useStickyUnion` — add an optional `retain` predicate
```ts
/** Drop any item for which retain(item) === false, at BOTH hydrate and ingest.
 *  Distinct from tombstones (explicit per-key retraction): this is an intrinsic
 *  per-row validity check against the active view (trading day, hard floors). */
retain?: (item: T) => boolean;
```
- **Hydrate** (readUnion / storageKey-change effect): filter the rehydrated map through `retain`; if anything was dropped, persist the cleaned blob so a poisoned slot self-heals durably on load.
- **Ingest**: skip incoming items failing `retain` (never upsert them) AND purge existing union entries failing it (so a tightened floor drops already-pinned rows). Mark `dirty` when a purge happens so the snapshot + persist update.
- Forward via a ref (like `keyFn`/`tombstones`) so an inline closure doesn't churn the ingest effect.
- Tombstones still take precedence; `retain` is additive.

### `useNeverVanishFeed` — forward `retain` to `useStickyUnion`
Optional passthrough, same pattern as `tombstones`.

### `LotteryFinder/index.tsx`
- **Main fires union** (`firesFeed`): `retain: (f) => sameDay(f) && premium(f) >= activeFloor` where
  `sameDay(f) = String(f.date).slice(0,10) === date`,
  `premium(f) = f.entry.price * f.trigger.windowSize * 100`,
  `activeFloor = minPremiumK * 1000`.
- **Reignited union** (`reignitedFeed`): `retain: (f) => sameDay(f)` ONLY. **Premium stays floor-blind** in Hot Right Now per owner decision 2026-06-10 (cheap re-igniting movers — the SNDK +1974% rationale). Do NOT add the premium clause here.

### `SilentBoom/index.tsx`
Mirror LotteryFinder: main union `retain` = sameDay && premium-floor; reignited/HRN equivalent = sameDay only. (User reported the same symptom on Silent Boom.) Verify SB's row premium field + floor wiring before applying — use SB's own `minPremiumK`/row shape, don't assume LF's.

## Why this is correct, not a symptom-mask
- A never-vanish feed must never render a row below the user's active hard floor — that's a correctness invariant, not cosmetic.
- It does NOT wrongly hide legitimately-qualifying chains: QQQ 684P's stale $15K pin is dropped, and its qualifying $28K rep (fire #1) re-populates on the next poll that delivers it. Transient-omission never-vanish still works for rows that pass the floor.
- HRN floor-blindness is explicitly preserved (retain = date-only there).

## Tests (TDD)
- `useStickyUnion`: hydrate drops rows failing `retain` and persists the cleaned blob; ingest skips failing incoming rows; ingest purges already-pinned rows that now fail `retain`; rows passing `retain` still never-vanish on transient omission; tombstones still win.
- `useNeverVanishFeed`: forwards `retain`.
- Component (Lottery + SilentBoom): a pinned sub-floor row disappears when the floor is set; a cross-day row never renders; HRN reignited rows are NOT premium-filtered.

## Out of scope / follow-up
- Why the qualifying rep isn't always on page 0 to refresh the pin (pagination interaction) — the guard makes it moot, but note it.
