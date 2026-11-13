"""Unit tests for src/futures_front_month.py, the per-session front-month rule.

Three layers:

- The pure functions (trade date, contract names, ``decide_front``) are held
  to the fixture shared with the TypeScript side,
  ``api/__tests__/fixtures/futures-roll-cases.json``. Its ``cmeTradeDate`` and
  ``decideFrontMonth`` lists run here case by case, ``throws`` cases
  included. Its ``pickScheduledFront`` list is the REST minute builder, which
  has no Python port: the live handler folds the two spellings of a contract
  into one bar instead of picking one row (tests/test_futures_trades_handler.py).
- ``ensure_front`` (read, fill forward, decide, ceiling, insert, re-read) runs
  against a dict-backed stand-in for the module's own read and insert
  functions. These are the twins of the PGlite block "ensureFrontMonth: the
  series only moves forward, whatever order dates are decided in" in
  ``api/__tests__/futures-front-month-pglite.test.ts``; the fixture cannot pin
  them because they are the database layer.
- The SQL functions run against a mocked ``db.fetch`` / ``db.execute``.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import asyncpg.exceptions
import pytest

import futures_front_month as ffm
import sentry_setup
from handlers import futures_trades as ft

_CHICAGO = ZoneInfo("America/Chicago")
_FIXTURE = Path(__file__).resolve().parents[2] / "api/__tests__/fixtures/futures-roll-cases.json"
_CASES = json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _utc(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _day(iso: str) -> date:
    return date.fromisoformat(iso)


# ----------------------------------------------------------------------
# Shared fixture
# ----------------------------------------------------------------------


class TestSharedFixture:
    def test_the_fixture_has_the_lists_this_port_runs(self):
        # A renamed list or an emptied one must fail here, not run zero cases.
        assert len(_CASES["cmeTradeDate"]) >= 27
        assert len(_CASES["decideFrontMonth"]) >= 43

    @pytest.mark.parametrize("case", _CASES["cmeTradeDate"], ids=lambda c: c["name"])
    def test_trade_date(self, case):
        assert ffm.trade_date(_utc(case["ts"])) == _day(case["tradeDate"])

    @pytest.mark.parametrize("case", _CASES["decideFrontMonth"], ids=lambda c: c["name"])
    def test_decide_front(self, case):
        def decide() -> str:
            return ffm.decide_front(
                case["incumbent"], case["volumes"], case["root"], _day(case["tradeDate"])
            )

        if "throws" in case:
            with pytest.raises(ValueError, match=case["throws"]):
                decide()
        else:
            assert decide() == case["front"]


# ----------------------------------------------------------------------
# Trade date
# ----------------------------------------------------------------------


class TestTradeDate:
    def test_a_naive_datetime_is_refused_not_read_as_local_time(self):
        with pytest.raises(ValueError, match="timezone-aware"):
            ffm.trade_date(datetime(2026, 11, 5, 23, 0))

    def test_an_instant_in_another_zone_gets_the_same_date(self):
        # 17:00 CST is the open of 11-06, however the instant is written.
        chicago = datetime(2026, 11, 5, 17, 0, tzinfo=_CHICAGO)
        assert ffm.trade_date(chicago) == date(2026, 11, 6)
        assert ffm.trade_date(chicago.replace(hour=16, minute=59)) == date(2026, 11, 5)

    @pytest.mark.parametrize(
        ("utc", "expected"),
        [
            # 2027-03-14: the clocks jump at 02:00. Seven hours added to the
            # Chicago wall clock before the jump would land an hour off; added
            # to the instant, the open is 22:00Z either way.
            (datetime(2027, 3, 14, 7, 59, tzinfo=UTC), date(2027, 3, 14)),
            (datetime(2027, 3, 14, 21, 59, tzinfo=UTC), date(2027, 3, 14)),
            (datetime(2027, 3, 14, 22, 0, tzinfo=UTC), date(2027, 3, 15)),
            # 2026-11-01: the clocks fall back at 02:00; the open moves to 23:00Z.
            (datetime(2026, 11, 1, 22, 59, tzinfo=UTC), date(2026, 11, 1)),
            (datetime(2026, 11, 1, 23, 0, tzinfo=UTC), date(2026, 11, 2)),
        ],
    )
    def test_a_chicago_zone_input_is_not_shifted_by_the_clock_change(self, utc, expected):
        assert ffm.trade_date(utc.astimezone(_CHICAGO)) == expected


# ----------------------------------------------------------------------
# Contract names
# ----------------------------------------------------------------------

_REF = date(2026, 6, 15)


class TestParseContract:
    @pytest.mark.parametrize(
        ("code", "month"),
        [(c, i + 1) for i, c in enumerate("FGHJKMNQUVXZ")],
    )
    def test_month_codes_in_both_year_forms(self, code, month):
        assert ffm.parse_contract("ES", f"ES{code}6", _REF) == (2026, month)
        assert ffm.parse_contract("ES", f"ES{code}27", _REF) == (2027, month)

    @pytest.mark.parametrize("root", sorted(ffm.CONTRACT_CYCLE))
    def test_every_root_reads_its_own_prefix(self, root):
        assert ffm.parse_contract(root, f"{root}Z6", _REF) == (2026, 12)

    def test_a_two_digit_year_is_20yy_whatever_the_reference(self):
        assert ffm.parse_contract("ES", "ESH07", _REF) == (2007, 3)
        assert ffm.parse_contract("ES", "ESZ26", date(2031, 1, 1)) == (2026, 12)

    @pytest.mark.parametrize(
        ("ref", "digit_to_year"),
        [
            (
                date(2026, 6, 15),
                {0: 2030, 1: 2031, 2: 2032, 3: 2033, 4: 2034, 5: 2025, 6: 2026, 7: 2027},
            ),
            (
                date(2029, 12, 20),
                {0: 2030, 1: 2031, 5: 2035, 7: 2037, 8: 2028, 9: 2029},
            ),
        ],
    )
    def test_a_one_digit_year_is_the_one_in_the_window(self, ref, digit_to_year):
        for digit, year in digit_to_year.items():
            assert ffm.parse_contract("ES", f"ESZ{digit}", ref) == (year, 12)

    def test_the_window_turns_over_on_the_reference_year(self):
        assert ffm.parse_contract("ES", "ESZ4", date(2025, 12, 31)) == (2024, 12)
        assert ffm.parse_contract("ES", "ESZ4", date(2026, 1, 1)) == (2034, 12)

    @pytest.mark.parametrize(
        "sym",
        [
            "ESZ6-ESH7",
            "ESZ6:ESH7",
            "ES",
            "ESZ",
            "ESA6",
            "esz6",
            "ESZ123",
            "ESZ6\n",
            "NQZ6",
            "MESZ6",
            "ES Z6",
            "ESZ٦",  # an Arabic-Indic digit: \d would match it, [0-9] does not
            "",
        ],
    )
    def test_anything_but_root_month_and_one_or_two_digits_is_none(self, sym):
        assert ffm.parse_contract("ES", sym, _REF) is None

    def test_an_expiry_orders_by_year_then_month(self):
        assert ffm.parse_contract("ES", "ESZ6", _REF) < ffm.parse_contract("ES", "ESH7", _REF)
        assert ffm.parse_contract("ES", "ESZ9", date(2029, 12, 20)) < ffm.parse_contract(
            "ES", "ESH0", date(2029, 12, 20)
        )


class TestCanonicalContract:
    @pytest.mark.parametrize(
        ("sym", "ref", "expected"),
        [
            ("ESZ6", date(2026, 12, 8), "ESZ6"),
            ("ESZ26", date(2026, 12, 8), "ESZ6"),
            ("ESH27", date(2026, 12, 8), "ESH7"),
            ("ESH34", date(2026, 12, 8), "ESH4"),  # the window edge, ref + 8
            ("ESZ25", date(2026, 12, 8), "ESZ5"),  # ref - 1
            ("ESH0", date(2029, 12, 20), "ESH0"),
            ("ESH30", date(2029, 12, 20), "ESH0"),
            ("CLZ36", date(2026, 12, 8), None),  # 2036 is outside [2025, 2034]
            ("ESZ24", date(2026, 12, 8), None),  # 2024 is before ref - 1
            ("ESZ6-ESH7", date(2026, 12, 8), None),
            ("NQZ6", date(2026, 12, 8), None),
        ],
    )
    def test_table(self, sym, ref, expected):
        assert ffm.canonical_contract("ES" if not sym.startswith("CL") else "CL", sym, ref) == (
            expected
        )

    def test_the_one_name_is_idempotent(self):
        for sym in ("ESZ6", "ESZ26", "ESH7", "ESH0", "ESH34"):
            once = ffm.canonical_contract("ES", sym, date(2026, 12, 8))
            assert once is not None
            assert ffm.canonical_contract("ES", once, date(2026, 12, 8)) == once


class TestNullSeedContract:
    @pytest.mark.parametrize(
        ("root", "ref", "expected"),
        [
            ("ES", date(2026, 11, 10), "ESZ6"),
            ("ES", date(2026, 12, 20), "ESZ6"),  # expired, and the rule moves on from there
            ("CL", date(2026, 11, 10), "CLZ6"),  # CL stops a month early: CLX6 is gone
            ("CL", date(2026, 12, 10), "CLF7"),
            ("GC", date(2026, 11, 10), "GCZ6"),
            ("GC", date(2027, 1, 12), "GCG7"),
            ("NQ", date(2027, 2, 10), "NQH7"),
            ("ZN", date(2027, 4, 1), "ZNM7"),
            ("RTY", date(2026, 7, 22), "RTYU6"),
            ("ES", date(2029, 12, 20), "ESZ9"),
            ("ES", date(2030, 1, 10), "ESH0"),
        ],
    )
    def test_table(self, root, ref, expected):
        assert ffm.null_seed_contract(root, ref) == expected

    def test_roots_and_cycles_match_the_handler_and_the_typescript(self):
        assert set(ffm.CONTRACT_CYCLE) == set(ft._TARGET_PRODUCTS)
        assert set(ffm.OUTRIGHT_SYM) == set(ft._TARGET_PRODUCTS)
        assert ffm.MONTH_CODES == "FGHJKMNQUVXZ"
        assert ffm.CONTRACT_CYCLE == {
            "ES": "HMUZ",
            "NQ": "HMUZ",
            "RTY": "HMUZ",
            "ZN": "HMUZ",
            "CL": "FGHJKMNQUVXZ",
            "GC": "GJMQVZ",
        }


class TestDecideFront:
    def test_the_inputs_are_not_changed(self):
        volumes = {"ESZ26": 3, "ESZ6": 4}
        ffm.decide_front("ESZ6", volumes, "ES", date(2026, 12, 8))
        assert volumes == {"ESZ26": 3, "ESZ6": 4}

    def test_a_volume_read_from_the_database_as_a_large_int_still_compares(self):
        assert (
            ffm.decide_front("ESZ6", {"ESZ6": 10**12, "ESH7": 10**12 + 1}, "ES", date(2026, 12, 8))
            == "ESH7"
        )


# ----------------------------------------------------------------------
# ensure_front against a dict-backed stand-in
# ----------------------------------------------------------------------

_NOW = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)  # 09:00 CST, trade date 2026-11-10


class _Store:
    """A dict-backed futures_front_month and futures_contract_volume.

    ``read_inputs`` answers what the SQL does: the incumbent is the latest
    decision before the date, the ceiling the earliest after it, the volumes
    those of the latest earlier date that has any, and ``undecided`` the dates
    with volume rows after the incumbent's date (none without an incumbent).
    """

    def __init__(self) -> None:
        self.front: dict[tuple[str, date], str] = {}
        self.volumes: dict[tuple[str, date], dict[str, int]] = {}
        self.inserted: list[tuple[str, date, str]] = []
        self.reads_of_inputs = 0
        self.fail_inputs_on: set[int] = set()  # 1-based call numbers that raise
        self.before_insert = None

    def decide(self, product: str, day: str, contract: str) -> None:
        self.front[(product, _day(day))] = contract

    def trade(self, product: str, day: str, volumes: dict[str, int]) -> None:
        self.volumes[(product, _day(day))] = volumes

    def dates(self) -> dict[str, str]:
        return {d.isoformat(): c for (_, d), c in sorted(self.front.items(), key=lambda kv: kv[0])}

    async def read_stored(self, product: str, day: date) -> str | None:
        return self.front.get((product, day))

    async def read_inputs(self, product: str, day: date) -> ffm._Inputs:
        self.reads_of_inputs += 1
        if self.reads_of_inputs in self.fail_inputs_on:
            raise TimeoutError("connection lost")
        before = sorted(d for (p, d) in self.front if p == product and d < day)
        after = sorted(d for (p, d) in self.front if p == product and d > day)
        with_volume = sorted(
            d for (p, d), v in self.volumes.items() if p == product and d < day and v
        )
        return ffm._Inputs(
            incumbent=self.front[(product, before[-1])] if before else None,
            ceiling=self.front[(product, after[0])] if after else None,
            volumes=dict(self.volumes[(product, with_volume[-1])]) if with_volume else {},
            undecided=[d for d in with_volume if before and d > before[-1]],
        )

    async def insert_decision(self, product: str, day: date, contract: str) -> None:
        if self.before_insert is not None:
            self.before_insert(self, product, day)
        self.inserted.append((product, day, contract))
        self.front.setdefault((product, day), contract)  # ON CONFLICT DO NOTHING


@pytest.fixture(autouse=True)
def _no_failures_carried_over(monkeypatch):
    """``last_failure`` is a process-wide record per root; start each test empty."""
    monkeypatch.setattr(ffm, "_last_failure", {})


@pytest.fixture
def store(monkeypatch):
    s = _Store()
    monkeypatch.setattr(ffm, "_read_stored", s.read_stored)
    monkeypatch.setattr(ffm, "_read_inputs", s.read_inputs)
    monkeypatch.setattr(ffm, "_insert_decision", s.insert_decision)
    monkeypatch.setattr(ffm, "_now", lambda: _NOW)
    return s


@pytest.fixture
def logs():
    """The three ways ensure_front reports, patched at the module's names."""
    with (
        patch("futures_front_month.log") as log,
        patch("futures_front_month.rate_limited_log") as rate_limited,
    ):
        yield log, rate_limited


