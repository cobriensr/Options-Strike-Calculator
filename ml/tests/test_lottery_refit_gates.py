"""Tests for ml/src/lottery_refit_gates.py: the nightly refit's gates.

The module decides whether a candidate lottery-weights version is built, waits,
passes or is rejected. These tests pin each gate on hand-built frames whose
answers are worked out in the comments, and tie the two mirrors (the inversion
bonus map and the feed's displayed-score SQL) to the TypeScript text they copy.

Every input is synthetic. Nothing reaches a database. This file needs no scipy,
so the nightly CI job can run it; the scipy comparison is in
test_lottery_refit_gates_scipy.py.

Two frames drive ``decide_shadow``:

* the eval frame holds fires of tickers T0..T4 whose outcome rises with the
  ticker's number, so weights ``T0=0 .. T4=4`` rank them well and the reversed
  weights rank them badly;
* the feed frame holds fires of tickers AAA..EEE only, 32 a day, so the tier
  shares are known counts of 32 (dyadic, so ratios like 1.5 come out exact).

The two ticker sets do not overlap, so a test can change the rho (through the T
weights) without moving a tier share, and the reverse (through the feed
tickers' weights).
"""

import copy
import json
import math
import re
import subprocess
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import lottery_refit_gates as g
import lottery_weights as lw

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "ml" / "src"
SEED_WEIGHTS = json.loads(
    (ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)["weights"]

NAN = float("nan")

# ── Builders ────────────────────────────────────────────────────────────────

EVAL_TICKERS = ("T0", "T1", "T2", "T3", "T4")
GOOD_EVAL = {"T0": 0, "T1": 1, "T2": 2, "T3": 3, "T4": 4}  # follows the outcome
BAD_EVAL = {"T0": 4, "T1": 3, "T2": 2, "T3": 1, "T4": 0}  # reverses it
FLAT_EVAL = dict.fromkeys(EVAL_TICKERS, 1)  # every fire scores the same

# Feed tickers: weights chosen so that, with cutoffs (7, 3) on qas, tier1 is the
# AAA fires and tier1+2 the AAA and BBB fires.
FEED_BASE = {"AAA": 8, "BBB": 4, "CCC": 0, "DDD": 0, "EEE": 0}
FEED_PER_DAY = {"AAA": 2, "BBB": 2, "DDD": 2, "EEE": 1, "CCC": 25}  # 32 a day
FEED_CUTOFFS = (7, 3)
# Base shares per day: tier1 2/32 = 0.0625, tier1+2 4/32 = 0.125.

VERSION_SHADOW = "refit-2026-03-02"
VERSION_ACTIVE = "seed-2026-06-17"


def trading_days(n: int, start: date = date(2026, 3, 2)) -> list[date]:
    days: list[date] = []
    day = start
    while len(days) < n:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


def make_weights(
    eval_weights: dict,
    feed_weights: dict,
    *,
    cutoffs: tuple[int, int] = FEED_CUTOFFS,
    version: str = VERSION_SHADOW,
) -> dict:
    """A valid weights object that scores by ticker alone."""
    w = copy.deepcopy(SEED_WEIGHTS)
    f = w["features"]
    f["ticker_weights"] = {**eval_weights, **feed_weights}
    f["tod_weights"] = dict.fromkeys(f["tod_weights"], 0)
    f["tod_weights_dow_overrides"] = {}
    f["dte_weights"] = dict.fromkeys(f["dte_weights"], 0)
    for stem in ("vol_oi", "gamma", "ask_pct"):
        f[f"{stem}_quintile_weights"] = [0] * 5
    f["option_type_weights"] = {"C": 0, "P": 0}
    f["composite_bonuses"] = []
    w["model_version"] = version
    w["trained_through"] = "2026-03-01"
    w["feed_cutoffs"] = {
        "tier1_min_score": cutoffs[0],
        "tier2_min_score": cutoffs[1],
    }
    return w


def _score_columns(symbols, day) -> dict:
    """An aligned Wednesday-or-not call fire per symbol; the weights above ignore
    everything but the ticker."""
    return {
        "underlying_symbol": symbols,
        "option_type": "C",
        "tod": "MID",
        "dte": 0,
        "trigger_vol_to_oi_window": 1.0,
        "gamma_at_trigger": 0.1,
        "trigger_ask_pct": 0.5,
        "cum_ncp_at_fire": 2.0,
        "cum_npp_at_fire": 1.0,
        "date": day,
    }


def make_eval_frame(rows_per_session, bad_sessions=(), seed=7) -> pd.DataFrame:
    """Eval fires: ``rows_per_session[i]`` on the i-th trading day, tickers T0..T4
    in turn. The outcome rises 10 points per ticker number (falls, for a session
    in ``bad_sessions``), plus noise."""
    rng = np.random.default_rng(seed)
    parts = []
    days = trading_days(len(rows_per_session))
    for i, (day, n) in enumerate(zip(days, rows_per_session)):
        idx = np.arange(n) % len(EVAL_TICKERS)
        slope = -10.0 if i in bad_sessions else 10.0
        frame = pd.DataFrame(
            _score_columns(np.array(EVAL_TICKERS, dtype=object)[idx], day)
        )
        frame["outcome_pct"] = slope * idx + rng.normal(0.0, 3.0, n)
        parts.append(frame)
    if not parts:
        return _empty_frame((*lw.SCORE_COLUMNS, "outcome_pct"))
    return pd.concat(parts, ignore_index=True)


def make_feed_frame(days, per_day=None) -> pd.DataFrame:
    """Feed fires: ``per_day`` maps ticker to its count on each of ``days``."""
    per_day = FEED_PER_DAY if per_day is None else per_day
    symbols = [s for s, k in per_day.items() for _ in range(k)]
    parts = []
    for day in days:
        frame = pd.DataFrame(_score_columns(symbols, day))
        frame["round_trip_score_deduct"] = 0
        frame["direction_gated"] = False
        frame["inversion_quintile"] = 3  # bonus 0
        parts.append(frame)
    if not parts:
        return _empty_frame(g.FEED_COLUMNS)
    return pd.concat(parts, ignore_index=True)


def _empty_frame(columns) -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series([], dtype="object") for c in columns})


def run(
    *,
    candidate_eval=GOOD_EVAL,
    active_eval=GOOD_EVAL,
    candidate_feed=None,
    active_feed=None,
    candidate_cutoffs=FEED_CUTOFFS,
    active_cutoffs=FEED_CUTOFFS,
    rows=(500,) * 10,
    bad_sessions=(),
    elapsed=10,
    eval_frame=None,
    feed_frame=None,
) -> g.ShadowVerdict:
    candidate = make_weights(
        candidate_eval,
        {**FEED_BASE, **(candidate_feed or {})},
        cutoffs=candidate_cutoffs,
        version=VERSION_SHADOW,
    )
    active = make_weights(
        active_eval,
        {**FEED_BASE, **(active_feed or {})},
        cutoffs=active_cutoffs,
        version=VERSION_ACTIVE,
    )
    return g.decide_shadow(
        eval_frame=make_eval_frame(rows, bad_sessions)
        if eval_frame is None
        else eval_frame,
        feed_frame=make_feed_frame(trading_days(len(rows)))
        if feed_frame is None
        else feed_frame,
        candidate=candidate,
        active=active,
        sessions_elapsed=elapsed,
    )


