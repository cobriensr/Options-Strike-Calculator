"""Tests for ml/src/lottery_weights.py: the Python twin of the TypeScript
lottery scorer.

The module must validate a weights object the way api/_lib/lottery-weights-
schema.ts does and score a frame the way ``scoreLotteryV2`` does. The anchor is
api/__tests__/fixtures/lottery-score-parity.json (synthetic fires with the
scores the TS scorer gave them, generated from the pre-edit code): the TS test
replays it through ``scoreLotteryV2`` and ``test_score_frame_matches_the_parity
_fixture`` replays it through ``score_frame``, so the two languages cannot
drift apart without one of the two tests failing. A second fixture,
lottery-score-parity-alt.json, holds a hand-built non-seed version (weekday
overrides past Monday, a composite on a "null" quintile label) that both
languages replay the same way, since a promoted version is never the seed.

Every input here is synthetic. Nothing reaches a database: ``load_pointer`` is
exercised with a fake connection object.
"""

import copy
import json
import math
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import lottery_weights as lw

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "ml" / "src"
FIXTURE = json.loads(
    (ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity.json").read_text(
        encoding="utf-8"
    )
)
CASES = FIXTURE["cases"]
ALT_FIXTURE = json.loads(
    (
        ROOT / "api" / "__tests__" / "fixtures" / "lottery-score-parity-alt.json"
    ).read_text(encoding="utf-8")
)
ALT_CASES = ALT_FIXTURE["cases"]

# (fire column, weights stem) for the three continuous features.
QUINTILE_FEATURES = [
    ("trigger_vol_to_oi_window", "vol_oi"),
    ("gamma_at_trigger", "gamma"),
    ("trigger_ask_pct", "ask_pct"),
]
WEEKDAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)


def _weights() -> dict:
    """A fresh copy of the seed weights the fixture carries."""
    return copy.deepcopy(FIXTURE["weights"])


def _zeroed_weights() -> dict:
    """The seed's shape with every weight 0: an aligned fire scores 0, so a test
    can switch on one table and see exactly that table's effect."""
    w = _weights()
    f = w["features"]
    f["ticker_weights"] = {t: 0 for t in f["ticker_weights"]}
    f["tod_weights"] = dict.fromkeys(f["tod_weights"], 0)
    f["tod_weights_dow_overrides"] = {}
    f["dte_weights"] = dict.fromkeys(f["dte_weights"], 0)
    for stem in ("vol_oi", "gamma", "ask_pct"):
        f[f"{stem}_quintile_weights"] = [0] * 5
    f["option_type_weights"] = {"C": 0, "P": 0}
    f["composite_bonuses"] = []
    return w


def _fire(**over) -> dict:
    """An aligned Wednesday call; override any column."""
    fire = {
        "underlying_symbol": "AMZN",
        "option_type": "C",
        "tod": "AM_open",
        "dte": 1,
        "trigger_vol_to_oi_window": 0.12,
        "gamma_at_trigger": 0.05,
        "trigger_ask_pct": 0.55,
        "cum_ncp_at_fire": 1_200_000.0,
        "cum_npp_at_fire": 800_000.0,
        "date": "2026-03-11",
    }
    fire.update(over)
    return fire


def _frame(fires: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(fires, columns=list(lw.SCORE_COLUMNS))


def _same(got, want) -> bool:
    """``got`` is a Series cell (an int or ``<NA>``), ``want`` an int or None."""
    if want is None:
        return got is pd.NA
    return got is not pd.NA and got == want


# ── The parity fixture ──────────────────────────────────────────────────────


def test_score_frame_matches_the_parity_fixture():
    df = _frame([c["fire"] for c in CASES])
    got = lw.score_frame(FIXTURE["weights"], df)
    assert str(got.dtype) == "Int64"
    assert len(got) == len(CASES) == 70
    mismatches = [
        (c["name"], c["expected"], g)
        for c, g in zip(CASES, got.tolist(), strict=True)
        if not _same(g, c["expected"])
    ]
    assert mismatches == []


def test_score_frame_gives_the_fixture_cases_in_both_outcomes():
    # Guards the test above against a fixture that quietly lost its gated rows.
    expected = [c["expected"] for c in CASES]
    assert any(e is None for e in expected)
    assert any(e is not None for e in expected)


def test_score_frame_matches_the_non_seed_parity_fixture():
    # The same replay on a version that is not the seed: other tables, three
    # weekday overrides, a "null" quintile label, a negative bound. The TS test
    # of the same name replays the same file through scoreLotteryV2.
    df = _frame([c["fire"] for c in ALT_CASES])
    got = lw.score_frame(ALT_FIXTURE["weights"], df)
    assert str(got.dtype) == "Int64"
    assert len(got) == len(ALT_CASES) == 109
    expected = [c["expected"] for c in ALT_CASES]
    assert any(e is None for e in expected)
    assert any(e is not None for e in expected)
    mismatches = [
        (c["name"], c["expected"], g)
        for c, g in zip(ALT_CASES, got.tolist(), strict=True)
        if not _same(g, c["expected"])
    ]
    assert mismatches == []


def test_scores_do_not_depend_on_row_order():
    df = _frame([c["fire"] for c in CASES])
    base = lw.score_frame(FIXTURE["weights"], df)
    order = np.random.default_rng(7).permutation(len(df))
    shuffled = lw.score_frame(FIXTURE["weights"], df.iloc[order])
    # Same index labels, so aligning by label recovers the original order.
    realigned = shuffled.reindex(df.index)
    assert [
        _same(a, b if b is not pd.NA else None)
        for a, b in zip(realigned.tolist(), base.tolist(), strict=True)
    ] == [True] * len(df)


def test_score_frame_keeps_the_index_and_leaves_the_input_alone():
    df = _frame([c["fire"] for c in CASES])
    df.index = pd.Index(range(500, 500 + len(df)))
    before = df.copy(deep=True)
    got = lw.score_frame(FIXTURE["weights"], df)
    assert got.index.equals(df.index)
    pd.testing.assert_frame_equal(df, before)


def test_score_frame_of_an_empty_frame_is_an_empty_int64_series():
    got = lw.score_frame(FIXTURE["weights"], _frame([]))
    assert len(got) == 0
    assert str(got.dtype) == "Int64"


# ── assign_quintile ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("stem", "k"),
    [(stem, k) for _col, stem in QUINTILE_FEATURES for k in range(4)],
)
def test_assign_quintile_value_on_a_boundary_goes_low(stem, k):
    bounds = FIXTURE["weights"]["features"][f"{stem}_quintile_boundaries"]
    b = bounds[k]
    assert lw.assign_quintile(b, bounds) == k
    assert lw.assign_quintile(float(np.nextafter(b, -np.inf)), bounds) == k
    assert lw.assign_quintile(float(np.nextafter(b, np.inf)), bounds) == k + 1


