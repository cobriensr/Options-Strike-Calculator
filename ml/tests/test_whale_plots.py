"""ml/src/whale_plots.py reads a given by-day dir and writes to a given out dir.

The fixtures are per-day chains files in the pinned layout of
scripts/_eod_flow.py (CHAINS_COLUMNS: the 22 columns and their types), built the
way both kinds of day come: the 44 seeded days carry `equity_type` and `sector`,
the days built from the Full Tape leave them NULL.

Every file a test writes is under tmp_path. The tracked ml/plots/whale-detection
is only read, to prove nothing writes there.
"""

import os
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import whale_plots

# Plot 11 passes edgecolors to an "x" marker, which matplotlib ignores with this
# warning. The plot code is not touched here; its output is what it was.
pytestmark = pytest.mark.filterwarnings(
    "ignore:You passed a edgecolor/edgecolors:UserWarning"
)

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
ML_SRC = ML_ROOT / "src"
REAL_PLOT_DIR = ML_ROOT / "plots" / "whale-detection"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
from _eod_flow import CHAINS_COLUMNS  # noqa: E402

ARROW_TYPES = {
    "VARCHAR": pa.string(),
    "DOUBLE": pa.float64(),
    "DATE": pa.date32(),
    "BIGINT": pa.int64(),
    "TIMESTAMPTZ": pa.timestamp("us", tz="UTC"),
}
DAYS = [date(2026, 10, 28), date(2026, 10, 29), date(2026, 10, 30)]  # all CDT

# The 14 charts: plot 01 draws one per ticker, plots 02-13 one each.
EXPECTED_PNGS = [
    "01_daily_footprint_ndxp.png",
    "01_daily_footprint_spxw.png",
    "02_eleven_day_timeline.png",
    "03_todays_level_map.png",
    "04_outcome_scatter.png",
    "05_time_to_target.png",
    "06_rr_distribution.png",
    "07_premium_distribution.png",
    "08_filter_funnel.png",
    "09_trade_count_distribution.png",
    "10_alignment_matrix.png",
    "11_synthetic_detector.png",
    "12_minute_clustering.png",
    "13_strike_magnet.png",
]

WHALE_PREMIUM = 5_000_000.0  # every whale ties at the top, so each clears the p95
FILLER_PREMIUM = 200_000.0


# ── fixtures: by-day files in the pinned schema ───────────────────────────────


def chain(
    day: date,
    ticker: str,
    strike: float,
    option_type: str,
    side: str,
    *,
    premium: float = WHALE_PREMIUM,
    minute: int = 35,
    minutes_long: int = 20,
    expiry_days: int = 0,
    **over,
) -> dict:
    """One chain row. A whale (default premium, 8 prints, one-sided, at the money)
    passes every step of the checklist."""
    spot = 6800.0 if ticker == "SPXW" else 24500.0
    first = datetime(day.year, day.month, day.day, 14, minute, tzinfo=UTC)  # 09:xx CT
    ask, bid = (90.0, 10.0) if side == "ask" else (10.0, 90.0)
    letter = option_type[0].upper()
    row = {
        "trade_date": day.isoformat(),
        "option_chain_id": f"{ticker}{day:%y%m%d}{letter}{int(strike):08d}",
        "ticker": ticker,
        "underlying_symbol": "SPX" if ticker == "SPXW" else "NDX",
        "strike": strike,
        "option_type": option_type,
        "expiry": day + timedelta(days=expiry_days),
        "equity_type": None,
        "sector": None,
        "total_size": ask + bid,
        "total_premium": premium,
        "day_volume": 1_000,
        "day_oi": 100,
        "ask_size": ask,
        "bid_size": bid,
        "first_ts": first,
        "last_ts": first + timedelta(minutes=minutes_long),
        "first_price": 10.0,
        "last_price": 12.0,
        "first_underlying": spot,
        "last_underlying": spot + 10.0,
        "trade_count": 8,
    }
    row.update(over)
    return row


