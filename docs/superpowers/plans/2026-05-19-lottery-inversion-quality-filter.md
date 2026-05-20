# Lottery Inversion-Quality Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow the daily lottery-finder feed from ~88 fires/day to ~40-50/day by adding a per-ticker Wilson-LCB inversion-quality metric and using it to both (a) suppress bottom-quintile tickers server-side and (b) re-tier surviving fires via a SELECT-time `quality_adjusted_score`.

**Architecture:** Path A from the spec — `combined_score` stays unchanged on `lottery_finder_fires`. A new per-ticker aggregate (`inversion_blend`, `inversion_quintile`, etc.) lives on `lottery_ticker_stats`, populated nightly by extending `scripts/enrich_lottery_outcomes.py`. The lottery endpoint LEFT JOINs the new columns, computes `qualityAdjustedScore = combined_score + bonus(quintile)` at SELECT time, filters Q1/Q2, and re-tiers. Escape hatch: `?showAll=1`.

**Tech Stack:** TypeScript (Node 24 / Vercel Functions), Vitest, Python 3 (psycopg2, pandas, numpy), Neon Postgres, React 19 + Tailwind 4, Playwright + axe-core.

**Spec:** [docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md](../specs/lottery-inversion-quality-filter-2026-05-19.md)

**Locked constants:**
- Win threshold T: `realized_flow_inversion_pct >= 50`
- Sample-size floor: N ≥ 10 per window
- Window weights: 0.6 × 21d + 0.4 × 90d (fall back to whichever has N≥10)
- Bonus by quintile: Q5=+5, Q4=+3, Q3=0, Q2=-2, Q1=-5
- Filter cut: suppress Q1 ∪ Q2 unless `?showAll=1`
- Next migration id: **175** (verified — latest is 174)
- Tier 1/2 cutoffs: **TBD — locked from Phase 2 CSV (Step 2.16)**
- Staleness cron host: `/api/cron/refresh-vix1d` (runs `0 11 * * 1-5`, once per trading morning)

---

## File Structure

**Create:**
- `api/_lib/lottery-inversion-bonus.ts` — pure helper: quintile → bonus, quality-adjusted-score
- `api/_lib/lottery-tier.ts` — tier classification from `qualityAdjustedScore`
- `api/__tests__/lottery-inversion-bonus.test.ts`
- `api/__tests__/lottery-tier.test.ts`
- `e2e/lottery-inversion-filter.spec.ts`
- `ml/tests/test_lottery_ticker_quality.py` (or extend existing)

**Modify:**
- `api/_lib/db-migrations.ts` — migration #175
- `api/__tests__/db.test.ts` — mock + assertion updates
- `scripts/enrich_lottery_outcomes.py` — append stats refit + CSV simulation
- `api/lottery-finder.ts` — 4 SELECTs, row shape, filter, serialize
- `api/_lib/validation/lottery.ts` — `showAll` query param
- `api/_lib/lottery-score-weights.ts` — keep `lotteryScoreTier` as deprecated re-export
- `api/__tests__/lottery-finder.test.ts` — coverage for filter + new fields
- `api/__tests__/lottery-finder-endpoint.test.ts` — endpoint-level coverage
- `src/components/LotteryFinder/LotteryRow.tsx` — tier badge prop + chip + tooltip
- `src/components/LotteryFinder/types.ts` — new row fields
- `src/components/LotteryFinder/LotteryRow.test.tsx` (if exists) or add one
- `src/hooks/useAppState.ts` — `showFilteredTickers` toggle state
- `api/cron/refresh-vix1d.ts` — staleness warning Sentry capture
- `docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md` — fill in locked tier cutoffs after Phase 2

---

## Per-Phase Loop

Every phase ends with this fixed loop, no asking between steps:

1. `npm run review` (or `ml/.venv/bin/pytest` for Python-only phases) — must be clean
2. Dispatch `code-reviewer` subagent on the diff
3. Resolve all `continue` feedback inline. On `refactor` verdict: revert, restart phase with reviewer notes.
4. **Atomic** stage + commit + push to main: `git add <specific paths> && git commit -m "…" && git push origin main` in one chained shell call (concurrent sessions are running — `git add -A` would swallow their work).

---

# Phase 1 — DB Migration (Add Columns to `lottery_ticker_stats`)

### Task 1: Migration #175

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append after id 174 at line ~4986)
- Test: `api/__tests__/db.test.ts`

- [ ] **Step 1.1: Read the db.test.ts mock pattern to understand call-count math**

Run: `grep -n "id: 174\|id: 173" api/__tests__/db.test.ts | head -10`

Use the existing pattern for migration 174 as the template for 175.

- [ ] **Step 1.2: Add the failing assertion to `db.test.ts`**

In `api/__tests__/db.test.ts`, find the section that lists applied-migration ids in the mock and the expected-output list. Add `{ id: 175 }` to the applied-migrations mock and the expected output list. Bump the expected SQL call count by **+2** (1 ALTER TABLE + 1 INSERT INTO schema_migrations).

- [ ] **Step 1.3: Run test to verify it fails**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: FAIL with a mismatch on migration count or expected output.

- [ ] **Step 1.4: Append migration #175 to `db-migrations.ts`**

In `api/_lib/db-migrations.ts`, after the existing id-174 block (line ~4986), add:

```ts
  {
    id: 175,
    description:
      'Add inversion-quality columns to lottery_ticker_stats. Wilson 95% LCB on ' +
      'P(realized_flow_inversion_pct >= 50) per ticker, computed on rolling 21d ' +
      'and 90d windows (sample-size floor N>=10 per window; NULL otherwise). ' +
      'inversion_blend = 0.6 * 21d + 0.4 * 90d, fallback to whichever window has ' +
      'N>=10 if only one qualifies. inversion_quintile maps blend across the ' +
      'ticker universe to 1..5. Populated nightly by scripts/enrich_lottery_outcomes.py.',
    statements: (sql) => [
      sql`ALTER TABLE lottery_ticker_stats
            ADD COLUMN IF NOT EXISTS inversion_lcb_21d NUMERIC,
            ADD COLUMN IF NOT EXISTS inversion_lcb_90d NUMERIC,
            ADD COLUMN IF NOT EXISTS inversion_blend NUMERIC,
            ADD COLUMN IF NOT EXISTS inversion_quintile SMALLINT,
            ADD COLUMN IF NOT EXISTS inversion_n_21d INTEGER,
            ADD COLUMN IF NOT EXISTS inversion_n_90d INTEGER`,
    ],
  },
```

- [ ] **Step 1.5: Run test to verify it passes**

Run: `npx vitest run api/__tests__/db.test.ts`
Expected: PASS — all migration counts and expected outputs match.

- [ ] **Step 1.6: Full review pass**

Run: `npm run review`
Expected: tsc + eslint + prettier + vitest --coverage all clean.

- [ ] **Step 1.7: Code-reviewer subagent**

Dispatch the `code-reviewer` subagent with: "Review the diff for migration #175 (lottery_ticker_stats columns). Pattern adherence to existing migrations; correct statements() shape; db.test.ts mock + call-count math correct."

Resolve any `continue` feedback inline.

- [ ] **Step 1.8: Commit + push atomically**

