# Silent Boom — H1 pre-trade-count + H3 adj-strike co-fire features

**Date:** 2026-05-17
**Author:** Charles + Claude
**Status:** Draft → user review → implement

## Goal

Add two new detector-side features to the Silent Boom alert pipeline,
both surfaced as columns on `silent_boom_alerts` AND wired into
`computeSilentBoomScore`. Both features are validated against the
93-day, 63,846-alert peak-ceiling dataset
(`docs/tmp/sb-93d-peak-revisit-2026-05-17.py`).

## Empirical basis

Baseline: peak_ceiling_pct ≥ 50% on 63,846 alerts → 16.2% hit rate.

### H1 — pre_trade_count

Trades on the same `option_chain_id` from session open (08:30 CT) until
the alert's `bucket_ct`. Strongest finding from the peak revisit:

| pre_trade_count | n      | peak ≥50% | lift (pp) |
| --------------- | ------ | --------- | --------- |
| 0 (dead silent) | 48,511 | 18.0%     | +1.8      |
| 1-5             | 3,088  | 3.2%      | -13.0     |
| 6-25            | 3,775  | 5.5%      | -10.7     |
| 26-100          | 3,433  | 9.6%      | -6.6      |
| 101-500         | 3,161  | 13.3%     | -2.9      |
| **501+**        | 1,878  | **28.2%** | **+12.0** |

**Cross-tab vs elapsed bucket** confirms the 501+ effect is independent
of TOD:

| Elapsed     | 0 silent | 501+  | Δ     |
| ----------- | -------- | ----- | ----- |
| 30-60 min   | 26.2%    | 42.9% | +16.7 |
| 60-120 min  | 22.7%    | 37.4% | +14.7 |
| 120-180 min | 18.3%    | 35.8% | +17.5 |
| 180-240 min | 16.8%    | 38.7% | +21.9 |
| 240-300 min | 12.7%    | 37.3% | +24.6 |
| 300-360 min | 7.7%     | 28.3% | +20.6 |
| 360+ min    | 2.0%     | 18.6% | +16.6 |

Heavy-prior-trading chains outperform dead-silent across every elapsed
bucket by 15–25pp — TOD does NOT explain this. Independent signal.

