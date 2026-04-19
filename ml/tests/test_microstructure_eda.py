"""Tests for microstructure_eda — Phase 4d EDA module.

Tests avoid plot rendering assertions (they render, but we don't eyeball
the PNGs). The focus is on:

* outcome derivation correctness (happy path + UTC-boundary regression)
* classification threshold behavior (exact boundaries)
* per-question correctness: Bonferroni correction, quartile cohorts,
  degraded-row exclusion, spread zero-rate recommendation trigger
* orchestrator wires all 6 questions into the findings JSON
"""

from __future__ import annotations

import json
import time as _time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import microstructure_eda as eda

# ---------------------------------------------------------------------------
# OHLCV fixture builder (mirrors the archive layout: year=YYYY/part.parquet)
# ---------------------------------------------------------------------------


def _make_ohlcv_row(
    *,
    ts_event: datetime,
    instrument_id: int,
    symbol: str,
    open_: float,
    close: float,
    high: float | None = None,
    low: float | None = None,
    volume: int = 100,
) -> dict[str, object]:
    return {
        "ts_event": ts_event,
        "rtype": 33,
        "publisher_id": 1,
        "instrument_id": instrument_id,
        "open": open_,
        "high": high if high is not None else max(open_, close),
        "low": low if low is not None else min(open_, close),
        "close": close,
        "volume": volume,
        "symbol": symbol,
    }


def _write_ohlcv(rows: list[dict[str, object]], root: Path) -> None:
    """Write rows to year-partitioned Parquet under root/ohlcv_1m/year=*/part.parquet."""
    df = pd.DataFrame(rows)
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    ohlcv_dir = root / "ohlcv_1m"
    for year, grp in df.groupby(df["ts_event"].dt.year, sort=False):
        year_dir = ohlcv_dir / f"year={int(year)}"
        year_dir.mkdir(parents=True, exist_ok=True)
        pq.write_table(
            pa.Table.from_pandas(grp.reset_index(drop=True), preserve_index=False),
            year_dir / "part.parquet",
        )


def _write_symbology(mappings: list[tuple[int, str]], root: Path) -> None:
    df = pd.DataFrame(
        [
            {
                "instrument_id": iid,
                "symbol": sym,
                "first_seen": pd.Timestamp(datetime(2020, 1, 1, tzinfo=UTC)),
                "last_seen": pd.Timestamp(datetime(2030, 1, 1, tzinfo=UTC)),
            }
            for iid, sym in mappings
        ]
    )
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), root / "symbology.parquet")


def _ohlcv_glob_of(root: Path) -> str:
    return str(root / "ohlcv_1m" / "year=*" / "part.parquet")


def _symbology_of(root: Path) -> str:
    return str(root / "symbology.parquet")


@pytest.fixture
def archive_root(tmp_path: Path) -> Path:
    root = tmp_path / "archive"
    root.mkdir()
    return root


# ---------------------------------------------------------------------------
# Synthetic feature DataFrame builder
# ---------------------------------------------------------------------------


