"""Day-analog Phase 0 parity: frozen Databento archive vs ``futures_bars``.

Spec: docs/superpowers/specs/day-analogs-rebuild-2026-10-02.md

Question this answers: can ``futures_bars`` (symbol ``'ES'``, one row per
minute) replace the sidecar's DuckDB archive as the source of the 60-dim
day-analog vector without changing which historical days come back as
neighbours?

Two windows are compared:

* ``utc`` — the CURRENT builder (``sidecar/src/archive_query.py``):
  UTC calendar day, front month = top-volume ``ES%`` symbology symbol
  (calendar spreads included), anchor = the day's first bar, vector =
  close at minutes 1..60 after the anchor (carried forward) / anchor
  open − 1. Days with < 10 bars in that hour are rejected.
* ``cash`` — the proposed default: the 08:30 CT cash open. Front month =
  top UTC-day-volume OUTRIGHT (no spreads), anchor = the 08:30 CT bar,
  vector = close at minutes 0..59 of the cash session (carried forward)
  / anchor open − 1. DST-aware via America/Chicago.

Metrics (per window): per-day vector parity (max |Δ| per day), top-15
cosine-neighbour overlap when the query vector comes from
``futures_bars`` instead of the archive (corpus = full archive history,
neighbours strictly ``date < d``), the same overlap with BOTH corpus and
query swapped inside the overlap window, and minute-level back-month
contamination (``futures_bars`` close vs the archive front-month close
> 2 ticks).

Read-only. The ``futures_bars`` pull runs in a READ ONLY session and
the connection string is never printed. Usage::

    ml/.venv/Scripts/python.exe ml/src/day_analog_parity.py \
        --archive ml/data/archive \
        --fb-parquet <cache>/futures_bars_es.parquet \
        --stored-features <cache>/day_features.parquet \
        --out <scratch>/parity.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

# ── Constants (agreed in the spec; see "Thresholds / constants") ──────────

VEC_DIM = 60
MIN_BARS = 10  # same rejection floor as the sidecar builder
TOP_K = 15  # cohort size used by findSimilarDays / getRangeForecast
PARITY_TOL = 1e-4  # "within 1e-4" per-day max |Δ|
ES_TICK = 0.25
CONTAM_TICKS = 2
CONTAM_PTS = ES_TICK * CONTAM_TICKS
CT = "America/Chicago"
CASH_OPEN_MIN_CT = 8 * 60 + 30
OUTRIGHT_RE = r"^ES[FGHJKMNQUVXZ][0-9]{1,2}$"
QUARTERLY = {"H": 3, "M": 6, "U": 9, "Z": 12}
# First minute the live Databento writer (all outright months mapped to
# 'ES', GREATEST/LEAST/last-write merge) owned futures_bars. Earlier rows
# came from scripts/backfill-futures.ts (Databento ES.c.0, DO NOTHING).
LIVE_WRITER_START = pd.Timestamp("2026-04-05T21:00:00Z")


# ── Archive loaders (DuckDB over the frozen parquet archive) ──────────────


def _connect() -> duckdb.DuckDBPyConnection:
    conn = duckdb.connect()
    # date_trunc('day', TIMESTAMPTZ) honours the session TZ; pin UTC like
    # the sidecar does so the UTC-day bucket is reproducible anywhere.
    conn.execute("SET TimeZone = 'UTC'")
    return conn


def _glob(archive: Path) -> str:
    return str(archive / "ohlcv_1m" / "year=*" / "part.parquet")


def load_sidecar_utc_first_hour(archive: Path, start: str, end: str) -> pd.DataFrame:
    """Replicate the current builder's bar selection.

    UTC-day bucket, top-volume ``ES%`` symbology symbol per day (spreads
    included, options excluded by the no-space rule), then only the bars
    from the day's first bar through first bar + 60 minutes.
    Columns: day, symbol, ts, open, close.
    """
    sql = """
        WITH filtered AS (
            SELECT b.ts_event AS ts, b.open, b.close, b.volume, s.symbol,
                   CAST(date_trunc('day', b.ts_event) AS DATE) AS day
            FROM read_parquet(?) AS b
            JOIN read_parquet(?) AS s USING (instrument_id)
            WHERE s.symbol LIKE 'ES%'
              AND strpos(s.symbol, ' ') = 0
              AND CAST(date_trunc('day', b.ts_event) AS DATE)
                  BETWEEN ?::DATE AND ?::DATE
        ),
        cv AS (
            SELECT day, symbol, SUM(volume) AS v FROM filtered
            GROUP BY day, symbol
        ),
        fc AS (
            SELECT day, symbol FROM (
                SELECT day, symbol,
                       ROW_NUMBER() OVER (
                           PARTITION BY day ORDER BY v DESC, symbol ASC
                       ) AS rk
                FROM cv
            ) WHERE rk = 1
        ),
        fb AS (
            SELECT f.day, f.symbol, f.ts, f.open, f.close
            FROM filtered f JOIN fc USING (day, symbol)
        ),
        anchor AS (SELECT day, MIN(ts) AS t0 FROM fb GROUP BY day)
        SELECT fb.day, fb.symbol, fb.ts, fb.open, fb.close
        FROM fb JOIN anchor USING (day)
        WHERE fb.ts <= anchor.t0 + INTERVAL 60 MINUTE
        ORDER BY fb.day, fb.ts
    """
    conn = _connect()
    df = conn.execute(
        sql, [_glob(archive), str(archive / "symbology.parquet"), start, end]
    ).df()
    return _normalise(df)


def load_outright_bars(
    archive: Path,
    start: str,
    end: str,
    *,
    front_only: bool,
    utc_hours: tuple[int, int] | None = None,
) -> pd.DataFrame:
    """Outright ES bars (the bar's own ``symbol``; no spreads, no options).

    ``front_only`` keeps only the top UTC-day-volume outright per day.
    ``utc_hours`` (inclusive) trims the result to those UTC hours AFTER
    the front month is chosen on full-day volume.
    Columns: day, symbol, ts, open, high, low, close, volume.
    """
    hour_clause = (
        f"WHERE hour(ts) BETWEEN {int(utc_hours[0])} AND {int(utc_hours[1])}"
        if utc_hours
        else ""
    )
    front_cte = (
        """
        cv AS (
            SELECT day, symbol, SUM(volume) AS v FROM filtered
            GROUP BY day, symbol
        ),
        fc AS (
            SELECT day, symbol FROM (
                SELECT day, symbol,
                       ROW_NUMBER() OVER (
                           PARTITION BY day ORDER BY v DESC, symbol ASC
                       ) AS rk
                FROM cv
            ) WHERE rk = 1
        ),
        picked AS (SELECT f.* FROM filtered f JOIN fc USING (day, symbol))
        """
        if front_only
        else "picked AS (SELECT * FROM filtered)"
    )
    sql = f"""
        WITH filtered AS (
            SELECT b.ts_event AS ts, b.open, b.high, b.low, b.close,
                   b.volume, b.symbol,
                   CAST(date_trunc('day', b.ts_event) AS DATE) AS day
            FROM read_parquet(?) AS b
            WHERE regexp_matches(b.symbol, '{OUTRIGHT_RE}')
              AND CAST(date_trunc('day', b.ts_event) AS DATE)
                  BETWEEN ?::DATE AND ?::DATE
        ),
        {front_cte}
        SELECT day, symbol, ts, open, high, low, close, volume
        FROM picked
        {hour_clause}
        ORDER BY day, ts, symbol
    """
    df = _connect().execute(sql, [_glob(archive), start, end]).df()
    return _normalise(df)


def _normalise(df: pd.DataFrame) -> pd.DataFrame:
    """UTC-aware ``ts``, python ``date`` ``day``, float prices."""
    out = df.copy()
    out["ts"] = pd.to_datetime(out["ts"], utc=True)
    if "day" in out.columns:
        out["day"] = pd.to_datetime(out["day"]).dt.date
    for col in ("open", "high", "low", "close"):
        if col in out.columns:
            out[col] = out[col].astype(float)
    return out


# ── Vector builders (pure; shared by archive and futures_bars) ────────────


def _carry_forward(idx: np.ndarray, closes: np.ndarray, base: float) -> np.ndarray:
    """60 slots, ``idx`` 0-based. Gaps carry the last seen close (start = base)."""
    slots = np.full(VEC_DIM, np.nan)
    slots[idx] = closes
    last = base
    for i in range(VEC_DIM):
        if np.isnan(slots[i]):
            slots[i] = last
        else:
            last = slots[i]
    return slots / base - 1.0


def utc_window_vectors(bars: pd.DataFrame) -> dict[date, np.ndarray]:
    """Current builder: anchor = first bar of the UTC day, minutes 1..60.

    ``bars`` needs ts/open/close; ``day`` is derived (UTC) when absent.
    Duplicate timestamps (symbology join fan-out) keep the last close.
    """
    df = bars.sort_values("ts", kind="stable")
    days = df["day"] if "day" in df.columns else df["ts"].dt.date
    out: dict[date, np.ndarray] = {}
    for day, g in df.groupby(days, sort=True):
        t0 = g["ts"].iloc[0]
        base = float(g["open"].iloc[0])
        minute = ((g["ts"] - t0).dt.total_seconds() // 60).astype(int).to_numpy()
        keep = (minute >= 1) & (minute <= VEC_DIM)
        if keep.sum() < MIN_BARS or base == 0:
            continue
        out[day] = _carry_forward(
            minute[keep] - 1, g["close"].to_numpy(dtype=float)[keep], base
        )
    return out


def cash_window_vectors(bars: pd.DataFrame) -> dict[date, np.ndarray]:
    """Proposed builder: anchor = the 08:30 CT bar, minutes 0..59.

    A day without an 08:30 CT bar is dropped (no fabricated anchor).
    """
    df = bars.sort_values("ts", kind="stable")
    ct = df["ts"].dt.tz_convert(CT)
    rel = (ct.dt.hour * 60 + ct.dt.minute - CASH_OPEN_MIN_CT).to_numpy()
    in_window = (rel >= 0) & (rel < VEC_DIM)
    sub = df.loc[in_window].assign(
        ct_day=ct[in_window].dt.date.to_numpy(), rel=rel[in_window]
    )
    out: dict[date, np.ndarray] = {}
    for day, g in sub.groupby("ct_day", sort=True):
        anchor = g.loc[g["rel"] == 0]
        if anchor.empty or len(g) < MIN_BARS:
            continue
        base = float(anchor["open"].iloc[0])
        if base == 0:
            continue
        out[day] = _carry_forward(
            g["rel"].to_numpy(dtype=int), g["close"].to_numpy(dtype=float), base
        )
    return out


# ── Metrics ───────────────────────────────────────────────────────────────


def vector_parity(
    a: dict[date, np.ndarray], b: dict[date, np.ndarray], *, worst: int = 10
) -> dict[str, Any]:
    """Per-day max |a − b| over the 60 slots, summarised across days."""
    common = sorted(set(a) & set(b))
    diffs = np.array([float(np.max(np.abs(a[d] - b[d]))) for d in common])
    res: dict[str, Any] = {
        "days_common": len(common),
        "days_only_a": len(set(a) - set(b)),
        "days_only_b": len(set(b) - set(a)),
    }
    if len(common) == 0:
        return res | {
            "median": None,
            "p90": None,
            "max": None,
            "share_within_tol": None,
        }
    order = np.argsort(diffs)[::-1][:worst]
    return res | {
        "median": float(np.median(diffs)),
        "p90": float(np.quantile(diffs, 0.9)),
        "max": float(diffs.max()),
        "share_within_tol": float(np.mean(diffs <= PARITY_TOL)),
        "worst_days": [
            {"date": common[i].isoformat(), "max_abs_diff": float(diffs[i])}
            for i in order
        ],
        "per_day": {d.isoformat(): float(x) for d, x in zip(common, diffs)},
    }


def classify_mismatches(
    per_day: dict[str, float], causes: dict[str, set[date]]
) -> dict[str, Any]:
    """Bucket days whose max |Δ| exceeds PARITY_TOL by the first matching cause.

    ``causes`` is ordered (dicts keep insertion order); a day matching
    none lands in ``other``. Also reports parity on the days that match
    no cause at all — the "clean" share.
    """
    counts = dict.fromkeys(causes, 0) | {"other": 0}
    other_days: list[str] = []
    clean = []
    for iso, diff in per_day.items():
        d = date.fromisoformat(iso)
        hit = next((name for name, days in causes.items() if d in days), None)
        if hit is None:
            clean.append(diff)
        if diff <= PARITY_TOL:
            continue
        if hit is None:
            counts["other"] += 1
            other_days.append(iso)
        else:
            counts[hit] += 1
    return {
        "over_tol_by_cause": counts,
        "other_days": other_days,
        "clean_days": len(clean),
        "clean_share_within_tol": float(np.mean(np.asarray(clean) <= PARITY_TOL))
        if clean
        else None,
    }


def mean_by_cause(
    per_day: dict[str, float], causes: dict[str, set[date]]
) -> dict[str, dict[str, float | int]]:
    """Mean of a per-day metric grouped by first matching cause (else ``other``)."""
    groups: dict[str, list[float]] = {name: [] for name in causes} | {"other": []}
    for iso, value in per_day.items():
        d = date.fromisoformat(iso)
        name = next((n for n, days in causes.items() if d in days), "other")
        groups[name].append(value)
    return {
        name: {"n": len(vals), "mean": float(np.mean(vals)) if vals else float("nan")}
        for name, vals in groups.items()
    }


def _unit_matrix(
    vectors: dict[date, np.ndarray],
) -> tuple[list[date], np.ndarray]:
    days = sorted(d for d, v in vectors.items() if np.linalg.norm(v) > 0)
    if not days:
        return [], np.zeros((0, VEC_DIM))
    mat = np.vstack([vectors[d] for d in days])
    return days, mat / np.linalg.norm(mat, axis=1, keepdims=True)


def _top_k(sims: np.ndarray, k: int) -> set[int]:
    k = min(k, sims.size)
    if k == 0:
        return set()
    return set(np.argpartition(-sims, k - 1)[:k].tolist())


def _summarise_overlap(overlaps: list[float], k: int) -> dict[str, Any]:
    if not overlaps:
        return {"n_queries": 0}
    arr = np.asarray(overlaps)
    return {
        "n_queries": int(arr.size),
        "mean": float(arr.mean()),
        "median": float(np.median(arr)),
        "p10": float(np.quantile(arr, 0.1)),
        "share_full": float(np.mean(arr >= 1.0 - 1e-12)),
        "share_ge_80pct": float(np.mean(arr >= 0.8 - 1e-12)),
        "k": k,
    }


def nn_overlap_query_swap(
    corpus: dict[date, np.ndarray],
    query_a: dict[date, np.ndarray],
    query_b: dict[date, np.ndarray],
    *,
    k: int = TOP_K,
) -> dict[str, Any]:
    """Same corpus, two query vectors per day; neighbours strictly ``< d``.

    Mirrors production after the ``date < d`` fix: today's vector comes
    from the new source, history stays as stored.
    """
    days, mat = _unit_matrix(corpus)
    day_idx = np.array([d.toordinal() for d in days])
    overlaps: list[float] = []
    per_day: dict[str, float] = {}
    for d in sorted(set(query_a) & set(query_b)):
        qa, qb = query_a[d], query_b[d]
        na, nb = np.linalg.norm(qa), np.linalg.norm(qb)
        n_cand = int(np.searchsorted(day_idx, d.toordinal(), side="left"))
        if na == 0 or nb == 0 or n_cand < k:
            continue
        cand = mat[:n_cand]
        top_a = _top_k(cand @ (qa / na), k)
        top_b = _top_k(cand @ (qb / nb), k)
        ov = len(top_a & top_b) / k
        overlaps.append(ov)
        per_day[d.isoformat()] = ov
    return _summarise_overlap(overlaps, k) | {"per_day": per_day}


def nn_overlap_corpus_swap(
    a: dict[date, np.ndarray],
    b: dict[date, np.ndarray],
    *,
    k: int = TOP_K,
) -> dict[str, Any]:
    """Corpus AND query from each source, restricted to common days.

    Neighbours = all other common days (not just earlier ones) so every
    query has a full candidate set; measures whether a futures_bars-built
    stretch of corpus ranks itself the way the archive would.
    """
    common = sorted(
        d
        for d in set(a) & set(b)
        if np.linalg.norm(a[d]) > 0 and np.linalg.norm(b[d]) > 0
    )
    if len(common) <= k:
        return {"n_queries": 0}
    _, ma = _unit_matrix({d: a[d] for d in common})
    _, mb = _unit_matrix({d: b[d] for d in common})
    sa, sb = ma @ ma.T, mb @ mb.T
    np.fill_diagonal(sa, -np.inf)
    np.fill_diagonal(sb, -np.inf)
    overlaps = [
        len(_top_k(sa[i], k) & _top_k(sb[i], k)) / k for i in range(len(common))
    ]
    return _summarise_overlap(overlaps, k)


# ── Contamination ─────────────────────────────────────────────────────────


def third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    offset = (4 - first.weekday()) % 7  # Friday = 4
    return first + timedelta(days=offset + 14)


def calendar_front(d: date) -> str:
    """Nearest unexpired quarterly ES contract (Databento ``ES.c.0`` rule)."""
    for year in (d.year, d.year + 1):
        for code, month in QUARTERLY.items():
            if third_friday(year, month) >= d:
                return f"ES{code}{year % 10}"
    raise AssertionError("unreachable")


@dataclass(frozen=True)
class ContaminationResult:
    summary: dict[str, Any]
    by_day: pd.DataFrame


def contamination(
    fb: pd.DataFrame, outrights: pd.DataFrame, *, cash_only: bool = False
) -> ContaminationResult:
    """futures_bars close vs archive front-month close at the same minute.

    ``outrights``: all outright archive bars (columns day, symbol, ts,
    open, high, low, close, volume). Front month = top UTC-day volume.
    A contaminated minute is |fb.close − front.close| > 2 ticks; it is
    *attributed* to a back month when some other outright's close at that
    minute is within 2 ticks of fb.close.
    """
    vol = outrights.groupby(["day", "symbol"], as_index=False)["volume"].sum()
    vol = vol.sort_values(["day", "volume", "symbol"], ascending=[True, False, True])
    front_sym = vol.drop_duplicates("day").set_index("day")["symbol"]
    is_front = (
        outrights["symbol"].to_numpy() == outrights["day"].map(front_sym).to_numpy()
    )
    front = outrights.loc[
        is_front, ["ts", "day", "symbol", "open", "high", "low", "close"]
    ]
    others = outrights.loc[~is_front, ["ts", "close"]].rename(
        columns={"close": "other_close"}
    )

    m = fb[["ts", "open", "high", "low", "close"]].merge(
        front, on="ts", how="inner", suffixes=("_fb", "_ar")
    )
    if cash_only:
        ct = m["ts"].dt.tz_convert(CT)
        mins = ct.dt.hour * 60 + ct.dt.minute
        m = m.loc[(mins >= CASH_OPEN_MIN_CT) & (mins < 15 * 60)]
    m = m.assign(diff=(m["close_fb"] - m["close_ar"]).abs())
    m["bad"] = m["diff"] > CONTAM_PTS + 1e-9
    m["bad_open"] = (m["open_fb"] - m["open_ar"]).abs() > CONTAM_PTS + 1e-9
    m["bad_high"] = (m["high_fb"] - m["high_ar"]).abs() > CONTAM_PTS + 1e-9
    m["bad_low"] = (m["low_fb"] - m["low_ar"]).abs() > CONTAM_PTS + 1e-9
    m["era"] = np.where(m["ts"] >= LIVE_WRITER_START, "live_writer", "backfill_c0")
    cal = {d: calendar_front(d) for d in m["day"].unique()}
    m["roll_week"] = m["symbol"].to_numpy() != m["day"].map(cal).to_numpy()

    bad = m.loc[m["bad"], ["ts", "close_fb"]]
    attributed = 0
    if not bad.empty:
        cand = bad.merge(others, on="ts", how="inner")
        hit = (cand["close_fb"] - cand["other_close"]).abs() <= CONTAM_PTS + 1e-9
        attributed = int(cand.loc[hit, "ts"].nunique())

    front_minutes = len(front) if not cash_only else None
    groups = []
    for (era, roll), g in m.groupby(["era", "roll_week"], sort=True):
        groups.append(
            {
                "era": era,
                "roll_week": bool(roll),
                "minutes": int(len(g)),
                "bad_close": int(g["bad"].sum()),
                "bad_close_share": float(g["bad"].mean()),
                "bad_open_share": float(g["bad_open"].mean()),
                "bad_high_share": float(g["bad_high"].mean()),
                "bad_low_share": float(g["bad_low"].mean()),
                "days": int(g["day"].nunique()),
            }
        )
    by_day = (
        m.groupby("day")
        .agg(
            minutes=("bad", "size"),
            bad_close=("bad", "sum"),
            bad_open=("bad_open", "sum"),
            bad_high=("bad_high", "sum"),
            front=("symbol", "first"),
            roll_week=("roll_week", "first"),
        )
        .reset_index()
    )
    summary = {
        "matched_minutes": int(len(m)),
        "archive_front_minutes": front_minutes,
        "fb_minutes_in_range": int(
            fb["ts"].between(outrights["ts"].min(), outrights["ts"].max()).sum()
        ),
        "bad_close": int(m["bad"].sum()),
        "bad_close_share": float(m["bad"].mean()) if len(m) else None,
        "bad_close_attributed_to_other_outright": attributed,
        "bad_open_share": float(m["bad_open"].mean()) if len(m) else None,
        "bad_high_share": float(m["bad_high"].mean()) if len(m) else None,
        "bad_low_share": float(m["bad_low"].mean()) if len(m) else None,
        "days_with_bad_close": int((by_day["bad_close"] > 0).sum()),
        "by_era_roll": groups,
    }
    return ContaminationResult(summary=summary, by_day=by_day)


PROXY_WIDE_PTS = 20.0
PROXY_JUMP_PTS = 15.0


def _proxy_flags(fb: pd.DataFrame) -> pd.DataFrame:
    """Per-bar carry-basis merge flags, sorted by ts.

    The retired Databento writer merged every outright month into one
    'ES' row: open = first write, high/low = GREATEST/LEAST, close = last
    write. ES carry between adjacent quarterlies is ~40-60 pts, so the
    merge shows up as:

    * ``gap`` — |open − previous close| > 15 pts (a back-month bar won
      the first write, so the open sits a carry away from the tape);
    * ``spike`` — a close > 15 pts away from both neighbours, same side;
    * ``wide`` — a bar wider than 20 pts. Informational only: real
      volatility at the cash open trips it too (see the calibration).

    ``flagged`` = gap | spike is the per-bar contamination call.
    """
    df = fb.sort_values("ts").reset_index(drop=True)
    prev_close = df["close"].shift(1)
    up = df["close"] - prev_close
    dn = df["close"] - df["close"].shift(-1)
    gap = (df["open"] - prev_close).abs() > PROXY_JUMP_PTS
    spike = (
        (up.abs() > PROXY_JUMP_PTS)
        & (dn.abs() > PROXY_JUMP_PTS)
        & (np.sign(up) == np.sign(dn))
    )
    return df.assign(
        wide=(df["high"] - df["low"]) > PROXY_WIDE_PTS,
        gap=gap,
        spike=spike,
        flagged=gap | spike,
    )


def contamination_proxy(fb: pd.DataFrame) -> list[dict[str, Any]]:
    """Archive-free proxy for the months the archive cannot check."""
    df = _proxy_flags(fb)
    agg = (
        df.assign(month=df["ts"].dt.strftime("%Y-%m"))
        .groupby("month")
        .agg(
            bars=("wide", "size"),
            flagged_bars=("flagged", "sum"),
            open_gaps=("gap", "sum"),
            spikes=("spike", "sum"),
            wide_bars=("wide", "sum"),
        )
        .reset_index()
    )
    return [
        {k: (int(v) if k != "month" else v) for k, v in row.items()}
        for row in agg.to_dict("records")
    ]


def cash_window_days(fb: pd.DataFrame) -> pd.DataFrame:
    """One row per CT date that has an 08:30 CT bar.

    Columns: bars (cash-window minutes present, of 60) and flagged (any
    of them carries a proxy flag — a vector P2 must not embed as-is).
    """
    df = _proxy_flags(fb)
    ct = df["ts"].dt.tz_convert(CT)
    rel = ct.dt.hour * 60 + ct.dt.minute - CASH_OPEN_MIN_CT
    in_win = (rel >= 0) & (rel < VEC_DIM)
    win = df.loc[in_win].assign(ct_day=ct[in_win].dt.date, rel=rel[in_win])
    per_day = win.groupby("ct_day").agg(
        bars=("rel", "size"),
        has_anchor=("rel", lambda s: bool((s == 0).any())),
        flagged=("flagged", "any"),
    )
    return per_day.loc[per_day["has_anchor"], ["bars", "flagged"]]


def proxy_calibration(
    days: pd.DataFrame, truth_bad: set[date], truth_days: set[date]
) -> dict[str, int]:
    """Confusion counts of the proxy flag vs parity-confirmed bad cash vectors."""
    scored = days.loc[[d in truth_days for d in days.index]]
    flagged = {d for d, f in zip(scored.index, scored["flagged"]) if f}
    return {
        "days": int(len(scored)),
        "true_positive": len(flagged & truth_bad),
        "false_positive": len(flagged - truth_bad),
        "false_negative": len(truth_bad & set(scored.index) - flagged),
    }


def cash_window_quality(fb: pd.DataFrame, after: date) -> list[dict[str, Any]]:
    """Per month after ``after``: what a futures_bars-built corpus would get."""
    per_day = cash_window_days(fb)
    per_day = per_day.loc[[d > after for d in per_day.index]].copy()
    per_day["month"] = [d.strftime("%Y-%m") for d in per_day.index]
    out = []
    for month, g in per_day.groupby("month", sort=True):
        out.append(
            {
                "month": month,
                "days_with_anchor": int(len(g)),
                "days_full_60": int((g["bars"] == VEC_DIM).sum()),
                "days_flagged": int(g["flagged"].sum()),
                "days_usable": int(((g["bars"] >= MIN_BARS) & ~g["flagged"]).sum()),
            }
        )
    return out


# ── Stored-corpus replica check ───────────────────────────────────────────


def parse_pgvector(text: str) -> np.ndarray:
    return np.array([float(x) for x in text.strip("[]").split(",")])


def stored_features(path: Path) -> tuple[dict[date, np.ndarray], dict[date, str]]:
    df = pd.read_parquet(path)
    days = pd.to_datetime(df["date"]).dt.date
    vecs = {d: parse_pgvector(t) for d, t in zip(days, df["features"])}
    syms = dict(zip(days, df["symbol"]))
    return vecs, syms


# ── Futures_bars loader ───────────────────────────────────────────────────


def load_futures_bars(path: Path) -> pd.DataFrame:
    """Read a cached ``futures_bars`` ES pull (ts, open, high, low, close, volume)."""
    return _normalise(pd.read_parquet(path))


def pull_futures_bars(conn: Any, start: str) -> pd.DataFrame:
    """Read every ``futures_bars`` ES row from ``start`` on, READ ONLY.

    ``conn`` is a psycopg2 connection the caller opened; this sets the
    session read-only before issuing the SELECT and rolls back after.
    The pull runs to the latest row so the archive-free contamination
    proxy also covers the months after the archive ends.
    """
    conn.set_session(readonly=True, autocommit=False)
    try:
        with conn.cursor(name="fb_es") as cur:
            cur.itersize = 50_000
            cur.execute(
                """
                SELECT ts, open::float8, high::float8, low::float8,
                       close::float8, volume
                FROM futures_bars
                WHERE symbol = 'ES' AND ts >= %s
                ORDER BY ts
                """,
                (start,),
            )
            rows = list(cur)
    finally:
        conn.rollback()
    return _normalise(
        pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    )


# ── Orchestration ─────────────────────────────────────────────────────────


def _in_range(
    vecs: dict[date, np.ndarray], start: date, end: date
) -> dict[date, np.ndarray]:
    return {d: v for d, v in vecs.items() if start <= d <= end}


def _strip(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if k != "per_day"}


def run(
    archive: Path,
    fb_path: Path,
    stored_path: Path | None,
    start: str,
    end: str,
    corpus_start: str,
) -> dict[str, Any]:
    t0, t1 = date.fromisoformat(start), date.fromisoformat(end)
    fb = load_futures_bars(fb_path)
    fb_overlap = fb.loc[fb["ts"].dt.date.between(t0, t1)]
    report: dict[str, Any] = {
        "range": {"start": start, "end": end, "corpus_start": corpus_start},
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }

    # Minute-level contamination over the overlap. Computed first: its
    # per-day roll-week flag feeds the mismatch-cause breakdown below.
    outrights = load_outright_bars(archive, start, end, front_only=False)
    full = contamination(fb_overlap, outrights)
    cash_only = contamination(fb_overlap, outrights, cash_only=True)
    roll_days = set(full.by_day.loc[full.by_day["roll_week"], "day"])
    live_days = {
        d
        for d in full.by_day["day"]
        if pd.Timestamp(d.isoformat(), tz="UTC") >= LIVE_WRITER_START.normalize()
    }

    # UTC window — current builder.
    side = load_sidecar_utc_first_hour(archive, corpus_start, end)
    spread_days = sorted(
        {d for d, s in zip(side["day"], side["symbol"]) if "-" in str(s)}
    )
    corpus_utc = utc_window_vectors(side)
    utc_arch = _in_range(corpus_utc, t0, t1)
    utc_fb = utc_window_vectors(fb_overlap.assign(day=fb_overlap["ts"].dt.date))
    utc_arch_nospread = {d: v for d, v in utc_arch.items() if d not in set(spread_days)}
    utc_parity = vector_parity(utc_arch, utc_fb)
    utc_causes = {
        "spread_front": set(spread_days),
        "roll_week": roll_days,
        "live_writer": live_days,
    }
    utc_nn = nn_overlap_query_swap(corpus_utc, utc_arch, utc_fb)
    report["utc"] = {
        "spread_front_days_in_corpus": [d.isoformat() for d in spread_days],
        "parity": _strip(utc_parity),
        "parity_excl_spread_days": _strip(vector_parity(utc_arch_nospread, utc_fb)),
        "mismatch_causes": classify_mismatches(
            utc_parity.get("per_day", {}), utc_causes
        ),
        "nn_query_swap": _strip(utc_nn),
        "nn_query_swap_by_cause": mean_by_cause(utc_nn["per_day"], utc_causes),
        "nn_corpus_swap": nn_overlap_corpus_swap(utc_arch_nospread, utc_fb),
    }
    if stored_path is not None:
        stored, stored_syms = stored_features(stored_path)
        replica = vector_parity(stored, corpus_utc)
        replica_syms = dict(zip(side["day"], side["symbol"]))
        sym_mismatch = sum(
            1
            for d, s in stored_syms.items()
            if d in replica_syms and s != replica_syms[d]
        )
        report["utc"]["replica_vs_stored_day_features"] = _strip(replica) | {
            "front_symbol_mismatches": sym_mismatch
        }

    # Cash window — proposed default.
    cash_bars = load_outright_bars(
        archive, corpus_start, end, front_only=True, utc_hours=(13, 15)
    )
    corpus_cash = cash_window_vectors(cash_bars)
    cash_arch = _in_range(corpus_cash, t0, t1)
    cash_fb = cash_window_vectors(fb_overlap)
    cash_parity = vector_parity(cash_arch, cash_fb)
    cash_causes = {"roll_week": roll_days, "live_writer": live_days}
    cash_nn = nn_overlap_query_swap(corpus_cash, cash_arch, cash_fb)
    report["cash"] = {
        "parity": _strip(cash_parity),
        "days_only_in_archive": sorted(
            d.isoformat() for d in set(cash_arch) - set(cash_fb)
        ),
        "mismatch_causes": classify_mismatches(
            cash_parity.get("per_day", {}), cash_causes
        ),
        "nn_query_swap": _strip(cash_nn),
        "nn_query_swap_by_cause": mean_by_cause(cash_nn["per_day"], cash_causes),
        "nn_corpus_swap": nn_overlap_corpus_swap(cash_arch, cash_fb),
    }

    bad_days = full.by_day.loc[full.by_day["bad_close"] > 0].sort_values("day")
    report["contamination"] = {
        "all_minutes": full.summary,
        "cash_session_minutes": cash_only.summary,
        "bad_days": [
            {
                "date": r.day.isoformat(),
                "front": r.front,
                "roll_week": bool(r.roll_week),
                "minutes": int(r.minutes),
                "bad_close": int(r.bad_close),
                "bad_high": int(r.bad_high),
            }
            for r in bad_days.itertuples()
        ],
    }
    report["contamination_proxy_by_month"] = contamination_proxy(fb)
    cash_bad = {
        date.fromisoformat(iso)
        for iso, diff in cash_parity.get("per_day", {}).items()
        if diff > PARITY_TOL and date.fromisoformat(iso) in live_days
    }
    report["proxy_calibration_cash_window"] = proxy_calibration(
        cash_window_days(fb_overlap),
        cash_bad,
        {date.fromisoformat(iso) for iso in cash_parity.get("per_day", {})},
    )
    report["post_archive_cash_window_quality"] = cash_window_quality(fb, t1)
    return report


def _fmt(x: Any, nd: int = 4) -> str:
    if x is None:
        return "n/a"
    if isinstance(x, float):
        return f"{x:.{nd}g}" if abs(x) < 1e-3 and x != 0 else f"{x:.{nd}f}"
    return str(x)


def render_markdown(r: dict[str, Any]) -> str:
    lines = ["| Metric | UTC day (current) | 08:30 CT cash open |", "|---|---|---|"]
    u, c = r["utc"], r["cash"]
    up, cp = u["parity"], c["parity"]
    rows = [
        ("Days compared", up["days_common"], cp["days_common"]),
        (
            "Days only in archive / only in futures_bars",
            f"{up['days_only_a']} / {up['days_only_b']}",
            f"{cp['days_only_a']} / {cp['days_only_b']}",
        ),
        ("Per-day max abs diff — median", _fmt(up["median"]), _fmt(cp["median"])),
        ("Per-day max abs diff — p90", _fmt(up["p90"]), _fmt(cp["p90"])),
        ("Per-day max abs diff — max", _fmt(up["max"]), _fmt(cp["max"])),
        (
            "Share of days within 1e-4",
            _fmt(up["share_within_tol"]),
            _fmt(cp["share_within_tol"]),
        ),
    ]
    ux = u["parity_excl_spread_days"]
    rows.append(
        (
            "Share within 1e-4, spread-front days excluded",
            _fmt(ux["share_within_tol"]),
            "n/a (outrights only)",
        )
    )
    uc, cc = u["mismatch_causes"], c["mismatch_causes"]

    def _causes(m: dict[str, Any]) -> str:
        return ", ".join(f"{k} {v}" for k, v in m["over_tol_by_cause"].items())

    rows += [
        ("Days over 1e-4 by cause", _causes(uc), _causes(cc)),
        (
            "Share within 1e-4 on days with no known cause",
            f"{_fmt(uc['clean_share_within_tol'])} (n={uc['clean_days']})",
            f"{_fmt(cc['clean_share_within_tol'])} (n={cc['clean_days']})",
        ),
    ]
    for label, key in (
        ("query swap", "nn_query_swap"),
        ("corpus swap", "nn_corpus_swap"),
    ):
        ua, ca = u[key], c[key]
        rows += [
            (
                f"Top-15 overlap ({label}) — mean",
                _fmt(ua.get("mean")),
                _fmt(ca.get("mean")),
            ),
            (
                f"Top-15 overlap ({label}) — median",
                _fmt(ua.get("median")),
                _fmt(ca.get("median")),
            ),
            (
                f"Top-15 overlap ({label}) — p10",
                _fmt(ua.get("p10")),
                _fmt(ca.get("p10")),
            ),
            (
                f"Top-15 overlap ({label}) — share 15/15",
                _fmt(ua.get("share_full")),
                _fmt(ca.get("share_full")),
            ),
            (
                f"Top-15 overlap ({label}) — queries",
                ua.get("n_queries"),
                ca.get("n_queries"),
            ),
        ]

    def _by_cause(m: dict[str, dict[str, Any]]) -> str:
        return ", ".join(
            f"{k} {_fmt(v['mean'], 3)} (n={v['n']})" for k, v in m.items() if v["n"]
        )

    rows.append(
        (
            "Query-swap overlap mean by cause",
            _by_cause(u["nn_query_swap_by_cause"]),
            _by_cause(c["nn_query_swap_by_cause"]),
        )
    )
    lines += [f"| {a} | {b} | {c_} |" for a, b, c_ in rows]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--fb-parquet", type=Path, required=True)
    p.add_argument("--stored-features", type=Path)
    p.add_argument("--start", default="2025-04-06")
    p.add_argument("--end", default="2026-04-17")
    p.add_argument("--corpus-start", default="2010-06-06")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument(
        "--pull",
        action="store_true",
        help="Pull futures_bars ES (READ ONLY, DATABASE_URL from env) "
        "into --fb-parquet when it does not exist yet",
    )
    a = p.parse_args(argv)
    for value in (a.start, a.end, a.corpus_start):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            print(f"bad date: {value}", file=sys.stderr)
            return 2
    if not (a.archive / "symbology.parquet").exists():
        print(f"no archive at {a.archive}", file=sys.stderr)
        return 2
    if not a.fb_parquet.exists():
        if not a.pull:
            print(f"missing {a.fb_parquet} (pass --pull)", file=sys.stderr)
            return 2
        import os

        import psycopg2

        conn = psycopg2.connect(os.environ["DATABASE_URL"], sslmode="require")
        try:
            pull_futures_bars(conn, a.start).to_parquet(a.fb_parquet)
        finally:
            conn.close()
    report = run(
        a.archive, a.fb_parquet, a.stored_features, a.start, a.end, a.corpus_start
    )
    a.out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(render_markdown(report))
    print()
    print(json.dumps(report["contamination"]["all_minutes"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