```bash
git add api/_lib/db-migrations.ts api/__tests__/db.test.ts && \
git commit -m "$(cat <<'EOF'
feat(lottery): Add migration 175 for ticker inversion-quality columns

Six new columns on lottery_ticker_stats: inversion_lcb_21d, inversion_lcb_90d,
inversion_blend, inversion_quintile, inversion_n_21d, inversion_n_90d.
Populated nightly by enrich_lottery_outcomes.py (Phase 2).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

# Phase 2 — ML Refit Extension + Tune-Before-Ship CSV

The existing script `scripts/enrich_lottery_outcomes.py` already uses psycopg2 + `execute_values` and is run manually after EOD ingest. We extend it with a final stage that computes the new ticker stats AND a one-shot CSV simulating tier cutoffs.

### Task 2: Wilson LCB helper

**Files:**
- Modify: `scripts/enrich_lottery_outcomes.py` (append new helpers near the top, after the dataclass imports)
- Test: `ml/tests/test_lottery_ticker_quality.py` (new file)

- [ ] **Step 2.1: Write the failing Wilson LCB test**

Create `ml/tests/test_lottery_ticker_quality.py`:

```python
"""Tests for the ticker-quality refit logic appended to enrich_lottery_outcomes.py."""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from enrich_lottery_outcomes import (
    wilson_lcb,
    inversion_blend,
    quintile_cuts,
)


def test_wilson_lcb_below_floor_returns_none():
    assert wilson_lcb(wins=5, n=9) is None  # N < 10


def test_wilson_lcb_at_floor_with_perfect_record():
    # n=10, wins=10 -> point estimate 1.0, but LCB strictly < 1
    val = wilson_lcb(wins=10, n=10)
    assert val is not None
    assert 0.6 < val < 1.0


def test_wilson_lcb_at_floor_with_zero_wins():
    # n=10, wins=0 -> LCB = 0
    val = wilson_lcb(wins=0, n=10)
    assert val is not None
    assert math.isclose(val, 0.0, abs_tol=1e-9)


def test_wilson_lcb_typical_case():
    # n=100, wins=60 -> point 0.60, LCB ~0.50
    val = wilson_lcb(wins=60, n=100)
    assert val is not None
    assert 0.48 < val < 0.52
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py::test_wilson_lcb_below_floor_returns_none -v`
Expected: FAIL with `ImportError: cannot import name 'wilson_lcb'`.

- [ ] **Step 2.3: Implement `wilson_lcb` in the script**

In `scripts/enrich_lottery_outcomes.py`, after the imports block and before the existing classes, add:

```python
# ============================================================
# Ticker inversion-quality refit (Phase 2 of the inversion-quality filter)
# ============================================================

INVERSION_WIN_THRESHOLD = 50.0  # realized_flow_inversion_pct >= 50 = "win"
SAMPLE_SIZE_FLOOR = 10
WILSON_Z = 1.96  # 95% CI
WINDOW_WEIGHT_21D = 0.6
WINDOW_WEIGHT_90D = 0.4


def wilson_lcb(wins: int, n: int) -> float | None:
    """Wilson 95% lower confidence bound on P(win | n trials).

    Returns None when n < SAMPLE_SIZE_FLOOR.
    """
    if n < SAMPLE_SIZE_FLOOR:
        return None
    if n == 0:
        return None
    p = wins / n
    z = WILSON_Z
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (center - margin) / denom)
```

Add `import math` to the import block if it isn't there already (it is on line 26).

- [ ] **Step 2.4: Run test to verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py::test_wilson_lcb_below_floor_returns_none ml/tests/test_lottery_ticker_quality.py::test_wilson_lcb_at_floor_with_perfect_record ml/tests/test_lottery_ticker_quality.py::test_wilson_lcb_at_floor_with_zero_wins ml/tests/test_lottery_ticker_quality.py::test_wilson_lcb_typical_case -v`
Expected: 4 PASS.

### Task 3: Window blend helper

- [ ] **Step 3.1: Add failing blend tests**

Append to `ml/tests/test_lottery_ticker_quality.py`:

```python
def test_inversion_blend_both_windows_present():
    val = inversion_blend(lcb_21d=0.5, lcb_90d=0.7)
    # 0.6 * 0.5 + 0.4 * 0.7 = 0.58
    assert math.isclose(val, 0.58, abs_tol=1e-9)


def test_inversion_blend_only_21d():
    assert inversion_blend(lcb_21d=0.5, lcb_90d=None) == 0.5


def test_inversion_blend_only_90d():
    assert inversion_blend(lcb_21d=None, lcb_90d=0.7) == 0.7


def test_inversion_blend_neither():
    assert inversion_blend(lcb_21d=None, lcb_90d=None) is None
```

- [ ] **Step 3.2: Run test — verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py -k blend -v`
Expected: FAIL with `ImportError: cannot import name 'inversion_blend'`.

- [ ] **Step 3.3: Implement `inversion_blend`**

In `scripts/enrich_lottery_outcomes.py`, after `wilson_lcb`:

```python
def inversion_blend(
    lcb_21d: float | None,
    lcb_90d: float | None,
) -> float | None:
    """Weighted blend of the 21d and 90d Wilson LCBs.

    Both present  -> 0.6 * 21d + 0.4 * 90d
    Only one      -> that one
    Neither       -> None
    """
    if lcb_21d is not None and lcb_90d is not None:
        return WINDOW_WEIGHT_21D * lcb_21d + WINDOW_WEIGHT_90D * lcb_90d
    if lcb_21d is not None:
        return lcb_21d
    if lcb_90d is not None:
        return lcb_90d
    return None
```

- [ ] **Step 3.4: Run test — verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py -k blend -v`
Expected: 4 PASS.

### Task 4: Quintile-cut helper

- [ ] **Step 4.1: Add failing quintile-cut tests**

Append to `ml/tests/test_lottery_ticker_quality.py`:

```python
def test_quintile_cuts_basic_universe():
    # 25 tickers with blends 0.01..0.25 should give roughly even quintiles
    blends = {f'T{i:02d}': i * 0.01 for i in range(1, 26)}
    quintiles = quintile_cuts(blends)
    # Each quintile should have ~5 tickers
    from collections import Counter
    counts = Counter(quintiles.values())
    for q in (1, 2, 3, 4, 5):
        assert counts[q] == 5, f"quintile {q} has {counts[q]}, expected 5"


def test_quintile_cuts_skips_none_values():
    # Tickers with None blend should not appear in the output
    blends = {'A': 0.1, 'B': None, 'C': 0.9, 'D': None}
    quintiles = quintile_cuts(blends)
    assert 'B' not in quintiles
    assert 'D' not in quintiles
    assert quintiles['A'] == 1
    assert quintiles['C'] == 5


def test_quintile_cuts_empty_universe():
    assert quintile_cuts({}) == {}
    assert quintile_cuts({'A': None}) == {}
```