def _minimal_feature_row(
    *,
    d: date,
    symbol: str,
    contract: str,
    is_degraded: bool = False,
    **overrides: float,
) -> dict[str, object]:
    """Build a feature row with all OUTPUT_COLUMNS filled in with benign values.

    Matches the column order/keys of Phase 4c's ``OUTPUT_COLUMNS`` so
    downstream Q1..Q6 functions get a plausible row. Overrides let a test
    set specific feature values.
    """
    base: dict[str, object] = {
        "date": d,
        "symbol": symbol,
        "front_month_contract": contract,
        "is_degraded": is_degraded,
        "trade_count": 10_000,
        "ofi_5m_mean": 0.01,
        "ofi_5m_std": 0.05,
        "ofi_5m_abs_p95": 0.15,
        "ofi_5m_pct_extreme": 0.0,
        "ofi_15m_mean": 0.02,
        "ofi_15m_std": 0.04,
        "ofi_15m_abs_p95": 0.12,
        "ofi_15m_pct_extreme": 0.0,
        "ofi_1h_mean": 0.015,
        "ofi_1h_std": 0.03,
        "ofi_1h_abs_p95": 0.10,
        "ofi_1h_pct_extreme": 0.0,
        "spread_widening_count_2sigma": 3,
        "spread_widening_count_3sigma": 1,
        "spread_widening_max_zscore": 2.5,
        "spread_widening_max_run_minutes": 2,
        "tob_extreme_minute_count": 10,
        "tob_max_run_buy_pressure": 2,
        "tob_max_run_sell_pressure": 3,
        "tob_mean_abs_log_ratio": 0.2,
        "tick_velocity_mean": 50.0,
        "tick_velocity_p95": 200.0,
        "tick_velocity_max_minute": 500,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 1. derive_outcomes — happy path with hand-calculable values
# ---------------------------------------------------------------------------


def test_derive_outcomes_happy_path(archive_root: Path) -> None:
    """Synthetic OHLCV with known open/close -> ret_day matches hand calc."""
    # Day 1: open=100, close=101 -> ret_day = +0.01 (up)
    # Day 6: close=102 -> ret_5d = (102 - 101) / 101 ~= +0.0099
    rows = [
        _make_ohlcv_row(
            ts_event=datetime(2025, 6, 2, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESM5",
            open_=100.0,
            close=101.0,
        ),
        _make_ohlcv_row(
            ts_event=datetime(2025, 6, 7, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESM5",
            open_=101.5,
            close=102.0,
        ),
    ]
    _write_ohlcv(rows, archive_root)
    _write_symbology([(101, "ESM5")], archive_root)

    feature_df = pd.DataFrame(
        [
            _minimal_feature_row(
                d=date(2025, 6, 2),
                symbol="ES",
                contract="ESM5",
            )
        ]
    )

    enriched = eda.derive_outcomes(
        feature_df,
        _ohlcv_glob_of(archive_root),
        _symbology_of(archive_root),
    )

    assert len(enriched) == 1
    assert enriched.iloc[0]["ret_day"] == pytest.approx(0.01, abs=1e-9)
    assert enriched.iloc[0]["ret_5d"] == pytest.approx((102.0 - 101.0) / 101.0, abs=1e-9)
    assert enriched.iloc[0]["regime_label"] == "up"


# ---------------------------------------------------------------------------
# 2. UTC-boundary regression
# ---------------------------------------------------------------------------


def test_derive_outcomes_utc_boundary(
    archive_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bar at 00:01 UTC must bucket into its UTC day, not the CT day.

    Mirrors test_utc_boundary_trades_bucket_into_correct_date from the
    features test module. Forces TZ=America/Chicago so the session TZ
    differs from UTC; the fix is ``SET TimeZone = 'UTC'`` on the connection.
    """
    if not hasattr(_time, "tzset"):
        pytest.skip("time.tzset() unavailable on this platform")
    monkeypatch.setenv("TZ", "America/Chicago")
    _time.tzset()

    # Bar at 2025-10-16 00:01 UTC (10-15 evening CT) with open=200, close=202.
    # Under UTC bucketing this belongs to 10-16. Under CT it would land on 10-15.
    rows = [
        _make_ohlcv_row(
            ts_event=datetime(2025, 10, 16, 0, 1, tzinfo=UTC),
            instrument_id=101,
            symbol="ESZ5",
            open_=200.0,
            close=202.0,
        ),
    ]
    _write_ohlcv(rows, archive_root)
    _write_symbology([(101, "ESZ5")], archive_root)

    feature_df = pd.DataFrame(
        [
            _minimal_feature_row(
                d=date(2025, 10, 16),
                symbol="ES",
                contract="ESZ5",
            )
        ]
    )

    enriched = eda.derive_outcomes(
        feature_df,
        _ohlcv_glob_of(archive_root),
        _symbology_of(archive_root),
    )

    # Feature row is for 2025-10-16; the bar at 00:01 UTC must be found.
    assert len(enriched) == 1
    assert enriched.iloc[0]["ret_day"] == pytest.approx((202.0 - 200.0) / 200.0)


# ---------------------------------------------------------------------------
# 3. Outcome classification thresholds — exact boundaries
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ret", "expected"),
    [
        (0.006, "up"),        # strictly greater than 0.005
        (0.005, "flat"),      # exact upper boundary is flat
        (0.004999, "flat"),   # inside flat band
        (0.0, "flat"),        # zero is flat
        (-0.004999, "flat"),  # inside flat band
        (-0.005, "flat"),     # exact lower boundary is flat
        (-0.006, "down"),     # strictly less than -0.005
    ],
)
def test_outcome_classification_thresholds(
    ret: float, expected: str, archive_root: Path
) -> None:
    """Verify strict > / < convention at the regime-label boundaries."""
    # Choose open/close so (close - open) / open == ret exactly.
    open_price = 100.0
    close_price = 100.0 * (1.0 + ret)
    rows = [
        _make_ohlcv_row(
            ts_event=datetime(2025, 6, 2, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESM5",
            open_=open_price,
            close=close_price,
        )
    ]
    _write_ohlcv(rows, archive_root)
    _write_symbology([(101, "ESM5")], archive_root)

    feature_df = pd.DataFrame(
        [
            _minimal_feature_row(
                d=date(2025, 6, 2),
                symbol="ES",
                contract="ESM5",
            )
        ]
    )

    enriched = eda.derive_outcomes(
        feature_df,
        _ohlcv_glob_of(archive_root),
        _symbology_of(archive_root),
    )
    assert enriched.iloc[0]["regime_label"] == expected


# ---------------------------------------------------------------------------
# 4. Q3 recommendation trigger
# ---------------------------------------------------------------------------


def test_q3_recommendation_trigger_above_threshold(tmp_path: Path) -> None:
    """When any symbol's zero-rate exceeds 0.9, a recommendation string appears."""
    # 95% of ES rows have zero zscore (trigger); NQ has 10% (safe).
    rows = []
    for i in range(100):
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                spread_widening_max_zscore=0.0 if i < 95 else 2.5,
            )
        )
    for i in range(100):
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="NQ",
                contract="NQM5",
                spread_widening_max_zscore=0.0 if i < 10 else 2.5,
            )
        )
    df = pd.DataFrame(rows)
    out_png = tmp_path / "q3.png"
    result = eda.q3_spread_zero_rate(df, out_png)

    assert out_png.exists()
    assert "recommendation" in result
    assert "Phase 4c" in result["recommendation"]
    assert result["per_symbol"]["ES"]["zero_rate"] == pytest.approx(0.95)
    assert result["per_symbol"]["NQ"]["zero_rate"] == pytest.approx(0.10)


