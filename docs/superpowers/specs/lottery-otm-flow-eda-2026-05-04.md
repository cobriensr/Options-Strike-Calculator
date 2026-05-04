# Lottery OTM-NCP Inversion EDA

**Date:** 2026-05-04
**Author:** Session continuation from lottery-flow-inversion-exit
**Status:** Spec — pending user approval before implementation
**Predecessor:** [lottery-flow-inversion-exit-2026-05-04.md](./lottery-flow-inversion-exit-2026-05-04.md) — flow-inversion shipped as 4th policy; +9.8pp mean uplift confirmed

---

## What this is

Test whether **OTM-only net call/put premium** produces a stronger inversion-exit signal than the **all-strikes NCP/NPP** we currently use. Lottery fires are exclusively on OTM contracts, so OTM-filtered flow should be a tighter directional signal — ITM trades (covered calls, synthetic stock, deep-ITM hedges) are noise for our purpose.

## What this is NOT

- **Not a UW REST backfill.** Probed UW (2026-05-04): `?otm_only=true` is silently ignored on `/stock/{ticker}/net-prem-ticks`. The OTM filter only exists on `/market/market-tide` (whole market). So this EDA computes OTM flow from the **per-trade parquet** instead — limited to the 15-day window where parquets exist.
- **Not a production cron.** If OTM-NCP wins, the next spec is "extend the parquet pipeline to compute and ship OTM-NCP via the same WRITE_DB pattern."

---

## Goal

> Determine whether OTM-only NCP/NPP produces a stronger inversion-exit signal than all-strikes NCP/NPP, on the same 47k-fire sample. If yes by ≥+3pp on lottery rate AND concentration check passes, open a follow-up spec to ship it.

---

## Data dependencies

| Source                                                          | What we need                                | Notes                                                                      |
| --------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `/Users/charlesobrien/Desktop/Bot-Eod-parquet/*-trades.parquet` | Per-trade tape, 15 days × ~10M rows/day     | Already has `strike`, `underlying_price`, `option_type`, `side`, `premium` |
| `lottery_finder_fires`                                          | Fire IDs + outcomes (already populated)     | No change                                                                  |
| `net_flow_per_ticker_history`                                   | NOT used here — REST flow has no OTM filter | Existing all-strikes data stays as the baseline comparison                 |

---

## Phases

### Phase 1 — Compute OTM flow from parquets

#### Task 1.1 — `ml/experiments/lottery-otm-flow-eda/compute_otm_flow.py`

For each of 15 daily parquets:

1. Load with column projection: `executed_at, underlying_symbol, option_type, strike, underlying_price, side, premium, canceled`
2. Drop canceled trades (handle both `True`/`'t'` encodings per the prior bug)
3. Restrict to lottery universe (the 51 tickers from `LOTTERY_TICKERS_ALL`)
4. **OTM filter**:
   - call: `strike > underlying_price`
   - put: `strike < underlying_price`
5. Compute signed premium per trade:
   - `side == 'ask'` → buyer-initiated → `+premium`
   - `side == 'bid'` → seller-initiated → `-premium`
   - `side == 'mid'` or `'no_side'` → drop (no directional signal)
6. Bucket per `(ticker, minute_floor(executed_at))`, aggregate:
   - `otm_ncp` = sum of signed call premiums
   - `otm_npp` = sum of signed put premiums
7. Restrict to session window (08:30–15:00 CT), append session_date column
8. Write `ml/experiments/lottery-otm-flow-eda/otm_flow.parquet`

**Verify:** Row count roughly matches `net_flow_per_ticker_history` for the same window (15 trading days × 51 tickers × ~390 min ≈ 300k rows). Spot-check one (ticker, minute) cell against the same row in REST data — magnitudes should be in the same order.

### Phase 2 — Re-run inversion simulation with OTM flow

#### Task 2.1 — `ml/experiments/lottery-otm-flow-eda/exit_simulation_otm.py`

Adapt `exit_simulation.py` to read the OTM-flow parquet instead of the DB. Same exit-rule logic (peak detection, slope inversion, 3-min persistence). Same trail-30/10 baseline.

Output `exit_simulation_otm_results.parquet` with columns:

- `fire_id`, `inversion_pct_all`, `inversion_pct_otm`, `trail_pct`, plus stratification cols

#### Task 2.2 — `ml/experiments/lottery-otm-flow-eda/compare.py`

Side-by-side comparison: all-NCP inversion vs OTM-NCP inversion vs trail-30/10. Tables for:

- Lottery rate (≥+100%) per policy
- Mean / median / std return per policy
- Stratified lift (mode, tod, option_type, top tickers, by date)
- Concentration check on OTM-NCP winners (per `feedback_uniform_lift_is_leakage`)

