---
status: Likely Shipped
date: 2026-05-16
---

# Deferred — Non-0DTE Surface Detectors

**Status:** Deferred 2026-05-16. User trades 0DTE only; these detectors carry edge primarily at 7-60 DTE and were dropped from active scope.
**Revisit when:** User expands trading horizon beyond 0DTE, or the Lottery / Silent Boom universe begins consistently surfacing actionable multi-week single-name positioning.

These specs are preserved so the original reasoning, data requirements, and implementation paths are recoverable without re-litigating the design from scratch.

---

## 1. Synthetic Basis / Put-Call Parity Break

### What it catches

Hard-to-borrow conditions, M&A target speculation, special dividend speculation, short-squeeze setups — conditions where the synthetic forward implied by options diverges from cash forward by more than borrow cost can explain.

The signal is strongest around **pre-announcement M&A leaks**: acquirers' prime brokers source target inventory weeks before public news, tightening borrow on the target, which breaks reverse-conversion arb. The basis widens before the print.

### Why not 0DTE

- Bid/ask spread on each leg eats the signal entirely on 0DTE (call − put + strike noise > actual basis divergence).
- Carry / borrow over one trading day is too small to register.
- Signal needs time premium to be measurable.

### Target DTE range

14-60 DTE, with M&A leak detection living in the 21-45 DTE band.

### Detector logic

For ATM strike on each name:

```
synthetic_forward = call_mid - put_mid + strike
cash_forward     = spot * exp((r - q) * T)
basis_bps        = (synthetic_forward / cash_forward - 1) * 10_000 / T_years
```

- Compute per-name rolling 30-day baseline + stdev of `basis_bps`.
- Alert when `|basis_bps - baseline| > N * stdev` (start with N=2.5).
- Critical: subtract known dividend yield. False positives explode if dividends are ignored on dividend-paying names around ex-div dates.

### Data needed

| Input              | Source                       | Have it? |
| ------------------ | ---------------------------- | -------- |
| Per-strike bid/ask | UW chain snapshots           | Yes      |
| Spot               | UW or sidecar                | Yes      |
| Risk-free curve    | FRED daily Treasury curve    | No — new |
| Dividend yield     | UW or external dividend feed | No — new |

The dividend feed is the gating dependency. Without it, this detector is unusable.

### Implementation cost