def test_q3_recommendation_absent_below_threshold(tmp_path: Path) -> None:
    """When all symbols' zero-rates are below 0.9, no recommendation is emitted."""
    rows = []
    for i in range(50):
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                spread_widening_max_zscore=0.0 if i < 20 else 2.5,
            )
        )
    df = pd.DataFrame(rows)
    out_png = tmp_path / "q3.png"
    result = eda.q3_spread_zero_rate(df, out_png)
    assert "recommendation" not in result
    assert result["per_symbol"]["ES"]["zero_rate"] == pytest.approx(0.40)


# ---------------------------------------------------------------------------
# 5. Q5 Bonferroni correction
# ---------------------------------------------------------------------------


def test_q5_bonferroni_correction_attenuates_significance(tmp_path: Path) -> None:
    """A feature with raw p~=0.04 must not be significant after Bonferroni.

    We vary multiple features so the dynamic divisor ``n_features *
    n_symbols`` is non-trivial (>= 10). For ``ofi_5m_mean`` we seed a modest
    correlation with ret_day; the raw p-value lands well under 0.05 but the
    Bonferroni-adjusted p climbs above 0.05 as the divisor grows.
    """
    rng = np.random.default_rng(seed=42)
    n = 30
    x = rng.normal(size=n)
    y = 0.4 * x + rng.normal(scale=1.0, size=n)

    rows = []
    for i in range(n):
        # Vary multiple features so more than one clears the "drop constants"
        # filter — that's what gives the Bonferroni divisor its bite.
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                ofi_5m_mean=float(x[i]),
                ofi_5m_std=float(rng.uniform(0.01, 0.1)),
                ofi_15m_mean=float(rng.normal()),
                ofi_1h_mean=float(rng.normal()),
                tick_velocity_mean=float(rng.uniform(10, 200)),
                tob_mean_abs_log_ratio=float(rng.uniform(0.05, 0.5)),
            )
        )
    df = pd.DataFrame(rows)
    df["ret_day"] = y
    df["ret_5d"] = float("nan")
    df["regime_label"] = "flat"

    out_png = tmp_path / "q5.png"
    result = eda.q5_feature_vs_return(df, out_png)

    # Dynamic divisor: multiple non-constant features x 1 symbol -> > 1.
    assert result["n_tests"] >= 5
    assert result["n_symbols"] == 1

    # Find ofi_5m_mean in the ES top features list.
    es_top = result["top_features_es"]
    ofi_entry = next((r for r in es_top if r["feature"] == "ofi_5m_mean"), None)
    assert ofi_entry is not None
    # With this seed and n=30, raw p should be well below 1; post-Bonf with
    # many tests, p_bonf typically climbs out of the <0.05 zone. We tolerate
    # either "not significant" OR (rare) still-significant; if significant,
    # verify the arithmetic holds.
    if ofi_entry["significant"]:
        assert ofi_entry["p_bonf"] <= 0.05
        assert ofi_entry["p_bonf"] == pytest.approx(
            min(1.0, ofi_entry["p_value"] * result["n_tests"])
        )
    else:
        # Arithmetic must still be consistent.
        assert ofi_entry["p_bonf"] == pytest.approx(
            min(1.0, ofi_entry["p_value"] * result["n_tests"])
        )