def test_assign_quintile_the_ends_and_the_nulls():
    bounds = [1.0, 2.0, 3.0, 4.0]
    assert lw.assign_quintile(-math.inf, bounds) == 0
    assert lw.assign_quintile(math.inf, bounds) == 4
    assert lw.assign_quintile(4.5, bounds) == 4
    assert lw.assign_quintile(None, bounds) is None
    assert lw.assign_quintile(math.nan, bounds) is None
    assert lw.assign_quintile(pd.NA, bounds) is None


@pytest.mark.parametrize(("column", "stem"), QUINTILE_FEATURES)
def test_score_frame_cuts_quintiles_like_pd_cut_right_closed(column, stem):
    # Training cuts with pd.cut(right=True); the scorer must land every value,
    # boundaries and their float neighbours included, in the same bucket. A
    # weights copy that scores the quintile index makes the score readable.
    w = _zeroed_weights()
    w["features"][f"{stem}_quintile_weights"] = [0, 1, 2, 3, 4]
    bounds = w["features"][f"{stem}_quintile_boundaries"]
    rng = np.random.default_rng(11)
    on_edges = [
        float(x)
        for b in bounds
        for x in (b, np.nextafter(b, -np.inf), np.nextafter(b, np.inf))
    ]
    values = on_edges + list(rng.uniform(0.0, 1.5 * bounds[-1], size=500))
    df = _frame([_fire(**{column: v}) for v in values])
    got = lw.score_frame(w, df)
    want = pd.cut(
        pd.Series(values), bins=[-np.inf, *bounds, np.inf], right=True, labels=False
    )
    assert got.tolist() == want.tolist()
    assert got.tolist() == [lw.assign_quintile(v, bounds) for v in values]


@pytest.mark.parametrize(("column", "stem"), QUINTILE_FEATURES)
def test_a_null_continuous_feature_adds_nothing(column, stem):
    w = _zeroed_weights()
    w["features"][f"{stem}_quintile_weights"] = [5, 5, 5, 5, 5]
    got = lw.score_frame(w, _frame([_fire(), _fire(**{column: None})]))
    assert got.tolist() == [5, 0]


# ── Gates ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("option_type", "ncp", "npp", "scored"),
    [
        ("C", 5.0, 3.0, True),
        ("P", 3.0, 5.0, True),
        ("C", 3.0, 5.0, False),
        ("P", 5.0, 3.0, False),
        ("C", 4.0, 4.0, False),
        ("P", 4.0, 4.0, False),
        ("C", None, 3.0, False),
        ("C", 5.0, None, False),
        ("P", None, 3.0, False),
        ("P", 3.0, None, False),
        ("C", -2.0, -5.0, True),
        ("P", -5.0, -2.0, True),
        ("X", 5.0, 3.0, False),
        (None, 5.0, 3.0, False),
    ],
)
def test_alignment_gate(option_type, ncp, npp, scored):
    fire = _fire(option_type=option_type, cum_ncp_at_fire=ncp, cum_npp_at_fire=npp)
    got = lw.score_frame(_weights(), _frame([fire]))
    assert (got.iloc[0] is not pd.NA) is scored


@pytest.mark.parametrize(
    ("dte", "scored"),
    [(0, True), (1, True), (2, True), (3, True), (4, False), (-1, False)]
    + [(1.5, False), (None, False), (float("nan"), False), (1.0, True)],
)
def test_dte_outside_zero_to_three_is_gated(dte, scored):
    got = lw.score_frame(_weights(), _frame([_fire(dte=dte)]))
    assert (got.iloc[0] is not pd.NA) is scored


def test_an_unknown_tod_on_a_scored_row_raises_and_on_a_gated_row_does_not():
    w = _weights()
    gated = _fire(tod="PRE", cum_ncp_at_fire=1.0, cum_npp_at_fire=2.0)
    assert lw.score_frame(w, _frame([gated])).tolist() == [pd.NA]
    with pytest.raises(ValueError, match=r"1 scored row.*tod"):
        lw.score_frame(w, _frame([_fire(), _fire(tod="PRE")]))
    with pytest.raises(ValueError, match="tod"):
        lw.score_frame(w, _frame([_fire(tod=None)]))


def test_missing_columns_are_named():
    df = _frame([_fire()]).drop(columns=["tod", "date"])
    with pytest.raises(ValueError, match="date, tod|tod, date"):
        lw.score_frame(_weights(), df)


def test_score_frame_refuses_invalid_weights():
    w = _weights()
    w["features"]["gamma_quintile_boundaries"].reverse()
    with pytest.raises(lw.WeightsInvalid, match="gamma_quintile_boundaries"):
        lw.score_frame(w, _frame([_fire()]))


# ── Weekday overrides ───────────────────────────────────────────────────────


def _weekday_probe_weights() -> dict:
    """Monday to Friday each get their own AM_open weight (1 to 5); every other
    day falls back to the global -9."""
    w = _zeroed_weights()
    f = w["features"]
    f["tod_weights"]["AM_open"] = -9
    f["tod_weights_dow_overrides"] = {
        day: {"AM_open": i + 1, "MID": 0, "LUNCH": 0, "PM": 0}
        for i, day in enumerate(WEEKDAY_NAMES[:5])
    }
    return w


def _probe_days() -> list[date]:
    days = [date(2026, 3, 9) + timedelta(days=i) for i in range(21)]
    # A leap day, a year end and a year start, where a naive calendar slips.
    return days + [date(2024, 2, 29), date(2026, 12, 31), date(2027, 1, 1)]


@pytest.mark.parametrize(
    "as_date",
    [
        pytest.param(lambda d: d.isoformat(), id="iso string"),
        pytest.param(lambda d: d, id="datetime.date"),
        pytest.param(lambda d: pd.Timestamp(d), id="Timestamp"),
        pytest.param(lambda d: np.datetime64(d), id="datetime64"),
    ],
)
def test_the_weekday_of_the_fire_date_picks_the_tod_table(as_date):
    days = _probe_days()
    df = _frame([_fire(date=as_date(d)) for d in days])
    got = lw.score_frame(_weekday_probe_weights(), df)
    by_weekday = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5}
    want = [by_weekday.get(d.weekday(), -9) for d in days]
    assert got.tolist() == want
    assert [WEEKDAY_NAMES[d.weekday()] for d in days][:7] == list(WEEKDAY_NAMES)


