# Options Flow Ranking Table

## Goal

Surface a sortable, ranked table of 0-1 DTE SPXW strikes with heavy repeated-hit flow, updated every minute, to use as directional confluence alongside the existing GEX components. Detect clustering of bullish or bearish flow above/below spot to inform long/short bias.

## Verified spec (live-tested against UW)

- Endpoint: `GET /api/option-trades/flow-alerts`
- Ticker: `SPXW` only (SPX carries monthlies with no 0-1 DTE)
- Rules: `RepeatedHits`, `RepeatedHitsAscendingFill`, `RepeatedHitsDescendingFill` (Floor\* rules never fired in 200-row live sample)
- DTE filter: `min_dte=0&max_dte=1` works server-side
- Multileg: effectively 0% on our rule set, but we store + badge for edge cases
- Cap: `limit=200` is UW's hard max; paginate with `older_than` only on first-run / outage recovery
- Incremental: `newer_than=<last_seen_created_at>` in steady state
- Observed volume: ~8 alerts/day typical, 200/day on heavy days — nowhere near cap

## Architecture

```
UW flow-alerts ──► [fetch-flow-alerts cron, 1-min]
                        │
                        ▼
                  [flow_alerts table]
                        │
                        ▼
               [GET /api/options-flow/top-strikes]
                        │
                        ▼
                 [useOptionsFlow hook]
                        │
                        ▼
              [OptionsFlowTable + FlowDirectionalRollup]
```

## Schema (expanded — overwrite-not-underwrite)

Design principle: capture every datapoint the API exposes today, add nullable columns for the detail-endpoint enrichment we haven't wired yet, denormalize cheap derived fields at ingest, and keep a `raw_response` JSONB safety net for forensic replay. All future ML work joins this table — we want zero backfills later.

### Column groups

#### Identity & rule

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `id` | BIGSERIAL PK | internal | our row id, not UW's |
| `uw_alert_id` | UUID, nullable | detail endpoint | UW's alert id (backfill later if we enrich) |
| `rule_id` | UUID, nullable | detail endpoint | UW's specific rule instance id |
| `alert_rule` | TEXT NOT NULL | list | `RepeatedHits`, `RepeatedHitsAscendingFill`, `RepeatedHitsDescendingFill` |
| `ticker` | TEXT NOT NULL | list | `SPXW` |
| `issue_type` | TEXT | list | `Index` for SPXW |
| `option_chain` | TEXT NOT NULL | list | OSI symbol; natural dedupe key |
| `strike` | NUMERIC NOT NULL | list | |
| `expiry` | DATE NOT NULL | list | |
| `type` | TEXT NOT NULL | list | `call` or `put` |