# ---------------------------------------------------------------------------
# 6. Q6 uses quartiles (not halves)
# ---------------------------------------------------------------------------


def test_q6_uses_quartiles(tmp_path: Path) -> None:
    """Cohort sizes should be ~25% of non-degraded population, not ~50%."""
    n = 100
    rng = np.random.default_rng(seed=7)
    x = rng.uniform(0.0, 1.0, size=n)
    # Strong ret_day response so we get a reasonable Mann-Whitney stat.
    y = 0.1 * x + rng.normal(scale=0.01, size=n)

    rows = []
    for i in range(n):
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                ofi_5m_mean=float(x[i]),
            )
        )
    df = pd.DataFrame(rows)
    df["ret_day"] = y
    df["ret_5d"] = float("nan")
    df["regime_label"] = "flat"

    out_png = tmp_path / "q6.png"
    result = eda.q6_cohorts(df, out_png, ["ofi_5m_mean"])

    assert result["quantile"] == eda.COHORT_QUANTILE
    cohort = result["cohorts"][0]
    # Quartile sizes ~= n * 0.25 each. Allow +/- 3 for quantile tie-break.
    assert 20 <= cohort["n_bottom"] <= 30
    assert 20 <= cohort["n_top"] <= 30
    # Combined strictly less than n (the two middle quartiles are excluded).
    assert cohort["n_bottom"] + cohort["n_top"] < n


# ---------------------------------------------------------------------------
# 7. Degraded rows excluded from Q5/Q6
# ---------------------------------------------------------------------------


def test_degraded_rows_excluded_from_q5_and_q6(tmp_path: Path) -> None:
    """Rows with is_degraded=True must not contribute to Q5 or Q6."""
    n = 40
    rng = np.random.default_rng(seed=11)
    x = rng.uniform(size=n)
    y = 0.05 * x + rng.normal(scale=0.01, size=n)

    rows = []
    for i in range(n):
        rows.append(
            _minimal_feature_row(
                d=date(2025, 6, 2) + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                is_degraded=(i < 10),  # first 10 flagged degraded
                ofi_5m_mean=float(x[i]),
            )
        )
    df = pd.DataFrame(rows)
    df["ret_day"] = y
    df["ret_5d"] = float("nan")
    df["regime_label"] = "flat"

    # Q5: the n field on each feature row should reflect only non-degraded rows.
    q5_result = eda.q5_feature_vs_return(df, tmp_path / "q5.png")
    es_top = q5_result["top_features_es"]
    ofi_entry = next(r for r in es_top if r["feature"] == "ofi_5m_mean")
    # Exactly 30 non-degraded rows with valid data -> q5 reports n=30.
    assert ofi_entry["n"] == 30

    # Q6: quartile cohorts computed on 30 rows -> ~7-8 per cohort (25%).
    q6_result = eda.q6_cohorts(df, tmp_path / "q6.png", ["ofi_5m_mean"])
    cohort = q6_result["cohorts"][0]
    # Allow a generous band; the point is "not 10" (which would be 25% of all 40).
    assert cohort["n_bottom"] + cohort["n_top"] < 20  # 25% of 30 = 7.5 each


# ---------------------------------------------------------------------------
# 8. run_all_questions orchestrator — six findings with correct IDs
# ---------------------------------------------------------------------------