class TestEnsureFront:
    @pytest.mark.asyncio
    async def test_decides_from_the_previous_decision_and_volumes_and_stores_it(self, store):
        store.decide("ES", "2026-11-05", "ESZ6")
        store.trade("ES", "2026-11-05", {"ESZ6": 500, "ESH7": 900})

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESH7"
        assert store.dates() == {"2026-11-05": "ESZ6", "2026-11-06": "ESH7"}
        assert store.inserted == [("ES", _day("2026-11-06"), "ESH7")]

    @pytest.mark.asyncio
    async def test_a_tie_keeps_the_incumbent(self, store):
        store.decide("ES", "2026-11-05", "ESZ6")
        store.trade("ES", "2026-11-05", {"ESZ6": 700, "ESH7": 700})
        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"

    @pytest.mark.asyncio
    async def test_a_stored_row_is_returned_without_a_decision_or_a_write(self, store):
        store.decide("ES", "2026-11-06", "ESZ6")
        store.trade("ES", "2026-11-05", {"ESH7": 10**6})

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"
        assert store.reads_of_inputs == 0
        assert store.inserted == []

    @pytest.mark.asyncio
    async def test_a_stored_two_digit_spelling_is_returned_canonical(self, store):
        store.decide("ES", "2026-11-06", "ESZ26")
        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"

    @pytest.mark.asyncio
    async def test_only_its_own_product_is_read(self, store):
        store.decide("ES", "2026-11-05", "ESZ6")
        store.decide("NQ", "2026-11-05", "NQZ6")
        store.trade("NQ", "2026-11-05", {"NQH7": 10**6})
        store.trade("ES", "2026-11-05", {"ESZ6": 5})

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"
        assert await ffm.ensure_front("NQ", _day("2026-11-06")) == "NQH7"

    @pytest.mark.asyncio
    async def test_the_cycle_seed_is_used_and_warned_with_no_history_at_all(self, store, logs):
        log, _ = logs

        assert await ffm.ensure_front("ES", _day("2026-11-10")) == "ESZ6"

        assert store.dates() == {"2026-11-10": "ESZ6"}
        assert log.warning.call_count == 1
        extra = log.warning.call_args.kwargs["extra"]
        assert extra["kind"] == "front_month_cycle_seed"
        assert extra["product"] == "ES"
        assert extra["trade_date"] == "2026-11-10"

    @pytest.mark.asyncio
    async def test_no_seed_warning_when_an_incumbent_or_volume_decides(self, store, logs):
        log, _ = logs
        store.decide("ES", "2026-11-05", "ESZ6")
        await ffm.ensure_front("ES", _day("2026-11-06"))  # incumbent, no volume
        store.trade("NQ", "2026-11-05", {"NQZ6": 5})
        await ffm.ensure_front("NQ", _day("2026-11-06"))  # volume, no incumbent

        assert log.warning.call_args_list == []

    @pytest.mark.asyncio
    async def test_refuses_a_date_after_the_current_trade_date_and_writes_nothing(
        self, store, logs
    ):
        _, rate_limited = logs

        assert await ffm.ensure_front("ES", _day("2026-11-11")) is None

        assert store.inserted == []
        assert store.reads_of_inputs == 0
        # A warning, not an error: a stamp a little ahead of our clock at the
        # open clears itself within the skew, so it is not a Sentry event.
        assert rate_limited.error.call_args_list == []
        call = rate_limited.warning.call_args
        assert call.kwargs["kind"] == "date_after_current_trade_date"
        assert call.kwargs["key"] == "ES"
        assert call.kwargs["extra"]["product"] == "ES"
        assert call.kwargs["extra"]["trade_date"] == "2026-11-11"
        assert call.kwargs["extra"]["current_trade_date"] == "2026-11-10"
        assert ffm.last_failure("ES") == ("date_after_current_trade_date", "")

    @pytest.mark.asyncio
    async def test_the_current_trade_date_follows_the_17_00_ct_open_not_the_utc_date(
        self, store, monkeypatch
    ):
        # 2026-11-10 22:59Z is 16:59 CST (date 11-10); 23:00Z opens 11-11.
        monkeypatch.setattr(ffm, "_now", lambda: datetime(2026, 11, 10, 22, 59, tzinfo=UTC))
        assert await ffm.ensure_front("ES", _day("2026-11-11")) is None
        assert await ffm.ensure_front("ES", _day("2026-11-10")) == "ESZ6"

        monkeypatch.setattr(ffm, "_now", lambda: datetime(2026, 11, 10, 23, 0, tzinfo=UTC))
        assert await ffm.ensure_front("ES", _day("2026-11-11")) == "ESZ6"

    @pytest.mark.asyncio
    async def test_a_stored_name_that_is_no_outright_of_the_product_is_a_logged_none(
        self, store, logs
    ):
        _, rate_limited = logs
        store.decide("ES", "2026-11-06", "NQZ6")

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        # Corrupt data is not transient: an error, which reaches Sentry.
        assert rate_limited.warning.call_args_list == []
        assert rate_limited.error.call_args.kwargs["kind"] == "ensure_front_failed"
        assert "NQZ6" in rate_limited.error.call_args.kwargs["extra"]["err"]

    @pytest.mark.asyncio
    async def test_a_corrupt_incumbent_is_a_logged_none_and_writes_nothing(self, store, logs):
        _, rate_limited = logs
        store.decide("ES", "2026-11-05", "ESZ6-ESH7")

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        assert store.inserted == []
        assert "incumbent" in rate_limited.error.call_args.kwargs["extra"]["err"]