The mid buckets (1-25 trades) concentrate at 300+ min elapsed (where
they're already penalized by `LATE = -5` / `PM = -4`), so the negative
lift there is partially absorbed by TOD. We score conservatively to
avoid double-penalizing.

**Thesis re-frame:** SB v1's "quiet → boom" model was incomplete. The
data says **both** ends of the activity spectrum (dead silent OR
heavily-traded → boom) carry signal. Middling activity is the
dead zone.

### H3 — adj_cofire

Another SB alert exists on the same `(ticker, option_type, bucket_ct)`
at strike ± $1 (or ± $5 for SPX/NDX/RUT cash-index roots).

|              | n      | peak ≥50% | lift (pp) |
| ------------ | ------ | --------- | --------- |
| adj_cofire=F | 61,935 | 16.0%     | -0.2      |
| adj_cofire=T | 1,911  | **22.0%** | **+5.8**  |

Small cohort (3.0% of alerts) but clean binary signal. Intuition: a
real underlying move is more likely to trigger two adjacent strikes
simultaneously than ghost-print noise.

## Score adjustments

Both fit the existing `computeSilentBoomScore` additive framework. Net
score range expands from -25..+35 to -25..+41:

```
pre_trade_count score:
  0-500   →  0    (no adjustment)
  501+    → +4    (matches the +12pp lift, scaled like other weights)

adj_cofire score:
  false → 0
  true  → +2     (matches the +5.8pp lift)
```

**Tier thresholds** held at 21/8 (consistent with the 2026-05-17 TOD
retune). New max score: dte(10) + baseline(5) + ratio(5) + price(5)

- AM_open(6) + ask(2) + call(1) + Fri-CALL(1) + pre_trade(4) + cofire(2)
  = **+41**.

## Schema changes (migration #169)

```sql
ALTER TABLE silent_boom_alerts
  ADD COLUMN pre_trade_count INTEGER,
  ADD COLUMN adj_cofire BOOLEAN;

CREATE INDEX ... silent_boom_alerts_pre_trade_count_idx ON silent_boom_alerts (pre_trade_count) WHERE pre_trade_count IS NOT NULL;
```

Both columns NULL-able for backwards compat. The detector populates
both at fire time; historical rows stay NULL until a backfill.

## Implementation strategy

### pre_trade_count — live detector

The cron's existing window query is 35-min lookback; we need
session-open-to-now per fired chain. Options:

1. **Batch query at end of cron** (preferred): after detecting all
   fires, issue ONE query that counts non-canceled trades on each
   fired chain from the session-open boundary to each fire's
   `bucket_ct`. ~50 fires × 1 COUNT query = bearable.
2. Per-ticker session cache (similar to `tickerFlowCache`): on first
   fire for a chain in a cron run, fetch all session ticks for that
   chain and count up to bucket_ct. Same wire bytes, slightly more
   memory.

**Pick option 1** — simpler, no caching state. The query:

```sql
SELECT
  option_chain,
  bucket_ts,
  COUNT(*) FILTER (
    WHERE canceled = FALSE AND price > 0
      AND executed_at >= session_open_ts
      AND executed_at <  bucket_ts
  ) AS pre_trade_count
FROM ws_option_trades
WHERE option_chain = ANY(${firedChainIds})
  AND executed_at >= ${sessionOpenIso}
  AND executed_at <  ${maxBucketIso}
GROUP BY option_chain, bucket_ts
```

Session open is 08:30 CT (= 13:30 UTC during CDT, 14:30 UTC during
CST). Derive from `ctx.today` + a Chicago-aware helper.

### adj_cofire — intra-cron + cross-cron lookup

Two paths:

1. **Intra-cron** (most cases): after computing all fires in the
   current cron run, build a `Set<string>` of
   `${ticker}|${optionType}|${bucketTsIso}|${strike}` keys. For each
   fire, check whether the key at strike ± step exists in the set.
2. **Cross-cron** (edge case — fire at bucket boundary): also query
   `silent_boom_alerts` for matching `(ticker, option_type,
bucket_ct, strike±step)` rows inserted in the last 35 min.

For v1 ship intra-cron only — covers >95% of cases. Add cross-cron in a
follow-up if needed.

Strike step: `$5` for `{SPXW, SPX, NDXP, NDX, RUTW, RUT}`, `$1`
otherwise. Mirror the lookup in `sb-93d-peak-revisit-2026-05-17.py`.

## Files to create / modify

### Phase A — H1 pre_trade_count

| File                                            | Change                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `api/_lib/db-migrations.ts`                     | Migration #169 — add column + index                                                 |
| `api/__tests__/db.test.ts`                      | Migration mock + SQL call count                                                     |
| `api/_lib/silent-boom-score.ts`                 | Add `preTradeCount` to `SilentBoomScoreInput`; new `PRE_TRADE_COUNT_BONUS` constant |
| `api/__tests__/silent-boom-score.test.ts`       | Tests for the new bucket                                                            |
| `api/cron/detect-silent-boom.ts`                | Add session-open derivation, batch query, pass `preTradeCount` to score + INSERT    |
| `api/__tests__/detect-silent-boom.test.ts`      | Update positional indices for new column; add test for the 501+ path                |
| `scripts/backfill_silent_boom_from_parquet.py`  | Mirror score change; add `pre_trade_count` derivation from parquet                  |
| `scripts/backfill_silent_boom_from_fulltape.py` | Same                                                                                |
| `scripts/backfill_silent_boom_ask_demote.py`    | SELECT now includes `pre_trade_count`                                               |

### Phase B — H3 adj_cofire

| File                                            | Change                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `api/_lib/db-migrations.ts`                     | Migration #170 — add `adj_cofire` column                                                       |
| `api/__tests__/db.test.ts`                      | Migration mock + SQL call count                                                                |
| `api/_lib/silent-boom-score.ts`                 | Add `adjCofire` to score input; `ADJ_COFIRE_BONUS` constant                                    |
| `api/__tests__/silent-boom-score.test.ts`       | Tests                                                                                          |
| `api/cron/detect-silent-boom.ts`                | Build intra-cron co-fire set; pass `adjCofire` to score + INSERT                               |
| `api/__tests__/detect-silent-boom.test.ts`      | Update positional indices; add test that two adjacent fires set both rows' `adj_cofire = true` |
| `scripts/backfill_silent_boom_from_parquet.py`  | Mirror; build keyset per day, lookup                                                           |
| `scripts/backfill_silent_boom_from_fulltape.py` | Same                                                                                           |
| `scripts/backfill_silent_boom_ask_demote.py`    | SELECT includes `adj_cofire`                                                                   |

### Phase C — Re-run Pass B with peak metric

| File                                        | Change                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/tmp/sb-93d-pass-b-peak-2026-05-17.py` | New analysis — re-runs H2/4/5/6 (parquet-scan hypotheses) with `peak_ceiling_pct ≥ 50%` as win metric. Mechanical; will surface whether any of those hypotheses flip under the peak metric the way TOD/DOW did. |

Output drives whether any additional features land in Phase D.

### Phase D — Full SB score recalibration (LAST)

Refit all weights against the 64k dataset rather than surgical
patches. Two-step:

1. Run a feature-by-feature lift analysis on the full 64k cohort
   (similar to `silent_boom_feature_audit.py` but on `peak_ceiling_pct
≥ 50%`).
2. Update every weight in `silent-boom-score.ts` to match the new lifts
   and re-derive tier thresholds.

May result in:

- DTE buckets resized (28-day data now shows more 0DTE differentiation)
- baseline_volume / spike_ratio thresholds shifting
- price thresholds changing
- TOD weights stable (already retuned)
- DOW × type stable (already added)
- New features (pre_trade_count, adj_cofire) absorbed into the refit

## Open questions

- **pre_trade_count** at 501+ has n=1,878 — clean but small. Worth
  splitting further (501-2000, 2000+) for more granularity? Probably
  not in v1 — keep one bucket, revisit in Phase D.
- **Session-open boundary**: do we use 08:30 CT or first-trade-of-day?
  Pre-market chains can have ticks before 08:30. Pick 08:30 CT
  (matches the script that computed the empirical lifts).
- **adj_cofire**: should the score bonus stack with the existing
  `fire_count_score_adjustment` (which counts SAME-strike re-fires)?
  Yes — different signals (different strike vs same strike).
- **Cross-cron adj_cofire**: defer to follow-up unless the intra-cron
  miss rate proves material in production.

## Thresholds frozen

```
PRE_TRADE_COUNT_BONUS_501_PLUS = 4         # pre_trade_count >= 501
ADJ_COFIRE_BONUS               = 2         # any adj-strike co-fire
ADJ_COFIRE_INDEX_STEP          = 5.0       # for SPX/NDX/RUT roots
ADJ_COFIRE_DEFAULT_STEP        = 1.0       # everyone else
SESSION_OPEN_CT_MINUTE         = 510       # 08:30 CT
INDEX_COFIRE_ROOTS = {'SPXW','SPX','NDXP','NDX','RUTW','RUT'}
```

## Phase order

A → B → C → D, with full review-fix-commit-push after each. Phase D
gates on outputs from C. Each phase independently shippable.