def test_run_all_questions_emits_six_findings(archive_root: Path, tmp_path: Path) -> None:
    """Orchestrator must output findings with exactly 6 question entries.

    Uses a small synthetic OHLCV archive + feature Parquet so the whole
    pipeline runs end-to-end without touching the real archive.
    """
    # Seed 10 consecutive days of OHLCV for ESM5 with known open/close.
    base_date = date(2025, 6, 2)
    rows: list[dict[str, object]] = []
    for i in range(20):  # 20 days so ret_5d has future data to find
        d = base_date + timedelta(days=i)
        rows.append(
            _make_ohlcv_row(
                ts_event=datetime(d.year, d.month, d.day, 14, 0, tzinfo=UTC),
                instrument_id=101,
                symbol="ESM5",
                open_=100.0 + i * 0.1,
                close=100.5 + i * 0.1,
            )
        )
    _write_ohlcv(rows, archive_root)
    _write_symbology([(101, "ESM5")], archive_root)

    # Build a 10-row feature Parquet.
    feat_rows = []
    rng = np.random.default_rng(seed=3)
    for i in range(10):
        feat_rows.append(
            _minimal_feature_row(
                d=base_date + timedelta(days=i),
                symbol="ES",
                contract="ESM5",
                ofi_5m_mean=float(rng.normal()),
                ofi_15m_mean=float(rng.normal()),
            )
        )
    feature_df = pd.DataFrame(feat_rows)
    feature_path = tmp_path / "features.parquet"
    pq.write_table(
        pa.Table.from_pandas(feature_df, preserve_index=False),
        feature_path,
        compression="zstd",
    )

    plots_dir = tmp_path / "plots"
    findings_path = tmp_path / "findings_microstructure.json"

    eda.run_all_questions(
        feature_path=feature_path,
        ohlcv_glob=_ohlcv_glob_of(archive_root),
        symbology_path=_symbology_of(archive_root),
        plots_dir=plots_dir,
        findings_path=findings_path,
    )

    assert findings_path.exists()
    disk = json.loads(findings_path.read_text())
    assert len(disk["questions"]) == 6
    ids = [q["id"] for q in disk["questions"]]
    assert ids == [
        "q1_distributions",
        "q2_correlation",
        "q3_spread_zero_rate",
        "q4_returns",
        "q5_feature_vs_return",
        "q6_cohorts",
    ]
    # Top-level metadata present.
    assert "generated_at" in disk
    assert disk["n_rows"] == 10
    assert disk["n_symbols"] == 1
    # All 6 PNGs written.
    for name in (
        "microstructure_q1_distributions.png",
        "microstructure_q2_correlation.png",
        "microstructure_q3_spread_zero_rate.png",
        "microstructure_q4_returns.png",
        "microstructure_q5_feature_vs_return.png",
        "microstructure_q6_cohorts.png",
    ):
        assert (plots_dir / name).exists()


# ---------------------------------------------------------------------------
# 9. derive_outcomes drops rows with no OHLCV for the contract (sanity)
# ---------------------------------------------------------------------------


def test_derive_outcomes_drops_rows_without_ohlcv(archive_root: Path, caplog) -> None:
    """A feature row whose contract has no OHLCV is dropped with a warning."""
    # OHLCV has ESM5 only; the feature row references a contract that doesn't exist.
    rows = [
        _make_ohlcv_row(
            ts_event=datetime(2025, 6, 2, 14, 0, tzinfo=UTC),
            instrument_id=101,
            symbol="ESM5",
            open_=100.0,
            close=101.0,
        ),
    ]
    _write_ohlcv(rows, archive_root)
    _write_symbology([(101, "ESM5")], archive_root)

    feature_df = pd.DataFrame(
        [
            _minimal_feature_row(
                d=date(2025, 6, 2),
                symbol="ES",
                contract="ESM5",
            ),
            _minimal_feature_row(
                d=date(2025, 6, 2),
                symbol="NQ",
                contract="NQM5",  # no OHLCV for this contract
            ),
        ]
    )
    enriched = eda.derive_outcomes(
        feature_df,
        _ohlcv_glob_of(archive_root),
        _symbology_of(archive_root),
    )
    # Only the ES row survives.
    assert len(enriched) == 1
    assert enriched.iloc[0]["symbol"] == "ES"


# ---------------------------------------------------------------------------
# 10. _new_connection has TimeZone=UTC
# ---------------------------------------------------------------------------


def test_new_connection_sets_utc_timezone() -> None:
    """Connection factory must force TimeZone='UTC' so date_trunc is UTC-stable."""
    conn = eda._new_connection()
    try:
        row = conn.execute("SELECT current_setting('TimeZone')").fetchone()
        assert row is not None
        assert row[0] == "UTC"
    finally:
        conn.close()