class TestEnsureFrontOrder:
    """Twins of the PGlite block: the series only moves forward, in any order."""

    @pytest.mark.asyncio
    async def test_a_gap_with_volume_rows_is_filled_first_oldest_first(self, store):
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-03", {"ESZ6": 100, "ESH7": 900})
        # Written out of date order on purpose.
        store.trade("ES", "2026-11-06", {"ESZ6": 900, "ESH7": 100})
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 50})
        store.trade("ES", "2026-11-05", {"ESZ6": 900, "ESH7": 100})

        # 11-09 alone would see ESZ6 as the incumbent and as the leader on
        # 11-06, and say ESZ6. In order, 11-04 follows 11-03's lead to ESH7
        # and nothing rolls back.
        assert await ffm.ensure_front("ES", _day("2026-11-09")) == "ESH7"

        assert store.dates() == {
            "2026-11-03": "ESZ6",
            "2026-11-04": "ESH7",
            "2026-11-05": "ESH7",
            "2026-11-06": "ESH7",
            "2026-11-09": "ESH7",
        }
        assert [d.isoformat() for _, d, _ in store.inserted] == [
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
            "2026-11-09",
        ]

    @pytest.mark.asyncio
    async def test_the_incumbents_own_date_is_not_decided_again(self, store):
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-03", {"ESZ6": 1})
        await ffm.ensure_front("ES", _day("2026-11-04"))
        assert [d.isoformat() for _, d, _ in store.inserted] == ["2026-11-04"]

    @staticmethod
    def _flicker(store: _Store) -> None:
        # ES is ESZ6 on 11-03. ESH7 out-trades on 11-04, ESZ6 again on 11-05.
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-03", {"ESZ6": 900, "ESH7": 100})
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})
        store.trade("ES", "2026-11-05", {"ESZ6": 900, "ESH7": 100})

    @pytest.mark.asyncio
    async def test_the_flicker_gives_the_same_rows_in_both_orders(self, monkeypatch):
        async def run(order: list[str]) -> dict[str, str]:
            s = _Store()
            monkeypatch.setattr(ffm, "_read_stored", s.read_stored)
            monkeypatch.setattr(ffm, "_read_inputs", s.read_inputs)
            monkeypatch.setattr(ffm, "_insert_decision", s.insert_decision)
            monkeypatch.setattr(ffm, "_now", lambda: _NOW)
            self._flicker(s)
            for day in order:
                await ffm.ensure_front("ES", _day(day))
            return s.dates()

        in_order = await run(["2026-11-04", "2026-11-05", "2026-11-06"])
        newest_first = await run(["2026-11-06", "2026-11-05", "2026-11-04"])
        middle_first = await run(["2026-11-05", "2026-11-06"])

        # 11-05 rolls to ESH7 and 11-06 stays there: ESZ6's lead on 11-05
        # cannot take the series back.
        expected = {
            "2026-11-03": "ESZ6",
            "2026-11-04": "ESZ6",
            "2026-11-05": "ESH7",
            "2026-11-06": "ESH7",
        }
        assert in_order == expected
        assert newest_first == expected
        assert middle_first == expected

    @pytest.mark.asyncio
    async def test_a_date_decided_before_the_one_just_before_it_finds_that_one_stored(self, store):
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})
        store.trade("ES", "2026-11-05", {"ESZ6": 900, "ESH7": 100})

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESH7"
        store.inserted.clear()
        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESH7"
        assert store.inserted == []

    @pytest.mark.asyncio
    async def test_no_incumbent_means_no_fill(self, store, logs):
        log, rate_limited = logs
        store.trade("ES", "2026-11-03", {"ESZ6": 100, "ESH7": 900})
        store.trade("ES", "2026-11-04", {"ESZ6": 900, "ESH7": 100})

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"

        assert store.dates() == {"2026-11-06": "ESZ6"}
        assert store.reads_of_inputs == 1
        assert log.warning.call_args_list == []
        assert rate_limited.warning.call_args_list == []

    @pytest.mark.asyncio
    async def test_an_old_date_decided_after_a_later_row_never_passes_it(self, store, logs):
        log, _ = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "ESZ6")
        store.decide("ES", "2026-11-10", "ESH7")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})

        # The tally wants ESH7, which expires after the ESZ6 stored for 11-09.
        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESZ6"

        assert store.dates() == {
            "2026-11-03": "ESZ6",
            "2026-11-04": "ESZ6",
            "2026-11-05": "ESZ6",
            "2026-11-09": "ESZ6",
            "2026-11-10": "ESH7",
        }
        # One clamp, logged at error level so it reaches Sentry, with the
        # product, date, wanted contract, ceiling and incumbent.
        assert log.error.call_count == 1
        assert log.warning.call_args_list == []
        extra = log.error.call_args.kwargs["extra"]
        assert extra == {
            "scope": "futures_front_month",
            "kind": "front_month_clamped",
            "product": "ES",
            "trade_date": "2026-11-05",
            "wanted": "ESH7",
            "ceiling": "ESZ6",
            "incumbent": "ESZ6",
        }

    @pytest.mark.asyncio
    async def test_a_clamp_is_sent_to_sentry_as_an_error_event(self, store, logs):
        """The SDK does not turn the error log line into an event, so the
        clamp sends its own."""
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "ESZ6")
        store.decide("ES", "2026-11-10", "ESH7")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})

        with patch("futures_front_month.capture_message") as capture:
            assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESZ6"

        capture.assert_called_once_with(
            "Front-month decision is later than the next stored decision: "
            "using the next stored decision",
            level="error",
            tags={"component": "futures_front_month", "kind": "front_month_clamped"},
            context={
                "scope": "futures_front_month",
                "kind": "front_month_clamped",
                "product": "ES",
                "trade_date": "2026-11-05",
                "wanted": "ESH7",
                "ceiling": "ESZ6",
                "incumbent": "ESZ6",
            },
        )

    @pytest.mark.asyncio
    async def test_no_clamp_sends_nothing_to_sentry(self, store, logs):
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "ESH7")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})

        with patch("futures_front_month.capture_message") as capture:
            assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESH7"

        capture.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("ceiling", ["ESH7", "ESM7"])
    async def test_no_clamp_when_the_next_stored_decision_is_not_before_the_wanted(
        self, store, logs, ceiling
    ):
        log, _ = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", ceiling)
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})

        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESH7"
        assert log.error.call_args_list == []

    @pytest.mark.asyncio
    async def test_the_earliest_later_decision_is_the_ceiling_not_the_latest(self, store, logs):
        log, _ = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "ESH7")
        store.decide("ES", "2026-11-10", "ESM7")
        store.trade("ES", "2026-11-04", {"ESZ6": 10, "ESH7": 50, "ESM7": 900})

        # ESM7 leads, but the next stored decision is ESH7.
        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESH7"
        assert log.error.call_args.kwargs["extra"]["ceiling"] == "ESH7"

    @pytest.mark.asyncio
    async def test_volume_rows_that_land_late_cannot_make_an_earlier_date_roll_past_a_later_one(
        self, store, logs
    ):
        log, _ = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-05", {"ESZ6": 900, "ESH7": 100})
        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"

        # 11-03's volume lands late with ESH7 in the lead: 11-04 would roll,
        # and 11-05 and 11-06 are already ESZ6.
        store.trade("ES", "2026-11-03", {"ESZ6": 100, "ESH7": 900})
        assert await ffm.ensure_front("ES", _day("2026-11-04")) == "ESZ6"

        assert set(store.dates().values()) == {"ESZ6"}
        extra = log.error.call_args.kwargs["extra"]
        assert (extra["trade_date"], extra["wanted"], extra["ceiling"]) == (
            "2026-11-04",
            "ESH7",
            "ESZ6",
        )

    @pytest.mark.asyncio
    async def test_over_rows_already_out_of_order_the_clamp_writes_the_ceiling_and_names_the_incumbent(
        self, store, logs
    ):
        log, _ = logs
        # A later contract stored before an earlier one: disorder from before.
        store.decide("ES", "2026-11-03", "ESH7")
        store.decide("ES", "2026-11-09", "ESZ6")
        store.trade("ES", "2026-11-03", {"ESZ6": 100, "ESH7": 900})

        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESZ6"

        assert log.error.call_count == 1
        extra = log.error.call_args.kwargs["extra"]
        assert (extra["wanted"], extra["ceiling"], extra["incumbent"]) == (
            "ESH7",
            "ESZ6",
            "ESH7",
        )

    @pytest.mark.asyncio
    async def test_a_ceiling_that_is_no_outright_of_the_product_writes_nothing(self, store, logs):
        _, rate_limited = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "NQZ6")

        assert await ffm.ensure_front("ES", _day("2026-11-05")) is None

        assert store.inserted == []
        err = rate_limited.error.call_args.kwargs["extra"]["err"]
        assert "next stored decision" in err
        assert "NQZ6" in err

    @pytest.mark.asyncio
    async def test_a_two_digit_ceiling_is_read_under_its_canonical_name(self, store, logs):
        log, _ = logs
        store.decide("ES", "2026-11-03", "ESZ6")
        store.decide("ES", "2026-11-09", "ESZ26")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})

        assert await ffm.ensure_front("ES", _day("2026-11-05")) == "ESZ6"
        assert log.error.call_args.kwargs["extra"]["ceiling"] == "ESZ6"


