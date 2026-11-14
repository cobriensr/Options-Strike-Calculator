"""Tests for the lottery-refit step: the nightly candidate lifecycle of plan D6.

What is patched, at the `refit_step` module boundary (R3): `connect_db`, the six
`weights_store` functions (an in-memory `FakeStore` with their semantics), `fetch_frame`
(the fires table, filtered by the same date window the SQL uses), `rescore_all` and
Sentry's `capture_message`. Nothing reaches a database or the network.

The gates and the scorer (`train_weights`, `score_frame`, `match_feed_cutoffs`,
`check_creation`, `decide_shadow`, `spearman`) run for real on small synthetic frames, so
the wiring between them is under test, not just the step's own branching. Where a test
needs a verdict the synthetic data cannot give cheaply (a rejection with chosen reasons), it
patches the one gate function and says so. `StepContext.seconds_left` reads the clock in
`steps`, which the autouse `clock` fixture freezes.
"""

from __future__ import annotations

import ast
import copy
import inspect
import json
import logging
import re
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, create_autospec
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2.errors
import pytest
import sentry_sdk
from backfill_lottery_scores import (
    ConcurrentScoreWriter,
    PointerMoved,
    RescoreDeadline,
    RescoreResult,
    rescore_all,
)
from lottery_refit_gates import (
    FEED_COLUMNS,
    OUTCOME_COLUMN,
    SHADOW_MAX_SESSIONS,
    CreationVerdict,
    FeedCutoffs,
    ShadowVerdict,
    daily_tier_shares,
    decide_shadow,
    feed_qas,
    match_feed_cutoffs,
    spearman,
)
from lottery_weights import (
    SEED_VERSION,
    WeightsInvalid,
    refit_version_id,
    score_frame,
    validate_weights,
)