- [ ] **Step 4.2: Run test — verify it fails**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py -k quintile -v`
Expected: FAIL with `ImportError: cannot import name 'quintile_cuts'`.

- [ ] **Step 4.3: Implement `quintile_cuts`**

In `scripts/enrich_lottery_outcomes.py`, after `inversion_blend`:

```python
def quintile_cuts(
    blends: dict[str, float | None],
) -> dict[str, int]:
    """Map each ticker's non-NULL blend to a quintile (1..5).

    Quintiles are computed across the population of tickers that have a
    non-NULL blend. Tickers with NULL blends are omitted from the output.
    Quintile 1 = worst (smallest blend), Quintile 5 = best.

    Ties at quintile boundaries go to the higher quintile (pandas qcut
    default: ``duplicates='drop'`` would shrink the output; use
    ``numpy.quantile`` thresholds instead so every ticker gets a slot).
    """
    valid = {t: b for t, b in blends.items() if b is not None}
    if not valid:
        return {}
    values = sorted(valid.values())
    # Five equal slices by count
    n = len(values)
    cut_indices = [int(round(n * q / 5)) for q in range(1, 5)]
    # Get the boundary values at each cut
    boundaries = [values[min(i, n - 1)] for i in cut_indices]
    out: dict[str, int] = {}
    for t, b in valid.items():
        q = 1
        for boundary in boundaries:
            if b > boundary:
                q += 1
        out[t] = q
    return out
```

- [ ] **Step 4.4: Run test — verify it passes**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py -k quintile -v`
Expected: 3 PASS.

### Task 5: Integration — refit stage in the main pipeline

- [ ] **Step 5.1: Find the entry point in the existing script**

Run: `grep -n "^def main\|if __name__" scripts/enrich_lottery_outcomes.py`

Identify the script's `main()` function (or equivalent) and the spot where the existing enrichment writes back. The new stage runs AFTER the existing enrichment so the just-written `realized_flow_inversion_pct` values are part of the rolling window.

- [ ] **Step 5.2: Implement the refit query + UPSERT**

In `scripts/enrich_lottery_outcomes.py`, add a new function near the end of the file (above `main()`):

```python
def refit_ticker_inversion_stats(
    conn,
    write_db: bool,
    sim_csv_path: Path | None = None,
) -> None:
    """Recompute lottery_ticker_stats.inversion_* columns from the rolling
    21d / 90d window of realized_flow_inversion_pct values.

    When sim_csv_path is provided, also writes the tune-before-ship CSV
    (one row per historical fire in the last 90 days) so the operator
    can lock Tier 1/2 cutoffs.
    """
    # ------- 21d and 90d per-ticker counts -------
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              underlying_symbol AS ticker,
              COUNT(*) FILTER (
                WHERE fired_at >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct IS NOT NULL
              ) AS n_21d,
              COUNT(*) FILTER (
                WHERE fired_at >= NOW() - INTERVAL '21 days'
                  AND realized_flow_inversion_pct >= %s
              ) AS w_21d,
              COUNT(*) FILTER (
                WHERE fired_at >= NOW() - INTERVAL '90 days'
                  AND realized_flow_inversion_pct IS NOT NULL
              ) AS n_90d,
              COUNT(*) FILTER (
                WHERE fired_at >= NOW() - INTERVAL '90 days'
                  AND realized_flow_inversion_pct >= %s
              ) AS w_90d
            FROM lottery_finder_fires
            WHERE fired_at >= NOW() - INTERVAL '90 days'
            GROUP BY underlying_symbol
            """,
            (INVERSION_WIN_THRESHOLD, INVERSION_WIN_THRESHOLD),
        )
        rows = cur.fetchall()

    blends: dict[str, float | None] = {}
    per_ticker: dict[str, dict] = {}
    for ticker, n_21d, w_21d, n_90d, w_90d in rows:
        lcb_21 = wilson_lcb(w_21d, n_21d)
        lcb_90 = wilson_lcb(w_90d, n_90d)
        blend = inversion_blend(lcb_21, lcb_90)
        blends[ticker] = blend
        per_ticker[ticker] = {
            'lcb_21d': lcb_21,
            'lcb_90d': lcb_90,
            'blend': blend,
            'n_21d': n_21d,
            'n_90d': n_90d,
        }

    quintiles = quintile_cuts(blends)

    # ------- Build UPSERT payload -------
    upsert_rows = []
    for ticker, stats in per_ticker.items():
        upsert_rows.append((
            ticker,
            stats['lcb_21d'],
            stats['lcb_90d'],
            stats['blend'],
            quintiles.get(ticker),  # None if blend was None
            stats['n_21d'],
            stats['n_90d'],
        ))

    # ------- Quintile distribution summary -------
    from collections import Counter
    quintile_counts = Counter(quintiles.values())
    print(f'[ticker-quality] {len(per_ticker)} tickers seen in 90d window')
    print(f'[ticker-quality] quintile distribution: {dict(sorted(quintile_counts.items()))}')
    null_count = sum(1 for b in blends.values() if b is None)
    print(f'[ticker-quality] {null_count} tickers had NULL blend (no window with N >= {SAMPLE_SIZE_FLOOR})')

    if not write_db:
        print('[ticker-quality] WRITE_DB not set — skipping UPSERT')
    else:
        with conn.cursor() as cur:
            # Batched UPSERT (500 rows per batch per project's batched-insert convention)
            BATCH = 500
            for i in range(0, len(upsert_rows), BATCH):
                batch = upsert_rows[i:i + BATCH]
                execute_values(
                    cur,
                    """
                    INSERT INTO lottery_ticker_stats (
                      ticker, inversion_lcb_21d, inversion_lcb_90d,
                      inversion_blend, inversion_quintile,
                      inversion_n_21d, inversion_n_90d, updated_at
                    )
                    VALUES %s
                    ON CONFLICT (ticker) DO UPDATE SET
                      inversion_lcb_21d = EXCLUDED.inversion_lcb_21d,
                      inversion_lcb_90d = EXCLUDED.inversion_lcb_90d,
                      inversion_blend = EXCLUDED.inversion_blend,
                      inversion_quintile = EXCLUDED.inversion_quintile,
                      inversion_n_21d = EXCLUDED.inversion_n_21d,
                      inversion_n_90d = EXCLUDED.inversion_n_90d,
                      updated_at = NOW()
                    """,
                    [(*r, None) for r in batch],  # NOW() fills updated_at
                    template='(%s, %s, %s, %s, %s, %s, %s, NOW())',
                )
        conn.commit()
        print(f'[ticker-quality] UPSERTed {len(upsert_rows)} rows into lottery_ticker_stats')

    if sim_csv_path is not None:
        _write_tune_csv(conn, quintiles, sim_csv_path)


INVERSION_BONUS_BY_QUINTILE = {1: -5, 2: -2, 3: 0, 4: 3, 5: 5}


def _write_tune_csv(conn, quintiles: dict[str, int], out_path: Path) -> None:
    """Simulate quality_adjusted_score for the last 90d of fires and emit a
    CSV that lets the operator pick Tier 1/2 cutoffs hitting the 40-50/day target.
    """
    import csv
    from collections import defaultdict

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, underlying_symbol, fired_at::date AS fire_date,
                   combined_score
            FROM lottery_finder_fires
            WHERE fired_at >= NOW() - INTERVAL '90 days'
              AND combined_score IS NOT NULL
            """
        )
        fires = cur.fetchall()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    daily_passes: dict[tuple[int, int], dict] = defaultdict(lambda: defaultdict(int))
    with out_path.open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow([
            'fire_id', 'ticker', 'fire_date',
            'combined_score', 'quintile', 'bonus',
            'quality_adjusted_score', 'would_be_filtered',
        ])
        for fid, ticker, fire_date, score in fires:
            q = quintiles.get(ticker)
            bonus = INVERSION_BONUS_BY_QUINTILE.get(q, 0) if q is not None else 0
            qas = float(score) + bonus
            filtered = q in (1, 2) if q is not None else False
            w.writerow([fid, ticker, fire_date, score, q, bonus, qas, int(filtered)])
            if not filtered:
                for t1 in range(20, 25):
                    for t2 in range(14, 18):
                        if t2 >= t1:
                            continue
                        if qas >= t2:
                            daily_passes[(t1, t2)][fire_date] += 1

    print(f'[ticker-quality] wrote simulation CSV to {out_path}')
    print('[ticker-quality] median daily Tier 1+2 count by cutoff:')
    import statistics
    print('  tier1  tier2  median/day')
    for (t1, t2), per_day in sorted(daily_passes.items()):
        med = statistics.median(per_day.values()) if per_day else 0
        marker = '  <-- target' if 40 <= med <= 50 else ''
        print(f'  >={t1:>2}   >={t2:>2}     {med:>5.1f}{marker}')
```

