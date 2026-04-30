# UW Concurrency Semaphore — corrective design

**Date:** 2026-04-30
**Supersedes:** [`uw-rate-limiter-2026-04-27.md`](./uw-rate-limiter-2026-04-27.md) (limiter shape only — daily/per-minute budget logic from that doc is retained)
**Status:** Implementation plan

## Goal

Stop intermittent UW 429 errors with body `"You have exceeded 3 concurrent requests"` by enforcing **concurrency** (in-flight count at any instant) rather than dispatch rate (count per fixed time window).

## Why the existing limiter doesn't catch this

`api/_lib/uw-rate-limit.ts` uses fixed 1-second buckets keyed `uw:rl:s:{epoch_sec}` with cap 3 per second. UW's actual cap is a true concurrency limit — at most 3 unanswered HTTP requests at any moment, regardless of when they were dispatched.

The two invariants diverge at second boundaries. Concrete failure mode:

```
t=14:28:50.700  → request A dispatched, second-bucket=50, count=1  ✓
t=14:28:50.800  → request B dispatched, second-bucket=50, count=2  ✓
t=14:28:50.900  → request C dispatched, second-bucket=50, count=3  ✓
t=14:28:51.001  → request D dispatched, second-bucket=51, count=1  ✓ (limiter says ok)
t=14:28:51.100  → request E dispatched, second-bucket=51, count=2  ✓ (limiter says ok)
t=14:28:51.200  → request F dispatched, second-bucket=51, count=3  ✓ (limiter says ok)
```

At `t=14:28:51.200`, requests A–F are all in flight (typical UW latency 800–1500 ms). UW sees 6 concurrent → 429 on the 4th–6th.

Confirmed by Sentry breadcrumbs on issue triggered 2026-04-30 14:28:51.245 CDT:
- 3 Upstash POSTs at `.193 / .199 / .200` (limiter granted slot)
- UW request at `.242` returned 429 with body `"3 concurrent requests, the maximum..."`

The limiter did its job per its own spec. The spec is wrong.

## Architecture

### Distributed counting semaphore (Redis ZSET-based)

Single ZSET `uw:cc` whose members are slot UUIDs and whose scores are lease expiry timestamps (ms since epoch).

```
acquire:
  1. ZREMRANGEBYSCORE uw:cc -inf <now>          ← gc expired leases
  2. ZCARD uw:cc                                 ← current in-flight count
  3. if count >= CAP: deny, sleep, retry
     else: ZADD uw:cc <now + LEASE_MS> <uuid>; granted

release (on success or failure):
  ZREM uw:cc <uuid>
```

Steps 1–3 wrapped in a Lua script for atomicity. Lease TTL handles function crashes — a slot held by a dead Lambda auto-recovers in `LEASE_MS`.

### Why ZSET instead of INCR/DECR counter

INCR/DECR counters have two failure modes:
1. **Crash leak** — function dies between INCR and DECR, counter stays inflated forever, eventual deadlock.
2. **TTL mass-reset** — putting TTL on the counter wipes ALL slots simultaneously when it expires, instead of expiring per-lease.

ZSET fixes both: each slot is an independent member with its own expiry score; `ZREMRANGEBYSCORE` reaps dead leases lazily on every acquire, so leaks self-heal in ≤30 s.

### Composition with existing `acquireUWSlot`

Keep `acquireUWSlot` as a **per-minute budget enforcer** (orthogonal to concurrency — protects against runaway loops that would burn the daily UW quota even at 3 concurrent). Drop the per-second cap from that module since the semaphore now owns that invariant.

```
uwFetch:
  await acquireUWSlot()                  ← per-minute budget (existing)
  slot = await acquireConcurrencySlot()  ← concurrency (new)
  try:
    return await doFetch()
  finally:
    await releaseConcurrencySlot(slot)
```

### withRetry — 429 reason differentiation

Today `withRetry` treats all 429s with 1s/2s exponential backoff. UW returns two distinct 429s:
- `"3 concurrent requests"` — clears in ~1 s as in-flight requests drain. Short jittered backoff (250–500 ms) is correct.
- `"120 in 60 seconds"` — minute window has to roll. 1s/2s is way too short. Honor `Retry-After` if present, else 5–30 s.

Parse the error message; pick a backoff function accordingly.

### Telemetry

| Metric | Type | Sampled at | Purpose |
|---|---|---|---|
| `uw.concurrency.in_use` | gauge | every acquire | how close to cap on average |
| `uw.concurrency.wait_ms` | histogram | acquire-to-grant | saturation pressure |
| `uw.concurrency.timeout` | counter | acquire failure | hard-saturation events |

If `wait_ms` p95 > 5 s sustained, the cap is too low for the cron load — drop tickers or raise the UW plan tier.

## Constants

| Name | Value | Rationale |
|---|---|---|
| `UW_CONCURRENCY_CAP` | `3` | Matches UW account limit (confirmed by 429 body) |
| `LEASE_MS` | `30_000` | Longer than any single UW request (typical 0.8–1.5 s, p99 ~5 s) |
| `MAX_ACQUIRE_ATTEMPTS` | `60` | 60 × ~250 ms ≈ 15 s wall-clock max, well under Vercel cron timeout |
| `WAIT_BASE_MS` | `250` | Average UW request duration order-of-magnitude |
| `WAIT_JITTER_MS` | `250` | Prevents thundering herd on slot release |

## Phases

Each phase is independently shippable. Run `npm run review` after each.

### Phase 1 — Build the semaphore library (no wiring)

**Files**
- CREATE `api/_lib/uw-concurrency.ts` (~80 LOC)
- CREATE `api/__tests__/uw-concurrency.test.ts` (~150 LOC, 5 tests)

