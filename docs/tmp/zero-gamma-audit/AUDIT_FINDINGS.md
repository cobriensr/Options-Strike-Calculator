# Zero-Gamma Logic Audit — 2026-05-03

**Spec prerequisite:** docs/superpowers/specs/strike-battle-map-2026-05-03.md → "Prerequisite — review zero-gamma logic before Phase 2"

**Scope:** Verify `/api/zero-gamma` (computed by `compute-zero-gamma` cron, served by `api/zero-gamma.ts`) is correct enough to underpin the Dealer Regime tile classifier in Phase 2.

**Verdict:** ⚠ **Block Phase 2 until two HIGH concerns are resolved.** Architecture is sound; the math has a known limitation (kernel smoothing instead of full re-pricing), but a sign-convention question must be answered before the Dealer Regime classifier can read the level safely.

## What was reviewed

- `api/_lib/zero-gamma.ts` — pure calculator (`computeZeroGammaLevel`)
- `api/cron/compute-zero-gamma.ts` — cron driver (5-min cadence)
- `api/zero-gamma.ts` — read endpoint
- `api/_lib/zero-gamma-tickers.ts` — per-ticker expiry policy
- `zero_gamma_levels` table contents (recent live data)
- `strike_exposures` table contents (input data)

## Architecture — what's right

- Clean separation: pure calculator (no DB / I/O) + cron driver (reads `strike_exposures`, writes `zero_gamma_levels`) + read endpoint with Zod validation.
- Per-ticker expiry policy in one place (`zero-gamma-tickers.ts`) so ingest and compute can't drift.
- Per-ticker error containment in the cron — one ticker failing doesn't block the others.
- Owner-or-guest auth tier on the read endpoint, matching sibling Greek-exposure endpoints.
- Confidence is computed and stored alongside the level; consumers can gate or dim low-confidence reads.

## Methodology — what's potentially right

The calculator builds a candidate spot grid (±3% of spot, 30 samples), evaluates net gamma at each by summing per-strike gamma weighted by a triangular kernel `kernel(strike − candidate_spot)`, and locates the first sign change via linear interpolation between adjacent samples.

This is a heuristic, not a true re-pricing. The docstring acknowledges it: "This models 'what would dealer gamma be if spot sat at c?' without requiring a full re-pricing." The kernel weights strikes by their distance from the candidate spot, which approximates the fact that ATM strikes contribute most to net gamma — but the magnitude is not exact. **Sign-change LOCATION can be off by O(0.5%) of spot from a true Black-Scholes re-pricing.**

For a regime indicator (rather than a tradeable level), this approximation is acceptable.

## HIGH concerns — block Phase 2

### Concern 1 — Sign convention is unverified and likely directional, not dealer-side

The `strike_exposures` table population (from `fetch-strike-exposure.ts` cron) shows a striking pattern across recent live data:

| Ticker | call_gamma_oi positive | call_gamma_oi negative | put_gamma_oi positive | put_gamma_oi negative |
|---|---:|---:|---:|---:|
| SPX | 145 | **0** | **0** | 130 |
| SPY | 30 | **0** | **0** | 28 |
| QQQ | 29 | **0** | **0** | 26 |

`call_gamma_oi` is **always non-negative**. `put_gamma_oi` is **always non-positive**. Average magnitudes:

- SPX: call_avg = +666M, put_avg = −148M (calls 4.5× larger)
- SPY: call_avg = +171M, put_avg = −80M (calls 2.1× larger)
- QQQ: call_avg = +119M, put_avg = −8M (calls 15× larger)

The cron sums them as `gamma = call_gamma_oi + put_gamma_oi` (line 127–128 of compute-zero-gamma.ts) and treats the result as **dealer net gamma at strike**.

But:

- True dealer-perspective gamma should **flip signs** based on dealer position changes — sometimes dealers are short calls (negative dealer call gamma), sometimes long.
- In our data, calls are *always* positive and puts *always* negative, regardless of regime. That can't be a true dealer-perspective signed value.

The most likely interpretation: UW's convention is **call_gamma_oi = magnitude × +1, put_gamma_oi = magnitude × −1** as a directional/positional convention, not a dealer-perspective sign. Adding them gives a **directional-gamma indicator** ("positive when calls dominate") rather than **net dealer gamma** ("positive when dealers are long").

These two metrics flip sign at **different price levels**. Our "zero-gamma" might actually be a "directional-gamma flip," which is related but not identical to the SpotGamma TRACE zero-gamma.

**Required action:** verify the sign convention by either:

1. Reading UW's API documentation (or asking support) to confirm what `call_gamma_oi` and `put_gamma_oi` represent. Specifically: are they dealer-side signed, or magnitudes with a directional sign tag, or something else?
2. Or comparing the produced `gamma_curve` shape against the UW TRACE gamma heatmap on a known day. If the sign at spot doesn't match TRACE's blue/red read, the convention is wrong.

### Concern 2 — Net gamma at spot is consistently positive on every recent ticker

Sample of 20 most-recent rows (2026-05-01, ~5-min cadence):

