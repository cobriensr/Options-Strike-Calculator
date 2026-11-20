"""Tests for the research-derive step.

R2 is moto and holds fixture tape objects, so the tape listing, the manifest and every derived
object go through the real R2Store and ResearchStore. The database, the tape reader and the
scripts' per-day functions are patched at research_derive's boundary. The fingerprints are the
scripts' real `fingerprint_rows` over fake fire rows, so what the pre-check hashes and what the
step stores differ only when a test makes the rows differ.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, call, create_autospec, patch

import _eod_flow
import _tape_reader
import boto3
import botocore.client
import exit_policy_search
import flow_inversion_timing
import pandas as pd
import psycopg2
import pytest
import sentry_sdk
from _tape_reader import FETCH_DEADLINE_SECONDS, TapeReader, TapeReadError
from botocore.exceptions import ClientError
from moto import mock_aws

import research_derive
import resources
import steps
from config import Settings, load_settings
from constants import (
    ENRICH_CACHE_DIR,
    LARGE_REPORT_BUDGET_SECONDS,
    REPORT_BUDGET_SECONDS,
    RESEARCH_DAY_BUDGET_SECONDS,
    RESEARCH_MAX_DAY_FAILURES,
    RESEARCH_TAPE_DIR,
    RESEARCH_WORK_DIR,
    WORK_DIR,
)
from r2_store import R2Store, R2VerifyError
from research_derive import (
    FAMILY_KEYS,
    MANIFEST_KEY,
    SEED,
    Manifest,
    ManifestError,
    fresh_days,
    stale_days,
    targets,
)
from research_store import ResearchStore
from steps import Step, StepContext, StepResult, run_steps

BUCKET = "test-bucket"
NOW = datetime(2026, 11, 12, 7, 15, tzinfo=UTC)
LAST_SESSION = date(2026, 11, 11)  # a Wednesday
DAYS = [
    date(2026, 11, 5),
    date(2026, 11, 6),
    date(2026, 11, 9),
    date(2026, 11, 10),
    date(2026, 11, 11),
]
NEWEST_FIRST = sorted(DAYS, reverse=True)
STEP_NAME = "research-derive"
FAMILIES = ("chains", "exit-policy", "flow-timing")
FIRE_FAMILIES = ("exit-policy", "flow-timing")
SCRIPTS = {"exit-policy": exit_policy_search, "flow-timing": flow_inversion_timing}
CHAINS_ROWS = 5
DERIVED_ROWS = {"exit-policy": 2, "flow-timing": 1}
DAY_ROWS = CHAINS_ROWS + sum(DERIVED_ROWS.values())
FAILED_DETAIL = "a day failed to derive"
MANIFEST_DETAIL = "derive manifest is malformed"
PARTIAL_DETAIL = "days left for the next night"
NOT_LANDED_DETAIL = "latest session tape not landed"
COUNT_NAMES = {
    "days_planned",
    "days_derived",
    "days_left",
    "days_failed",
    "days_tape_missing",
    "chains_written",
    "exit_policy_written",
    "flow_timing_written",
    "rows_written",
}


# --- fixtures and the rig --------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_home(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """boto3 reads ~/.aws and may cache under the home dir; keep it off the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def settings() -> Settings:
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    return load_settings().model_copy(
        update={"r2_endpoint_url": "https://s3.amazonaws.com", "r2_bucket_fulltape": BUCKET}
    )


@dataclass
class Clock:
    now: float = 1_000.0

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(steps, "monotonic", lambda: fake.now)
    return fake