def day_chains(day: date, **over) -> list[dict]:
    """A session's chains: SPXW and NDXP whales in both directions, a 6800 put at
    the first whale's strike printed at the same time (a simultaneous pair), and
    fillers below the premium cutoff."""
    return [
        # bullish: ask-bought call, bid-sold put; bearish: ask-bought put, bid-sold call
        chain(day, "SPXW", 6800.0, "call", "ask", **over),
        chain(day, "SPXW", 6750.0, "put", "ask", minute=40, **over),
        chain(day, "SPXW", 6700.0, "put", "bid", minute=45, **over),
        chain(day, "SPXW", 6850.0, "call", "bid", minute=50, **over),
        chain(day, "SPXW", 6800.0, "put", "ask", premium=FILLER_PREMIUM, **over),
        chain(day, "SPXW", 6900.0, "call", "ask", premium=FILLER_PREMIUM, **over),
        chain(day, "NDXP", 24500.0, "call", "ask", minute=36, **over),
        chain(day, "NDXP", 24400.0, "put", "ask", minute=41, **over),
        chain(day, "NDXP", 24600.0, "call", "ask", premium=FILLER_PREMIUM, **over),
    ]


def write_by_day(path: Path, rows: list[dict]) -> Path:
    columns = {
        name: pa.array([r[name] for r in rows], ARROW_TYPES[sql_type])
        for name, sql_type in CHAINS_COLUMNS
    }
    pq.write_table(pa.table(columns), path)
    return path


def write_days(directory: Path) -> Path:
    """Three sessions. The first is a seeded day (equity_type and sector filled),
    the other two are built from the tape (both NULL)."""
    directory.mkdir(parents=True, exist_ok=True)
    seeded = {"equity_type": "Common Stock", "sector": "Tech"}
    for i, day in enumerate(DAYS):
        rows = day_chains(day, **(seeded if i == 0 else {}))
        write_by_day(directory / f"{day.isoformat()}-chains.parquet", rows)
    return directory


def pngs(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.glob("*.png"))


def snapshot(directory: Path) -> dict[str, int]:
    """Every file in `directory` with its modification time, ns."""
    return {p.name: p.stat().st_mtime_ns for p in directory.iterdir()}


@pytest.fixture
def by_day_dir(tmp_path: Path) -> Path:
    return write_days(tmp_path / "by-day")


# ── load_data ─────────────────────────────────────────────────────────────────


def test_whale_plots_reads_seeded_and_tape_built_days(tmp_path):
    # The strict pl.concat in load_data needs one schema across both kinds of day.
    directory = tmp_path / "by-day"
    directory.mkdir()
    write_by_day(
        directory / "2026-10-28-chains.parquet",
        [
            chain(
                DAYS[0],
                "SPXW",
                6800.0,
                "call",
                "ask",
                equity_type="Common Stock",
                sector="Tech",
            )
        ],
    )
    for day in DAYS[1:]:
        write_by_day(
            directory / f"{day.isoformat()}-chains.parquet",
            [chain(day, "SPXW", 6800.0, "call", "ask")],
        )

    df = whale_plots.load_data(directory)

    assert df["trade_date"].to_list() == [d.isoformat() for d in DAYS]
    assert df["equity_type"].to_list() == ["Common Stock", None, None]
    assert df["sector"].to_list() == ["Tech", None, None]
    assert df.schema["equity_type"] == pl.String
    assert df.schema["sector"] == pl.String
    # The derived columns every plot reads.
    assert df["ask_pct"].to_list() == [0.9, 0.9, 0.9]
    assert df.schema["first_ct"].time_zone == "America/Chicago"
    assert df["first_ct"].dt.hour().to_list() == [9, 9, 9]
    assert df["dte"].to_list() == [0, 0, 0]
    assert df["moneyness"].to_list() == [0.0, 0.0, 0.0]


def test_load_data_reads_only_chains_files_of_the_given_dir(tmp_path):
    directory = write_days(tmp_path / "by-day")
    (directory / "2026-10-31-chains.csv").write_text("not a parquet file")
    (directory / "cumulative-headlines.txt").write_text("not a parquet file")

    df = whale_plots.load_data(directory)

    assert df["trade_date"].n_unique() == 3
    assert df.height == 27


def test_load_data_without_chains_files_names_the_dir(tmp_path):
    with pytest.raises(FileNotFoundError, match="No parquet files in") as exc:
        whale_plots.load_data(tmp_path)
    assert str(tmp_path) in str(exc.value)


# ── the fixture itself ────────────────────────────────────────────────────────


