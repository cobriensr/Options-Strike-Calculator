# Feed Never-Vanish (Absolute) — Design Spec

**Date:** 2026-06-06
**Status:** Proposed — pending user review
**Branch:** `fix/feed-never-vanish`

## Goal

**Once a Lottery Finder or Silent Boom alert has appeared in the UI, it must never disappear for the rest of that trading day — absolutely, no exceptions.** Transient server empties, mid-session suppression flips, score deducts, and page refreshes must not remove a row the user has already seen.

## Why (root causes found in the 2026-06-06 investigation)

The client currently does a **straight replace** every poll (`src/hooks/useFetchedData.ts:126`) with **zero client-side pinning** — the UI shows exactly what the server returned *this* poll. Lottery's server-side `chain_max_takeit` monotonic gate (`api/lottery-finder.ts:494,562`) protects the take-it floor, but three server vectors still drop previously-returned rows:

1. **Timeout → `[]`**: heavy reignition/badge/cluster CTEs hit `degradeOnTimeout(... [] ...)` (`api/lottery-finder.ts:294,1119`) and blank the "Hot Right Now" section for a poll (~258×/day historically). Self-heals next poll. **Most frequent.**
2. **Q1/Q2 quintile suppression flip**: suppression joins the *live* `lottery_ticker_stats.inversion_quintile` (`api/lottery-finder.ts:563`); a mid-session refit can suppress all of a ticker's chains. Persistent within the day.
3. **Silent Boom has no monotonic gate** (`api/silent-boom-feed.ts:454`, per-row `takeit_prob`); safe only because columns are frozen at insert — fragile, and a round-trip score deduct can demote a row under a client `minScore` floor.

A **client-side absolute union** neutralizes all three at once, independent of any server behavior.

## Scope

**In scope:** "Never *remove* a row once the server has returned it (i.e., once it appeared)." Applies to both feeds and the reignition / "Hot Right Now" section.

**Explicitly OUT of scope (separate concern):** a fire that *never appeared* because it didn't clear a first-paint floor (e.g. take-it `≥0.70` default, Silent Boom `vol/OI ≥0.5` default). That's "never shown," not "vanished." If every detector fire should appear regardless of floor, that's a separate floor-default change — tracked as an open question, not built here.

## Approach — client-side sticky union, persisted per date

A reusable hook maintains a **union of every item the server has ever returned for the current date**, keyed by a stable id:

- On each poll: for each item in the server response, **upsert** into the union (insert if new, update fields if seen before). Items in the union that are **absent** from this response are **kept** (pinned with their last-known fields).
- The displayed list = the union (re-sorted by the active sort).
- **Reset boundary:** the union is scoped to `(feed, date)`. When the active date changes (user picks a date, or ET-midnight rollover changes the default), a fresh union for the new date is used. Prior dates are not accumulated into the current view.
- **Persistence:** the union is persisted to `localStorage` keyed by `(feed, date)` so a **page refresh does not lose pinned rows** (satisfies "ever"). Bounded — one trading day's fires, cleared when the date rolls.

### Pinned-row semantics
A row absent from the latest poll renders with its **last-known fields** (it does not "freeze-flash" or grey out — it simply persists). This is intentional: the requirement is "do not vanish," and last-known is the correct representation of a row the server is transiently not returning. (Live fields like fire-count/score stop advancing only while the server isn't returning it; they resume on reappearance.)

## Components & Files

**Create:**
- `src/hooks/useStickyUnion.ts` — generic never-vanish accumulator: `useStickyUnion<T>(items: T[], { key: (item) => string, resetKey: string, storageKey: string }): T[]`. In-memory `Map` + `localStorage` hydration/persistence keyed by `resetKey`; upsert-and-never-delete; resets when `resetKey` changes. Test: `src/__tests__/useStickyUnion.test.ts`.

**Modify:**
- `src/hooks/useLotteryFinder.ts` — wrap the fetched fires in `useStickyUnion`, keyed by the chain/fire stable id, `resetKey = date`, `storageKey = 'lottery:' + date`. The implementer must confirm the stable id field on the fire row (chain identity = `underlying_symbol|strike|option_type|expiry`, or a server-provided fire/chain id — verify against the response type).
- `src/hooks/useSilentBoomFeed.ts` — same, keyed by the alert id (`silent_boom_alerts` row id — verify the field name).
- `src/components/LotteryFinder/index.tsx` + `src/components/SilentBoom/index.tsx` — derive displayed **counts** (ticker-count badges, total) from the union so they match the rendered rows (don't let the separate ticker-counts endpoint under-count pinned rows). Ensure the reignition / "Hot Right Now" section also draws from the union (so a timeout `[]` can't blank it).
- **Pagination:** the union can exceed `PAGE_SIZE` (50). Confirm pinned rows remain reachable — and since "scrolled to page 2" is arguably still "vanished from view," evaluate raising/removing the page cap for the union or surfacing a "N more" affordance. (Decision below.)

## Data dependencies

None new (no tables, env vars, or endpoints). Pure client state + `localStorage`. The existing endpoints are unchanged; the union is layered on top of their responses.

## Phases

1. **`useStickyUnion` hook + tests** — the generic accumulator (upsert-never-delete, reset on key change, localStorage hydrate/persist, SSR/no-window guard). Independently testable.
2. **Wire Lottery** — `useLotteryFinder` uses the union; counts + reignition section draw from it. Verify against the LotteryFinder tests + add union-specific tests.
3. **Wire Silent Boom** — `useSilentBoomFeed` uses the union; counts from it.
4. **Pagination/counts polish** — ensure no pinned row is unreachable; reconcile badges; (optional) "new fires" affordance.
5. **Verify + e2e** — full `npm run review`; a focused test simulating a poll that drops a previously-returned row and asserting it stays.

## Thresholds / Constants

- Union reset scope: `(feed, date)`.
- `localStorage` key: `feed-union:<feed>:<date>` (namespaced; cleared when date rolls).

## Open Questions (with default picks)

1. **Stable id fields** — confirm the exact unique key per feed from the response types (Lottery chain identity vs a fire id; SB alert id). *Default: use a server-provided id if present, else the composite chain/alert identity.* (Implementer verifies in Phase 2/3.)
2. **Pagination roll-off** — is a pinned row on "page 2" acceptable, or does "never vanish from view" require it stays on one continuously-growing list? *Default: keep pagination but ensure pinned rows are never dropped from the union; revisit a "new fires" indicator if page-1 roll-off feels like vanishing.*
3. **localStorage vs in-memory** — *Default: localStorage-backed (refresh-proof), per the "ever" requirement.* In-memory-only would lose pins on refresh.
4. **First-paint floor** (out of scope above) — should sub-floor detector fires also appear (separate from never-vanish)? *Default: no — leave the take-it/vol-OI floors as-is; revisit separately if desired.*

## Risks & Notes

- **Stale fields on pinned rows** — acceptable and intended (last-known representation of a not-currently-returned row).
- **localStorage growth** — bounded to one day's fires per feed; reset on date roll. Guard JSON size defensively.
- **SSR/no-window** — guard `localStorage`/`window` access (the app is CSR-only, but guard anyway).
- **Counts drift** — must derive displayed counts from the union, or badges will under-count pinned rows.
- **Pre-existing, not Options-Alerts scope** — this is a separate branch/PR from the Options Alerts UI (PR #165); it's based on that branch only to inherit the latest feed code and avoid merge conflicts in the shared feed files.