Output `compare.md` with explicit verdict.

### Phase 3 — Decision

Read the report flatly. Pre-committed decision rules:

- **OTM wins** if OTM-NCP inversion lottery rate ≥ all-NCP + 3pp AND concentration check shows real edge → open follow-up spec to ship OTM-NCP as a parquet-pipeline column + new exit policy
- **OTM ties** if delta is within ±2pp → keep all-NCP, document the null result, move to Dir Delta next
- **OTM loses** if delta is < -2pp → all-NCP captured the signal; OTM filter loses information

---

## Files to create

- `ml/experiments/lottery-otm-flow-eda/README.md`
- `ml/experiments/lottery-otm-flow-eda/compute_otm_flow.py`
- `ml/experiments/lottery-otm-flow-eda/exit_simulation_otm.py`
- `ml/experiments/lottery-otm-flow-eda/compare.py`
- `ml/experiments/lottery-otm-flow-eda/otm_flow.parquet` (output)
- `ml/experiments/lottery-otm-flow-eda/exit_simulation_otm_results.parquet` (output)
- `ml/experiments/lottery-otm-flow-eda/compare.md` (output)

## Files NOT modified

- Any production code (api/, src/) — this is research-only
- `ml/experiments/lottery-net-flow-eda/exit_simulation.py` — the all-NCP version stays as-is (we compare against it)

---

## Locked thresholds

| Constant            | Value                                                                            | Source                      |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| OTM-call filter     | `strike > underlying_price`                                                      | Standard convention         |
| OTM-put filter      | `strike < underlying_price`                                                      | Standard convention         |
| Side classification | `ask=+`, `bid=-`, `mid/no_side` dropped                                          | Matches UW's NCP formula    |
| Decision threshold  | ±3pp on lottery rate                                                             | Practical-significance band |
| All other constants | Same as exit_simulation.py (peak prominence 5%, slope window 5min, persist 3min) | Match prior work            |

---

## Open questions

1. **Mid-side trades.** Dropping `mid` and `no_side` trades is the strict interpretation. UW's own NCP formula treats them as half-credit to ask side, half to bid side. Strict drop is cleaner; if results are noisy, we may need to revisit. Default: drop.

2. **Underlying price source.** Per-trade `underlying_price` is the spot at trade time. For OTM classification we use that. Alternative: classify based on day-open spot to keep classifications stable. Default: per-trade (matches UW's intent).

---

## Done when

- [ ] `otm_flow.parquet` exists with ~300k rows
- [ ] `exit_simulation_otm_results.parquet` populated for the same fire_ids as the all-NCP simulation
- [ ] `compare.md` exists with all-NCP vs OTM-NCP head-to-head + concentration check + verdict
- [ ] Decision recorded in this spec (appended): ship / kill / next-feature

---

## Notes

- This is exploratory research, not a feature ship. Run lint on the Python (it's optional in ml/) but skip the code-reviewer subagent per CLAUDE.md ml/ exception.
- If OTM wins, the production rollout becomes a separate spec — including extending the existing backfill pipeline to compute and store OTM-NCP/NPP, plus adding a 5th exit-policy chip.

---

## Result (appended 2026-05-04)

**Verdict: TIE — OTM does NOT improve the signal. Killing.**

Headline lottery rate (47,658 fires, gross of costs):

- trail-30/10: 1.30%
- inversion (all-NCP): **6.69%**
- inversion (OTM-NCP): **5.86%**
- delta: **−0.82pp** (OTM marginally worse, within ±2pp tie band)

Stratified breakdown shows OTM is **directionally worse in 11/15 dates**
and across nearly every cell:

- Mode A: −1.09pp / Mode B: −0.68pp
- Calls: −1.12pp / Puts: −0.49pp
- AM_open: −0.98 / LUNCH: −1.18 / MID: −1.28 / PM: +0.06 (only stratum where OTM is not worse)

**Why OTM loses**: my prior hypothesis was that ITM trades are noise.
Wrong. Around-the-money ITM trades carry real directional information
(institutional buyers loading up on ITM calls IS a bullish signal).
Filtering them out reduces sample size at each minute AND removes
genuine signal. The all-strikes NCP captures the relevant directional
flow already.

**Decision**: Keep `realizedFlowInversionPct` (all-NCP) as shipped.
Do NOT add an OTM variant. Move to next feature in the screenshot
priority list — **Dir Delta** (delta-weighted directional flow).

Full report: [`compare.md`](../../../ml/experiments/lottery-otm-flow-eda/compare.md)
