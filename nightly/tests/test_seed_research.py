"""Tests for the one-time seed of local research state into R2.

R2 is moto, behind the real ResearchStore and the real research_derive Manifest. The repo is a
fixture tree under tmp_path: one file per seed rule, plus decoys no rule may take. Nothing here
reaches a real bucket, a real database or a real checkout.
"""

from __future__ import annotations

import ast
import re
import runpy
import sys
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from unittest.mock import patch

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from moto import mock_aws

import seed_research
from config import Settings, load_settings
from r2_store import R2VerifyError
from research_derive import CHAINS_VERSION, FAMILY_KEYS, MANIFEST_KEY, SEED, Manifest, stale_days
from research_store import ResearchStore
from seed_research import SeedItem, SeedNameError, SeedResult, plan_seed, run_seed

BUCKET = "test-bucket"
BY_DAY = "scripts/eod-flow-analysis/output/by-day"
BY_DAY_PREFIX = "research/eod-flow/by-day/"
TRACKING_KEY = "research/lottery-tracking/state/lottery-tracking.csv"
CHAINS_DAYS = [date(2026, 4, 13), date(2026, 4, 14)]

# Every file the seed takes, in plan order (rule order, then name), with the key it lands on.
EXPECTED: dict[str, str] = {
    f"{BY_DAY}/2026-04-13-chains.parquet": "research/eod-flow/by-day/2026-04-13-chains.parquet",
    f"{BY_DAY}/2026-04-14-chains.parquet": "research/eod-flow/by-day/2026-04-14-chains.parquet",
    "docs/tmp/lottery-tracking.csv": TRACKING_KEY,
    "docs/tmp/lottery-exit-policy-search-2026-05-05.md": (
        "research/exit-policy/2026-05-05/lottery-exit-policy-search-2026-05-05.md"
    ),
    "docs/tmp/flow-inversion-timing-2026-05-06.md": (
        "research/flow-timing/2026-05-06/flow-inversion-timing-2026-05-06.md"
    ),
    "docs/tmp/lottery-feature-audit-2026-05-07.md": (
        "research/feature-audit/2026-05-07/lottery-feature-audit-2026-05-07.md"
    ),
    "docs/tmp/lottery-composite-candidates-2026-05-08.md": (
        "research/outcome-mining/2026-05-08/lottery-composite-candidates-2026-05-08.md"
    ),
    "docs/tmp/lottery-score-lineage-2026-05-09.md": (
        "research/score-lineage/2026-05-09/lottery-score-lineage-2026-05-09.md"
    ),
    "docs/tmp/lottery-quality-sim-2026-05-10.csv": (
        "research/quality-sim/2026-05-10/lottery-quality-sim-2026-05-10.csv"
    ),
    "docs/tmp/takeit-drift-2026-05-11.md": (
        "research/takeit-drift/2026-05-11/takeit-drift-2026-05-11.md"
    ),
    "ml/plots/takeit-drift/reliability_lottery_2026-05-29.png": (
        "research/takeit-drift/2026-05-29/reliability_lottery_2026-05-29.png"
    ),
    "ml/plots/takeit-drift/reliability_silent_boom_2026-05-29.png": (
        "research/takeit-drift/2026-05-29/reliability_silent_boom_2026-05-29.png"
    ),
}
# Files in the same folders that no rule takes.
DECOYS = [
    "docs/tmp/lottery-exit-analysis-2026-05-05.md",  # a stem no rule names
    "docs/tmp/lottery-quality-sim-2026-05-10.md",  # a rule's stem, the wrong extension
    "docs/tmp/notes.md",
    "ml/plots/takeit-drift/summary.png",
    f"{BY_DAY}/README.md",
    f"{BY_DAY}/2026-04-13-chains.csv",
]
# One listing per rule: the static part of each key template, in rule order.
RULE_PREFIXES = [
    "research/eod-flow/by-day/",
    TRACKING_KEY,
    "research/exit-policy/",
    "research/flow-timing/",
    "research/feature-audit/",
    "research/outcome-mining/",
    "research/score-lineage/",
    "research/quality-sim/",
    "research/takeit-drift/",
]
SECRET_ROW = "SECRET-ROW-0DTE-4242"