class TestEnsureFrontFillCap:
    @staticmethod
    def _backlog(store: _Store, sessions: int) -> None:
        store.decide("ES", "2026-10-01", "ESZ6")
        for n in range(sessions):
            store.trade("ES", f"2026-10-{2 + n:02d}", {"ESZ6": 900, "ESH7": 100})

    @pytest.mark.asyncio
    async def test_twelve_undecided_dates_fill_ten_then_none_then_the_rest(self, store, logs):
        _, rate_limited = logs
        self._backlog(store, 12)  # volume rows for 10-02 .. 10-13

        assert await ffm.ensure_front("ES", _day("2026-10-14")) is None

        # The first ten, oldest first. The date asked for is not decided.
        assert [d.isoformat() for _, d, _ in store.inserted] == [
            f"2026-10-{n:02d}" for n in range(2, 12)
        ]
        assert ("ES", _day("2026-10-14")) not in store.front
        # An error: ten sessions without a decision is not routine, and it
        # costs a gap in every minute until the fill catches up.
        assert rate_limited.error.call_count == 1
        assert rate_limited.warning.call_args_list == []
        assert rate_limited.error.call_args.kwargs["kind"] == "front_month_fill_capped"
        assert rate_limited.error.call_args.kwargs["key"] == "ES"
        extra = rate_limited.error.call_args.kwargs["extra"]
        assert extra["product"] == "ES"
        assert extra["trade_date"] == "2026-10-14"
        assert ffm.last_failure("ES") == ("front_month_fill_capped", "")

        # The next call carries on from where the fill stopped.
        assert await ffm.ensure_front("ES", _day("2026-10-14")) == "ESZ6"
        assert [d.isoformat() for _, d, _ in store.inserted] == [
            f"2026-10-{n:02d}" for n in range(2, 14)
        ] + ["2026-10-14"]
        assert set(store.dates().values()) == {"ESZ6"}

    @pytest.mark.asyncio
    async def test_ten_undecided_dates_still_complete_in_one_call(self, store, logs):
        _, rate_limited = logs
        self._backlog(store, 10)  # 10-02 .. 10-11

        assert await ffm.ensure_front("ES", _day("2026-10-12")) == "ESZ6"
        assert len(store.inserted) == 11
        assert rate_limited.warning.call_args_list == []
        assert rate_limited.error.call_args_list == []

    @pytest.mark.asyncio
    async def test_the_cap_is_ten(self):
        assert ffm.FILL_CAP == 10


