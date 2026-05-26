# Silent Boom × GexBot — Live Instrumentation Spec (2026-05-26)

## Goal

Stash the top GexBot scalars at Silent Boom fire time so they accumulate as
features on the `silent_boom_alerts` row. The nightly `takeit-retrain` GH
Actions pipeline will pick them up via `build_training_set.py` and the model
will incorporate them once data is sufficient (~3–4 weeks).

## Why

The 2026-05-26 univariate probe ([docs/superpowers/specs/silent-boom-gexbot-probe-findings-2026-05-26.md](../../tmp/silent-boom-gexbot-probe-findings-2026-05-26.md))
found tentative evidence (r≈0.15–0.20, p<0.01 on the top 3 features) that
GexBot 1DTE+ convexity and DEX scalars predict Silent Boom hit rates. n=270
across 4 trading days is too thin to commit to a model change — but the
instrumentation cost is small and starts the forward-validation clock.

## Top features (from probe)

Sorted by |r| against `peak_ceiling_pct >= 30`:

1. `one_cvroflow` — r=+0.20 (1DTE+ convexity flow rate)
2. `net_put_dex` — r=+0.19 (net put DEX, aggregated across expiries)
3. `one_dexoflow` — r=+0.19 (1DTE+ delta-exposure flow rate)
4. `one_gexoflow` — r=-0.16 (1DTE+ gamma-exposure flow rate, anti-signal)
5. `zcvr` — captured as a 0DTE convexity baseline (no direct probe hit but
   semantically important for 0DTE-tagged fires; cheap to include)

## Phases

### Phase 1 — DB + cron (this batch)

**Migration 180** (`api/_lib/db-migrations.ts`):

Add to `silent_boom_alerts`:

| Column | Type | Notes |
|---|---|---|
| `gex_one_cvroflow` | NUMERIC | Top probe signal |
| `gex_net_put_dex` | NUMERIC | |
| `gex_one_dexoflow` | NUMERIC | |
| `gex_one_gexoflow` | NUMERIC | Anti-signal |
| `gex_zcvr` | NUMERIC | 0DTE convexity baseline |
| `gex_zero_gamma` | NUMERIC | Dealer flip level (compute `gex_zero_gamma_minus_spot` downstream) |
| `gex_spot` | NUMERIC | GexBot's view of spot at snapshot |
| `gex_captured_at` | TIMESTAMPTZ | Freshness; NULL = no snapshot found |

Eight columns, all nullable. NULL when (a) ticker isn't in GexBot universe
(non-index/non-ETF retail names), (b) GexBot poll missed the fire-minute
window (rare), (c) row pre-dates migration.

**Helper** (`api/_lib/gexbot-queries.ts` — already exists):
- `getLatestGexbotSnapshot(client, ticker, asOf, maxAgeSeconds)` — returns
  the single most recent `gexbot_snapshots` row for `ticker` whose
  `captured_at` is within `[asOf - maxAgeSeconds, asOf]`. Default
  `maxAgeSeconds = 120` (2 minutes, covering one cron miss).
- Handles SPXW → SPX (and any future) ticker aliases.

**Cron change** (`api/cron/detect-silent-boom.ts`):
- Before each INSERT, call `getLatestGexbotSnapshot(...)` with the fire's
  `underlying_symbol` mapped to GexBot's enum.
- Add the 8 gex_ columns to the INSERT statement.
- Pass through nulls cleanly when no snapshot.

**Test updates**:
- `api/__tests__/db.test.ts` — add `{ id: 180 }` to applied migrations
  mock; bump SQL call count by 2 (CREATE/ALTER + INSERT INTO
  schema_migrations).
- `api/__tests__/detect-silent-boom.test.ts` — extend the existing test
  to mock `getLatestGexbotSnapshot` and assert the gex_ columns flow
  through. If the file doesn't exist, add it.
- `api/__tests__/gexbot-queries.test.ts` — test the freshness window
  + ticker mapping.

### Phase 2 — Training pipeline (this batch)

**`ml/src/takeit/build_training_set.py`** SILENTBOOM_SQL:
- Add the 8 gex_ columns to the SELECT list.
- No featurization changes — the columns flow through `build_silentboom_from_raw`
  unchanged. The trainer's feature-discovery step will see them as new
  numeric columns the next time it runs against data that has them.