# ── Constants ───────────────────────────────────────────────────────────────


def test_gate_constants_match_the_plans_table():
    # docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md, "Gate numbers".
    assert g.TRAIN_WINDOW_DAYS == 90
    assert g.MIN_TRAIN_ROWS == 30_000
    assert g.MIN_TRAIN_SESSIONS == 30
    assert g.SHADOW_SESSIONS == 10
    assert g.SHADOW_MAX_SESSIONS == 20
    assert g.MIN_EVAL_ROWS_PER_SESSION == 500  # re-measured 2026-11-14 (was 300)
    assert g.MIN_EVAL_ROWS == 5_000
    assert g.TIER_SHARE_RATIO_BAND == (0.67, 1.5)
    assert g.TIER1_SHARE_BAND == (0.01, 0.15)
    assert g.FEED_CUTOFF_MATCH_SESSIONS == 20
    assert g.FEED_CUTOFF_SEARCH_MAX == 40
    assert g.FEED_CUTOFF_FLOOR == 8  # one above the largest NULL-score qas: bonus 5 + 2


def test_feed_columns_extend_the_score_columns():
    assert g.FEED_COLUMNS == lw.SCORE_COLUMNS + (
        "round_trip_score_deduct",
        "direction_gated",
        "inversion_quintile",
    )
    # The fire-count score adjustment was retired on 2026-11-15 and its column
    # is dropped by migration #209, so a SELECT built from FEED_COLUMNS must
    # not name it.
    assert "fire_count_score_adjustment" not in g.FEED_COLUMNS


def test_inversion_bonus_matches_the_ts_map():
    text = (ROOT / "api" / "_lib" / "lottery-inversion-bonus.ts").read_text(
        encoding="utf-8"
    )
    block = re.search(r"INVERSION_BONUS_BY_QUINTILE[^=]*=\s*\{(.*?)\}\s*;", text, re.S)
    assert block is not None, "the TS map moved or changed shape"
    ts_map = {int(k): int(v) for k, v in re.findall(r"(\d+)\s*:\s*(-?\d+)", block[1])}
    assert ts_map == g.INVERSION_BONUS
    # The CASE expression the feed splices into its SQL carries the same table.
    case_sql = {int(k): int(v) for k, v in re.findall(r"WHEN (\d+) THEN (-?\d+)", text)}
    assert case_sql == g.INVERSION_BONUS


def test_feed_qas_mirrors_the_feeds_displayed_score_sql():
    # `qasExprText` in api/lottery-finder.ts is what feed_qas copies. If its text
    # changes, this test fails first and the mirror must follow.
    text = (ROOT / "api" / "lottery-finder.ts").read_text(encoding="utf-8")
    start = text.index("function qasExprText(")
    body = text[start : text.index("\n}\n", start)]
    for fragment in (
        "(GREATEST(0, COALESCE(${fireAlias}score, 0) ",
        "+ COALESCE(${fireAlias}round_trip_score_deduct, 0)) ",
        "+ ${INVERSION_BONUS_CASE_SQL})",
    ):
        assert fragment in body
    # No fire-count term: the adjustment was retired on 2026-11-15.
    assert "fire_count" not in body


def test_module_imports_without_scipy_or_utils():
    # The nightly image gets this file and lottery_weights.py, plus numpy and
    # pandas. A subprocess in isolated mode (-I: no PYTHONPATH, no cwd on
    # sys.path) shows what the import itself pulls in.
    probe = (
        "import json, os, sys\n"
        "src = sys.argv[1]\n"
        "sys.path.insert(0, src)\n"
        "import lottery_refit_gates\n"
        "own = sorted(\n"
        "    name for name, mod in sys.modules.items()\n"
        "    if name != 'lottery_refit_gates'\n"
        "    and getattr(mod, '__file__', None)\n"
        "    and os.path.abspath(mod.__file__).startswith(os.path.abspath(src))\n"
        ")\n"
        "print(json.dumps({\n"
        "    'scipy': 'scipy' in sys.modules,\n"
        "    'utils': 'utils' in sys.modules,\n"
        "    'siblings': own,\n"
        "}))\n"
    )
    out = subprocess.run(
        [sys.executable, "-I", "-c", probe, str(SRC_DIR)],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    assert json.loads(out.stdout.strip().splitlines()[-1]) == {
        "scipy": False,
        "utils": False,
        "siblings": ["lottery_weights"],
    }


# ── in_band ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "inside"),
    [
        (0.67, True),  # the lower edge is inside
        (1.5, True),  # the upper edge is inside
        (1.0, True),
        (0.66, False),
        (1.51, False),
        (math.inf, False),
        (NAN, False),  # an undefined number is never in a band
    ],
)
def test_ratio_band_edges(value, inside):
    assert g.in_band(value, g.TIER_SHARE_RATIO_BAND) is inside


@pytest.mark.parametrize(
    ("value", "inside"),
    [(0.01, True), (0.15, True), (0.0099, False), (0.1501, False), (NAN, False)],
)
def test_share_band_edges(value, inside):
    assert g.in_band(value, g.TIER1_SHARE_BAND) is inside


# ── spearman ────────────────────────────────────────────────────────────────

# (x, y, rho). The rho values were computed once with scipy 1.17.1:
# stats.spearmanr(x, y, nan_policy="omit").statistic. The NaN cases drop the
# pairs with a NaN on either side. No scipy is needed to run them.
SPEARMAN_KNOWN = [
    ("perfect rise", [1, 2, 3, 4, 5], [10, 20, 30, 40, 50], 1.0),
    ("perfect fall", [1, 2, 3, 4, 5], [50, 40, 30, 20, 10], -1.0),
    ("ties in x", [1, 1, 2, 3, 3], [1, 2, 3, 4, 5], 0.9486832980505137),
    ("ties in both", [1, 2, 2, 3, 3, 3], [4, 4, 5, 6, 6, 7], 0.9057894597833127),
    (
        "textbook ten",
        [106, 86, 100, 101, 99, 103, 97, 113, 112, 110],
        [7, 0, 27, 50, 28, 29, 20, 12, 6, 17],
        -0.17575757575757575,
    ),
    ("NaN in x", [1, NAN, 3, 4, 5, 6], [2, 1, 4, 3, 6, 5], 0.7999999999999998),
    (
        "NaN on both sides, different rows",
        [1, NAN, 3, 4, 5, 6, 7],
        [2, 1, NAN, 3, 6, 5, 7],
        0.8999999999999998,
    ),
    (
        "NaN and ties",
        [3, 3, NAN, 1, 2, 2, 5, NAN, 4],
        [10, 20, 30, NAN, 20, 40, 50, 60, 50],
        0.5454545454545455,
    ),
    ("one huge outlier", [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 5000], 1.0),
    ("an infinity", [1, 2, 3, math.inf, 5], [1, 3, 2, 4, 5], 0.7999999999999999),
    ("weak", [5, 1, 4, 2, 3, 8, 7, 6], [1, 6, 3, 8, 2, 4, 5, 7], -0.19047619047619052),
]