- [ ] **Step 5.3: Wire the refit into `main()`**

Find the end of the existing `main()` flow (where DB connection is still open). Add:

```python
    sim_csv = Path('docs/tmp/lottery-quality-sim-2026-05-19.csv')
    refit_ticker_inversion_stats(
        conn,
        write_db=bool(int(os.environ.get('WRITE_DB', '0'))),
        sim_csv_path=sim_csv,
    )
```

Place it **after** the existing flow-inversion enrichment so the freshly-written `realized_flow_inversion_pct` values are part of the rolling window.

- [ ] **Step 5.4: Smoke-test the refit on a dry run**

Run: `WRITE_DB=0 ml/.venv/bin/python scripts/enrich_lottery_outcomes.py`
Expected: prints quintile distribution + NULL count + the cutoff-search table; does NOT write to DB; CSV written to `docs/tmp/lottery-quality-sim-2026-05-19.csv`.

If the cutoff table shows zero or one combination in [40, 50], note it — Step 5.7 may need to widen the bonus or filter shape. If the table looks sensible (multiple combinations in range), proceed.

- [ ] **Step 5.5: Run all Phase 2 Python tests**

Run: `ml/.venv/bin/python -m pytest ml/tests/test_lottery_ticker_quality.py -v`
Expected: all PASS.

- [ ] **Step 5.6: Live run — populate the table**

Run: `WRITE_DB=1 ml/.venv/bin/python scripts/enrich_lottery_outcomes.py`
Verify: `psql $DATABASE_URL -c "SELECT inversion_quintile, COUNT(*) FROM lottery_ticker_stats GROUP BY 1 ORDER BY 1"` — should show 1..5 with similar counts plus a NULL bucket for cold-start tickers.

- [ ] **Step 5.7: Pick the locked cutoffs from the CSV**

Open `docs/tmp/lottery-quality-sim-2026-05-19.csv` and the printed median table. Pick the `(tier1_cutoff, tier2_cutoff)` pair whose median daily Tier 1+2 count is closest to **45**. Record both numbers — they go into the spec and into the constants in Phase 3.

- [ ] **Step 5.8: Update the spec with locked cutoffs**

In `docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md`, replace the row in the "Thresholds / constants" table that says `Tier cutoffs (post-bonus) | TBD — locked from Phase 2 CSV` with the chosen values, e.g.:

```
| Tier 1 cutoff (post-bonus) | quality_adjusted_score >= 22 | Phase 2 CSV — median 43/day |
| Tier 2 cutoff (post-bonus) | quality_adjusted_score >= 16 | Phase 2 CSV — median 43/day |
```

Also update the "Locked constants" block at the top of THIS plan file (under `# Lottery Inversion-Quality Filter Implementation Plan`).

- [ ] **Step 5.9: Full review pass (Python + spec)**

Run: `ml/.venv/bin/python -m pytest ml/tests/ -v` (Python-only — TypeScript side is unchanged this phase)
Expected: all Python tests PASS, including pre-existing ones.

- [ ] **Step 5.10: Code-reviewer subagent**

Dispatch: "Review the ml/refit additions in scripts/enrich_lottery_outcomes.py, the new ml/tests/test_lottery_ticker_quality.py, and the spec table update. Pattern adherence to the existing enrichment script; correct Wilson math; quintile-cut handles edge cases; batched UPSERT; CSV writes to docs/tmp/; spec cutoffs match printed median."

- [ ] **Step 5.11: Commit + push atomically**

```bash
git add scripts/enrich_lottery_outcomes.py \
        ml/tests/test_lottery_ticker_quality.py \
        docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md \
        docs/superpowers/plans/2026-05-19-lottery-inversion-quality-filter.md && \
git commit -m "$(cat <<'EOF'
feat(lottery): Compute per-ticker inversion-quality stats nightly

Append a refit stage to scripts/enrich_lottery_outcomes.py that computes
Wilson 95% LCB on P(realized_flow_inversion_pct >= 50) over rolling 21d/90d
windows per ticker, blends them (0.6 * 21d + 0.4 * 90d), assigns quintiles
across the ticker universe, and UPSERTs into lottery_ticker_stats columns
added by migration 175. Also writes a tune-before-ship CSV to docs/tmp/
so the operator can lock Tier 1/2 cutoffs that hit the 40-50/day target.

Cutoffs locked into the spec from this run's CSV.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

# Phase 3 — API: Read, Score, Filter

### Task 6: `lottery-inversion-bonus.ts` module

**Files:**
- Create: `api/_lib/lottery-inversion-bonus.ts`
- Test: `api/__tests__/lottery-inversion-bonus.test.ts`

- [ ] **Step 6.1: Write the failing test file**

Create `api/__tests__/lottery-inversion-bonus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  inversionQualityBonus,
  qualityAdjustedScore,
  INVERSION_BONUS_BY_QUINTILE,
} from '../_lib/lottery-inversion-bonus.js';

describe('inversionQualityBonus', () => {
  it('returns -5 for quintile 1', () => {
    expect(inversionQualityBonus(1)).toBe(-5);
  });
  it('returns -2 for quintile 2', () => {
    expect(inversionQualityBonus(2)).toBe(-2);
  });
  it('returns 0 for quintile 3', () => {
    expect(inversionQualityBonus(3)).toBe(0);
  });
  it('returns 3 for quintile 4', () => {
    expect(inversionQualityBonus(4)).toBe(3);
  });
  it('returns 5 for quintile 5', () => {
    expect(inversionQualityBonus(5)).toBe(5);
  });
  it('returns 0 for null', () => {
    expect(inversionQualityBonus(null)).toBe(0);
  });
  it('returns 0 for out-of-range 0', () => {
    expect(inversionQualityBonus(0)).toBe(0);
  });
  it('returns 0 for out-of-range 6', () => {
    expect(inversionQualityBonus(6)).toBe(0);
  });
});

