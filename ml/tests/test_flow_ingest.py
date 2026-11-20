"""Unit tests for scripts/ingest-flow.py: header check, closed enums, the
Bot-EOD archive write, and main() end to end on a small synthetic CSV."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from unittest.mock import patch

import polars as pl
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Load the script as a module (script filename has hyphens, not a valid identifier)
_spec = importlib.util.spec_from_file_location(
    "ingest_flow", REPO_ROOT / "scripts" / "ingest-flow.py"
)
assert _spec is not None and _spec.loader is not None
ingest_flow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ingest_flow)

DAY = "2026-04-24"


@pytest.fixture(autouse=True)
def _default_dirs_stay_under_tmp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Move the script's default dirs into tmp_path: a run that ignored
    --archive-dir or --input-dir would otherwise write under the home
    directory, where the owner's real Bot-EOD archive lives."""
    monkeypatch.setattr(
        ingest_flow, "DEFAULT_ARCHIVE_DIR", tmp_path / "default-archive"
    )
    monkeypatch.setattr(ingest_flow, "DEFAULT_INPUT_DIR", tmp_path / "default-input")


# Shape mirrors actual UW samples: `f`/`t` for `canceled`, a `+00` UTC offset.
# The AAPL row carries `extended_hours_trade`: the archive keeps every print,
# so it must survive the run.
ROWS = [
    "2026-04-24 14:00:00.000000+00,SPY,SPY260515P00650000,ask,650,put,2026-05-15,710.76,1.25,1.35,1.25,1.35,1.30,3,390,3,121751,0.25,-0.07,-0.14,0.003,0.225,-0.029,1.30,,XPHO,{},f,auto,ETF",
    "2026-04-24 14:00:01.000000+00,QQQ,QQQ260515C00500000,bid,500,call,2026-05-15,510.00,5.00,5.10,5.00,5.10,5.05,1,505,1,2426,0.20,0.50,-0.05,0.01,0.30,-0.10,5.05,,XCBO,{},t,auto,ETF",
    "2026-04-24 14:00:02.000000+00,AAPL,AAPL260515C00200000,ask,200,call,2026-05-15,205.00,1.00,1.10,1.00,1.10,1.05,1,105,1,500,0.30,0.40,-0.08,0.02,0.20,-0.15,1.05,Tech,XPHO,{extended_hours_trade},f,auto,Common Stock",
]


def _write_csv(tmp_path: Path, rows: list[str] = ROWS) -> Path:
    input_dir = tmp_path / "EOD-OptionFlow"
    input_dir.mkdir(exist_ok=True)
    csv = input_dir / f"bot-eod-report-{DAY}.csv"
    header = ",".join(ingest_flow.FLOW_SCHEMA.keys())
    csv.write_text("\n".join([header, *rows]) + "\n")
    return csv


def _run(tmp_path: Path, *extra: str) -> int:
    return ingest_flow.main(
        [
            DAY,
            "--input-dir",
            str(tmp_path / "EOD-OptionFlow"),
            "--archive-dir",
            str(tmp_path / "Bot-Eod-parquet"),
            *extra,
        ]
    )


def _archive(tmp_path: Path) -> Path:
    return tmp_path / "Bot-Eod-parquet" / f"{DAY}-trades.parquet"


# --- main(): the archive is the only output ---------------------------------


