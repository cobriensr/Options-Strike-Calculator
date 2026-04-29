# Shared UW outbound rate limiter (2026-04-27)

## Goal

Eliminate UW 429 warnings by gating every `uwFetch()` call through an
Upstash-Redis-backed token bucket so synchronized cron bursts at minute
boundaries can no longer overrun UW's per-second smoothing window.

## Why this shape

Vercel cron is minute-granular — schedule jitter cannot solve simultaneity.
This was already proven: commit `533fd50` tried to stagger crons off the
top-of-minute and was reverted (`68b9c10`) because the user requires
per-minute monitor crons (`monitor-iv`, `monitor-flow-ratio`,
`fetch-darkpool`) for 0DTE detection latency. The revert message
explicitly recommends "per-endpoint rate-limit guards inside each cron
handler using the existing `isRateLimited()` helper". This spec
implements that fix at the wrapper layer (`uwFetch`), so every UW caller
inherits it without per-cron edits.

The 429s currently fire on `fetch-strike-trade-volume` because it
`Promise.all`s 13 tickers at once. ~10 other UW crons also fire at the
same minute boundary. UW's documented cap is 120/min, but per-second
smoothing trips first when 30–50 concurrent requests land in the same
~1s window.

## Phase 1 — implement and wire (single phase, 3 files)

### Files

- **NEW** `api/_lib/uw-rate-limit.ts` — token bucket logic
- **MODIFY** `api/_lib/api-helpers.ts` — call `acquireUWSlot()` inside `uwFetch`
- **NEW** `api/__tests__/uw-rate-limit.test.ts` — unit tests with mocked redis

### Design

Two Redis-backed counters per request:

1. **Per-second bucket** — key `uw:rl:s:{epoch_sec}`, TTL 5s. Caps the burst.
2. **Per-minute bucket** — key `uw:rl:m:{epoch_min}`, TTL 90s. Safety net under documented 120/min budget.

Both use the existing pipeline-INCR-then-EXPIRE pattern from
`isRateLimited()` at `api/_lib/api-helpers.ts:253`.

### Acquisition logic (pseudocode)

    acquireUWSlot:
      attempts = 0
      while attempts < MAX_WAIT_ATTEMPTS:
        sec_count = INCR uw:rl:s:{now_sec}; EXPIRE 5
        if sec_count > UW_PER_SECOND_CAP:
          sleep WAIT_BASE_MS + random(WAIT_JITTER_MS)
          attempts += 1
          continue
        min_count = INCR uw:rl:m:{now_min}; EXPIRE 90
        if min_count > UW_PER_MINUTE_CAP:
          throw "UW per-minute budget exceeded"
        return  // slot acquired
      throw "UW rate limiter: failed to acquire slot after N attempts"

Slight per-minute counter inflation during burst retries is acceptable —
the per-min cap is a far-from-hot safety net, not the primary control.

### Constants

| Name                | Value | Rationale                                                                                                      |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------- |
| `UW_PER_SECOND_CAP` | `3`   | Account's actual concurrency cap (lowered from 8 on 2026-04-28 — see Follow-up). 0 headroom; jitter de-bursts. |
| `UW_PER_MINUTE_CAP` | `100` | 17% headroom under documented 120/min. Currently nowhere near this.                                            |
| `MAX_WAIT_ATTEMPTS` | `60`  | 60 × ~250ms avg = ~15s max wall-clock per call, well under 60s cron timeout.                                   |
| `WAIT_BASE_MS`      | `150` | Base backoff (raised from 100ms on 2026-04-28 to space retries across more seconds).                           |
| `WAIT_JITTER_MS`    | `100` | Random jitter on top of base, prevents thundering-herd retry sync.                                             |

### Failure modes

- **Redis down / error** → fail open (proceed with the UW call). Log warning + Sentry. Same posture as `isRateLimited()` — Redis being down should not break the data pipeline.
- **Per-second cap repeatedly hit** → wait, retry, eventually throw if 30 attempts fail. Caller (cron) catches and logs; downstream Sentry shows pressure as a metric, not a flood of identical errors.
- **Per-minute cap hit** → throw immediately. Don't wait — by definition we'd wait ~30s for the next minute, blowing function timeouts.