@pytest.mark.parametrize(
    ("x", "y", "expected"),
    [case[1:] for case in SPEARMAN_KNOWN],
    ids=[case[0] for case in SPEARMAN_KNOWN],
)
def test_spearman_known_answers(x, y, expected):
    got = g.spearman(pd.Series(x, dtype="float64"), pd.Series(y, dtype="float64"))
    assert got == pytest.approx(expected, abs=1e-12)
    assert type(got) is float


@pytest.mark.parametrize(
    ("x", "y"),
    [
        ([1, 1, 1, 1], [1, 2, 3, 4]),  # x is constant
        ([1, 2, 3, 4], [5, 5, 5, 5]),  # y is constant
        ([1, 2], [3, 4]),  # two rows
        ([1.0], [1.0]),
        ([], []),
        ([1, 2, 3, NAN], [4, NAN, 6, 7]),  # two complete pairs left
        ([NAN, NAN, NAN], [1, 2, 3]),
        ([1, 2, 3, NAN], [7, 7, 7, 1]),  # constant on the complete pairs
    ],
    ids=[
        "constant x",
        "constant y",
        "two rows",
        "one row",
        "empty",
        "two pairs after NaN",
        "all NaN in x",
        "constant after NaN",
    ],
)
def test_spearman_nan_on_constant_or_tiny(x, y):
    assert math.isnan(
        g.spearman(pd.Series(x, dtype="float64"), pd.Series(y, dtype="float64"))
    )


def test_spearman_three_rows_is_enough():
    assert g.spearman(pd.Series([1, 2, 3]), pd.Series([1, 3, 2])) == pytest.approx(0.5)


def test_spearman_reads_positions_dtypes_and_decimals_not_labels():
    expected = g.spearman(
        pd.Series([3.5, 1.5, 2.5, 0.5, 4.5]), pd.Series([10.0, 30.0, 20.0, 5.0, 40.0])
    )
    # Index labels that disagree, so a label join would scramble the pairs.
    x = pd.Series([3.5, 1.5, 2.5, 0.5, 4.5], index=[4, 3, 2, 1, 0])
    y = pd.Series([10.0, 30.0, 20.0, 5.0, 40.0], index=[0, 1, 2, 3, 4])
    assert g.spearman(x, y) == expected
    # The Int64 a gated-aware score comes in, with a <NA>, and Decimal from NUMERIC.
    scores = pd.Series([3, 1, pd.NA, 0, 4, 2], dtype="Int64")
    outcomes = pd.Series(
        [Decimal("10"), Decimal("30"), Decimal("99"), Decimal("5"), None, Decimal("20")]
    )
    # Pairs left: (3,10) (1,30) (0,5) (2,20).
    assert g.spearman(scores, outcomes) == pytest.approx(
        g.spearman(pd.Series([3, 1, 0, 2]), pd.Series([10, 30, 5, 20]))
    )


def test_spearman_is_symmetric_and_ignores_monotone_changes():
    rng = np.random.default_rng(11)
    x = pd.Series(rng.integers(0, 6, 400).astype(float))  # lots of ties
    y = pd.Series(rng.normal(size=400))
    rho = g.spearman(x, y)
    assert g.spearman(y, x) == pytest.approx(rho, abs=1e-12)
    assert g.spearman(x, np.exp(y)) == pytest.approx(rho, abs=1e-12)
    assert g.spearman(-x, y) == pytest.approx(-rho, abs=1e-12)
    assert -1.0 <= rho <= 1.0


def test_spearman_refuses_unequal_lengths():
    with pytest.raises(ValueError, match="same length"):
        g.spearman(pd.Series([1, 2, 3]), pd.Series([1, 2]))


# ── feed_qas ────────────────────────────────────────────────────────────────


def _sql_qas(score, round_trip, quintile) -> int:
    """The feed's displayed score for one row, transliterated from the SQL in
    api/lottery-finder.ts qasExprText: GREATEST(0, COALESCE(score, 0) +
    COALESCE(round_trip_score_deduct, 0)) + CASE inversion_quintile ... ELSE 0
    END."""
    base = max(0, (score or 0) + (round_trip or 0))
    return base + {1: -5, 2: -2, 3: 0, 4: 3, 5: 5}.get(quintile, 0)


def _feed(rows: list[dict]) -> pd.DataFrame:
    """A feed frame from rows of (round_trip_score_deduct, direction_gated,
    inversion_quintile); the score columns hold placeholders, because feed_qas
    takes the scores as its own argument."""
    frame = pd.DataFrame(_score_columns(["AAA"] * len(rows), date(2026, 3, 2)))
    for column in (
        "round_trip_score_deduct",
        "direction_gated",
        "inversion_quintile",
    ):
        frame[column] = [r.get(column) for r in rows]
    return frame


def _row(rt=0, gated=False, quintile=3) -> dict:
    return {
        "round_trip_score_deduct": rt,
        "direction_gated": gated,
        "inversion_quintile": quintile,
    }


def test_feed_qas_forces_tier3_rows():
    feed = _feed(
        [
            _row(quintile=4),  # 0 normal: 10 + 3
            _row(quintile=5),  # 1 score <NA>: forced
            _row(gated=True, quintile=5),  # 2 direction gated: forced
            _row(quintile=1),  # 3 quintile 1: forced
            _row(quintile=2),  # 4 quintile 2: forced
            _row(quintile=3),  # 5 quintile 3: 10 + 0
            _row(quintile=None),  # 6 cold-start ticker: 10 + 0, not forced
            _row(gated=None, quintile=5),  # 7 NULL gate reads as not gated: 10 + 5
        ]
    )
    feed["direction_gated"] = feed["direction_gated"].astype("object")
    scores = pd.Series([10, pd.NA, 10, 10, 10, 10, 10, 10], dtype="Int64")
    qas = g.feed_qas(scores, feed)
    assert qas.dtype == "float64"
    assert qas.index.equals(feed.index)
    assert qas.isna().tolist() == [False, True, True, True, True, False, False, False]
    assert qas.dropna().tolist() == [13.0, 10.0, 10.0, 15.0]


@pytest.mark.parametrize("dtype", ["bool", "boolean", "object"])
def test_feed_qas_reads_the_gate_in_any_boolean_dtype(dtype):
    feed = _feed([_row(gated=False), _row(gated=True), _row(gated=False)])
    feed["direction_gated"] = feed["direction_gated"].astype(dtype)
    qas = g.feed_qas(pd.Series([5, 5, 5], dtype="Int64"), feed)
    assert qas.isna().tolist() == [False, True, False]


def test_feed_qas_floors_at_zero_before_the_bonus():
    feed = _feed(
        [
            _row(rt=-3, quintile=5),  # 2 - 3 = -1 -> 0, then +5 = 5 (not 4)
            _row(rt=-3, quintile=4),  # 0 + 3 = 3 (not 2)
            _row(rt=-3, quintile=3),  # 2 - 3 = -1 -> 0
            _row(rt=-1, quintile=3),  # 2 - 1 = 1: the floor does not touch it
        ]
    )
    qas = g.feed_qas(pd.Series([2, 2, 2, 2], dtype="Int64"), feed)
    assert qas.tolist() == [5.0, 3.0, 0.0, 1.0]