def test_ingest_writes_the_archive_and_never_touches_blob(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No Blob token is needed, nothing is uploaded, and the module no longer
    carries a Blob client."""
    monkeypatch.delenv("BLOB_READ_WRITE_TOKEN", raising=False)
    csv = _write_csv(tmp_path)

    rc = _run(tmp_path)

    assert rc == 0
    assert _archive(tmp_path).is_file()
    assert not csv.exists()
    assert not hasattr(ingest_flow, "requests")
    assert not hasattr(ingest_flow, "upload_to_blob")


def test_archive_holds_every_print_of_the_csv(tmp_path: Path) -> None:
    """The archive is the unfiltered CSV: the extended-hours print stays, and
    `canceled` keeps UW's `f`/`t` literals."""
    _write_csv(tmp_path)

    assert _run(tmp_path) == 0

    df = pl.read_parquet(_archive(tmp_path))
    assert df.height == 3
    assert sorted(df["underlying_symbol"].to_list()) == ["AAPL", "QQQ", "SPY"]
    assert sorted(df["canceled"].to_list()) == ["f", "f", "t"]
    assert df["executed_at"].dtype == pl.Datetime("us", "UTC")
    assert df["expiry"].dtype == pl.Date
    assert df.columns == list(ingest_flow.FLOW_SCHEMA.keys())


def test_keep_csv_keeps_it(tmp_path: Path) -> None:
    csv = _write_csv(tmp_path)

    assert _run(tmp_path, "--keep-csv") == 0

    assert csv.is_file()
    assert _archive(tmp_path).is_file()


def test_top_underlyings_summary_counts_every_print(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The closing summary reads the archive, so the extended-hours AAPL print
    is counted too."""
    _write_csv(tmp_path)

    assert _run(tmp_path) == 0

    out = capsys.readouterr().out
    assert "Top 10 underlyings:" in out
    summary = out.split("Top 10 underlyings:")[1]
    counts = {
        sym: int(n.replace(",", ""))
        for sym, n in re.findall(r"^\s+(\S+)\s+([\d,]+)$", summary, re.MULTILINE)
    }
    assert counts == {"SPY": 1, "QQQ": 1, "AAPL": 1}


def test_null_underlying_symbol_is_labelled_in_the_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A blank symbol in the CSV is a null in the archive; the summary labels
    it instead of failing to format it."""
    blank = ROWS[0].replace(",SPY,SPY260515P", ",,SPY260515P")
    assert blank != ROWS[0]
    _write_csv(tmp_path, rows=[blank, *ROWS[1:]])

    assert _run(tmp_path) == 0

    assert "(null)" in capsys.readouterr().out.split("Top 10 underlyings:")[1]


def test_summary_failure_keeps_the_csv(tmp_path: Path) -> None:
    """The summary is computed before the CSV is deleted, so a failure there
    leaves the CSV in place."""
    csv = _write_csv(tmp_path)

    with patch.object(
        pl.LazyFrame, "group_by", side_effect=RuntimeError("summary failed")
    ):
        with pytest.raises(RuntimeError, match="summary failed"):
            _run(tmp_path)

    assert csv.exists()


@pytest.mark.parametrize("flag", ["--dry-run", "--skip-archive"])
def test_retired_flags_are_rejected(tmp_path: Path, flag: str) -> None:
    _write_csv(tmp_path)
    with pytest.raises(SystemExit) as exc:
        _run(tmp_path, flag)
    assert exc.value.code == 2


def test_empty_csv_exits_2_and_writes_no_archive(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    csv = _write_csv(tmp_path, rows=[])

    rc = _run(tmp_path)

    assert rc == 2
    assert "ERROR: empty CSV" in capsys.readouterr().err
    assert not _archive(tmp_path).exists()
    assert csv.exists()


def test_bad_date_exits_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    rc = ingest_flow.main(["24-04-2026", "--input-dir", str(tmp_path)])

    assert rc == 2
    assert "date must be YYYY-MM-DD" in capsys.readouterr().err


def test_header_mismatch_writes_no_archive_and_keeps_csv(tmp_path: Path) -> None:
    """The header is checked before anything is written: a renamed column
    fails the run by name, leaves no archive, and keeps the CSV."""
    csv = _write_csv(tmp_path)
    csv.write_text(csv.read_text().replace(",rho,", ",rho_renamed,", 1))

    with pytest.raises(ValueError, match="rho_renamed"):
        _run(tmp_path)

    assert csv.exists()
    assert not _archive(tmp_path).exists()


# --- main(): closed enums are checked on the archive ------------------------


def test_closed_enums_checked_on_the_archive(tmp_path: Path) -> None:
    """An unknown `side` in the CSV fails the run by name, and the CSV is not
    deleted: it is only removed after the enum check passes."""
    bad = [ROWS[0].replace(",ask,650,", ",lifted,650,"), *ROWS[1:]]
    csv = _write_csv(tmp_path, rows=bad)

    with pytest.raises(ValueError, match="side"):
        _run(tmp_path)

    assert csv.exists()


def _write_archive(tmp_path: Path, sides: list[str]) -> Path:
    """An existing archive with one row per entry of `sides`, nothing else
    the run reads."""
    archive = _archive(tmp_path)
    archive.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(
        {
            "underlying_symbol": ["SPY"] * len(sides),
            "side": sides,
            "option_type": ["put"] * len(sides),
            "equity_type": ["ETF"] * len(sides),
        }
    ).write_parquet(archive)
    return archive


def test_enum_check_reads_the_archive_not_the_csv(tmp_path: Path) -> None:
    """A valid CSV next to an existing archive (same row count) that holds an
    unknown value fails: the check looks at what is on disk, the archive."""
    csv = _write_csv(tmp_path)
    _write_archive(tmp_path, ["lifted", "ask", "bid"])

    with pytest.raises(ValueError, match="side"):
        _run(tmp_path)

    assert csv.exists()


# --- main(): a reused archive must match the CSV ----------------------------


def test_matching_existing_archive_is_reused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A second run finds the archive with the CSV's row count, leaves it
    untouched, and still deletes the CSV."""
    csv = _write_csv(tmp_path)
    assert _run(tmp_path, "--keep-csv") == 0
    archive = _archive(tmp_path)
    written = archive.stat().st_mtime_ns
    capsys.readouterr()

    assert _run(tmp_path) == 0

    assert "Archive already exists, skipping" in capsys.readouterr().out
    assert archive.stat().st_mtime_ns == written
    assert not csv.exists()


def test_mismatched_existing_archive_is_not_reused(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """An archive with a different row count than the CSV fails the run
    (exit 2), names both counts and the path, and keeps the CSV."""
    csv = _write_csv(tmp_path)
    archive = _write_archive(tmp_path, ["ask"])
    before = archive.read_bytes()

    rc = _run(tmp_path)

    assert rc == 2
    err = capsys.readouterr().err
    assert str(archive) in err
    assert "has 1 rows but the CSV has 3" in err
    assert csv.exists()
    assert archive.read_bytes() == before


# --- validate_categoricals ---------------------------------------------------


def test_validate_categoricals_passes_on_known_values() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "bid", "mid", "no_side"],
            "option_type": ["put", "call", "put", "call"],
            "equity_type": ["ETF", "Common Stock", "Index", "ADR"],
        }
    )
    ingest_flow.validate_categoricals(df)  # should not raise


def test_validate_categoricals_rejects_unknown_side() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "lifted"],  # "lifted" not in enum
            "option_type": ["put", "call"],
            "equity_type": ["ETF", "ETF"],
        }
    )
    with pytest.raises(ValueError, match="lifted"):
        ingest_flow.validate_categoricals(df)


def test_validate_categoricals_rejects_unknown_equity_type() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", "bid"],
            "option_type": ["put", "call"],
            "equity_type": ["ETF", "Crypto"],  # "Crypto" not in enum
        }
    )
    with pytest.raises(ValueError, match="Crypto"):
        ingest_flow.validate_categoricals(df)


def test_validate_categoricals_allows_nulls() -> None:
    df = pl.DataFrame(
        {
            "side": ["ask", None],
            "option_type": ["put", None],
            "equity_type": ["ETF", None],
        }
    )
    ingest_flow.validate_categoricals(df)  # nulls should not trigger


# --- write_full_archive ------------------------------------------------------


def test_write_full_archive_atomic_rename(tmp_path: Path) -> None:
    """Happy path: parquet lands at the final path, no .tmp left behind."""
    archive = tmp_path / "2026-04-24-trades.parquet"
    lf = pl.LazyFrame({"a": [1, 2, 3]})
    ingest_flow.write_full_archive(lf, archive)
    assert archive.exists()
    assert pl.read_parquet(archive)["a"].to_list() == [1, 2, 3]
    assert not list(tmp_path.glob("*.tmp"))


def test_write_full_archive_crash_leaves_no_final_file(tmp_path: Path) -> None:
    """A crash mid-write must not leave a file at the final path — the
    caller's exists() skip guard would lock a truncated archive in."""
    archive = tmp_path / "2026-04-24-trades.parquet"
    lf = pl.LazyFrame({"a": [1]})

    def boom(self: pl.LazyFrame, path: Path, **kwargs: object) -> None:
        Path(path).write_bytes(b"partial")
        raise RuntimeError("simulated crash mid-write")

    with patch.object(pl.LazyFrame, "sink_parquet", boom):
        with pytest.raises(RuntimeError, match="simulated crash"):
            ingest_flow.write_full_archive(lf, archive)
    assert not archive.exists()


# --- validate_header ---------------------------------------------------------


def test_validate_header_passes_on_correct_header(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    csv.write_text(",".join(ingest_flow.FLOW_SCHEMA.keys()) + "\n")
    ingest_flow.validate_header(csv)  # should not raise


def test_validate_header_fails_on_extra_column(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    cols = list(ingest_flow.FLOW_SCHEMA.keys()) + ["new_uw_field"]
    csv.write_text(",".join(cols) + "\n")
    with pytest.raises(ValueError, match="new_uw_field"):
        ingest_flow.validate_header(csv)


def test_validate_header_fails_on_missing_column(tmp_path: Path) -> None:
    csv = tmp_path / "bot-eod-report-2026-04-24.csv"
    cols = [c for c in ingest_flow.FLOW_SCHEMA.keys() if c != "rho"]
    csv.write_text(",".join(cols) + "\n")
    with pytest.raises(ValueError, match="rho"):
        ingest_flow.validate_header(csv)