describe('qualityAdjustedScore', () => {
  it('adds the bonus to combined score', () => {
    expect(qualityAdjustedScore(18, 5)).toBe(23);
    expect(qualityAdjustedScore(18, 1)).toBe(13);
    expect(qualityAdjustedScore(18, null)).toBe(18);
  });
});

describe('INVERSION_BONUS_BY_QUINTILE', () => {
  it('exposes the mapping as a readonly record', () => {
    expect(INVERSION_BONUS_BY_QUINTILE).toEqual({
      1: -5,
      2: -2,
      3: 0,
      4: 3,
      5: 5,
    });
  });
});
```

- [ ] **Step 6.2: Run test — verify it fails**

Run: `npx vitest run api/__tests__/lottery-inversion-bonus.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 6.3: Implement `lottery-inversion-bonus.ts`**

Create `api/_lib/lottery-inversion-bonus.ts`:

```ts
/**
 * Inversion-quality bonus: maps a per-ticker inversion quintile
 * (1..5, NULL for cold-start tickers) to an additive score adjustment.
 *
 * Bonus shape is locked in docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md.
 * NULL quintile -> 0 bonus (cold-start protection — never penalize a
 * ticker that doesn't have history yet).
 */

export const INVERSION_BONUS_BY_QUINTILE: Readonly<Record<number, number>> = {
  1: -5,
  2: -2,
  3: 0,
  4: 3,
  5: 5,
};

export function inversionQualityBonus(quintile: number | null): number {
  if (quintile == null) return 0;
  return INVERSION_BONUS_BY_QUINTILE[quintile] ?? 0;
}

export function qualityAdjustedScore(
  combinedScore: number,
  quintile: number | null,
): number {
  return combinedScore + inversionQualityBonus(quintile);
}
```

- [ ] **Step 6.4: Run test — verify it passes**

Run: `npx vitest run api/__tests__/lottery-inversion-bonus.test.ts`
Expected: all PASS.

### Task 7: `lottery-tier.ts` module

**Files:**
- Create: `api/_lib/lottery-tier.ts`
- Test: `api/__tests__/lottery-tier.test.ts`

> **Note:** The cutoff constants below assume Tier 1 ≥ 22, Tier 2 ≥ 16. Replace with the actual values locked in Phase 2 Step 5.8 before completing this task.

- [ ] **Step 7.1: Write the failing test file**

Create `api/__tests__/lottery-tier.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  tierFromQualityScore,
  TIER_CUTOFFS_V2,
} from '../_lib/lottery-tier.js';

describe('tierFromQualityScore', () => {
  const { tier1MinScore, tier2MinScore } = TIER_CUTOFFS_V2;

  it('returns tier1 at and above tier1MinScore', () => {
    expect(tierFromQualityScore(tier1MinScore)).toBe('tier1');
    expect(tierFromQualityScore(tier1MinScore + 1)).toBe('tier1');
  });
  it('returns tier2 at tier2MinScore', () => {
    expect(tierFromQualityScore(tier2MinScore)).toBe('tier2');
  });
  it('returns tier2 between cutoffs', () => {
    expect(tierFromQualityScore(tier1MinScore - 1)).toBe('tier2');
  });
  it('returns tier3 below tier2MinScore', () => {
    expect(tierFromQualityScore(tier2MinScore - 1)).toBe('tier3');
  });
  it('returns tier3 for null', () => {
    expect(tierFromQualityScore(null)).toBe('tier3');
  });
});
```

- [ ] **Step 7.2: Run test — verify it fails**

Run: `npx vitest run api/__tests__/lottery-tier.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7.3: Implement `lottery-tier.ts`**

Create `api/_lib/lottery-tier.ts`:

```ts
/**
 * V2 tier classification — operates on `qualityAdjustedScore` (combined_score +
 * inversion bonus) instead of bare combined_score. Cutoffs are locked from
 * the Phase 2 simulation CSV; see
 * docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md.
 *
 * Legacy `lotteryScoreTier()` in lottery-score-weights.ts is preserved as a
 * deprecated re-export for any external caller.
 */

import type { LotteryScoreTier } from './lottery-score-weights.js';

// REPLACE with values from Phase 2 Step 5.8 before merging
export const TIER_CUTOFFS_V2 = {
  tier1MinScore: 22,
  tier2MinScore: 16,
} as const;

export function tierFromQualityScore(
  score: number | null,
): LotteryScoreTier {
  if (score == null) return 'tier3';
  if (score >= TIER_CUTOFFS_V2.tier1MinScore) return 'tier1';
  if (score >= TIER_CUTOFFS_V2.tier2MinScore) return 'tier2';
  return 'tier3';
}
```

- [ ] **Step 7.4: Run test — verify it passes**

Run: `npx vitest run api/__tests__/lottery-tier.test.ts`
Expected: all PASS.

### Task 8: Validation schema — add `showAll`

**Files:**
- Modify: `api/_lib/validation/lottery.ts`
- Test: `api/__tests__/lottery-finder.test.ts` (or wherever the validation schema is exercised)

- [ ] **Step 8.1: Add `showAll` to the schema**

In `api/_lib/validation/lottery.ts`, inside the `lotteryFinderQuerySchema = z.object({...})` block, add (alongside the other booleans like `reload`):

```ts
  showAll: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
```

This follows the existing `reload` / `cheapCallPm` pattern in the same file (lines 47-58).

- [ ] **Step 8.2: Quick parse test — confirm schema accepts and rejects correctly**

Run an ad-hoc check (or add a one-off vitest line):

```bash
node --input-type=module -e "
import { lotteryFinderQuerySchema } from './api/_lib/validation/lottery.ts';
console.log(lotteryFinderQuerySchema.safeParse({ showAll: 'true' }));
console.log(lotteryFinderQuerySchema.safeParse({ showAll: 'false' }));
console.log(lotteryFinderQuerySchema.safeParse({}));
"
```

(Or just run the existing endpoint tests in Step 10.4 — they exercise the schema.)

### Task 9: Extend the endpoint SELECTs

**Files:**
- Modify: `api/lottery-finder.ts` (4 SELECTs at lines 441, 516, 590, 879 per current code)

- [ ] **Step 9.1: Add the new columns to each SELECT**

For **each** of the four SELECTs that LEFT JOIN `lottery_ticker_stats s`, add the following columns alongside the existing `s.high_peak_rate`:

```sql
          s.inversion_blend       AS ticker_inversion_blend,
          s.inversion_quintile    AS ticker_inversion_quintile,
          s.inversion_n_21d       AS ticker_inversion_n_21d,
          s.inversion_n_90d       AS ticker_inversion_n_90d,
```

Use `grep -n "ticker_high_peak_rate" api/lottery-finder.ts` to find every SELECT and confirm all four are updated.

- [ ] **Step 9.2: Extend the row type interface**

In `api/lottery-finder.ts`, find the row interface (search for `ticker_high_peak_rate: DbNullableNumeric`) and add:

```ts
  ticker_inversion_blend: DbNullableNumeric;
  ticker_inversion_quintile: DbNullableNumeric;
  ticker_inversion_n_21d: DbNullableNumeric;
  ticker_inversion_n_90d: DbNullableNumeric;