def test_a_missing_fire_date_uses_the_global_tod_table():
    got = lw.score_frame(
        _weekday_probe_weights(), _frame([_fire(date=None), _fire(date=pd.NaT)])
    )
    assert got.tolist() == [-9, -9]


def test_a_weekday_with_no_override_uses_the_global_table():
    w = _weekday_probe_weights()
    del w["features"]["tod_weights_dow_overrides"]["Wednesday"]
    got = lw.score_frame(w, _frame([_fire(date="2026-03-11")]))  # a Wednesday
    assert got.tolist() == [-9]


# ── Composite bonuses ───────────────────────────────────────────────────────


def _composite(match: dict, bonus: int = 7) -> dict:
    return {
        "match": match,
        "bonus": bonus,
        "support": 40,
        "win_rate": 0.9,
        "note": "synthetic probe",
    }


@pytest.mark.parametrize(("column", "stem"), QUINTILE_FEATURES)
def test_a_null_label_composite_matches_a_null_quintile_and_nothing_else(column, stem):
    # The seed has no composite with a "null" label, so the fixture cannot
    # reach this arm; the TS unit test covers it for gamma and so does this one,
    # for each of the three features.
    w = _zeroed_weights()
    w["features"]["composite_bonuses"] = [
        _composite({"ticker": "AMZN", f"{stem}_q": "null"})
    ]
    other = next(c for c, _s in QUINTILE_FEATURES if c != column)
    df = _frame(
        [
            _fire(**{column: None}),  # the feature is NULL: matches
            _fire(**{column: 0.05}),  # a number carries "0".."4", never "null"
            _fire(**{column: None, "underlying_symbol": "SPY"}),  # other ticker
            _fire(**{other: None}),  # a different feature is NULL: no match
        ]
    )
    assert lw.score_frame(w, df).tolist() == [7, 0, 0, 0]


def test_a_numbered_label_does_not_match_a_null_quintile():
    w = _zeroed_weights()
    w["features"]["composite_bonuses"] = [
        _composite({"gamma_q": q}) for q in ("0", "1", "2", "3", "4")
    ]
    assert lw.score_frame(w, _frame([_fire(gamma_at_trigger=None)])).tolist() == [0]


def test_composites_sum_and_every_key_must_agree():
    w = _zeroed_weights()
    w["features"]["composite_bonuses"] = [
        _composite({"ticker": "AMZN"}, bonus=3),
        _composite({"ticker": "AMZN", "tod": "AM_open"}, bonus=2),
        _composite({"ticker": "AMZN", "tod": "MID"}, bonus=-5),
        _composite({"tod": "AM_open", "gamma_q": "2", "vol_oi_q": "2"}, bonus=4),
    ]
    # gamma 0.03 and vol_oi 0.1 both sit in quintile 2 under the seed bounds.
    fire = _fire(gamma_at_trigger=0.03, trigger_vol_to_oi_window=0.1)
    assert lw.score_frame(w, _frame([fire])).tolist() == [3 + 2 + 4]


# ── Weights as data ─────────────────────────────────────────────────────────


def test_a_weights_copy_moves_the_score_by_exactly_the_change():
    w = _weights()
    base = lw.score_frame(w, _frame([_fire(underlying_symbol="SNDK", tod="MID")]))
    w["features"]["ticker_weights"]["SNDK"] += 3
    bumped = lw.score_frame(w, _frame([_fire(underlying_symbol="SNDK", tod="MID")]))
    assert bumped.tolist() == [base.iloc[0] + 3]


def test_integral_float_weights_score_as_integers():
    w = _zeroed_weights()
    w["features"]["ticker_weights"]["AMZN"] = 3.0
    w["features"]["option_type_weights"]["C"] = -2.0
    got = lw.score_frame(w, _frame([_fire()]))
    assert str(got.dtype) == "Int64"
    assert got.tolist() == [1]


def _decimal(value):
    return None if value is None else Decimal(repr(float(value)))


def test_postgres_decimals_and_pandas_nullable_dtypes_score_the_same():
    df = _frame([c["fire"] for c in CASES])
    want = lw.score_frame(FIXTURE["weights"], df).tolist()

    numeric = [
        "trigger_vol_to_oi_window",
        "gamma_at_trigger",
        "trigger_ask_pct",
        "cum_ncp_at_fire",
        "cum_npp_at_fire",
    ]
    as_decimal = df.copy()
    for column in numeric:
        as_decimal[column] = pd.Series(
            [_decimal(v) if not pd.isna(v) else None for v in df[column]],
            index=df.index,
            dtype=object,
        )
    as_decimal["dte"] = pd.Series(df["dte"].tolist(), index=df.index, dtype=object)

    nullable = df.astype(
        {
            "trigger_vol_to_oi_window": "Float64",
            "gamma_at_trigger": "Float64",
            "trigger_ask_pct": "Float64",
            "cum_ncp_at_fire": "Float64",
            "cum_npp_at_fire": "Float64",
            "dte": "Int64",
            "underlying_symbol": "string",
            "option_type": "category",
            "tod": "category",
        }
    )
    nullable["date"] = pd.to_datetime(df["date"])

    for label, frame in (("Decimal", as_decimal), ("nullable", nullable)):
        got = lw.score_frame(FIXTURE["weights"], frame).tolist()
        mismatches = [
            (c["name"], label)
            for c, g, e in zip(CASES, got, want, strict=True)
            if not _same(g, None if e is pd.NA else e)
        ]
        assert mismatches == []


def test_missing_text_cells_in_nullable_columns_do_not_crash_the_scorer():
    # A pandas "string" column holds NULL as pd.NA, and pd.NA == "C" is NA, not
    # False; the scorer must still read it as "not a call".
    w = _zeroed_weights()
    w["features"]["ticker_weights"]["AMZN"] = 3
    df = _frame(
        [_fire(), _fire(option_type=None), _fire(underlying_symbol=None)]
    ).astype({"underlying_symbol": "string", "option_type": "string", "tod": "string"})
    assert df["option_type"].isna().sum() == 1
    assert df["underlying_symbol"].isna().sum() == 1
    assert lw.score_frame(w, df).tolist() == [3, pd.NA, 0]