class TestEnsureFrontDatabaseFailures:
    @pytest.mark.asyncio
    async def test_a_database_error_is_a_logged_none_not_a_raise(self, store, logs, monkeypatch):
        _, rate_limited = logs

        async def boom(product, day):
            raise TimeoutError("command_timeout")

        monkeypatch.setattr(ffm, "_read_stored", boom)

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None

        # A timeout is transient: a warning, and its window is the root's own.
        assert rate_limited.error.call_args_list == []
        assert rate_limited.warning.call_count == 1
        assert rate_limited.warning.call_args.kwargs["scope"] == "futures_front_month"
        assert rate_limited.warning.call_args.kwargs["kind"] == "ensure_front_failed"
        assert rate_limited.warning.call_args.kwargs["key"] == "ES"
        extra = rate_limited.warning.call_args.kwargs["extra"]
        assert extra["err_type"] == "TimeoutError"
        assert extra["err"] == "command_timeout"
        assert extra["product"] == "ES"
        assert ffm.last_failure("ES") == ("ensure_front_failed", "TimeoutError")

    @pytest.mark.asyncio
    async def test_a_genuine_database_error_is_an_error_that_reaches_sentry(
        self, store, logs, monkeypatch
    ):
        _, rate_limited = logs

        async def missing_table(product, day):
            raise asyncpg.exceptions.UndefinedTableError("relation does not exist")

        monkeypatch.setattr(ffm, "_read_stored", missing_table)

        assert await ffm.ensure_front("NQ", _day("2026-11-06")) is None

        assert rate_limited.warning.call_args_list == []
        assert rate_limited.error.call_count == 1
        assert rate_limited.error.call_args.kwargs["kind"] == "ensure_front_failed"
        assert rate_limited.error.call_args.kwargs["key"] == "NQ"
        assert rate_limited.error.call_args.kwargs["extra"]["err_type"] == "UndefinedTableError"
        assert ffm.last_failure("NQ") == ("ensure_front_failed", "UndefinedTableError")

    @pytest.mark.asyncio
    async def test_a_genuine_failure_sends_an_error_event_and_a_transient_one_does_not(
        self, store, monkeypatch
    ):
        """Through the real throttled logger: the error line is also an event,
        the warning is not."""
        monkeypatch.setattr(ffm.rate_limited_log, "_state", {})
        events: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            sentry_setup, "capture_message", lambda msg, **kw: events.append((msg, kw))
        )

        async def timed_out(product, day):
            raise TimeoutError("command_timeout")

        async def missing_table(product, day):
            raise asyncpg.exceptions.UndefinedTableError("relation does not exist")

        monkeypatch.setattr(ffm, "_read_stored", timed_out)
        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        assert events == []

        monkeypatch.setattr(ffm, "_read_stored", missing_table)
        assert await ffm.ensure_front("NQ", _day("2026-11-06")) is None

        ((message, kwargs),) = events
        assert message == "front-month lookup failed; the date stays undecided"
        assert kwargs["level"] == "error"
        assert kwargs["tags"] == {"component": "futures_front_month", "kind": "ensure_front_failed"}
        assert kwargs["context"]["err_type"] == "UndefinedTableError"
        assert kwargs["context"]["product"] == "NQ"

    @pytest.mark.asyncio
    async def test_a_failing_insert_is_a_logged_none_and_the_row_is_not_there(
        self, store, logs, monkeypatch
    ):
        """The write rejects (a grant, a constraint): R4's write-failure case."""
        _, rate_limited = logs
        store.decide("ES", "2026-11-05", "ESZ6")

        async def rejected(product, day, contract):
            raise asyncpg.exceptions.InsufficientPrivilegeError("permission denied")

        monkeypatch.setattr(ffm, "_insert_decision", rejected)

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None

        assert ("ES", _day("2026-11-06")) not in store.front
        assert rate_limited.error.call_args.kwargs["extra"]["err_type"] == (
            "InsufficientPrivilegeError"
        )

    @pytest.mark.asyncio
    async def test_a_transient_failure_of_the_insert_stays_a_warning(
        self, store, logs, monkeypatch
    ):
        _, rate_limited = logs

        async def timed_out(product, day, contract):
            raise TimeoutError("command_timeout")

        monkeypatch.setattr(ffm, "_insert_decision", timed_out)

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        assert rate_limited.error.call_args_list == []
        assert rate_limited.warning.call_args.kwargs["extra"]["err_type"] == "TimeoutError"

    @pytest.mark.asyncio
    async def test_the_last_failure_is_per_root_and_a_success_clears_it(self, store, monkeypatch):
        real_read = store.read_stored

        async def flaky(product, day):
            if product == "ES":
                raise TimeoutError("slow")
            return await real_read(product, day)

        monkeypatch.setattr(ffm, "_read_stored", flaky)
        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        assert await ffm.ensure_front("NQ", _day("2026-11-06")) == "NQZ6"

        assert ffm.last_failure("ES") == ("ensure_front_failed", "TimeoutError")
        assert ffm.last_failure("NQ") is None

        monkeypatch.setattr(ffm, "_read_stored", real_read)
        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"
        assert ffm.last_failure("ES") is None

    @pytest.mark.asyncio
    async def test_a_failure_part_way_through_the_fill_keeps_what_was_written_and_a_retry_finishes(
        self, store, logs
    ):
        store.decide("ES", "2026-11-03", "ESZ6")
        store.trade("ES", "2026-11-04", {"ESZ6": 100, "ESH7": 900})
        store.trade("ES", "2026-11-05", {"ESZ6": 900, "ESH7": 100})
        # Input reads, in order: 11-06, 11-04, 11-05. Fail the third.
        store.fail_inputs_on = {3}

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        assert store.dates() == {"2026-11-03": "ESZ6", "2026-11-04": "ESZ6"}

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESH7"
        assert store.dates() == {
            "2026-11-03": "ESZ6",
            "2026-11-04": "ESZ6",
            "2026-11-05": "ESH7",
            "2026-11-06": "ESH7",
        }

    @pytest.mark.asyncio
    async def test_a_row_another_writer_inserted_first_wins(self, store):
        store.decide("ES", "2026-11-05", "ESZ6")
        store.trade("ES", "2026-11-05", {"ESZ6": 1, "ESH7": 9})

        def other_writer(s: _Store, product: str, day: date) -> None:
            s.front[(product, day)] = "ESZ6"  # landed after our inputs were read

        store.before_insert = other_writer

        assert await ffm.ensure_front("ES", _day("2026-11-06")) == "ESZ6"
        assert store.dates()["2026-11-06"] == "ESZ6"

    @pytest.mark.asyncio
    async def test_a_row_missing_after_its_insert_is_a_logged_none(self, store, logs, monkeypatch):
        _, rate_limited = logs

        async def lost(product, day, contract):
            return None

        monkeypatch.setattr(ffm, "_insert_decision", lost)

        assert await ffm.ensure_front("ES", _day("2026-11-06")) is None
        err = rate_limited.error.call_args.kwargs["extra"]["err"]
        assert "missing after its insert" in err
        assert "ES" in err
        assert "2026-11-06" in err

    @pytest.mark.asyncio
    async def test_a_cancel_is_not_swallowed(self, store, monkeypatch):
        import asyncio

        async def cancelled(product, day):
            raise asyncio.CancelledError

        monkeypatch.setattr(ffm, "_read_stored", cancelled)
        with pytest.raises(asyncio.CancelledError):
            await ffm.ensure_front("ES", _day("2026-11-06"))