def test_feed_qas_reads_a_null_deduct_and_odd_quintiles_as_zero():
    # COALESCE(x, 0) on the deduct, and CASE ... ELSE 0 on a quintile outside
    # 1..5 (0, 6, a fraction): none of them changes the score.
    feed = _feed(
        [
            _row(rt=None, quintile=3),
            _row(rt=-1, quintile=3),
            _row(quintile=0),
            _row(quintile=6),
            _row(quintile=3.5),
        ]
    )
    qas = g.feed_qas(pd.Series([7] * 5, dtype="Int64"), feed)
    assert qas.tolist() == [7.0, 6.0, 7.0, 7.0, 7.0]


def test_feed_qas_ignores_a_fire_count_adjustment_column():
    # The fire-count score adjustment was retired on 2026-11-15: the qas does
    # not depend on how many times a chain has fired. A frame that still
    # carries the old column (an export from before migration #209) scores the
    # same as one without it, whatever the column holds.
    rows = [_row(rt=-1, quintile=3), _row(quintile=4), _row(rt=-3, quintile=5)]
    plain = _feed(rows)
    stale = _feed(rows)
    stale["fire_count_score_adjustment"] = [-3, 2, None]
    scores = pd.Series([12, 12, 2], dtype="Int64")
    assert g.feed_qas(scores, stale).tolist() == g.feed_qas(scores, plain).tolist()
    assert g.feed_qas(scores, stale).tolist() == [11.0, 15.0, 5.0]


def test_feed_qas_matches_the_sql_transliteration_on_random_rows():
    rng = np.random.default_rng(3)
    n = 3000
    score = rng.integers(0, 18, n)
    rt = rng.choice([0, -1, -2, -3], n)
    quintile = rng.choice([3, 4, 5], n)  # the rows that are not forced
    feed = _feed([_row(rt=int(a), quintile=int(b)) for a, b in zip(rt, quintile)])
    got = g.feed_qas(pd.Series(score, dtype="Int64"), feed)
    want = [_sql_qas(int(s), int(a), int(b)) for s, a, b in zip(score, rt, quintile)]
    assert got.tolist() == [float(v) for v in want]


def test_feed_qas_needs_matching_scores_and_columns():
    feed = _feed([_row(), _row()])
    with pytest.raises(ValueError, match="same index"):
        g.feed_qas(pd.Series([1, 2, 3], dtype="Int64"), feed)
    with pytest.raises(ValueError, match="same index"):
        g.feed_qas(pd.Series([1, 2], index=[5, 6], dtype="Int64"), feed)
    with pytest.raises(ValueError, match="direction_gated"):
        g.feed_qas(
            pd.Series([1, 2], dtype="Int64"), feed.drop(columns=["direction_gated"])
        )


# ── daily_tier_shares ───────────────────────────────────────────────────────


def test_daily_tier_shares_counts_nan_below_every_cutoff():
    d1, d2 = date(2026, 3, 2), date(2026, 3, 3)
    feed = pd.DataFrame({"date": [d2, d1, d1, d1, d2, d1, d1, d1, d1, d1]})
    # d1 (8 rows): 14 13 12 10 9 NaN NaN 3   d2 (2 rows): 20 5 (in the order above)
    qas = pd.Series([20, 14, 13, 12, 5, 10, 9, NAN, NAN, 3], dtype="float64")
    shares = g.daily_tier_shares(qas, feed, g.FeedCutoffs(13, 10))
    assert list(shares.columns) == ["tier1_share", "tier12_share"]
    assert shares.index.name == "date"
    assert shares.index.tolist() == [d1, d2]  # ascending
    # d1: tier1 = 14, 13 -> 2/8; tier1+2 = 14, 13, 12, 10 -> 4/8.
    assert shares.loc[d1].tolist() == [0.25, 0.5]
    # d2: 20 is tier1 (1/2); 5 is neither, so tier1+2 is 1/2 as well.
    assert shares.loc[d2].tolist() == [0.5, 0.5]


def test_daily_tier_shares_reads_dates_given_as_text_or_timestamps():
    qas = pd.Series([5.0, 5.0], dtype="float64")
    cuts = g.FeedCutoffs(5, 3)
    expected = [date(2026, 3, 2)]
    for values in (["2026-03-02"] * 2, pd.to_datetime(["2026-03-02"] * 2)):
        shares = g.daily_tier_shares(qas, pd.DataFrame({"date": values}), cuts)
        assert shares.index.tolist() == expected
        assert shares["tier1_share"].tolist() == [1.0]


def test_daily_tier_shares_of_nothing_is_an_empty_frame():
    shares = g.daily_tier_shares(
        pd.Series([], dtype="float64"),
        pd.DataFrame({"date": []}),
        g.FeedCutoffs(13, 10),
    )
    assert shares.empty
    assert list(shares.columns) == ["tier1_share", "tier12_share"]


def test_daily_tier_shares_refuses_mismatched_inputs():
    feed = pd.DataFrame({"date": [date(2026, 3, 2)] * 2})
    with pytest.raises(ValueError, match="same index"):
        g.daily_tier_shares(pd.Series([1.0]), feed, g.FeedCutoffs(13, 10))
    with pytest.raises(ValueError, match="no session date"):
        g.daily_tier_shares(
            pd.Series([1.0, 2.0]),
            pd.DataFrame({"date": [date(2026, 3, 2), None]}),
            g.FeedCutoffs(13, 10),
        )


# ── match_feed_cutoffs ──────────────────────────────────────────────────────


def _qas(**counts: int) -> pd.Series:
    """A qas series from ``v<value>=<count>`` keywords, e.g. v20=2, v3=80."""
    values: list[float] = []
    for name, count in counts.items():
        values += [float(name[1:])] * count
    return pd.Series(values, dtype="float64")


def test_match_feed_cutoffs_hand_built():
    # The active tiers 5 of 100 fires as tier1 (>= 13) and 20 of 100 as tier1+2
    # (>= 10): targets 0.05 and 0.20.
    active = _qas(v20=5, v11=15, v2=80)
    # The candidate's share at or above c: 100% to c=3, 20% on 4..12, 10% on
    # 13..14, 5% on 15..17, 2% on 18..20, none above. 5% is first met on 15..17
    # and 20% on 4..12; the larger c wins each tie.
    candidate = _qas(v20=2, v17=3, v14=5, v12=10, v3=80)
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert got == g.FeedCutoffs(tier1_min_score=17, tier2_min_score=12)
    assert all(type(v) is int for v in (got.tier1_min_score, got.tier2_min_score))


def test_match_feed_cutoffs_breaks_a_tie_between_two_sides_upward():
    # Targets: tier1 3/40 = 0.075, tier1+2 5/40 = 0.125.
    active = _qas(v20=3, v11=2, v1=35)
    # Candidate shares: 4/40 = 0.10 on c = 2..10, 2/40 = 0.05 on 11..20. For
    # tier1 the two are exactly as far from 0.075 (1/40 each); float arithmetic
    # would split them by an ulp. The larger c, 20, wins. For tier1+2 the 0.10
    # side is nearest, and its largest c is 10.
    candidate = _qas(v20=2, v10=2, v1=36)
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert got == g.FeedCutoffs(tier1_min_score=20, tier2_min_score=10)