### Phase 3 — UI badge (this batch)

**`src/components/SilentBoom/SilentBoomRow.tsx`**:
- Add a small "GEX" pill showing two stats when `gex_captured_at` is set:
  - `one_cvroflow` value with directional arrow (↑ above 1.0, ↓ below)
  - `net_put_dex` sign indicator
- Pill is informational only — no filtering, no sorting impact, no action.
- Hidden entirely when `gex_captured_at` is NULL.

**`src/components/SilentBoom/types.ts`**:
- Extend the row type with the 8 new optional fields.

**Endpoint update** (`api/silent-boom-feed.ts` or whichever serves rows):
- Include the gex_* columns in the SELECT.

### Phase 4 — Status

- **Lottery instrumentation: SHIPPED (commit 093208c5, 2026-05-26).**
  Migration #181 mirrors #180 on `lottery_finder_fires`; detect-lottery-fires
  uses the same `getLatestGexbotSnapshotAt` helper; `LOTTERY_SQL` in
  `ml/src/takeit/build_training_set.py` pulls the new columns;
  `LotteryRow.tsx` renders the same GEX badge.

- **Live-feature wiring still deferred** — `LotteryAlertRow` /
  `SilentBoomAlertRow` in `api/_lib/takeit-features.ts` and the TS
  scorers (`scoreSilentBoom`, `scoreLottery`) do NOT consume the new
  gex_* columns yet. The bundle would need a retrain that knows the
  new feature names, and the training data needs ~3-4 weeks to
  accumulate before that retrain has signal. Targets the **2026-06-16**
  re-probe (see "Verification" below).

### Follow-up audit findings (2026-05-26 review)

After the initial commits a meta-review surfaced fixes that landed in a
follow-up commit on the same day:

- ML pipeline: `gex_captured_at` (TIMESTAMPTZ) + `gex_zero_gamma` /
  `gex_spot` (absolute prices that don't generalize across SPX~6000 /
  SPY~600 / VIX~20) were added to `NON_FEATURE_COLS` in
  `ml/src/takeit/train.py`. Without this the nightly retrain would
  crash on `X.astype(float)`.
- `mapToGexbotTicker` extended with `NDXP → NDX` and `RUTW → RUT`
  (both roots appear in the detect-cron universes; the original only
  handled SPXW).
- `GEXBOT_TICKER_SET` now derived from the canonical `GEXBOT_TICKERS`
  list in `gexbot-client.ts` (was a hand-duplicated copy).
- `getLatestGexbotSnapshotAt` default freshness window bumped from
  120s → 180s (tolerates 2 consecutive missed `fetch-gexbot-fast` runs
  instead of just 1).
- Both detect crons now emit `gexHits` / `gexMisses` / `gexOutOfUniverse`
  counters in the summary log — a successful-but-null lookup never
  triggers Sentry, so without these counts a slow regression is
  invisible.
- The frontend `gexbotBadge` factory and the per-feed `gex` field type
  are shared via `src/utils/gexbot-badge.ts` + `src/types/gexbot.ts`
  (previously duplicated across SilentBoomRow and LotteryRow).

## Open questions

- Does the existing `silent-boom-feed` endpoint already SELECT *, or does
  it list columns? (Affects whether the UI change requires a server change.)
- Are there any Silent Boom tickers in the GexBot universe beyond SPXW that
  need an alias map? Initial probe showed only SPXW→SPX.

## Verification before reporting done

1. `npm run review` passes (tsc + eslint + prettier + vitest --coverage).
2. Manual probe in `docs/tmp/` confirms that fresh Silent Boom inserts
   today populate the gex_* columns end-to-end.
3. `ml/src/takeit/build_training_set.py` runs without errors against the
   new schema (no need to retrain; just confirm the query is well-formed).

## Why not just wait for more data

Two reasons:
1. Each day without instrumentation is a day of unrecoverable training
   data. If we wait 3 weeks then add columns, the columns are NULL for
   those 3 weeks; the model can't learn from them.
2. The instrumentation cost is ~5 files for a small, contained change.
   Lower opportunity cost than building feature plumbing that goes through
   `gexbot_api_capture` JSONB at training time (which would also work but
   is more brittle and requires Blob reads during training).