- Computation: low (pure transformation on existing chain data).
- New ingestion: 1 daily feed (Treasury curve) + 1 ongoing feed (dividend yield).
- Storage: 1 new table (`synthetic_basis_snapshots`) keyed by (ticker, date, dte_bucket).
- Live cron: 1 new entry, hourly cadence is sufficient (this isn't a sub-minute signal).

### Edge cases to handle on revisit

- Ex-div days: zero out the basis signal for ±2 days around ex-div.
- Earnings: the basis can widen mechanically due to event vol pricing; condition the alert on "no earnings within DTE window."
- ETFs vs single names: basket arb keeps ETF basis tight; only fire on single names.

### Validation approach

- 90-day historical parquet replay.
- Cross-reference top 20 basis-widening events against known M&A announcement dates (use 13D/13G filings as proxy if true M&A leaks aren't labeled).
- Target: at least 30% of alerts precede an announcement within 30 days. Below that the false-positive rate is too high for actionable trading.

---

## 2. Term Structure Inversion

### What it catches

Front-month IV > next-month IV without a known scheduled event — typically a leaked catalyst (pending M&A, FDA decision, court ruling, regulatory action) that the market is pricing in but no public news has surfaced.

### Why not 0DTE

Term structure requires at least two expiries by definition. The detector compares front vs next month; you cannot construct a "term structure" with one expiry.

### Target DTE range

- Front: 7-14 DTE (skip last few days of expiry — annualized IV gets noisy around weekend/holiday effects)
- Next: 30-45 DTE (the next monthly cycle)

### Detector logic

For each name:

```
front_iv  = ATM_IV(front_monthly_expiry)
next_iv   = ATM_IV(next_monthly_expiry)
ratio     = front_iv / next_iv
```

- Normal regime: ratio < 1 (contango — natural state).
- Alert when ratio crosses 1.0 _and_ there is no known event in the front-month window.
- The "known event" filter is the entire signal — without it, the detector fires constantly around earnings and is useless.

### Data needed

| Input                     | Source                                      | Have it?                |
| ------------------------- | ------------------------------------------- | ----------------------- |
| Per-expiry ATM IV         | UW chain snapshots                          | Yes                     |
| Earnings calendar         | UW or external (Earnings Whispers, Zacks)   | Partial — earnings only |
| FDA calendar              | FDA + biotech-specific aggregators          | No — new                |
| Macro event calendar      | FOMC, CPI, NFP (known well in advance)      | Partial                 |
| Court / regulatory events | No clean source; manual or news aggregation | No                      |

The catalyst calendar is the gating dependency. Without comprehensive event filtering, this detector has too high a false-positive rate to be useful.

### Implementation cost

- Computation: trivial.
- Catalyst calendar build: medium-to-high. The earnings calendar exists; FDA + court / regulatory require new feeds and are noisy.
- A "narrow scope" variant (single-name biotech only, FDA-calendar-only) is much cheaper to build and historically the highest-edge subset.

### Edge cases to handle on revisit

- Ex-div day mechanics distort front-month IV.
- Roll periods: when the front month becomes 0DTE, "next" should advance one cycle.
- ETFs with quarterly reconstitution.
- Bake in a "minimum DTE for front" floor — < 7 DTE is too noisy.

### Validation approach

- 90-day historical parquet replay.
- Cross-reference top inversion events against subsequent news (M&A, FDA approval / denial, earnings surprise, settlement).
- Target: 40% precision on inversions converting to a price-moving catalyst within 14 days. Below 40% the noise eats the signal.

---

## 3. Skew Shock at 25Δ

### What it catches (at 7-30 DTE)

Institutional tail-risk buying that splits across many small clips to evade flow-based detectors. SoftBank-style 2020 single-name accumulation patterns. The signal: cumulative pressure repricing the surface even though no individual print qualifies as a Lottery or Silent Boom event.

### Why deferred — not viable at 0DTE

The 0DTE version of this detector is **not the same signal at a different DTE** — it's a fundamentally different signal with different actionability:

- 0DTE "25Δ" strikes are only 0.5-2% OTM (vs 5-10% at 30 DTE). The skew z-score at 0DTE measures a tiny price range dominated by **dealer hedging pressure**, not tail-risk repricing.
- 0DTE skew shifts mostly reflect: dealers being flushed out of puts as price drops, momentum traders piling into 0DTE calls, charm-driven afternoon reflexivity.
- That information is **already in the GEX maps and Periscope tile** for SPX (MM-attributed gamma per strike is the same dealer-stress signal at higher resolution).
- For single-name 0DTE (NVDA, TSLA, AAPL, etc.) there is some additional signal — Periscope coverage doesn't extend there — but the unique edge is thin relative to dev cost.

The unique value of skew shock — catching institutional tail-risk accumulation that flow detectors structurally miss — only exists at 7-30 DTE. At 0DTE the detector measures dealer-hedge-stress, which the user's existing GEX/Periscope stack already covers.

### Target DTE range (when revived)

7-30 DTE per name. Skip 0-7 DTE for the reasons above.

### Detector logic (sketched)

- Per name, every 5 min, interpolate 25Δ put IV and 25Δ call IV from chain snapshots.
- `skew = put_iv_25d - call_iv_25d`
- Rolling 30-day per-name z-score.
- Alert when `|z| > 2.5` within 15-minute window.

### Data needed

UW chain snapshots provide everything. **No new feeds required** — this is the cheapest of the three deferred detectors to build.

### Why this is the easiest revival

If the user expands to 7-30 DTE single-name positioning, skew shock should be revived **first** because:

1. No new data feeds required.
2. Cleanest signal of the three (no dependency on dividend yield or catalyst calendar accuracy).
3. Catches a structurally invisible flow pattern that Lottery and Silent Boom cannot see by design.

---

## Notes for Revival

If reviving any of these:

1. Re-validate the target DTE range against current market structure (the 0DTE share of total volume keeps growing; the optimal DTE band for these detectors may shift).
2. Re-check data feeds — UW endpoint coverage and pricing changes; the dividend / catalyst feeds may have moved.
3. The multileg assembler (built as part of the active 2026-05-16 plan) should be wired in _first_ — without it, these surface detectors will fire on spread legs and mislabel positions.
4. Forced-flow penalty (also active plan) should be applied to these alerts the same way it's applied to Lottery and Silent Boom.

Original conversation context: turn from session 2026-05-16 (~7:50 PM CT) covering market-maker structural edge, Aug 2024 Japan VIX spike example, and the resulting 7-detector roadmap.
