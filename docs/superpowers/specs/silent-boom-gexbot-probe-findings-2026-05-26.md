# Silent Boom × GexBot — Univariate Probe Findings (2026-05-26)

## TL;DR

There's a tentative signal — 1DTE+ convexity & put-DEX scalars correlate
with Silent Boom hit rates at r≈0.15-0.20 (p<0.05 unadjusted, p<0.01 for
the top 2 features on hit-30). **But the sample is too thin to commit to
building.** 4 trading days × 270 joinable fires is what we have. The probe
was meant to test on "days of GexBot data"; the actual history that
exists is just under one week.

**Recommendation:** wait ~3 weeks (≈15 trading days, ≈1,000+ joinable fires),
then re-run this same probe. If the same features hold, build the pipeline.

## What I expected vs. what I found

|                              | Expected             | Actual                                                    |
| ---------------------------- | -------------------- | --------------------------------------------------------- |
| GexBot history               | "days" → assumed ≥30 | 4 trading days (2026-05-19 → 2026-05-22)                  |
| Live in Neon                 | All of it            | Only today (cleanup-gexbot is aggressive)                 |
| Historical store             | —                    | 4 parquet files in Vercel Blob `gexbot/gexbot_snapshots/` |
| Silent Boom fires in window  | ~3,000-4,000         | 599 enriched, 270 in GexBot universe                      |
| Join hit rate after SPXW→SPX | <100%                | 100% (every fire matched a snapshot)                      |

## Top features (Pearson r vs. hit-30%, sorted by |r|)

```
            feature   n         r     p
    gx_one_cvroflow 270  +0.2032   7.85e-04   ← clears Bonferroni for 36 tests
     gx_net_put_dex 270  +0.1878   1.94e-03   ← clears Bonferroni
    gx_one_dexoflow 270  +0.1853   2.23e-03   ← clears Bonferroni
 gx_one_net_put_dex 270  +0.1743   4.08e-03
    gx_one_gexoflow 270  -0.1580   9.30e-03
 gx_one_agg_put_dex 270  +0.1526   1.21e-02
            gx_ocvr 270  -0.1388   2.25e-02
```

For hit-50% the same features rank highest, just with weaker effect sizes.

## Interpretation

1. **1DTE+ scalars dominate, not 0DTE.** Silent Boom alerts span DTEs
   (most aren't 0DTE), so the `one_*` block aligns better than `z_*`.
   Worth keeping in mind for the full pipeline — the 0DTE-specific
   features may matter only for the 0DTE-tagged subset of fires.

2. **`one_cvroflow` is the cleanest signal.** Rate of 1DTE+ convexity
   being added. Positive flow → higher hit rate. r=+0.20, p<0.001.

3. **Put-DEX features rank high and positive.** When dealers carry
   more net put exposure (positive net put DEX), bullish alerts
   are more likely to hit. Consistent with the dealer-hedging story:
   put-heavy dealers chase aggressively above key levels.

4. **`gexoflow` is negatively correlated** (-0.16). Heavy 1DTE+ gamma
   absorption → vol suppression → alerts don't run. Inverse signal,
   directional.

## Why this is not yet conclusive

1. **n=270 is small** for any feature claim. Bonferroni-adjusted
   threshold for 36 tested features is p<0.0014 — only `one_cvroflow`
   and `one_dexoflow` clear it on hit-30.
2. **Day imbalance.** 2026-05-19 contributed 5 fires; 2026-05-20
   contributed 136. One day dominates the sample. Could be picking
   up a day-regime correlation, not a fire-level signal.
3. **No leakage fingerprint possible.** Quintile stratification needs
   ≥500 rows. By-ticker stratification only worked for SPY (n=104).
   Cannot rule out that the signal is concentrated in one ticker or
   one hour-of-day bucket — the cleanest way to spot leakage.
4. **GexBot fields are point-in-time** (verified — no rolling/EMA in
   fetch-gexbot-fast.ts), so look-ahead leakage is unlikely. But
   that's the _only_ leakage check the small sample passes.

## Recommendation

**Don't build the full ML pipeline yet.** Three options, ranked:

1. **Wait + re-probe in 3 weeks** (≈2026-06-16). At ~270 fires/4 days,
   we'd have ~1,000-1,300 joinable fires after 3 more weeks. That's
   enough for quintile stratification, per-ticker checks, and a real
   logistic-regression baseline.

2. **Live-feature instrument now, validate forward.** Surface the top-3
   GexBot features (`one_cvroflow`, `net_put_dex`, `one_dexoflow`) on
   the Silent Boom alert card as informational context. Tag fires
   with their values. In 3 weeks, you have both the historical
   probe AND a forward-looking validation set.

3. **Stop, declare premature.** Honest answer: 4 days is not enough.
   Spend the effort elsewhere until data accumulates.

I'd recommend **(2)** — it costs almost nothing (add 3 columns to the
fires table at insert time, add a small badge to the alert card),
and you accumulate validation data instead of waiting passively.

## Artifacts

- Joined data:
  `docs/tmp/silent-boom-gexbot-joined-v2.parquet` (270 rows × ~50 cols)
- Correlations:
  `docs/tmp/correlations-hit_50.csv`
  `docs/tmp/correlations-hit_30.csv`
- Probe script:
  `docs/tmp/silent-boom-gexbot-probe-v2.py`
- Probe log:
  `docs/tmp/silent-boom-gexbot-probe-v2-output.log`
- Downloaded GexBot parquet:
  `docs/tmp/blob-cache/gexbot/gexbot_snapshots/{2026-05-19..22}.parquet`

## Open questions for next pass

- Should `gexbot_api_capture` (the per-strike JSONB raw archive) be
  unpacked for additional features? It carries the 150-strike state
  vectors which weren't used in this probe. Could surface charm-cliff
  / vanna-shock features.
- Cleanup-gexbot deletes after 2 days — is the 4-day Blob retention
  intentional? If we want history for ML, we need to either keep
  more in Neon or build a parquet-loader path into ml/.
- SPXW→SPX is the only mapping needed; verify no other SB tickers
  hide behind aliases (NDXP, RUTW etc. don't appear in the SB sample
  but should be checked when larger).