| Ticker | spot | netγ@spot | zero_gamma | Δ from spot | confidence |
|---|---:|---:|---:|---:|---:|
| SPX | 7230 | **+12.4B** | (none in grid) | — | 0.00 |
| SPY | 720.6 | **+2.6B** | 705.66 | −2.07% | 0.01 |
| NDX | 27710 | +7.3M | 27269.94 | −1.59% | 0.03 |
| QQQ | 674.0 | **+2.0B** | 667.33 | −0.99% | 0.01 |

All net γ at spot are positive across all recent rows examined. If the values represented true dealer gamma, we'd expect to see this flip — sometimes dealers are net short gamma at spot (volatility regime), sometimes net long (pin regime). A persistently positive read suggests the methodology has a structural positive bias, consistent with Concern 1.

The zero-gamma level itself lands in a plausible 0.5–2.0% below-spot band, which matches typical SpotGamma TRACE values for SPY 0DTE on quiet sessions — so it's not obviously wrong, but the consistency could be coincidental.

**Required action:** plot 1–2 weeks of `netGammaAtSpot` per ticker. If it never flips negative, the interpretation is wrong even if the level looks right. The Dealer Regime classifier we want to build relies on the sign at spot flipping between regimes.

## MEDIUM concerns — fix before Phase 2 launch but not blockers for build

### Concern 3 — Confidence values are uniformly low

In recent data, confidence ranges from 0.00 to 0.13. The calculator computes:

```
confidence = |slope at crossing| ÷ (peak |netGamma| / dx)
```

The peak |netGamma| is dominated by a single near-the-money spike (e.g. SPY strike 720 alone has net γ = +2.49B; the strike 721 has +585M; everything else is ≤ 100M). The slope at the eventual crossing far from spot is shallow relative to that peak → confidence stays in the 0.0x range.

Practically: **most stored zero-gamma levels are low-confidence**. Consumers downstream (the Dealer Regime tile, etc.) should treat anything with `confidence < 0.10` as suspect.

**Required action:** in Phase 2's classifier, gate the "spot above/below zero-gamma" read on `confidence ≥ 0.10`. Below threshold, fall through to "uncertain regime" rather than picking a side.

### Concern 4 — No cross-validation against SpotGamma TRACE

The spec audit task called for: "Cross-check a few historical days against SpotGamma TRACE's published zero-gamma — they should agree within ~0.2–0.5% on most days."

This has not been done. We have no telemetry comparing our level to TRACE's level. Without it, the methodology could be wrong without anyone noticing.

**Required action:** one-off comparison study against 5–10 historical TRACE captures the user already has from past sessions. Compare our `zero_gamma_levels.zero_gamma` for those dates against the TRACE +γ/−γ junction visible in the screenshots. Document mean deviation and standard deviation. If divergence > 0.5% systematically, the sign convention or the methodology needs revision.

## LOW concerns — nice-to-have, not Phase 2 blockers

### Concern 5 — OI-only methodology, no volume-based variant

The cron reads `call_gamma_oi + put_gamma_oi` (open interest based). TRACE shows both OI-based (structural / slow-moving) and Vol-based (intraday / fast-moving) flips. For a regime tile that updates every 5 minutes, OI-based is the right choice — but it should be explicit which "zero-gamma" we're exposing.

**Required action (low priority):** rename the response field from `zero_gamma` to `zero_gamma_oi` if we ever add a Vol-based variant, OR document in the endpoint docstring that the value is OI-based.

### Concern 6 — No spec test for the kernel approximation accuracy

The triangular kernel with half-width = 2 × median strike spacing is plausible but unverified. A unit-test asserting that for a synthetic gamma profile with a known-true zero crossing (e.g. a perfectly linear ramp), the calculator returns the right level within tolerance, would catch regressions if the kernel half-width is ever changed.

**Required action (low priority):** add a deterministic-input test in `api/__tests__/` that sets up a synthetic gex profile and asserts the calculated level lands within expected tolerance.

## Phase 2 readiness — concrete checklist

Before the Dealer Regime classifier ships:

- [ ] Resolve Concern 1 — confirm sign convention against UW docs OR a known-good TRACE comparison.
- [ ] Resolve Concern 2 — verify `netGammaAtSpot` actually flips signs across regime changes (1–2 weeks of telemetry).
- [ ] Implement Concern 3 fix — confidence gate at ≥ 0.10 in the regime classifier.
- [ ] Resolve Concern 4 — TRACE cross-validation study; document mean/SD divergence.

Concerns 5 and 6 can ride as follow-ups without blocking Phase 2 launch.

## Files reviewed

- /Users/charlesobrien/Documents/Workspace/strike-calculator/api/_lib/zero-gamma.ts
- /Users/charlesobrien/Documents/Workspace/strike-calculator/api/cron/compute-zero-gamma.ts
- /Users/charlesobrien/Documents/Workspace/strike-calculator/api/zero-gamma.ts
- /Users/charlesobrien/Documents/Workspace/strike-calculator/api/_lib/zero-gamma-tickers.ts
- docs/tmp/zero-gamma-audit/probe.mjs (audit data probe)
