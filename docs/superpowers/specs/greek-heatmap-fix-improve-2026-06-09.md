# GreekHeatmap Fix & Improve (0DTE) — 2026-06-09

## Goal

Make the existing per-ticker 0DTE GreekHeatmap **trustworthy**: stop it from
blanking on transient poll failures, guard against malformed responses, show
the user how fresh the data is, and correct a regime sign-boundary edge. No
new feature surface; no SPX work (SPX 0DTE already ships under the `SPXW`
ticker, which works end-to-end today).

## Background (audit findings, 2026-06-09)

The core signal is **correct** and verified against source:

- Gamma sign: `netGamma = call_gamma_oi + put_gamma_oi`. UW pre-signs
  `put_gamma_oi` negative (reference payload: `put_gamma_oi: "-1172037.66"`),
  so the additive sum yields correct net dealer gamma. Green = positive
  (dealer long Γ), red = negative. Matches `db-gex-strike-expiry.ts`.
- Aggregation: `DISTINCT ON (strike) ORDER BY ts_minute DESC` → one row per
  strike, latest minute. No cross-timestamp summing, no call/put double-count.
- Empty data returns all-`null` (not fake zeros); DB errors return HTTP 500
  (no silent `.catch(() => [])`).
- ATM exact-match (`s.strike === atmStrike`) is safe because the backend
  derives `atmStrike` from a chain strike value itself.

What needs fixing (this spec):

1. **Wipe-on-error** — `useGreekHeatmap.ts:150` sets `data: null` on any
   non-abort error, so one failed 30s poll blanks the live grid then it
   reappears next tick. Flicker-to-blank during market hours.
2. **No runtime validation** — `useGreekHeatmap.ts:133` raw-casts the JSON;
   a malformed payload renders as garbage.
3. **No data-age affordance** — `asOf` is fetched but never displayed; a
   frozen post-close or scrubbed snapshot looks identical to live.
4. **Regime sign-boundary** — `db-greek-heatmap.ts:248` binary ternary labels
   exactly-flat net gamma as `'Short Γ'` instead of neutral.
5. **Dead docstring** — `GreekHeatmapTable.tsx` documents a "peak ring"
   feature that was never implemented.

**Out of scope (flag, do not change):** the 6 unused `*Oi` fields per strike
row (pre-existing dead payload, not created by this work); the
per-visible-window color-scale normalization (a design decision deferred to
the user).

## Phases

### Phase 1 — Frontend resilience & trust
Files:
- `src/hooks/useGreekHeatmap.ts` (modify)
- the hook's existing test file (modify — locate the colocated `*.test.ts`)
- `src/components/GreekHeatmap/index.tsx` (modify)
- `src/components/GreekHeatmap/DataAgeBadge.tsx` (new)
- a colocated test for the badge (new, follow existing GreekHeatmap test convention)

Hook contract (Task 1 establishes; Task 2 consumes):
- On a non-abort fetch/validation error, **preserve the previous
  `data`** if one exists; only set `data: null` when there was no prior
  successful response. Always set `error` to the message. Add a boolean
  `stale: boolean` to the returned state = `error !== null && data !== null`
  (i.e. "showing last-good data despite a failure").
- Validate the response with a Zod schema mirroring `GreekHeatmapResponse`.
  A parse failure is treated as an error (routes through the
  preserve-last-good path above), not a throw that crashes the consumer.
  Keep the `as GreekHeatmapResponse` removed in favor of the parsed result.

UI:
- `DataAgeBadge` renders the `asOf` timestamp as `as of HH:MM:SS CT` (use the
  repo's existing CT formatting util — check `src/utils/timezone.ts`). When
  `stale` is true, also render a subtle inline strip: "Connection issue —
  showing last update" (non-alarming, amber, not a full error banner).
- Mount the badge in the header row of `index.tsx` near the regime chip.
- The existing full error banner should now only show when there is **no**
  data to fall back to (`data === null && error !== null`).

### Phase 2 — Backend correctness & cleanup
Files:
- `api/_lib/db-greek-heatmap.ts` (modify)
- the endpoint's test file `api/__tests__/...greek-heatmap...` (modify)
- `src/components/GreekHeatmap/GreekHeatmapTable.tsx` (modify — docstring only)
- `src/hooks/useGreekHeatmap.ts` type (modify if needed — `regime` already
  allows `null`)

Changes:
- Regime: return `null` (neutral) when `totalNetGamma === 0`; otherwise
  `> 0 ? 'Long Γ' : 'Short Γ'`. The response `regime` type already includes
  `null` and `RegimeChip` already renders an em-dash for it.
- Delete the dead "peak ring" paragraph from the `GreekHeatmapTable.tsx`
  docstring so the comment matches the implementation.

## Data dependencies
None. No new tables, migrations, env vars, or endpoints. No `/api/greek-heatmap`
contract change except `regime` can now be `null` at exact-zero (already typed).

## Tests (mandatory, same commit)
- Hook: transient error after a successful load **keeps** `data` and sets
  `error`/`stale`; first-load error sets `data: null`; malformed JSON routes
  to the error path without throwing.
- Badge: renders formatted `asOf`; shows the stale strip only when `stale`.
- Backend: `totalNetGamma === 0` → `regime: null`; positive → `'Long Γ'`;
  negative → `'Short Γ'`.

## Verification
`npm run review` (tsc + eslint + prettier + vitest --coverage) must pass with
zero errors before each phase is considered done. Two-stage subagent review
(spec compliance, then code quality) per task.

## Open questions
- Color-scale normalization (per-visible-window vs full-chain absolute):
  deferred to user — not touched here.