```

### Task 10: Filter + serialize

**Files:**
- Modify: `api/lottery-finder.ts`
- Test: `api/__tests__/lottery-finder-endpoint.test.ts`

- [ ] **Step 10.1: Write the failing endpoint test for the filter**

In `api/__tests__/lottery-finder-endpoint.test.ts`, add a new test block (mirror the existing endpoint test setup — `vi.mocked(getDb)` with `mockResolvedValueOnce` matching the SQL call order):

```ts
describe('inversion-quality filter', () => {
  it('suppresses fires whose ticker inversion_quintile is 1 or 2 by default', async () => {
    // Mock 4 fires: tickers in quintiles 1, 2, 3, and null
    const mockRows = [
      makeFireRow({ ticker: 'BADQ1', ticker_inversion_quintile: 1, combined_score: 18 }),
      makeFireRow({ ticker: 'BADQ2', ticker_inversion_quintile: 2, combined_score: 18 }),
      makeFireRow({ ticker: 'OKQ3',  ticker_inversion_quintile: 3, combined_score: 18 }),
      makeFireRow({ ticker: 'NEW',   ticker_inversion_quintile: null, combined_score: 18 }),
    ];
    // ... mock getDb sequence ...

    const res = await callHandler(reqWith({ /* no showAll */ }));
    const body = await res.json();
    const tickers = body.rows.map((r: any) => r.ticker);
    expect(tickers).not.toContain('BADQ1');
    expect(tickers).not.toContain('BADQ2');
    expect(tickers).toContain('OKQ3');
    expect(tickers).toContain('NEW');  // NULL quintile is never filtered
  });

  it('returns all rows including Q1/Q2 when showAll=true', async () => {
    // same mock rows ...
    const res = await callHandler(reqWith({ showAll: 'true' }));
    const body = await res.json();
    const tickers = body.rows.map((r: any) => r.ticker);
    expect(tickers).toContain('BADQ1');
    expect(tickers).toContain('BADQ2');
    expect(tickers).toContain('OKQ3');
    expect(tickers).toContain('NEW');
  });

  it('computes qualityAdjustedScore from combined_score + quintile bonus', async () => {
    const mockRows = [
      makeFireRow({ ticker: 'TOP', ticker_inversion_quintile: 5, combined_score: 18 }),
    ];
    // mock ...
    const res = await callHandler(reqWith({ showAll: 'true' }));
    const body = await res.json();
    expect(body.rows[0].qualityAdjustedScore).toBe(23);  // 18 + 5
  });
});
```

Reuse the existing test helper conventions (likely `makeFireRow` or an equivalent factory; if not present, define a minimal helper in the same file). If `makeFireRow` does not exist, build one locally that returns a row matching the existing row shape with the new fields defaulted.

- [ ] **Step 10.2: Run test — verify it fails**

Run: `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts -t "inversion-quality filter"`
Expected: FAIL.

- [ ] **Step 10.3: Implement the filter + serialize**

In `api/lottery-finder.ts`, after the existing row mapping that produces the response payload (search for `realizedFlowInversionPct: num(r.realized_flow_inversion_pct)` around line 1256), add:

```ts
          inversionQuintile: r.ticker_inversion_quintile != null
            ? Number(r.ticker_inversion_quintile)
            : null,
          inversionBlend: num(r.ticker_inversion_blend),
          inversionN21d: r.ticker_inversion_n_21d != null
            ? Number(r.ticker_inversion_n_21d)
            : null,
          inversionN90d: r.ticker_inversion_n_90d != null
            ? Number(r.ticker_inversion_n_90d)
            : null,
          qualityAdjustedScore: qualityAdjustedScore(
            Number(r.combined_score ?? 0),
            r.ticker_inversion_quintile != null
              ? Number(r.ticker_inversion_quintile)
              : null,
          ),
          tier: tierFromQualityScore(
            qualityAdjustedScore(
              Number(r.combined_score ?? 0),
              r.ticker_inversion_quintile != null
                ? Number(r.ticker_inversion_quintile)
                : null,
            ),
          ),
```

Add the imports at the top of the file:

```ts
import { qualityAdjustedScore } from './_lib/lottery-inversion-bonus.js';
import { tierFromQualityScore } from './_lib/lottery-tier.js';
```

Then apply the filter — find the post-query row collection (likely `const rows = result.map(...)`). After mapping but before pagination/return, add:

```ts
const filteredRows = showAll
  ? rows
  : rows.filter((r) =>
      r.inversionQuintile == null || r.inversionQuintile > 2,
    );
```

Replace any downstream reference to `rows` (in the response payload + pagination) with `filteredRows`.

The `showAll` variable is destructured from the validated query — locate the existing destructure (look for where `reload` or `cheapCallPm` is unpacked) and add `showAll`.

- [ ] **Step 10.4: Run test — verify it passes**

Run: `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts -t "inversion-quality filter"`
Expected: all PASS.

- [ ] **Step 10.5: Update `lottery-score-weights.ts` to preserve back-compat**

In `api/_lib/lottery-score-weights.ts`, add a comment at the top of `lotteryScoreTier`:

```ts
/**
 * @deprecated Use tierFromQualityScore from './lottery-tier.js' for new
 * call sites. This function still tiers on bare combined_score, NOT on
 * quality_adjusted_score. Kept exported for any external caller until
 * they migrate.
 */
```

No behavior change — this is a comment-only edit.

- [ ] **Step 10.6: Full review pass**

Run: `npm run review`
Expected: tsc + eslint + prettier + vitest --coverage all clean.

- [ ] **Step 10.7: Code-reviewer subagent**

Dispatch: "Review Phase 3 diff (lottery-inversion-bonus.ts, lottery-tier.ts, validation/lottery.ts showAll, lottery-finder.ts SELECTs/filter/serialize, lottery-score-weights.ts deprecation note, endpoint test additions). Confirm: (a) all four SELECTs got the new columns; (b) filter only suppresses Q1/Q2 with showAll=false and NULL is never filtered; (c) imports use .js suffix per project convention; (d) test coverage hits filter on/off + qualityAdjustedScore math + tier classification."

- [ ] **Step 10.8: Commit + push atomically**

```bash
git add api/_lib/lottery-inversion-bonus.ts \
        api/_lib/lottery-tier.ts \
        api/_lib/lottery-score-weights.ts \
        api/_lib/validation/lottery.ts \
        api/lottery-finder.ts \
        api/__tests__/lottery-inversion-bonus.test.ts \
        api/__tests__/lottery-tier.test.ts \
        api/__tests__/lottery-finder-endpoint.test.ts && \
git commit -m "$(cat <<'EOF'
feat(lottery): Apply inversion-quality bonus and Q1/Q2 filter at SELECT

Add lottery-inversion-bonus.ts and lottery-tier.ts; endpoint LEFT JOINs the
new lottery_ticker_stats columns, computes qualityAdjustedScore at SELECT
time, classifies tier via the new cutoffs, and suppresses fires whose
ticker is in inversion quintile 1 or 2 unless ?showAll=1 is passed. NULL
quintile (cold-start tickers) is never filtered and bonus is 0.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

# Phase 4 — Frontend: Chip, Tooltip, Escape-Hatch Toggle

### Task 11: Extend the frontend row type

**Files:**
- Modify: `src/components/LotteryFinder/types.ts`

- [ ] **Step 11.1: Add new fields to `LotteryRow` (or equivalent row interface)**