def test_match_feed_cutoffs_keeps_tier2_below_tier1():
    # Nothing sits between the active's cutoffs, so both shares are 5% and both
    # cutoffs would land on the same c (17, the larger of 15..17): tier2 drops
    # to 16.
    active = _qas(v20=5, v2=95)
    candidate = _qas(v20=2, v17=3, v14=5, v12=10, v3=80)
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert got == g.FeedCutoffs(tier1_min_score=17, tier2_min_score=16)


def test_match_feed_cutoffs_stays_inside_the_search_range():
    # Every candidate fire is above 40, so every c in 0..40 gives share 1.0:
    # the tie goes to the largest c the search allows.
    active = _qas(v20=5, v11=15, v2=80)
    candidate = _qas(v50=100)
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert g.FEED_CUTOFF_SEARCH_MAX == 40
    assert got == g.FeedCutoffs(tier1_min_score=40, tier2_min_score=39)


def test_the_floor_is_derived_from_the_largest_qas_a_null_score_fire_can_reach():
    # The feed's SQL floor gives a NULL-score fire `0 + fire_count_score_adjustment +
    # inversion bonus`: up to +2 and +5. The gate counts such a fire tier3, so the two
    # agree only for cutoffs above their sum. Each part is a named constant.
    assert g.FIRE_COUNT_ADJUSTMENT_MAX == 2
    assert max(g.INVERSION_BONUS.values()) == 5
    assert g.NULL_SCORE_QAS_MAX == g.FIRE_COUNT_ADJUSTMENT_MAX + 5 == 7
    assert g.FEED_CUTOFF_FLOOR == g.NULL_SCORE_QAS_MAX + 1 == 8


TRIGGER_DEFINITION = "CREATE OR REPLACE FUNCTION update_lottery_fire_count_score_adj()"


def _trigger_ladder(migrations: str) -> list[int]:
    """The values of the `fire_count_score_adjustment` ladder in the trigger's one
    definition in the migrations text (`-3` .. `ELSE 2`)."""
    # Postgres runs the last definition, so a redefinition may change the ladder while the
    # first match here still reads the old one and leaves the floor stale.
    count = migrations.count(TRIGGER_DEFINITION)
    assert count == 1, (
        f"update_lottery_fire_count_score_adj is defined {count} times in "
        "api/_lib/db-migrations.ts, not once. The ladder that writes "
        "fire_count_score_adjustment may have changed: update FIRE_COUNT_ADJUSTMENT_MAX "
        "in ml/src/lottery_refit_gates.py (and so NULL_SCORE_QAS_MAX and "
        "FEED_CUTOFF_FLOOR) from its source, then point this test at it."
    )
    start = migrations.index(TRIGGER_DEFINITION)
    ladder = re.search(r"new_adj := CASE(.*?)END;", migrations[start:], re.S)
    assert ladder is not None, "the trigger's ladder moved or changed shape"
    return [int(v) for v in re.findall(r"(?:THEN|ELSE)\s+(-?\d+)", ladder[1])]


def test_the_fire_count_adjustment_max_is_the_triggers_largest_value():
    # The only writer of `fire_count_score_adjustment` is the trigger of migration #167,
    # and its ladder is the source of the +2. If a migration changes the ladder, this fails
    # first and the floor must follow. (The backfill UPDATE beside it uses the same ladder.)
    text = (ROOT / "api" / "_lib" / "db-migrations.ts").read_text(encoding="utf-8")
    values = _trigger_ladder(text)
    assert values == [-3, -1, 0, 1, 2]
    assert max(values) == g.FIRE_COUNT_ADJUSTMENT_MAX


def test_a_redefined_trigger_fails_the_floor_test_instead_of_leaving_it_stale():
    # A later migration redefines the trigger with a higher top bracket. Reading the
    # first definition would stay green on the old ladder; the count of definitions fails.
    text = (ROOT / "api" / "_lib" / "db-migrations.ts").read_text(encoding="utf-8")
    redefined = (
        text
        + f"\n{TRIGGER_DEFINITION}\n"
        + "new_adj := CASE WHEN new_count = 1 THEN -3 ELSE 4 END;\n"
    )
    with pytest.raises(AssertionError, match="defined 2 times") as raised:
        _trigger_ladder(redefined)
    assert "update FIRE_COUNT_ADJUSTMENT_MAX" in str(raised.value)


@pytest.mark.parametrize("reach", [5, 7])
def test_match_feed_cutoffs_never_lands_where_a_null_score_can_tier(reach):
    # A cutoff of 7 or less can tier a NULL-score fire on the feed (qas up to 7), while
    # `feed_qas` counts it tier3, so the gate would judge a tiering the feed does not show.
    # 5 is the bonus alone (the displayed tier); 7 adds the fire-count adjustment (the SQL
    # floor, which serves `minTier` and the chip counts).
    active = _qas(v20=5, v11=15, v2=80)  # targets 5% (>= 13) and 20% (>= 10)
    # The candidate reaches 20% only at c <= `reach`. Searching from 0, tier2 would be
    # `reach` (the larger c wins a tie): 5, and 7, which the first floor of 6 let through.
    candidate = _qas(**{f"v{reach}": 20, "v1": 80})
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert got.tier2_min_score > g.NULL_SCORE_QAS_MAX
    # Nothing is at or above 8, so every cutoff from there on is equally far from the
    # target and the tie goes to the largest: the candidate cannot match the active's tiers
    # above the floor, and check_creation rejects it on its tier1 share (0 is under 1 %).
    assert got == g.FeedCutoffs(tier1_min_score=40, tier2_min_score=39)


def test_match_feed_cutoffs_may_land_exactly_on_the_floor_with_tier1_above_it():
    # Both targets are 10% (nothing sits between the active's cutoffs). The candidate holds
    # 10% on c = 2..8 and nothing from 9. Searching from 0 gives (8, 7): tier2 inside the
    # disagreeing zone. Tier2 may use 8, the floor, but tier1 must stay above it.
    active = _qas(v20=10, v2=90)
    candidate = _qas(v8=10, v1=90)
    got = g.match_feed_cutoffs(candidate, active, g.FeedCutoffs(13, 10))
    assert got.tier2_min_score == g.FEED_CUTOFF_FLOOR
    assert got.tier1_min_score > got.tier2_min_score
    assert got == g.FeedCutoffs(tier1_min_score=40, tier2_min_score=8)


def test_match_feed_cutoffs_counts_nan_below_and_in_the_denominator():
    cuts = g.FeedCutoffs(12, 1)
    # Active: 2 of 4 reach 12 (the NaN rows count, below): target 0.5. Without
    # them it would be 1.0, and the match would land on c=1.
    active = pd.Series([12, 12, NAN, NAN])
    candidate = pd.Series([12, 12, 1, 1], dtype="float64")
    assert g.match_feed_cutoffs(candidate, active, cuts) == g.FeedCutoffs(12, 11)
    # Candidate: 4 of 8 reach 12 (the NaN rows are in the 8): share 0.5 on every
    # c <= 12, exactly the target. Without the NaN rows the shares would be 1.0
    # and 0.0, each 0.5 away, and the tie would go to c=40.
    active = pd.Series([12, 12, 0, 0], dtype="float64")
    candidate = pd.Series([12] * 4 + [NAN] * 4)
    assert g.match_feed_cutoffs(candidate, active, cuts) == g.FeedCutoffs(12, 11)


