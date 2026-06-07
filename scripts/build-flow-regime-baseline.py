#!/usr/bin/env python3
"""Build the Flow Regime baseline artifact (Phase 1 of flow-regime-badge spec).

Reads the 106-day Desktop full-tape parquet archive, RESTRICTS it to the
uw-stream WS Lottery universe (so the historical denominators match the
live ~50-ticker `ws_option_trades` stream), and computes per (ET day,
30-min slot) two detrend-robust ratio metrics:

  net_delta_tilt    = Σ(side_sign · delta · size) / Σ(|delta| · size)
  idx0dte_put_share = Σ(premium | 0DTE index put) / Σ(premium)

For each slot it then builds the historical DISTRIBUTION as a compact
percentile grid (1,5,10,...,90,95,99) across all days for that slot, and
writes `api/_lib/flow-regime-baseline.json` (small, committed artifact
consumed by the pure TS evaluator in api/_lib/flow-regime.ts).

VALIDATION: the same per-(day,slot) metrics are recomputed from Neon
`ws_option_trades` for the overlapping days (the WS stream began
2026-06-02) and compared to the full-tape-restricted values for those
same days. They should match closely (same underlying trades). The
comparison is logged to stdout and written to
docs/tmp/flow-regime-baseline-validation.txt. If they DON'T match the
script exits non-zero rather than ship a baseline whose live percentiles
would be meaningless.

DuckDB gotchas (confirmed against the archive, see spec):
  - MUST `SET TimeZone='UTC'`.
  - ET = (((executed_at::TIMESTAMP) AT TIME ZONE 'UTC')
            AT TIME ZONE 'America/New_York'). The `::TIMESTAMP` cast
    handles both tz-naive (early files) and tz-aware (late files)
    executed_at columns after union_by_name promotes them.
  - Cast decimals `::DOUBLE` (early files store DECIMAL, late files DOUBLE).
  - read_parquet(glob, union_by_name=true): schema varies across files
    (decimal vs float, naive vs aware ts, some files lack a `date` column),
    so the day is ALWAYS derived from the ET timestamp, never the `date`
    column.

Run:
  ml/.venv/bin/python scripts/build-flow-regime-baseline.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import date as date_cls
from pathlib import Path

import duckdb

try:
    import psycopg2
    from dotenv import dotenv_values
except ImportError:  # pragma: no cover - validation deps are optional at import
    psycopg2 = None  # type: ignore[assignment]
    dotenv_values = None  # type: ignore[assignment]

# ── Paths ────────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent
TAPE_GLOB = str(
    Path.home() / "Desktop" / "Eod-Full-Tape-parquet" / "*.parquet"
)
OUT_JSON = REPO_ROOT / "api" / "_lib" / "flow-regime-baseline.json"
VALIDATION_TXT = REPO_ROOT / "docs" / "tmp" / "flow-regime-baseline-validation.txt"
ENV_LOCAL = REPO_ROOT / ".env.local"

# ── Constants (mirror uw-stream/src/config.py _LOTTERY_TICKERS) ──────────────
# Hardcoded verbatim so the baseline universe is pinned to the artifact and the
# evaluator/cron read the IDENTICAL set out of the JSON. If config.py changes,
# update this list AND regenerate the baseline.

UNIVERSE: list[str] = sorted(
    {
        # V3 (Mode A 0DTE intraday)
        "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC", "SQQQ",
        "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM", "RKLB", "SOFI",
        "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER", "MSTR", "TQQQ", "RIOT",
        "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
        "SPXW",
        "CRWV", "IBIT", "ARM", "OKLO", "APLD", "IONQ",
        "HIMS", "CAR", "IREN", "ASTS", "NBIS", "CRCL", "LITE", "NVTS",
        # EXTENDED (Mode B DTE 1-3 trend)
        "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN",
        "PLTR", "AVGO", "GOOGL", "GOOG", "COIN", "HOOD", "MRVL",
        "ORCL", "AAPL",
        "QCOM", "NFLX", "LLY", "BABA", "NOW", "CRWD",
        "BE", "AAOI", "SHOP", "BA", "APP", "POET",
        "DELL", "CVNA", "RGTI", "IBM", "CSCO",
        "GME", "TLT",
    }
)

# Index symbols within the universe (used for idx0dte_put_share numerator).
INDEX_SET: list[str] = ["SPXW", "NDXP", "QQQ", "SPY", "IWM"]

BUCKET_MINUTES = 30
RTH_START_MIN = 570  # 09:30 ET in minutes-of-day
RTH_END_MIN = 960  # 16:00 ET
SLOT_COUNT = (RTH_END_MIN - RTH_START_MIN) // BUCKET_MINUTES  # 13 slots (0..12)

# Percentile grid stored per slot per metric.
PERCENTILES: list[int] = [1, 5, 10, 25, 50, 75, 90, 95, 99]

# Minimum prior days for a slot's percentile to be considered valid (spec).
MIN_DAYS_PER_SLOT = 15

# side_sign mapping. Tape derives side from the `tags` string; Neon has a
# discrete `side` column. Both collapse to the same {+1, -1, 0} mapping.
SIDE_SIGN_MAP = {"ask": 1, "bid": -1, "mid": 0, "no_side": 0}

# Validation tolerances. Same underlying trades → near-identical metrics. The
# tape is the EOD canonical archive and the WS stream is best-effort realtime,
# so we allow a small mean-abs-diff and require strong correlation.
MAX_MEAN_ABS_DIFF = 0.05
MIN_CORRELATION = 0.95


# ── SQL fragments ────────────────────────────────────────────────────────────

# Comma-separated quoted ticker lists for SQL IN (...).
_UNIVERSE_SQL = ", ".join(f"'{t}'" for t in UNIVERSE)
_INDEX_SQL = ", ".join(f"'{t}'" for t in INDEX_SET)

# Canonical ET timestamp expression (handles naive + aware after union).
_ET_EXPR = (
    "(((executed_at::TIMESTAMP) AT TIME ZONE 'UTC') "
    "AT TIME ZONE 'America/New_York')"
)


def _slot_expr(et_expr: str) -> str:
    """SQL expression for the 30-min slot index from an ET timestamp expr."""
    mod = f"(extract(hour FROM {et_expr}) * 60 + extract(minute FROM {et_expr}))"
    return f"CAST(({mod} - {RTH_START_MIN}) / {BUCKET_MINUTES} AS INTEGER)"


def _metrics_select(
    *,
    source_table: str,
    side_sign_expr: str,
    option_type_is_put_expr: str,
    cast_suffix: str,
    et_expr: str,
    where_extra: str,
) -> str:
    """Build a per-(day, slot) metrics aggregation query.

    Both the tape (DuckDB, parquet) and Neon paths share the same metric
    algebra; only the column expressions (side derivation, option-type
    encoding, decimal casts) differ.
    """
    slot = _slot_expr(et_expr)
    et_date = f"CAST({et_expr} AS DATE)"
    side_sign = side_sign_expr
    abs_delta = f"abs(delta{cast_suffix})"
    delta = f"delta{cast_suffix}"
    size = "size"
    premium = f"premium{cast_suffix}"
    is_idx_put = (
        f"(underlying_symbol IN ({_INDEX_SQL}) "
        f"AND {option_type_is_put_expr} "
        f"AND expiry = {et_date})"
    )
    return f"""
    WITH base AS (
        SELECT
            {et_date} AS d,
            {slot} AS slot,
            {side_sign} AS side_sign,
            {delta} AS delta_v,
            {abs_delta} AS abs_delta_v,
            {size} AS size_v,
            {premium} AS premium_v,
            {is_idx_put} AS is_idx_put
        FROM {source_table}
        WHERE underlying_symbol IN ({_UNIVERSE_SQL})
          AND {slot} >= 0 AND {slot} < {SLOT_COUNT}
          {where_extra}
    )
    SELECT
        d,
        slot,
        sum(side_sign * delta_v * size_v) AS nd_num,
        sum(abs_delta_v * size_v) AS nd_den,
        sum(CASE WHEN is_idx_put THEN premium_v ELSE 0 END) AS idx_num,
        sum(premium_v) AS prem_den
    FROM base
    GROUP BY d, slot
    """


# ── Tape (DuckDB) path ───────────────────────────────────────────────────────


def build_tape_metrics() -> dict[tuple[date_cls, int], tuple[float, float]]:
    """Per-(day, slot) (net_delta_tilt, idx0dte_put_share) from the full-tape.

    Restricted to the WS universe. premium uses the tape's own `premium`
    column (already price·size·100 in the archive).
    """
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    source = f"read_parquet('{TAPE_GLOB}', union_by_name=true)"
    # Tape side derives from the `tags` string ('ask_side'→+1, 'bid_side'→-1).
    side_sign_expr = (
        "CASE WHEN contains(tags, 'ask_side') THEN 1 "
        "WHEN contains(tags, 'bid_side') THEN -1 ELSE 0 END"
    )
    # Tape option_type is 'put'/'call'.
    option_type_is_put_expr = "lower(option_type) = 'put'"
    sql = _metrics_select(
        source_table=source,
        side_sign_expr=side_sign_expr,
        option_type_is_put_expr=option_type_is_put_expr,
        cast_suffix="::DOUBLE",
        et_expr=_ET_EXPR,
        where_extra="AND canceled = FALSE",
    )
    rows = con.execute(sql).fetchall()
    con.close()
    return _rows_to_metrics(rows)


# ── Neon (psycopg2) path ─────────────────────────────────────────────────────


def build_neon_metrics(
    days: list[date_cls],
) -> dict[tuple[date_cls, int], tuple[float, float]]:
    """Per-(day, slot) metrics from Neon ws_option_trades for `days`.

    premium is computed as price·size·100 (the WS table stores `price`, not
    a premium column) — matching the consistency rule in the spec.
    """
    if psycopg2 is None or dotenv_values is None:
        raise RuntimeError("psycopg2 / python-dotenv required for validation")
    env = dotenv_values(ENV_LOCAL) if ENV_LOCAL.exists() else {}
    url = (
        os.environ.get("DATABASE_URL_UNPOOLED")
        or os.environ.get("DATABASE_URL")
        or env.get("DATABASE_URL_UNPOOLED")
        or env.get("DATABASE_URL")
    )
    if not url:
        raise RuntimeError("DATABASE_URL[_UNPOOLED] not found in env or .env.local")

    et_expr = "(executed_at AT TIME ZONE 'America/New_York')"
    slot = _slot_expr(et_expr)
    et_date = f"CAST({et_expr} AS DATE)"
    day_list = ", ".join(f"DATE '{d.isoformat()}'" for d in days)
    side_sign = (
        "CASE side WHEN 'ask' THEN 1 WHEN 'bid' THEN -1 ELSE 0 END"
    )
    # Neon: underlying symbol column is `ticker`; option_type is 'C'/'P';
    # premium = price * size * 100.
    sql = f"""
    WITH base AS (
        SELECT
            {et_date} AS d,
            {slot} AS slot,
            {side_sign} AS side_sign,
            delta::double precision AS delta_v,
            abs(delta::double precision) AS abs_delta_v,
            size AS size_v,
            (price::double precision * size * 100) AS premium_v,
            (ticker IN ({_INDEX_SQL})
             AND option_type = 'P'
             AND expiry = {et_date}) AS is_idx_put
        FROM ws_option_trades
        WHERE ticker IN ({_UNIVERSE_SQL})
          AND canceled = FALSE
          AND {et_date} IN ({day_list})
          AND {slot} >= 0 AND {slot} < {SLOT_COUNT}
    )
    SELECT
        d, slot,
        sum(side_sign * delta_v * size_v) AS nd_num,
        sum(abs_delta_v * size_v) AS nd_den,
        sum(CASE WHEN is_idx_put THEN premium_v ELSE 0 END) AS idx_num,
        sum(premium_v) AS prem_den
    FROM base
    GROUP BY d, slot
    """
    con = psycopg2.connect(url)
    cur = con.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    con.close()
    return _rows_to_metrics(rows)


# ── Shared aggregation → metrics ─────────────────────────────────────────────


def _rows_to_metrics(
    rows: list[tuple],
) -> dict[tuple[date_cls, int], tuple[float, float]]:
    """Map raw (d, slot, nd_num, nd_den, idx_num, prem_den) rows to metrics."""
    out: dict[tuple[date_cls, int], tuple[float, float]] = {}
    for d, slot, nd_num, nd_den, idx_num, prem_den in rows:
        if d is None or slot is None:
            continue
        d_key = d if isinstance(d, date_cls) else date_cls.fromisoformat(str(d))
        nd_num = float(nd_num or 0.0)
        nd_den = float(nd_den or 0.0)
        idx_num = float(idx_num or 0.0)
        prem_den = float(prem_den or 0.0)
        nd_tilt = nd_num / nd_den if nd_den != 0 else 0.0
        idx_put_share = idx_num / prem_den if prem_den != 0 else 0.0
        out[(d_key, int(slot))] = (nd_tilt, idx_put_share)
    return out


# ── Percentile grid ──────────────────────────────────────────────────────────


def _percentiles(values: list[float], pcts: list[int]) -> list[float]:
    """Linear-interpolation percentiles (matches numpy 'linear' / TS evaluator).

    Implemented without numpy so the artifact build has no extra dependency
    and the breakpoint math is identical to the pure-TS interpolation in
    api/_lib/flow-regime.ts.
    """
    if not values:
        return [0.0 for _ in pcts]
    s = sorted(values)
    n = len(s)
    out: list[float] = []
    for p in pcts:
        if n == 1:
            out.append(round(s[0], 8))
            continue
        rank = (p / 100.0) * (n - 1)
        lo = int(rank)
        hi = min(lo + 1, n - 1)
        frac = rank - lo
        val = s[lo] + (s[hi] - s[lo]) * frac
        out.append(round(val, 8))
    return out


def build_baseline_json(
    tape_metrics: dict[tuple[date_cls, int], tuple[float, float]],
) -> dict:
    """Aggregate per-(day, slot) tape metrics into per-slot percentile grids."""
    per_slot_nd: dict[int, list[float]] = {s: [] for s in range(SLOT_COUNT)}
    per_slot_idx: dict[int, list[float]] = {s: [] for s in range(SLOT_COUNT)}
    for (_d, slot), (nd_tilt, idx_share) in tape_metrics.items():
        if 0 <= slot < SLOT_COUNT:
            per_slot_nd[slot].append(nd_tilt)
            per_slot_idx[slot].append(idx_share)

    slots_out = []
    for slot in range(SLOT_COUNT):
        nd_vals = per_slot_nd[slot]
        idx_vals = per_slot_idx[slot]
        slots_out.append(
            {
                "slot": slot,
                "n_days": len(nd_vals),
                "nd_tilt_breakpoints": _percentiles(nd_vals, PERCENTILES),
                "idx0dte_put_share_breakpoints": _percentiles(
                    idx_vals, PERCENTILES
                ),
            }
        )

    return {
        "schema_version": 1,
        "generated_from": (
            "Desktop full-tape (~/Desktop/Eod-Full-Tape-parquet/*.parquet) "
            "restricted to the uw-stream WS Lottery universe; validated "
            "against Neon ws_option_trades on overlapping days. See "
            "docs/superpowers/specs/flow-regime-badge-2026-06-06.md."
        ),
        "universe": UNIVERSE,
        "index_set": INDEX_SET,
        "bucket_minutes": BUCKET_MINUTES,
        "rth_start_minute": RTH_START_MIN,
        "rth_end_minute": RTH_END_MIN,
        "slot_count": SLOT_COUNT,
        "min_days_per_slot": MIN_DAYS_PER_SLOT,
        "side_sign_map": SIDE_SIGN_MAP,
        "percentiles": PERCENTILES,
        "slots": slots_out,
    }


# ── Validation ───────────────────────────────────────────────────────────────


def _corr(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return float("nan")
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return float("nan")
    return cov / (vx**0.5 * vy**0.5)


def validate(
    tape_metrics: dict[tuple[date_cls, int], tuple[float, float]],
    overlap_days: list[date_cls],
) -> tuple[bool, str]:
    """Compare tape-restricted vs Neon metrics on the overlapping days."""
    neon_metrics = build_neon_metrics(overlap_days)

    keys = sorted(
        k
        for k in set(tape_metrics) & set(neon_metrics)
        if k[0] in overlap_days
    )
    lines: list[str] = []
    lines.append("Flow Regime baseline validation")
    lines.append("=" * 60)
    lines.append(
        "full-tape-restricted (universe-matched) vs Neon ws_option_trades, "
        "per (day, slot)"
    )
    lines.append(
        "NOTE: 2026-06-02 + 2026-06-03 excluded — WS stream ramp-up partials. "
        "06-02 was the daemon's mid-deploy first session (~33K rows vs ~8M/day). "
        "06-03's index subs (SPXW/QQQ/SPY) only came online ~13:52 ET, so its "
        "morning slots miss index-put premium. Both are subscription-coverage "
        "artifacts, not metric-definition mismatches; 06-04/06-05 (full index "
        "coverage from 09:30) match the tape per-slot at corr ~0.99."
    )
    lines.append(f"overlap days: {[d.isoformat() for d in overlap_days]}")
    lines.append(f"matched (day, slot) cells: {len(keys)}")
    lines.append(f"tape-only cells: {len(set(tape_metrics) - set(neon_metrics))}")
    lines.append(f"neon-only cells: {len(set(neon_metrics) - set(tape_metrics))}")
    lines.append("")

    if not keys:
        lines.append("NO OVERLAPPING CELLS — cannot validate.")
        return False, "\n".join(lines)

    ok = True
    for idx, metric_name in enumerate(("net_delta_tilt", "idx0dte_put_share")):
        tape_vals = [tape_metrics[k][idx] for k in keys]
        neon_vals = [neon_metrics[k][idx] for k in keys]
        diffs = [abs(a - b) for a, b in zip(tape_vals, neon_vals)]
        mad = sum(diffs) / len(diffs)
        mx = max(diffs)
        r = _corr(tape_vals, neon_vals)
        lines.append(f"[{metric_name}]")
        lines.append(f"  mean abs diff : {mad:.6f}  (max {mx:.6f})")
        lines.append(f"  correlation   : {r:.6f}")
        # NaN correlation (degenerate: constant series) only acceptable if
        # the MAD itself is tiny; otherwise require both MAD and correlation.
        if math.isnan(r):
            metric_ok = mad <= MAX_MEAN_ABS_DIFF
        else:
            metric_ok = mad <= MAX_MEAN_ABS_DIFF and r >= MIN_CORRELATION
        lines.append(
            f"  thresholds    : MAD<={MAX_MEAN_ABS_DIFF} "
            f"corr>={MIN_CORRELATION} -> {'PASS' if metric_ok else 'FAIL'}"
        )
        lines.append("")
        ok = ok and metric_ok

    # Per-cell sample for eyeballing.
    lines.append("sample cells (day, slot): tape_nd / neon_nd | tape_idx / neon_idx")
    for k in keys[:20]:
        t = tape_metrics[k]
        n = neon_metrics[k]
        lines.append(
            f"  {k[0].isoformat()} s{k[1]:>2}: "
            f"{t[0]:+.4f} / {n[0]:+.4f} | {t[1]:.4f} / {n[1]:.4f}"
        )

    return ok, "\n".join(lines)


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    print(f"[1/4] reading full-tape: {TAPE_GLOB}")
    print(f"      universe: {len(UNIVERSE)} tickers; index set: {INDEX_SET}")
    tape_metrics = build_tape_metrics()
    all_days = sorted({k[0] for k in tape_metrics})
    print(
        f"      tape cells: {len(tape_metrics)} over {len(all_days)} days "
        f"({all_days[0]} .. {all_days[-1]})"
    )

    print("[2/4] validating tape-restricted vs Neon on overlapping days")
    # Only days where the WS stream had FULL-session coverage of the index
    # tickers are valid for validation. The stream's first two sessions were
    # ramp-up partials (confirmed against ws_option_trades per-ticker spans):
    #   - 2026-06-02: daemon came up mid-deploy; ~33K rows for the whole
    #     session vs ~8M on a normal day → pure small-sample noise.
    #   - 2026-06-03: the high-volume index subscriptions (SPXW/QQQ/SPY) only
    #     came online at ~13:52 ET, so the morning slots are MISSING their
    #     index-put premium in Neon while the full tape has it. This shows up
    #     as a systematic ~6x idx0dte_put_share gap on 06-03 mornings — a
    #     subscription-coverage artifact, NOT a metric-definition mismatch.
    # 06-04 and 06-05 have all index tickers streaming from 09:30 ET and match
    # the universe-restricted full tape per-slot within MAD ~0.003 (nd) /
    # ~0.001 (idx), corr ~0.99. See docs/tmp/flow-regime-baseline-validation.txt.
    NEON_PARTIAL_DAYS = {date_cls(2026, 6, 2), date_cls(2026, 6, 3)}
    neon_window = [
        date_cls(2026, 6, 4),
        date_cls(2026, 6, 5),
    ]
    overlap_days = [
        d
        for d in neon_window
        if d in set(all_days) and d not in NEON_PARTIAL_DAYS
    ]
    ok, report = validate(tape_metrics, overlap_days)
    print(report)
    VALIDATION_TXT.parent.mkdir(parents=True, exist_ok=True)
    VALIDATION_TXT.write_text(report + "\n")
    print(f"      wrote {VALIDATION_TXT}")

    if not ok:
        print(
            "\nVALIDATION FAILED — tape-restricted metrics diverge from the "
            "live WS stream. Refusing to write a baseline whose percentiles "
            "would be meaningless. Investigate universe / side / premium "
            "definitions before shipping.",
            file=sys.stderr,
        )
        return 1

    print("[3/4] building per-slot percentile grids")
    baseline = build_baseline_json(tape_metrics)
    thin = [s["slot"] for s in baseline["slots"] if s["n_days"] < MIN_DAYS_PER_SLOT]
    if thin:
        print(f"      WARNING: slots with < {MIN_DAYS_PER_SLOT} days: {thin}")

    print(f"[4/4] writing baseline artifact: {OUT_JSON}")
    OUT_JSON.write_text(json.dumps(baseline, indent=2) + "\n")
    size = OUT_JSON.stat().st_size
    print(f"      wrote {OUT_JSON} ({size:,} bytes)")
    for s in baseline["slots"]:
        et_min = RTH_START_MIN + s["slot"] * BUCKET_MINUTES
        hh, mm = divmod(et_min, 60)
        print(
            f"      slot {s['slot']:>2} ({hh:02d}:{mm:02d} ET) "
            f"n_days={s['n_days']:>3}  "
            f"nd[p10={s['nd_tilt_breakpoints'][2]:+.3f} "
            f"p50={s['nd_tilt_breakpoints'][4]:+.3f} "
            f"p90={s['nd_tilt_breakpoints'][6]:+.3f}]  "
            f"idx[p10={s['idx0dte_put_share_breakpoints'][2]:.3f} "
            f"p90={s['idx0dte_put_share_breakpoints'][6]:.3f}]"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
