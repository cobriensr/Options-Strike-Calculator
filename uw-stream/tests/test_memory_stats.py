"""Process and container memory readers, and the registry of size gauges (memory gauge, Task 1a).

uw-stream's memory climbs through the day (0.46 GB on 11-09, 0.58 on 11-12, 0.69
on 11-13). ``memory_stats`` reads the three numbers that say where it goes:
resident set size (the process alone), the container's memory (what Railway's
graph plots, page cache included) and the sizes of the in-memory stores that
register a gauge. The pipeline minute line and ``/metrics`` print them.

The readers open ``/proc/self/statm`` and the cgroup files, which exist on Linux
only, and the suite also runs on Windows. Each test points the module's path
constants at files under ``tmp_path`` (or at a name that does not exist) and
swaps the module's ``os`` name for a fake ``sysconf``, so nothing reads the host.
The gauge registry starts empty in every test: conftest.py's autouse fixture
replaces it, and ``test_no_gauges_registered_reads_as_an_empty_object`` (which
follows a test that registers) fails if that fixture goes.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import memory_stats
import sentry_setup
from logger_setup import RateLimitedLogger

_PAGE_SIZE = 16_384  # not the usual 4,096, so a hard-coded page size fails


@pytest.fixture(autouse=True)
def _fake_page_size(monkeypatch):
    """``os.sysconf("SC_PAGE_SIZE")`` is 16,384, and only that name is known.

    Replaces only this module's ``os`` name. Windows has no ``os.sysconf``.
    """

    def _sysconf(name: str) -> int:
        if name != "SC_PAGE_SIZE":
            raise ValueError(f"unrecognized configuration name {name}")
        return _PAGE_SIZE

    monkeypatch.setattr(memory_stats, "os", SimpleNamespace(sysconf=_sysconf))


def _point_at(
    monkeypatch,
    tmp_path: Path,
    *,
    statm: bytes | None = None,
    v2: bytes | None = None,
    v1: bytes | None = None,
) -> None:
    """Make the readers open files in ``tmp_path``; a ``None`` content is a file that is absent."""
    for attribute, name, content in (
        ("STATM_PATH", "statm", statm),
        ("CGROUP_V2_PATH", "memory.current", v2),
        ("CGROUP_V1_PATH", "memory.usage_in_bytes", v1),
    ):
        path = tmp_path / name
        if content is not None:
            path.write_bytes(content)
        monkeypatch.setattr(memory_stats, attribute, path)


@pytest.fixture
def logged(monkeypatch, service_log_records):
    """Every record the service logger emits, under a fresh throttle.

    The module-level limiter keeps its windows for the whole process, so a
    warning logged by an earlier test would silence the first one of this test.
    """
    monkeypatch.setattr(memory_stats, "rate_limited_log", RateLimitedLogger())
    return service_log_records


@pytest.fixture
def sentry_events(monkeypatch) -> list[str]:
    """What reaches ``sentry_setup.capture_message``, the only way a log line becomes an event."""
    sent: list[str] = []
    monkeypatch.setattr(
        sentry_setup, "capture_message", lambda message, **_kw: sent.append(message)
    )
    return sent


# ----------------------------------------------------------------------
# read_rss_bytes
# ----------------------------------------------------------------------


def test_rss_is_the_second_statm_field_in_pages_times_the_page_size(monkeypatch, tmp_path):
    # statm: size resident shared text lib data dt, all in pages.
    _point_at(monkeypatch, tmp_path, statm=b"90000 250 100 5 0 300 0\n")

    assert memory_stats.read_rss_bytes() == 250 * _PAGE_SIZE


def test_rss_is_none_when_statm_does_not_exist(monkeypatch, tmp_path):
    # Windows, macOS, and every test run: no /proc.
    _point_at(monkeypatch, tmp_path, statm=None)

    assert memory_stats.read_rss_bytes() is None


@pytest.mark.parametrize(
    "garbled",
    [b"", b"garbage", b"1", b"1 abc 3", b"1 2.5 3", b"1 -5 3", b"\xff\xfe\x00"],
    ids=["empty", "text", "one-field", "non-numeric", "float", "negative", "binary"],
)
def test_rss_is_none_not_zero_when_statm_is_garbled(monkeypatch, tmp_path, garbled):
    # A reader that guessed 0 would put "the process uses no memory" on the line.
    _point_at(monkeypatch, tmp_path, statm=garbled)

    assert memory_stats.read_rss_bytes() is None


def test_rss_is_none_when_the_page_size_cannot_be_read(monkeypatch, tmp_path):
    def _no_page_size(_name: str) -> int:
        raise OSError("sysconf failed")

    monkeypatch.setattr(memory_stats, "os", SimpleNamespace(sysconf=_no_page_size))
    _point_at(monkeypatch, tmp_path, statm=b"90000 250 100 5 0 300 0\n")

    assert memory_stats.read_rss_bytes() is None


def test_rss_is_none_when_the_os_has_no_sysconf_at_all(monkeypatch, tmp_path):
    # Windows has no os.sysconf: the attribute is missing, not a call that fails.
    # With a statm file that reads, the guard must still hold.
    monkeypatch.setattr(memory_stats, "os", SimpleNamespace())
    _point_at(monkeypatch, tmp_path, statm=b"90000 250 100 5 0 300 0\n")

    assert memory_stats.read_rss_bytes() is None


def test_the_production_paths_are_the_linux_ones():
    # The test above points the constants at tmp_path; this pins what ships.
    assert str(memory_stats.STATM_PATH).replace("\\", "/") == "/proc/self/statm"
    assert str(memory_stats.CGROUP_V2_PATH).replace("\\", "/") == "/sys/fs/cgroup/memory.current"
    assert (
        str(memory_stats.CGROUP_V1_PATH).replace("\\", "/")
        == "/sys/fs/cgroup/memory/memory.usage_in_bytes"
    )


# ----------------------------------------------------------------------
# read_cgroup_bytes
# ----------------------------------------------------------------------


def test_cgroup_v2_reads_memory_current(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, v2=b"734003200\n")

    assert memory_stats.read_cgroup_bytes() == 734_003_200


def test_cgroup_falls_back_to_v1_when_v2_is_absent(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, v2=None, v1=b"612368384\n")

    assert memory_stats.read_cgroup_bytes() == 612_368_384


def test_cgroup_v2_wins_when_both_exist(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, v2=b"734003200\n", v1=b"612368384\n")

    assert memory_stats.read_cgroup_bytes() == 734_003_200


def test_cgroup_is_none_when_neither_file_exists(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, v2=None, v1=None)

    assert memory_stats.read_cgroup_bytes() is None


@pytest.mark.parametrize(
    "garbled",
    [b"", b"max", b"abc", b"-1", b"12 34", b"1.5", b"\xff\xfe"],
    ids=["empty", "max", "text", "negative", "two-fields", "float", "binary"],
)
def test_cgroup_is_none_not_zero_when_every_file_is_garbled(monkeypatch, tmp_path, garbled):
    _point_at(monkeypatch, tmp_path, v2=garbled, v1=garbled)

    assert memory_stats.read_cgroup_bytes() is None


def test_a_garbled_v2_file_falls_through_to_a_good_v1_file(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, v2=b"max\n", v1=b"612368384\n")

    assert memory_stats.read_cgroup_bytes() == 612_368_384


# ----------------------------------------------------------------------
# Gauge registry
# ----------------------------------------------------------------------


def test_read_gauges_calls_each_registered_gauge_and_returns_its_value():
    memory_stats.register_gauge("option_trades.dedupe_keys", lambda: 160_000)
    memory_stats.register_gauge("option_trades:SPY.chains", lambda: 412)

    assert memory_stats.read_gauges() == {
        "option_trades.dedupe_keys": 160_000,
        "option_trades:SPY.chains": 412,
    }


def test_no_gauges_registered_reads_as_an_empty_object():
    assert memory_stats.read_gauges() == {}


def test_registering_a_gauge_does_not_call_it_and_each_read_calls_it_once():
    # The gauges run once a minute from the reporter, never from a hot path:
    # registering (at handler construction) must not read the structure.
    calls: list[None] = []
    memory_stats.register_gauge("net_flow.depth", lambda: calls.append(None) or len(calls))

    assert calls == []
    assert memory_stats.read_gauges() == {"net_flow.depth": 1}
    assert memory_stats.read_gauges() == {"net_flow.depth": 2}
    assert len(calls) == 2


def test_registering_a_name_again_replaces_the_gauge_and_does_not_add_one():
    # A handler rebuilt in a test, or a restart that constructs one again, binds
    # the same name to a new structure; the old closure must not stay behind.
    memory_stats.register_gauge("option_trades.dedupe_keys", lambda: 1)
    memory_stats.register_gauge("option_trades.dedupe_keys", lambda: 2)

    assert memory_stats.read_gauges() == {"option_trades.dedupe_keys": 2}


def test_registering_the_same_name_over_and_over_never_grows_the_registry():
    for size in range(1_000):
        memory_stats.register_gauge("option_trades.dedupe_keys", lambda size=size: size)

    assert len(memory_stats._gauges) == 1
    assert memory_stats.read_gauges() == {"option_trades.dedupe_keys": 999}


def test_the_registry_is_capped_so_a_name_made_up_per_call_cannot_grow_it(logged):
    for index in range(memory_stats.MAX_GAUGES + 5):
        memory_stats.register_gauge(f"made_up.{index}", lambda index=index: index)

    assert len(memory_stats._gauges) == memory_stats.MAX_GAUGES
    assert "made_up.0" in memory_stats.read_gauges()
    assert f"made_up.{memory_stats.MAX_GAUGES}" not in memory_stats.read_gauges()
    # The refusal is said once (rate limited), at warning level, naming the gauge.
    refusals = [r for r in logged if r.levelname == "WARNING"]
    assert len(refusals) == 1
    assert refusals[0].gauge == f"made_up.{memory_stats.MAX_GAUGES}"


def test_a_full_registry_still_replaces_a_name_it_already_holds():
    for index in range(memory_stats.MAX_GAUGES):
        memory_stats.register_gauge(f"made_up.{index}", lambda: 0)

    memory_stats.register_gauge("made_up.3", lambda: 33)

    assert len(memory_stats._gauges) == memory_stats.MAX_GAUGES
    assert memory_stats.read_gauges()["made_up.3"] == 33


def test_a_gauge_that_raises_is_skipped_and_the_others_still_report(logged, sentry_events):
    def _broken() -> int:
        raise RuntimeError("structure mutated")

    memory_stats.register_gauge("a.first", lambda: 10)
    memory_stats.register_gauge("b.broken", _broken)
    memory_stats.register_gauge("c.last", lambda: 30)

    assert memory_stats.read_gauges() == {"a.first": 10, "c.last": 30}

    failures = [r for r in logged if r.levelname == "WARNING"]
    assert len(failures) == 1
    assert failures[0].getMessage() == "memory gauge failed"
    assert (failures[0].gauge, failures[0].err_type, failures[0].err) == (
        "b.broken",
        "RuntimeError",
        "structure mutated",
    )
    # A log line is not a Sentry event: nothing here may page.
    assert [r for r in logged if r.levelname in {"ERROR", "CRITICAL"}] == []
    assert sentry_events == []


def test_a_gauge_that_keeps_raising_is_logged_at_most_once_a_minute_not_on_every_read(logged):
    def _broken() -> int:
        raise ValueError("still broken")

    memory_stats.register_gauge("b.broken", _broken)

    for _ in range(5):
        assert memory_stats.read_gauges() == {}

    assert len([r for r in logged if r.levelname == "WARNING"]) == 1


def test_two_broken_gauges_are_each_named(logged):
    def _broken() -> int:
        raise ValueError("broken")

    memory_stats.register_gauge("b.one", _broken)
    memory_stats.register_gauge("b.two", _broken)

    memory_stats.read_gauges()

    assert sorted(r.gauge for r in logged if r.levelname == "WARNING") == ["b.one", "b.two"]


def test_a_gauge_is_read_again_the_minute_after_it_failed(logged):
    state = {"broken": True}

    def _sometimes() -> int:
        if state["broken"]:
            raise RuntimeError("mid-rotation")
        return 7

    memory_stats.register_gauge("a.flaky", _sometimes)
    assert memory_stats.read_gauges() == {}

    state["broken"] = False
    assert memory_stats.read_gauges() == {"a.flaky": 7}


def test_a_cancel_inside_a_gauge_is_not_swallowed():
    import asyncio

    def _cancelled() -> int:
        raise asyncio.CancelledError()

    memory_stats.register_gauge("a.cancelled", _cancelled)

    with pytest.raises(asyncio.CancelledError):
        memory_stats.read_gauges()


# ----------------------------------------------------------------------
# snapshot
# ----------------------------------------------------------------------


def test_snapshot_carries_all_three_readings(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, statm=b"90000 250 100 5 0 300 0\n", v2=b"734003200\n")
    memory_stats.register_gauge("option_trades.dedupe_keys", lambda: 5)

    snapshot = memory_stats.snapshot()

    assert snapshot == memory_stats.MemorySnapshot(
        rss_bytes=250 * _PAGE_SIZE,
        cgroup_bytes=734_003_200,
        gauges={"option_trades.dedupe_keys": 5},
    )


def test_snapshot_reads_none_for_a_missing_source_and_keeps_the_rest(monkeypatch, tmp_path):
    _point_at(monkeypatch, tmp_path, statm=None, v2=b"734003200\n")

    snapshot = memory_stats.snapshot()

    assert snapshot.rss_bytes is None
    assert snapshot.cgroup_bytes == 734_003_200
    assert snapshot.gauges == {}
