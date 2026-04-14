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

```text
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

```text
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
- `ml/src/moc_vol_premium.py` — Tier 0 long-vol mirror analysis.
- `ml/plots/moc/*.png` — 14 plots, tracked in git.
- `ml/data/*.parquet` — cached data, gitignored.

## Phase 4 (Tier 0): Long-vol mirror — also null-ish

After the short-gamma thread closed, we ran the symmetric question: "is
there a retail edge in BUYING vol into MOC?" The idea was that if
MAE/range distributions blow out in elevated-VIX regimes, maybe options
systematically underprice that tail.

Method: computed realized 10-min |return| vs VIX-implied 10-min sigma
(`VIX * sqrt(10 / (252 * 390))`) and simulated a naive "buy ATM straddle
at 15:50, hold to close" strategy. Straddle cost approximated via the
Black-Scholes ATM formula (`sqrt(2/π) * sigma * S`).

| VIX regime | n   | mean P&L     | median P&L   | win rate | Sharpe/trade |
| ---------- | --- | ------------ | ------------ | -------- | ------------ |
| Calm       | 510 | −2.5 bps     | −4.5 bps     | 27%      | −0.33        |
| Normal     | 728 | −3.4 bps     | −5.5 bps     | 25%      | −0.38        |
| Elevated   | 601 | −2.8 bps     | −6.3 bps     | 33%      | −0.20        |
| **Stress** | 152 | **+4.1 bps** | **−5.6 bps** | **37%**  | **+0.10**    |

The ratio (realized / implied) rises monotonically with VIX regime (0.45
in Calm → 0.64 in Stress), directionally consistent with "options
underprice tail regimes." But at the median, options are _always_
overpriced (ratio < 1), and the long-straddle P&L is only positive in
Stress because of a handful of +200 bps outliers. Median is still
−5.6 bps in Stress; win rate is 37%.

**Known overstatements in Tier 0** (all push the Stress edge further
toward zero, not away from it):

- VIX is 30-day constant-maturity, not 0DTE 10-min. Real 0DTE implieds
  in Stress regimes typically spike 10–30% _above_ VIX due to inverted
  term structure — meaning the true straddle cost is higher than I
  modeled, and the true edge is smaller.
- Bid-ask on QQQ 0DTE options is ~1–2 bps round-trip, eating ~half the
  apparent edge.
- No slippage modeled.
- Best-day outlier of +240 bps dominates the mean — removing it drops
  Stress mean to ~+2.5 bps.

**Conclusion on long-vol mirror:** technically +EV in Stress regime on
the surface, but the quality of the edge (negative median, 37% win rate,
fat-tail dependence, Sharpe ~0.1) is classic "tail of tail" that works
on paper and fails in practice for retail. Closing without Tier 1
options data.

The asymmetry worth noting: **avoiding the bad outcome on the short
side is cheap (just gate on VIX); capturing the symmetric opportunity
on the long side is not.** Market makers and HFT capture the long side;
retail gets the short-side protection.

## Phase 5: Does dealer gamma augment the VIX gate? — null

One more plausible angle closed out. Pulled a $10 UW export of 1 year
of SPX daily aggregated dealer gamma (2025-04-15 → 2026-04-14: 250
days × `call_gex`, `put_gex`, `net_gex`, `put_call_gex_ratio`), asking:

> Does net dealer gamma predict SPX daily range BEYOND what VIX already
> captures? If yes, the VIX-only banner becomes a two-variable gate.

