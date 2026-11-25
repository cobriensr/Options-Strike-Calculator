"""Tests for scripts/verify_index_candle_repair.py, the Full Tape check.

The tool compares repaired SPX 1-minute candles with the last SPXW
``underlying_price`` per UTC minute in the UW Full Tape. These tests touch no
database and no R2: the comparison maths and the gate are pure; the Postgres
read runs against a fake ``psycopg2.connect`` (a read-only session, SELECTs
only); the tape query runs against a local Parquet file through a local DuckDB
connection, in both Full Tape layouts.

Run:
    ml/.venv/Scripts/python -m pytest -q scripts/test_verify_index_candle_repair.py
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import duckdb
import psycopg2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_index_candle_repair as vic  # noqa: E402

CREDENTIAL_NAMES = (
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
    "DATABASE_URL",
)


def minute_of(year, month, day, hour, minute) -> int:
    """The UTC epoch minute, from a clock time written out by hand."""
    stamp = datetime(year, month, day, hour, minute, tzinfo=UTC)
    return int(stamp.timestamp()) // 60


# ── minute_stats ─────────────────────────────────────────────────────────────


def test_minute_stats_gives_exact_figures_for_a_hand_built_pair():
    candles = {0: 100.0, 1: 102.0, 2: 97.0, 3: 100.5}
    tape = {0: 100.0, 1: 100.0, 2: 100.0, 3: 100.0}
    # d = candle - tape = 0, 2, -3, 0.5 -> |d| sorted 0, 0.5, 2, 3
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 4
    assert stats["mean"] == pytest.approx(-0.125, abs=1e-12)  # signed
    assert stats["median_abs"] == pytest.approx(1.25, abs=1e-12)  # (0.5 + 2) / 2
    assert stats["p95_abs"] == pytest.approx(2.85, abs=1e-12)  # 2 + 0.85 * (3 - 2)
    assert stats["p99_abs"] == pytest.approx(2.97, abs=1e-12)  # 2 + 0.97 * (3 - 2)
    assert stats["max_abs"] == 3.0


def test_minute_stats_ignores_minutes_only_one_side_has():
    candles = {0: 100.0, 1: 101.0, 77: 9999.0}  # 77 has no tape minute
    tape = {0: 100.0, 1: 100.0, 88: 1.0}  # 88 has no candle
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 2
    assert stats["max_abs"] == 1.0
    assert stats["median_abs"] == 0.5


def test_minute_stats_skips_a_non_finite_value_instead_of_poisoning_the_median():
    candles = {0: 100.0, 1: float("nan"), 2: 101.0}
    tape = {0: 100.0, 1: 100.0, 2: 100.0}
    stats = vic.minute_stats(candles, tape)
    assert stats["minutes"] == 2
    assert stats["median_abs"] == 0.5


def test_minute_stats_with_no_common_minute_reports_none_not_a_crash():
    stats = vic.minute_stats({0: 1.0}, {5: 1.0})
    assert stats["minutes"] == 0
    assert stats["median_abs"] is None
    assert stats["p99_abs"] is None
    assert stats["max_abs"] is None
    assert stats["mean"] is None
    assert vic.minute_stats({}, {})["minutes"] == 0


# ── gate ─────────────────────────────────────────────────────────────────────


def stats_of(median, p99, maximum=None, minutes=390):
    return {
        "minutes": minutes,
        "mean": 0.0,
        "median_abs": median,
        "p95_abs": p99,
        "p99_abs": p99,
        "max_abs": p99 if maximum is None else maximum,
    }


def test_gate_passes_the_aug_12_method_check():
    assert vic.gate(stats_of(0.95, 2.3)) == (True, [])


def test_gate_passes_nov_20_a_live_day_with_one_outlier_minute():
    # One minute at 25.3 against a median of 0.67: why the gate reads p99, not
    # max. The fixture takes p99 4.9 from the task brief, close under the limit;
    # the real 2026-11-20 run measured p99 2.85.
    assert vic.gate(stats_of(0.67, 4.9, maximum=25.3)) == (True, [])


def test_gate_fails_the_placeholder_with_a_reason_naming_the_median():
    ok, reasons = vic.gate(stats_of(25.1, 25.4))
    assert ok is False
    assert any("median" in reason for reason in reasons)


def test_gate_fails_on_p99_alone_and_names_p99_not_the_median():
    ok, reasons = vic.gate(stats_of(0.8, 5.01))
    assert ok is False
    assert len(reasons) == 1
    assert "p99" in reasons[0]
    assert "median" not in reasons[0]


def test_gate_limits_are_inclusive_at_2_and_5_and_fail_just_past_them():
    assert vic.gate(stats_of(2.0, 5.0)) == (True, [])
    assert vic.gate(stats_of(2.01, 5.0))[0] is False
    assert vic.gate(stats_of(2.0, 5.01))[0] is False


def test_gate_fails_no_overlap():
    ok, reasons = vic.gate(vic.minute_stats({0: 1.0}, {9: 1.0}))
    assert ok is False
    assert len(reasons) == 1
    assert "no overlap" in reasons[0]


# ── ratio_share ──────────────────────────────────────────────────────────────


def test_ratio_share_counts_the_minutes_within_1e_6():
    etf = {0: 700.0, 1: 700.0, 2: 700.0, 3: 700.0}
    ratio = 10.04
    index = {
        0: 700.0 * ratio,  # exact
        1: 700.0 * (ratio + 5e-7),  # inside the tolerance
        2: 700.0 * (ratio + 2e-6),  # outside
        3: 700.0 * (ratio - 5e-7),  # inside, below
    }
    assert vic.ratio_share(index, etf, ratio) == pytest.approx(0.75)


def test_ratio_share_honours_a_wider_tolerance():
    etf = {0: 700.0}
    index = {0: 700.0 * (10.04 + 2e-6)}
    assert vic.ratio_share(index, etf, 10.04) == 0.0
    assert vic.ratio_share(index, etf, 10.04, tol=1e-3) == 1.0


def test_ratio_share_ignores_minutes_only_one_side_has():
    etf = {0: 700.0, 5: 700.0}  # 5 has no index bar
    index = {0: 7028.0, 9: 1.0}  # 9 has no ETF bar
    assert vic.ratio_share(index, etf, 10.04) == 1.0


def test_ratio_share_is_zero_with_nothing_in_common():
    assert vic.ratio_share({0: 7028.0}, {1: 700.0}, 10.04) == 0.0
    assert vic.ratio_share({}, {}, 10.04) == 0.0


def test_ratio_share_counts_a_zero_etf_close_as_a_mismatch_not_a_division_error():
    etf = {0: 0.0, 1: 700.0}
    index = {0: 5.0, 1: 7028.0}
    assert vic.ratio_share(index, etf, 10.04) == 0.5


# ── evaluate: the gate plus the ratio check ──────────────────────────────────


def test_evaluate_passes_without_a_ratio():
    assert vic.evaluate(stats_of(0.9, 2.0), None) == (True, [])


def test_evaluate_fails_a_ratio_share_under_99_percent_and_names_the_ratio():
    ok, reasons = vic.evaluate(stats_of(0.9, 2.0), 0.98)
    assert ok is False
    assert len(reasons) == 1
    assert "ratio" in reasons[0]


def test_evaluate_passes_a_ratio_share_of_exactly_99_percent():
    assert vic.evaluate(stats_of(0.9, 2.0), 0.99) == (True, [])


def test_evaluate_keeps_the_gate_reason_next_to_the_ratio_reason():
    ok, reasons = vic.evaluate(stats_of(25.1, 25.4), 0.0)
    assert ok is False
    assert any("median" in r for r in reasons)
    assert any("ratio" in r for r in reasons)


# ── arguments ────────────────────────────────────────────────────────────────


def test_args_parse_the_documented_command():
    args = vic.parse_args(
        [
            "--symbol",
            "SPX",
            "--date",
            "2026-04-10",
            "--before",
            "17:11Z",
            "--ratio",
            "10.040707",
        ]
    )
    assert args.symbol == "SPX"
    assert args.date == date(2026, 4, 10)
    assert args.before == "17:11Z"
    assert args.ratio == 10.040707


def test_args_default_to_no_cut_and_no_ratio():
    args = vic.parse_args(["--symbol", "SPX", "--date", "2026-03-26"])
    assert args.before is None
    assert args.ratio is None


def test_args_refuse_ndx_because_the_tape_carries_no_ndx_price(capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(["--symbol", "NDX", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    assert "no NDX price" in capsys.readouterr().err


def test_args_refuse_any_other_symbol(capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(["--symbol", "QQQ", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    assert "SPX" in capsys.readouterr().err


@pytest.mark.parametrize(
    "bad",
    [
        ["--symbol", "SPX"],  # no date
        ["--date", "2026-03-26"],  # no symbol
        ["--symbol", "SPX", "--date", "2026-13-45"],
        ["--symbol", "SPX", "--date", "2026-3-26"],
        ["--symbol", "SPX", "--date", "20260326"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "17:11"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "25:00Z"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--before", "17:60Z"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "0"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "-10"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "nan"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "inf"],
        ["--symbol", "SPX", "--date", "2026-03-26", "--ratio", "ten"],
    ],
)
def test_args_refuse_malformed_input(bad, capsys):
    with pytest.raises(SystemExit) as exit_info:
        vic.parse_args(bad)
    assert exit_info.value.code == 2
    capsys.readouterr()


# ── the 04-10 cut ────────────────────────────────────────────────────────────


def test_before_minute_is_the_utc_epoch_minute():
    # 1970-01-02 00:01Z is minute 1440 + 1.
    assert vic.before_minute(date(1970, 1, 2), "00:01Z") == 1441
    assert vic.before_minute(date(1970, 1, 1), "23:59Z") == 1439


def test_apply_cut_keeps_only_minutes_strictly_before_the_cut():
    kept = vic.apply_cut({9: 1.0, 10: 2.0, 11: 3.0}, 10)
    assert kept == {9: 1.0}


def test_apply_cut_without_a_cut_keeps_everything():
    assert vic.apply_cut({9: 1.0, 10: 2.0}, None) == {9: 1.0, 10: 2.0}


# ── credentials ──────────────────────────────────────────────────────────────


def test_read_allowed_env_returns_only_the_five_credential_names(tmp_path):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "\n".join(
            [
                "# a comment",
                "R2_ACCESS_KEY_ID=key-id",
                'R2_SECRET_ACCESS_KEY="quoted-secret"',
                "R2_ENDPOINT_URL='https://r2.example'",
                "R2_BUCKET_FULLTAPE=bucket",
                "DATABASE_URL=postgres://u:p@h/d",
                "OWNER_SECRET=must-not-load",
                "ANTHROPIC_API_KEY=must-not-load",
                "R2_ACCOUNT_ID=not-needed",
                "export R2_CLOUDFLARE_TOKEN=not-needed",
            ]
        ),
        encoding="utf-8",
    )
    found = vic.read_allowed_env(env_file)
    assert found == {
        "R2_ACCESS_KEY_ID": "key-id",
        "R2_SECRET_ACCESS_KEY": "quoted-secret",
        "R2_ENDPOINT_URL": "https://r2.example",
        "R2_BUCKET_FULLTAPE": "bucket",
        "DATABASE_URL": "postgres://u:p@h/d",
    }


def test_read_allowed_env_keeps_the_first_assignment_of_a_repeated_name(tmp_path):
    # The same rule as scripts/_cli_paths.load_env_file (setdefault).
    env_file = tmp_path / ".env.local"
    env_file.write_text("DATABASE_URL=first\nDATABASE_URL=second\n", encoding="utf-8")
    assert vic.read_allowed_env(env_file) == {"DATABASE_URL": "first"}


def test_read_allowed_env_of_a_missing_file_is_empty(tmp_path):
    assert vic.read_allowed_env(tmp_path / "nope") == {}


def test_load_credentials_sets_only_the_allowed_names_and_keeps_a_shell_value(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "\n".join(
            [
                "R2_ACCESS_KEY_ID=from-file",
                "R2_SECRET_ACCESS_KEY=from-file",
                "R2_ENDPOINT_URL=https://r2.example",
                "R2_BUCKET_FULLTAPE=bucket",
                "DATABASE_URL=postgres://from-file",
                "OWNER_SECRET=must-not-load",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://from-shell"})
    vic.load_credentials(env_file)
    assert os.environ["DATABASE_URL"] == "postgres://from-shell"
    assert os.environ["R2_ACCESS_KEY_ID"] == "from-file"
    assert "OWNER_SECRET" not in os.environ


def test_load_credentials_names_what_is_missing_and_never_a_value(
    tmp_path, monkeypatch
):
    env_file = tmp_path / ".env.local"
    env_file.write_text(
        "R2_ACCESS_KEY_ID=value-that-must-not-print\n", encoding="utf-8"
    )
    monkeypatch.setattr(os, "environ", {})
    with pytest.raises(RuntimeError) as err:
        vic.load_credentials(env_file)
    message = str(err.value)
    assert "R2_SECRET_ACCESS_KEY" in message
    assert "DATABASE_URL" in message
    assert "R2_ACCESS_KEY_ID" not in message  # that one is set
    assert "value-that-must-not-print" not in message


def test_main_checkout_comes_from_the_git_common_dir():
    assert vic.main_checkout_from_common_dir("F:/dev/strike-calculator/.git\n") == Path(
        "F:/dev/strike-calculator"
    )
    assert vic.main_checkout_from_common_dir("/srv/repo/.git/") == Path("/srv/repo")


def test_main_checkout_refuses_a_path_that_is_not_a_dot_git():
    with pytest.raises(ValueError, match="not a .git"):
        vic.main_checkout_from_common_dir("/srv/repo/worktrees/x")


def test_redact_hides_every_secret_value_that_is_set(monkeypatch):
    monkeypatch.setattr(
        os,
        "environ",
        {
            "DATABASE_URL": "postgres://user:hunter2@host/db",
            "R2_SECRET_ACCESS_KEY": "s3cr3tkey",
            "R2_BUCKET_FULLTAPE": "",
        },
    )
    text = "failed on postgres://user:hunter2@host/db with s3cr3tkey"
    # The whole URL goes first: replacing the password alone first would leave
    # the user and host of the connection string in the message.
    assert vic.redact(text) == "failed on *** with ***"
    assert vic.redact("nothing secret here") == "nothing secret here"


def test_redact_hides_a_database_password_that_shows_up_alone(monkeypatch):
    monkeypatch.setattr(
        os, "environ", {"DATABASE_URL": "postgres://user:hunter2@host/db"}
    )
    assert vic.redact("auth failed, password hunter2 rejected") == (
        "auth failed, password *** rejected"
    )


# ── the Postgres read ────────────────────────────────────────────────────────


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self._rows = []

    def execute(self, sql, params=None):
        self._conn.events.append(("execute", " ".join(sql.split()), params))
        if self._conn.fail_on_execute:
            raise psycopg2.OperationalError("connection reset by the fake")
        table = "index" if "index_candles_1m" in sql else "etf"
        self._rows = list(self._conn.tables[table])

    def fetchall(self):
        return self._rows

    def close(self):
        self._conn.events.append(("cursor_close",))


class FakeConnection:
    def __init__(self, tables, fail_on_execute=False):
        self.tables = tables
        self.fail_on_execute = fail_on_execute
        self.events = [("connect",)]

    def set_session(self, **kwargs):
        self.events.append(("set_session", kwargs))

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.events.append(("close",))


def install_fake_postgres(monkeypatch, conn):
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": "postgres://fake/db"})
    monkeypatch.setattr(psycopg2, "connect", lambda *a, **k: conn)


def test_fetch_index_and_etf_opens_a_read_only_session_before_any_query(monkeypatch):
    conn = FakeConnection(
        {"index": [(100, 5800.5), (101, 5801.0)], "etf": [(100, 580.0), (101, 580.1)]}
    )
    install_fake_postgres(monkeypatch, conn)
    index, etf = vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    assert index == {100: 5800.5, 101: 5801.0}
    assert etf == {100: 580.0, 101: 580.1}
    kinds = [event[0] for event in conn.events]
    assert kinds[0] == "connect"
    assert conn.events[1] == ("set_session", {"readonly": True})
    assert kinds[-1] == "close"
    executed = [event for event in conn.events if event[0] == "execute"]
    assert len(executed) == 2
    assert all(event[1].upper().startswith("SELECT") for event in executed)


def test_fetch_index_and_etf_reads_regular_minutes_of_that_symbol_and_day(monkeypatch):
    conn = FakeConnection({"index": [], "etf": []})
    install_fake_postgres(monkeypatch, conn)
    vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    index_query, etf_query = [e for e in conn.events if e[0] == "execute"]
    assert "market_time = 'r'" in index_query[1]
    assert index_query[2] == ("SPX", date(2026, 3, 26))
    assert "ticker = 'SPY'" in etf_query[1]
    assert etf_query[2] == (date(2026, 3, 26), date(2026, 3, 26))


def test_fetch_index_and_etf_closes_the_connection_when_the_query_fails(monkeypatch):
    conn = FakeConnection({"index": [], "etf": []}, fail_on_execute=True)
    install_fake_postgres(monkeypatch, conn)
    with pytest.raises(psycopg2.OperationalError, match="connection reset"):
        vic.fetch_index_and_etf("SPX", date(2026, 3, 26))
    assert conn.events[-1] == ("close",)


# ── the tape query ───────────────────────────────────────────────────────────

# (executed_at column type, canceled column type, (not canceled, canceled), price type)
TAPE_LAYOUTS = {
    "tz_boolean": ("TIMESTAMPTZ", "BOOLEAN", ("false", "true"), "DOUBLE"),
    "naive_boolean": ("TIMESTAMP", "BOOLEAN", ("false", "true"), "DECIMAL(18,4)"),
    "naive_text_f_t": ("TIMESTAMP", "VARCHAR", ("'f'", "'t'"), "DECIMAL(18,4)"),
    "tz_text_words": ("TIMESTAMPTZ", "VARCHAR", ("'false'", "'true'"), "DOUBLE"),
}

# One SPXW print list: (id, chain, clock, price, canceled?)
TAPE_ROWS = [
    # 14:30: last by time wins; the later canceled print at 5900 is ignored.
    ("a1", "SPXW260326C05800000", "14:30:05", "5800.0", False),
    ("a2", "SPXW260326P05800000", "14:30:50", "5801.5", False),
    ("a3", "SPXW260326C05800000", "14:30:59", "5900.0", True),
    # 14:31: same instant twice; the later id wins the tie.
    ("b1", "SPXW260326C05800000", "14:31:10", "5802.0", False),
    ("b2", "SPXW260326C05805000", "14:31:10", "5803.0", False),
    # 14:32: the later print has no spot; the earlier one stands.
    ("c1", "SPXW260326C05800000", "14:32:10", "5804.0", False),
    ("c2", "SPXW260326C05800000", "14:32:30", None, False),
    # 14:33: only non-SPXW roots; no minute at all.
    ("d1", "SPX260327C05800000", "14:33:10", "5810.0", False),
    ("d2", "SPXS260326C00010000", "14:33:20", "9.0", False),
]


def write_tape(path: Path, layout: str) -> None:
    ts_type, canceled_type, (no, yes), price_type = TAPE_LAYOUTS[layout]
    con = duckdb.connect()
    try:
        con.execute(
            f"""CREATE TABLE tape (id VARCHAR, option_chain_id VARCHAR,
                executed_at {ts_type}, underlying_price {price_type},
                canceled {canceled_type})"""
        )
        offset = "+00" if ts_type == "TIMESTAMPTZ" else ""  # naive layout is UTC
        for row_id, chain, clock, price, canceled in TAPE_ROWS:
            stamp = f"'2026-03-26 {clock}{offset}'"
            value = "NULL" if price is None else price
            flag = yes if canceled else no
            con.execute(
                f"INSERT INTO tape VALUES ('{row_id}', '{chain}', "
                f"CAST({stamp} AS {ts_type}), {value}, {flag})"
            )
        con.execute(f"COPY tape TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


@pytest.mark.parametrize("layout", sorted(TAPE_LAYOUTS))
def test_fetch_tape_spots_takes_the_last_spxw_spot_per_utc_minute(
    layout, tmp_path, monkeypatch
):
    tape_file = tmp_path / "2026-03-26-fulltape.parquet"
    write_tape(tape_file, layout)
    monkeypatch.syspath_prepend(str(vic.ML_SRC))
    import utils.r2 as r2

    asked = {}

    def local_connection(**kwargs):
        asked.update(kwargs)
        return duckdb.connect()

    monkeypatch.setattr(r2, "fulltape_connection", local_connection)
    monkeypatch.setattr(r2, "r2_url", lambda day: tape_file.as_posix())

    spots = vic.fetch_tape_spots(date(2026, 3, 26))

    assert spots == {
        minute_of(2026, 3, 26, 14, 30): 5801.5,
        minute_of(2026, 3, 26, 14, 31): 5803.0,
        minute_of(2026, 3, 26, 14, 32): 5804.0,
    }
    # The brief's budget for the shared box.
    assert asked == {"threads": 4, "memory_limit": "3000MiB"}


# ── main ─────────────────────────────────────────────────────────────────────

M0 = 1_000_000  # an arbitrary UTC epoch minute


def install_main_fakes(monkeypatch, candles, etf, tape):
    monkeypatch.setattr(vic, "load_credentials", lambda path=None: None)
    monkeypatch.setattr(vic, "fetch_index_and_etf", lambda symbol, day: (candles, etf))
    monkeypatch.setattr(vic, "fetch_tape_spots", lambda day: tape)


def run_main(argv):
    return vic.main(["--symbol", "SPX", "--date", "2026-03-26", *argv])


def test_main_passes_a_day_that_matches_the_tape(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 + i for i in range(10)}
    tape = {M0 + i: 5800.0 + i + (0.5 if i % 2 else -0.5) for i in range(10)}
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 0
    out = capsys.readouterr().out
    assert "PASS" in out
    assert "FAIL" not in out
    assert "median" in out


def test_main_fails_a_placeholder_day_and_says_why(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 for i in range(10)}
    tape = {M0 + i: 5825.1 for i in range(10)}  # 25.1 pt away: the placeholder
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "median" in out


def test_main_fails_no_overlap_instead_of_passing_or_crashing(monkeypatch, capsys):
    install_main_fakes(monkeypatch, {M0: 5800.0}, {}, {})
    assert run_main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "no overlap" in out


def test_main_with_a_ratio_fails_a_low_share_and_prints_the_share(monkeypatch, capsys):
    candles = {M0 + i: 5800.0 + i for i in range(10)}
    tape = dict(candles)  # the tape gate passes on its own
    etf = {M0 + i: (5800.0 + i) / 10.0 for i in range(10)}
    install_main_fakes(monkeypatch, candles, etf, tape)
    assert run_main(["--ratio", "10.0"]) == 0  # every minute is index / etf = 10
    assert "100.0%" in capsys.readouterr().out
    etf_off = {m: close * 1.001 for m, close in etf.items()}  # index / etf = 9.99
    install_main_fakes(monkeypatch, candles, etf_off, tape)
    assert run_main(["--ratio", "10.0"]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "0.0%" in out
    assert "ratio" in out


def test_main_before_cuts_off_the_minutes_from_the_cut_on(monkeypatch, capsys):
    # 2026-03-26 17:11Z. Minute before it matches; from the cut on, wildly off.
    cut = minute_of(2026, 3, 26, 17, 11)
    candles = {cut - 1: 5800.0, cut: 5800.0, cut + 1: 5800.0}
    tape = {cut - 1: 5800.5, cut: 6800.0, cut + 1: 6800.0}
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main(["--before", "17:11Z"]) == 0
    assert "compared: 1 " in capsys.readouterr().out
    install_main_fakes(monkeypatch, candles, {}, tape)
    assert run_main([]) == 1  # without the cut the bad minutes fail the day
    assert "compared: 3 " in capsys.readouterr().out


def test_main_exits_2_on_a_read_failure_and_prints_no_secret(monkeypatch, capsys):
    secret_url = "postgres://user:hunter2@host/db"
    monkeypatch.setattr(os, "environ", {"DATABASE_URL": secret_url})
    monkeypatch.setattr(vic, "load_credentials", lambda path=None: None)

    def boom(symbol, day):
        raise RuntimeError(f"could not connect to {secret_url}")

    monkeypatch.setattr(vic, "fetch_index_and_etf", boom)
    monkeypatch.setattr(vic, "fetch_tape_spots", lambda day: {})
    assert run_main([]) == 2
    captured = capsys.readouterr()
    shown = captured.out + captured.err
    assert "hunter2" not in shown
    assert secret_url not in shown
    assert "RuntimeError" in shown
    assert "PASS" not in shown


def test_main_exits_2_when_credentials_are_missing_and_names_them(monkeypatch, capsys):
    def no_credentials(path=None):
        raise RuntimeError("missing credentials: DATABASE_URL, R2_ENDPOINT_URL")

    monkeypatch.setattr(vic, "load_credentials", no_credentials)
    assert run_main([]) == 2
    err = capsys.readouterr().err
    assert "DATABASE_URL" in err


def test_main_refuses_ndx_before_reading_anything(monkeypatch, capsys):
    def must_not_run(*args, **kwargs):
        raise AssertionError("read something for a refused symbol")

    monkeypatch.setattr(vic, "load_credentials", must_not_run)
    monkeypatch.setattr(vic, "fetch_index_and_etf", must_not_run)
    monkeypatch.setattr(vic, "fetch_tape_spots", must_not_run)
    with pytest.raises(SystemExit) as exit_info:
        vic.main(["--symbol", "NDX", "--date", "2026-03-26"])
    assert exit_info.value.code == 2
    assert "no NDX price" in capsys.readouterr().err