# ── validate_weights ────────────────────────────────────────────────────────


def _walk(w, dotted):
    *parents, last = dotted.split(".")
    node = w
    for part in parents:
        node = node[int(part)] if isinstance(node, list) else node[part]
    return node, (int(last) if isinstance(node, list) else last)


def set_(dotted, value):
    def mutate(w):
        node, key = _walk(w, dotted)
        node[key] = value

    return mutate


def drop(dotted):
    def mutate(w):
        node, key = _walk(w, dotted)
        del node[key]

    return mutate


def apply(*mutations):
    def mutate(w):
        for m in mutations:
            m(w)

    return mutate


def _many_tickers(w):
    w["features"]["ticker_weights"] = {f"T{i}": 0 for i in range(501)}


def _many_composites(w):
    first = w["features"]["composite_bonuses"][0]
    w["features"]["composite_bonuses"] = [copy.deepcopy(first) for _ in range(51)]


def _rename_win_rate(w):
    entry = w["features"]["composite_bonuses"][0]
    entry["winRate"] = entry.pop("win_rate")


def _equal_boundaries(w):
    b = w["features"]["vol_oi_quintile_boundaries"]
    b[1] = b[0]


def _reverse(dotted):
    def mutate(w):
        node, key = _walk(w, dotted)
        node[key].reverse()

    return mutate


def _pop(dotted):
    def mutate(w):
        node, key = _walk(w, dotted)
        node[key].pop()

    return mutate


def _push(dotted, value):
    def mutate(w):
        node, key = _walk(w, dotted)
        node[key].append(value)

    return mutate


F = "features"
CB0 = "features.composite_bonuses.0"
OVR = "features.tod_weights_dow_overrides"

