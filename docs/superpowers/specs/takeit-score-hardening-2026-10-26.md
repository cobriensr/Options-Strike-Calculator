# Take-It scorer hardening (2026-10-26)

## Goal

Make the TypeScript Take-It scorer (`api/_lib/takeit-score.ts`) fail loudly on bundle shapes it can't score correctly, instead of quietly returning NaN or a probability Python wouldn't produce. Today's real bundles are not affected.

## Background

A review of the new unit tests (`api/__tests__/takeit-score.test.ts`, added to fix CI) found five gaps (A–E), each confirmed with a probe. Review round 1 of this change found a sixth (F), which predates it:

- **A. Malformed trees score as NaN with no error.** `XGBTreeSchema` (`api/_lib/takeit-bundle-schema.ts`) doesn't require the per-node arrays to be the same length. A tree with `base_weights: []` passes `assertBundleCompat`, and `predictTakeitScore` returns `{prob_raw: NaN, prob_calibrated: NaN}`. `scoreLottery` and `scoreSilentBoom` (`takeit-detect.ts`) pass the NaN on with no Sentry event.
- **B. `out_of_bounds: 'nan'` is accepted but ignored.** `applyIsotonic` always clips. Both live bundles use `'clip'`, set in `ml/src/takeit/train.py:265`.
- **C. `assertBundleCompat`'s `supported` parameter is a test-only seam (R3).** Its only production caller (the `assertBundleCompat(bundle)` call in `fetchBundleByPath`, `takeit-bundle-loader.ts`) and the parity test both use the default.
- **D. Non-number feature values are coerced, not treated as missing.** `walkTree` checks `Number.isNaN`, so `'abc'` goes right even when `default_left` is 1, `'5'` becomes 5 and `true` becomes 1. This can't happen today, because `sanitizeScoringInputs` turns non-finite and non-number values to null first; the fix is defence in depth.
- **E. NaN handling in `applyIsotonic` is inconsistent.** NaN in gives NaN out, except when the first two knots share an x: then it returns `y[0]`. That's the only way into the `x1 === x0` guard in `applyIsotonic`.
- **F. `walkTree` reads the leaf value from the wrong array.** At a leaf it returned `base_weights[node]`. XGBoost's JSON keeps the leaf value in `split_conditions[node]`; `base_weights` is not always the leaf value. The two are equal at leaves `hist` or `approx` creates by splitting, whatever gamma is, which is every leaf in both live bundles (0/7640 lottery and 0/3862 silentboom leaves differ). So live scoring has been right by luck and switching is bit-identical for it. They differ at every `tree_method='exact'` leaf and at the lone leaf of any tree that never split (see the evidence below), so such a retrain would silently miscompute. Once F lands, A's NaN trigger is `split_conditions: []` rather than `base_weights: []`.

The callers already handle a throw safely. `scoreLottery` and `scoreSilentBoom` wrap each row in try/catch, send it to Sentry and return `prob: null`. So turning a silent NaN into a throw gives a Sentry event and a null probability, and the rest of the cron run is unaffected.

## Phase 1 (one commit, small)

- **A.** In `takeit-bundle-schema.ts`, add a `.superRefine` to `XGBTreeSchema` requiring every per-node array to match `left_children.length`. The issue names the first short array and both lengths (e.g. `split_conditions length 0 != left_children length 1`), so a Sentry event can be triaged without the 3.5 MB bundle. In `predictTakeitScore`, throw `BundleSchemaError` when the summed logit is not finite.
- **B.** `assertBundleCompat` rejects `out_of_bounds !== 'clip'` with a `BundleSchemaError` that names the value.
- **C.** Remove the `supported` parameter and read `SUPPORTED_XGB_JSON_SCHEMAS` directly. Grep every caller and mock first.
- **D.** In `walkTree`, treat `typeof value !== 'number' || Number.isNaN(value)` as missing.
- **E.** In `applyIsotonic`, return NaN for NaN input before the clip checks. This makes the `x1 === x0` guard unreachable; keep it with a comment saying why, or remove it if no input can reach it.
- **F.** In `walkTree`, return `split_conditions[node]` at a leaf. Rebuild the hand-made test trees so leaf values live in `split_conditions` (with `base_weights` set to 20x the leaf, as `exact` stores it, so any regression shows in every test), and add a dedicated test with leaves where the two differ.
- **Tests first (TDD).** For each item, add the failing case to `takeit-score.test.ts` (or a schema test), then make it pass. Every error is asserted by class, name and message (R4). For A, a `takeit-detect` test should show a malformed bundle gives `prob: null` plus a Sentry capture, not NaN.
- **Parity.** The local parity test, which uses the real bundles, must still pass with identical outputs. That is the proof that live scoring doesn't change. Also confirm both real bundles pass the new array-length refine and the `out_of_bounds` check.

### Evidence for F

Two independent probes with xgboost 3.4.1 (the review harness exported bundles through `build_bundle`; a second probe trained small models directly and compared against `predict(output_margin=True)`):

- `tree_method='exact'` (eta 0.05, gamma 0): every leaf's `base_weights` is 20x its `split_conditions` (1/eta). Summing `split_conditions` matches XGBoost's margin to ~2e-7; summing `base_weights` misses by up to 26 in margin, and TS `prob_raw` differed from Python by up to 0.45. With `gamma=5`, every `exact` leaf still differs.
- `hist` with `gamma=1e6` (every tree root-only): the lone leaf of each tree differs (20/20); TS `prob_raw` was off by 0.0073. `hist` with `gamma=0` and `min_child_weight=1e6`, also root-only, gives the same 20/20.
- `hist` with `gamma=5`, `hist` with an explicit prune updater, and `approx`: 0 leaves differ. Gamma and pruning are not the trigger; `exact` and never-split trees are.
- `hist` with `gamma=0` (both live bundles): the two arrays are equal at every leaf, so F changes no live output. The parity test and both OLD-vs-NEW identity harnesses confirm this bit for bit.

## Files

- `api/_lib/takeit-score.ts`
- `api/_lib/takeit-bundle-schema.ts`
- `api/__tests__/takeit-score.test.ts`
- `api/__tests__/takeit-detect-malformed-bundle.test.ts` (new)
- `api/__tests__/takeit-bundle-loader.test.ts` (fixture gains `out_of_bounds: 'clip'`)
- Comment-only, committed separately: `api/_lib/takeit-bundle-loader.ts`, `api/_lib/takeit-detect.ts`, `ml/src/takeit/export_model.py`

## Deploy

These change the live scoring path used every minute by `detect-lottery-fires` and `detect-silent-boom`. Hold the push until after the 15:00 CT close unless the owner says otherwise.

On 2026-10-26, a read-only query of production `takeit_model_version` confirmed that every scored fire used bundle v2026-05-16: 952,500 lottery rows (plus 1,244 rows labelled `+backfill-strict-v1` on the same bundle) and 27,580 silent-boom rows. No other version appears. That is the bundle the parity, real-bundle and bit-identity checks ran against, so they apply to production as-is.

## Open questions

- **Removing the `x1 === x0` guard after E.** Default: keep it with a comment. It costs nothing and protects against a future change to the search.
- **An absent `out_of_bounds` under B.** Decided: rejected like `'nan'`. sklearn's `IsotonicRegression` defaults to `'nan'`, so a missing field is not a known clip, and `export_model.py` has written the field since the first export.