def test_match_feed_cutoffs_refuses_empty_input():
    cuts = g.FeedCutoffs(13, 10)
    with pytest.raises(ValueError, match="needs fires"):
        g.match_feed_cutoffs(pd.Series([], dtype="float64"), pd.Series([1.0]), cuts)
    with pytest.raises(ValueError, match="needs fires"):
        g.match_feed_cutoffs(pd.Series([1.0]), pd.Series([], dtype="float64"), cuts)


def test_feed_cutoffs_from_weights():
    w = make_weights(GOOD_EVAL, FEED_BASE, cutoffs=(16, 12))
    assert g.FeedCutoffs.from_weights(w) == g.FeedCutoffs(16, 12)


# ── check_creation ──────────────────────────────────────────────────────────


def _creation(weights=None, *, rows=30_000, sessions=30, share=0.05):
    return g.check_creation(
        make_weights(GOOD_EVAL, FEED_BASE) if weights is None else weights,
        train_rows=rows,
        train_sessions=sessions,
        tier1_share=share,
    )


def test_check_creation_accepts_a_healthy_candidate_at_every_edge():
    ok = _creation()
    assert ok == g.CreationVerdict(
        ok=True, reasons=(), train_rows=30_000, train_sessions=30, tier1_share=0.05
    )
    assert _creation(share=0.01).ok
    assert _creation(share=0.15).ok


def test_check_creation_each_reason():
    broken = make_weights(GOOD_EVAL, FEED_BASE)
    broken["feed_cutoffs"] = {"tier1_min_score": 3, "tier2_min_score": 3}
    cases = [
        (_creation(rows=29_999), ("too_few_train_rows",)),
        (_creation(sessions=29), ("too_few_train_sessions",)),
        (_creation(broken), ("invalid_weights",)),
        (_creation(share=0.0099), ("tier1_share_out_of_band",)),
        (_creation(share=0.1501), ("tier1_share_out_of_band",)),
        (_creation(share=NAN), ("tier1_share_out_of_band",)),
    ]
    for verdict, reasons in cases:
        assert verdict.reasons == reasons
        assert verdict.ok is False


def test_check_creation_lists_every_failed_check_in_a_fixed_order():
    broken = {"schema_version": 1}  # a weights object missing everything else
    verdict = _creation(broken, rows=196, sessions=3, share=0.0)
    assert verdict.reasons == (
        "too_few_train_rows",
        "too_few_train_sessions",
        "invalid_weights",
        "tier1_share_out_of_band",
    )
    assert (verdict.train_rows, verdict.train_sessions) == (196, 3)
    assert verdict.tier1_share == 0.0


def test_check_creation_reads_a_non_mapping_as_invalid_weights():
    # validate_weights refuses it as a "type" failure, which is a verdict, not a
    # crash: the step stores the rejection and sends its notice.
    verdict = _creation("not weights")
    assert verdict.reasons == ("invalid_weights",)
    assert verdict.ok is False


# ── decide_shadow: sessions ─────────────────────────────────────────────────


def test_decide_passes_a_healthy_candidate():
    v = run()
    assert v.decision == "pass"
    assert v.reasons == ()
    assert v.sessions == tuple(trading_days(10))
    assert v.eval_rows == 5000
    assert v.rho_candidate == v.rho_active
    assert v.rho_candidate > 0.9
    assert (v.tier1_ratio, v.tier12_ratio) == (1.0, 1.0)
    assert v.tier1_share == 0.0625


def test_decide_waits_under_ten_sessions():
    v = run(rows=(500,) * 9, elapsed=9)
    assert v.decision == "wait"
    assert v.reasons == ()
    assert v.sessions == tuple(trading_days(9))
    assert v.eval_rows == 4500
    for undefined in (v.rho_candidate, v.rho_active, v.tier1_ratio, v.tier12_ratio):
        assert math.isnan(undefined)
    assert math.isnan(v.tier1_share)


def test_decide_waits_with_no_sessions_at_all():
    empty = make_eval_frame(())
    v = run(rows=(), elapsed=3, eval_frame=empty, feed_frame=make_feed_frame([]))
    assert (v.decision, v.reasons, v.sessions, v.eval_rows) == ("wait", (), (), 0)


@pytest.mark.parametrize(
    ("elapsed", "decision", "reasons"),
    [
        (19, "wait", ()),
        (20, "reject", ("shadow_starved",)),
        (27, "reject", ("shadow_starved",)),
    ],
)
def test_shadow_starved_after_max_sessions(elapsed, decision, reasons):
    v = run(rows=(500,) * 9, elapsed=elapsed)
    assert (v.decision, v.reasons) == (decision, reasons)
    assert v.sessions == tuple(trading_days(9))


def test_a_full_shadow_is_judged_even_after_the_starvation_limit():
    v = run(rows=(500,) * 10, elapsed=25)
    assert (v.decision, v.reasons) == ("pass", ())


def test_decide_uses_exactly_the_first_ten_sessions():
    base = run(rows=(500,) * 10)
    # An 11th session whose outcome runs the wrong way, and whose feed day is
    # nothing but tier1 fires, would move the rho and every share if it counted.
    days = trading_days(11)
    eval_frame = make_eval_frame((500,) * 11, bad_sessions=(10,))
    feed_frame = pd.concat(
        [make_feed_frame(days[:10]), make_feed_frame(days[10:], {"AAA": 32})],
        ignore_index=True,
    )
    eleven = run(rows=(500,) * 11, eval_frame=eval_frame, feed_frame=feed_frame)
    assert eleven == base
    assert eleven.eval_rows == 5000
    assert eleven.sessions == tuple(days[:10])
    # The bad session really would have changed the pooled rho.
    all_eleven = lw.score_frame(make_weights(GOOD_EVAL, FEED_BASE), eval_frame).astype(
        "float64"
    )
    assert g.spearman(all_eleven, eval_frame["outcome_pct"]) != pytest.approx(
        base.rho_candidate, abs=1e-6
    )


def test_a_thin_session_is_skipped_and_the_next_one_takes_its_place():
    # 499 scored rows is one short of a session. The first ten sessions that do
    # count are days 0-2 and 4-10.
    rows = (500, 500, 500, 499) + (500,) * 8
    v = run(rows=rows)
    days = trading_days(12)
    assert v.sessions == tuple(days[:3] + days[4:11])
    assert v.eval_rows == 5000
    assert v.decision == "pass"


def test_a_session_of_exactly_the_minimum_counts():
    # The first session sits on the floor; the nine after it are above it, so the
    # total is 500 + 9 * 600 = 5,900.
    v = run(rows=(500,) + (600,) * 9)
    assert v.sessions == tuple(trading_days(10))
    assert (v.decision, v.eval_rows) == ("pass", 5900)


def test_sessions_under_the_floor_never_make_a_shadow():
    # Ten sessions of 499 rows hold 4,990, but none of them is a session.
    v = run(rows=(499,) * 10)
    assert (v.decision, v.reasons) == ("wait", ())
    assert (v.sessions, v.eval_rows) == ((), 0)