In `src/components/LotteryFinder/types.ts`, find the row interface (it mirrors the API row shape — search for `realizedFlowInversionPct`) and add:

```ts
  inversionQuintile: number | null;
  inversionBlend: number | null;
  inversionN21d: number | null;
  inversionN90d: number | null;
  qualityAdjustedScore: number;
  tier: ScoreTier;  // re-derived field; was previously local-derived
```

If `tier` is already present (it likely is — `ScoreTier` is imported on line 10), leave the existing declaration in place and just note that the server now sets it.

### Task 12: Tier badge consumes `qualityAdjustedScore`

**Files:**
- Modify: `src/components/LotteryFinder/LotteryRow.tsx` (1218 lines)

- [ ] **Step 12.1: Find the tier badge component**

Run: `grep -n "tier\|ScoreTier\|tier1\|tier2\|tier3" src/components/LotteryFinder/LotteryRow.tsx | head -20`

Identify the prop / variable currently feeding the badge component (likely a derived `tier` from `combined_score`).

- [ ] **Step 12.2: Switch the badge input**

Replace the local derivation with the server-provided `row.tier` field. If the row component was previously calling `lotteryScoreTier(row.combinedScore)` to derive tier locally, replace it with direct usage of `row.tier`.

If a derivation helper imports `lotteryScoreTier` solely for this purpose and no longer needs the import, remove the import per the orphan-cleanup rule.

### Task 13: Quintile chip

**Files:**
- Modify: `src/components/LotteryFinder/LotteryRow.tsx`

- [ ] **Step 13.1: Add the chip near the tier pill**

Find the tier pill JSX (use the badge ref from Step 12.1). Adjacent to it, render:

```tsx
{row.inversionQuintile != null && (
  <span
    className={cn(
      'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
      row.inversionQuintile === 1 && 'bg-red-900/40 text-red-300',
      row.inversionQuintile === 2 && 'bg-amber-900/40 text-amber-300',
      row.inversionQuintile === 3 && 'bg-slate-800 text-slate-400',
      row.inversionQuintile === 4 && 'bg-emerald-900/40 text-emerald-300',
      row.inversionQuintile === 5 && 'bg-emerald-800 text-emerald-200',
    )}
    title={
      row.inversionBlend != null
        ? `Inversion-win rate: ${(row.inversionBlend * 100).toFixed(1)}% (Wilson 95% LCB)\n` +
          `Sample: n=${row.inversionN21d ?? 0} (21d) / n=${row.inversionN90d ?? 0} (90d)`
        : undefined
    }
  >
    Q{row.inversionQuintile}
  </span>
)}
```

If a `cn()` helper isn't already imported in this file, look up the project's convention (likely `clsx`). Match what's already used elsewhere in this file.

### Task 14: Escape-hatch toggle in `useAppState`

**Files:**
- Modify: `src/hooks/useAppState.ts`

- [ ] **Step 14.1: Find the useAppState file**

Run: `ls src/hooks/useAppState.ts`

If the file exists and exports a hook, add the toggle state:

```ts
// Lottery Finder: bypass the bottom-quintile inversion-quality filter
const [showFilteredLotteryTickers, setShowFilteredLotteryTickers] =
  useState(false);
```

Add `showFilteredLotteryTickers` and `setShowFilteredLotteryTickers` to the return object.

### Task 15: Wire the toggle into the lottery feed fetch

**Files:**
- Modify: wherever the lottery feed is fetched (find with grep)

- [ ] **Step 15.1: Find the fetch call**

Run: `grep -rln "/api/lottery-finder" src/ | head -10`

- [ ] **Step 15.2: Append `?showAll=1` when toggle is on**

In the fetch URL construction, add `showAll=true` to the query string when `showFilteredLotteryTickers` is true. Pass through to the hook that builds the URL.

### Task 16: Render the toggle UI

**Files:**
- Modify: the component that hosts the exit-policy chip selector (likely a parent of `LotteryRow`)

- [ ] **Step 16.1: Find the exit-policy chip selector**

Run: `grep -rln "EXIT_POLICY_LABELS\|realizedTrail30_10Pct" src/components/LotteryFinder/`

- [ ] **Step 16.2: Add a toggle next to the chip selector**

```tsx
<label className="flex items-center gap-2 text-sm text-slate-300">
  <input
    type="checkbox"
    checked={showFilteredLotteryTickers}
    onChange={(e) => setShowFilteredLotteryTickers(e.target.checked)}
  />
  Show filtered tickers (Q1/Q2)
</label>
```

Use whichever toggle / switch primitive the project already uses elsewhere — match existing styling.

### Task 17: Playwright e2e spec

**Files:**
- Create: `e2e/lottery-inversion-filter.spec.ts`

- [ ] **Step 17.1: Write the e2e spec**

Use the existing e2e/ spec conventions (semantic selectors via `getByRole`, axe-core via `injectAxe` + `checkA11y`). Reference an existing spec like `e2e/lottery-finder.spec.ts` (or the closest existing one — run `ls e2e/lottery*` to find it) for setup boilerplate.

```ts
import { test, expect } from '@playwright/test';
import { injectAxe, checkA11y } from 'axe-playwright';

test.describe('Lottery inversion-quality filter', () => {
  test('quintile chip renders with tooltip', async ({ page }) => {
    await page.goto('/');
    await injectAxe(page);
    // Navigate to lottery finder section
    // ... (match existing nav pattern)
    const chip = page.locator('[data-testid="lottery-quintile-chip"]').first();
    await expect(chip).toBeVisible();
    const tooltipText = await chip.getAttribute('title');
    expect(tooltipText).toMatch(/Inversion-win rate:/);
    await checkA11y(page);
  });

  test('escape hatch toggle reveals Q1/Q2 rows', async ({ page }) => {
    await page.goto('/');
    // Count rows before toggle
    const before = await page.locator('[data-testid="lottery-row"]').count();
    await page.getByLabel('Show filtered tickers').check();
    // wait for re-fetch
    await page.waitForResponse(/showAll=true/);
    const after = await page.locator('[data-testid="lottery-row"]').count();
    expect(after).toBeGreaterThan(before);
  });
});
```

You will need to add `data-testid="lottery-quintile-chip"` to the chip span in Task 13 and `data-testid="lottery-row"` to the row container in `LotteryRow.tsx` if they aren't already present.

- [ ] **Step 17.2: Run the e2e spec**

Run: `npx playwright test e2e/lottery-inversion-filter.spec.ts`
Expected: PASS.

### Task 18: Full review + commit

- [ ] **Step 18.1: Full review pass**

Run: `npm run review`
Expected: all clean.

- [ ] **Step 18.2: Code-reviewer subagent**

Dispatch: "Review Phase 4 diff (LotteryFinder/types.ts row shape, LotteryRow.tsx tier-badge + quintile chip + tooltip + data-testid, useAppState.ts toggle state, feed-fetch URL builder, host component toggle UI, e2e spec). Confirm: (a) NULL quintile hides the chip (no Q? placeholder); (b) tooltip uses native title attribute or matches existing tooltip primitive; (c) toggle is off-by-default; (d) URL query param is `showAll=true` not `showAll=1`; (e) e2e spec covers both visibility and toggle behavior + axe-core a11y."

