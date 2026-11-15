"""The gates the nightly refit applies to a candidate lottery-weights version.

The refit trains a candidate on the last 90 days, holds it in shadow while it
is scored against the live version on sessions neither saw in training, and
promotes it only if the gates below say so. This module holds the numbers, the
arithmetic and the verdicts. It reads no database and writes nothing.

Where the numbers come from. Plan: docs/superpowers/plans/2026-11-05-nightly-
pipeline-phase4.md. "Facts" holds the 11-cycle walk-forward on 219,651
training-population rows (held-out pooled Spearman, tier shares under fixed and
under matched cutoffs); "Gate numbers" is the table the constants below copy,
tuned on those cycles and re-checked by the plan's Task 1 on the tape-built
window; D6 is the candidate lifecycle these verdicts serve, and Task 13 the
interface.

The outcome. Every rho here is the rank correlation of a fire's score with
``outcome_pct``: ``COALESCE(realized_flow_inversion_pct, realized_eod_pct)``,
a flow-inversion exit with a held-to-EOD fallback (D7; the column
``lottery_scoring.fetch_frame`` builds). The evaluation population is D7's:
aligned, single-leg, outcome present. The tier shares are read on every fire of
the session instead, the way the feed's tier monitor counts them.

The lifecycle, in the order the step calls the functions:

* ``feed_qas`` scores the feed as the feed displays it, and ``daily_tier_shares``
  reads each session's tier1 and tier1+2 share off that. ``match_feed_cutoffs``
  picks the candidate's feed cutoffs so its tiers hold as many fires as the
  active version's do on the trailing sessions (Facts: under the fixed 13/10
  cutoffs the held-out tier1 share, candidate over comparator, had median 1.76
  and ran up to 4.56; under matched ones the median was 1.13 and 9 of 10 cycles
  fell within 0.73-1.43).
* ``check_creation`` decides whether a trained candidate may enter shadow.
* ``decide_shadow`` decides, each night, whether the shadow waits, passes or is
  rejected, on exactly its first ``SHADOW_SESSIONS`` evaluated sessions.

The rho rule is a guard against clearly worse weights, not a selector of better
ones: the candidate-minus-active rho had SD 0.044 over 10 sessions and was at or
above zero in 6 of 10 cycles (Facts).

This file is copied into the nightly image (Python 3.12), where lottery_weights.py
is the only module it may import from ml/src. It uses numpy and pandas besides:
no scipy, no ``utils``, and nothing newer than 3.12. ``spearman`` is hand-written
for that reason; tests/test_lottery_refit_gates_scipy.py checks it against scipy.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

import numpy as np
import pandas as pd

from lottery_weights import SCORE_COLUMNS, WeightsInvalid, score_frame, validate_weights

# ── Gate numbers ────────────────────────────────────────────────────────────
# The plan's "Gate numbers" table, verbatim. Bands are inclusive at both ends.
# TRAIN_WINDOW_DAYS and FEED_CUTOFF_MATCH_SESSIONS are read by the refit step,
# which cuts the frames; the functions below take them already cut.

TRAIN_WINDOW_DAYS = 90

# Parquet-era training windows held 74,533-139,970 rows on 41-58 sessions; the
# 10-29 collapse held 196.
MIN_TRAIN_ROWS = 30_000
MIN_TRAIN_SESSIONS = 30

# SD of the held-out rho difference: 0.105 / 0.072 / 0.044 at 3 / 5 / 10 sessions.
SHADOW_SESSIONS = 10
# 2 x SHADOW_SESSIONS: a starved shadow is rejected instead of awaited forever.
SHADOW_MAX_SESSIONS = 20

# Re-measured 2026-11-14 on the tape-built era 06-17 -> 11-13 (73 sessions): daily
# eval rows p10 1,344, min 535 (parquet era: p10 797, min 83). The floor is the
# p10 over 2.5, rounded down to 50. Windows of 10 sessions held 10,995-38,129
# (parquet era). Ten sessions of at least 500 rows hold at least 5,000, so
# MIN_EVAL_ROWS can no longer fail on its own: it stays as a backstop.
MIN_EVAL_ROWS_PER_SESSION = 500
MIN_EVAL_ROWS = 5_000

# Candidate share over active share, for tier1 and tier1+2 alike (matched cutoffs
# ran 0.73-1.43 in 9 of 10 cycles); and the candidate's mean daily tier1 share
# (the live feed since 06-17: 1.6-14.9 %).
TIER_SHARE_RATIO_BAND = (0.67, 1.5)
TIER1_SHARE_BAND = (0.01, 0.15)

# The trailing sessions the feed cutoffs are matched on, and the largest cutoff
# searched (qas p99 since 10-20 is 28).
FEED_CUTOFF_MATCH_SESSIONS = 20
FEED_CUTOFF_SEARCH_MAX = 40

# Mirrors INVERSION_BONUS_BY_QUINTILE in api/_lib/lottery-inversion-bonus.ts (and
# the CASE in INVERSION_BONUS_CASE_SQL beside it); the test parses both. A NULL
# or other quintile adds 0.
INVERSION_BONUS = {1: -5, 2: -2, 3: 0, 4: 3, 5: 5}

# The frame ``feed_qas`` and ``daily_tier_shares`` read: the score columns, which
# ``score_frame`` needs to rescore a fire, and the three the feed adds. The
# fire-count score adjustment is not among them: it was retired on 2026-11-15
# and migration #209 drops its column.
_FEED_ONLY_COLUMNS = (
    "round_trip_score_deduct",
    "direction_gated",
    "inversion_quintile",
)
FEED_COLUMNS = (*SCORE_COLUMNS, *_FEED_ONLY_COLUMNS)

# The outcome column of an evaluation frame (see the module docstring).
OUTCOME_COLUMN = "outcome_pct"

# The reasons a verdict carries are fixed phrases, written out where they are
# raised so that a notice's text can be found by grep: too_few_train_rows,
# too_few_train_sessions, invalid_weights, tier1_share_out_of_band (creation);
# shadow_starved, too_few_eval_rows, rho_undefined, rho_below_active,
# tier1_share_out_of_band, tier1_ratio_out_of_band, tier12_ratio_out_of_band
# (shadow).

__all__ = [
    "FEED_COLUMNS",
    "FEED_CUTOFF_MATCH_SESSIONS",
    "FEED_CUTOFF_SEARCH_MAX",
    "INVERSION_BONUS",
    "MIN_EVAL_ROWS",
    "MIN_EVAL_ROWS_PER_SESSION",
    "MIN_TRAIN_ROWS",
    "MIN_TRAIN_SESSIONS",
    "OUTCOME_COLUMN",
    "SHADOW_MAX_SESSIONS",
    "SHADOW_SESSIONS",
    "TIER1_SHARE_BAND",
    "TIER_SHARE_RATIO_BAND",
    "TRAIN_WINDOW_DAYS",
    "CreationVerdict",
    "FeedCutoffs",
    "ShadowVerdict",
    "check_creation",
    "daily_tier_shares",
    "decide_shadow",
    "feed_qas",
    "in_band",
    "match_feed_cutoffs",
    "spearman",
]


# ── Small helpers ───────────────────────────────────────────────────────────


def in_band(value: float, band: tuple[float, float]) -> bool:
    """Whether ``value`` lies in ``band``, both edges included. NaN is never in."""
    low, high = band
    return bool(low <= value <= high)


def _require_columns(frame: pd.DataFrame, columns: Iterable[str], name: str) -> None:
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        raise ValueError(f"{name} needs columns: {', '.join(sorted(missing))}")


def _floats(series: pd.Series) -> np.ndarray:
    """A numeric column as float64 with NaN for a NULL. Postgres NUMERIC arrives
    from psycopg2 as ``Decimal`` in an object column; this turns it into floats."""
    return pd.to_numeric(series).to_numpy(dtype="float64", na_value=np.nan)


def _flags(series: pd.Series) -> np.ndarray:
    """A boolean column as a bool array, with NULL read as False."""
    return series.eq(True).fillna(False).to_numpy(dtype=bool)


def _session_dates(frame: pd.DataFrame) -> pd.Series:
    """The ``date`` column as ``datetime.date`` objects, whatever it arrived as
    (dates, ISO text, timestamps). A fire with no date belongs to no session."""
    stamps = pd.to_datetime(frame["date"])
    if stamps.isna().any():
        raise ValueError("frame has fires with no session date")
    return stamps.dt.date


# ── Spearman ────────────────────────────────────────────────────────────────


def spearman(x: pd.Series, y: pd.Series) -> float:
    """Spearman's rank correlation of ``x`` and ``y``, as scipy gives it.

    The Pearson correlation of the two average ranks (ties share the mean of the
    ranks they span), on the positions where both are present. ``x`` and ``y``
    are paired by position, not by index label. The result is NaN when fewer than
    3 pairs remain or either side is constant over them: a rank correlation
    needs both. Written out because the nightly image carries no scipy.
    """
    if len(x) != len(y):
        raise ValueError("spearman needs two series of the same length")
    xs, ys = _floats(x), _floats(y)
    keep = ~(np.isnan(xs) | np.isnan(ys))
    if keep.sum() < 3:
        return math.nan
    rx = pd.Series(xs[keep]).rank(method="average").to_numpy()
    ry = pd.Series(ys[keep]).rank(method="average").to_numpy()
    if rx.min() == rx.max() or ry.min() == ry.max():
        return math.nan
    dx, dy = rx - rx.mean(), ry - ry.mean()
    rho = float(dx @ dy) / (math.sqrt(float(dx @ dx)) * math.sqrt(float(dy @ dy)))
    return min(1.0, max(-1.0, rho))


# ── The feed's displayed score and its tiers ────────────────────────────────


@dataclass(frozen=True)
class FeedCutoffs:
    """A version's feed tier cutoffs on qas: tier1 at or above ``tier1_min_score``,
    tier2 at or above ``tier2_min_score``. ``validate_weights`` is where
    ``tier1_min_score > tier2_min_score >= 0`` is enforced; this holds two ints."""

    tier1_min_score: int
    tier2_min_score: int

    @classmethod
    def from_weights(cls, weights: Mapping[str, Any]) -> FeedCutoffs:
        cut = weights["feed_cutoffs"]
        return cls(int(cut["tier1_min_score"]), int(cut["tier2_min_score"]))


def feed_qas(scores: pd.Series, feed: pd.DataFrame) -> pd.Series:
    """The feed's displayed quality-adjusted score (qas) for each fire.

    Mirrors ``qasExprText`` in api/lottery-finder.ts, which the feed filters and
    badges on, and the tier monitor in api/cron/detect-lottery-fires.ts, which
    classifies the same way:

        qas = GREATEST(0, COALESCE(score, 0)
                          + COALESCE(round_trip_score_deduct, 0))
              + CASE inversion_quintile 1 THEN -5 ... 5 THEN 5 ELSE 0 END

    The floor at zero comes before the bonus. A NULL deduct counts as 0, and
    so does a NULL or out-of-range quintile. There is no fire-count term: that
    adjustment was retired on 2026-11-15, so the qas does not depend on how many
    times a chain has fired. ``scores`` is what ``score_frame`` returns for
    ``feed`` under one weights version (``<NA>`` for a fire the scorer gates
    out), on the same index.

    The result is NaN for the fires the feed shows as tier3 whatever their qas:
    a NULL score, ``direction_gated``, and an inversion quintile of 1 or 2 (the
    feed hides those tickers by default and the monitor counts them tier3). A NaN
    is below every cutoff and still counts in a share's denominator.
    """
    if not scores.index.equals(feed.index):
        raise ValueError("scores and feed must have the same index")
    _require_columns(feed, _FEED_ONLY_COLUMNS, "feed")
    score = scores.to_numpy(dtype="float64", na_value=np.nan)
    round_trip = np.nan_to_num(_floats(feed["round_trip_score_deduct"]))
    quintile = _floats(feed["inversion_quintile"])
    bonus = np.zeros(len(feed))
    for q, points in INVERSION_BONUS.items():
        bonus[quintile == q] = points
    # A <NA> score is NaN here and stays NaN through the sum and np.maximum
    # (np.fmax would swallow it), which is the forced tier3 of a NULL score.
    qas = np.maximum(0.0, score + round_trip) + bonus
    forced = _flags(feed["direction_gated"]) | np.isin(quintile, (1, 2))
    qas[forced] = np.nan
    return pd.Series(qas, index=feed.index, name="qas")


def daily_tier_shares(
    qas: pd.Series, feed: pd.DataFrame, cutoffs: FeedCutoffs
) -> pd.DataFrame:
    """Each session's tier1 and tier1+2 share of the feed's fires.

    ``tier1_share`` is the fraction of the session's fires with ``qas >=
    tier1_min_score`` and ``tier12_share`` the fraction with ``qas >=
    tier2_min_score``. The denominator is every fire of the session; a fire whose
    qas is NaN is in it and in neither tier. The index is the ascending session
    dates, named ``date``.
    """
    if not qas.index.equals(feed.index):
        raise ValueError("qas and feed must have the same index")
    columns = ["tier1_share", "tier12_share"]
    if len(feed) == 0:
        return pd.DataFrame(
            {c: pd.Series([], dtype="float64") for c in columns},
            index=pd.Index([], name="date"),
        )
    values = qas.to_numpy(dtype="float64", na_value=np.nan)
    flags = pd.DataFrame(
        {
            "tier1_share": values >= cutoffs.tier1_min_score,
            "tier12_share": values >= cutoffs.tier2_min_score,
        }
    )
    shares = flags.groupby(_session_dates(feed).to_numpy(), sort=True).mean()
    shares.index.name = "date"
    return shares.astype("float64")


def match_feed_cutoffs(
    qas_candidate: pd.Series, qas_active: pd.Series, active: FeedCutoffs
) -> FeedCutoffs:
    """Feed cutoffs for the candidate that tier as many fires as the active's do.

    Both series are qas (``feed_qas``) of the same trailing sessions, pooled. The
    target share of a tier is the share of the active's fires at or above its
    cutoff, NaN counted below. For each tier the cutoff is the integer ``c`` in
    0..``FEED_CUTOFF_SEARCH_MAX`` whose candidate share (at or above ``c``, NaN
    below) is nearest the target; a tie goes to the larger ``c``. If tier2 does
    not come out below tier1 it is set to ``tier1 - 1``. (That is -1 if tier1 is
    0, which ``validate_weights`` then refuses, so ``check_creation`` reports
    ``invalid_weights``.)

    Distances are compared as exact fractions of two fire counts, so a tie is a
    tie and not an accident of float rounding.
    """
    cand = qas_candidate.to_numpy(dtype="float64", na_value=np.nan)
    act = qas_active.to_numpy(dtype="float64", na_value=np.nan)
    if len(cand) == 0 or len(act) == 0:
        raise ValueError("match_feed_cutoffs needs fires on both sides")
    reach = [int((cand >= c).sum()) for c in range(FEED_CUTOFF_SEARCH_MAX + 1)]

    def nearest(cutoff: int) -> int:
        hits = int((act >= cutoff).sum())
        best_c, best_gap = 0, None
        for c, count in enumerate(reach):
            # |count/len(cand) - hits/len(act)|, scaled by len(cand) * len(act).
            gap = abs(count * len(act) - hits * len(cand))
            if best_gap is None or gap <= best_gap:  # `<=`: the later c wins a tie
                best_c, best_gap = c, gap
        return best_c

    tier1 = nearest(active.tier1_min_score)
    tier2 = nearest(active.tier2_min_score)
    if tier2 >= tier1:
        tier2 = tier1 - 1
    return FeedCutoffs(tier1_min_score=tier1, tier2_min_score=tier2)


# ── Creation ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CreationVerdict:
    """Whether a trained candidate may enter shadow, and the reasons it may not."""

    ok: bool
    reasons: tuple[str, ...]
    train_rows: int
    train_sessions: int
    tier1_share: float


def check_creation(
    weights: Mapping[str, Any],
    *,
    train_rows: int,
    train_sessions: int,
    tier1_share: float,
) -> CreationVerdict:
    """Check a trained candidate before it is stored as a shadow.

    ``train_rows`` and ``train_sessions`` are the training window's, and
    ``tier1_share`` the candidate's mean daily tier1 share under its (matched)
    feed cutoffs. Every failed check is listed, in the order: ``too_few_train_rows``
    (under ``MIN_TRAIN_ROWS``), ``too_few_train_sessions`` (under
    ``MIN_TRAIN_SESSIONS``), ``invalid_weights`` (``validate_weights`` refuses
    them), ``tier1_share_out_of_band`` (outside ``TIER1_SHARE_BAND``, or
    undefined).
    """
    reasons: list[str] = []
    if train_rows < MIN_TRAIN_ROWS:
        reasons.append("too_few_train_rows")
    if train_sessions < MIN_TRAIN_SESSIONS:
        reasons.append("too_few_train_sessions")
    try:
        validate_weights(weights)
    except WeightsInvalid:
        reasons.append("invalid_weights")
    if not in_band(tier1_share, TIER1_SHARE_BAND):
        reasons.append("tier1_share_out_of_band")
    return CreationVerdict(
        ok=not reasons,
        reasons=tuple(reasons),
        train_rows=train_rows,
        train_sessions=train_sessions,
        tier1_share=tier1_share,
    )


# ── The shadow decision ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ShadowVerdict:
    """The night's decision on a shadow, with the numbers behind it.

    ``sessions`` are the evaluated sessions the numbers are read on (the first
    ``SHADOW_SESSIONS`` of them, or fewer while the shadow waits). While it waits,
    or is rejected as starved, nothing past ``eval_rows`` was computed and the
    rho, ratio and share fields are NaN.
    """

    decision: Literal["wait", "pass", "reject"]
    reasons: tuple[str, ...]
    sessions: tuple[date, ...]
    eval_rows: int
    rho_candidate: float
    rho_active: float
    tier1_ratio: float
    tier12_ratio: float
    tier1_share: float


def _ratio(candidate: float, active: float) -> float:
    """``candidate / active``, with 0/0 read as 1 (no change) and x/0 as infinity."""
    if active == 0:
        return 1.0 if candidate == 0 else math.inf
    return candidate / active


def _mean_shares(weights: Mapping[str, Any], feed: pd.DataFrame) -> tuple[float, float]:
    """The mean over sessions of the daily tier1 and tier1+2 share of ``feed``
    under ``weights``, read against the weights' own feed cutoffs."""
    qas = feed_qas(score_frame(weights, feed), feed)
    shares = daily_tier_shares(qas, feed, FeedCutoffs.from_weights(weights))
    return float(shares["tier1_share"].mean()), float(shares["tier12_share"].mean())