#### Timing

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `created_at` | TIMESTAMPTZ NOT NULL | list | alert creation time (UW) |
| `start_time` | TIMESTAMPTZ, nullable | detail | first trade in the cluster |
| `end_time` | TIMESTAMPTZ, nullable | detail | last trade in the cluster |
| `ingested_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | internal | when WE stored it; lets us measure ingest lag |

#### Pricing & volatility

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `price` | NUMERIC | list | avg fill price of the cluster |
| `underlying_price` | NUMERIC | list | SPX spot at alert time |
| `bid` | NUMERIC, nullable | detail | NBBO bid at alert |
| `ask` | NUMERIC, nullable | detail | NBBO ask at alert |
| `iv_start` | NUMERIC, nullable | detail | IV at cluster start |
| `iv_end` | NUMERIC, nullable | detail | IV at cluster end |

#### Premium & size

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `total_premium` | NUMERIC NOT NULL | list | |
| `total_ask_side_prem` | NUMERIC | list | aggressive buys |
| `total_bid_side_prem` | NUMERIC | list | sold to MMs |
| `total_size` | INT | list | contracts in this cluster |
| `trade_count` | INT | list | prints rolled up |
| `expiry_count` | INT | list | distinct expiries in the alert |
| `volume` | INT | list | contract volume at this strike |
| `open_interest` | INT | list | |
| `volume_oi_ratio` | NUMERIC | list | |

#### Flags

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `has_sweep` | BOOLEAN | list | |
| `has_floor` | BOOLEAN | list | |
| `has_multileg` | BOOLEAN | list | |
| `has_singleleg` | BOOLEAN | list | confirms the inverse signal too |
| `all_opening_trades` | BOOLEAN | list | fresh positioning (not closing) |

#### Denormalized derived (computed at ingest)

Cheap to compute once, avoids repeated arithmetic in ML queries over millions of rows.

| Column | Type | Formula | Why pre-compute |
| --- | --- | --- | --- |
| `ask_side_ratio` | NUMERIC | `total_ask_side_prem / total_premium` | feature for every ML model |
| `bid_side_ratio` | NUMERIC | `total_bid_side_prem / total_premium` | |
| `net_premium` | NUMERIC | `total_ask_side_prem - total_bid_side_prem` | signed directional force |
| `dte_at_alert` | INT | `expiry - created_at::date` | faster than re-deriving |
| `distance_from_spot` | NUMERIC | `strike - underlying_price` | directional feature |
| `distance_pct` | NUMERIC | `(strike - underlying_price) / underlying_price` | scale-invariant feature |
| `moneyness` | NUMERIC | `underlying_price / strike` | standard options feature |
| `is_itm` | BOOLEAN | derived from type + strike + spot | |
| `minute_of_day` | INT | CT-minute 0-1439 | project convention (range 510-899 for session) |
| `session_elapsed_min` | INT | minutes since 08:30 CT | time-of-day feature |
| `day_of_week` | INT | 0=Mon, 4=Fri | calendar feature |

#### Safety net

| Column | Type | Notes |
| --- | --- | --- |
| `raw_response` | JSONB | the full UW list-response row as-is; survives any future field additions without migration |

### Constraints & indexes

```sql
UNIQUE (option_chain, created_at)        -- natural dedupe key
INDEX (created_at DESC)                   -- "last N min" queries
INDEX (expiry, strike)                    -- ML joins on contract
INDEX (alert_rule)                        -- rule-conditional analysis
INDEX (type, created_at DESC)             -- call/put filtered time queries
INDEX (minute_of_day)                     -- time-of-day ML features
```

### Why this is the right shape

- **Nullable detail columns = zero-cost option.** If later experiments want `bid`/`ask`/`iv_start`/`iv_end`, we add a one-off enrichment job that back-populates those columns. No migration. No schema drift.
- **Denormalized derived fields** make ML `GROUP BY minute_of_day` or `WHERE distance_pct > 0.01` queries orders of magnitude faster than recomputing every read.
- **`raw_response` JSONB** is insurance. If UW adds new fields tomorrow that we care about, they're already stored — we just add a column and populate from the JSONB.
- **`ingested_at` separate from `created_at`** lets us measure ingest latency — useful for diagnosing missed cron runs and for ML features that care about "was this signal seen in real time or after the fact."

## Scoring formula (sortable column)

Per-strike composite over rolling 15-min window:

```
score = (log10(total_premium) * 20)          // premium size, log-scaled
      + (ask_side_ratio * 30)                // aggression (0-1 ratio × 30)
      + (volume_oi_ratio_capped * 15)        // fresh positioning, capped at 2.0
      + (hit_count * 10)                     // cluster density
      + (ascending_fill_bonus ? 15 : 0)      // UW-flagged buyer-paying-up
      - (proximity_penalty)                  // 0 near ATM, up to -20 at >3% OTM
