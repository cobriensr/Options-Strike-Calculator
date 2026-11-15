"""One Python home for the lottery score weights: the shape check, the version
ids, and a scorer that gives the same number the TypeScript scorer gives.

Why this exists. The nightly refit trains new weights, gates them against the
live ones, and promotes the winner by rescoring every stored fire. The live
scorer is ``scoreLotteryV2`` (api/_lib/lottery-score-weights-v2.ts), a pure
function of a weights object that the API checks with ``LotteryWeightsSchema``
(api/_lib/lottery-weights-schema.ts). The refit side must check the same rules
and score by the same arithmetic, or a version it promotes would score
differently in the cron than in the gate that approved it. This module is that
twin:

* ``validate_weights``  the Zod schema, rule for rule.
* ``refit_version_id``  the id a refit is stored under.
* ``assign_quintile``   ``assignQuintile``: right-closed, a value on a boundary
                        goes to the lower bucket.
* ``score_frame``       ``scoreLotteryV2`` over a DataFrame of fires.
* ``load_pointer``      the weights a store pointer (``active``, ``takeit``)
                        names, validated.

The anchor is api/__tests__/fixtures/lottery-score-parity.json, replayed by the
TS test and by ml/tests/test_lottery_weights.py.

This file is copied on its own into the nightly image (Python 3.12), so it uses
numpy and pandas only: no scipy, no ``utils``, no sibling module, nothing newer
than 3.12. Spec: docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md
(D5 and Task 12).
"""

from __future__ import annotations

import calendar
import math
import numbers
import re
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any, Literal, NoReturn

import numpy as np
import pandas as pd

SCHEMA_VERSION = 1
SEED_VERSION = "seed-2026-06-17"

