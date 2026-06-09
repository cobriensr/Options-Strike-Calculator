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