# ----------------------------------------------------------------------
# The SQL functions, against a mocked db.fetch / db.execute
# ----------------------------------------------------------------------


class TestReadStored:
    @pytest.mark.asyncio
    async def test_binds_the_product_and_the_date_and_returns_the_contract(self):
        with patch(
            "futures_front_month.db.fetch", AsyncMock(return_value=[{"contract": "ESZ6"}])
        ) as fetch:
            assert await ffm._read_stored("ES", date(2026, 11, 6)) == "ESZ6"

        _label, sql, *args = fetch.await_args.args
        assert "FROM futures_front_month" in sql
        assert "product = $1 AND trade_date = $2::date" in sql
        assert args == ["ES", date(2026, 11, 6)]

    @pytest.mark.asyncio
    async def test_no_row_is_none(self):
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=[])):
            assert await ffm._read_stored("ES", date(2026, 11, 6)) is None

    @pytest.mark.asyncio
    async def test_a_hostile_product_stays_a_bound_value(self):
        hostile = "ES'; DROP TABLE futures_front_month; --"
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=[])) as fetch:
            await ffm._read_stored(hostile, date(2026, 11, 6))
        _label, sql, *args = fetch.await_args.args
        assert hostile not in sql
        assert args[0] == hostile


class TestReadInputs:
    @pytest.mark.asyncio
    async def test_reads_the_four_arms_in_one_statement_and_parses_them(self):
        rows = [
            {"kind": "incumbent", "contract": "ESZ6", "volume": None, "day": None},
            {"kind": "ceiling", "contract": "ESH7", "volume": None, "day": None},
            {"kind": "volume", "contract": "ESZ6", "volume": 500, "day": None},
            {"kind": "volume", "contract": "ESH7", "volume": 900, "day": None},
            {"kind": "undecided", "contract": None, "volume": None, "day": date(2026, 11, 5)},
            {"kind": "undecided", "contract": None, "volume": None, "day": date(2026, 11, 4)},
        ]
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=rows)) as fetch:
            inputs = await ffm._read_inputs("ES", date(2026, 11, 9))

        assert fetch.await_count == 1
        _label, sql, *args = fetch.await_args.args
        assert args == ["ES", date(2026, 11, 9)]
        assert sql.count("UNION ALL") == 3
        assert inputs.incumbent == "ESZ6"
        assert inputs.ceiling == "ESH7"
        assert inputs.volumes == {"ESZ6": 500, "ESH7": 900}
        # The SQL promises no order (SELECT DISTINCT); the fill needs oldest first.
        assert inputs.undecided == [date(2026, 11, 4), date(2026, 11, 5)]

    @pytest.mark.asyncio
    async def test_no_rows_is_no_incumbent_no_ceiling_no_volume_no_gap(self):
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=[])):
            inputs = await ffm._read_inputs("ES", date(2026, 11, 9))
        assert (inputs.incumbent, inputs.ceiling, inputs.volumes, inputs.undecided) == (
            None,
            None,
            {},
            [],
        )

    @pytest.mark.asyncio
    async def test_the_sql_takes_the_incumbent_before_the_date_and_the_ceiling_after_it(self):
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=[])) as fetch:
            await ffm._read_inputs("ES", date(2026, 11, 9))
        sql = " ".join(fetch.await_args.args[1].split())
        assert "trade_date < $2::date ORDER BY trade_date DESC LIMIT 1" in sql
        assert "trade_date > $2::date ORDER BY trade_date LIMIT 1" in sql
        # With no incumbent the comparison is against NULL and the gap arm is
        # empty: a cold start must not walk the volume history.
        assert "v.trade_date > (SELECT max(trade_date)" in sql


