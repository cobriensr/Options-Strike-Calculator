"""Idempotence tests for the online ticker-weight EMA updater.

Covers the two re-run-safety mechanisms:
  - upsert_history_csv replaces same-day rows instead of appending (no dup rows
    across repeated `make update` runs).
  - already_applied_today no-ops a bare re-run whose nudge is already baked into
    the live weights, while staying compatible with `make update` (where refit
    resets the baseline first).

Run:
    ml/.venv/Scripts/pytest scripts/test_online_ticker_update.py -q
"""

from __future__ import annotations

import csv
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import online_ticker_update as otu  # noqa: E402
from lottery_scoring import SINGLE_LEG_FILTER  # noqa: E402


def _rows(csv_path: Path) -> list[dict]:
    with csv_path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _update(ticker: str, old: int, new: int) -> dict:
    return {
        "ticker": ticker,
        "old_weight": old,
        "new_weight": new,
        "today_n": 12,
        "today_mean": 3.4,
    }


@pytest.fixture
def history_csv(tmp_path, monkeypatch) -> Path:
    p = tmp_path / "lottery-ticker-weight-history.csv"
    monkeypatch.setattr(otu, "HISTORY_CSV", p)
    return p


def test_upsert_replaces_same_day_rows(history_csv: Path) -> None:
    today = date(2026, 5, 29)
    otu.upsert_history_csv(today, [_update("NVDA", 2, 3), _update("TSLA", 0, 1)])
    otu.upsert_history_csv(today, [_update("NVDA", 2, 3), _update("TSLA", 0, 1)])

    rows = _rows(history_csv)
    # Two upserts of the same date => still exactly two rows, not four.
    assert len(rows) == 2
    assert {r["ticker"] for r in rows} == {"NVDA", "TSLA"}


def test_upsert_keeps_prior_day_rows(history_csv: Path) -> None:
    otu.upsert_history_csv(date(2026, 5, 28), [_update("NVDA", 1, 2)])
    otu.upsert_history_csv(date(2026, 5, 29), [_update("NVDA", 2, 3)])

    rows = _rows(history_csv)
    assert len(rows) == 2
    by_date = {r["date"]: r["new_weight"] for r in rows}
    assert by_date == {"2026-05-28": "2", "2026-05-29": "3"}


def test_upsert_rewrites_only_target_date(history_csv: Path) -> None:
    otu.upsert_history_csv(date(2026, 5, 28), [_update("NVDA", 1, 2)])
    # Re-running 05-29 must not disturb the 05-28 row.
    otu.upsert_history_csv(date(2026, 5, 29), [_update("TSLA", 0, 1)])
    otu.upsert_history_csv(date(2026, 5, 29), [_update("TSLA", 0, 1)])

    rows = _rows(history_csv)
    assert len(rows) == 2
    assert sorted(r["date"] for r in rows) == ["2026-05-28", "2026-05-29"]


def test_already_applied_true_when_live_weights_match_record(
    history_csv: Path,
) -> None:
    today = date(2026, 5, 29)
    otu.upsert_history_csv(today, [_update("NVDA", 2, 3), _update("TSLA", 0, 1)])
    # Live weights == today's recorded post-nudge values => bare re-run no-ops.
    live = {"NVDA": 3, "TSLA": 1, "AAPL": 0}
    assert otu.already_applied_today(today, live) is True


def test_already_applied_false_after_refit_reset(history_csv: Path) -> None:
    today = date(2026, 5, 29)
    otu.upsert_history_csv(today, [_update("NVDA", 2, 3), _update("TSLA", 0, 1)])
    # `make update` re-run: refit reset NVDA/TSLA back to their baselines (2, 0),
    # which differ from the recorded post-nudge (3, 1) => must re-apply.
    live = {"NVDA": 2, "TSLA": 0}
    assert otu.already_applied_today(today, live) is False


def test_already_applied_false_when_no_history(history_csv: Path) -> None:
    assert otu.already_applied_today(date(2026, 5, 29), {"NVDA": 3}) is False


def test_already_applied_false_when_today_absent(history_csv: Path) -> None:
    otu.upsert_history_csv(date(2026, 5, 28), [_update("NVDA", 2, 3)])
    # No rows for 05-29 yet => not applied today.
    assert otu.already_applied_today(date(2026, 5, 29), {"NVDA": 3}) is False


# ---------------------------------------------------------------------------
# Refit guard (temporary; see ml/src/lottery_refit_guard.py)
# ---------------------------------------------------------------------------


class _FakeDate(date):
    pinned = date(2026, 10, 29)

    @classmethod
    def today(cls) -> date:  # type: ignore[override]
        return cls.pinned


def test_main_guarded_skips_db_and_writes_nothing(
    monkeypatch, tmp_path: Path, capsys
) -> None:
    _FakeDate.pinned = date(2026, 10, 29)
    monkeypatch.setattr(otu, "date", _FakeDate)
    weights = tmp_path / "w.json"
    weights.write_text('{"sentinel": 1}\n', encoding="utf-8")
    monkeypatch.setattr(otu, "WEIGHTS_PATH", weights)
    hist = tmp_path / "hist.csv"
    monkeypatch.setattr(otu, "HISTORY_CSV", hist)

    def _boom(*_a, **_k):
        raise AssertionError("must not run while guarded")

    for name in (
        "load_env",
        "connect_with_retry",
        "fetch_today_fires",
        "write_weights_json",
        "upsert_history_csv",
    ):
        monkeypatch.setattr(otu, name, _boom)

    otu.main()

    captured = capsys.readouterr()
    assert "REFIT BLOCKED: online_ticker_update.py" in captured.out
    assert "REFIT BLOCKED: online_ticker_update.py" in captured.err
    assert weights.read_text(encoding="utf-8") == '{"sentinel": 1}\n'
    assert not hist.exists()


def test_main_unguarded_before_cutoff_proceeds(monkeypatch) -> None:
    _FakeDate.pinned = date(2026, 10, 28)
    monkeypatch.setattr(otu, "date", _FakeDate)
    reached: list[bool] = []

    def _load_env() -> None:
        reached.append(True)
        raise SystemExit("stop after load_env")

    monkeypatch.setattr(otu, "load_env", _load_env)
    with pytest.raises(SystemExit):
        otu.main()
    assert reached == [True]


def test_today_query_uses_the_shared_single_leg_filter() -> None:
    assert SINGLE_LEG_FILTER in otu.TODAY_QUERY
    assert "inferred_structure" not in otu.TODAY_QUERY