@pytest.fixture
def capture_exception(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = create_autospec(sentry_sdk.capture_exception)
    monkeypatch.setattr(sentry_sdk, "capture_exception", mock)
    return mock


def tape_body(day: date, generation: int = 0) -> bytes:
    return f"tape {day.isoformat()} g{generation}".encode()


def etag_of(body: bytes) -> str:
    """What R2 reports for a single-part upload: the body's MD5."""
    return hashlib.md5(body, usedforsecurity=False).hexdigest()


def fires_frame(day: date, n: int = 2) -> pd.DataFrame:
    """The fires a day's fingerprint covers: `n` ids, every other one with an inversion."""
    ids = [day.toordinal() * 100 + k for k in range(n)]
    return pd.DataFrame({"id": ids, "flow_inv": [5.0 if k % 2 == 0 else None for k in range(n)]})


def derived_frame(family: str, n: int) -> pd.DataFrame:
    """What a script's derive_day returns: its DERIVED_COLUMNS with the pinned dtypes."""
    columns = SCRIPTS[family].DERIVED_COLUMNS
    return pd.DataFrame(
        {
            column: pd.Series(range(n), dtype="int64" if column == "id" else "float64")
            for column in columns
        }
    )


def _day_of(path: Path) -> date:
    return date.fromisoformat(path.name[:10])


@dataclass
class Rig:
    """The patched boundary of research_derive, and what it was asked, in order."""

    s3: Any
    settings: Settings
    work: Path
    events: list[str]
    conn: MagicMock
    connect: MagicMock
    reader: MagicMock
    open_reader: MagicMock
    build_chains: MagicMock
    fires: dict[str, MagicMock]
    derive: dict[str, MagicMock]
    day_fingerprints: dict[str, MagicMock]
    api_calls: list[tuple[str, dict[str, Any]]]
    generations: dict[date, int] = field(default_factory=dict)
    # The rows the day-fingerprint query hashed, per family and day; `served` is what
    # fires_for_day returns, which a test can make differ.
    precheck: dict[str, dict[date, pd.DataFrame]] = field(default_factory=dict)
    served: dict[str, dict[date, pd.DataFrame]] = field(default_factory=dict)
    derived_n: dict[str, dict[date, int]] = field(default_factory=dict)
    chain_rows: dict[date, int] = field(default_factory=dict)
    fetch_errors: dict[date, BaseException] = field(default_factory=dict)
    missing_tape: set[date] = field(default_factory=set)
    chains_errors: dict[date, BaseException] = field(default_factory=dict)
    fires_errors: dict[tuple[str, date], BaseException] = field(default_factory=dict)
    derive_errors: dict[tuple[str, date], BaseException] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    # tape
    def land(self, day: date, generation: int = 0) -> None:
        self.generations[day] = generation
        self.s3.put_object(
            Bucket=BUCKET,
            Key=f"fulltape/{day.isoformat()}-fulltape.parquet",
            Body=tape_body(day, generation),
        )

    def unland(self, day: date) -> None:
        self.s3.delete_object(Bucket=BUCKET, Key=f"fulltape/{day.isoformat()}-fulltape.parquet")

    def etag(self, day: date) -> str:
        return etag_of(tape_body(day, self.generations[day]))

    # fires
    def set_fires(self, family: str, day: date, frame: pd.DataFrame) -> None:
        self.precheck[family][day] = frame
        self.served[family][day] = frame

    def serve(self, family: str, day: date, frame: pd.DataFrame) -> None:
        """What fires_for_day returns, while the day-fingerprint query keeps the old rows."""
        self.served[family][day] = frame

    def target(self, family: str, day: date) -> str:
        """The fingerprint the pre-check expects for a day, as the step spells it."""
        if family == "chains":
            return f"{self.etag(day)}|v{research_derive.CHAINS_VERSION}"
        script = SCRIPTS[family]
        digest = script.fingerprint_rows(self.precheck[family][day])
        return f"{self.etag(day)}|v{script.DERIVE_VERSION}|{digest}"

    # the manifest and the derived objects
    def put_manifest(self, body: object) -> None:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.s3.put_object(Bucket=BUCKET, Key=MANIFEST_KEY, Body=raw)

    def manifest_bytes(self) -> bytes | None:
        try:
            return self.s3.get_object(Bucket=BUCKET, Key=MANIFEST_KEY)["Body"].read()
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "NoSuchKey":
                return None
            raise

    def manifest(self) -> dict[str, Any] | None:
        raw = self.manifest_bytes()
        return None if raw is None else json.loads(raw)

    def keys(self) -> list[str]:
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET)
        return sorted(o["Key"] for page in pages for o in page.get("Contents", []))

    def research_keys(self) -> list[str]:
        return [key for key in self.keys() if key.startswith("research/")]

    def object_bytes(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()

    def object_frame(self, key: str) -> pd.DataFrame:
        return pd.read_parquet(io.BytesIO(self.object_bytes(key)))

    def expected_manifest(self, days: list[date]) -> dict[str, Any]:
        return {
            "version": 1,
            "families": {
                family: {day.isoformat(): self.target(family, day) for day in sorted(days)}
                for family in FAMILIES
            },
        }

    # one run
    def run(self, ctx: StepContext) -> StepResult:
        """Run the step; `calls` is every botocore request it made, in order."""
        self.api_calls.clear()
        try:
            return research_derive.run(ctx)
        finally:
            self.calls = list(self.api_calls)

    def puts(self) -> list[str]:
        return [params["Key"] for op, params in self.calls if op == "PutObject"]


@pytest.fixture
def rig(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, settings: Settings, clock: Clock
) -> Iterator[Rig]:
    events: list[str] = []
    api_calls: list[tuple[str, dict[str, Any]]] = []
    original_call = botocore.client.BaseClient._make_api_call

    def recording_call(self: Any, operation_name: str, api_params: dict[str, Any]) -> Any:
        api_calls.append((operation_name, dict(api_params)))
        return original_call(self, operation_name, api_params)

    work = tmp_path / "research"  # not created: the step makes it
    monkeypatch.setattr(research_derive, "RESEARCH_WORK_DIR", work)
    monkeypatch.setattr(botocore.client.BaseClient, "_make_api_call", recording_call)

    conn = MagicMock(name="conn")

    @contextmanager
    def fake_connect(_settings: Settings) -> Iterator[MagicMock]:
        events.append("connect")
        try:
            yield conn
        finally:
            events.append("close")

    reader = create_autospec(TapeReader, instance=True)
    reader.__enter__.return_value = reader
    reader.__exit__.return_value = False  # a truthy exit would swallow the step's exceptions

    def fake_open_reader(_settings: Settings, _cache_dir: Path) -> MagicMock:
        events.append("open_reader")
        return reader

    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        r = Rig(
            s3=s3,
            settings=settings,
            work=work,
            events=events,
            conn=conn,
            connect=create_autospec(resources.connect_db, side_effect=fake_connect),
            reader=reader,
            open_reader=create_autospec(resources.open_reader, side_effect=fake_open_reader),
            build_chains=create_autospec(_eod_flow.build_chains),
            fires={f: create_autospec(SCRIPTS[f].fires_for_day) for f in FIRE_FAMILIES},
            derive={f: create_autospec(SCRIPTS[f].derive_day) for f in FIRE_FAMILIES},
            day_fingerprints={
                f: create_autospec(SCRIPTS[f].day_fingerprints) for f in FIRE_FAMILIES
            },
            api_calls=api_calls,
        )
        r.precheck = {f: {} for f in FIRE_FAMILIES}
        r.served = {f: {} for f in FIRE_FAMILIES}
        r.derived_n = {f: {} for f in FIRE_FAMILIES}

        def fetch(day: date, deadline: float | None = None) -> Path | None:
            events.append(f"fetch {day}")
            if day in r.fetch_errors:
                raise r.fetch_errors[day]
            if day in r.missing_tape:
                return None
            return Path(f"/cache/{day}-fulltape.parquet")

        reader.fetch_day.side_effect = fetch
        reader.release.side_effect = lambda day: events.append(f"release {day}")

        def build(tape_path: Path, day: date, out_path: Path, temp_dir: Path | None = None) -> int:
            events.append(f"chains {day}")
            if day in r.chains_errors:
                raise r.chains_errors[day]
            out_path.write_bytes(f"chains {day}".encode())
            return r.chain_rows.get(day, CHAINS_ROWS)

        r.build_chains.side_effect = build

        for family in FIRE_FAMILIES:

            def fires_for_day(_conn: MagicMock, day: date, family: str = family) -> pd.DataFrame:
                events.append(f"fires {family} {day}")
                if (family, day) in r.fires_errors:
                    raise r.fires_errors[(family, day)]
                return r.served[family][day]

            def derive_day(*args: Any, family: str = family) -> pd.DataFrame:
                day = _day_of(args[0]) if family == "exit-policy" else args[1]
                events.append(f"derive {family} {day}")
                if (family, day) in r.derive_errors:
                    raise r.derive_errors[(family, day)]
                return derived_frame(family, r.derived_n[family].get(day, DERIVED_ROWS[family]))

            def day_fingerprints(_conn: MagicMock, family: str = family) -> dict[date, str]:
                return {
                    day: SCRIPTS[family].fingerprint_rows(frame)
                    for day, frame in r.precheck[family].items()
                }

            r.fires[family].side_effect = fires_for_day
            r.derive[family].side_effect = derive_day
            r.day_fingerprints[family].side_effect = day_fingerprints
            monkeypatch.setattr(SCRIPTS[family], "fires_for_day", r.fires[family])
            monkeypatch.setattr(SCRIPTS[family], "derive_day", r.derive[family])
            monkeypatch.setattr(SCRIPTS[family], "day_fingerprints", r.day_fingerprints[family])

        for day in DAYS:
            r.land(day)
            for family in FIRE_FAMILIES:
                r.set_fires(family, day, fires_frame(day))
        monkeypatch.setattr(research_derive, "connect_db", r.connect)
        monkeypatch.setattr(research_derive, "open_reader", r.open_reader)
        monkeypatch.setattr(research_derive, "build_chains", r.build_chains)
        yield r


def _ctx(
    settings: Settings,
    clock: Clock,
    *,
    left: float = 100_000.0,
    last_session: date = LAST_SESSION,
) -> StepContext:
    return StepContext(settings, NOW, last_session, deadline=clock.now + left, tape=())


def _isos(events: list[str], prefix: str) -> list[str]:
    return [e.removeprefix(f"{prefix} ") for e in events if e.startswith(f"{prefix} ")]


def _advancing(rig: Rig, clock: Clock, seconds: float) -> Callable[..., int]:
    """The rig's chains build, which also spends `seconds` of the step's time."""
    original = rig.build_chains.side_effect

    def build(*args: Any, **kwargs: Any) -> int:
        clock.advance(seconds)
        return original(*args, **kwargs)

    return build


def _chains_key(day: date) -> str:
    return f"research/eod-flow/by-day/{day.isoformat()}-chains.parquet"


def _exit_key(day: date) -> str:
    return f"research/exit-policy/derived/{day.isoformat()}.parquet"


def _timing_key(day: date) -> str:
    return f"research/flow-timing/derived/{day.isoformat()}.parquet"


def _full_counts(days: int, **overrides: int) -> dict[str, int]:
    """The counts of a night that derived `days` whole days; `overrides` change some."""
    counts = {
        "days_planned": days,
        "days_derived": days,
        "days_left": 0,
        "days_failed": 0,
        "days_tape_missing": 0,
        "chains_written": days,
        "exit_policy_written": days,
        "flow_timing_written": days,
        "rows_written": days * DAY_ROWS,
    }
    return {**counts, **overrides}


# --- constants ---------------------------------------------------------------------------


def test_phase_three_constants_are_the_briefs() -> None:
    assert WORK_DIR / "research" == RESEARCH_WORK_DIR
    assert WORK_DIR / "research-tape" == RESEARCH_TAPE_DIR
    assert RESEARCH_DAY_BUDGET_SECONDS == 900
    assert RESEARCH_MAX_DAY_FAILURES == 3
    assert REPORT_BUDGET_SECONDS == 300
    assert LARGE_REPORT_BUDGET_SECONDS == 600


def test_the_research_directories_are_apart() -> None:
    # open_reader empties its directory, and the derive spills and writes into the other.
    assert RESEARCH_TAPE_DIR != ENRICH_CACHE_DIR
    assert RESEARCH_TAPE_DIR not in RESEARCH_WORK_DIR.parents
    assert RESEARCH_WORK_DIR not in RESEARCH_TAPE_DIR.parents
    assert RESEARCH_TAPE_DIR != RESEARCH_WORK_DIR


def test_research_day_budget_fits_the_fetch_deadline() -> None:
    assert RESEARCH_DAY_BUDGET_SECONDS <= _tape_reader.FETCH_DEADLINE_SECONDS + 300


# --- the manifest ------------------------------------------------------------------------


def test_the_state_keys_follow_the_layout() -> None:
    day = date(2026, 11, 5)
    assert FAMILY_KEYS["chains"](day) == "research/eod-flow/by-day/2026-11-05-chains.parquet"
    assert FAMILY_KEYS["exit-policy"](day) == "research/exit-policy/derived/2026-11-05.parquet"
    assert FAMILY_KEYS["flow-timing"](day) == "research/flow-timing/derived/2026-11-05.parquet"
    assert set(FAMILY_KEYS) == set(FAMILIES)
    assert MANIFEST_KEY == "research/_state/derive-manifest.json"
    assert SEED == "seed"


def test_an_absent_manifest_loads_empty(rig: Rig, settings: Settings) -> None:
    manifest = Manifest.load(ResearchStore(settings))

    assert manifest.families == {}
    assert manifest.get("chains", DAYS[0]) is None


def test_the_manifest_round_trips_through_r2(rig: Rig, settings: Settings) -> None:
    store = ResearchStore(settings)
    manifest = Manifest.load(store)
    manifest.set("flow-timing", DAYS[1], "e|v1|b")
    manifest.set("chains", DAYS[1], "e|v1")
    manifest.set("chains", DAYS[0], SEED)

    manifest.save(store)

    assert json.loads(rig.manifest_bytes() or b"") == {
        "version": 1,
        "families": {
            "chains": {"2026-11-05": "seed", "2026-11-06": "e|v1"},
            "flow-timing": {"2026-11-06": "e|v1|b"},
        },
    }
    loaded = Manifest.load(store)
    assert loaded.get("chains", DAYS[0]) == SEED
    assert loaded.get("flow-timing", DAYS[1]) == "e|v1|b"
    assert loaded.get("exit-policy", DAYS[1]) is None
    assert loaded.families == manifest.families


def test_set_replaces_a_days_fingerprint() -> None:
    manifest = Manifest()
    manifest.set("exit-policy", DAYS[0], "old")

    manifest.set("exit-policy", DAYS[0], "new")

    assert manifest.get("exit-policy", DAYS[0]) == "new"
    assert manifest.get("flow-timing", DAYS[0]) is None


def test_saving_is_one_put_of_the_manifest_key(rig: Rig, settings: Settings) -> None:
    manifest = Manifest()
    manifest.set("chains", DAYS[0], "e|v1")
    store = ResearchStore(settings)
    rig.api_calls.clear()

    manifest.save(store)

    assert [(op, p["Key"]) for op, p in rig.api_calls if op == "PutObject"] == [
        ("PutObject", MANIFEST_KEY)
    ]


BAD_MANIFESTS: dict[str, bytes] = {
    "not json": b"{oops",
    "not utf-8": b"\xff\xfe\x00",
    "a list": b"[]",
    "a number": b"7",
    "no version": json.dumps({"families": {}}).encode(),
    "version 2": json.dumps({"version": 2, "families": {}}).encode(),
    "version true": json.dumps({"version": True, "families": {}}).encode(),
    "no families": json.dumps({"version": 1}).encode(),
    "families a list": json.dumps({"version": 1, "families": []}).encode(),
    "an extra top-level key": json.dumps({"version": 1, "families": {}, "x": 1}).encode(),
    "an unknown family": json.dumps({"version": 1, "families": {"whale": {}}}).encode(),
    "a family that is a list": json.dumps({"version": 1, "families": {"chains": []}}).encode(),
    "a day that is not a date": json.dumps(
        {"version": 1, "families": {"chains": {"yesterday": "a|v1"}}}
    ).encode(),
    "a day not spelled as isoformat": json.dumps(
        {"version": 1, "families": {"chains": {"20261105": "a|v1"}}}
    ).encode(),
    "a fingerprint that is not text": json.dumps(
        {"version": 1, "families": {"chains": {"2026-11-05": 5}}}
    ).encode(),
    "an empty fingerprint": json.dumps(
        {"version": 1, "families": {"chains": {"2026-11-05": ""}}}
    ).encode(),
}


@pytest.mark.parametrize("body", BAD_MANIFESTS.values(), ids=BAD_MANIFESTS.keys())
def test_a_malformed_manifest_raises_manifest_error_naming_the_key(
    rig: Rig, settings: Settings, body: bytes
) -> None:
    rig.put_manifest(body)

    with pytest.raises(ManifestError, match=MANIFEST_KEY):
        Manifest.load(ResearchStore(settings))


def test_a_manifest_the_store_cannot_read_is_not_a_manifest_error(
    rig: Rig, settings: Settings
) -> None:
    denied = ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
    store = ResearchStore(settings)
    with (
        patch.object(ResearchStore, "get_json", side_effect=denied),
        pytest.raises(ClientError, match="AccessDenied"),
    ):
        Manifest.load(store)


# --- targets, stale_days and fresh_days --------------------------------------------------


def test_targets_cover_landed_days_in_each_familys_range(rig: Rig) -> None:
    before_chains = _eod_flow.CHAINS_START.replace(day=10)  # 2026-04-10: fires, no chains
    after = LAST_SESSION.replace(day=12)
    landed = {before_chains: "ea", DAYS[0]: "eb", LAST_SESSION: "ec", after: "ed"}
    for family in FIRE_FAMILIES:
        rig.precheck[family] = {
            before_chains: fires_frame(before_chains),
            DAYS[0]: fires_frame(DAYS[0]),
            DAYS[1]: fires_frame(DAYS[1]),  # fires, but the tape has not landed
            after: fires_frame(after),  # landed, but after the last session
        }
    # LAST_SESSION is landed and has no fires: only chains cover it.

    result = targets(rig.conn, landed, LAST_SESSION)

    version = research_derive.CHAINS_VERSION
    assert set(result) == set(FAMILIES)
    assert result["chains"] == {DAYS[0]: f"eb|v{version}", LAST_SESSION: f"ec|v{version}"}
    for family in FIRE_FAMILIES:
        script = SCRIPTS[family]
        digest = {d: script.fingerprint_rows(fires_frame(d)) for d in (before_chains, DAYS[0])}
        assert result[family] == {
            before_chains: f"ea|v{script.DERIVE_VERSION}|{digest[before_chains]}",
            DAYS[0]: f"eb|v{script.DERIVE_VERSION}|{digest[DAYS[0]]}",
        }
        rig.day_fingerprints[family].assert_called_once_with(rig.conn)


def test_each_family_keeps_its_own_scripts_derive_version(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(exit_policy_search, "DERIVE_VERSION", 7)
    monkeypatch.setattr(flow_inversion_timing, "DERIVE_VERSION", 9)

    result = targets(rig.conn, {DAYS[0]: "e"}, LAST_SESSION)

    assert result["exit-policy"][DAYS[0]].startswith("e|v7|")
    assert result["flow-timing"][DAYS[0]].startswith("e|v9|")


def _targets(**families: dict[date, str]) -> dict[str, dict[date, str]]:
    return {family: families.get(family.replace("-", "_"), {}) for family in FAMILIES}


def test_stale_days_lists_each_day_with_its_stale_families_newest_first() -> None:
    manifest = Manifest()
    manifest.set("chains", DAYS[0], "c0")  # fresh
    manifest.set("exit-policy", DAYS[0], "old")  # stale
    manifest.set("chains", DAYS[1], "c1")
    manifest.set("exit-policy", DAYS[1], "x1")
    manifest.set("flow-timing", DAYS[1], "t1")  # the whole of day 1 is fresh
    wanted = _targets(
        chains={DAYS[0]: "c0", DAYS[1]: "c1", DAYS[2]: "c2"},
        exit_policy={DAYS[0]: "x0", DAYS[1]: "x1"},
        flow_timing={DAYS[1]: "t1", DAYS[2]: "t2"},
    )

    result = stale_days(manifest, wanted)

    assert list(result.items()) == [
        (DAYS[2], ("chains", "flow-timing")),
        (DAYS[0], ("exit-policy",)),
    ]


def test_a_seed_entry_is_fresh_for_chains_only() -> None:
    manifest = Manifest()
    for family in FAMILIES:
        manifest.set(family, DAYS[0], SEED)
    wanted = _targets(
        chains={DAYS[0]: "anything|v1"},
        exit_policy={DAYS[0]: "x"},
        flow_timing={DAYS[0]: "t"},
    )

    assert stale_days(manifest, wanted) == {DAYS[0]: ("exit-policy", "flow-timing")}
    assert fresh_days(manifest, wanted, "chains") == [DAYS[0]]
    assert fresh_days(manifest, wanted, "exit-policy") == []
    assert fresh_days(manifest, wanted, "flow-timing") == []


def test_fresh_days_are_the_matching_days_oldest_first() -> None:
    manifest = Manifest()
    manifest.set("flow-timing", DAYS[2], "t2")
    manifest.set("flow-timing", DAYS[0], "t0")
    manifest.set("flow-timing", DAYS[1], "stale")
    wanted = _targets(flow_timing={DAYS[0]: "t0", DAYS[1]: "t1", DAYS[2]: "t2", DAYS[3]: "t3"})

    assert fresh_days(manifest, wanted, "flow-timing") == [DAYS[0], DAYS[2]]


def test_a_manifest_day_outside_the_targets_is_neither_fresh_nor_stale() -> None:
    manifest = Manifest()
    manifest.set("chains", DAYS[0], "c0")
    wanted = _targets(chains={DAYS[1]: "c1"})

    assert fresh_days(manifest, wanted, "chains") == []
    assert stale_days(manifest, wanted) == {DAYS[1]: ("chains",)}


# --- the day loop ------------------------------------------------------------------------


def test_derives_stale_days_newest_first_with_one_fetch_each(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    result = rig.run(_ctx(settings, clock))

    assert rig.reader.fetch_day.call_args_list == [
        call(day, deadline=clock.now + FETCH_DEADLINE_SECONDS) for day in NEWEST_FIRST
    ]
    assert rig.reader.release.call_args_list == [call(day) for day in NEWEST_FIRST]
    for step_events in ("chains", "derive exit-policy", "derive flow-timing"):
        assert _isos(rig.events, step_events) == [d.isoformat() for d in NEWEST_FIRST]
    assert result.status == "ok"
    assert result.detail == ""
    assert dict(result.counts) == _full_counts(5)
    expected_keys = sorted([MANIFEST_KEY] + [FAMILY_KEYS[f](day) for f in FAMILIES for day in DAYS])
    assert rig.research_keys() == expected_keys
    assert rig.manifest() == rig.expected_manifest(DAYS)


def test_the_objects_hold_what_the_families_built(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    day = DAYS[2]
    assert rig.object_bytes(_chains_key(day)) == f"chains {day}".encode()
    for family, key in (("exit-policy", _exit_key(day)), ("flow-timing", _timing_key(day))):
        frame = rig.object_frame(key)
        assert tuple(frame.columns) == SCRIPTS[family].DERIVED_COLUMNS
        assert len(frame) == DERIVED_ROWS[family]
        assert dict(frame.dtypes.astype(str)) == {
            column: "int64" if column == "id" else "float64" for column in frame.columns
        }


def test_each_object_is_stored_before_the_manifest_and_the_manifest_is_saved_once_a_day(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    expected: list[str] = []
    for day in NEWEST_FIRST:
        expected += [_chains_key(day), _exit_key(day), _timing_key(day), MANIFEST_KEY]
    assert rig.puts() == expected


def test_the_work_files_are_removed_as_each_day_ends(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    assert list(rig.work.iterdir()) == []


def test_no_stale_days_opens_no_reader_and_no_day_connection(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))
    rig.events.clear()

    result = rig.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert dict(result.counts) == _full_counts(0)
    assert rig.events == ["connect", "close"]  # the setup connection alone
    assert rig.puts() == []


def test_a_day_runs_in_the_order_fetch_chains_then_the_connection(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))
    rig.events.clear()
    rig.land(DAYS[3], generation=1)

    rig.run(_ctx(settings, clock))

    day = DAYS[3]
    assert rig.events == [
        "connect",  # the setup connection: the targets
        "close",
        "open_reader",
        f"fetch {day}",
        f"chains {day}",
        "connect",  # the day's: opened after the download and the chains
        f"fires exit-policy {day}",
        f"derive exit-policy {day}",
        f"fires flow-timing {day}",
        f"derive flow-timing {day}",
        "close",
        f"release {day}",
    ]


def test_a_chains_only_day_opens_no_day_connection(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))
    rig.events.clear()
    rig.land(DAYS[0], generation=1)  # the tape changed, so chains are stale
    for family in FIRE_FAMILIES:
        rig.precheck[family].pop(DAYS[0])  # and the day has no fires to derive

    result = rig.run(_ctx(settings, clock))

    assert dict(result.counts) == _full_counts(
        1, exit_policy_written=0, flow_timing_written=0, rows_written=CHAINS_ROWS
    )
    assert rig.events == [
        "connect",
        "close",
        "open_reader",
        f"fetch {DAYS[0]}",
        f"chains {DAYS[0]}",
        f"release {DAYS[0]}",
    ]


def test_seeded_chains_are_never_rebuilt(rig: Rig, settings: Settings, clock: Clock) -> None:
    seeded = [DAYS[0], DAYS[1]]
    rig.put_manifest({"version": 1, "families": {"chains": {d.isoformat(): SEED for d in seeded}}})
    rig.land(DAYS[0], generation=3)  # the tape changed since the seed: still not rebuilt

    result = rig.run(_ctx(settings, clock))

    assert _isos(rig.events, "chains") == [d.isoformat() for d in NEWEST_FIRST if d not in seeded]
    assert _isos(rig.events, "derive exit-policy") == [d.isoformat() for d in NEWEST_FIRST]
    assert result.counts["chains_written"] == 3
    assert result.counts["days_planned"] == 5  # the fire families still wait on those two days
    for day in seeded:
        assert _chains_key(day) not in rig.research_keys()
    manifest = rig.manifest() or {}
    assert [manifest["families"]["chains"][d.isoformat()] for d in seeded] == [SEED, SEED]
    assert manifest["families"]["exit-policy"][DAYS[0].isoformat()] == rig.target(
        "exit-policy", DAYS[0]
    )


def test_a_seed_in_a_fire_family_is_stale_and_rederived(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.put_manifest({"version": 1, "families": {"exit-policy": {DAYS[1].isoformat(): SEED}}})

    result = rig.run(_ctx(settings, clock))

    assert DAYS[1].isoformat() in _isos(rig.events, "derive exit-policy")
    assert (rig.manifest() or {})["families"]["exit-policy"][DAYS[1].isoformat()] == rig.target(
        "exit-policy", DAYS[1]
    )
    assert result.counts["exit_policy_written"] == 5


def test_etag_change_rebuilds_chains_and_both_fire_families(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))
    before = rig.manifest() or {}
    rig.events.clear()
    day = DAYS[2]
    rig.land(day, generation=1)  # UW re-landed one day

    result = rig.run(_ctx(settings, clock))

    assert dict(result.counts) == _full_counts(1)
    assert _isos(rig.events, "fetch") == [str(day)]
    assert _isos(rig.events, "chains") == [str(day)]
    assert _isos(rig.events, "derive exit-policy") == [str(day)]
    assert _isos(rig.events, "derive flow-timing") == [str(day)]
    assert rig.puts() == [_chains_key(day), _exit_key(day), _timing_key(day), MANIFEST_KEY]
    after = rig.manifest() or {}
    assert after == rig.expected_manifest(DAYS)
    iso = day.isoformat()
    for family in FAMILIES:
        assert after["families"][family][iso] != before["families"][family][iso]


def test_fingerprint_change_rederives_only_that_family(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))
    before = rig.manifest() or {}
    rig.events.clear()
    day = DAYS[3]
    rig.set_fires("flow-timing", day, fires_frame(day, n=3))  # a fire got its inversion

    result = rig.run(_ctx(settings, clock))

    assert dict(result.counts) == _full_counts(
        1,
        chains_written=0,
        exit_policy_written=0,
        rows_written=DERIVED_ROWS["flow-timing"],
    )
    assert [e for e in rig.events if e.startswith(("chains", "derive", "fires"))] == [
        f"fires flow-timing {day}",
        f"derive flow-timing {day}",
    ]
    assert rig.puts() == [_timing_key(day), MANIFEST_KEY]
    after = rig.manifest() or {}
    assert after == rig.expected_manifest(DAYS)
    changed = [
        (family, d)
        for family in FAMILIES
        for d in DAYS
        if after["families"][family][d.isoformat()] != before["families"][family][d.isoformat()]
    ]
    assert changed == [("flow-timing", day)]


@pytest.mark.parametrize("family", FIRE_FAMILIES)
def test_a_derive_version_bump_rederives_that_family_on_every_day(
    rig: Rig, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch, family: str
) -> None:
    rig.run(_ctx(settings, clock))
    rig.events.clear()
    monkeypatch.setattr(SCRIPTS[family], "DERIVE_VERSION", 2)
    other = next(f for f in FIRE_FAMILIES if f != family)

    result = rig.run(_ctx(settings, clock))

    assert result.counts["days_planned"] == 5
    assert _isos(rig.events, f"derive {family}") == [d.isoformat() for d in NEWEST_FIRST]
    assert _isos(rig.events, f"derive {other}") == []
    assert _isos(rig.events, "chains") == []
    stored = rig.manifest() or {}
    assert all("|v2|" in fp for fp in stored["families"][family].values())
    assert all("|v1|" in fp for fp in stored["families"][other].values())


def test_a_chains_version_bump_rebuilds_chains_only(
    rig: Rig, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig.run(_ctx(settings, clock))
    rig.events.clear()
    monkeypatch.setattr(research_derive, "CHAINS_VERSION", 2)

    result = rig.run(_ctx(settings, clock))

    assert result.counts["chains_written"] == 5
    assert result.counts["exit_policy_written"] == 0
    assert _isos(rig.events, "chains") == [d.isoformat() for d in NEWEST_FIRST]
    assert _isos(rig.events, "derive exit-policy") == []
    assert all(fp.endswith("|v2") for fp in (rig.manifest() or {})["families"]["chains"].values())


def test_empty_derive_is_recorded_and_not_redone(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    day = DAYS[0]
    rig.chain_rows[day] = 0
    for family in FIRE_FAMILIES:
        rig.derived_n[family][day] = 0

    first = rig.run(_ctx(settings, clock))

    assert first.status == "ok"
    for family, key in (("exit-policy", _exit_key(day)), ("flow-timing", _timing_key(day))):
        frame = rig.object_frame(key)
        assert len(frame) == 0
        assert tuple(frame.columns) == SCRIPTS[family].DERIVED_COLUMNS
    assert _chains_key(day) in rig.research_keys()
    assert (rig.manifest() or {}) == rig.expected_manifest(DAYS)
    assert first.counts["rows_written"] == 4 * DAY_ROWS  # the empty day adds none
    rig.events.clear()

    second = rig.run(_ctx(settings, clock))

    assert dict(second.counts) == _full_counts(0)
    assert _isos(rig.events, "fetch") == []
    assert rig.puts() == []


def test_a_tape_missing_from_r2_counts_and_is_not_a_failure(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    rig.missing_tape.add(DAYS[3])

    result = rig.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert dict(result.counts) == _full_counts(
        5,
        days_derived=4,
        days_tape_missing=1,
        chains_written=4,
        exit_policy_written=4,
        flow_timing_written=4,
        rows_written=4 * DAY_ROWS,
    )
    assert (rig.manifest() or {})["families"]["chains"].keys() == {
        d.isoformat() for d in DAYS if d != DAYS[3]
    }
    assert rig.reader.release.call_count == 5  # the missing day's too
    capture_exception.assert_not_called()


def test_stored_fp_comes_from_the_rows_used(rig: Rig, settings: Settings, clock: Clock) -> None:
    day = DAYS[4]
    other = fires_frame(day, n=7)  # the day's fires changed after the pre-check hashed them
    rig.serve("exit-policy", day, other)

    result = rig.run(_ctx(settings, clock))

    assert result.status == "ok"
    stored = (rig.manifest() or {})["families"]["exit-policy"][day.isoformat()]
    version = exit_policy_search.DERIVE_VERSION
    assert stored == f"{rig.etag(day)}|v{version}|{exit_policy_search.fingerprint_rows(other)}"
    assert stored != rig.target("exit-policy", day)
    derive_call = next(
        c for c in rig.derive["exit-policy"].call_args_list if _day_of(c.args[0]) == day
    )
    assert derive_call.args[1] is other  # the same rows went to derive_day and to the hash
    # The pre-check still sees other rows, so that family of that day is stale again, once.
    again = rig.run(_ctx(settings, clock))
    assert dict(again.counts) == _full_counts(
        1, chains_written=0, flow_timing_written=0, rows_written=DERIVED_ROWS["exit-policy"]
    )


def test_each_family_calls_its_scripts_derive_with_its_own_arguments(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    day = DAYS[1]
    path = Path(f"/cache/{day}-fulltape.parquet")
    exit_call = next(
        c for c in rig.derive["exit-policy"].call_args_list if _day_of(c.args[0]) == day
    )
    assert len(exit_call.args) == 2
    assert not exit_call.kwargs
    assert exit_call.args[0] == path
    assert exit_call.args[1] is rig.served["exit-policy"][day]
    timing_call = next(c for c in rig.derive["flow-timing"].call_args_list if c.args[1] == day)
    assert len(timing_call.args) == 4
    assert not timing_call.kwargs
    assert timing_call.args[0] is rig.conn
    assert timing_call.args[2] == path
    assert timing_call.args[3] is rig.served["flow-timing"][day]
    for family in FIRE_FAMILIES:
        fires_call = next(c for c in rig.fires[family].call_args_list if c.args[1] == day)
        assert fires_call.args[0] is rig.conn


def test_the_stored_derived_files_are_what_the_scripts_load_derived_reads(
    rig: Rig, settings: Settings, clock: Clock, tmp_path: Path
) -> None:
    rig.run(_ctx(settings, clock))

    day = DAYS[3]
    for family, key in (("exit-policy", _exit_key(day)), ("flow-timing", _timing_key(day))):
        folder = tmp_path / family
        folder.mkdir()
        (folder / f"{day.isoformat()}.parquet").write_bytes(rig.object_bytes(key))
        loaded, missing = SCRIPTS[family].load_derived(folder, [day.isoformat()])
        assert missing == []
        assert len(loaded) == DERIVED_ROWS[family]
        assert tuple(loaded.columns) == SCRIPTS[family].DERIVED_COLUMNS


def test_a_real_tape_day_becomes_a_chains_object(
    rig: Rig, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The real builder, on a one-print tape: the call's arguments, the work directory as the
    # DuckDB spill directory, and the file the step stores.
    tape = tmp_path / "tape.parquet"
    pd.DataFrame(
        [
            {
                "id": 1,
                "option_chain_id": "AAPL261113C00200000",
                "underlying_symbol": "AAPL",
                "executed_at": pd.Timestamp("2026-11-11T14:35:00", tz="UTC"),
                "price": 2.5,
                "underlying_price": 200.0,
                "size": 100,
                "premium": 150_000.0,
                "strike": 200.0,
                "option_type": "call",
                "expiry": date(2026, 11, 13),
                "volume": 600,
                "open_interest": 100,
                "tags": "{ask_side,bullish}",
                "canceled": False,
            }
        ]
    ).to_parquet(tape, index=False)
    monkeypatch.setattr(research_derive, "build_chains", _eod_flow.build_chains)
    rig.reader.fetch_day.side_effect = lambda day, deadline=None: tape
    for family in FIRE_FAMILIES:
        rig.precheck[family].clear()  # chains only

    result = rig.run(_ctx(settings, clock))

    assert result.status == "ok"
    assert dict(result.counts) == _full_counts(
        5, exit_policy_written=0, flow_timing_written=0, rows_written=5
    )
    day = DAYS[3]
    chains = rig.object_frame(_chains_key(day))
    assert list(chains.columns) == [name for name, _ in _eod_flow.CHAINS_COLUMNS]
    assert chains["trade_date"].tolist() == [day.isoformat()]
    assert chains["ask_size"].tolist() == [100.0]
    assert list(rig.work.iterdir()) == []


def test_chains_are_built_from_the_fetched_tape_into_the_work_dir(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    day = DAYS[1]
    built = next(c for c in rig.build_chains.call_args_list if c.args[1] == day)
    assert len(built.args) == 3
    assert built.args[0] == Path(f"/cache/{day}-fulltape.parquet")
    assert rig.work in built.args[2].parents
    assert built.kwargs == {"temp_dir": rig.work}


# --- the deadline and the failure cap -----------------------------------------------------


def test_deadline_leaves_days_as_partial(rig: Rig, settings: Settings, clock: Clock) -> None:
    # Room for two days: after the second, less than a day's budget is left.
    ctx = _ctx(settings, clock, left=2 * RESEARCH_DAY_BUDGET_SECONDS + 1)
    rig.build_chains.side_effect = _advancing(rig, clock, RESEARCH_DAY_BUDGET_SECONDS)

    result = rig.run(ctx)

    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    assert dict(result.counts) == _full_counts(
        5,
        days_derived=2,
        days_left=3,  # the three oldest days, tomorrow's work
        chains_written=2,
        exit_policy_written=2,
        flow_timing_written=2,
        rows_written=2 * DAY_ROWS,
    )
    assert rig.reader.fetch_day.call_count == 2
    assert rig.manifest() == rig.expected_manifest(NEWEST_FIRST[:2])


def test_a_day_starts_with_exactly_its_budget_left(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    for day in DAYS[1:]:
        rig.unland(day)

    result = rig.run(_ctx(settings, clock, left=RESEARCH_DAY_BUDGET_SECONDS))

    assert result.counts["days_derived"] == 1
    assert result.counts["days_left"] == 0


def test_a_day_does_not_start_without_its_budget(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    result = rig.run(_ctx(settings, clock, left=RESEARCH_DAY_BUDGET_SECONDS - 1))

    rig.reader.fetch_day.assert_not_called()
    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    assert result.counts["days_left"] == 5
    assert result.counts["days_derived"] == 0
    assert rig.manifest() is None  # nothing derived, so nothing saved


def test_a_download_is_bounded_by_the_readers_deadline_from_now(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    # The day budget assumes a download of at most FETCH_DEADLINE_SECONDS: a step deadline
    # hours away must not let one slow download spend all of it.
    rig.build_chains.side_effect = _advancing(rig, clock, 100)
    ctx = _ctx(settings, clock, left=50_000)
    started = clock.now

    rig.run(ctx)

    # "Now" is read for each day, on the clock the step's own deadline is on.
    assert [c.kwargs["deadline"] for c in rig.reader.fetch_day.call_args_list[:2]] == [
        started + FETCH_DEADLINE_SECONDS,
        started + 100 + FETCH_DEADLINE_SECONDS,
    ]
    assert started + 100 + FETCH_DEADLINE_SECONDS < ctx.deadline


def test_a_download_never_outlasts_the_step_deadline(
    rig: Rig, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With the real budget a day starts with more than FETCH_DEADLINE_SECONDS left, so the
    # step's own deadline is the nearer one only if the budget is smaller than that.
    monkeypatch.setattr(research_derive, "RESEARCH_DAY_BUDGET_SECONDS", 100)
    for day in DAYS[1:]:
        rig.unland(day)
    ctx = _ctx(settings, clock, left=FETCH_DEADLINE_SECONDS - 100)

    rig.run(ctx)

    rig.reader.fetch_day.assert_called_once_with(DAYS[0], deadline=ctx.deadline)


def test_day_failures_isolated_capped_at_three_and_captured_with_day_tag(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    assert RESEARCH_MAX_DAY_FAILURES == 3
    failures = {d: RuntimeError(f"row 7 of ep-x.neon.tech {d}") for d in DAYS}
    rig.fetch_errors.update(failures)

    result = rig.run(_ctx(settings, clock))

    assert rig.reader.fetch_day.call_count == 3  # not 5: a broken night costs three downloads
    assert [c.args[0] for c in capture_exception.call_args_list] == [
        failures[d] for d in NEWEST_FIRST[:3]
    ]
    assert [c.kwargs for c in capture_exception.call_args_list] == [
        {"tags": {"step": STEP_NAME, "day": d.isoformat()}} for d in NEWEST_FIRST[:3]
    ]
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert dict(result.counts) == _full_counts(
        5,
        days_derived=0,
        days_failed=3,
        days_left=2,
        chains_written=0,
        exit_policy_written=0,
        flow_timing_written=0,
        rows_written=0,
    )
    assert rig.reader.release.call_count == 3
    assert rig.manifest() is None


def test_failures_that_are_not_consecutive_count_toward_the_same_cap(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    for position in (0, 2, 3):
        rig.fetch_errors[NEWEST_FIRST[position]] = RuntimeError(str(position))

    result = rig.run(_ctx(settings, clock))

    assert result.counts["days_failed"] == 3
    assert result.counts["days_derived"] == 1
    assert result.counts["days_left"] == 1


def test_a_failing_day_does_not_stop_the_others(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    failure = ValueError("row 7 of ep-x.neon.tech")
    rig.derive_errors[("exit-policy", DAYS[3])] = failure

    result = rig.run(_ctx(settings, clock))

    assert _isos(rig.events, "fetch") == [str(d) for d in NEWEST_FIRST]
    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["days_failed"] == 1
    assert result.counts["days_derived"] == 4
    assert result.counts["days_left"] == 0
    capture_exception.assert_called_once_with(
        failure, tags={"step": STEP_NAME, "day": DAYS[3].isoformat()}
    )
    assert (rig.manifest() or {}) == rig.expected_manifest([d for d in DAYS if d != DAYS[3]])


def test_manifest_survives_a_failure_mid_run(rig: Rig, settings: Settings, clock: Clock) -> None:
    # A killed run: SIGTERM raises SystemExit, which is no Exception, so the loop cannot catch it.
    third = NEWEST_FIRST[2]
    rig.fetch_errors[third] = SystemExit(143)

    with pytest.raises(SystemExit):
        rig.run(_ctx(settings, clock))

    assert (rig.manifest() or {}) == rig.expected_manifest(NEWEST_FIRST[:2])
    assert rig.reader.release.call_args_list == [call(d) for d in NEWEST_FIRST[:3]]
    assert list(rig.work.iterdir()) == []
    assert _chains_key(third) not in rig.research_keys()


def test_a_failed_day_leaves_the_other_days_in_the_saved_manifest(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    third = NEWEST_FIRST[2]
    rig.fetch_errors[third] = TapeReadError("fetch failed")

    result = rig.run(_ctx(settings, clock))

    assert result.status == "failed"
    saved = rig.manifest() or {}
    assert saved == rig.expected_manifest([d for d in DAYS if d != third])
    assert all(third.isoformat() not in days for days in saved["families"].values())


@pytest.mark.parametrize("stage", ["chains", "fires", "derive", "connect", "put"])
def test_a_failure_at_each_stage_fails_that_day_and_records_nothing_of_it(
    rig: Rig,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
    stage: str,
) -> None:
    day = NEWEST_FIRST[0]
    boom = RuntimeError(f"{stage} broke")
    if stage == "chains":
        rig.chains_errors[day] = boom
    elif stage == "fires":
        rig.fires_errors[("exit-policy", day)] = boom
    elif stage == "derive":
        rig.derive_errors[("flow-timing", day)] = boom
    elif stage == "connect":
        original_connect = rig.connect.side_effect

        def failing_connect(settings_arg: Settings) -> Any:
            if rig.connect.call_count == 2:  # the first day's: the setup's was the first
                raise boom
            return original_connect(settings_arg)

        rig.connect.side_effect = failing_connect
    else:
        real_put = ResearchStore.put_file

        def failing_put(self: ResearchStore, key: str, path: Path) -> int:
            if key == _exit_key(day):
                raise R2VerifyError(f"{key}: could not verify 5 uploaded bytes")
            return real_put(self, key, path)

        monkeypatch.setattr(ResearchStore, "put_file", failing_put)

    result = rig.run(_ctx(settings, clock))

    assert result.status == "failed"
    assert result.detail == FAILED_DETAIL
    assert result.counts["days_failed"] == 1
    assert result.counts["days_derived"] == 4
    assert [c.kwargs for c in capture_exception.call_args_list] == [
        {"tags": {"step": STEP_NAME, "day": day.isoformat()}}
    ]
    assert rig.reader.release.call_args_list[0] == call(day)  # released whatever went wrong
    assert (rig.manifest() or {}) == rig.expected_manifest([d for d in DAYS if d != day])
    assert list(rig.work.iterdir()) == []  # the work files go, finished or not


def test_objects_stored_before_a_failure_still_count(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    # They are in R2, whatever happened after them; the day is not derived and is not recorded.
    day = NEWEST_FIRST[0]
    rig.derive_errors[("flow-timing", day)] = RuntimeError("boom")

    result = rig.run(_ctx(settings, clock))

    assert dict(result.counts) == _full_counts(
        5,
        days_derived=4,
        days_failed=1,
        flow_timing_written=4,
        rows_written=4 * DAY_ROWS + CHAINS_ROWS + DERIVED_ROWS["exit-policy"],
    )
    assert {_chains_key(day), _exit_key(day)} <= set(rig.research_keys())
    assert _timing_key(day) not in rig.research_keys()


def test_a_save_that_fails_once_fails_its_day_and_a_later_save_still_records_it(
    rig: Rig,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The day's objects are in R2 and its fingerprints are right, so the next day's save
    # carries them; the failure is still counted and reported.
    real_put_json = ResearchStore.put_json
    attempts: list[str] = []

    def failing_once(self: ResearchStore, key: str, obj: object) -> None:
        attempts.append(key)
        if len(attempts) == 1:
            raise ClientError({"Error": {"Code": "InternalError"}}, "PutObject")
        real_put_json(self, key, obj)

    monkeypatch.setattr(ResearchStore, "put_json", failing_once)

    result = rig.run(_ctx(settings, clock))

    assert result.status == "failed"
    assert result.counts["days_failed"] == 1
    assert result.counts["days_derived"] == 4
    assert capture_exception.call_count == 1
    assert (rig.manifest() or {}) == rig.expected_manifest(DAYS)


def test_a_manifest_that_will_not_save_fails_every_day_up_to_the_cap(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    denied = ClientError({"Error": {"Code": "AccessDenied"}}, "PutObject")
    with patch.object(ResearchStore, "put_json", side_effect=denied):
        result = rig.run(_ctx(settings, clock))

    assert result.status == "failed"
    assert result.counts["days_failed"] == 3
    assert result.counts["days_derived"] == 0
    assert result.counts["days_left"] == 2
    assert rig.manifest() is None
    assert capture_exception.call_count == 3


# --- setup failures ----------------------------------------------------------------------


def test_malformed_manifest_fails_without_resetting(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    body = b'{"version": 1, "families": {"chains": {"2026-11-05": 12}}}'
    rig.put_manifest(body)

    result = rig.run(_ctx(settings, clock))

    assert result.status == "failed"
    assert result.detail == MANIFEST_DETAIL
    assert dict(result.counts) == _full_counts(0)
    assert rig.puts() == []  # not even a reset
    assert rig.manifest_bytes() == body
    rig.connect.assert_not_called()
    rig.open_reader.assert_not_called()
    rig.reader.fetch_day.assert_not_called()
    assert rig.research_keys() == [MANIFEST_KEY]
    capture_exception.assert_not_called()  # the failed result is what run_steps reports


def test_a_manifest_that_is_not_json_fails_the_step_too(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.put_manifest(b"<html>")

    result = rig.run(_ctx(settings, clock))

    assert (result.status, result.detail) == ("failed", MANIFEST_DETAIL)
    assert rig.puts() == []


@pytest.mark.parametrize("stage", ["manifest", "listing", "connect", "fingerprints", "reader"])
def test_a_setup_failure_propagates_for_the_runner_to_report(
    rig: Rig, settings: Settings, clock: Clock, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    boom: Exception = ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
    if stage == "manifest":
        monkeypatch.setattr(ResearchStore, "get_json", MagicMock(side_effect=boom))
    elif stage == "listing":
        monkeypatch.setattr(R2Store, "tape_etags", MagicMock(side_effect=boom))
    elif stage == "connect":
        boom = psycopg2.OperationalError("connection to ep-x.neon.tech failed")
        rig.connect.side_effect = boom
    elif stage == "fingerprints":
        boom = psycopg2.OperationalError("statement timeout")
        rig.day_fingerprints["flow-timing"].side_effect = boom
    else:
        boom = TapeReadError("could not build the R2 client")
        rig.open_reader.side_effect = boom

    with pytest.raises(type(boom)) as raised:
        rig.run(_ctx(settings, clock))

    assert raised.value is boom
    assert rig.puts() == []
    rig.reader.fetch_day.assert_not_called()


# --- the status, the counts and the logs --------------------------------------------------


def test_latest_session_not_landed_is_partial(rig: Rig, settings: Settings, clock: Clock) -> None:
    rig.unland(LAST_SESSION)

    result = rig.run(_ctx(settings, clock))

    assert result.status == "partial"
    assert result.detail == NOT_LANDED_DETAIL
    assert dict(result.counts) == _full_counts(4)  # the other four days are derived
    assert (rig.manifest() or {}) == rig.expected_manifest(DAYS[:4])


def test_days_left_is_the_detail_when_the_last_session_is_also_missing(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.unland(LAST_SESSION)

    result = rig.run(_ctx(settings, clock, left=RESEARCH_DAY_BUDGET_SECONDS - 1))

    assert (result.status, result.detail) == ("partial", PARTIAL_DETAIL)


def test_a_failed_day_outranks_partial(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    rig.unland(LAST_SESSION)
    rig.fetch_errors[DAYS[3]] = RuntimeError("x")

    result = rig.run(_ctx(settings, clock))

    assert (result.status, result.detail) == ("failed", FAILED_DETAIL)


def test_a_fully_derived_night_with_the_last_session_landed_is_ok(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    result = rig.run(_ctx(settings, clock))

    assert (result.status, result.detail) == ("ok", "")


def test_no_landed_tape_at_all_is_partial_and_writes_nothing(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    for day in DAYS:
        rig.unland(day)

    result = rig.run(_ctx(settings, clock))

    assert (result.status, result.detail) == ("partial", NOT_LANDED_DETAIL)
    assert dict(result.counts) == _full_counts(0)
    assert rig.puts() == []


def test_only_fulltape_and_research_prefixes_are_listed(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    # Objects of the other jobs share the bucket; the step must not so much as name them.
    rig.s3.put_object(Bucket=BUCKET, Key="gexbot-eod/SPX/2026-11-05.zip", Body=b"zip")
    rig.s3.put_object(Bucket=BUCKET, Key="backups/strike_exposures/2026-11-05.parquet", Body=b"p")
    rig.put_manifest({"version": 1, "families": {}})

    rig.run(_ctx(settings, clock))

    touched = [
        (op, params.get("Prefix") or params.get("Key"))
        for op, params in rig.calls
        if params.get("Bucket") == BUCKET
    ]
    assert ("ListObjectsV2", "fulltape/") in touched
    assert ("GetObject", MANIFEST_KEY) in touched
    assert all(str(name).startswith(("fulltape/", "research/")) for _, name in touched), touched
    # Only the tape listing reaches the tape prefix: no tape object is read, written or deleted.
    assert [op for op, name in touched if str(name).startswith("fulltape/")] == ["ListObjectsV2"]
    assert rig.object_bytes("gexbot-eod/SPX/2026-11-05.zip") == b"zip"


@pytest.mark.parametrize("scenario", ["ok", "failed-day", "left", "not-landed", "manifest"])
def test_counts_are_ints_and_detail_is_fixed(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock, scenario: str
) -> None:
    left = 100_000.0
    status, detail = "ok", ""
    if scenario == "failed-day":
        rig.fetch_errors[DAYS[1]] = RuntimeError("row 7 of ep-x.neon.tech")
        status, detail = "failed", FAILED_DETAIL
    elif scenario == "left":
        left = RESEARCH_DAY_BUDGET_SECONDS + 50
        rig.build_chains.side_effect = _advancing(rig, clock, 100)
        status, detail = "partial", PARTIAL_DETAIL
    elif scenario == "not-landed":
        rig.unland(LAST_SESSION)
        status, detail = "partial", NOT_LANDED_DETAIL
    elif scenario == "manifest":
        rig.put_manifest(b"[]")
        status, detail = "failed", MANIFEST_DETAIL

    outcomes = run_steps(
        [Step(STEP_NAME, research_derive.run, RESEARCH_DAY_BUDGET_SECONDS)],
        settings=settings,
        now_utc=NOW,
        last_session=LAST_SESSION,
        run_deadline=clock.now + left,
        tape=(),
        on_outcome=lambda _outcome: None,  # the returned outcomes are what is read
    )

    (outcome,) = outcomes
    assert outcome.error is None
    assert outcome.detail == detail  # not the runner's "invalid step result"
    assert outcome.status == status
    assert set(outcome.counts) == COUNT_NAMES
    assert all(type(n) is int and n >= 0 for n in outcome.counts.values())
    assert not any(ch.isdigit() for ch in outcome.detail)


def test_the_counts_add_up_to_the_days_planned(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    rig.missing_tape.add(DAYS[0])
    rig.fetch_errors[DAYS[2]] = RuntimeError("x")

    result = rig.run(_ctx(settings, clock))

    c = result.counts
    assert c["days_planned"] == 5
    assert c["days_planned"] == (
        c["days_derived"] + c["days_failed"] + c["days_tape_missing"] + c["days_left"]
    )


def test_one_log_line_per_day_names_the_date_families_rows_and_seconds(
    rig: Rig, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="research_derive"):
        rig.run(_ctx(settings, clock))

    lines = [r.getMessage() for r in caplog.records if r.name == "research_derive"]
    assert len(lines) == 5
    for line, day in zip(lines, NEWEST_FIRST, strict=True):
        assert day.isoformat() in line
        assert "chains,exit-policy,flow-timing" in line
        assert f"rows={DAY_ROWS}" in line
        assert " in " in line
        assert line.endswith("s")


def test_a_failed_day_is_logged_by_class_never_by_message(
    rig: Rig,
    settings: Settings,
    clock: Clock,
    capture_exception: MagicMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    rig.derive_errors[("exit-policy", DAYS[4])] = ValueError("row 7 of ep-x.neon.tech")

    with caplog.at_level(logging.INFO, logger="research_derive"):
        rig.run(_ctx(settings, clock))

    failed = [r for r in caplog.records if "failed" in r.getMessage()]
    assert len(failed) == 1
    assert failed[0].levelno == logging.WARNING
    assert "ValueError" in failed[0].getMessage()
    assert DAYS[4].isoformat() in failed[0].getMessage()
    assert "ep-x" not in caplog.text
    assert "row 7" not in caplog.text


def test_a_missing_tape_is_logged_as_a_warning(
    rig: Rig, settings: Settings, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    rig.missing_tape.add(DAYS[2])

    with caplog.at_level(logging.INFO, logger="research_derive"):
        rig.run(_ctx(settings, clock))

    missing = [r for r in caplog.records if "tape missing" in r.getMessage()]
    assert len(missing) == 1
    assert missing[0].levelno == logging.WARNING
    assert DAYS[2].isoformat() in missing[0].getMessage()


# --- the reader and its cache -------------------------------------------------------------


def test_cache_dir_is_the_research_tape_dir(rig: Rig, settings: Settings, clock: Clock) -> None:
    rig.run(_ctx(settings, clock))

    rig.open_reader.assert_called_once_with(settings, RESEARCH_TAPE_DIR)
    assert RESEARCH_TAPE_DIR != ENRICH_CACHE_DIR


def test_the_reader_is_opened_as_a_context_manager(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.run(_ctx(settings, clock))

    rig.reader.__enter__.assert_called_once_with()
    rig.reader.__exit__.assert_called_once()
    rig.reader.close.assert_not_called()  # the context manager closes it


def test_the_reader_closes_when_the_step_is_killed(
    rig: Rig, settings: Settings, clock: Clock
) -> None:
    rig.fetch_errors[NEWEST_FIRST[1]] = SystemExit(143)

    with pytest.raises(SystemExit):
        rig.run(_ctx(settings, clock))

    rig.reader.__exit__.assert_called_once()


def test_release_runs_even_when_a_derive_raises(
    rig: Rig, settings: Settings, clock: Clock, capture_exception: MagicMock
) -> None:
    rig.derive_errors[("flow-timing", DAYS[4])] = RuntimeError("boom")

    rig.run(_ctx(settings, clock))

    assert call(DAYS[4]) in rig.reader.release.call_args_list