# --- fixtures and helpers ----------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_home(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """boto3 reads ~/.aws and may cache under the home dir; keep it off the real one."""
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def r2_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The environment `main` builds its settings from, pointed at moto."""
    # moto only intercepts AWS hostnames; a custom R2 endpoint would go out to the network.
    monkeypatch.setenv("R2_ENDPOINT_URL", "https://s3.amazonaws.com")
    monkeypatch.setenv("R2_BUCKET_FULLTAPE", BUCKET)


@pytest.fixture
def settings(r2_env: None) -> Settings:
    return load_settings()


@pytest.fixture
def s3(r2_env: None) -> Iterator[object]:
    """A raw moto-backed client with the bucket created, for seeding and inspecting."""
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


@pytest.fixture
def store(s3: object, settings: Settings) -> ResearchStore:
    return ResearchStore(settings)


def _write(root: Path, relative: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(f"{SECRET_ROW} body of {relative}".encode())
    return path


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    for relative in [*EXPECTED, *DECOYS]:
        _write(root, relative)
    # A directory whose name matches a rule is not a file to seed.
    (root / "docs/tmp/lottery-feature-audit-2026-05-12.md").mkdir()
    return root


def _body(s3, key: str) -> bytes:
    return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()


def _snapshot(s3) -> dict[str, bytes]:
    """Every object in the bucket with its body."""
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])]
    return {key: _body(s3, key) for key in keys}


def _put(s3, key: str, body: bytes) -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=body)


def _rel(repo: Path, item: SeedItem) -> str:
    return item.path.relative_to(repo).as_posix()


def _client_error(code: str = "AccessDenied") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "denied"}}, "PutObject")


# --- the plan ----------------------------------------------------------------------------


def test_plan_maps_each_rule(repo: Path):
    items = plan_seed(repo)

    assert {_rel(repo, item): item.key for item in items} == EXPECTED
    # Plan order is rule order, then name: the same run always uploads in the same order.
    assert [item.key for item in items] == list(EXPECTED.values())


@pytest.mark.parametrize(
    "relative",
    [
        "docs/tmp/lottery-exit-policy-search-latest.md",  # a dated key, no date
        "docs/tmp/flow-inversion-timing-2026-05-06-2026-05-07.md",  # two dates
        "docs/tmp/lottery-feature-audit-2026-13-45.md",  # month 13
        "docs/tmp/lottery-composite-candidates-2026-02-30.md",  # day 30 of February
        "docs/tmp/lottery-quality-sim-12026-05-10.csv",  # the date sits inside a digit run
        "docs/tmp/takeit-drift-latest.md",
        "ml/plots/takeit-drift/reliability_lottery_latest.png",
        f"{BY_DAY}/latest-chains.parquet",  # the chains rule needs the day for its seed mark
        f"{BY_DAY}/2026-04-15-2026-04-16-chains.parquet",
        # One valid date, but not the YYYY-MM-DD-chains.parquet the derive step keys by day: it
        # would upload under a key nothing reads and get no seed mark.
        f"{BY_DAY}/x-2026-04-13-chains.parquet",
        "docs/tmp/lottery-score-lineage-2026-05-09..md",  # a key the store refuses
    ],
)
def test_a_bad_name_is_an_error_naming_the_file(repo: Path, relative: str):
    _write(repo, relative)
    name = Path(relative).name

    with pytest.raises(SeedNameError, match=re.escape(name)):
        plan_seed(repo)


# --- run_seed ----------------------------------------------------------------------------


def test_existing_keys_are_never_overwritten(s3, store: ResearchStore, repo: Path):
    items = plan_seed(repo)
    kept = {
        EXPECTED[f"{BY_DAY}/2026-04-13-chains.parquet"]: b"R2 copy of a chains day",
        TRACKING_KEY: b"the live tracking state",
        EXPECTED["docs/tmp/lottery-exit-policy-search-2026-05-05.md"]: b"a published report",
    }
    for key, body in kept.items():
        _put(s3, key, body)

    result = run_seed(store, items, dry_run=False)

    # The existing chains day still gets its seed mark: its key exists after the run.
    assert result == SeedResult(
        uploaded=len(items) - 3, skipped_existing=3, chains_marked_seed=len(CHAINS_DAYS)
    )
    for key, body in kept.items():
        assert _body(s3, key) == body
    for item in items:
        if item.key not in kept:
            assert _body(s3, item.key) == item.path.read_bytes()


def test_a_key_that_only_starts_with_a_seed_key_does_not_count_as_existing(
    s3, store: ResearchStore, repo: Path
):
    # The listing is by prefix, so it returns this sibling too; existence is the exact key.
    sibling = f"{TRACKING_KEY}.bak"
    _put(s3, sibling, b"an old backup of the tracking state")
    items = plan_seed(repo)

    result = run_seed(store, items, dry_run=False)

    assert result == SeedResult(
        uploaded=len(items), skipped_existing=0, chains_marked_seed=len(CHAINS_DAYS)
    )
    assert _body(s3, TRACKING_KEY) == (repo / "docs/tmp/lottery-tracking.csv").read_bytes()
    assert _body(s3, sibling) == b"an old backup of the tracking state"


def test_chains_days_are_marked_seed_once(s3, store: ResearchStore, repo: Path):
    items = plan_seed(repo)

    with patch.object(store, "put_json", wraps=store.put_json) as put_json:
        first = run_seed(store, items, dry_run=False)
        second = run_seed(store, items, dry_run=False)

    assert first == SeedResult(
        uploaded=len(items), skipped_existing=0, chains_marked_seed=len(CHAINS_DAYS)
    )
    # Only chains, only those days, and every one is the literal the derive step treats as fresh.
    assert Manifest.load(store).families == {
        "chains": {day.isoformat(): SEED for day in CHAINS_DAYS}
    }
    # A rerun finds everything in R2 and every mark made: nothing to upload, nothing to write.
    assert second == SeedResult(uploaded=0, skipped_existing=len(items), chains_marked_seed=0)
    assert put_json.call_count == 1


def test_a_seed_mark_never_replaces_a_fingerprint(store: ResearchStore, repo: Path):
    manifest = Manifest()
    manifest.set("chains", CHAINS_DAYS[0], f"etag-1|v{CHAINS_VERSION}")
    manifest.set("exit-policy", CHAINS_DAYS[0], "etag-1|v2|abc")
    manifest.save(store)

    result = run_seed(store, plan_seed(repo), dry_run=False)

    assert result.chains_marked_seed == 1
    assert Manifest.load(store).families == {
        "chains": {
            CHAINS_DAYS[0].isoformat(): f"etag-1|v{CHAINS_VERSION}",
            CHAINS_DAYS[1].isoformat(): SEED,
        },
        "exit-policy": {CHAINS_DAYS[0].isoformat(): "etag-1|v2|abc"},
    }


def test_dry_run_writes_nothing(s3, store: ResearchStore, repo: Path):
    items = plan_seed(repo)
    _put(s3, TRACKING_KEY, b"the live tracking state")
    manifest = Manifest()
    manifest.set("chains", CHAINS_DAYS[0], "etag-1|v3")
    manifest.save(store)
    before = _snapshot(s3)

    result = run_seed(store, items, dry_run=True)

    # It reports what a real run would do, and the bucket is byte-for-byte what it was:
    # no object, no manifest.
    assert result == SeedResult(uploaded=len(items) - 1, skipped_existing=1, chains_marked_seed=1)
    assert _snapshot(s3) == before
    # The report is the real run's.
    assert run_seed(store, items, dry_run=False) == result


def test_existence_is_one_listing_per_rule_not_one_request_per_file(
    store: ResearchStore, repo: Path
):
    items = plan_seed(repo)
    assert len(items) > len(RULE_PREFIXES)  # some rules hold several files

    with patch.object(store, "list", wraps=store.list) as listing:
        run_seed(store, items, dry_run=False)

    # The manifest read lists its own key, once, to tell a missing manifest from a null one.
    prefixes = [call.args[0] for call in listing.call_args_list if call.args[0] != MANIFEST_KEY]
    assert prefixes == RULE_PREFIXES


def test_an_item_outside_every_rule_is_refused(store: ResearchStore, tmp_path: Path):
    stray = SeedItem(path=tmp_path / "x.md", key="research/reports/x.md")

    with pytest.raises(ValueError, match=re.escape("research/reports/x.md")):
        run_seed(store, [stray], dry_run=True)


def test_no_items_touch_nothing(store: ResearchStore):
    with (
        patch.object(store, "list") as listing,
        patch.object(store, "get_json") as get_json,
    ):
        assert run_seed(store, [], dry_run=False) == SeedResult(0, 0, 0)

    listing.assert_not_called()
    get_json.assert_not_called()


def test_seeded_chains_are_skipped_by_research_derive(store: ResearchStore, repo: Path):
    run_seed(store, plan_seed(repo), dry_run=False)
    manifest = Manifest.load(store)

    # The tape's ETag has nothing to do with it: a seeded day is never rebuilt.
    targets = {
        "chains": {day: f"some-etag-{day}|v{CHAINS_VERSION}" for day in CHAINS_DAYS},
    }
    assert stale_days(manifest, targets) == {}
    # Without the seed the same days are due, newest first.
    assert stale_days(Manifest(), targets) == dict.fromkeys(reversed(CHAINS_DAYS), ("chains",))
    # The seed vouches for chains only.
    fires = {"exit-policy": dict.fromkeys(CHAINS_DAYS, "etag|v2|abc")}
    assert stale_days(manifest, fires) == dict.fromkeys(reversed(CHAINS_DAYS), ("exit-policy",))
    # And the objects sit where the derive step keeps its own.
    stored = set(store.list("research/eod-flow/by-day/"))
    assert stored == {FAMILY_KEYS["chains"](day) for day in CHAINS_DAYS}


# --- main --------------------------------------------------------------------------------


def _total_line(uploaded: int, skipped: int, marked: int) -> str:
    return f"total: uploaded={uploaded} skipped_existing={skipped} chains_marked_seed={marked}"


EXPECTED_COUNTS = [
    "research/eod-flow/by-day/: uploaded=2 skipped_existing=0 chains_marked_seed=2",
    f"{TRACKING_KEY}: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/exit-policy/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/flow-timing/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/feature-audit/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/outcome-mining/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/score-lineage/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/quality-sim/: uploaded=1 skipped_existing=0 chains_marked_seed=0",
    "research/takeit-drift/: uploaded=3 skipped_existing=0 chains_marked_seed=0",
]


def test_main_prints_counts_only(s3, repo: Path, capsys: pytest.CaptureFixture[str]):
    code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 0
    assert err == ""
    assert out.splitlines() == [*EXPECTED_COUNTS, _total_line(12, 0, 2)]
    # No path, no file content, no setting value, no name of a single file. The tracking CSV
    # is left out of the names: its rule's label is its one key.
    everything = out + err
    assert str(repo) not in everything
    assert SECRET_ROW not in everything
    for item in plan_seed(repo):
        if item.key != TRACKING_KEY:
            assert item.path.name not in everything
    for setting in ("test-access-key-id", "test-secret-access-key", "amazonaws.com", BUCKET):
        assert setting not in everything
    # And it did the work.
    assert sorted(_snapshot(s3)) == sorted([*EXPECTED.values(), MANIFEST_KEY])


def test_main_dry_run_says_so_and_writes_nothing(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    _put(s3, TRACKING_KEY, b"the live tracking state")
    before = _snapshot(s3)

    code = seed_research.main(["--repo-root", str(repo), "--dry-run"])

    out = capsys.readouterr().out.splitlines()
    assert code == 0
    assert "dry run" in out[0] and "nothing is written" in out[0]
    assert out[-1] == _total_line(11, 1, 2)
    assert f"{TRACKING_KEY}: uploaded=0 skipped_existing=1 chains_marked_seed=0" in out
    assert _snapshot(s3) == before


def test_main_exits_2_on_a_bad_name_before_any_upload(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    # The bad name sorts after good files of earlier rules: nothing of theirs may go up.
    _write(repo, "docs/tmp/takeit-drift-latest.md")

    code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 2
    assert out == ""
    assert "takeit-drift-latest.md" in err
    assert SECRET_ROW not in err
    assert _snapshot(s3) == {}


def test_main_exits_2_on_bad_arguments(
    repo: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    with pytest.raises(SystemExit) as no_root:
        seed_research.main([])
    with pytest.raises(SystemExit) as unknown:
        seed_research.main(["--repo-root", str(repo), "--force"])
    assert no_root.value.code == 2
    assert unknown.value.code == 2

    missing = tmp_path / "no-such-checkout"
    # A typo'd root would otherwise match no file and report a clean run of zeros.
    assert seed_research.main(["--repo-root", str(missing)]) == 2
    assert "--repo-root" in capsys.readouterr().err
    assert seed_research.main(["--repo-root", str(repo / "docs/tmp/notes.md")]) == 2


def test_main_exits_2_when_no_file_matches_a_rule(
    s3, tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
):
    # A directory that holds none of the files (an empty folder, say) would otherwise report a
    # clean run of zeros. The settings are invalid too, so the fixed line also shows the check
    # comes before they are read.
    monkeypatch.delenv("DATABASE_URL")
    bare = tmp_path / "bare"
    bare.mkdir()
    only_decoys = tmp_path / "only-decoys"
    for relative in DECOYS:
        _write(only_decoys, relative)

    for root in (bare, only_decoys):
        assert seed_research.main(["--repo-root", str(root)]) == 2
        out, err = capsys.readouterr()
        assert out == ""
        assert err == "error: no file under --repo-root matches a seed rule\n"
    assert _snapshot(s3) == {}


def test_main_exits_2_on_invalid_settings(
    s3, repo: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("R2_ENDPOINT_URL", "http://not-https.example")
    monkeypatch.delenv("DATABASE_URL")

    code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 2
    assert out == ""
    # The invalid fields by name; never a value (the secrets are still set).
    assert "r2_endpoint_url" in err and "database_url" in err
    for value in ("not-https.example", "test-secret-access-key", "test-access-key-id", "test-key"):
        assert value not in err
    assert _snapshot(s3) == {}


def test_main_exits_1_on_a_failed_upload_and_a_rerun_resumes(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    real_put_file = ResearchStore.put_file
    puts: list[str] = []

    def second_upload_fails(self: ResearchStore, key: str, path: Path) -> int:
        puts.append(key)
        if len(puts) == 2:
            raise _client_error()
        return real_put_file(self, key, path)

    with patch.object(ResearchStore, "put_file", second_upload_fails):
        code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 1
    assert err == "error: ClientError\n"
    assert SECRET_ROW not in out + err
    # The first chains day went up; nothing was marked, since the rule did not finish.
    assert sorted(_snapshot(s3)) == [EXPECTED[f"{BY_DAY}/2026-04-13-chains.parquet"]]

    # With the failure gone, the rerun skips what is there and finishes the rest and the marks.
    assert seed_research.main(["--repo-root", str(repo)]) == 0
    out, _ = capsys.readouterr()
    assert out.splitlines()[0] == (
        "research/eod-flow/by-day/: uploaded=1 skipped_existing=1 chains_marked_seed=2"
    )
    assert out.splitlines()[-1] == _total_line(11, 1, 2)
    assert sorted(_snapshot(s3)) == sorted([*EXPECTED.values(), MANIFEST_KEY])


def test_main_exits_1_when_the_listing_fails_before_any_upload(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    with patch.object(ResearchStore, "list", side_effect=_client_error()):
        code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 1
    assert out == ""
    assert err == "error: ClientError\n"
    assert _snapshot(s3) == {}


def test_main_exits_1_when_the_manifest_write_fails_and_the_rerun_marks(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    chains_keys = sorted(key for key in EXPECTED.values() if key.startswith(BY_DAY_PREFIX))

    with patch.object(ResearchStore, "put_json", side_effect=_client_error()):
        code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 1
    assert err == "error: ClientError\n"
    # The chains objects are up. The marks were not stored, and no later rule ran.
    assert out == ""
    assert sorted(_snapshot(s3)) == chains_keys

    # With the failure gone, the rerun skips the objects and stores the marks.
    assert seed_research.main(["--repo-root", str(repo)]) == 0
    out, _ = capsys.readouterr()
    assert out.splitlines()[0] == (
        "research/eod-flow/by-day/: uploaded=0 skipped_existing=2 chains_marked_seed=2"
    )
    assert out.splitlines()[-1] == _total_line(10, 2, 2)
    assert sorted(_snapshot(s3)) == sorted([*EXPECTED.values(), MANIFEST_KEY])


def test_main_exits_1_on_a_malformed_manifest_before_any_upload(
    s3, repo: Path, capsys: pytest.CaptureFixture[str]
):
    _put(s3, MANIFEST_KEY, b'{"not": "a manifest"}')
    before = _snapshot(s3)

    code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 1
    assert out == ""
    assert err == "error: ManifestError\n"
    # Never reset, and nothing else written.
    assert _snapshot(s3) == before


@pytest.mark.parametrize(
    "failure",
    [
        _client_error("InternalError"),
        EndpointConnectionError(endpoint_url="https://secret-endpoint.example"),
        R2VerifyError("size differs"),
        PermissionError("denied"),
    ],
    ids=lambda failure: type(failure).__name__,
)
def test_main_exits_1_naming_only_the_class_of_a_store_or_file_error(
    s3, repo: Path, capsys: pytest.CaptureFixture[str], failure: Exception
):
    with patch.object(ResearchStore, "put_file", side_effect=failure):
        code = seed_research.main(["--repo-root", str(repo)])

    out, err = capsys.readouterr()
    assert code == 1
    assert out == ""
    # Never the message: an endpoint error carries the endpoint.
    assert err == f"error: {type(failure).__name__}\n"
    assert _snapshot(s3) == {}


def test_running_the_module_exits_with_main_s_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # `python -m seed_research` with a root that is not a directory: main returns 2.
    monkeypatch.setattr(sys, "argv", ["seed_research", "--repo-root", str(tmp_path / "missing")])

    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("seed_research", run_name="__main__")

    assert exit_info.value.code == 2


# --- the module's imports ----------------------------------------------------------------

NIGHTLY_SRC = Path(__file__).resolve().parents[1] / "src"
# What nightly/requirements.txt installs and this module may use besides the standard
# library and nightly/src: boto3's botocore, and pydantic.
IMAGE_PACKAGES = {"botocore", "pydantic"}


def test_the_module_imports_only_what_the_image_has():
    # The image copies nightly/src whole, and CI imports it there with no other site-packages
    # than requirements.txt: a top-level import of anything else would fail that import.
    tree = ast.parse((NIGHTLY_SRC / "seed_research.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    allowed = set(sys.stdlib_module_names) | {p.stem for p in NIGHTLY_SRC.glob("*.py")}

    assert imported - allowed <= IMAGE_PACKAGES
    assert {"research_derive", "research_store", "config"} <= imported