**Tests**
1. `acquireConcurrencySlot()` returns a UUID and registers a member in the ZSET
2. Acquire blocks (waits) when at cap, succeeds after a slot frees
3. Expired leases are auto-reclaimed on the next acquire (set lease past, verify count drops)
4. `releaseConcurrencySlot(uuid)` removes the slot
5. Acquire throws after `MAX_ACQUIRE_ATTEMPTS` when cap is sustained

**Verify** — `npm run review` clean; new tests pass; no production code calls the new module yet.

### Phase 2 — Wire into `uwFetch`

**Files**
- MODIFY `api/_lib/api-helpers.ts` — import the new module, wrap `uwFetch` body in try/finally with acquire/release. Add the three telemetry metrics.
- MODIFY `api/__tests__/api-helpers.test.ts` — existing `uwFetch` tests need `vi.mock` for the semaphore module so they don't try to hit Redis. Add 1–2 cases verifying release happens on both success and error paths.

**Verify** — `npm run review` clean; deploy to production; observe Sentry for 429 issue (`7421183959`) — count should stop incrementing once new revision is serving traffic.

### Phase 3 — withRetry 429 differentiation

**Files**
- MODIFY `api/_lib/api-helpers.ts` — add a `classify429(msg)` helper, branch backoff strategy.
- MODIFY `api/__tests__/api-helpers.test.ts` — 2 new tests:
  - 429 with `"3 concurrent"` body → backoff is < 600 ms before retry
  - 429 with `"120 in 60 seconds"` body → backoff respects Retry-After or defaults to ≥ 5 s

**Verify** — `npm run review` clean. The semaphore from phase 2 should already eliminate most 429s, but if any slip through (e.g., during deploy lag), withRetry now backs off correctly.

### Phase 4 — Update prior spec + memorialize

**Files**
- MODIFY `docs/superpowers/specs/uw-rate-limiter-2026-04-27.md` — add a header note linking to this doc as the corrective design. Don't rewrite the original; preserve the historical decision context.

**Verify** — link renders correctly when previewed.

## Data dependencies

Already in place — no new infra:

- Upstash Redis (already used by `uw-rate-limit.ts`, gated by `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`)
- No new env vars
- No DB migrations
- No new external API access

Lua via `EVAL` requires Upstash to support scripting. Open question — see below. Fallback uses `WATCH`/`MULTI` if needed.

## Open questions

1. **Does Upstash Redis support `EVAL` of Lua scripts?**
   The Upstash REST API documents `eval` as supported. Will confirm during Phase 1 implementation by writing a probe test. **Fallback if not:** use `WATCH` on `uw:cc` + `MULTI`/`EXEC` transaction — slightly slower under contention but functionally equivalent.

2. **Should `acquireUWSlot`'s per-second cap be removed entirely?**
   Yes — once the semaphore enforces concurrency, the per-second window adds redundant friction (a request can be slot-granted but rate-blocked at second boundaries, doubling latency). Per-minute cap stays as a budget guardrail. **Decision:** remove per-second cap from `acquireUWSlot` in Phase 2. Per-minute cap is retained.

3. **Region qualifier on the semaphore key?**
   Vercel runs cron functions in `iad1` per `cloud.region` from Sentry. UW likely sees requests from a single Vercel egress IP regardless of function region, but if Vercel's load balancer ever spreads us across regions, our single Redis instance still gives correct global coordination. **Decision:** keep `uw:cc` as a single global key. Re-evaluate only if multi-region deploy is configured later.

4. **Should `releaseConcurrencySlot` be best-effort or required?**
   Best-effort — wrap in `try { ... } catch { /* lease will expire */ }`. If Redis is unavailable on release, the lease auto-expires in `LEASE_MS`. Failing release shouldn't block the request response.

## Files touched (summary)

| File | Action | Phase |
|---|---|---|
| `api/_lib/uw-concurrency.ts` | CREATE | 1 |
| `api/__tests__/uw-concurrency.test.ts` | CREATE | 1 |
| `api/_lib/api-helpers.ts` | MODIFY | 2, 3 |
| `api/__tests__/api-helpers.test.ts` | MODIFY | 2, 3 |
| `api/_lib/uw-rate-limit.ts` | MODIFY (drop per-second cap) | 2 |
| `api/__tests__/uw-rate-limit.test.ts` | MODIFY (drop per-second tests) | 2 |
| `docs/superpowers/specs/uw-rate-limiter-2026-04-27.md` | MODIFY (link forward) | 4 |

Phase 2 expanded slightly from initial scoping — dropping the now-redundant per-second cap from `acquireUWSlot` is a correctness win and keeps the design clean.

## Out of scope

- Auto-tuning the cap based on observed `wait_ms` — manual constant for now.
- Priority queue for cron jobs (e.g., critical crons jump the line) — only useful if we sustain saturation, which the semaphore should prevent.
- Multi-region key sharding — only relevant if Vercel deploy goes multi-region.
- Replacing `mapWithConcurrency` per-cron — the global semaphore subsumes its purpose, but per-cron limits are still useful as a hint to UW (don't bunch 14 requests in 50 ms even if the global cap allows). Keep `mapWithConcurrency` as is.

## Success criteria

- Sentry issue `7421183959` (UW 429 `"3 concurrent"`) stops accumulating new events after the Phase 2 deploy.
- `uw.concurrency.wait_ms` p95 < 2 s during normal market hours; p99 < 10 s.
- `uw.concurrency.timeout` counter at zero per day (the cap is high enough that we never sustain saturation past `MAX_ACQUIRE_ATTEMPTS`).
- No regressions in existing UW cron tests; full `npm run review` green at every phase boundary.