```

Tuneable constants live in `api/_lib/flow-scoring.ts`. Empirical tuning after 1 week of data.

## Tasks

### Phase 1 — Data model + ingest cron

- [ ] **1.1** Add `flow_alerts` table migration to `migrateDb()` in `api/_lib/db.ts` per the full schema in the **Schema (expanded)** section above. All list-endpoint fields are NOT NULL where the spec guarantees them. Detail-endpoint fields (`uw_alert_id`, `rule_id`, `bid`, `ask`, `iv_start`, `iv_end`, `start_time`, `end_time`) are NULLABLE — populated only if we later wire the detail-endpoint enrichment. Denormalized derived columns are populated at insert time from the list fields. `raw_response JSONB` stores the original row. Five indexes as specified. → **Verify:** `POST /api/journal/init` runs migration without error; `\d flow_alerts` in psql shows all column groups and indexes.
- [ ] **1.2** Update `api/__tests__/db.test.ts` with new migration id, expected output, and incremented SQL call count. → **Verify:** `npm run test:run api/__tests__/db.test.ts` passes.
- [ ] **1.3** Create `api/cron/fetch-flow-alerts.ts` using the standard cron pattern. On each run: read max(created_at) from flow_alerts, pass as `newer_than`, fetch with pagination if response is full (200 rows). For each alert row, compute denormalized derived fields (`ask_side_ratio`, `bid_side_ratio`, `net_premium`, `dte_at_alert`, `distance_from_spot`, `distance_pct`, `moneyness`, `is_itm`, `minute_of_day`, `session_elapsed_min`, `day_of_week`) and store the original JSON as `raw_response`. Upsert with `ON CONFLICT (option_chain, created_at) DO NOTHING`. → **Verify:** Hit local endpoint with `CRON_SECRET`, confirm rows land in DB with derived columns populated and `raw_response` JSONB present.
- [ ] **1.4** Register cron in `vercel.json` with `* * * * *` schedule (every minute; the market-hours gate in `cronGuard` keeps it idle off-hours). Add `/api/cron/fetch-flow-alerts` to the `protect` array in `src/main.tsx` (botid). → **Verify:** `vercel.json` lint passes; botid list includes path.
- [ ] **1.5** Write `api/__tests__/fetch-flow-alerts.test.ts`: mock `getDb`, mock UW response, verify insert shape (all 24 list fields + 11 derived + raw_response), newer_than logic, pagination branch, and correct computation of derived fields (e.g. `ask_side_ratio`, `minute_of_day`, `is_itm`). → **Verify:** `npm run test:run api/__tests__/fetch-flow-alerts.test.ts` passes.

### Phase 2 — Read API + scoring

- [ ] **2.1** Create `api/_lib/flow-scoring.ts` exporting `scoreStrike()` and the rolling-window aggregator. Pure functions, no DB calls. → **Verify:** unit-tested with fixture alerts.
- [ ] **2.2** Create `api/options-flow/top-strikes.ts` endpoint. Query last 15 min of flow_alerts, group by strike+type, compute score via `scoreStrike`, return top N (configurable, default 10). Response shape: `{ strikes: RankedStrike[], rollup: DirectionalRollup, spot: number | null, last_updated: ISO }`. Zod-validate query params (limit, window_minutes). → **Verify:** `curl localhost:3000/api/options-flow/top-strikes` returns ranked JSON.
- [ ] **2.3** Write `api/__tests__/top-strikes.test.ts` with seeded fixture rows → expected ranking order. → **Verify:** `npm run test:run` passes.
- [ ] **2.4** Add `/api/options-flow/top-strikes` to the botid `protect` array in `src/main.tsx`. → **Verify:** protect list updated.

### Phase 3 — Frontend hook + component

- [ ] **3.1** Create `src/hooks/useOptionsFlow.ts` following the `useMarketData` pattern (polling every 60s, gated on `marketOpen`). → **Verify:** hook unit test with mocked fetch.
- [ ] **3.2** Create `src/components/OptionsFlow/OptionsFlowTable.tsx` — sortable table with columns: Strike, Side (C/P), Distance from spot, Premium, Ask-side %, Vol/OI, GEX-at-strike (from existing state), Multileg badge, Score. Dark-mode Tailwind. Click column header to re-sort. Default sort: score desc. → **Verify:** `npm run test:run` component test (sorts correctly, renders badge).
- [ ] **3.3** Create `src/components/OptionsFlow/FlowDirectionalRollup.tsx` — the "4 bullish above / 1 bearish below — Lean: Bullish" summary row above the table. → **Verify:** component test with mocked data.
- [ ] **3.4** Wire into `App.tsx` — mount above or alongside the existing GEX components so you can eyeball confluence. → **Verify:** `npm run dev`, load UI, see table with live data during market hours (or empty state off-hours).

### Phase 4 — Verification

- [ ] **4.1** Run `npm run review` (tsc + eslint + prettier + vitest). → **Verify:** zero errors.
- [ ] **4.2** e2e Playwright spec in `e2e/options-flow.spec.ts`: check table renders, axe-core a11y pass, keyboard sort works. → **Verify:** `npm run test:e2e` passes.
- [ ] **4.3** Launch code-reviewer subagent to eval full diff against CLAUDE.md conventions. → **Verify:** verdict = `pass`.

## Done When

- [ ] 1-min cron is populating `flow_alerts` in prod
- [ ] UI component renders a ranked, sortable table of top strikes during market hours
- [ ] Directional rollup surfaces cluster bias (bullish/bearish/neutral)
- [ ] GEX-at-strike column is wired in for visual confluence with existing GEX components
- [ ] All tests pass, code-reviewer verdict is `pass`

## Open questions (surface before Phase 1)

1. **Rolling window.** 15 min vs 30 min vs 60 min. Longer = more stable ranking but laggier to new positioning. I'd start at 15, tune later.
2. **Top N.** 5 or 10? 5 is cleaner for eyeballing confluence; 10 captures more of the distribution. Default to 10, let the sort collapse noise.
3. **GEX-at-strike column source.** Does it come from the existing `useGexTarget` / `useSpotGex` state (already loaded in the SPA) or should the read endpoint join it server-side? Client-side join is simpler and keeps the new endpoint pure.
4. **Score weights.** The formula above is an initial guess. Plan to leave the weight constants exported + log raw inputs so we can tune after 1 week of live data without re-deploying.

## Future ML Phase (documentation only — not part of this build)

Once `flow_alerts` has ~1 month of accumulated data, the following ML directions become feasible. This section is exploratory — none of it ships with the initial feature. Treat as a research roadmap that informs what we store now so we don't regret the schema later.

### Data readiness

The Phase 1 schema already gives us what ML needs:

- **Raw signal:** every alert's strike, side, rule, aggression ratio, size, timing
- **Joinable keys:** `created_at` (timestamp) + `expiry` to join against `spx_candles_1m`, `greek_exposure`, `spot_gex`
- **Outcome computable after the fact:** forward returns at 1/5/15/30/60 min post-alert via a simple SQL join on SPX candles

Optional additions if ML research demands them later:

- Ingest a parallel feed of rejected/non-triggering alerts (e.g. broad `/flow-alerts` without the rule filter) — would let us train a classifier that learns what distinguishes "real positioning" from typical flow. Costs one more API call/min.
- Store the full UW response blob in a JSONB column for forensic replay — trades storage cost for schema flexibility.

### Research questions to run experiments against

Each of these maps to a single ML phase doc (`ml/docs/PHASE-FLOW-*.md`) following the project's existing convention. Ordered by expected value:

1. **Does flow clustering predict forward SPX return?**
   Outcome: binary (up/down) or three-class (up/flat/down) over next 5/15/30 min. Features: aggregate `score`, `ascending_fill_count`, `ask_side_ratio`, cluster size, strike distance from spot, time-of-day bucket. Model: gradient-boosted trees (sklearn). Baseline: majority class. If AUC > 0.55 out-of-sample, there's a signal worth trading on.

2. **Does flow-against-GEX outperform flow-with-GEX?**
   The core "confluence hypothesis." Interaction feature: `flow_score × sign(gex_at_strike)`. Test whether the interaction term adds predictive power beyond either feature alone. If the coefficient is significantly negative (i.e. flow against positive GEX predicts moves), that validates the visual-confluence thesis and could become an automated alert.

3. **Signal half-life / decay curve.**
   How long does predictive power persist after a cluster forms? Measure AUC at t+1, t+5, t+15, t+30, t+60 minutes. Informs optimal entry timing and stop-loss horizons. Outputs a single decay plot per rule type.

4. **Cluster type discovery (unsupervised).**
   K-means or HDBSCAN on feature vectors of detected clusters. Goal: are there natural categories like "aggressive directional," "hedging wall," "calendar positioning," "OEX rebalance"? If yes, each type may need its own predictive model. Visualize with t-SNE / UMAP for sanity-check.

5. **VIX regime conditioning.**
   You already have VIX regime classification. Test whether flow signal strength varies by regime. Plausible hypothesis: flow matters more in low-VIX drift regimes, gets drowned by volatility in high-VIX. Conditional models per regime.

6. **False-positive / noise characterization.**
   What separates clusters that lead to moves from clusters that don't? Binary classifier on "cluster → price moved ≥0.25% within 15 min" (yes/no). Feature importance reveals what to filter on.

7. **Backtest driven strategy.**
   After above confirms edge: rule like "if directional rollup confidence > 0.65 AND score > threshold, enter long with 3-point stop, 5-point target." Walk-forward backtest on 3+ months of data. Only worth doing if phases 1-2 show genuine edge.

8. **Production inference.**
   Load trained classifier into `api/analyze.ts` context so Claude sees "ML-predicted direction: 0.72 bullish" alongside the static rules. Low-latency (model loads once, inference per analyze call is <10ms). Only after offline backtest validates the model.

### Pipeline structure (when we get there)

Mirrors the existing `ml/` pipeline:

```text
ml/src/load_flow_alerts.py          # pull from Postgres, join candles + GEX
ml/src/flow_features.py             # per-alert + per-cluster feature engineering
ml/src/flow_outcomes.py             # compute forward returns, label rows
ml/src/phase_flow_classification.py # train + evaluate direction classifier
ml/src/phase_flow_clustering.py     # unsupervised cluster type discovery
ml/plots/flow/                      # decay curves, feature importance, ROC
ml/docs/PHASE-FLOW-*.md             # findings doc per phase
```

### Data volume check

At ~200 alerts/day × ~20 trading days/month = 4,000 alerts/month. For supervised learning on forward-return outcomes, want ~6 months = ~24,000 labeled rows. Sufficient for tree-based models, borderline for deep learning (not needed at this stage).

### What to decide NOW (so future-ML isn't painful)

- **Keep ingested_at AND created_at.** Phase 1 schema already does this. Critical — lets us later analyze ingest lag separately from true alert time.
- **Don't pre-aggregate into "snapshots."** Store raw alerts, let ML recompute clusters however it wants. Phase 1 already does this.
- **Don't normalize across deploys.** If we ever change scoring weights, keep the raw inputs so we can re-score history. Phase 1 stores raw fields, not just the computed score — good.

## Non-goals for this pass

- Backfill of historical flow alerts (add a script later if ML phase wants >22-day lookback for training)
- Per-strike drill-down modal (future iteration — clicking a row could show individual alerts)
- ML pipeline itself (documented above as future work)
- Alert notifications (e.g. "new cluster forming") — separate skill

## Notes

- Cron runs every minute. `cronGuard` default `marketHours: true` keeps it idle outside 08:30-15:00 CT Mon-Fri. No work off-hours, no extra cost.
- UW 429 handling is already covered by `uwFetch` Sentry metrics — no custom retry needed beyond `withRetry`.
- Table data is derived — no need to store "top strikes" snapshots. We can always recompute from `flow_alerts`. This is a win for tuning: change score weights, reload, see new ranking with no DB migration.
- Schema lets us add the historical flow to ML pipeline later (ingested_at + created_at both tracked).