def test_fixture_whales_pass_the_checklist(by_day_dir):
    # If this fails the fixture is wrong, not the module: the whale plots below
    # need whales on every day, in both directions, for both tickers.
    df = whale_plots.load_data(by_day_dir)
    qual = whale_plots.apply_checklist(df, whale_plots.compute_thresholds(df))

    assert qual.height == 18  # 6 whales a day, no filler
    assert set(qual["total_premium"].to_list()) == {WHALE_PREMIUM}
    assert set(qual["ticker"].to_list()) == {"SPXW", "NDXP"}
    assert set(qual["direction"].to_list()) == {"bullish", "bearish"}
    assert sorted(qual["trade_date"].unique().to_list()) == [
        d.isoformat() for d in DAYS
    ]


# ── main ──────────────────────────────────────────────────────────────────────


def test_whale_plots_writes_only_to_out_dir(by_day_dir, tmp_path, capsys):
    # The default out dir is the tracked ml/plots/whale-detection. It must be
    # there to be watched, and be the module's default, or this proves nothing.
    assert whale_plots.OUTPUT_DIR.resolve() == REAL_PLOT_DIR.resolve()
    assert len(pngs(REAL_PLOT_DIR)) == 14
    before = snapshot(REAL_PLOT_DIR)
    out = tmp_path / "out"

    code = whale_plots.main(["--by-day-dir", str(by_day_dir), "--out-dir", str(out)])

    assert code == 0
    assert pngs(out) == EXPECTED_PNGS
    assert all((out / name).stat().st_size > 0 for name in EXPECTED_PNGS)
    assert snapshot(REAL_PLOT_DIR) == before
    printed = capsys.readouterr().out
    assert str(out) in printed
    assert "2026-10-30" in printed


def test_a_failing_plot_does_not_stop_the_others_and_the_exit_is_one(
    by_day_dir, tmp_path, monkeypatch, capsys
):
    def broken(*args, **kwargs):
        raise ValueError("plot blew up")

    monkeypatch.setattr(whale_plots, "plot_06_rr_distribution", broken)
    out = tmp_path / "out"

    code = whale_plots.main(["--by-day-dir", str(by_day_dir), "--out-dir", str(out)])

    assert code == 1
    assert pngs(out) == [n for n in EXPECTED_PNGS if not n.startswith("06_")]
    captured = capsys.readouterr()
    assert "06_rr_distribution FAILED" in captured.err
    assert "ValueError" in captured.err
    assert "1/13 plot(s) failed" in captured.err
    # The summary still prints for the failed run, for the date and the out dir.
    assert str(out) in captured.out


def test_main_with_no_chains_files_raises_and_writes_no_plot(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    out = tmp_path / "out"

    with pytest.raises(FileNotFoundError, match="No parquet files in"):
        whale_plots.main(["--by-day-dir", str(empty), "--out-dir", str(out)])

    assert pngs(out) == []


def test_main_runs_as_a_script_with_the_dirs_the_nightly_passes(by_day_dir, tmp_path):
    # The nightly step runs the file as a subprocess with these two flags. What
    # runs here is a copy under tmp_path: the script takes its default dirs from
    # its own location, so a script that ignored the flags would read and write
    # under tmp_path (and fail) instead of regenerating the tracked plots.
    script_dir = tmp_path / "app" / "ml" / "src"
    script_dir.mkdir(parents=True)
    script = script_dir / "whale_plots.py"
    script.write_bytes((ML_SRC / "whale_plots.py").read_bytes())
    out = tmp_path / "out"

    child = subprocess.run(
        [
            sys.executable,
            str(script),
            "--by-day-dir",
            str(by_day_dir),
            "--out-dir",
            str(out),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env={**os.environ, "MPLBACKEND": "Agg", "PYTHONIOENCODING": "utf-8"},
    )

    assert child.returncode == 0, child.stderr
    assert pngs(out) == EXPECTED_PNGS


# ── print_pipeline_summary ────────────────────────────────────────────────────


@pytest.mark.parametrize("latest", ["2026-10-30", date(2026, 10, 30)])
def test_print_pipeline_summary_prints_only_the_date_and_out_dir(
    latest, tmp_path, capsys
):
    whale_plots.print_pipeline_summary(latest, tmp_path / "out")

    printed = capsys.readouterr().out
    assert "2026-10-30" in printed
    assert str(tmp_path / "out") in printed
    # The retired Make-era lines: where the aggregate, the Blob copy and the
    # archive were, and what to commit.
    for retired in ("blob", "archive", "commit", "aggregate", "cumulative", "~/"):
        assert retired not in printed.lower()