- [ ] **Step 18.3: Commit + push atomically**

```bash
git add src/components/LotteryFinder/types.ts \
        src/components/LotteryFinder/LotteryRow.tsx \
        src/hooks/useAppState.ts \
        e2e/lottery-inversion-filter.spec.ts && \
# Plus any host-component file(s) found in Step 16.1
git commit -m "$(cat <<'EOF'
feat(lottery-ui): Show inversion-quality chip and escape-hatch toggle

Lottery row now shows a Q1-Q5 chip near the tier pill (with a tooltip
showing the Wilson LCB and sample sizes) and the feed parent has a
"Show filtered tickers" toggle that flips ?showAll=true on the API fetch.
Tier badge consumes server-provided tier (computed from qualityAdjustedScore)
instead of deriving it locally from combined_score.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

# Phase 5 — Operational Guard (Sentry Staleness Warning)

### Task 19: Staleness check on `/api/cron/refresh-vix1d`

**Files:**
- Modify: `api/cron/refresh-vix1d.ts`
- Test: `api/__tests__/refresh-vix1d.test.ts` (if exists; otherwise add coverage to the existing test pattern)

- [ ] **Step 19.1: Find the existing cron handler + tests**

Run: `ls api/cron/refresh-vix1d.ts && ls api/__tests__/refresh-vix1d.test.ts 2>/dev/null`

If the test file doesn't exist, look at a similar cron's test (e.g. `api/__tests__/fetch-flow.test.ts`) for the pattern.

- [ ] **Step 19.2: Write the failing staleness test**

In the appropriate test file, add:

```ts
import * as Sentry from '@sentry/node';

it('captures a Sentry warning when lottery_ticker_stats is stale (>3 days)', async () => {
  vi.mocked(getDb).mockReturnValue(mockSql);
  mockSql
    .mockResolvedValueOnce([{ id: 'vix1d-row' }])  // existing flow
    .mockResolvedValueOnce([{ days: '4.5' }]);     // staleness check returns >3 days

  const captureSpy = vi.spyOn(Sentry, 'captureMessage');
  process.env.CRON_SECRET = 'test-secret';

  await handler(makeReq({ headers: { authorization: 'Bearer test-secret' } }));

  expect(captureSpy).toHaveBeenCalledWith(
    expect.stringContaining('lottery_ticker_stats stale'),
    expect.objectContaining({ level: 'warning' }),
  );
});

it('does NOT capture when lottery_ticker_stats is fresh', async () => {
  vi.mocked(getDb).mockReturnValue(mockSql);
  mockSql
    .mockResolvedValueOnce([{ id: 'vix1d-row' }])
    .mockResolvedValueOnce([{ days: '0.5' }]);  // 12 hours old, fresh

  const captureSpy = vi.spyOn(Sentry, 'captureMessage');
  process.env.CRON_SECRET = 'test-secret';

  await handler(makeReq({ headers: { authorization: 'Bearer test-secret' } }));

  expect(captureSpy).not.toHaveBeenCalled();
});
```

Match the existing mock-sequence pattern in the file. The exact mock structure depends on what `refresh-vix1d.ts` already does — read it first.

- [ ] **Step 19.3: Run test — verify it fails**

Run: `npx vitest run api/__tests__/refresh-vix1d.test.ts -t staleness`
Expected: FAIL.

- [ ] **Step 19.4: Add the staleness check to the handler**

In `api/cron/refresh-vix1d.ts`, at the end of the existing handler logic (after the main vix1d refresh, before the response), add:

```ts
  // Staleness guard for the lottery inversion-quality refit. The refit is
  // a manual nightly step; warn if the table hasn't been updated in >3 days.
  try {
    const ageRows = await sql`
      SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 86400 AS days
      FROM lottery_ticker_stats
    `;
    const days = Number(ageRows[0]?.days ?? 0);
    if (days > 3) {
      Sentry.captureMessage('lottery_ticker_stats stale', {
        level: 'warning',
        extra: { ageDays: days },
      });
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { source: 'lottery-ticker-stats-staleness-check' },
    });
  }
```

Add the Sentry import if not present: `import * as Sentry from '@sentry/node';`.

- [ ] **Step 19.5: Run test — verify it passes**

Run: `npx vitest run api/__tests__/refresh-vix1d.test.ts -t staleness`
Expected: PASS.

- [ ] **Step 19.6: Full review pass**

Run: `npm run review`
Expected: all clean.

- [ ] **Step 19.7: Code-reviewer subagent**

Dispatch: "Review the staleness guard added to /api/cron/refresh-vix1d. Confirm: (a) it's the LAST step in the handler so a failure doesn't block the vix1d refresh; (b) it has its own try/catch around the SQL so a transient DB error doesn't fail the cron; (c) test mocks match the new SQL sequence."

- [ ] **Step 19.8: Commit + push atomically**

```bash
git add api/cron/refresh-vix1d.ts api/__tests__/refresh-vix1d.test.ts && \
git commit -m "$(cat <<'EOF'
feat(observability): Warn when lottery_ticker_stats refit is stale

Append a staleness check to /api/cron/refresh-vix1d (runs once per trading
morning at 11 UTC). If MAX(updated_at) on lottery_ticker_stats is older
than 3 days, capture a Sentry warning. The refit is a manual nightly step;
this catches the case where it gets skipped for several days and the
ticker-quality filter falls out of date.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" && git push origin main
```

---

## Self-Review (per writing-plans skill)

**Spec coverage:**
- ✅ Migration (Section 2.1 / Phase 1)
- ✅ ML refit + tune-CSV (Section 2.2 / Phase 2)
- ✅ Path A SELECT-time scoring (Section 2.3 / Phase 3 Task 6, 7, 10)
- ✅ Q1/Q2 server-side filter (Phase 3 Task 10)
- ✅ `?showAll=1` escape hatch (Phase 3 Task 8, 10; Phase 4 Task 14, 15, 16)
- ✅ Quintile chip + tooltip (Phase 4 Task 13)
- ✅ Tier badge migration to qualityAdjustedScore (Phase 4 Task 12)
- ✅ Playwright + axe-core (Phase 4 Task 17)
- ✅ Sentry staleness guard (Phase 5)
- ✅ Test coverage at every layer (every Task has TDD steps)
- ✅ Code-reviewer subagent at end of every phase

**Placeholder scan:**
- One intentional placeholder: tier cutoff values in `lottery-tier.ts` (Step 7.3) are stamped as `22 / 16` with an explicit instruction to replace with Phase 2's locked values. This is the *only* TBD in the plan and is structurally unavoidable (the values come from the simulation run).

**Type consistency:**
- `inversionQuintile: number | null` — used identically in `types.ts`, `lottery-inversion-bonus.ts`, the endpoint serializer, the filter predicate, and the chip JSX.
- `qualityAdjustedScore: number` — set on the row in Step 10.3, consumed by Step 12.2 (badge) and Step 7.x (tier classification).
- `tier: ScoreTier` — produced server-side in Step 10.3, consumed in Step 12.2.
- `showAll: boolean` — Zod schema in Step 8.1 transforms to boolean; destructured in Step 10.3.

No mismatches found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-lottery-inversion-quality-filter.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Matches your `feedback_subagent_driven` standing preference.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