# One malformed copy of the seed per case: (label, mutation, path, rule). The
# TS suite's "the schema rejects" table (api/__tests__/lottery-score-weights-
# v2.test.ts) is ported case for case, with the Python-side extras at the end.
REJECTED = [
    # Unknown keys: "no unknown keys anywhere".
    ("an unknown key at the top level", set_("extra", 1), "extra", "unknown_key"),
    (
        "an unknown key in features",
        set_("features.extra", 1),
        "features.extra",
        "unknown_key",
    ),
    (
        "an unknown key in cutoffs",
        set_("cutoffs.derivation", "x"),
        "cutoffs.derivation",
        "unknown_key",
    ),
    (
        "an unknown key in feed_cutoffs",
        set_("feed_cutoffs.extra", 1),
        "feed_cutoffs.extra",
        "unknown_key",
    ),
    (
        "an unknown key in a composite",
        set_(f"{CB0}.extra", 1),
        f"{CB0}.extra",
        "unknown_key",
    ),
    (
        "an unknown key in a composite match",
        set_(f"{CB0}.match.extra", "1"),
        f"{CB0}.match.extra",
        "unknown_key",
    ),
    # Boundaries.
    (
        "NaN in a boundary",
        set_("features.gamma_quintile_boundaries.0", math.nan),
        "features.gamma_quintile_boundaries.0",
        "finite",
    ),
    (
        "numpy NaN in a boundary",
        set_("features.gamma_quintile_boundaries.0", np.float64("nan")),
        "features.gamma_quintile_boundaries.0",
        "finite",
    ),
    (
        "Infinity in a boundary",
        set_("features.ask_pct_quintile_boundaries.3", math.inf),
        "features.ask_pct_quintile_boundaries.3",
        "finite",
    ),
    (
        "-Infinity in a boundary",
        set_("features.vol_oi_quintile_boundaries.0", -math.inf),
        "features.vol_oi_quintile_boundaries.0",
        "finite",
    ),
    (
        "an int too large for a double in a boundary",
        set_("features.gamma_quintile_boundaries.3", 10**400),
        "features.gamma_quintile_boundaries.3",
        "finite",
    ),
    (
        "equal boundaries",
        _equal_boundaries,
        "features.vol_oi_quintile_boundaries",
        "increasing",
    ),
    (
        "decreasing boundaries",
        _reverse("features.gamma_quintile_boundaries"),
        "features.gamma_quintile_boundaries",
        "increasing",
    ),
    (
        "3 boundaries",
        _pop("features.ask_pct_quintile_boundaries"),
        "features.ask_pct_quintile_boundaries",
        "length",
    ),
    (
        "5 boundaries",
        _push("features.vol_oi_quintile_boundaries", 9),
        "features.vol_oi_quintile_boundaries",
        "length",
    ),
    (
        "a boundary that is a string",
        set_("features.gamma_quintile_boundaries.1", "0.5"),
        "features.gamma_quintile_boundaries.1",
        "type",
    ),
    (
        "a boundary that is a bool",
        set_("features.gamma_quintile_boundaries.1", True),
        "features.gamma_quintile_boundaries.1",
        "type",
    ),
    (
        "a boundary that is None",
        set_("features.gamma_quintile_boundaries.1", None),
        "features.gamma_quintile_boundaries.1",
        "type",
    ),
    (
        "boundaries that are not a list",
        set_("features.gamma_quintile_boundaries", "0.1,0.2,0.3,0.4"),
        "features.gamma_quintile_boundaries",
        "type",
    ),
    # Weights.
    (
        "a ticker weight of 11",
        set_("features.ticker_weights.AAPL", 11),
        "features.ticker_weights.<ticker>",
        "range",
    ),
    (
        "a ticker weight of -6",
        set_("features.ticker_weights.AAPL", -6),
        "features.ticker_weights.<ticker>",
        "range",
    ),
    (
        "a fractional weight",
        set_("features.tod_weights.MID", 0.5),
        "features.tod_weights.MID",
        "integer",
    ),
    (
        "a fractional ticker weight",
        set_("features.ticker_weights.AAPL", 0.5),
        "features.ticker_weights.<ticker>",
        "integer",
    ),
    (
        "a NaN weight",
        set_("features.dte_weights.0", math.nan),
        "features.dte_weights.0",
        "finite",
    ),
    (
        "a numpy NaN weight",
        set_("features.dte_weights.0", np.float64("nan")),
        "features.dte_weights.0",
        "finite",
    ),
    (
        "an infinite weight",
        set_("features.dte_weights.1", math.inf),
        "features.dte_weights.1",
        "finite",
    ),
    (
        "True as a weight",
        set_("features.ticker_weights.AAPL", True),
        "features.ticker_weights.<ticker>",
        "type",
    ),
    (
        "False as a weight",
        set_("features.tod_weights.MID", False),
        "features.tod_weights.MID",
        "type",
    ),
    (
        "numpy True as a weight",
        set_("features.tod_weights.MID", np.True_),
        "features.tod_weights.MID",
        "type",
    ),
    (
        "a string weight",
        set_("features.option_type_weights.C", "1"),
        "features.option_type_weights.C",
        "type",
    ),
    (
        "None as a weight",
        set_("features.ticker_weights.AAPL", None),
        "features.ticker_weights.<ticker>",
        "type",
    ),
    (
        "a float weight beyond the safe integers",
        set_("features.tod_weights.PM", 1e20),
        "features.tod_weights.PM",
        "range",
    ),
    (
        "a tod weight of 21",
        set_("features.tod_weights.PM", 21),
        "features.tod_weights.PM",
        "range",
    ),
    (
        "a dte weight of -21",
        set_("features.dte_weights.2", -21),
        "features.dte_weights.2",
        "range",
    ),
    (
        "an option-type weight of 21",
        set_("features.option_type_weights.P", 21),
        "features.option_type_weights.P",
        "range",
    ),
    (
        "a quintile weight of 21",
        set_("features.gamma_quintile_weights.4", 21),
        "features.gamma_quintile_weights.4",
        "range",
    ),
    (
        "4 quintile weights",
        _pop("features.vol_oi_quintile_weights"),
        "features.vol_oi_quintile_weights",
        "length",
    ),
    (
        "6 quintile weights",
        _push("features.ask_pct_quintile_weights", 0),
        "features.ask_pct_quintile_weights",
        "length",
    ),
    # Tables.
    (
        "a ticker key in lower case",
        set_("features.ticker_weights.aapl", 0),
        "features.ticker_weights.<ticker>",
        "pattern",
    ),
    (
        "a ticker key of 11 characters",
        set_("features.ticker_weights.ABCDEFGHIJK", 0),
        "features.ticker_weights.<ticker>",
        "pattern",
    ),
    (
        "a ticker key with a trailing newline",
        set_("features.ticker_weights.AAPL\n", 0),
        "features.ticker_weights.<ticker>",
        "pattern",
    ),
    (
        "a ticker key with a full-width letter",
        set_("features.ticker_weights.Ａ", 0),
        "features.ticker_weights.<ticker>",
        "pattern",
    ),
    (
        "no tickers",
        set_("features.ticker_weights", {}),
        "features.ticker_weights",
        "size",
    ),
    ("501 tickers", _many_tickers, "features.ticker_weights", "size"),
    (
        "ticker_weights that is a list",
        set_("features.ticker_weights", [1]),
        "features.ticker_weights",
        "type",
    ),
    (
        "a tod_weights key missing",
        drop("features.tod_weights.PM"),
        "features.tod_weights.PM",
        "missing",
    ),
    (
        "an extra tod_weights key",
        set_("features.tod_weights.EVENING", 0),
        "features.tod_weights.EVENING",
        "unknown_key",
    ),
    (
        "a dte_weights key missing",
        drop("features.dte_weights.3"),
        "features.dte_weights.3",
        "missing",
    ),
    (
        "a dte_weights key '4'",
        set_("features.dte_weights.4", 0),
        "features.dte_weights.4",
        "unknown_key",
    ),
    (
        "an extra option_type_weights key",
        set_("features.option_type_weights.X", 0),
        "features.option_type_weights.X",
        "unknown_key",
    ),
    (
        "an option_type_weights key missing",
        drop("features.option_type_weights.P"),
        "features.option_type_weights.P",
        "missing",
    ),
    (
        "an integer dte_weights key",
        apply(
            drop("features.dte_weights.0"),
            lambda w: w["features"]["dte_weights"].update({0: 2}),
        ),
        "features.dte_weights.0",
        "unknown_key",
    ),
    (
        "a Saturday override",
        set_(f"{OVR}.Saturday", {"AM_open": 0, "MID": 0, "LUNCH": 0, "PM": 0}),
        f"{OVR}.Saturday",
        "unknown_key",
    ),
    (
        "an override missing a tod",
        drop(f"{OVR}.Monday.LUNCH"),
        f"{OVR}.Monday.LUNCH",
        "missing",
    ),
    ("an override of None", set_(f"{OVR}.Monday", None), f"{OVR}.Monday", "type"),
    ("an override table that is a list", set_(OVR, []), OVR, "type"),
    # Composites.
    (
        "a q label '5'",
        set_(f"{CB0}.match.gamma_q", "5"),
        f"{CB0}.match.gamma_q",
        "enum",
    ),
    (
        "a numeric q label",
        set_(f"{CB0}.match.gamma_q", 0),
        f"{CB0}.match.gamma_q",
        "enum",
    ),
    (
        "a None q label",
        set_(f"{CB0}.match.gamma_q", None),
        f"{CB0}.match.gamma_q",
        "enum",
    ),
    ("an empty composite match", set_(f"{CB0}.match", {}), f"{CB0}.match", "empty"),
    (
        "a composite match that is a list",
        set_(f"{CB0}.match", ["ticker"]),
        f"{CB0}.match",
        "type",
    ),
    (
        "a composite tod outside the four",
        set_(f"{CB0}.match.tod", "EVENING"),
        f"{CB0}.match.tod",
        "enum",
    ),
    (
        "a composite ticker that is not a string",
        set_(f"{CB0}.match.ticker", 5),
        f"{CB0}.match.ticker",
        "type",
    ),
    (
        "a composite ticker of None",
        set_(f"{CB0}.match.ticker", None),
        f"{CB0}.match.ticker",
        "type",
    ),
    ("a composite bonus of 11", set_(f"{CB0}.bonus", 11), f"{CB0}.bonus", "range"),
    ("a composite bonus of -11", set_(f"{CB0}.bonus", -11), f"{CB0}.bonus", "range"),
    (
        "a fractional composite bonus",
        set_(f"{CB0}.bonus", 2.5),
        f"{CB0}.bonus",
        "integer",
    ),
    (
        "a negative composite support",
        set_(f"{CB0}.support", -1),
        f"{CB0}.support",
        "range",
    ),
    (
        "a fractional composite support",
        set_(f"{CB0}.support", 2.5),
        f"{CB0}.support",
        "integer",
    ),
    (
        "a composite support past the safe integers",
        set_(f"{CB0}.support", 2**53),
        f"{CB0}.support",
        "range",
    ),
    ("a win_rate above 1", set_(f"{CB0}.win_rate", 1.01), f"{CB0}.win_rate", "range"),
    ("a win_rate below 0", set_(f"{CB0}.win_rate", -0.01), f"{CB0}.win_rate", "range"),
    ("a NaN win_rate", set_(f"{CB0}.win_rate", math.nan), f"{CB0}.win_rate", "finite"),
    (
        "a camelCase winRate in place of win_rate",
        _rename_win_rate,
        f"{CB0}.winRate",
        "unknown_key",
    ),
    ("a composite without a note", drop(f"{CB0}.note"), f"{CB0}.note", "missing"),
    (
        "a composite note that is not a string",
        set_(f"{CB0}.note", 3),
        f"{CB0}.note",
        "type",
    ),
    ("51 composites", _many_composites, "features.composite_bonuses", "size"),
    (
        "composites that are a dict",
        set_("features.composite_bonuses", {}),
        "features.composite_bonuses",
        "type",
    ),
    # Cutoffs.
    (
        "t1 equal to t2",
        apply(set_("cutoffs.t1", 6), set_("cutoffs.t2", 6)),
        "cutoffs",
        "order",
    ),
    (
        "t1 below t2",
        apply(set_("cutoffs.t1", 5), set_("cutoffs.t2", 6)),
        "cutoffs",
        "order",
    ),
    ("a fractional t1", set_("cutoffs.t1", 10.5), "cutoffs.t1", "integer"),
    ("a t1 past the safe integers", set_("cutoffs.t1", 2**53), "cutoffs.t1", "range"),
    (
        "a t2 below the safe integers",
        set_("cutoffs.t2", -(2**53)),
        "cutoffs.t2",
        "range",
    ),
    ("a missing t2", drop("cutoffs.t2"), "cutoffs.t2", "missing"),
    (
        "tier1_min_score equal to tier2_min_score",
        set_("feed_cutoffs.tier1_min_score", 10),
        "feed_cutoffs",
        "order",
    ),
    (
        "tier1_min_score below tier2_min_score",
        apply(
            set_("feed_cutoffs.tier1_min_score", 5),
            set_("feed_cutoffs.tier2_min_score", 9),
        ),
        "feed_cutoffs",
        "order",
    ),
    (
        "a fractional tier1_min_score",
        set_("feed_cutoffs.tier1_min_score", 13.5),
        "feed_cutoffs.tier1_min_score",
        "integer",
    ),
    (
        "a negative tier2_min_score",
        set_("feed_cutoffs.tier2_min_score", -1),
        "feed_cutoffs.tier2_min_score",
        "range",
    ),
    (
        "a fractional tier2_min_score",
        set_("feed_cutoffs.tier2_min_score", 9.5),
        "feed_cutoffs.tier2_min_score",
        "integer",
    ),
    # Header fields.
    ("schema_version 2", set_("schema_version", 2), "schema_version", "literal"),
    ("schema_version True", set_("schema_version", True), "schema_version", "literal"),
    ("schema_version '1'", set_("schema_version", "1"), "schema_version", "literal"),
    ("a missing schema_version", drop("schema_version"), "schema_version", "missing"),
    ("an empty model_version", set_("model_version", ""), "model_version", "empty"),
    (
        "a model_version that is not a string",
        set_("model_version", 3),
        "model_version",
        "type",
    ),
    (
        "a trained_through that is not a date",
        set_("trained_through", "2026-13-01"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through of a non-leap Feb 29",
        set_("trained_through", "2026-02-29"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through of 1900-02-29",
        set_("trained_through", "1900-02-29"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through with a time part",
        set_("trained_through", "2026-06-16T00:00:00Z"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through with a trailing newline",
        set_("trained_through", "2026-06-16\n"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through with leading space",
        set_("trained_through", " 2026-06-16"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through in full-width digits",
        set_("trained_through", "２０２６-06-16"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through without zero padding",
        set_("trained_through", "2026-6-16"),
        "trained_through",
        "date",
    ),
    (
        "a trained_through that is a date object",
        set_("trained_through", date(2026, 6, 16)),
        "trained_through",
        "type",
    ),
    ("a missing features block", drop("features"), "features", "missing"),
    ("a features block that is a list", set_("features", []), "features", "type"),
]


@pytest.mark.parametrize(
    ("mutate", "path", "rule"),
    [pytest.param(m, p, r, id=label) for label, m, p, r in REJECTED],
)
def test_validate_rejects(mutate, path, rule):
    w = _weights()
    mutate(w)
    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(w)
    assert str(caught.value) == f"{path}: {rule}"
    assert (caught.value.path, caught.value.rule) == (path, rule)


@pytest.mark.parametrize("bad", [None, [], [1], 1, "x", True, (1, 2)])
def test_validate_rejects_a_root_that_is_not_an_object(bad):
    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(bad)
    assert str(caught.value) == "$: type"


@pytest.mark.parametrize(
    ("symbol", "weight", "rule"),
    [
        ("AAPL", 11, "range"),
        ("MSFT", None, "type"),
        ("NVDA", 0.5, "integer"),
        ("aapl", 0, "pattern"),
        ("ABCDEFGHIJK", 0, "pattern"),
        ("AAPL\n", 0, "pattern"),
        ("Ａ", 0, "pattern"),
    ],
)
def test_a_malformed_ticker_entry_is_named_by_its_slot_never_its_symbol(
    symbol, weight, rule
):
    # The message of a stored row that fails validation reaches logs and Sentry as the
    # step's exception text, and a symbol is market data that must not travel with it.
    w = _weights()
    w["features"]["ticker_weights"] = {symbol: weight}

    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(w)

    assert str(caught.value) == f"features.ticker_weights.<ticker>: {rule}"
    assert caught.value.path == "features.ticker_weights.<ticker>"
    assert symbol.strip() not in str(caught.value)
    assert symbol.strip() not in repr(caught.value)


@pytest.mark.parametrize(
    "key",
    ["two\nlines", "a b", "x" * 100, "ünï", "AAPL" + "!" * 30],
    ids=["newline", "space", "long", "non-ascii", "symbol-and-punctuation"],
)
def test_an_unusual_unknown_key_is_written_as_a_short_repr_on_one_line(key):
    # Only the ticker table is data by design; any other unknown key is a stored row's own
    # text, which can hold anything: it is quoted and cut, so a path stays one short line.
    w = _weights()
    w["features"]["tod_weights"][key] = 0

    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(w)

    message = str(caught.value)
    assert caught.value.rule == "unknown_key"
    assert "\n" not in message
    segment = caught.value.path.removeprefix("features.tod_weights.")
    shown = repr(key)
    # The repr, cut to 40 characters with `...` where it was cut.
    assert segment == (shown if len(shown) <= 40 else f"{shown[:37]}...")
    assert len(segment) <= 40
    assert key not in message or len(key) <= 37  # a long key is never shown whole


def test_a_plain_unknown_key_keeps_its_name_in_the_path():
    # A name, a digit string or an index reads as before: the REJECTED table pins the rest.
    w = _weights()
    w["features"]["tod_weights"]["EVENING"] = 0

    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(w)

    assert caught.value.path == "features.tod_weights.EVENING"


def _all_weekday_overrides(w):
    monday = w["features"]["tod_weights_dow_overrides"]["Monday"]
    w["features"]["tod_weights_dow_overrides"] = {
        d: dict(monday) for d in WEEKDAY_NAMES[:5]
    }


def _range_edges(w):
    f = w["features"]
    f["ticker_weights"]["AAPL"] = -5
    f["ticker_weights"]["AMD"] = 10
    f["tod_weights"]["AM_open"] = 20
    f["tod_weights"]["PM"] = -20
    f["composite_bonuses"][0]["bonus"] = 10
    f["composite_bonuses"][1]["bonus"] = -10
    f["composite_bonuses"][0]["support"] = 0
    f["composite_bonuses"][0]["win_rate"] = 1
    f["composite_bonuses"][1]["win_rate"] = 0
    f["composite_bonuses"][2]["match"] = {"gamma_q": "null"}
    w["feed_cutoffs"] = {"tier1_min_score": 1, "tier2_min_score": 0}
    w["cutoffs"] = {"t1": -3, "t2": -4}


def _numpy_scalars(w):
    f = w["features"]
    f["ticker_weights"] = {t: np.int64(v) for t, v in f["ticker_weights"].items()}
    f["gamma_quintile_boundaries"] = [
        np.float64(b) for b in f["gamma_quintile_boundaries"]
    ]
    f["tod_weights"] = {t: np.int32(v) for t, v in f["tod_weights"].items()}
    f["composite_bonuses"][0]["win_rate"] = np.float32(0.5)


def _tuples(w):
    f = w["features"]
    f["gamma_quintile_boundaries"] = tuple(f["gamma_quintile_boundaries"])
    f["vol_oi_quintile_weights"] = tuple(f["vol_oi_quintile_weights"])
    f["composite_bonuses"] = tuple(f["composite_bonuses"])


def _five_hundred_tickers(w):
    w["features"]["ticker_weights"] = {f"T{i}": 0 for i in range(500)}


def _fifty_composites(w):
    first = w["features"]["composite_bonuses"][0]
    w["features"]["composite_bonuses"] = [copy.deepcopy(first) for _ in range(50)]


ACCEPTED = [
    ("the seed unchanged", lambda w: None),
    ("an empty override table", set_(OVR, {})),
    ("overrides for Monday to Friday", _all_weekday_overrides),
    ("the boundary values of every range", _range_edges),
    ("500 tickers", _five_hundred_tickers),
    ("50 composites", _fifty_composites),
    ("no composites", set_("features.composite_bonuses", [])),
    # JS cannot tell 3.0 from 3, so Zod takes it; 3.5 is still refused above.
    ("a float 3.0 where an int is required", set_("features.ticker_weights.AAPL", 3.0)),
    ("a float 3.0 as a composite bonus", set_(f"{CB0}.bonus", 3.0)),
    ("a float 1.0 as schema_version", set_("schema_version", 1.0)),
    ("a float 13.0 as a cutoff", set_("feed_cutoffs.tier1_min_score", 13.0)),
    ("negative zero as a weight", set_("features.ticker_weights.AAPL", -0.0)),
    ("integer boundaries", set_("features.gamma_quintile_boundaries", [0, 1, 2, 3])),
    (
        "negative boundaries",
        set_("features.gamma_quintile_boundaries", [-4, -3, -2, -1]),
    ),
    (
        "a composite ticker outside the ticker pattern",
        set_(f"{CB0}.match.ticker", "not a ticker!"),
    ),
    ("a composite ticker of the empty string", set_(f"{CB0}.match.ticker", "")),
    ("a composite note of the empty string", set_(f"{CB0}.note", "")),
    (
        "a composite match of only a null label",
        set_(f"{CB0}.match", {"ask_pct_q": "null"}),
    ),
    ("a support at the largest safe integer", set_(f"{CB0}.support", 2**53 - 1)),
    (
        "cutoffs at both edges of the safe integers",
        apply(set_("cutoffs.t1", 2**53 - 1), set_("cutoffs.t2", -(2**53 - 1))),
    ),
    ("a trained_through on a leap day", set_("trained_through", "2024-02-29")),
    ("a trained_through of 2000-02-29", set_("trained_through", "2000-02-29")),
    (
        "a trained_through of year 0000, as Zod's date pattern allows",
        set_("trained_through", "0000-02-29"),
    ),
    ("numpy scalars", _numpy_scalars),
    ("tuples for arrays", _tuples),
]


@pytest.mark.parametrize("mutate", [pytest.param(m, id=label) for label, m in ACCEPTED])
def test_validate_accepts(mutate):
    w = _weights()
    mutate(w)
    lw.validate_weights(w)  # does not raise


def test_validate_accepts_the_fixture_weights():
    lw.validate_weights(FIXTURE["weights"])
    assert FIXTURE["version"] == lw.SEED_VERSION


def test_validate_accepts_the_non_seed_fixture_weights():
    lw.validate_weights(ALT_FIXTURE["weights"])
    # A refit's id is its training date, so the fixture's two must agree, and
    # neither may be the seed's.
    trained = date.fromisoformat(ALT_FIXTURE["weights"]["trained_through"])
    assert ALT_FIXTURE["version"] == lw.refit_version_id(trained)
    assert ALT_FIXTURE["version"] != lw.SEED_VERSION
    assert ALT_FIXTURE["weights"] != FIXTURE["weights"]


def test_validate_leaves_its_input_alone():
    w = _weights()
    before = copy.deepcopy(w)
    lw.validate_weights(w)
    assert w == before


@pytest.mark.parametrize(
    ("mutate", "secret"),
    [
        (set_("features.ticker_weights.AAPL", 424242), "424242"),
        (set_("features.tod_weights.MID", 0.123456789), "0.123456789"),
        (set_(f"{CB0}.match.gamma_q", "TOP-SECRET-LABEL"), "TOP-SECRET-LABEL"),
        (set_(f"{CB0}.note", 98765.4321), "98765.4321"),
        (set_("model_version", 31337), "31337"),
        (set_("trained_through", "not-a-date-4711"), "4711"),
        (set_("schema_version", 99999), "99999"),
        (set_("features.gamma_quintile_boundaries.2", "bad-bound-5150"), "5150"),
    ],
)
def test_error_message_names_the_path_not_the_value(mutate, secret):
    w = _weights()
    mutate(w)
    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.validate_weights(w)
    shown = [str(caught.value), repr(caught.value), *map(str, caught.value.args)]
    assert not any(secret in text for text in shown)
    assert re.fullmatch(r"[A-Za-z0-9_.$<>]+: [a-z_]+", str(caught.value))
    assert isinstance(caught.value, ValueError)


# ── Version ids ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("day", "want"),
    [
        (date(2026, 11, 5), "refit-2026-11-05"),
        (date(2026, 12, 31), "refit-2026-12-31"),
        (date(2024, 2, 29), "refit-2024-02-29"),
        (date(2026, 1, 1), "refit-2026-01-01"),
    ],
)
def test_refit_version_id_format(day, want):
    got = lw.refit_version_id(day)
    assert got == want
    # The database check on lottery_score_versions.version.
    assert re.fullmatch(r"(seed|refit)-\d{4}-\d{2}-\d{2}", got)


def test_refit_version_id_takes_a_date_not_a_timestamp_or_a_string():
    for bad in (
        datetime(2026, 11, 5, 3, 0),
        pd.Timestamp("2026-11-05"),
        "2026-11-05",
        None,
    ):
        with pytest.raises(TypeError):
            lw.refit_version_id(bad)


def test_the_seed_version_matches_the_fixture_and_the_database_pattern():
    assert lw.SEED_VERSION == "seed-2026-06-17"
    assert re.fullmatch(r"(seed|refit)-\d{4}-\d{2}-\d{2}", lw.SEED_VERSION)
    assert lw.SCHEMA_VERSION == 1
    assert lw.SCORE_COLUMNS == (
        "underlying_symbol",
        "option_type",
        "tod",
        "dte",
        "trigger_vol_to_oi_window",
        "gamma_at_trigger",
        "trigger_ask_pct",
        "cum_ncp_at_fire",
        "cum_npp_at_fire",
        "date",
    )


# ── load_pointer ────────────────────────────────────────────────────────────


class _FakeCursor:
    def __init__(self, row, log):
        self._row = row
        self._log = log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._log.append("closed")
        return False

    def execute(self, sql, params=None):
        self._log.append(("execute", sql, params))

    def fetchone(self):
        return self._row


class _FakeConn:
    """Stands in for a psycopg2 connection: one cursor, one canned row."""

    def __init__(self, row):
        self.row = row
        self.log: list = []

    def cursor(self):
        return _FakeCursor(self.row, self.log)


@pytest.mark.parametrize("name", ["active", "takeit"])
def test_load_pointer_returns_the_version_and_validated_weights(name):
    w = _weights()
    conn = _FakeConn(("refit-2026-11-04", w))
    assert lw.load_pointer(conn, name) == ("refit-2026-11-04", w)


def test_load_pointer_reads_a_dict_row_by_column_name():
    w = _weights()
    conn = _FakeConn({"version": "seed-2026-06-17", "weights": w})
    assert lw.load_pointer(conn, "active") == ("seed-2026-06-17", w)


def test_load_pointer_only_reads_and_closes_its_cursor():
    conn = _FakeConn(("seed-2026-06-17", _weights()))
    lw.load_pointer(conn, "takeit")
    kind, sql, params = conn.log[0]
    assert kind == "execute"
    assert sql.lstrip().upper().startswith("SELECT")
    assert not re.search(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b", sql, re.I)
    assert "lottery_score_pointers" in sql
    assert "lottery_score_versions" in sql
    assert "p.name = %s" in sql
    assert params == ("takeit",)  # parameterised, never formatted into the text
    assert "takeit" not in sql
    assert conn.log[-1] == "closed"


def test_load_pointer_validates_the_row():
    bad = _weights()
    bad["features"]["tod_weights"]["MID"] = 21
    conn = _FakeConn(("refit-2026-11-04", bad))
    with pytest.raises(lw.WeightsInvalid) as caught:
        lw.load_pointer(conn, "active")
    assert str(caught.value) == "features.tod_weights.MID: range"
    assert conn.log[-1] == "closed"


def test_load_pointer_with_no_row_raises_a_lookup_error_naming_the_pointer():
    conn = _FakeConn(None)
    with pytest.raises(LookupError, match="active"):
        lw.load_pointer(conn, "active")


@pytest.mark.parametrize("name", ["promoted", "", "ACTIVE", None])
def test_load_pointer_refuses_an_unknown_name_before_any_query(name):
    conn = _FakeConn(("seed-2026-06-17", _weights()))
    with pytest.raises(ValueError, match="pointer"):
        lw.load_pointer(conn, name)
    assert conn.log == []


# ── The module stands alone ─────────────────────────────────────────────────


def test_module_imports_without_scipy_or_utils():
    # The nightly image gets this one file, plus numpy and pandas. A subprocess
    # in isolated mode (-I: no PYTHONPATH, no cwd on sys.path) shows what the
    # import itself pulls in.
    probe = (
        "import json, os, sys\n"
        "src = sys.argv[1]\n"
        "sys.path.insert(0, src)\n"
        "import lottery_weights\n"
        "own = [\n"
        "    name for name, mod in sys.modules.items()\n"
        "    if name != 'lottery_weights'\n"
        "    and getattr(mod, '__file__', None)\n"
        "    and os.path.abspath(mod.__file__).startswith(os.path.abspath(src))\n"
        "]\n"
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
        "siblings": [],
    }