import constants
import refit_step
import steps
from calendar_nyse import trading_days
from config import load_settings
from outcome_check import recent_sessions
from refit_step import fetch_feed_frame
from steps import StepContext, StepResult
from weights_store import StoredVersion

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads(
    (REPO_ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)
SEED: dict[str, Any] = FIXTURE["weights"]
assert FIXTURE["version"] == SEED_VERSION

NOW = datetime(2026, 11, 12, 7, 15, tzinfo=UTC)
CLOCK = 1_000.0
SECONDS_LEFT = 5_000.0
LAST_SESSION = date(2026, 11, 11)  # a Wednesday
SHADOW_TT = date(2026, 10, 1)  # a shadow's training date in the evaluation scenarios
TICKERS = ("AAPL", "AMD", "AMZN", "APLD")
TODS = ("AM_open", "MID", "LUNCH", "PM")
CONN = object()  # what connect_db yields; every fake ignores it
PARTIAL_DETAIL = "promotion deferred to the next night"
COUNT_NAMES = {
    "candidates_built",
    "candidates_rejected",
    "already_built",
    "sessions_recorded",
    "waiting",
    "passed",
    "promoted",
    "rejected",
    "promotion_deferred",
    "rows_rescored",
    "train_rows",
    "eval_rows",
}


# --- synthetic data --------------------------------------------------------------


def sessions_after(day: date, n: int) -> list[date]:
    """The next `n` trading days after `day`, ascending."""
    return trading_days(day + timedelta(days=1), day + timedelta(days=3 * n + 15))[:n]


def make_fires(sessions: Sequence[date], per_session: int, *, seed: int = 11) -> pd.DataFrame:
    """Aligned single-leg fires with an outcome: every `lottery_scoring.fetch_frame` and
    `fetch_feed_frame` column, so one master frame can answer both."""
    rng = np.random.default_rng(seed)
    n = len(sessions) * per_session
    option = rng.choice(["C", "P"], n)
    base = rng.uniform(0.0, 1000.0, n)
    gap = rng.uniform(1.0, 100.0, n)
    outcome = rng.normal(5.0, 40.0, n)
    frame = pd.DataFrame(
        {
            "underlying_symbol": rng.choice(TICKERS, n),
            "option_type": option,
            "tod": rng.choice(TODS, n),
            "dte": rng.integers(0, 4, n).astype("float64"),
            "trigger_vol_to_oi_window": rng.uniform(0.0, 0.5, n),
            "gamma_at_trigger": rng.uniform(0.0, 0.1, n),
            "trigger_ask_pct": rng.uniform(0.4, 0.95, n),
            "cum_ncp_at_fire": np.where(option == "C", base + gap, base),
            "cum_npp_at_fire": np.where(option == "P", base + gap, base),
            "date": pd.Series(np.repeat(np.array(list(sessions), dtype=object), per_session)),
            "realized_flow_inversion_pct": outcome,
            "realized_eod_pct": outcome,
            "peak_ceiling_pct": np.abs(outcome) + 100.0,
            "round_trip_score_deduct": 0.0,
            "fire_count_score_adjustment": 0.0,
            "direction_gated": False,
            # 3-5: a quintile of 1 or 2 forces the feed's tier3 and would thin the tiers.
            "inversion_quintile": rng.integers(3, 6, n).astype("float64"),
        }
    )
    frame[OUTCOME_COLUMN] = frame["realized_flow_inversion_pct"]
    return frame


def tuned(weights: dict[str, Any], fires: pd.DataFrame) -> dict[str, Any]:
    """`weights` with feed cutoffs at the 95th and 85th percentile of its own qas on `fires`,
    so a candidate scoring like it sits inside the tier1 share band."""
    qas = feed_qas(score_frame(weights, fires), fires).dropna()
    tier1 = int(np.percentile(qas, 95))
    tier2 = min(int(np.percentile(qas, 85)), tier1 - 1)
    out = copy.deepcopy(weights)
    out["feed_cutoffs"] = {"tier1_min_score": tier1, "tier2_min_score": tier2}
    validate_weights(out)
    return out


def same_candidate(active: dict[str, Any], through: date) -> dict[str, Any]:
    out = copy.deepcopy(active)
    out["trained_through"] = through.isoformat()
    return out


def differing_candidate(active: dict[str, Any], through: date) -> dict[str, Any]:
    """Two ticker weights changed, C/P and DTE0 flipped, feed cutoffs one point higher: what
    a notice's extras report."""
    out = same_candidate(active, through)
    features = out["features"]
    features["ticker_weights"]["APLD"] += 3
    features["ticker_weights"]["AMD"] -= 2
    features["option_type_weights"] = {"C": 2, "P": -2}
    features["dte_weights"]["0"] = -2
    out["feed_cutoffs"] = {
        "tier1_min_score": active["feed_cutoffs"]["tier1_min_score"] + 1,
        "tier2_min_score": active["feed_cutoffs"]["tier2_min_score"] + 1,
    }
    validate_weights(out)
    return out


_PLAIN_TYPES = (bool, int, float, str, type(None))


def assert_plain(value: object, path: str = "value") -> None:
    """Only Python scalars, lists and str-keyed dicts: nothing numpy, no date, no tuple
    (carry e: json.dumps raises on numpy int64 and float32)."""
    if isinstance(value, dict):
        for key, item in value.items():
            assert type(key) is str, (path, key)
            assert_plain(item, f"{path}.{key}")
    elif isinstance(value, list):
        for i, item in enumerate(value):
            assert_plain(item, f"{path}[{i}]")
    else:
        assert type(value) in _PLAIN_TYPES, (path, type(value))


def plain_copy(value: object) -> Any:
    assert_plain(value)
    return json.loads(json.dumps(value))


# --- the fakes -------------------------------------------------------------------


class FakeStore:
    """`lottery_score_versions` and its pointers, behind weights_store's six functions.

    The same rules the real store enforces (and weights_store's own tests pin): a second
    shadow is a UniqueViolation, `insert_candidate` is idempotent per version, a session is
    recorded once, and `decide` touches only a shadow. Every write goes through JSON, so a
    numpy value in it fails here as it would in `psycopg2.extras.Json`.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.active = SEED_VERSION
        self.takeit = SEED_VERSION
        self.calls: list[str] = []
        self.records: list[tuple[str, date, bool]] = []
        self._put(SEED_VERSION, SEED, "seed", None, {})

    def _put(
        self,
        version: str,
        weights: dict[str, Any],
        status: str,
        trained_through: date | None,
        report: dict[str, Any],
    ) -> None:
        self.rows[version] = {
            "weights": plain_copy(weights),
            "status": status,
            "trained_through": trained_through,
            "gate_report": plain_copy(report),
        }

    def set_active(self, weights: dict[str, Any]) -> None:
        self.rows[self.active]["weights"] = plain_copy(weights)

    def add_shadow(self, version: str, weights: dict[str, Any], through: date) -> None:
        self._put(version, weights, "shadow", through, {"creation": {}})

    def _stored(self, version: str) -> StoredVersion:
        row = self.rows[version]
        return StoredVersion(
            version,
            copy.deepcopy(row["weights"]),
            row["status"],
            row["trained_through"],
            copy.deepcopy(row["gate_report"]),
        )

    def load_active(self, conn: Any) -> StoredVersion:
        self.calls.append("load_active")
        return self._stored(self.active)

    def load_shadow(self, conn: Any) -> StoredVersion | None:
        self.calls.append("load_shadow")
        shadows = [v for v, row in self.rows.items() if row["status"] == "shadow"]
        return self._stored(shadows[0]) if shadows else None

    def version_exists(self, conn: Any, version: str) -> bool:
        self.calls.append("version_exists")
        return version in self.rows

    def insert_candidate(
        self,
        conn: Any,
        version: str,
        weights: dict[str, Any],
        *,
        status: str,
        trained_through: date,
        report: dict[str, Any],
    ) -> bool:
        self.calls.append("insert_candidate")
        if version in self.rows:
            return False
        if status == "shadow" and any(r["status"] == "shadow" for r in self.rows.values()):
            raise psycopg2.errors.UniqueViolation("one shadow at a time")
        self._put(version, weights, status, trained_through, report)
        return True

    def record_session_eval(
        self, conn: Any, version: str, session: date, entry: dict[str, Any]
    ) -> bool:
        self.calls.append("record_session_eval")
        row = self.rows.get(version)
        key = session.isoformat()
        sessions = None if row is None else row["gate_report"].setdefault("sessions", {})
        wrote = row is not None and row["status"] == "shadow" and key not in sessions
        if wrote:
            sessions[key] = plain_copy(entry)
        self.records.append((version, session, wrote))
        return wrote

    def decide(self, conn: Any, version: str, status: str, verdict: dict[str, Any]) -> bool:
        self.calls.append("decide")
        row = self.rows.get(version)
        if row is None or row["status"] != "shadow":
            return False
        row["status"] = status
        row["gate_report"]["verdict"] = plain_copy(verdict)
        return True

    def promote(self, version: str, expect_active: str) -> None:
        """What `rescore_all`'s promotion transaction does when it commits."""
        if self.active != expect_active or self.rows[version]["status"] not in ("shadow", "passed"):
            raise PointerMoved("the active pointer moved")
        self.rows[version]["status"] = "promoted"
        self.active = version


class Fires:
    """The fires table behind `fetch_frame` and `fetch_feed_frame`, with the SQL's windows."""

    def __init__(self, frame: pd.DataFrame, *, feed_missing: Sequence[date] = ()) -> None:
        self.frame = frame
        self.feed_missing = set(feed_missing)
        self.fetch_calls: list[tuple[date, date]] = []
        self.feed_calls: list[list[date]] = []

    def fetch_frame(self, conn: Any, start: date, end: date) -> pd.DataFrame:
        self.fetch_calls.append((start, end))
        inside = np.array([start < d <= end for d in self.frame["date"]], dtype=bool)
        return self.frame[inside].reset_index(drop=True)

    def fetch_feed_frame(self, conn: Any, sessions: Sequence[date]) -> pd.DataFrame:
        self.feed_calls.append(list(sessions))
        wanted = set(sessions) - self.feed_missing
        inside = np.array([d in wanted for d in self.frame["date"]], dtype=bool)
        return self.frame[inside][list(FEED_COLUMNS)].reset_index(drop=True)


@dataclass
class World:
    store: FakeStore
    notices: MagicMock
    rescore: MagicMock
    fires: Fires = field(default_factory=lambda: Fires(make_fires([], 1)))
    connects: int = 0

    def titles(self) -> list[str]:
        return [c.args[0] for c in self.notices.call_args_list]


RESCORED = RescoreResult(
    scanned=1_000, changed=640, snapshot_rows=1, pointer_moved=True, score_changed=600
)


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(steps, "monotonic", lambda: CLOCK)


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    store = FakeStore()
    notices = create_autospec(sentry_sdk.capture_message)
    rescore = create_autospec(rescore_all)
    w = World(store, notices, rescore)

    def promote(conn: Any, *, to_version: str, expect_active: str, **_: Any) -> RescoreResult:
        store.promote(to_version, expect_active)
        return RESCORED

    rescore.side_effect = promote

    @contextmanager
    def connect(settings: Any) -> Iterator[object]:
        w.connects += 1
        yield CONN

    monkeypatch.setattr(refit_step, "connect_db", connect)
    for name in (
        "load_active",
        "load_shadow",
        "version_exists",
        "insert_candidate",
        "record_session_eval",
        "decide",
    ):
        monkeypatch.setattr(refit_step, name, getattr(store, name))
    monkeypatch.setattr(refit_step, "fetch_frame", lambda c, s, e: w.fires.fetch_frame(c, s, e))
    monkeypatch.setattr(refit_step, "fetch_feed_frame", lambda c, s: w.fires.fetch_feed_frame(c, s))
    monkeypatch.setattr(refit_step, "rescore_all", rescore)
    monkeypatch.setattr(sentry_sdk, "capture_message", notices)
    return w


def make_ctx(
    last_session: date = LAST_SESSION,
    *,
    now_utc: datetime = NOW,
    seconds_left: float = SECONDS_LEFT,
) -> StepContext:
    return StepContext(load_settings(), now_utc, last_session, CLOCK + seconds_left, ())


def run_night(w: World, last_session: date = LAST_SESSION, **ctx: Any) -> StepResult:
    return refit_step.run(make_ctx(last_session, **ctx))


def ok_creation(
    weights: dict[str, Any], *, train_rows: int, train_sessions: int, tier1_share: float
) -> CreationVerdict:
    """A `check_creation` that approves: the synthetic windows are far under 30,000 rows."""
    return CreationVerdict(True, (), train_rows, train_sessions, tier1_share)


def creation_world(w: World, monkeypatch: pytest.MonkeyPatch, *, approve: bool) -> list[date]:
    """Fires for the 20 sessions the feed cutoffs are matched on, 60 each. Returns them."""
    trailing = recent_sessions(LAST_SESSION, 20)
    w.fires = Fires(make_fires(trailing, 60))
    if approve:
        monkeypatch.setattr(refit_step, "check_creation", ok_creation)
    return trailing


@dataclass(frozen=True)
class Scenario:
    version: str
    trained_through: date
    elapsed: list[date]
    last_session: date
    candidate: dict[str, Any]
    active: dict[str, Any]


def shadow_scenario(
    w: World,
    *,
    n_elapsed: int,
    per_session: int,
    differing: bool = False,
    tt: date = SHADOW_TT,
) -> Scenario:
    """A shadow trained through `tt`, with `n_elapsed` sessions evaluable tonight (the
    run lands one session after the last of them) and two spare sessions of fires after."""
    sessions = sessions_after(tt, n_elapsed + 3)
    fires = make_fires(sessions, per_session)
    active = tuned(SEED, fires)
    make = differing_candidate if differing else same_candidate
    candidate = make(active, tt)
    w.fires = Fires(fires)
    w.store.set_active(active)
    version = refit_version_id(tt)
    w.store.add_shadow(version, candidate, tt)
    return Scenario(version, tt, sessions[:n_elapsed], sessions[n_elapsed], candidate, active)


def verdict(
    decision: str,
    reasons: Sequence[str] = (),
    *,
    sessions: Sequence[date] = (),
) -> ShadowVerdict:
    return ShadowVerdict(
        decision=decision,  # type: ignore[arg-type]
        reasons=tuple(reasons),
        sessions=tuple(sessions),
        eval_rows=6_000,
        rho_candidate=0.06,
        rho_active=0.05,
        tier1_ratio=1.1,
        tier12_ratio=0.9,
        tier1_share=0.05,
    )


def patch_verdict(monkeypatch: pytest.MonkeyPatch, result: ShadowVerdict) -> MagicMock:
    mock = create_autospec(decide_shadow, return_value=result)
    monkeypatch.setattr(refit_step, "decide_shadow", mock)
    return mock


def arguments_of(mock: MagicMock, function: Callable[..., Any]) -> dict[str, Any]:
    """The last call's arguments by parameter name, however the step passed them."""
    call = mock.call_args
    return dict(inspect.signature(function).bind(*call.args, **call.kwargs).arguments)


def promote_ready(w: World, monkeypatch: pytest.MonkeyPatch, **scenario: Any) -> Scenario:
    """A shadow whose gates pass (patched), promotion enabled."""
    monkeypatch.setattr(refit_step, "PROMOTION_ENABLED", True)
    s = shadow_scenario(w, **{"n_elapsed": 11, "per_session": 40, "differing": True, **scenario})
    patch_verdict(monkeypatch, verdict("pass", sessions=s.elapsed[:10]))
    return s


# --- creation: no shadow ---------------------------------------------------------


def test_builds_a_shadow_when_none_exists(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    creation_world(world, monkeypatch, approve=True)

    result = run_night(world)

    version = f"refit-{LAST_SESSION.isoformat()}"
    row = world.store.rows[version]
    assert row["status"] == "shadow"
    assert row["trained_through"] == LAST_SESSION
    validate_weights(row["weights"])
    assert row["weights"]["trained_through"] == LAST_SESSION.isoformat()
    assert result.status == "ok"
    assert result.detail == ""
    assert result.counts["candidates_built"] == 1
    assert result.counts["train_rows"] == 20 * 60
    assert sum(result.counts.values()) == 1 + 20 * 60
    # The shadow is read before anything is built or inserted (carry d); the window is
    # (last_session - 90 days, last_session].
    assert world.store.calls == [
        "load_active",
        "load_shadow",
        "version_exists",
        "insert_candidate",
    ]
    assert world.fires.fetch_calls == [(LAST_SESSION - timedelta(days=90), LAST_SESSION)]
    world.notices.assert_not_called()  # a shadow is only logged; the notices are decisions
    assert world.connects == 1


def test_thin_window_rejects_at_creation_with_one_notice(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # All gates real: 1,200 rows over 20 sessions is under both training minimums.
    creation_world(world, monkeypatch, approve=False)

    result = run_night(world)

    version = f"refit-{LAST_SESSION.isoformat()}"
    row = world.store.rows[version]
    assert row["status"] == "rejected"
    assert world.store.load_shadow(None) is None
    reasons = row["gate_report"]["creation"]["verdict"]["reasons"]
    assert reasons[:2] == ["too_few_train_rows", "too_few_train_sessions"]
    assert result.status == "ok"  # the notice is the alert (spec delta 10)
    assert result.counts["candidates_rejected"] == 1
    assert result.counts["candidates_built"] == 0

    world.notices.assert_called_once()
    (title,) = world.notices.call_args.args
    kwargs = world.notices.call_args.kwargs
    assert title == "nightly refit candidate rejected"
    assert kwargs["level"] == "error"
    assert kwargs["fingerprint"] == ["nightly-refit", "candidate_rejected", "too_few_train_rows"]
    assert kwargs["tags"]["version"] == version
    assert kwargs["extras"]["reasons"] == reasons  # the verdict's order, as given
    extras = kwargs["extras"]
    assert extras["train_rows"] == 20 * 60
    assert extras["train_sessions"] == 20
    assert extras["insample_rho"] == row["gate_report"]["creation"]["insample_rho"]
    assert extras["tier1_share"] == row["gate_report"]["creation"]["verdict"]["tier1_share"]
    # The feed cutoffs before (the active's) and after matching, and how far the training
    # moved the ticker weights from the active's, as counts: never which tickers (D9).
    stored = row["weights"]
    assert extras["feed_tier1_before"] == SEED["feed_cutoffs"]["tier1_min_score"]
    assert extras["feed_tier2_before"] == SEED["feed_cutoffs"]["tier2_min_score"]
    assert extras["feed_tier1_after"] == stored["feed_cutoffs"]["tier1_min_score"]
    assert extras["feed_tier2_after"] == stored["feed_cutoffs"]["tier2_min_score"]
    new, old = stored["features"]["ticker_weights"], SEED["features"]["ticker_weights"]
    moved = sum(new.get(t, 0) != old.get(t, 0) for t in set(new) | set(old))
    assert moved > 0  # four trained tickers against the seed's 85
    assert extras["ticker_weights_changed"] == moved
    assert set(extras["flipped_signs"]) <= {"C/P", "DTE0"}
    assert_plain(extras)


@pytest.mark.parametrize("approved", [True, False], ids=["shadow", "rejected"])
def test_rerun_same_night_is_a_no_op(
    world: World, monkeypatch: pytest.MonkeyPatch, approved: bool
) -> None:
    creation_world(world, monkeypatch, approve=approved)
    run_night(world)
    rows = copy.deepcopy(world.store.rows)
    notices = world.notices.call_count

    second = run_night(world)

    assert world.store.rows == rows
    assert world.store.calls.count("insert_candidate") == 1
    assert world.notices.call_count == notices  # no second rejection notice
    assert second.counts["candidates_built"] == 0
    assert second.counts["candidates_rejected"] == 0
    assert second.counts["sessions_recorded"] == 0
    # A shadow built tonight waits; a version rejected tonight is already built.
    assert second.counts["waiting" if approved else "already_built"] == 1
    assert second.status == "ok"


def test_creation_report_holds_verdict_window_and_insample_rho(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    creation_world(world, monkeypatch, approve=False)

    run_night(world)

    row = world.store.rows[f"refit-{LAST_SESSION.isoformat()}"]
    report = row["gate_report"]
    assert set(report) == {"creation"}
    creation = report["creation"]
    assert set(creation) == {"verdict", "train_window", "insample_rho"}
    assert set(creation["verdict"]) == {
        "ok",
        "reasons",
        "train_rows",
        "train_sessions",
        "tier1_share",
    }
    assert creation["verdict"]["ok"] is False
    assert creation["train_window"] == {
        "after": (LAST_SESSION - timedelta(days=90)).isoformat(),
        "through": LAST_SESSION.isoformat(),
    }
    train = world.fires.fetch_frame(None, LAST_SESSION - timedelta(days=90), LAST_SESSION)
    expected = spearman(score_frame(row["weights"], train), train[OUTCOME_COLUMN])
    assert creation["insample_rho"] == expected
    # No ticker EMA any more (owner, 2026-11-06).
    assert "ema" not in json.dumps(report).lower()


def test_feed_cutoffs_are_matched_to_the_active(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    trailing = creation_world(world, monkeypatch, approve=True)
    active = copy.deepcopy(SEED)
    active["feed_cutoffs"] = {"tier1_min_score": 12, "tier2_min_score": 8}
    world.store.set_active(active)
    match = create_autospec(match_feed_cutoffs, return_value=FeedCutoffs(9, 6))
    monkeypatch.setattr(refit_step, "match_feed_cutoffs", match)
    creation = MagicMock(wraps=ok_creation)
    monkeypatch.setattr(refit_step, "check_creation", creation)

    run_night(world)

    # Over the last 20 trading sessions, ending on tonight's last session.
    assert world.fires.feed_calls == [trailing]
    row = world.store.rows[f"refit-{LAST_SESSION.isoformat()}"]
    assert row["weights"]["feed_cutoffs"] == {"tier1_min_score": 9, "tier2_min_score": 6}
    args = arguments_of(match, match_feed_cutoffs)
    assert args["active"] == FeedCutoffs(12, 8)
    feed = world.fires.fetch_feed_frame(None, trailing)
    pd.testing.assert_series_equal(
        args["qas_active"], feed_qas(score_frame(active, feed), feed), check_names=False
    )
    pd.testing.assert_series_equal(
        args["qas_candidate"], feed_qas(score_frame(row["weights"], feed), feed), check_names=False
    )
    # The active version's row is not touched.
    assert world.store.rows[SEED_VERSION]["weights"]["feed_cutoffs"] == active["feed_cutoffs"]

    # The creation check reads the candidate's mean daily tier1 share under the MATCHED
    # cutoffs, which differ here from the active's (else this would not tell them apart).
    qas = args["qas_candidate"]
    matched_share = daily_tier_shares(qas, feed, FeedCutoffs(9, 6))["tier1_share"].mean()
    active_share = daily_tier_shares(qas, feed, FeedCutoffs(12, 8))["tier1_share"].mean()
    assert matched_share != active_share
    assert creation.call_args.kwargs == {
        "train_rows": 20 * 60,
        "train_sessions": 20,
        "tier1_share": matched_share,
    }
    assert creation.call_args.args == (row["weights"],)


def test_cutoffs_the_validator_refuses_reject_at_creation_instead_of_failing_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # match_feed_cutoffs gives tier1 0 and tier2 -1 when the candidate has no fires at the
    # top: check_creation reports `invalid_weights`. The candidate must still be stored and
    # announced, not left as an exception that scoring it (which validates) would raise.
    creation_world(world, monkeypatch, approve=False)
    monkeypatch.setattr(refit_step, "match_feed_cutoffs", lambda *a, **k: FeedCutoffs(0, -1))

    result = run_night(world)

    row = world.store.rows[f"refit-{LAST_SESSION.isoformat()}"]
    assert row["status"] == "rejected"
    assert "invalid_weights" in row["gate_report"]["creation"]["verdict"]["reasons"]
    assert row["weights"]["feed_cutoffs"] == {"tier1_min_score": 0, "tier2_min_score": -1}
    assert result.counts["candidates_rejected"] == 1
    world.notices.assert_called_once()


@pytest.mark.parametrize(
    "error",
    [WeightsInvalid("features.gamma_quintile_boundaries", "increasing"), ValueError("no rows")],
    ids=["weights-invalid", "value-error"],
)
def test_a_training_error_fails_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    creation_world(world, monkeypatch, approve=True)

    def raising(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise error

    monkeypatch.setattr(refit_step, "train_weights", raising)

    with pytest.raises(type(error)):
        run_night(world)

    # Never turned into a rejection or a wait (carry b): nothing stored, nothing sent.
    assert "insert_candidate" not in world.store.calls
    world.notices.assert_not_called()


def test_an_unknown_tod_in_the_fires_fails_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    trailing = creation_world(world, monkeypatch, approve=True)
    frame = make_fires(trailing, 60)
    frame.loc[frame.index[-1], "tod"] = "PREMARKET"
    world.fires = Fires(frame)

    with pytest.raises(ValueError, match="tod"):
        run_night(world)

    assert "insert_candidate" not in world.store.calls
    world.notices.assert_not_called()


def test_a_second_shadow_is_a_failure_not_an_already_built(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Another run's insert won: the one-shadow index refuses ours. That is a logic bug or a
    # concurrent run (carry d), never "already built".
    creation_world(world, monkeypatch, approve=True)

    def second_shadow(*args: Any, **kwargs: Any) -> bool:
        raise psycopg2.errors.UniqueViolation("one shadow at a time")

    monkeypatch.setattr(refit_step, "insert_candidate", second_shadow)

    with pytest.raises(psycopg2.errors.UniqueViolation):
        run_night(world)

    world.notices.assert_not_called()


def test_losing_the_insert_to_a_concurrent_run_of_the_same_night_counts_already_built(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    creation_world(world, monkeypatch, approve=False)
    monkeypatch.setattr(refit_step, "insert_candidate", lambda *a, **k: False)

    result = run_night(world)

    assert result.counts["already_built"] == 1
    assert result.counts["candidates_rejected"] == 0
    world.notices.assert_not_called()  # the run that inserted it sent its own


@pytest.mark.parametrize("failing", ["load_active", "load_shadow", "insert_candidate", "fetch"])
def test_a_database_error_fails_the_step_and_sends_no_notice(
    world: World, monkeypatch: pytest.MonkeyPatch, failing: str
) -> None:
    creation_world(world, monkeypatch, approve=True)
    lost = psycopg2.OperationalError("connection lost")

    def raising(*args: Any, **kwargs: Any) -> None:
        raise lost

    monkeypatch.setattr(refit_step, "fetch_frame" if failing == "fetch" else failing, raising)

    with pytest.raises(psycopg2.OperationalError):
        run_night(world)

    world.notices.assert_not_called()
    assert "decide" not in world.store.calls


def test_an_active_version_that_cannot_be_loaded_fails_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_pointer(conn: Any) -> StoredVersion:
        raise LookupError("lottery_score_pointers has no row named active")

    monkeypatch.setattr(refit_step, "load_active", no_pointer)

    with pytest.raises(LookupError):
        run_night(world)

    world.notices.assert_not_called()


# --- evaluation: a shadow exists -------------------------------------------------


def test_records_each_new_session_once(world: World) -> None:
    s = shadow_scenario(world, n_elapsed=3, per_session=40)

    frame = world.fires.frame
    day = s.elapsed[1]
    # Five fires of the second session have no outcome: they are not eval rows.
    frame.loc[frame.index[frame["date"] == day][:5], OUTCOME_COLUMN] = np.nan

    first = run_night(world, s.last_session)

    # Ascending, each written once, and the feed is fetched for every elapsed session
    # (carry a), the evaluation frame over (trained_through, last elapsed session].
    assert world.store.records == [(s.version, day, True) for day in s.elapsed]
    assert world.fires.feed_calls == [s.elapsed]
    assert world.fires.fetch_calls == [(s.trained_through, s.elapsed[-1])]
    assert first.counts["sessions_recorded"] == 3
    assert first.counts["waiting"] == 1
    assert first.status == "ok"
    sessions = world.store.rows[s.version]["gate_report"]["sessions"]
    assert set(sessions) == {day.isoformat() for day in s.elapsed}

    rows = frame[frame["date"] == day]
    expected_rho = {
        "rho_candidate": spearman(score_frame(s.candidate, rows), rows[OUTCOME_COLUMN]),
        "rho_active": spearman(score_frame(s.active, rows), rows[OUTCOME_COLUMN]),
    }
    entry = sessions[day.isoformat()]
    assert entry == {
        "eval_rows": 35,
        "evaluated": False,  # under MIN_EVAL_ROWS_PER_SESSION
        "feed_fires": 40,  # every fire of the session, with or without an outcome
        **expected_rho,
    }
    assert sessions[s.elapsed[0].isoformat()]["eval_rows"] == 40

    # The same night again: every session is in the report, so none is written or counted.
    world.store.records.clear()
    second = run_night(world, s.last_session)
    assert world.store.records == []
    assert second.counts["sessions_recorded"] == 0
    assert second.counts["waiting"] == 1

    # The next night adds the one session that has since become evaluable, and the feed is
    # fetched for all of them again.
    third = run_night(world, sessions_after(s.last_session, 1)[0])
    assert world.store.records == [(s.version, s.last_session, True)]
    assert third.counts["sessions_recorded"] == 1
    assert world.fires.feed_calls[-1] == [*s.elapsed, s.last_session]


@pytest.mark.parametrize(("per_session", "evaluated"), [(499, False), (500, True)])
def test_a_session_counts_as_evaluated_at_the_minimum_rows(
    world: World, per_session: int, evaluated: bool
) -> None:
    # MIN_EVAL_ROWS_PER_SESSION is 500 and the edge is inclusive, as in `decide_shadow`.
    s = shadow_scenario(world, n_elapsed=1, per_session=per_session)

    run_night(world, s.last_session)

    entry = world.store.rows[s.version]["gate_report"]["sessions"][s.elapsed[0].isoformat()]
    assert entry["eval_rows"] == per_session
    assert entry["evaluated"] is evaluated


@pytest.mark.parametrize(
    ("last_session", "last_evaluated"),
    [
        pytest.param(date(2026, 11, 4), date(2026, 11, 3), id="wednesday"),
        pytest.param(date(2026, 11, 9), date(2026, 11, 6), id="monday-after-a-weekend"),
        pytest.param(date(2026, 11, 27), date(2026, 11, 25), id="day-after-thanksgiving"),
    ],
)
def test_newest_session_is_not_recorded_until_the_next_session_lands(
    world: World, last_session: date, last_evaluated: date
) -> None:
    tt = date(2026, 11, 2)
    sessions = trading_days(tt + timedelta(days=1), last_session)
    world.fires = Fires(make_fires(sessions, 5))
    world.store.add_shadow(refit_version_id(tt), same_candidate(SEED, tt), tt)

    run_night(world, last_session)

    # Session s is judged on the run after session s+1 lands (D6): the night's own session
    # is left for the next night, and a weekend or a holiday does not make it two.
    recorded = {day for _, day, _ in world.store.records}
    assert last_session not in recorded
    assert max(recorded) == last_evaluated
    assert world.fires.fetch_calls == [(tt, last_evaluated)]
    assert world.fires.feed_calls[0][-1] == last_evaluated


def test_the_night_after_a_shadow_is_built_has_nothing_to_judge(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    creation_world(world, monkeypatch, approve=True)
    run_night(world)
    world.fires.fetch_calls.clear()
    world.fires.feed_calls.clear()

    nxt = sessions_after(LAST_SESSION, 1)[0]
    result = run_night(world, nxt)

    # trained_through is the previous session: the newest one is not yet judged, so there
    # is nothing to fetch, record or decide.
    assert result.counts["waiting"] == 1
    assert world.fires.fetch_calls == [] and world.fires.feed_calls == []
    assert world.store.records == []
    world.notices.assert_not_called()


def test_waits_under_ten_sessions(world: World) -> None:
    # Nine sessions of 600 usable fires each: all evaluated, one short of SHADOW_SESSIONS.
    s = shadow_scenario(world, n_elapsed=9, per_session=600)

    result = run_night(world, s.last_session)

    assert result.counts["waiting"] == 1
    assert result.counts["eval_rows"] == 9 * 600
    assert result.counts["sessions_recorded"] == 9
    assert result.status == "ok"
    assert world.store.rows[s.version]["status"] == "shadow"
    assert "decide" not in world.store.calls
    world.notices.assert_not_called()
    world.rescore.assert_not_called()


def test_sessions_with_no_outcome_yet_are_recorded_empty_and_the_shadow_waits(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=3, per_session=40)
    # `fetch_frame` builds its frame from zero rows (every column object dtype) when no fire
    # of the window has an outcome; the feed still has the fires.
    empty = pd.DataFrame([], columns=list(world.fires.frame.columns))
    monkeypatch.setattr(refit_step, "fetch_frame", lambda conn, start, end: empty)

    result = run_night(world, s.last_session)

    assert result.counts["waiting"] == 1
    assert result.counts["eval_rows"] == 0
    assert result.counts["sessions_recorded"] == 3
    entry = world.store.rows[s.version]["gate_report"]["sessions"][s.elapsed[0].isoformat()]
    assert entry["eval_rows"] == 0
    assert entry["evaluated"] is False
    assert entry["feed_fires"] == 40
    assert np.isnan(entry["rho_candidate"]) and np.isnan(entry["rho_active"])
    world.notices.assert_not_called()


def test_decide_shadow_gets_both_versions_and_the_elapsed_count(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=4, per_session=40, differing=True)
    spy = patch_verdict(monkeypatch, verdict("wait"))

    run_night(world, s.last_session)

    args = arguments_of(spy, decide_shadow)
    assert args["candidate"] == s.candidate
    assert args["active"] == s.active
    assert args["sessions_elapsed"] == 4
    assert sorted(set(args["eval_frame"]["date"])) == s.elapsed
    assert sorted(set(args["feed_frame"]["date"])) == s.elapsed


def test_starved_shadow_is_rejected_once(world: World) -> None:
    # Real gates: 20 elapsed sessions of 30 fires, none evaluated (500 needed).
    s = shadow_scenario(world, n_elapsed=SHADOW_MAX_SESSIONS, per_session=30)

    first = run_night(world, s.last_session)

    row = world.store.rows[s.version]
    assert row["status"] == "rejected"
    assert row["gate_report"]["verdict"]["reasons"] == ["shadow_starved"]
    assert first.counts["rejected"] == 1
    assert first.status == "ok"
    assert world.titles() == ["nightly refit rejected"]
    assert world.notices.call_args.kwargs["fingerprint"] == [
        "nightly-refit",
        "rejected",
        s.version,
    ]

    # The next night there is no shadow: a fresh candidate is built, and the rejected one
    # is neither decided nor announced again.
    second = run_night(world, sessions_after(s.last_session, 1)[0])
    assert world.store.calls.count("decide") == 1
    assert world.store.rows[s.version]["status"] == "rejected"
    assert second.counts["rejected"] == 0
    assert world.titles().count("nightly refit rejected") == 1


def test_a_real_pass_with_promotion_disabled_marks_passed_and_warns(world: World) -> None:
    # Real gates end to end: a candidate that scores like the active ties its rho, and its
    # tier shares sit in the band the active's own cutoffs give.
    s = shadow_scenario(world, n_elapsed=11, per_session=600)

    result = run_night(world, s.last_session)

    row = world.store.rows[s.version]
    assert row["status"] == "passed"
    judged = row["gate_report"]["verdict"]
    assert judged["decision"] == "pass"
    assert judged["sessions"] == [day.isoformat() for day in s.elapsed[:10]]
    assert judged["eval_rows"] == 6_000
    assert result.counts["passed"] == 1
    assert result.counts["eval_rows"] == 6_000
    assert result.counts["sessions_recorded"] == 11
    assert result.status == "ok"
    world.rescore.assert_not_called()
    world.notices.assert_called_once()
    (title,) = world.notices.call_args.args
    kwargs = world.notices.call_args.kwargs
    assert title == "nightly refit passed; promotion disabled"
    assert kwargs["level"] == "warning"
    assert kwargs["fingerprint"] == ["nightly-refit", "passed", s.version]
    # A candidate scoring like the active moved no ticker weight and flipped no sign.
    assert kwargs["extras"]["ticker_weights_changed"] == 0
    assert kwargs["extras"]["flipped_signs"] == []
    assert (
        kwargs["extras"]["rho_candidate"] == kwargs["extras"]["rho_active"] == judged["rho_active"]
    )


def test_pass_with_promotion_disabled_marks_passed_and_warns(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=11, per_session=40, differing=True)
    patch_verdict(monkeypatch, verdict("pass", sessions=s.elapsed[:10]))
    assert constants.PROMOTION_ENABLED is False  # the shipped state

    result = run_night(world, s.last_session)

    assert world.store.rows[s.version]["status"] == "passed"
    # The stored verdict is the whole decision, as plain JSON: dates as ISO text.
    assert world.store.rows[s.version]["gate_report"]["verdict"] == {
        "decision": "pass",
        "reasons": [],
        "sessions": [day.isoformat() for day in s.elapsed[:10]],
        "eval_rows": 6_000,
        "rho_candidate": 0.06,
        "rho_active": 0.05,
        "tier1_ratio": 1.1,
        "tier12_ratio": 0.9,
        "tier1_share": 0.05,
    }
    assert world.store.active == SEED_VERSION
    assert result.counts["passed"] == 1 and result.counts["promoted"] == 0
    world.rescore.assert_not_called()
    kwargs = world.notices.call_args.kwargs
    assert world.titles() == ["nightly refit passed; promotion disabled"]
    assert kwargs["level"] == "warning"
    assert kwargs["tags"] == {
        "service": "nightly",
        "step": "lottery-refit",
        "refit": "passed",
        "version": s.version,
    }
    extras = kwargs["extras"]
    assert extras["reasons"] == []
    assert extras["sessions"] == 10
    assert extras["eval_rows"] == 6_000
    assert extras["rho_candidate"] == 0.06 and extras["rho_active"] == 0.05
    assert extras["tier1_ratio"] == 1.1 and extras["tier12_ratio"] == 0.9
    assert extras["tier1_share"] == 0.05
    # Aggregates about the change: how many ticker weights moved and which signs flipped,
    # never which tickers (D9), and the feed cutoffs before and after.
    assert extras["ticker_weights_changed"] == 2
    assert extras["flipped_signs"] == ["C/P", "DTE0"]
    assert extras["feed_tier1_before"] == s.active["feed_cutoffs"]["tier1_min_score"]
    assert extras["feed_tier2_before"] == s.active["feed_cutoffs"]["tier2_min_score"]
    assert extras["feed_tier1_after"] == s.candidate["feed_cutoffs"]["tier1_min_score"]
    assert extras["feed_tier2_after"] == s.candidate["feed_cutoffs"]["tier2_min_score"]
    assert_plain(extras)
    blob = json.dumps(extras)
    for ticker in TICKERS:
        assert ticker not in blob


def test_pass_promotes_in_one_call_and_warns(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    s = promote_ready(world, monkeypatch)
    ctx = make_ctx(s.last_session)

    result = refit_step.run(ctx)

    world.rescore.assert_called_once()
    assert world.rescore.call_args.args == (CONN,)
    assert world.rescore.call_args.kwargs == {
        "to_version": s.version,
        "weights": s.candidate,
        "reason": "promotion",
        "expect_active": SEED_VERSION,
        "dry_run": False,
        "deadline": ctx.deadline,
    }
    # The promotion transaction marks the version and moves the pointer; the step does
    # neither itself (a `decide` would also have to find a shadow).
    assert "decide" not in world.store.calls
    assert world.store.rows[s.version]["status"] == "promoted"
    assert world.store.active == s.version
    assert result.status == "ok"
    assert result.counts["promoted"] == 1
    assert result.counts["rows_rescored"] == RESCORED.changed
    assert result.counts["passed"] == 0 and result.counts["promotion_deferred"] == 0
    assert world.titles() == ["nightly refit promoted"]
    kwargs = world.notices.call_args.kwargs
    assert kwargs["level"] == "warning"
    assert kwargs["fingerprint"] == ["nightly-refit", "promoted", s.version]
    assert kwargs["extras"]["rows_rescored"] == RESCORED.changed
    assert kwargs["extras"]["scores_changed"] == RESCORED.score_changed
    assert_plain(kwargs["extras"])


@pytest.mark.parametrize(
    "now_utc",
    [
        pytest.param(datetime(2026, 11, 12, 12, 30, tzinfo=UTC), id="at-the-cutoff"),
        pytest.param(datetime(2026, 11, 12, 15, 0, tzinfo=UTC), id="afternoon"),
        pytest.param(
            datetime(2026, 11, 12, 8, 0, tzinfo=ZoneInfo("America/New_York")),
            id="08:00-ET-is-13:00-UTC",
        ),
    ],
)
def test_promotion_after_cutoff_is_deferred_partial(
    world: World, monkeypatch: pytest.MonkeyPatch, now_utc: datetime
) -> None:
    s = promote_ready(world, monkeypatch)

    result = run_night(world, s.last_session, now_utc=now_utc)

    world.rescore.assert_not_called()
    assert world.store.rows[s.version]["status"] == "shadow"
    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    assert result.counts["promotion_deferred"] == 1
    assert result.counts["promoted"] == 0
    world.notices.assert_not_called()


def test_promotion_a_minute_before_the_cutoff_goes_ahead(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = promote_ready(world, monkeypatch)

    result = run_night(
        world, s.last_session, now_utc=datetime(2026, 11, 12, 12, 29, 59, tzinfo=UTC)
    )

    assert result.counts["promoted"] == 1
    assert time(12, 30) == constants.PROMOTION_CUTOFF_UTC


@pytest.mark.parametrize(
    ("seconds_left", "promotes"),
    [
        (constants.PROMOTION_MIN_SECONDS - 1, False),
        (constants.PROMOTION_MIN_SECONDS, True),
    ],
)
def test_promotion_with_little_time_left_is_deferred(
    world: World, monkeypatch: pytest.MonkeyPatch, seconds_left: float, promotes: bool
) -> None:
    s = promote_ready(world, monkeypatch)

    result = run_night(world, s.last_session, seconds_left=seconds_left)

    assert (world.rescore.call_count == 1) is promotes
    assert result.counts["promoted"] == int(promotes)
    assert result.counts["promotion_deferred"] == int(not promotes)
    assert result.status == ("ok" if promotes else "partial")
    assert world.store.rows[s.version]["status"] == ("promoted" if promotes else "shadow")


@pytest.mark.parametrize(
    "error",
    [
        RescoreDeadline("the deadline passed before a page"),
        psycopg2.errors.LockNotAvailable("canceling statement due to lock timeout"),
    ],
    ids=["deadline", "lock-timeout"],
)
def test_rescore_deadline_defers_the_promotion(
    world: World, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    s = promote_ready(world, monkeypatch)
    world.rescore.side_effect = error
    ctx = make_ctx(s.last_session)

    result = refit_step.run(ctx)

    # The rescore rolled back whole: the version stays a shadow for the next night.
    assert world.store.rows[s.version]["status"] == "shadow"
    assert world.store.active == SEED_VERSION
    assert result.counts["promotion_deferred"] == 1
    assert result.counts["promoted"] == 0
    assert result.counts["rows_rescored"] == 0
    assert result.status == "partial"
    assert result.detail == PARTIAL_DETAIL
    world.notices.assert_not_called()
    # One attempt, never retried: `is_retryable_db_error` would treat a lock timeout as
    # transient and run the rescore again (carry f).
    assert world.rescore.call_count == 1
    assert world.rescore.call_args.kwargs["deadline"] == ctx.deadline
    assert "decide" not in world.store.calls


@pytest.mark.parametrize(
    "error",
    [PointerMoved("the active pointer names x"), ConcurrentScoreWriter("1 of 500 changed")],
)
def test_a_moved_pointer_or_a_concurrent_writer_fails_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    s = promote_ready(world, monkeypatch)
    world.rescore.side_effect = error

    with pytest.raises(type(error)):
        run_night(world, s.last_session)

    # Rolled back and left a shadow, no notice: the runner's Sentry exception is the alert.
    assert world.store.rows[s.version]["status"] == "shadow"
    world.notices.assert_not_called()
    assert world.rescore.call_count == 1


def test_reject_after_shadow_errors_with_version_fingerprint(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=11, per_session=40, differing=True)
    # The gate's own order (rho, tier1 band, then the ratios), which is not alphabetical
    # ("tier12" sorts before "tier1_"): the notice and the stored verdict keep it (carry c).
    reasons = (
        "rho_below_active",
        "tier1_share_out_of_band",
        "tier1_ratio_out_of_band",
        "tier12_ratio_out_of_band",
    )
    patch_verdict(monkeypatch, verdict("reject", reasons, sessions=s.elapsed[:10]))

    result = run_night(world, s.last_session)

    assert world.store.rows[s.version]["status"] == "rejected"
    assert world.store.rows[s.version]["gate_report"]["verdict"]["reasons"] == list(reasons)
    assert result.counts["rejected"] == 1
    assert result.status == "ok"
    world.rescore.assert_not_called()
    world.notices.assert_called_once()
    (title,) = world.notices.call_args.args
    kwargs = world.notices.call_args.kwargs
    assert title == "nightly refit rejected"
    assert kwargs["level"] == "error"
    assert kwargs["fingerprint"] == ["nightly-refit", "rejected", s.version]
    assert kwargs["tags"]["version"] == s.version
    assert kwargs["extras"]["reasons"] == list(reasons)
    assert_plain(kwargs["extras"])


def test_a_decision_another_run_already_made_sends_nothing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=11, per_session=40)
    patch_verdict(monkeypatch, verdict("reject", ("rho_below_active",), sessions=s.elapsed[:10]))
    monkeypatch.setattr(refit_step, "decide", lambda *a, **k: False)

    result = run_night(world, s.last_session)

    assert result.counts["rejected"] == 0
    world.notices.assert_not_called()


def test_a_session_recorded_by_another_run_counts_nothing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # record_session_eval answers False for a session already recorded (carry g).
    s = shadow_scenario(world, n_elapsed=3, per_session=40)
    monkeypatch.setattr(refit_step, "record_session_eval", lambda *a, **k: False)

    result = run_night(world, s.last_session)

    assert result.counts["sessions_recorded"] == 0
    assert result.counts["waiting"] == 1
    world.notices.assert_not_called()


def test_a_judged_session_without_feed_rows_fails_the_step(world: World) -> None:
    # A missing day must fail loudly, never shrink the average (carry a): real gates, ten
    # evaluated sessions, the feed frame has nothing for the third.
    s = shadow_scenario(world, n_elapsed=11, per_session=600)
    world.fires.feed_missing = {s.elapsed[2]}

    with pytest.raises(ValueError, match="no rows for session"):
        run_night(world, s.last_session)

    row = world.store.rows[s.version]
    assert row["status"] == "shadow"
    assert "sessions" not in row["gate_report"]  # nothing half-recorded
    world.notices.assert_not_called()


def test_an_unknown_tod_in_any_session_fails_the_step(world: World) -> None:
    # The 11th session is not one of the ten judged, and still fails the step (carry b).
    s = shadow_scenario(world, n_elapsed=11, per_session=600)
    frame = world.fires.frame
    last = frame.index[frame["date"] == s.elapsed[-1]][0]
    frame.loc[last, "tod"] = "PREMARKET"

    with pytest.raises(ValueError, match="tod"):
        run_night(world, s.last_session)

    assert world.store.rows[s.version]["status"] == "shadow"
    world.notices.assert_not_called()


def test_a_shadow_without_a_training_date_fails_the_step(world: World) -> None:
    world.store.add_shadow("refit-2026-10-01", same_candidate(SEED, SHADOW_TT), SHADOW_TT)
    world.store.rows["refit-2026-10-01"]["trained_through"] = None

    with pytest.raises(ValueError, match="trained_through"):
        run_night(world)


def test_a_database_error_while_judging_fails_the_step(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = shadow_scenario(world, n_elapsed=3, per_session=40)

    def lost(*args: Any, **kwargs: Any) -> bool:
        raise psycopg2.OperationalError("connection lost")

    monkeypatch.setattr(refit_step, "record_session_eval", lost)

    with pytest.raises(psycopg2.OperationalError):
        run_night(world, s.last_session)

    world.notices.assert_not_called()


# --- counts, logs, the pointer ---------------------------------------------------


def test_counts_are_the_documented_names_as_plain_ints(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = promote_ready(world, monkeypatch)

    result = run_night(world, s.last_session)

    assert set(result.counts) == COUNT_NAMES
    for name, value in result.counts.items():
        assert type(value) is int, name  # steps._is_count refuses a numpy integer


def test_logs_carry_no_ticker_or_weight(
    world: World, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    s = promote_ready(world, monkeypatch)
    run_night(world, s.last_session)
    # The promoted version is now the active one; the next night builds against it.
    creation_world(world, monkeypatch, approve=True)
    run_night(world, LAST_SESSION)

    own = [r for r in caplog.records if r.name == "refit_step"]
    assert len(own) == 2  # one line per run
    first = own[0].getMessage()
    assert s.version in first and "promoted" in first
    assert "rows_rescored=640" in first
    assert f"refit-{LAST_SESSION.isoformat()}" in own[1].getMessage()
    text = "\n".join(r.getMessage() for r in caplog.records)
    for ticker in SEED["features"]["ticker_weights"]:
        assert not re.search(rf"\b{ticker}\b", text), ticker
    assert "weights" not in text and "features" not in text


def _string_constants(tree: ast.Module) -> list[str]:
    """Every string literal in the module that is not a docstring."""
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_never_moves_the_takeit_pointer(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    # Statically: the module's only SQL is the feed SELECT, and it never names a pointer.
    # Only `rescore_all`'s promotion transaction moves `active`; nothing moves `takeit`.
    tree = ast.parse(Path(refit_step.__file__).read_text(encoding="utf-8"))
    literals = _string_constants(tree)
    assert not [s for s in literals if "takeit" in s.lower()]
    assert not [s for s in literals if "lottery_score_pointers" in s]
    sql = [s for s in literals if re.search(r"\b(select|update|insert|delete)\b", s, re.I)]
    assert sql, "the scan found no SQL: fetch_feed_frame holds one"
    assert all(s.lstrip().upper().startswith("SELECT ") for s in sql), sql

    # Dynamically: a whole promotion leaves the Take-It pointer where it was.
    s = promote_ready(world, monkeypatch)
    run_night(world, s.last_session)
    assert world.store.active == s.version
    assert world.store.takeit == SEED_VERSION
    assert "pin_active" not in world.rescore.call_args.kwargs


def test_the_rescore_is_never_wrapped_in_a_retry() -> None:
    # `_pipeline_retry.is_retryable_db_error` treats every OperationalError, a lock timeout
    # included, as transient: a retried promotion would hold the pointer lock twice (carry f).
    tree = ast.parse(Path(refit_step.__file__).read_text(encoding="utf-8"))
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            names += [node.module or "", *(alias.name for alias in node.names)]
        elif isinstance(node, ast.Name):
            names.append(node.id)
        elif isinstance(node, ast.Attribute):
            names.append(node.attr)
    assert names, "the scan read no names"
    assert not [n for n in names if "retry" in n.lower()]


def test_promotion_ships_disabled_with_a_floor_inside_the_budget() -> None:
    assert constants.PROMOTION_ENABLED is False
    assert 0 < constants.PROMOTION_MIN_SECONDS < constants.REFIT_BUDGET_SECONDS
    assert constants.REFIT_STEP_NAME == "lottery-refit"


# --- fetch_feed_frame ------------------------------------------------------------


class FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]], error: Exception | None = None) -> None:
        self.rows = rows
        self.error = error
        self.executed: list[tuple[str, Any]] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        self.executed.append((sql, params))
        if self.error is not None:
            raise self.error

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> FakeCursor:
        return self._cursor


def _feed_row(day: date, *, gated: bool | None = False) -> tuple[Any, ...]:
    """One row in FEED_COLUMNS order, NUMERICs as psycopg2 returns them (Decimal)."""
    values: dict[str, Any] = {
        "underlying_symbol": "AAPL",
        "option_type": "C",
        "tod": "MID",
        "dte": Decimal("0"),
        "trigger_vol_to_oi_window": Decimal("0.2500"),
        "gamma_at_trigger": None,
        "trigger_ask_pct": Decimal("0.7"),
        "cum_ncp_at_fire": Decimal("120.5"),
        "cum_npp_at_fire": Decimal("80"),
        "date": day,
        "round_trip_score_deduct": None,
        "fire_count_score_adjustment": Decimal("-2"),
        "direction_gated": gated,
        "inversion_quintile": Decimal("4"),
    }
    return tuple(values[column] for column in FEED_COLUMNS)


def test_fetch_feed_frame_reads_the_feed_columns_for_those_sessions() -> None:
    days = [date(2026, 11, 9), date(2026, 11, 10)]
    cursor = FakeCursor([_feed_row(days[0]), _feed_row(days[1], gated=None)])

    frame = fetch_feed_frame(FakeConnection(cursor), days)

    assert list(frame.columns) == list(FEED_COLUMNS)
    assert len(frame) == 2
    (sql, params) = cursor.executed[0]
    assert params == (days,)  # one date[] parameter, a list (psycopg2 sends a list as ARRAY)
    assert "LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol" in sql
    assert "f.date = ANY(%s::date[])" in sql
    assert "s.inversion_quintile" in sql
    for column in ("dte", "gamma_at_trigger", "cum_ncp_at_fire", "inversion_quintile"):
        assert frame[column].dtype == "float64", column
    assert frame["gamma_at_trigger"].isna().all()
    assert frame["fire_count_score_adjustment"].tolist() == [-2.0, -2.0]
    # The flag is not a number: it stays as the database gave it, a NULL included.
    assert frame["direction_gated"].tolist() == [False, None]
    assert frame["date"].tolist() == days
    assert list(frame["underlying_symbol"]) == ["AAPL", "AAPL"]
    # The frame feeds the real feed arithmetic as it is, a NULL gate included.
    scores = score_frame(SEED, frame)
    assert len(feed_qas(scores, frame)) == 2


def test_fetch_feed_frame_with_no_fires_is_an_empty_frame_with_the_columns() -> None:
    frame = fetch_feed_frame(FakeConnection(FakeCursor([])), [date(2026, 11, 9)])

    assert list(frame.columns) == list(FEED_COLUMNS)
    assert frame.empty


def test_fetch_feed_frame_lets_a_database_error_through() -> None:
    cursor = FakeCursor([], error=psycopg2.OperationalError("connection lost"))

    with pytest.raises(psycopg2.OperationalError):
        fetch_feed_frame(FakeConnection(cursor), [date(2026, 11, 9)])