def test_only_scored_rows_count_toward_a_session():
    # Day 0 has 600 fires, 200 of them unaligned (cum_ncp below cum_npp for a
    # call), which the scorer gates out. 400 scored rows is not a session, though
    # 600 fires would be.
    eval_frame = make_eval_frame((600,) + (500,) * 10)
    first_day = eval_frame["date"] == trading_days(1)[0]
    gated = eval_frame.index[first_day][:200]
    eval_frame.loc[gated, "cum_ncp_at_fire"] = 0.5
    v = run(rows=(600,) + (500,) * 10, eval_frame=eval_frame)
    assert v.sessions == tuple(trading_days(11)[1:])
    assert v.eval_rows == 5000


def test_a_session_whose_rows_have_no_outcome_is_not_evaluated():
    eval_frame = make_eval_frame((500,) * 11)
    first_day = eval_frame["date"] == trading_days(1)[0]
    eval_frame.loc[first_day, "outcome_pct"] = NAN
    v = run(rows=(500,) * 11, eval_frame=eval_frame)
    assert v.sessions == tuple(trading_days(11)[1:])
    assert v.eval_rows == 5000


# ── decide_shadow: the rho gate ─────────────────────────────────────────────


def test_rho_tie_passes():
    # The same weights under a new version id score every fire alike, so the two
    # rhos are the same number and "candidate >= active" holds.
    v = run(candidate_eval=GOOD_EVAL, active_eval=GOOD_EVAL)
    assert v.rho_candidate == v.rho_active
    assert (v.decision, v.reasons) == ("pass", ())


def test_a_better_ranking_passes():
    v = run(candidate_eval=GOOD_EVAL, active_eval=BAD_EVAL)
    assert v.rho_candidate > 0.9 > 0 > v.rho_active
    assert (v.decision, v.reasons) == ("pass", ())


def test_rho_below_active_rejects():
    v = run(candidate_eval=BAD_EVAL, active_eval=GOOD_EVAL)
    assert v.rho_candidate < v.rho_active
    assert (v.decision, v.reasons) == ("reject", ("rho_below_active",))
    assert v.sessions == tuple(trading_days(10))


@pytest.mark.parametrize(
    ("candidate_eval", "active_eval", "which"),
    [
        (GOOD_EVAL, FLAT_EVAL, "active"),
        (FLAT_EVAL, GOOD_EVAL, "candidate"),
        (FLAT_EVAL, FLAT_EVAL, "both"),
    ],
)
def test_rho_undefined_rejects(candidate_eval, active_eval, which):
    # A version that gives every fire the same score has no rank correlation.
    v = run(candidate_eval=candidate_eval, active_eval=active_eval)
    assert (v.decision, v.reasons) == ("reject", ("rho_undefined",))
    assert math.isnan(v.rho_candidate) is (which in ("candidate", "both"))
    assert math.isnan(v.rho_active) is (which in ("active", "both"))


def test_rho_is_pooled_over_the_judged_sessions_not_averaged_per_session():
    # Ten sessions of unequal size. The third, by far the biggest, runs against
    # the ranking: pooled over all 6,900 rows its 2,400 outweigh any other single
    # session (the other 4,500 rows together still outweigh it), while a mean of
    # ten per-session rhos would count it once in ten.
    rows = (500, 500, 2400, 500, 500, 500, 500, 500, 500, 500)
    eval_frame = make_eval_frame(rows, bad_sessions=(2,))
    v = run(rows=rows, eval_frame=eval_frame, active_eval=BAD_EVAL)
    assert v.eval_rows == 6900
    outcomes = eval_frame["outcome_pct"]
    by_session = [eval_frame["date"] == day for day in trading_days(10)]
    for ranking, got in ((GOOD_EVAL, v.rho_candidate), (BAD_EVAL, v.rho_active)):
        scores = lw.score_frame(make_weights(ranking, FEED_BASE), eval_frame)
        pooled = g.spearman(scores, outcomes)
        per_session = [g.spearman(scores[m], outcomes[m]) for m in by_session]
        assert got == pytest.approx(pooled, abs=1e-12)
        # The two aggregates are far apart here, so the equality above tells
        # them apart.
        assert abs(pooled - float(np.mean(per_session))) > 0.2
    assert (v.decision, v.reasons) == ("pass", ())


# ── decide_shadow: eval rows ────────────────────────────────────────────────


def test_too_few_eval_rows(monkeypatch):
    # Ten sessions hold at least 10 * MIN_EVAL_ROWS_PER_SESSION = 5,000 rows, so
    # with the shipped constants this check cannot fire on its own: it is a
    # backstop. Raising the total floor one row above what the minimum sessions hold
    # shows the check itself. The rows come from the shipped per-session floor, and the
    # total floor is set from what they sum to, so a retune of MIN_EVAL_ROWS that keeps
    # the check a backstop does not fail this test.
    rows = (g.MIN_EVAL_ROWS_PER_SESSION,) * g.SHADOW_SESSIONS
    total = sum(rows)
    monkeypatch.setattr(g, "MIN_EVAL_ROWS", total + 1)
    v = run(rows=rows)
    assert (v.decision, v.reasons, v.eval_rows) == (
        "reject",
        ("too_few_eval_rows",),
        total,
    )
    monkeypatch.setattr(g, "MIN_EVAL_ROWS", total)
    assert run(rows=rows).decision == "pass"  # exactly the floor


def test_the_shipped_floors_leave_the_total_check_a_backstop():
    # Pins the relationship the test above works around: a shadow of the minimum
    # sessions never falls under the total floor. If this fails, the total check
    # has become live (or the per-session floor was lowered), and
    # test_too_few_eval_rows no longer needs its patch.
    assert g.SHADOW_SESSIONS * g.MIN_EVAL_ROWS_PER_SESSION >= g.MIN_EVAL_ROWS


# ── decide_shadow: the tier shares ──────────────────────────────────────────

# With FEED_BASE the AAA fires are tier1 and AAA+BBB tier1+2 under (7, 3):
# 2/32 and 4/32. Giving DDD weight 4 adds its 2 fires to tier1+2 only (6/32),
# EEE its 1 fire (5/32).


def test_tier12_ratio_of_exactly_one_and_a_half_passes():
    v = run(candidate_feed={"DDD": 4})  # 6/32 over 4/32
    assert v.tier12_ratio == 1.5
    assert v.tier1_ratio == 1.0
    assert (v.decision, v.reasons) == ("pass", ())


def test_tier12_ratio_just_above_the_band_rejects():
    v = run(candidate_feed={"DDD": 4, "EEE": 4})  # 7/32 over 4/32 = 1.75
    assert v.tier12_ratio == 1.75
    assert (v.decision, v.reasons) == ("reject", ("tier12_ratio_out_of_band",))


def test_tier12_ratio_inside_and_below_the_lower_edge():
    # Active tier1+2 is 6/32. A candidate at 5/32 is 0.8333 (in); at 4/32 it is
    # 0.6667, under the 0.67 edge (out).
    inside = run(active_feed={"DDD": 4}, candidate_feed={"EEE": 4})
    assert inside.tier12_ratio == pytest.approx(5 / 6)
    assert (inside.decision, inside.reasons) == ("pass", ())
    outside = run(active_feed={"DDD": 4})
    assert outside.tier12_ratio == pytest.approx(2 / 3)
    assert (outside.decision, outside.reasons) == (
        "reject",
        ("tier12_ratio_out_of_band",),
    )


