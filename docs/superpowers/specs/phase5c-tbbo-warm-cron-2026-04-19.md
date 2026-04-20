# Phase 5c — Pre-warm cron for tbbo-ofi-percentile — 2026-04-19

Small follow-up to Phase 4b. The `tbbo-ofi-percentile` sidecar
endpoint pays a ~10-20s cold-cache cost on its first call per
sidecar process (loading Parquet footers + hot-pathing the
aggregation). The Vercel fetcher has a 2s timeout, so the first
analyze call of the day silently returns null and Claude sees no
historical rank line. This phase adds a pre-warm cron that hits the
endpoint before market open each weekday so the OS page cache is
hot when the first analyze call lands.

## Goal

Fire one GET to `/archive/tbbo-ofi-percentile` for each of ES and NQ
at a 1h window, 30 minutes before SPX open (13:00 UTC Mon-Fri).
Success or failure is not consequential — the worst case is the
first analyze call of the day falls back to no-percentile rendering,
which is the current Phase 4b behavior anyway.

## Why a cron and not lazy in-flight warming

Alternatives considered and rejected:

- **Bump fetcher timeout to 10s** — penalizes every analyze call with
  a worst-case 10s block. Pre-warm externalizes the cost.
- **Fire-and-forget warm on first analyze call** — still costs the
  first user. Plus re-warming cross-contamination if sidecar restarts.
- **Pre-warm inside the seed endpoint** — only warms when user
  manually seeds, not after Railway auto-restarts.

Cron is the simplest durable solution.

## Files

### New

- `api/cron/warm-tbbo-percentile.ts` — GET handler with `cronGuard(req, res, { requireApiKey: false })` (we don't call UW; we call the sidecar). Hits the sidecar's `/archive/tbbo-ofi-percentile` twice in parallel (ES + NQ 1h window, dummy value like 0), logs outcomes, returns 200 with a summary.
- `api/__tests__/warm-tbbo-percentile.test.ts` — mock fetch, verify it calls both symbols, verify CRON_SECRET gate, verify graceful handling when sidecar returns 5xx.

### Modified

- `vercel.json` — register the cron. Schedule: `0 13 * * 1-5` (13:00 UTC Mon-Fri = 30 min before 13:30 UTC SPX open). Stagger off the 0-minute if other UW crons fire at :00 (check the file; spec notes a 429 revert in the past).
- `src/main.tsx` — add `/api/cron/warm-tbbo-percentile` to the `initBotId()` protect array per CLAUDE.md convention for new endpoints.

## Implementation

### Cron handler shape

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cronGuard } from '../_lib/api-helpers.js';
import { fetchTbboOfiPercentile } from '../_lib/archive-sidecar.js';
import logger from '../_lib/logger.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const guard = cronGuard(req, res, {
    requireApiKey: false, // not calling UW, calling sidecar
    marketHours: false, // runs at 13:00 UTC, before market open
  });
  if (!guard) return;

  const [esResult, nqResult] = await Promise.allSettled([
    fetchTbboOfiPercentile('ES', 0, '1h'),
    fetchTbboOfiPercentile('NQ', 0, '1h'),
  ]);

  const esOk = esResult.status === 'fulfilled' && esResult.value !== null;
  const nqOk = nqResult.status === 'fulfilled' && nqResult.value !== null;

  logger.info({ esOk, nqOk }, 'tbbo-ofi-percentile pre-warm completed');

  return res.status(200).json({
    ok: esOk || nqOk,
    es: esOk,
    nq: nqOk,
  });
}
```

Key decisions:

- `marketHours: false` — we run this BEFORE market open intentionally
- `requireApiKey: false` — don't need UW_API_KEY; we call our own sidecar
- Value of 0 is a valid dummy for warming — percentile math still runs, result is just always ~50th-percentile
- Never fails the response even if sidecar is down — logged for observability; the point is to warm the cache opportunistically

### Cron test pattern

Use `vi.mocked(getDb)` mock setup if needed, `process.env.CRON_SECRET` in setup, mock the `archive-sidecar` module's `fetchTbboOfiPercentile`. Cases:

1. Happy path — both symbols warm successfully, 200 with `{ok: true, es: true, nq: true}`.
2. ES fails / NQ succeeds — 200 with `{ok: true, es: false, nq: true}`.
3. Both fail — 200 with `{ok: false, es: false, nq: false}` (still 200, not 500 — pre-warm failure is not a hard error).
4. Missing CRON_SECRET — 401.
5. Non-GET method — 405.

### vercel.json schedule

Add new entry:

```json
{
  "path": "/api/cron/warm-tbbo-percentile",
  "schedule": "0 13 * * 1-5"
}
```

Check existing entries for :00-minute firing conflicts. If there's a conflict, stagger to `:01` or `:02` per the 429 revert precedent.

### src/main.tsx protect

```ts
initBotId({
  protect: [
    ...,
    { path: '/api/cron/warm-tbbo-percentile', method: 'GET' },
  ],
});
```

## Constraints

- **No new DB migrations.**
- **No changes to Phase 4b files** except what's needed to reference them (the new cron imports `fetchTbboOfiPercentile`).
- **Runs exactly daily** at 13:00 UTC Mon-Fri.
- **Failure doesn't block anything** — logged, returns 200.

## Done when

- `npm run review` passes.
- All 5 test cases pass.
- Cron registered in vercel.json.
- `src/main.tsx` protect array updated.
- After deploy, check Vercel's cron log Monday 13:00 UTC to confirm it fires.

## Out of scope

- Pre-warming `tbbo-day-microstructure` — that endpoint isn't called by the hot analyze path (Phase 4b wired only the percentile into analyze context).
- Pre-warming `es_day_summary` / `analog_days` — the parallel session's existing endpoints; if they show cold-start issues, handle separately.
- Restart detection / re-warming after Railway container cycles — one warm per weekday morning is enough for our cadence.

## Open questions

- **Schedule vs market-hours cron guard:** `cronGuard`'s `marketHours: false` lets the cron run outside the 13-21 UTC market window. Confirm that's the right override. Default cronGuard behavior rejects non-market-hours requests, which would break pre-warm (we run at 13:00 UTC, 30 min before open).
- **What if the sidecar is down entirely?** The fetcher returns null on connection failure (2s timeout). Our handler logs and returns 200. No alert; user will see "no Historical rank line" in analyze output when that day's analyze runs. Flag for later if reliability matters.