### Observability

When `acquireUWSlot()` waits or throws, emit a Sentry metric:

- `uw.rate_limit.wait` (counter, attribute: `bucket=second`) — incremented on each per-sec wait
- `uw.rate_limit.throw` (counter, attribute: `bucket=second|minute`) — incremented on final throw

These let us monitor the limiter's effectiveness without a flood of warning events.

### Tests

- Under cap → resolves immediately, single INCR pair, no sleep
- Per-second cap exceeded once → waits, second attempt succeeds
- Per-second cap exceeded MAX_WAIT_ATTEMPTS times → throws after ~15s
- Per-minute cap exceeded → throws immediately, no retry
- Redis throws → fail-open path resolves

Use `vi.useFakeTimers()` for the wait-loop tests so we don't actually sleep
in the suite. Mock redis pipeline with `mockResolvedValueOnce` per call,
matching the pattern in `api-helpers.test.ts`.

## Out of scope

- No `vercel.json` schedule changes (rejected previously).
- No env var changes (Upstash already wired via `KV_REST_API_URL` / `KV_REST_API_TOKEN`).
- No per-cron handler edits — the limiter sits in `uwFetch` so every caller is covered transparently.
- No new bot-protect entries in `src/main.tsx` — this is library code, not a new endpoint.

## Open questions

- **`UW_PER_SECOND_CAP = 8` is a guess.** RESOLVED 2026-04-28: actual cap is 3. Lowered. See Follow-up.
- Should we DECR the per-minute counter when we throw on per-minute cap hit? No — TTL handles cleanup, and we don't want to give the caller a "free" retry that bypasses the cap.

## Verification

Run `npm run review` (tsc + eslint + prettier + vitest). Then watch
Sentry for ~10 minutes: the `UW 429 on /stock/.../flow-per-strike-intraday`
warnings should stop appearing, and the new `uw.rate_limit.wait` metric
should show a low (single-digit per minute) waiting rate during top-of-minute bursts.

## Follow-up — 2026-04-28

The original spec went live with `UW_PER_SECOND_CAP = 8`. Production
Sentry continued to report 429 cascades during market hours. Owner
clarified the account's actual concurrency limit is **3 in-flight calls
per second**. Two changes followed:

1. **Tightened limiter constants** in `api/_lib/uw-rate-limit.ts`:
   - `UW_PER_SECOND_CAP`: 8 → 3
   - `MAX_WAIT_ATTEMPTS`: 30 → 60 (drain budget for 16-handler bursts)
   - `WAIT_BASE_MS`: 100 → 150 (smoother retry spacing)

2. **Added `cronJitter()` helper** in `api/_lib/api-helpers.ts` and wired
   it into every UW cron handler scheduled `* 13-21 * * 1-5`:
   - `fetch-darkpool`, `fetch-spot-gex`, `fetch-greek-flow-etf`,
     `fetch-etf-candles-1m`, `fetch-gex-0dte`, `fetch-spx-candles-1m`,
     `fetch-vol-0dte`, `fetch-strike-trade-volume`, `monitor-iv`,
     `monitor-flow-ratio`, `fetch-flow-alerts`, `fetch-nope`

   The original spec deliberately kept rate-limit logic centralized in
   `uwFetch`. With the cap lowered to 3, ~13 handlers all racing to
   acquire 3 slots at second :00 of every minute would queue 10+ deep
   in Redis, burning function CPU on the wait loop. `cronJitter()`
   sleeps 0–8s at handler entry so the 13 handlers spread across the
   window naturally — the limiter then rarely needs to queue.

   The helper is a no-op when `process.env.VITEST` is set so handler
   tests stay fast and deterministic.

Belt-and-suspenders: jitter spreads the burst, the limiter caps what
slips through.