def test_tier1_ratio_out_of_band_names_tier1():
    # Candidate cutoffs (4, 3): tier1 becomes the AAA and BBB fires, 4/32, twice
    # the active's 2/32. The tier1+2 share is unchanged.
    v = run(candidate_cutoffs=(4, 3))
    assert v.tier1_ratio == 2.0
    assert v.tier12_ratio == 1.0
    assert v.reasons == ("tier1_ratio_out_of_band",)


def test_each_version_is_read_against_its_own_feed_cutoffs():
    # The active's (4, 3) puts 4/32 in its tier1, so a candidate at (7, 3), with
    # 2/32, is half of it. Reading the active against the candidate's cutoffs
    # would give a ratio of 1.
    v = run(active_cutoffs=(4, 3))
    assert v.tier1_ratio == 0.5
    assert v.tier12_ratio == 1.0
    assert v.reasons == ("tier1_ratio_out_of_band",)


def test_shares_are_the_mean_of_daily_shares_not_pooled():
    # Nine ordinary feed days of 32 fires and one of 320, half of it AAA fires
    # (tier1 for both versions). The candidate also gives EEE weight 8, so its
    # tier1 is AAA+EEE and its tier1+2 AAA+BBB+EEE; the active's are AAA and
    # AAA+BBB. Daily shares, candidate / active:
    #
    #                    tier1                     tier1+2
    #   9 small days     3/32 = 0.09375 / 0.0625   5/32 = 0.15625 / 0.125
    #   the big day      0.5 / 0.5                 0.5 / 0.5
    #   mean of 10 days  0.134375 / 0.10625        0.190625 / 0.1625
    #
    # Pooled over fires (the mutant) they would be 187/608 and 178/608, then
    # 205/608 and 196/608: a candidate tier1 share of 0.3076 and ratios of 1.05
    # and 1.046, none of them equal to the means below.
    days = trading_days(10)
    feed = pd.concat(
        [
            make_feed_frame(days[:9]),
            make_feed_frame(days[9:], {"AAA": 160, "CCC": 160}),
        ],
        ignore_index=True,
    )
    v = run(candidate_feed={"EEE": 8}, feed_frame=feed)
    assert v.tier1_share == pytest.approx(0.134375)
    assert v.tier1_ratio == pytest.approx(0.134375 / 0.10625)  # 43/34
    assert v.tier12_ratio == pytest.approx(0.190625 / 0.1625)  # 61/52
    assert v.tier1_ratio != pytest.approx(187 / 178, abs=1e-3)
    assert v.tier12_ratio != pytest.approx(205 / 196, abs=1e-3)
    assert (v.decision, v.reasons) == ("pass", ())


def test_zero_over_zero_ratio_is_one():
    # Under (9, 3) nothing reaches tier1 for either version (the top weight is
    # 8): 0/0 reads as "no change", not as a failed ratio. The candidate's own
    # share of 0 still trips the share band.
    v = run(candidate_cutoffs=(9, 3), active_cutoffs=(9, 3))
    assert v.tier1_ratio == 1.0
    assert v.tier1_share == 0.0
    assert v.reasons == ("tier1_share_out_of_band",)


def test_a_share_over_zero_is_an_infinite_ratio():
    v = run(active_cutoffs=(9, 3))  # active tier1 share 0; candidate's is 2/32
    assert v.tier1_ratio == math.inf
    assert v.reasons == ("tier1_ratio_out_of_band",)


def test_tier1_share_band():
    # Giving DDD and EEE weight 8 puts their 3 fires in tier1 beside AAA's 2:
    # 5/32 = 0.15625, over 0.15.
    high = run(candidate_feed={"DDD": 8, "EEE": 8})
    assert high.tier1_share == 0.15625
    assert "tier1_share_out_of_band" in high.reasons
    # 4/32 = 0.125 is inside the band; only its ratio to the active's 2/32 fails.
    inside = run(candidate_cutoffs=(4, 3))
    assert inside.tier1_share == 0.125
    assert "tier1_share_out_of_band" not in inside.reasons
    # 0 is under 0.01.
    low = run(candidate_cutoffs=(9, 3))
    assert low.tier1_share == 0.0
    assert "tier1_share_out_of_band" in low.reasons


def test_every_failed_check_is_listed_in_vocabulary_order(monkeypatch):
    # Thin rows (the total floor raised one above ten minimum sessions, as in
    # test_too_few_eval_rows); a reversed ranking; nothing reaches tier1 under
    # (9, 3), so its share is 0 (under the band, ratio 0); and tier1+2 grows to
    # 7/32 over 4/32.
    rows = (g.MIN_EVAL_ROWS_PER_SESSION,) * g.SHADOW_SESSIONS
    monkeypatch.setattr(g, "MIN_EVAL_ROWS", sum(rows) + 1)
    v = run(
        rows=rows,
        candidate_eval=BAD_EVAL,
        active_eval=GOOD_EVAL,
        candidate_feed={"DDD": 4, "EEE": 4},
        candidate_cutoffs=(9, 3),
    )
    assert v.decision == "reject"
    assert v.reasons == (
        "too_few_eval_rows",
        "rho_below_active",
        "tier1_share_out_of_band",
        "tier1_ratio_out_of_band",
        "tier12_ratio_out_of_band",
    )
    assert (v.tier1_ratio, v.tier12_ratio) == (0.0, 1.75)


# ── decide_shadow: bad input ────────────────────────────────────────────────


def test_a_chosen_session_without_feed_rows_is_an_error():
    days = trading_days(10)
    feed = make_feed_frame(days[:9])
    with pytest.raises(ValueError, match="feed_frame has no rows"):
        run(feed_frame=feed)


def test_missing_columns_are_named():
    eval_frame = make_eval_frame((500,) * 10).drop(columns=["outcome_pct"])
    with pytest.raises(ValueError, match="outcome_pct"):
        run(eval_frame=eval_frame)
    feed = make_feed_frame(trading_days(10)).drop(columns=["inversion_quintile"])
    with pytest.raises(ValueError, match="inversion_quintile"):
        run(feed_frame=feed)


def test_an_invalid_weights_object_is_not_scored():
    candidate = make_weights(GOOD_EVAL, FEED_BASE)
    candidate["cutoffs"] = {"t1": 1, "t2": 5}
    with pytest.raises(lw.WeightsInvalid):
        g.decide_shadow(
            eval_frame=make_eval_frame((500,) * 10),
            feed_frame=make_feed_frame(trading_days(10)),
            candidate=candidate,
            active=make_weights(GOOD_EVAL, FEED_BASE),
            sessions_elapsed=10,
        )


def test_an_unknown_tod_reaches_the_caller():
    # score_frame refuses a scored fire whose tod is not one of the four
    # buckets; the verdict must not swallow that into a pass or a reject.
    eval_frame = make_eval_frame((500,) * 10)
    eval_frame.loc[3, "tod"] = "OVERNIGHT"
    with pytest.raises(ValueError, match="tod"):
        run(eval_frame=eval_frame)