def decide_shadow(
    *,
    eval_frame: pd.DataFrame,
    feed_frame: pd.DataFrame,
    candidate: Mapping[str, Any],
    active: Mapping[str, Any],
    sessions_elapsed: int,
) -> ShadowVerdict:
    """Wait, pass or reject a shadow on the sessions evaluated so far.

    ``eval_frame`` holds the evaluation population (D7) of the elapsed sessions:
    ``SCORE_COLUMNS`` plus ``OUTCOME_COLUMN``. ``feed_frame`` holds every fire of
    those sessions with ``FEED_COLUMNS``. ``candidate`` and ``active`` are
    weights objects; a malformed one raises ``WeightsInvalid``, and a scored fire
    with an unknown ``tod`` raises ``ValueError``, as in ``score_frame``.
    ``sessions_elapsed`` counts the sessions since the candidate's training date
    (the same lagged range the frames cover).

    An eval row is a fire the weights score (neither version gates it out) and
    that has an outcome. A session is evaluated when it has at least
    ``MIN_EVAL_ROWS_PER_SESSION`` eval rows.

    * Fewer than ``SHADOW_SESSIONS`` evaluated sessions: ``wait``, or ``reject``
      for ``shadow_starved`` once ``sessions_elapsed >= SHADOW_MAX_SESSIONS``.
    * Otherwise the verdict is read on exactly the first ``SHADOW_SESSIONS``
      evaluated sessions in date order, so a later session changes nothing. It
      is ``pass`` with no reasons, else ``reject`` with every failed check, in
      this order:

      - ``too_few_eval_rows``: under ``MIN_EVAL_ROWS`` eval rows;
      - ``rho_undefined``: either version's pooled rho is NaN; or
        ``rho_below_active``: the candidate's is below the active's (a tie
        passes);
      - ``tier1_share_out_of_band``: the candidate's mean daily tier1 share is
        outside ``TIER1_SHARE_BAND``;
      - ``tier1_ratio_out_of_band``, ``tier12_ratio_out_of_band``: the
        candidate's mean daily share over the active's is outside
        ``TIER_SHARE_RATIO_BAND`` (0/0 reads as 1, x/0 as infinity).

    Each version's tiers use its own ``feed_cutoffs``. Raises ``ValueError`` if
    ``feed_frame`` has no fires for one of the sessions judged: a missing day
    must not shrink the average.
    """
    _require_columns(eval_frame, (*SCORE_COLUMNS, OUTCOME_COLUMN), "eval_frame")
    _require_columns(feed_frame, FEED_COLUMNS, "feed_frame")

    cand_scores = score_frame(candidate, eval_frame)
    act_scores = score_frame(active, eval_frame)
    outcome = _floats(eval_frame[OUTCOME_COLUMN])
    usable = (
        cand_scores.notna().to_numpy()
        & act_scores.notna().to_numpy()
        & ~np.isnan(outcome)
    )
    dates = _session_dates(eval_frame)
    per_session = pd.Series(usable.astype(int)).groupby(dates.to_numpy()).sum()
    evaluated = sorted(
        day for day, rows in per_session.items() if rows >= MIN_EVAL_ROWS_PER_SESSION
    )

    if len(evaluated) < SHADOW_SESSIONS:
        starved = sessions_elapsed >= SHADOW_MAX_SESSIONS
        return ShadowVerdict(
            decision="reject" if starved else "wait",
            reasons=("shadow_starved",) if starved else (),
            sessions=tuple(evaluated),
            eval_rows=int((usable & dates.isin(evaluated).to_numpy()).sum()),
            rho_candidate=math.nan,
            rho_active=math.nan,
            tier1_ratio=math.nan,
            tier12_ratio=math.nan,
            tier1_share=math.nan,
        )

    judged = evaluated[:SHADOW_SESSIONS]
    rows = usable & dates.isin(judged).to_numpy()
    eval_rows = int(rows.sum())
    rho_candidate = spearman(cand_scores[rows], pd.Series(outcome[rows]))
    rho_active = spearman(act_scores[rows], pd.Series(outcome[rows]))

    feed_dates = _session_dates(feed_frame)
    present = set(feed_dates)
    absent = [day for day in judged if day not in present]
    if absent:
        raise ValueError(
            "feed_frame has no rows for session(s): "
            + ", ".join(day.isoformat() for day in absent)
        )
    feed = feed_frame[feed_dates.isin(judged).to_numpy()]
    cand_t1, cand_t12 = _mean_shares(candidate, feed)
    act_t1, act_t12 = _mean_shares(active, feed)
    tier1_ratio = _ratio(cand_t1, act_t1)
    tier12_ratio = _ratio(cand_t12, act_t12)

    reasons: list[str] = []
    if eval_rows < MIN_EVAL_ROWS:
        reasons.append("too_few_eval_rows")
    if math.isnan(rho_candidate) or math.isnan(rho_active):
        reasons.append("rho_undefined")
    elif rho_candidate < rho_active:
        reasons.append("rho_below_active")
    if not in_band(cand_t1, TIER1_SHARE_BAND):
        reasons.append("tier1_share_out_of_band")
    if not in_band(tier1_ratio, TIER_SHARE_RATIO_BAND):
        reasons.append("tier1_ratio_out_of_band")
    if not in_band(tier12_ratio, TIER_SHARE_RATIO_BAND):
        reasons.append("tier12_ratio_out_of_band")
    return ShadowVerdict(
        decision="reject" if reasons else "pass",
        reasons=tuple(reasons),
        sessions=tuple(judged),
        eval_rows=eval_rows,
        rho_candidate=rho_candidate,
        rho_active=rho_active,
        tier1_ratio=tier1_ratio,
        tier12_ratio=tier12_ratio,
        tier1_share=cand_t1,
    )