Caveat on the data: UW confirmed it's end-of-day only, so GEX is lagged
by one trading day before joining to make correlations tradeable (same-
day GEX and same-day range are contaminated — EOD snapshots partially
reflect the day's own move).

**Results on 249 lagged days:**

```text
R^2(VIX only)                = 0.4425
R^2(VIX + net_gex + |gex|)   = 0.4480
Incremental R^2 from GEX     = +0.0055
```

VIX alone explains ~44% of SPX daily-range variance. Adding GEX adds
half a percentage point. Below the +0.02 threshold we'd want to justify
a two-variable gate in production.

Median SPX daily range by (VIX regime × gamma sign), lagged:

| VIX bucket | gamma sign  | n   | median range | p95 range |
| ---------- | ----------- | --- | ------------ | --------- |
| Calm       | long_gamma  | 21  | 51 bps       | 102       |
| Calm       | short_gamma | 4   | 79 bps       | 139       |
| Normal     | long_gamma  | 128 | 73 bps       | 142       |
| Normal     | short_gamma | 24  | 92 bps       | 171       |
| Elevated   | long_gamma  | 17  | 119 bps      | 234       |
| Elevated   | short_gamma | 50  | 131 bps      | 244       |
| Stress     | short_gamma | 5   | 196 bps      | 270       |

Short-gamma days have higher range within each VIX bucket
(monotonically, unlike the same-day analysis), but the split is
~10–25% wider — real but small. VIX already captures most of it.

**What's NOT in this data** (confirmed by UW): strike-level intraday
GEX. Only daily aggregated scalars. So the original "pin-riding via
GEX-predicted strike" hypothesis cannot be tested with a historical
data pull from UW. Only path to that test is accumulating snapshots
via the existing cron for 6–12 months, or sourcing raw OI data from
a different vendor.

**Decision:** keep the VIX-only banner. GEX doesn't clear the bar for a
two-variable production gate on ~250 days of data. Revisit if 1+ years
of accumulated snapshot data becomes available.

## Phase 6: MOO (Market-on-Open) persistence — also null

Prompted by a UW community member reporting success "sniping SPX after
MOC numbers are released" and asking whether opening-cross imbalance
might be the real setup signal we were missing.

Method: filter the imbalance cache to `auction_type == 'O'` (opening
cross messages, 9:25–9:29 ET), snapshot each day at 9:29:30, compute
intraday targets from QQQ 1-min bars, correlate.

Results on 1,998 days:

| Test                                | Result |
| ----------------------------------- | ------ |
| MOO sign → day return agreement     | 51.7%  |
| MOO sign → 10am return agreement    | 50.2%  |
| MOO sign → MOC sign agreement       | 53.9%  |
| Pearson r(MOO, return_day)          | −0.014 |
| Pearson r(\|MOO\|, intraday range)  | +0.143 |
| Incremental R^2 over VIX (range)    | +0.008 |

Direction: coin flip. Persistence to MOC: effectively zero. Only real
signal is `|MOO| -> |range|` (r=+0.14) — same magnitude-implies-vol
pattern we already see in MOC, and already captured by VIX.

Also notable: 70% of QQQ days have essentially zero MOO imbalance at
the 9:29:30 snapshot — the book pairs down as the cross approaches the
open. So there's nothing to trade on 7 days out of 10 anyway.

## Phase 7: 0DTE directional options simulation — null

The community member trades 0DTE SPX options, and a weak signal on
underlying can become +EV through long-option convexity. Simulated:

- **A. MOC-directional**: at 15:50 ET, long ATM call if MOC signed
  imbalance > 0 else put; hold to close (10-min window).
- **B. MOC-random**: same window, random direction (control).
- **C. MOO-directional**: at 9:30 ET, same rules, 6.5h window.
- **D. MOO-random**: MOO window, random direction (control).

Pricing via Black-Scholes ATM (`~0.399 * sigma * S * sqrt(T)`) using
VIX as IV. Payoff = intrinsic at close (0DTE cash-settled).

| Strategy         | n    | mean P&L | win rate | edge vs random |
| ---------------- | ---- | -------- | -------- | -------------- |
| MOC_directional  | 1603 | −0.55    | 33%      | +0.53 (t≈1.58) |
| MOC_random       | 1980 | −1.08    | 30%      | —              |
| MOO_directional  | 678  | −6.61    | 33%      | +0.66 (t≈0.21) |
| MOO_random       | 1980 | −7.27    | 31%      | —              |

**Both directional edges are tiny and not statistically significant**
(t < 2), and both strategies are negative-EV in absolute terms because
ATM 0DTE options bleed theta faster than the weak directional signal
can compensate. After 1–2 bps SPX 0DTE round-trip friction, the edge
is decisively negative.

**Convexity does not rescue the signal.** If a retail trader is making
money "sniping MOC" they are likely doing something the mechanical
test can't capture: selective entry (10–20% of days), non-mechanical
exits, OTM lottery-ticket structures with different risk/reward, or
confirmation from price action after the imbalance prints. Survivorship
bias in self-reported P&L is also always on the table.

**Final decision:** seven phases across five hours and ~$14 of data
produced one shipped rule (VIX banner) and six clean null results. The
asymmetry is durable: **avoiding the blowup (defensive) is cheap and
effective; capturing symmetric profit (offensive) requires tools and
positioning that retail structurally doesn't have.** Thread fully
closed.

## Takeaway

The valuable thing this research produced wasn't the hypothesis
validation we were looking for — it was an empirical elimination of a
plausible-sounding idea, plus the discovery that a variable we already
have (VIX) is 7× stronger as a protective signal. Net cost: $3 of data,
one afternoon. Net benefit: one less expensive plumbing project, plus a
concrete gating rule backed by 8 years of evidence.
