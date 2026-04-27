# TRACE Live ML Pipeline — Outcomes, Analogs, Calibration, Drift

**Status:** in progress
**Started:** 2026-04-27
**Owner:** charlesobrien

## Goal

Turn the ~10K-rows-per-year stream from `trace_live_analyses` into actionable trading intelligence:

1. Pair every captured analysis with the realized SPX outcome (close + intraday path) so we can measure model accuracy.
2. Surface "historical analogs" (top-K embedding neighbors + their outcomes) in the dashboard so the trader sees a real outcome distribution next to each model prediction.
3. Build a nightly calibration dashboard (regime × confidence × stability tertile → hit rate) so we know whether the model's confidence labels are honest.
4. Compute a per-capture novelty score (distance to k-NN) so the dashboard can flag "we've never seen this before, the model's calibration won't apply."

## Phases

### Phase 1 — Outcomes join (foundation; everything depends on it)

**What:** Augment `trace_live_analyses` rows with `actual_close` (next 4 PM ET cash close) and `actual_path` (1-min SPX prices from capture-time → close, as JSONB array).

**Files to create/modify:**

- `api/_lib/db-migrations.ts` — Migration #90: add `actual_close NUMERIC(10,2)` and `actual_path JSONB` columns to `trace_live_analyses`
- `api/cron/fetch-outcomes.ts` — after the existing `outcomes` upsert, ALSO update `trace_live_analyses` rows for that date by joining `spx_candles_1m` (path) and `outcomes.settlement` (close)
- `api/__tests__/db.test.ts` — add migration #90 to the applied-migrations list and SQL call count
- `api/__tests__/fetch-outcomes.test.ts` — extend with mock for the trace_live_analyses update sequence

**Why this first:** Phase 2's analogs panel and Phase 3's calibration are both useless without realized outcomes. Phase 4's drift score doesn't need outcomes but is trivial enough that it stacks at the end.

### Phase 2 — Historical Analogs UI panel

**What:** New endpoint `/api/trace-live-analogs?id=N&k=10` returns the top-K nearest-neighbor captures (by embedding cosine distance) AND their realized outcomes. New collapsible panel in the dashboard renders the analogs as a table: capture time, distance, headline, predicted close, actual close, error.

**Files to create/modify:**

- `api/trace-live-analogs.ts` — NEW: HNSW cosine query + outcomes join
- `src/main.tsx` — add `/api/trace-live-analogs` to BotID `protect` array
- `src/components/TRACELive/TRACELiveAnalogsPanel.tsx` — NEW: collapsible UI
- `src/components/TRACELive/index.tsx` — render the new panel below synthesis
- `src/components/TRACELive/types.ts` — add `TraceLiveAnalog` interface
- `api/__tests__/trace-live-analogs.test.ts` — NEW

**Pattern:** mirror `api/_lib/embeddings.ts:225-268` (`findSimilarAnalyses`) — same `<=>` HNSW operator, same exclude-self logic, but joining on the new `actual_close` column instead of the legacy `outcomes` table.

### Phase 3 — Calibration dashboard (ml/ pipeline addition)

**What:** Nightly Python script reads `trace_live_analyses` joined with outcomes, buckets by `regime × confidence × stability_tertile`, computes hit rate (% of predictions within ±$X of actual_close at multiple thresholds), writes plots to `ml/plots/calibration-*.png` and a structured summary to `ml/findings.json`.

**Files to create/modify:**

- `ml/src/calibration.py` — NEW: load + bucket + plot
- `ml/Makefile` — add `calibration` target
- `.github/workflows/ml-pipeline.yml` — invoke `make calibration` in the pipeline run
- `ml/requirements.txt` — already has pandas/matplotlib/psycopg2; verify
- `ml/tests/test_calibration.py` — NEW: smoke test for bucketing logic

**Outputs:**

- `ml/plots/calibration-by-regime.png` — accuracy distribution per regime
- `ml/plots/calibration-by-confidence.png` — accuracy distribution per confidence tier
- `ml/plots/calibration-stability-tertile.png` — accuracy distribution by stability bucket
- `ml/plots/calibration-curve.png` — actual hit rate vs claimed confidence

### Phase 4 — Drift/novelty score

**What:** For each new capture, compute the distance to the k-th nearest neighbor. Persist as `novelty_score` column. Frontend surfaces a flag when `novelty_score > p95` of historical scores.

**Files to create/modify:**

- `api/_lib/db-migrations.ts` — Migration #91: add `novelty_score NUMERIC(8,6)` to `trace_live_analyses`
- `api/_lib/trace-live-db.ts` — `saveTraceLiveAnalysis` computes novelty before insert
- `api/__tests__/db.test.ts` — add migration #91
- `src/components/TRACELive/TRACELiveHeader.tsx` — render novelty flag when score > threshold

## Open questions

- For `actual_path`: store every 1-min sample (~390 entries) or downsample to 5-min (~78)? Default: 5-min to keep JSONB compact.
- For analogs UI: how many top-K to show by default? Default: 10.
- For calibration: what error threshold counts as "hit"? Default: emit curves at ±$5, ±$10, ±$15 so all three are visible.
- For drift: what's the threshold for the UI flag? Default: 95th percentile of historical novelty scores (computed nightly, written to a config table or constant).

## Build sequence

1. **Phase 1 first**, in isolation. Migration + cron update + tests. Verify a row gets populated by manually running `fetch-outcomes` against today's data after market close.
2. **Phases 2 + 3 can run in parallel** once Phase 1 ships — they depend on Phase 1's `actual_close` column but not on each other.
3. **Phase 4 last** — small, low-risk, builds on the embedding-querying pattern from Phase 2.

## Done when

- [ ] Phase 1: A row in `trace_live_analyses` for any past date has non-null `actual_close` and `actual_path`.
- [ ] Phase 2: Dashboard shows a "Historical Analogs" panel with top-K rows + their outcomes for the active capture.
- [ ] Phase 3: `ml/plots/calibration-*.png` populated; nightly GH Actions run produces fresh plots.
- [ ] Phase 4: Dashboard renders a "novel setup" flag when novelty_score exceeds threshold.
- [ ] Deep code review across all four phases before any commits.
