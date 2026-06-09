# Graceful degradation on transient DB timeouts — greek-heatmap + opening-flow-signal

**Date:** 2026-06-09
**Goal:** When a Neon query trips `withDbRetry`'s per-attempt timeout (the
`db attempt timeout` error) or any other transient DB blip, the two read
endpoints should degrade gracefully — a soft, auto-retrying state instead of a
hard `HTTP 500` error card — and stop spamming Sentry with infra-blip
exceptions.

## Background

Triage on 2026-06-09 found `/api/greek-heatmap` and `/api/opening-flow-signal`
both 500ing intermittently. Every 500 matched the `db attempt timeout` string
(`withDbRetry`'s 10s per-attempt timeout in `api/_lib/db.ts`). They failed at
the same second alongside a cron — a shared Neon slowdown driven by an all-day
classifier OOM crash loop hammering the shared Neon instance, NOT a code or
build regression. The OOM has since been corrected; this work hardens the
endpoints so the next transient stall is a non-event.

Both client hooks already preserve last-good data (`useGreekHeatmap` in-memory +
stale badge; `useOpeningFlowSignal` via localStorage `displayData`). The
remaining gaps are server-side semantics + Sentry noise, plus greek-heatmap's
first-load (no last-good) error card.

## Phases

### Phase 1 — Backend (server semantics + telemetry)

`isRetryableDbError(err)` is already exported from `api/_lib/db.ts` and matches
`db attempt timeout` (via the `timeout` token in `DB_RETRYABLE_RX`) plus the
real Neon transient signatures (`fetch failed`, `recovery_mode`, etc.).

- **New helper** `api/_lib/transient-db-response.ts`:
  `sendDbErrorResponse(res, err, { logger, label })` —
  - transient (`isRetryableDbError`): `res.setHeader('Retry-After', '5')`,
    `503` `{ error: 'temporarily unavailable', transient: true }`,
    `logger.warn({ err }, '<label> transient db timeout')`,
    `metrics.increment('<label>.db_timeout')`. No `Sentry.captureException`.
  - non-transient: `Sentry.captureException(err)`,
    `logger.error({ err }, '<label> failed')`, `500` (existing body shape per
    caller — keep `{ error: 'internal error' }` / `{ error: 'Internal server
    error' }` respectively by passing the 500 body in).
- Wire `api/greek-heatmap.ts` and `api/opening-flow-signal.ts` catch blocks to
  the helper.
- Tests: `api/__tests__/transient-db-response.test.ts` (both branches, header,
  no-Sentry-on-transient); extend the two endpoint tests to assert 503 +
  Retry-After on a thrown `db attempt timeout` and 500 on a generic error.

### Phase 2 — Frontend (greek-heatmap soft first-load)

- `src/hooks/useGreekHeatmap.ts`: add `transient: boolean` to `State`; set it
  when `!res.ok && res.status === 503`. Expose it in the returned object.
  Preserve last-good exactly as today.
- `src/components/GreekHeatmap/index.tsx`: when `transient && data === null`
  (first-load transient), render a muted neutral "Reconnecting… (auto-retrying)"
  placeholder with a Retry button INSTEAD of the rose
  `Failed to load heatmap` banner. Non-transient first-load failure keeps the
  rose banner. Stale (data !== null) path unchanged.
- Tests: `useGreekHeatmap.test.tsx` — 503 sets `transient` and keeps last-good;
  500 sets `error` with `transient=false`. Component test — transient first-load
  renders the soft placeholder, not the rose banner.

opening-flow-signal client: unchanged — `displayData` already falls back to the
localStorage cache, so a 503 simply keeps the cached panel.

## Verification criteria

- `npm run review` green (tsc + eslint + prettier + vitest --coverage).
- Endpoint unit tests: `db attempt timeout` → 503 + `Retry-After`, no Sentry
  exception; generic `Error` → 500 + Sentry.
- greek-heatmap first-load 503 → soft "Reconnecting" placeholder (no rose card).

## Thresholds / constants

- `Retry-After: 5` (seconds).
- 503 body: `{ error: 'temporarily unavailable', transient: true }`.
- Metric keys: `greek_heatmap.db_timeout`, `opening_flow_signal.db_timeout`.

---

# Round 2 — code-review fixes (2026-06-09)

A high-effort `/code-review` of commit 54b57c4b surfaced 9 findings. This round
fixes all of them, plus rolls the soft-degrade out across reader endpoints (#5).

## Phase 1a — backend foundation (typed transient error)

- **`api/_lib/db.ts`**: add `export class TransientDbError extends Error` that
  wraps the original (`super(original.message)`, `this.cause = original`,
  `name = 'TransientDbError'`). In `withDbRetry`, at the give-up point, when the
  error is retryable, throw `new TransientDbError(err)` instead of the raw err
  (genuine/non-retryable errors still throw raw). Add an early
  `if (err instanceof TransientDbError) return true` to `isRetryableDbError` so
  nested retries + lottery-finder's `degradeOnTimeout` still classify it.
  Blast radius verified safe: 283 refs, all error-inspecting callers use
  `err.message` (preserved) or `instanceof Error` (subclass); none check the
  concrete NeonDbError type.
- **`api/_lib/transient-db-response.ts`** (fixes #2, #4): classify transient via
  `err instanceof TransientDbError` (NOT the raw message regex — a genuine bug
  whose message contains "timeout" no longer gets swallowed). Run telemetry
  (logger + metric / Sentry) BEFORE writing the response, and guard every write
  with `if (!res.headersSent)`. Keeps `Retry-After: 5`.
- **`api/_lib/opening-flow-store.ts`** (#2 consistency): wrap the
  `readOpeningFlowSnapshot` query in `withDbRetry` so its transient blips also
  produce a `TransientDbError`.

## Phase 1b — frontend foundation + #1,#3,#6,#7,#8

- **`src/utils/fetchWithRetry.ts`** (fixes #1): remove `503` from the retried
  statuses — 503 now means "server already retried, back off; the caller's own
  cadence (poll) is the retry." Keep `502`/`504` (gateway hiccups). Export
  `isTransientHttpStatus(status)` = `502|503|504` (single source of truth for
  the client transient flag; reuse finding). Only consumer is useGreekHeatmap,
  so blast radius is trivial.
- **`src/hooks/useGreekHeatmap.ts`** (#3, #6, #7): set `transient` from
  `isTransientHttpStatus(res.status)` captured before throwing (covers 502/504,
  robust to message reformat — fixes the brittle `msg === 'HTTP 503'`). Add a
  consecutive-transient counter (ref); after `MAX_TRANSIENT_RETRIES = 4`
  (~2 min at 30s poll) escalate to the hard error card (`transient` returns
  false) so a sustained outage is distinguishable from a blip (#6). `transient`
  stays genuine State (now status-derived, not message-derived) and TS-required
  so it cannot desync (#7).
- **`src/components/GreekHeatmap/index.tsx`** (#8): extract a `RetryButton`
  (tone: 'neutral' | 'rose' | 'amber'); collapse the two first-load branches
  into one `error && !data` block whose wrapper/text/tone switch on `transient`.

## Phase 1 — #9 disposition (no code change)

opening-flow historical mode does a single fetch with no polling/retry
(`usePolling` gated on `effectiveDate == null`) and plain `fetch` (no
client retry), so the "retry storm" cannot occur automatically; a 503 for a
genuine transient is semantically correct. Wrapping readOpeningFlowSnapshot in
withDbRetry (1a) is the only relevant hardening. Documented as design-mitigated.

## Phase 2 — #5 reader-endpoint sweep

Roll `sendDbErrorResponse` across the **reader** (GET) endpoints whose catch
currently does `Sentry.captureException + status(500)` on a DB read (51 total
`status(500)` files identified). EXCLUDE: write/mutation endpoints (503 invites
client retry → non-idempotent double-apply: panel-prefs PUT, positions POST,
push/*, tracker/contracts mutations, *-ack, periscope-*-update, journal POST),
crons (no client; 503 confuses cron status), and non-DB-primary endpoints
(analyze = Anthropic). Convert in batches of ≤5 files; preserve each endpoint's
existing 500 body + specific non-DB branches (400 validation, Upstream errors).
Safe because: 503 only emitted for `TransientDbError`; non-transient unchanged;
no client amplification (only useGreekHeatmap used fetchWithRetry, and 503 is no
longer retried there).

## Verification

- `npm run review` green after Phase 1; targeted vitest per sweep batch.
- Backend: genuine Error('...timeout...') thrown OUTSIDE withDbRetry → 500 +
  Sentry (no longer misclassified). TransientDbError → 503, no Sentry.
- Frontend: 502/503/504 → soft "Reconnecting"; sustained (>4) → hard card.