class TestInsertDecision:
    @pytest.mark.asyncio
    async def test_inserts_with_the_live_source_and_do_nothing_on_conflict(self):
        with patch(
            "futures_front_month.db.execute", AsyncMock(return_value="INSERT 0 1")
        ) as execute:
            await ffm._insert_decision("ES", date(2026, 11, 6), "ESH7")

        _label, sql, *args = execute.await_args.args
        assert "INSERT INTO futures_front_month (product, trade_date, contract, source)" in sql
        assert "'live'" in sql
        assert "ON CONFLICT (product, trade_date) DO NOTHING" in sql
        assert args == ["ES", date(2026, 11, 6), "ESH7"]


class TestLoadTally:
    @pytest.mark.asyncio
    async def test_returns_the_stored_volume_per_contract(self):
        rows = [{"contract": "ESZ6", "volume": 500}, {"contract": "ESH7", "volume": 90}]
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=rows)) as fetch:
            assert await ffm.load_tally("ES", date(2026, 11, 6)) == {"ESZ6": 500, "ESH7": 90}

        _label, sql, *args = fetch.await_args.args
        assert "FROM futures_contract_volume" in sql
        assert args == ["ES", date(2026, 11, 6)]

    @pytest.mark.asyncio
    async def test_folds_spellings_and_drops_names_no_outright_could_have(self):
        rows = [
            {"contract": "ESZ6", "volume": 5},
            {"contract": "ESZ26", "volume": 7},
            {"contract": "ESZ6-ESH7", "volume": 99},
            {"contract": "ESZ36", "volume": 99},
        ]
        with patch("futures_front_month.db.fetch", AsyncMock(return_value=rows)):
            assert await ffm.load_tally("ES", date(2026, 11, 6)) == {"ESZ6": 12}

    @pytest.mark.asyncio
    async def test_a_database_error_reaches_the_caller(self):
        with (
            patch("futures_front_month.db.fetch", AsyncMock(side_effect=TimeoutError("slow"))),
            pytest.raises(TimeoutError),
        ):
            await ffm.load_tally("ES", date(2026, 11, 6))


