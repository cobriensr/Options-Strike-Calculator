# regime-0dte — Handoff (paused 2026-06-07)

**Branch:** `feat/regime-0dte` (worktree `/private/tmp/regime-0dte`, off `origin/main`, pushed).
**Spec:** `docs/superpowers/specs/2026-06-07-regime-0dte-panel-design.md`
**Plan:** `docs/superpowers/plans/2026-06-07-regime-0dte-panel.md` (13 tasks, 4 phases)

## Done
- **Phase 1 — pure evaluator COMPLETE, reviewed (pass), pushed.**
  - `api/_lib/regime-0dte.ts`: `gradeGate`, `gexNear`, `flipStrike`, `countCandles`, `ivBreak`, `evaluateRegime0dte` + types/constants. Fully pure (no DB/network/clock).
  - `api/__tests__/regime-0dte.test.ts`: 15 tests pass; `npm run lint` clean.
  - Commits: ec3f8446, 2389b62f, 4816bfc9, e9671319.

## NEXT (do this first when resuming) — Plan Task 12: calibrate `GATE_DEEP_NEG`
`GATE_DEEP_NEG = -0.15` in `api/_lib/regime-0dte.ts` is in the **EOD-parquet study's units**. The live `gex_strike_0dte` columns (`call_gamma_oi`, `put_gamma_oi`) are a DIFFERENT scale. The gate SIGN (calm vs negative) is correct already; only the deep-neg MAGNITUDE needs re-fitting.

1. Against **prod Neon** (read-only), compute per-day `gexNear` (sum of `call_gamma_oi - put_gamma_oi` within ±1% of that minute's `price`) at the latest minute. Query sketch in plan Task 12 Step 1.
2. Set `GATE_DEEP_NEG` to the **~12th percentile** (most-negative ~12% of days, matching 13/106 from the study). If history < ~30 days, use an interim (median of negative-GEX days) + a dated TODO.
3. Re-run `npm run test:run -- regime-0dte.test.ts` (signs are scale-invariant; fixtures should still pass).

## Then: Phases 2–4 (subagent-driven, per the plan)
- **P2:** migration `flow_regime_0dte_daily` (Task 4, update `db.test.ts`) → read helpers `regime-0dte-queries.ts` (Task 5) → endpoint `api/regime-0dte.ts` (Task 6) → nightly cron `capture-regime-0dte` + `vercel.json` (Task 7).
- **P3:** `useRegime0dte` hook + `Regime0dte/` rich panel (4 sub-viz) (Tasks 8–10).
- **P4:** wire into `App.tsx` + e2e + optional history seed from `docs/tmp/crash-autopsy/master_scorecard.csv` (Tasks 11, 13).

## Notes
- Live tables (all 1-min crons, no new capture cron needed): `gex_strike_0dte`, `strike_iv_snapshots` (SPXW puts, ±12% band keeps ATM), `index_candles_1m` (SPX).
- Mirror patterns: Opening Flow Signal triad (`useOpeningFlowSignal`/`api/opening-flow-signal.ts`/`OpeningFlowSignal.tsx`), `withCronInstrumentation`, `guardOwnerOrGuestEndpoint`.
- Research harness + 106-day baseline: `docs/tmp/crash-autopsy/` (on the `fix/feed-never-vanish` branch / main checkout, not this worktree).
- Pre-existing baseline test failure unrelated to this work: `takeit-score.parity.test.ts` (missing generated ML artifact in fresh worktrees).