# The columns ``score_frame`` reads: lottery_finder_fires' names, as the TS
# parity fixture spells them.
SCORE_COLUMNS = (
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

__all__ = [
    "SCHEMA_VERSION",
    "SCORE_COLUMNS",
    "SEED_VERSION",
    "WeightsInvalid",
    "assign_quintile",
    "load_pointer",
    "refit_version_id",
    "score_frame",
    "validate_weights",
]

_TODS = ("AM_open", "MID", "LUNCH", "PM")
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
_DTES = ("0", "1", "2", "3")
_OPTION_TYPES = ("C", "P")
_Q_LABELS = ("0", "1", "2", "3", "4", "null")
_MATCH_KEYS = ("ticker", "tod", "gamma_q", "vol_oi_q", "ask_pct_q")
_QUINTILES = ("vol_oi", "gamma", "ask_pct")
_POINTER_NAMES = ("active", "takeit")

# `re.fullmatch`, not `^...$`: Python's `$` also matches before a trailing
# newline, JS's does not, so "AAPL\n" would pass here and fail in Zod.
_TICKER_KEY = re.compile(r"[A-Z][A-Z0-9.]{0,9}")
# What a path says for a key that is data: an entry of `ticker_weights` (a symbol), and any
# key the schema does not define. Never the key's own text: a stored row can put a symbol
# anywhere, and the message reaches logs and Sentry.
_TICKER_SEGMENT = "<ticker>"
_UNKNOWN_SEGMENT = "<key>"
# [0-9], not \d: Python's \d takes any Unicode digit, JS's takes only ASCII.
_ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

# Zod's `.int()` is a safe-integer check: 2**53 and beyond are refused.
_MAX_SAFE_INT = 2**53 - 1

_POINTER_SQL = (
    "SELECT v.version, v.weights "
    "FROM lottery_score_pointers p "
    "JOIN lottery_score_versions v ON v.version = p.version "
    "WHERE p.name = %s"
)

_FEATURE_KEYS = (
    "ticker_weights",
    "tod_weights",
    "tod_weights_dow_overrides",
    "dte_weights",
    "vol_oi_quintile_weights",
    "vol_oi_quintile_boundaries",
    "gamma_quintile_weights",
    "gamma_quintile_boundaries",
    "ask_pct_quintile_weights",
    "ask_pct_quintile_boundaries",
    "option_type_weights",
    "composite_bonuses",
)


# ── Validation ──────────────────────────────────────────────────────────────


class WeightsInvalid(ValueError):
    """A weights object broke a rule.

    The message is the dotted path of the offending field and the name of the
    rule it broke, ``features.ticker_weights.<ticker>: range``, and never the
    value: a weights object can arrive from a database row, and its text ends up
    in logs and Sentry. The same goes for every key that is data: an entry of
    ``ticker_weights`` is named ``<ticker>`` whatever its symbol, and a key the
    schema does not define is named ``<key>``, wherever it sits (a symbol can be
    misplaced anywhere), so the message holds only names the schema defines and
    indexes. ``$`` names the root. Rule names: ``type``, ``unknown_key``,
    ``missing``, ``finite``, ``integer``, ``range``, ``length``, ``size``,
    ``pattern``, ``enum``, ``increasing``, ``empty``, ``literal``, ``date``,
    ``order``.
    """

    def __init__(self, path: str, rule: str) -> None:
        super().__init__(f"{path or '$'}: {rule}")
        self.path = path or "$"
        self.rule = rule


def _fail(path: str, rule: str) -> NoReturn:
    raise WeightsInvalid(path, rule)


def _join(path: str, key: str | int) -> str:
    """``path`` with one more segment. ``key`` is a name the schema defines or an index,
    never a key read from the object: those go through ``_unknown`` or are named
    ``<ticker>``, so no text from a stored row reaches a message."""
    return f"{path}.{key}" if path else str(key)


def _unknown(path: str) -> str:
    """The path of a key the schema does not define: ``<key>`` under ``path``."""
    return _join(path, _UNKNOWN_SEGMENT)


def _is_real(v: object) -> bool:
    """A number, not a bool: ``True`` is an ``int`` in Python and a type error
    in JSON-schema terms."""
    return isinstance(v, numbers.Real) and not isinstance(v, (bool, np.bool_))


def _check_object(path: str, v: object, keys: Sequence[str]) -> Mapping[str, Any]:
    """``z.strictObject``: a mapping with exactly ``keys``, no more, no fewer."""
    if not isinstance(v, Mapping):
        _fail(path, "type")
    for key in v:
        if not isinstance(key, str) or key not in keys:
            _fail(_unknown(path), "unknown_key")
    for key in keys:
        if key not in v:
            _fail(_join(path, key), "missing")
    return v


def _check_list(path: str, v: object, length: int) -> Sequence[Any]:
    if not isinstance(v, (list, tuple)):
        _fail(path, "type")
    if len(v) != length:
        _fail(path, "length")
    return v


def _check_str(path: str, v: object) -> str:
    if not isinstance(v, str):
        _fail(path, "type")
    return v


def _check_number(
    path: str, v: object, lo: float | None = None, hi: float | None = None
) -> None:
    """``z.number()`` with optional bounds: finite, not a bool."""
    if not _is_real(v):
        _fail(path, "type")
    try:
        finite = math.isfinite(float(v))
    except OverflowError:  # an int too large for a double reads as Infinity in JS
        finite = False
    if not finite:
        _fail(path, "finite")
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        _fail(path, "range")


def _check_int(
    path: str, v: object, lo: int = -_MAX_SAFE_INT, hi: int = _MAX_SAFE_INT
) -> None:
    """``z.number().int().min(lo).max(hi)``.

    A float like 3.0 passes, because JS cannot tell 3.0 from 3; 3.5 does not.
    An unbounded side stops at the safe integers (the defaults), Zod's own limit.
    """
    if not _is_real(v):
        _fail(path, "type")
    if not isinstance(v, numbers.Integral):
        as_float = float(v)
        if not math.isfinite(as_float):
            _fail(path, "finite")
        if not as_float.is_integer():
            _fail(path, "integer")
    if v < lo or v > hi:
        _fail(path, "range")


def _check_weight_table(path: str, v: object, keys: Sequence[str]) -> None:
    """A table with one weight in [-20, 20] per key in ``keys``."""
    table = _check_object(path, v, keys)
    for key in keys:
        _check_int(_join(path, key), table[key], -20, 20)


def _check_quintile_weights(path: str, v: object) -> None:
    for i, weight in enumerate(_check_list(path, v, 5)):
        _check_int(_join(path, i), weight, -20, 20)


def _check_boundaries(path: str, v: object) -> None:
    """Four finite numbers, strictly increasing."""
    items = _check_list(path, v, 4)
    for i, bound in enumerate(items):
        _check_number(_join(path, i), bound)
    floats = [float(b) for b in items]
    if any(b <= a for a, b in zip(floats, floats[1:])):
        _fail(path, "increasing")


def _check_ticker_weights(path: str, v: object) -> None:
    if not isinstance(v, Mapping):
        _fail(path, "type")
    if not 1 <= len(v) <= 500:
        _fail(path, "size")
    for key, weight in v.items():
        # Never the symbol: it would reach logs and Sentry through the exception message.
        key_path = f"{path}.{_TICKER_SEGMENT}"
        if not isinstance(key, str) or not _TICKER_KEY.fullmatch(key):
            _fail(key_path, "pattern")
        _check_int(key_path, weight, -5, 10)


def _check_overrides(path: str, v: object) -> None:
    if not isinstance(v, Mapping):
        _fail(path, "type")
    for day, table in v.items():
        if not isinstance(day, str) or day not in _WEEKDAYS:
            _fail(_unknown(path), "unknown_key")
        _check_weight_table(_join(path, day), table, _TODS)


def _check_enum(path: str, v: object, allowed: Sequence[str]) -> None:
    if not isinstance(v, str) or v not in allowed:
        _fail(path, "enum")


def _check_composite_match(path: str, v: object) -> None:
    """At least one of ``ticker``, ``tod`` and the three quintile labels."""
    if not isinstance(v, Mapping):
        _fail(path, "type")
    for key in v:
        if not isinstance(key, str) or key not in _MATCH_KEYS:
            _fail(_unknown(path), "unknown_key")
    if not v:
        _fail(path, "empty")
    for key, value in v.items():
        key_path = _join(path, key)
        if key == "ticker":
            _check_str(key_path, value)  # no pattern, as in the Zod schema
        elif key == "tod":
            _check_enum(key_path, value, _TODS)
        else:
            _check_enum(key_path, value, _Q_LABELS)


def _check_composite(path: str, v: object) -> None:
    entry = _check_object(path, v, ("match", "bonus", "support", "win_rate", "note"))
    _check_composite_match(_join(path, "match"), entry["match"])
    _check_int(_join(path, "bonus"), entry["bonus"], -10, 10)
    _check_int(_join(path, "support"), entry["support"], 0)
    _check_number(_join(path, "win_rate"), entry["win_rate"], 0, 1)
    _check_str(_join(path, "note"), entry["note"])


def _check_composites(path: str, v: object) -> None:
    if not isinstance(v, (list, tuple)):
        _fail(path, "type")
    if len(v) > 50:
        _fail(path, "size")
    for i, entry in enumerate(v):
        _check_composite(_join(path, i), entry)


def _check_features(path: str, v: object) -> None:
    f = _check_object(path, v, _FEATURE_KEYS)

    def at(key: str) -> str:
        return _join(path, key)

    _check_ticker_weights(at("ticker_weights"), f["ticker_weights"])
    _check_weight_table(at("tod_weights"), f["tod_weights"], _TODS)
    _check_overrides(at("tod_weights_dow_overrides"), f["tod_weights_dow_overrides"])
    _check_weight_table(at("dte_weights"), f["dte_weights"], _DTES)
    for stem in _QUINTILES:
        _check_quintile_weights(
            at(f"{stem}_quintile_weights"), f[f"{stem}_quintile_weights"]
        )
        _check_boundaries(
            at(f"{stem}_quintile_boundaries"), f[f"{stem}_quintile_boundaries"]
        )
    _check_weight_table(
        at("option_type_weights"), f["option_type_weights"], _OPTION_TYPES
    )
    _check_composites(at("composite_bonuses"), f["composite_bonuses"])


def _is_iso_date(v: object) -> bool:
    """A calendar date as ``YYYY-MM-DD``, ASCII digits, leap days honoured.

    Not ``date.fromisoformat``: since Python 3.11 that also takes ``20260616``
    and ``2026-W24-2``, which ``z.iso.date()`` refuses.
    """
    match = _ISO_DATE.fullmatch(v) if isinstance(v, str) else None
    if match is None:
        return False
    year, month, day = (int(g) for g in match.groups())
    if not 1 <= month <= 12:
        return False
    days = _DAYS_IN_MONTH[month - 1] + (month == 2 and calendar.isleap(year))
    return 1 <= day <= days


def validate_weights(w: Mapping[str, Any]) -> None:
    """Raise ``WeightsInvalid`` unless ``w`` is a lottery weights object.

    The rules are ``LotteryWeightsSchema``'s (api/_lib/lottery-weights-
    schema.ts), the plan's D5 table: schema_version 1, a non-empty
    model_version, an ISO trained_through, the ``features`` tables, the two
    cutoff pairs, and no unknown key anywhere. Fails at the first broken rule.
    """
    root = _check_object(
        "",
        w,
        (
            "schema_version",
            "model_version",
            "trained_through",
            "features",
            "cutoffs",
            "feed_cutoffs",
        ),
    )
    version = root["schema_version"]
    if not (_is_real(version) and version == SCHEMA_VERSION):
        _fail("schema_version", "literal")
    if not _check_str("model_version", root["model_version"]):
        _fail("model_version", "empty")
    _check_str("trained_through", root["trained_through"])
    if not _is_iso_date(root["trained_through"]):
        _fail("trained_through", "date")
    _check_features("features", root["features"])

    cutoffs = _check_object("cutoffs", root["cutoffs"], ("t1", "t2"))
    _check_int("cutoffs.t1", cutoffs["t1"])
    _check_int("cutoffs.t2", cutoffs["t2"])
    if not cutoffs["t1"] > cutoffs["t2"]:
        _fail("cutoffs", "order")

    feed = _check_object(
        "feed_cutoffs", root["feed_cutoffs"], ("tier1_min_score", "tier2_min_score")
    )
    _check_int("feed_cutoffs.tier1_min_score", feed["tier1_min_score"])
    _check_int("feed_cutoffs.tier2_min_score", feed["tier2_min_score"], 0)
    if not feed["tier1_min_score"] > feed["tier2_min_score"]:
        _fail("feed_cutoffs", "order")


# ── Version ids ─────────────────────────────────────────────────────────────


def refit_version_id(trained_through: date) -> str:
    """The id a refit is stored under: ``refit-YYYY-MM-DD``.

    One candidate per training session, so a same-night re-run lands on the same
    row. A ``datetime`` is refused: its ``isoformat`` carries a time part that
    the store's id pattern (``^(seed|refit)-\\d{4}-\\d{2}-\\d{2}$``) rejects.
    """
    if isinstance(trained_through, datetime) or not isinstance(trained_through, date):
        raise TypeError("refit_version_id takes a datetime.date")
    return f"refit-{trained_through.isoformat()}"


# ── Scoring ─────────────────────────────────────────────────────────────────


def assign_quintile(value: float | None, bounds: Sequence[float]) -> int | None:
    """The quintile (0-4) of ``value``, cut at ``bounds``; ``None`` for a NULL.

    Right-closed, as ``assignQuintile`` and the training's ``pd.cut(right=True)``
    are: a value on a boundary goes to the lower bucket (``value <= bounds[k]``
    is quintile ``k``), and a value above the last boundary is quintile 4. NaN
    counts as NULL, since that is how pandas holds one in a float column.
    """
    if pd.isna(value):
        return None
    for i, bound in enumerate(bounds):
        if value <= bound:
            return i
    return len(bounds)


def _labels(series: pd.Series) -> np.ndarray:
    """Text columns as an object array with ``None`` for a NULL, whatever the
    pandas dtype (``str``, ``string``, ``category``, ``object``)."""
    return series.to_numpy(dtype=object, na_value=None)


def _floats(series: pd.Series) -> np.ndarray:
    """A numeric column as float64 with NaN for a NULL. Postgres NUMERIC arrives
    from psycopg2 as ``Decimal`` in an object column; this turns it into floats."""
    return pd.to_numeric(series).to_numpy(dtype="float64", na_value=np.nan)


def _lookup(labels: np.ndarray, table: Mapping[str, Any]) -> np.ndarray:
    """``table[label]`` per row as float64, NaN where the label is not a key."""
    mapped = pd.Series(labels, dtype=object).map(dict(table))
    return mapped.to_numpy(dtype="float64", na_value=np.nan)


def _ints(values: Sequence[Any]) -> np.ndarray:
    # `int()` turns an integral float weight (3.0, which validation accepts)
    # into the int the TS scorer adds.
    return np.array([int(v) for v in values], dtype=np.int64)


def _quintile_part(
    values: np.ndarray, bounds: Sequence[float], weights: Sequence[int]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The score part, the quintile index and the NULL mask of one feature.

    ``searchsorted(side="left")`` returns the first ``k`` with ``bounds[k] >=
    value``, which is the right-closed bucket. A NULL is cut as the last
    quintile and then ignored through the mask: it adds 0, as in the TS scorer.
    """
    null = np.isnan(values)
    q = np.searchsorted(np.asarray(bounds, dtype="float64"), values, side="left")
    part = np.where(null, 0, _ints(weights)[q])
    return part, q, null


def _q_matches(label: str, q: np.ndarray, null: np.ndarray) -> np.ndarray:
    """Which rows a composite's quintile label picks: ``"null"`` takes the NULL
    rows, a number takes the rows in that quintile and never a NULL one."""
    return null if label == "null" else (q == int(label)) & ~null


def score_frame(w: Mapping[str, Any], df: pd.DataFrame) -> pd.Series:
    """Score each fire in ``df`` with ``w``, as ``scoreLotteryV2`` does.

    ``df`` needs the ``SCORE_COLUMNS``. The result is an ``Int64`` Series on
    ``df``'s index: the sum of the ticker, tod, DTE, three quintile, option-type
    and composite weights, or ``<NA>`` for a fire the scorer gates out:

    * not aligned: a call needs ``cum_ncp_at_fire > cum_npp_at_fire``, a put the
      reverse; a tie or a NULL on either side is not aligned;
    * a DTE outside 0-3.

    A NULL quintile feature adds 0, and a composite whose label is ``"null"``
    matches exactly that NULL. The tod table is the one for the weekday of
    ``date`` when ``tod_weights_dow_overrides`` has it, else the global one.
    Weights are validated first, so a malformed object never scores.

    A fire that passes both gates but whose ``tod`` is not one of the four
    buckets raises ``ValueError`` (the TS scorer would add ``undefined`` and
    return NaN); ``<NA>`` is kept for the gates, so bad data cannot hide in it.
    """
    validate_weights(w)
    missing = [c for c in SCORE_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError("score_frame needs columns: " + ", ".join(sorted(missing)))
    f = w["features"]

    symbol = _labels(df["underlying_symbol"])
    option_type = _labels(df["option_type"])
    tod = _labels(df["tod"])
    dte = _floats(df["dte"])
    ncp = _floats(df["cum_ncp_at_fire"])
    npp = _floats(df["cum_npp_at_fire"])

    # The gates. NaN compares False, so a NULL cumulative value is never aligned.
    is_call = option_type == "C"
    is_put = option_type == "P"
    aligned = (is_call & (ncp > npp)) | (is_put & (npp > ncp))
    in_universe = np.zeros(len(df), dtype=bool)
    for d in _DTES:
        in_universe |= dte == int(d)
    scored = aligned & in_universe

    # Ticker: a ticker the weights do not list adds 0.
    score = np.nan_to_num(_lookup(symbol, f["ticker_weights"])).astype(np.int64)

    # Tod: the weekday's override table where there is one, else the global one.
    weekday = (
        pd.to_datetime(df["date"]).dt.day_name().to_numpy(dtype=object, na_value=None)
    )
    tod_weight = _lookup(tod, f["tod_weights"])
    for day, table in f["tod_weights_dow_overrides"].items():
        tod_weight = np.where(weekday == day, _lookup(tod, table), tod_weight)
    unknown_tod = scored & np.isnan(tod_weight)
    if unknown_tod.any():
        raise ValueError(
            f"score_frame: {int(unknown_tod.sum())} scored rows have a tod "
            f"outside {', '.join(_TODS)}"
        )
    score += np.nan_to_num(tod_weight).astype(np.int64)

    # DTE: 0-3 are the only keys; any other row is gated out below.
    dte_table = _ints([f["dte_weights"][d] for d in _DTES])
    score += dte_table[np.where(in_universe, dte, 0).astype(np.int64)]

    # The three quintile features, kept for the composites.
    quintiles: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for column, stem in (
        ("trigger_vol_to_oi_window", "vol_oi"),
        ("gamma_at_trigger", "gamma"),
        ("trigger_ask_pct", "ask_pct"),
    ):
        part, q, null = _quintile_part(
            _floats(df[column]),
            f[f"{stem}_quintile_boundaries"],
            f[f"{stem}_quintile_weights"],
        )
        score += part
        quintiles[stem] = (q, null)

    # Option type: an aligned fire is a call or a put.
    option_weights = f["option_type_weights"]
    score += np.where(is_call, int(option_weights["C"]), int(option_weights["P"]))

    # Composites: every entry whose keys all agree adds its bonus.
    for entry in f["composite_bonuses"]:
        match = entry["match"]
        hit = np.ones(len(df), dtype=bool)
        if match.get("ticker") is not None:
            hit &= symbol == match["ticker"]
        if match.get("tod") is not None:
            hit &= tod == match["tod"]
        for stem in _QUINTILES:
            label = match.get(f"{stem}_q")
            if label is not None:
                hit &= _q_matches(label, *quintiles[stem])
        score += np.where(hit, int(entry["bonus"]), 0)

    values = pd.arrays.IntegerArray(np.where(scored, score, 0), ~scored)
    return pd.Series(values, index=df.index, name="score")


# ── The store ───────────────────────────────────────────────────────────────


def load_pointer(
    conn: Any, name: Literal["active", "takeit"]
) -> tuple[str, dict[str, Any]]:
    """The version a store pointer names and its validated weights.

    ``conn`` is a psycopg2 connection. Reads ``lottery_score_pointers`` joined
    to ``lottery_score_versions`` and writes nothing. Raises ``LookupError`` when
    the pointer has no row (the store was never migrated) and ``WeightsInvalid``
    when the row's weights break a rule, so a caller never trains or scores
    against a malformed version.
    """
    if name not in _POINTER_NAMES:
        raise ValueError(f"pointer name must be one of {', '.join(_POINTER_NAMES)}")
    with conn.cursor() as cur:
        cur.execute(_POINTER_SQL, (name,))
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"lottery_score_pointers has no row named {name}")
    if isinstance(row, Mapping):
        version, weights = row["version"], row["weights"]
    else:
        version, weights = row
    validate_weights(weights)
    return version, weights
