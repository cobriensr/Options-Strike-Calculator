# MOC Imbalance Research — Null Result & Derived VIX Rule

**Status:** Closed, negative result. Protective rule adopted.
**Date range studied:** 2018-05-01 → 2026-04-13 (1,991 trading days)
**Data cost:** ~$3 total (Databento historical, DBN format)
**Code:** `ml/src/moc_inspect.py`, `moc_features.py`, `moc_eda.py`, `moc_regime_vix.py`

---

## Question

Triggered by a 2026-04-13 session where a bracketed iron-fly ladder on SPX
was run over by a directional move immediately after the NYSE Closing
Auction Imbalance publication at 14:50 CT (15:50 ET).

**Hypothesis:** The MOC imbalance stream (size, direction, growth) is a
leading indicator of last-10-min price chaos, and a threshold rule on
imbalance could gate short-gamma exposure to avoid these blowups.

## Data

- Databento `imbalance` schema, dataset `XNAS.ITCH`, symbols SPY + QQQ,
  2018-05-01 → 2026-04-13 (1.8M messages, $3).
- Databento `ohlcv-1m`, same dataset/window, QQQ only (1.6M bars, $1).
- VIX daily close via yfinance (free).
- Total engineering time: ~3 hours end-to-end.

## Key data-provenance finding

NASDAQ `ind_match_price` and `upper/lower_collar` fields are **never
populated for ETFs** — this is a venue convention, not a data bug. The
usable clearing-price field is `cont_book_clr_price` (92% populated).
SPY imbalance on `XNAS.ITCH` is also ~0 for 75% of days because SPY's
_primary_ closing cross happens on NYSE Arca, not NASDAQ. QQQ NOII is the
only clean series in this dataset.

## Results — the null

Against **realized_mae_down_bps** (max adverse excursion, 15:50→16:00 ET):

| Feature                  | Pearson r | Spearman r |
| ------------------------ | --------- | ---------- |
| T50_signed_imbalance     | −0.143    | −0.162     |
| imbalance_delta_50_to_55 | +0.011    | +0.032     |
| T50_cont_drift_bps       | −0.209\*  | −0.152\*   |
| T50_paired_ratio         | 0.000     | −0.022     |
| side_flipped (boolean)   | +0.002    | +0.007     |

\* Only 19% of days have this populated; likely survivorship bias toward calm days.

**Directional prediction** (sign agreement between signed_imbalance and
realized_return): 53.2% — indistinguishable from coin flip.

**Decile binning**: median MAE across 10 |imbalance| deciles moves from
9.9 bps (smallest) to 12.6 bps (largest). 95th-pct MAE moves from 36 bps
to 44 bps. Real but small lift, far from actionable.

**Threshold rule evaluation**: at |imbalance| > 400K shares (fires on 7%
of days), the 95th-pct MAE lift vs baseline is +5 bps. Closing iron flies
10 minutes early costs more in foregone theta than this saves.

## The signal that IS real — VIX regime

Same target (realized MAE), pulled against daily VIX close:

```
Pearson  r(vix_close → mae_down_bps) = +0.560   R² = 0.31
Spearman r                            = +0.467
```

**VIX alone explains ~31% of MAE variance.** This is 7× stronger than
any imbalance feature tested.

Bucket breakdown:

| VIX regime       | n   | median MAE | p95 MAE | p99 MAE |
| ---------------- | --- | ---------- | ------- | ------- |
| Calm (<15)       | 505 | 7.6        | 20      | 30      |
| Normal (15–20)   | 726 | 9.6        | 28      | 41      |
| Elevated (20–30) | 598 | 15.4       | 45      | 69      |
| Stress (>30)     | 151 | 25.2       | 80      | **192** |

- Median MAE scales 3.3× Calm → Stress.
- 99th-pct MAE scales **6.4×** (30 bps → 192 bps).
- Relationship is monotonic across all four buckets.

**Imbalance conditional on VIX regime is still null.** The |imbalance| vs
MAE Pearson r in the Stress bucket is +0.041 — essentially zero. The
conditional hypothesis ("imbalance only matters when vol is elevated")
is also rejected.

## Adopted rule

```
VIX close      Short-gamma 0DTE rule
─────────────  ──────────────────────────────────────────────
< 15           Safe to hold iron flies / short straddles to
               the close. p95 MAE = 20 bps.
15–20          Hold with moderate size. p95 MAE = 28 bps.
20–30          Flat short-gamma by 14:45 CT. p95 MAE = 45 bps,
               p99 = 69 bps. Iron fly ladders get overrun here.
> 30           Do NOT hold short-gamma into the close window.
               Flat by 14:30 CT. p99 MAE = 192 bps — one day in
               100 loses you a month of theta.
```

## What I won't do (explicit negative decisions)

- **Not pulling SPY ARCX.PILLAR imbalance.** QQQ null was comprehensive;
  SPY would almost certainly show the same pattern because the flow
  dynamics (index-arb dominance in the last 10 min) are structurally
  identical for both ETFs. $1.50 + 2–3 hours of pipeline adaptation for
  marginal certainty isn't a good trade.
- **Not subscribing to the Databento live feed ($199/mo).** The live
  feed would only be useful if we had a working real-time rule; we
  don't.
- **Not rebuilding any of this for SPX constituent aggregation.** If
  broad-market ETFs don't carry the signal, a weighted constituent
  aggregate won't either.

## Files

- `ml/src/moc_inspect.py` — decode DBN, validate schema, cache parquet.
- `ml/src/moc_features.py` — per-day features (snapshots at 15:50 + 15:55,
  targets MAE/MFE/return from 1-min bars).
- `ml/src/moc_eda.py` — 8 plots + correlation matrices.
- `ml/src/moc_regime_vix.py` — VIX regime split + conditional correlations.
- `ml/plots/moc/*.png` — 11 plots, tracked in git.
- `ml/data/*.parquet` — cached data, gitignored.

## Takeaway

The valuable thing this research produced wasn't the hypothesis
validation we were looking for — it was an empirical elimination of a
plausible-sounding idea, plus the discovery that a variable we already
have (VIX) is 7× stronger as a protective signal. Net cost: $3 of data,
one afternoon. Net benefit: one less expensive plumbing project, plus a
concrete gating rule backed by 8 years of evidence.
