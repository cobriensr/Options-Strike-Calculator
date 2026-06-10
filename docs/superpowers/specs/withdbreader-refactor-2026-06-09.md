# withDbReader — shared reader-endpoint wrapper (code-review #7/#8)

**Date:** 2026-06-09
**Goal:** Replace the per-endpoint copy-paste of `metrics.request` + `withIsolationScope`
+ `try/catch → sendDbErrorResponse` with a single wrapper, so the soft-degrade
policy lives in ONE place and new reader endpoints adopt it by construction.

**Scope decision (user-confirmed):** "Clean ones only — no behavior change."
Migrate ONLY the reader endpoints that are ALREADY GET-405-gated, instrumented
with `metrics.request`, single-JSON-response, with their auth guard up front.
Do NOT touch: mixed GET+write (panel-prefs, positions, pre-market,
tracker/contracts), no-method-gate / no-metrics readers (would add 405 + metrics
= behavior change), CSV/binary outputs, or gex-target-history (stale-on-error
inside its own catch). Those keep their current per-endpoint sendDbErrorResponse.

## Design

`api/_lib/request-scope.ts` gains `withDbReader`, composing the existing
`withRequestScope('GET', path, ...)` (Sentry isolation scope + setTransactionName
+ metrics.request→done + 405 method check) and adding the outer try/catch:

```ts
export function withDbReader(
  path: string,
  label: string,
  handler: ScopedHandler,                 // (req, res, done) => Promise<unknown>
  opts: { serverErrorBody?: Record<string, unknown> } = {},
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return withRequestScope('GET', path, async (req, res, done) => {
    try {
      await handler(req, res, done);
    } catch (err) {
      sendDbErrorResponse(res, err, { label, serverErrorBody: opts.serverErrorBody, done });
    }
  });
}
```

Each migrated endpoint becomes:
```ts
export default withDbReader('/api/zero-gamma', 'zero_gamma', async (req, res, done) => {
  const guard = await guardOwnerOrGuestEndpoint(req, res, done);
  if (guard) return;
  // ...validation 400s, logic...
  done({ status: 200 });
  res.status(200).json(payload);
});
```
The handler keeps its OWN guard / rate-limit / zod-400 / 404 returns verbatim
(the wrapper does not touch auth/validation). `done({status:200})` stays in the
handler; transient/genuine error statuses are recorded by the helper via `done`.

## Endpoints to migrate (~17, all migratable:"clean" in the catalog)

alerts, gamma-setups/active, gamma-setups/weekly-stats, greek-exposure-strike,
interval-ba-alerts, interval-ba-feed, journal, ml/plots (NO auth guard — keep it
guard-less), ml/prediction, nope-intraday, periscope-chat-detail,
periscope-lessons-list, periscope-playbook, strike-trade-volume,
tracker/alerts/unread, vega-spikes, zero-gamma.

Per-endpoint notes: journal uses guardOwnerEndpoint (owner-only) + rateLimit(20);
ml/plots has no guard; periscope-* have rate limits; several have pre-query zod
400s — all move verbatim into the inner handler.

## Behavior-preservation invariants (MUST hold)

- Same HTTP method handling (405 on non-GET — already true for these).
- Same auth guard, rate limit, zod-400, 404 early returns.
- Same success response + done({status:200}).
- Same transient→503 / genuine→500 (now via the wrapper's catch).
- Default serverErrorBody `{error:'Internal error'}` where the endpoint used that;
  pass serverErrorBody explicitly where it differs (journal 'Query failed',
  ml/plots 'Failed to fetch plot data', ml/prediction 'Failed to fetch prediction').

## Phases

1. **withDbReader + unit tests** (request-scope.ts). Tests: success passthrough,
   transient→503+done(503)+RetryAfter+no Sentry, genuine→500+done(500)+Sentry,
   405 on non-GET, default body.
2. **Migrate in batches of ≤5**, each: rewrite handler to withDbReader form,
   UPDATE the endpoint's test so it still passes (default export still a
   (req,res)=>Promise callable; method/guard/200/503/500 assertions hold),
   `npx tsc --noEmit` + `npx vitest run` the touched tests.
3. **Verify** `npm run review` green; final code-reviewer; commit + push.

## Verification

`npm run review` green (tsc + eslint + prettier + full vitest). Each migrated
endpoint: 200 happy path, a 4xx guard/validation path, transient→503,
genuine→500 all still asserted. Zero behavior change vs pre-refactor.