class TestSaveTally:
    @pytest.mark.asyncio
    async def test_one_statement_for_all_rows_with_arrays_bound_not_spliced(self):
        rows = [
            ("ES", date(2026, 11, 6), "ESZ6", 500),
            ("ES", date(2026, 11, 6), "ESH7", 90),
            ("NQ", date(2026, 11, 6), "NQZ6", 40),
        ]
        with patch(
            "futures_front_month.db.execute", AsyncMock(return_value="INSERT 0 3")
        ) as execute:
            await ffm.save_tally(rows)

        assert execute.await_count == 1
        _label, sql, *args = execute.await_args.args
        assert args == [
            ["ES", "ES", "NQ"],
            [date(2026, 11, 6)] * 3,
            ["ESZ6", "ESH7", "NQZ6"],
            [500, 90, 40],
        ]
        assert "unnest($1::text[], $2::date[], $3::text[], $4::bigint[])" in sql
        assert "ESZ6" not in sql

    @pytest.mark.asyncio
    async def test_the_upsert_only_raises_volume_and_marks_the_row_live(self):
        with patch(
            "futures_front_month.db.execute", AsyncMock(return_value="INSERT 0 1")
        ) as execute:
            await ffm.save_tally([("ES", date(2026, 11, 6), "ESZ6", 5)])

        sql = execute.await_args.args[1]
        assert "ON CONFLICT (product, trade_date, contract) DO UPDATE" in sql
        assert "volume = GREATEST(futures_contract_volume.volume, EXCLUDED.volume)" in sql
        assert "source = 'live'" in sql
        assert "updated_at = now()" in sql

    @pytest.mark.asyncio
    async def test_one_source_per_session_a_session_with_candle_rows_is_never_written(self):
        # Phase 5a's rule from the live side: the guard is in the same
        # statement, keyed on the (product, trade date) and not on the contract.
        with patch(
            "futures_front_month.db.execute", AsyncMock(return_value="INSERT 0 0")
        ) as execute:
            await ffm.save_tally([("ES", date(2026, 11, 6), "ESZ6", 5)])

        sql = execute.await_args.args[1]
        assert "WHERE NOT EXISTS" in sql
        assert "v.product = t.product" in sql
        assert "v.trade_date = t.trade_date" in sql
        assert "v.source = 'candles'" in sql
        assert "v.contract" not in sql

    @pytest.mark.asyncio
    async def test_duplicate_keys_are_collapsed_to_the_larger_volume(self):
        # Postgres rejects one INSERT ... ON CONFLICT DO UPDATE that reaches
        # the same row twice.
        rows = [
            ("ES", date(2026, 11, 6), "ESZ6", 5),
            ("ES", date(2026, 11, 6), "ESZ6", 9),
            ("ES", date(2026, 11, 6), "ESZ6", 7),
        ]
        with patch(
            "futures_front_month.db.execute", AsyncMock(return_value="INSERT 0 1")
        ) as execute:
            await ffm.save_tally(rows)

        assert execute.await_args.args[2:] == (["ES"], [date(2026, 11, 6)], ["ESZ6"], [9])

    @pytest.mark.asyncio
    async def test_no_rows_no_statement(self):
        with patch("futures_front_month.db.execute", AsyncMock()) as execute:
            await ffm.save_tally([])
        assert execute.await_count == 0

    @pytest.mark.asyncio
    async def test_a_database_error_reaches_the_caller(self):
        with (
            patch("futures_front_month.db.execute", AsyncMock(side_effect=TimeoutError("slow"))),
            pytest.raises(TimeoutError),
        ):
            await ffm.save_tally([("ES", date(2026, 11, 6), "ESZ6", 5)])
