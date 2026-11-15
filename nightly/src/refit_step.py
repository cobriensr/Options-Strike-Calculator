"""The lottery-refit step: one move of the weights candidate lifecycle each night (plan D6).

A night does exactly one of two things, decided by whether a shadow exists:

- No shadow: build `refit-<last_session>`. Train on the trailing 90 days, match the feed
  cutoffs to the active version over the last 20 sessions, check the result, and store it as
  a shadow, or as `rejected` with a notice naming the first reason. Two checks come first,
  in this order, and each makes the step a no-op that is counted and builds nothing: the
  version already exists (`already_built`: a re-run after the night built it), or some
  version was decided since 00:00 UTC of the run's date (`already_decided`: a re-run after
  the night's own run rejected, passed or promoted the shadow, so no shadow is left to
  find and a build would be a second move in one night). The next scheduled run falls on
  the next UTC date and builds as usual.
- A shadow: record each session that has become evaluable and not yet been recorded, then
  ask `decide_shadow` for a verdict on all of them. It waits until 10 sessions are
  evaluated, rejects a starved shadow at 20 elapsed sessions, and otherwise passes or
  rejects on exactly the first 10. A pass promotes only when `PROMOTION_ENABLED`; with it
  off (it ships off) the shadow is marked `passed`. The owner gets a notice for every
  promotion, pass and rejection (`monitoring.report_refit`, plan D9).

Evaluation lags one session (D6): session s is judged on the run after session s+1 lands,
so a fire whose net flow arrived late has had its tape inversion filled by then. The
newest session of the night is therefore left for the next night.

Failure rules (the step runner reports a raised exception to Sentry and fails the step):
- `WeightsInvalid`, the unknown-`tod` `ValueError`, a missing feed day and every database
  error propagate. None is turned into a rejection or a wait: a bad input must be seen.
  The one exception is the matched feed cutoffs the validator refuses, which the creation
  check reports as `invalid_weights`: that candidate is stored and announced.
- A promotion that is started too late, or hits its deadline or the lock timeout (the
  rescore rolled back whole), is deferred: the version stays a shadow and the step is
  `partial`. Each deferred night is recorded on the shadow (`gate_report.deferred_nights`)
  and the third one sends a `deferred` notice, so a promotion that never fits the window
  is not left to one `nightly step partial` email. The deadline is the step's or
  `PROMOTION_CUTOFF_UTC`, whichever comes first (see `_promotion_window`), so a rescore
  never runs into the market session. `PointerMoved` and `ConcurrentScoreWriter` mean the
  active pointer or the scores moved under it, and fail the step. The rescore is called
  once and never retried.
- An `OperationalError` out of the rescore may be a commit the server applied whose
  acknowledgement was lost. The step reads the `active` pointer on a connection of its
  own: if it names the shadow, the promotion happened and is counted and announced as
  one; otherwise (or if that read fails too) the original error propagates.
- Every night, after the active version is loaded, the step counts the fires tagged with
  some other version. Any count above 0 sends an `off_version` notice naming the active
  version, and changes nothing else: the residue is a repair for the owner (the
  `--only-tag` rescore in nightly/README.md), not a refit failure.
- A write that finds nothing to do means another run of the same night got there first,
  and none of them alerts. `insert_candidate` answering False counts as `already_built`.
  `record_session_eval` answering False is neither counted nor logged, and neither is
  `record_deferral` answering None (the night was already recorded, so no second notice).
  `decide` answering False shows only as the logged decision "already decided".

Every value handed to the store or to Sentry is a Python int, float, str or list: no numpy
scalar, which `json.dumps` refuses. Logs carry the version, the decision and the counts,
never a weight or a ticker, and the notices carry aggregates only. Nothing here writes a
pointer: only the promotion transaction in `rescore_all` moves `active`, and nothing moves
the Take-It pointer.

This module imports `ml/src` and `scripts/` modules at the top (`lottery_scoring`,
`lottery_refit_gates`, `lottery_weights`, `backfill_lottery_scores`), so an `ImportError`
there fails this step alone: `pipeline` imports the step lazily.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from time import monotonic
from typing import TYPE_CHECKING, Any

import pandas as pd
from backfill_lottery_scores import RescoreDeadline, rescore_all
from lottery_refit_gates import (
    FEED_COLUMNS,
    FEED_CUTOFF_MATCH_SESSIONS,
    MIN_EVAL_ROWS_PER_SESSION,
    OUTCOME_COLUMN,
    TRAIN_WINDOW_DAYS,
    FeedCutoffs,
    ShadowVerdict,
    check_creation,
    daily_tier_shares,
    decide_shadow,
    feed_qas,
    match_feed_cutoffs,
    spearman,
)
from lottery_scoring import fetch_frame, train_weights
from lottery_weights import refit_version_id, score_frame
from psycopg2 import OperationalError
from psycopg2.errors import LockNotAvailable

from calendar_nyse import previous_trading_day, recent_sessions, trading_days
from constants import (
    PROMOTION_CUTOFF_UTC,
    PROMOTION_ENABLED,
    PROMOTION_MIN_SECONDS,
    REFIT_STEP_NAME,
)
from monitoring import report_refit
from resources import connect_db
from steps import StepContext, StepResult
from weights_store import (
    StoredVersion,
    count_off_version,
    decide,
    decided_since,
    insert_candidate,
    load_active,
    load_shadow,
    record_deferral,
    record_session_eval,
    version_exists,
)

if TYPE_CHECKING:
    from psycopg2.extensions import connection

log = logging.getLogger(__name__)

# The counts a result always carries, zero or not, in this order.
COUNT_NAMES = (
    "candidates_built",
    "candidates_rejected",
    "already_built",
    "already_decided",
    "sessions_recorded",
    "waiting",
    "passed",
    "promoted",
    "rejected",
    "promotion_deferred",
    "rows_rescored",
    "train_rows",
    "eval_rows",
    "fires_off_version",
)

# `StepResult.detail` is part of the `nightly step partial` fingerprint: a fixed phrase.
DEFERRED_DETAIL = "promotion deferred to the next night"
# The deferred night on which the owner is told: one night is the market window being short,
# three in a row is a promotion that does not fit it. Exactly this night, not every one after
# it: the notice's fingerprint is the version, so a later night would add nothing.
DEFERRED_NOTICE_NIGHTS = 3

# The feed's own frame: the columns `feed_qas` and `daily_tier_shares` read, for every fire
# of the given sessions (the tier monitor counts them all), with the ticker's inversion
# quintile from the LEFT JOIN the feed endpoint uses. Everything here is a SELECT.
_FEED_SELECT = ", ".join(
    "s.inversion_quintile" if column == "inversion_quintile" else f"f.{column}"
    for column in FEED_COLUMNS
)
_FEED_SQL = (
    f"SELECT {_FEED_SELECT} FROM lottery_finder_fires f "
    "LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol "
    "WHERE f.date = ANY(%s::date[])"
)
_NOT_NUMERIC = ("underlying_symbol", "option_type", "tod", "date", "direction_gated")
_NUMERIC_FEED_COLUMNS = tuple(c for c in FEED_COLUMNS if c not in _NOT_NUMERIC)


def fetch_feed_frame(conn: connection, sessions: Sequence[date]) -> pd.DataFrame:
    """Every fire of `sessions` with the `FEED_COLUMNS`, numbers as floats.

    One SELECT. NUMERIC arrives from psycopg2 as `Decimal` in an object column, so each
    numeric column is converted (a NULL becomes NaN). A session with no fires has no rows;
    the caller decides whether that is an error (`decide_shadow` raises for a judged one).
    """
    with conn.cursor() as cursor:
        cursor.execute(_FEED_SQL, (list(sessions),))
        rows = cursor.fetchall()
    frame = pd.DataFrame(rows, columns=list(FEED_COLUMNS))
    for column in _NUMERIC_FEED_COLUMNS:
        frame[column] = pd.to_numeric(frame[column]).astype("float64")
    return frame


def run(ctx: StepContext) -> StepResult:
    counts = dict.fromkeys(COUNT_NAMES, 0)
    with connect_db(ctx.settings) as conn:
        active = load_active(conn)
        _report_off_version(conn, active, counts)
        # Read before anything is built: a second shadow is refused by the store, and that
        # is a failure to surface, never an "already built" to hide.
        shadow = load_shadow(conn)
        if shadow is None:
            version, decision = _build_candidate(conn, ctx, active, counts)
        else:
            version, decision = _judge_shadow(conn, ctx, active, shadow, counts)
    log.info(
        "%s %s: %s%s",
        REFIT_STEP_NAME,
        version,
        decision,
        "".join(f" {name}={n}" for name, n in counts.items()),
    )
    if counts["promotion_deferred"]:
        return StepResult("partial", counts, DEFERRED_DETAIL)
    return StepResult("ok", counts)


def _report_off_version(conn: connection, active: StoredVersion, counts: dict[str, int]) -> None:
    """Count the fires tagged with another version than `active`, and tell the owner.

    After a promotion every fire carries the active tag, so a fire that does not was scored
    by a live writer that fell back to the seed, or was left behind by a by-hand undo. A
    cache period of the Vercel loader is enough to produce some. The count changes no
    status and no later decision: it is a repair for the owner, whose notice carries the
    count and groups by the active version, so each active version mails once. Before the
    first promotion the only tag is the seed's, which is the active one: the count is 0.
    """
    off_version = count_off_version(conn, active.version)
    counts["fires_off_version"] = off_version
    if off_version:
        report_refit(
            "off_version",
            version=active.version,
            reasons=(),
            extras={"fires_off_version": off_version},
        )


# --- no shadow: build a candidate --------------------------------------------------


def _build_candidate(
    conn: connection, ctx: StepContext, active: StoredVersion, counts: dict[str, int]
) -> tuple[str, str]:
    trained_through = ctx.last_session
    version = refit_version_id(trained_through)
    # Two no-ops, in this order: the version this night would build exists (a re-run after a
    # candidate was built or rejected at creation), or the night already decided a shadow
    # (a re-run after its rejection, pass or promotion, when no shadow is left to find).
    if version_exists(conn, version):
        counts["already_built"] += 1
        return version, "already built"
    if decided_since(conn, _start_of_run_date(ctx)):
        counts["already_decided"] += 1
        return version, "decided earlier tonight"

    window_start = trained_through - timedelta(days=TRAIN_WINDOW_DAYS)
    train = fetch_frame(conn, window_start, trained_through)
    counts["train_rows"] = len(train)
    candidate = train_weights(train, base=active.weights, trained_through=trained_through)
    # Scored before the matched cutoffs go in: they do not enter a score, and cutoffs the
    # validator refuses would make `score_frame` raise instead of reaching the rejection.
    insample_rho = float(spearman(score_frame(candidate, train), train[OUTCOME_COLUMN]))

    feed = fetch_feed_frame(conn, recent_sessions(trained_through, FEED_CUTOFF_MATCH_SESSIONS))
    qas_active = feed_qas(score_frame(active.weights, feed), feed)
    qas_candidate = feed_qas(score_frame(candidate, feed), feed)
    before = FeedCutoffs.from_weights(active.weights)
    after = match_feed_cutoffs(qas_candidate, qas_active, before)
    candidate["feed_cutoffs"] = {
        "tier1_min_score": after.tier1_min_score,
        "tier2_min_score": after.tier2_min_score,
    }
    tier1_share = float(daily_tier_shares(qas_candidate, feed, after)["tier1_share"].mean())

    verdict = check_creation(
        candidate,
        train_rows=len(train),
        train_sessions=int(train["date"].nunique()),
        tier1_share=tier1_share,
    )
    report = {
        "creation": {
            "verdict": {
                "ok": verdict.ok,
                "reasons": list(verdict.reasons),
                "train_rows": int(verdict.train_rows),
                "train_sessions": int(verdict.train_sessions),
                "tier1_share": float(verdict.tier1_share),
            },
            "train_window": {
                "after": window_start.isoformat(),
                "through": trained_through.isoformat(),
            },
            "insample_rho": insample_rho,
        }
    }
    inserted = insert_candidate(
        conn,
        version,
        candidate,
        status="shadow" if verdict.ok else "rejected",
        trained_through=trained_through,
        report=report,
    )
    if not inserted:
        # Another run of the same night inserted it between the check above and here.
        counts["already_built"] += 1
        return version, "already built"
    if verdict.ok:
        counts["candidates_built"] += 1
        return version, "built shadow"
    counts["candidates_rejected"] += 1
    report_refit(
        "candidate_rejected",
        version=version,
        reasons=verdict.reasons,
        extras={
            "train_rows": int(verdict.train_rows),
            "train_sessions": int(verdict.train_sessions),
            "tier1_share": float(verdict.tier1_share),
            "insample_rho": insample_rho,
            **_cutoff_extras(before, after),
            **_change_extras(candidate, active.weights),
        },
    )
    return version, "candidate rejected"


def _start_of_run_date(ctx: StepContext) -> datetime:
    """00:00 UTC of the run's own date: a decision stamped at or after it was made tonight.

    From the date's start, not from `ctx.now_utc`: a re-run at 09:00 must still see a
    decision the first run stamped at 07:20. The run's start is read in UTC whatever offset
    the context carries, because the nightly cron fires at 07:15 UTC and the next scheduled
    run falls on the next UTC date.
    """
    return datetime.combine(_run_date(ctx), time.min, tzinfo=UTC)


def _run_date(ctx: StepContext) -> date:
    """The UTC date the run started on: the night a deferral is recorded under."""
    return ctx.now_utc.astimezone(UTC).date()


# --- a shadow exists: record its new sessions and judge it ---------------------------


def _judge_shadow(
    conn: connection,
    ctx: StepContext,
    active: StoredVersion,
    shadow: StoredVersion,
    counts: dict[str, int],
) -> tuple[str, str]:
    if shadow.trained_through is None:
        raise ValueError("a shadow has no trained_through: its evaluation window is unknown")
    # The session before the night's own (`previous_trading_day` is "on or before", so the
    # day before the last session is what makes it strictly earlier): the lag of D6.
    last_judged = previous_trading_day(ctx.last_session - timedelta(days=1))
    elapsed = trading_days(shadow.trained_through + timedelta(days=1), last_judged)
    if not elapsed:
        counts["waiting"] += 1
        return shadow.version, "waiting"

    # The whole elapsed range, recorded or not: `decide_shadow` judges the first ten
    # evaluated sessions from scratch and raises for a judged one with no feed rows.
    eval_frame = fetch_frame(conn, shadow.trained_through, last_judged)
    feed_frame = fetch_feed_frame(conn, elapsed)
    verdict = decide_shadow(
        eval_frame=eval_frame,
        feed_frame=feed_frame,
        candidate=shadow.weights,
        active=active.weights,
        sessions_elapsed=len(elapsed),
    )
    counts["eval_rows"] = int(verdict.eval_rows)

    # Everything that can raise on the data is behind us: no session is written for a
    # night that then fails.
    recorded = shadow.gate_report.get("sessions") or {}
    fresh = [day for day in elapsed if day.isoformat() not in recorded]
    if fresh:
        entries = _session_entries(shadow.weights, active.weights, eval_frame, feed_frame, fresh)
        for day in fresh:
            if record_session_eval(conn, shadow.version, day, entries[day]):
                counts["sessions_recorded"] += 1

    if verdict.decision == "wait":
        counts["waiting"] += 1
        return shadow.version, "waiting"
    summary = _verdict_summary(verdict)
    extras = {
        **_verdict_extras(verdict),
        **_cutoff_extras(
            FeedCutoffs.from_weights(active.weights), FeedCutoffs.from_weights(shadow.weights)
        ),
        **_change_extras(shadow.weights, active.weights),
    }
    if verdict.decision == "reject":
        return _reject(conn, shadow, verdict, summary, extras, counts)
    if not PROMOTION_ENABLED:
        return _mark_passed(conn, shadow, summary, extras, counts)
    return _promote(conn, ctx, active, shadow, summary, extras, counts)


def _reject(
    conn: connection,
    shadow: StoredVersion,
    verdict: ShadowVerdict,
    summary: dict[str, Any],
    extras: dict[str, Any],
    counts: dict[str, int],
) -> tuple[str, str]:
    if not decide(conn, shadow.version, "rejected", summary):
        return shadow.version, "already decided"
    counts["rejected"] += 1
    report_refit("rejected", version=shadow.version, reasons=verdict.reasons, extras=extras)
    return shadow.version, "rejected"


def _mark_passed(
    conn: connection,
    shadow: StoredVersion,
    summary: dict[str, Any],
    extras: dict[str, Any],
    counts: dict[str, int],
) -> tuple[str, str]:
    if not decide(conn, shadow.version, "passed", summary):
        return shadow.version, "already decided"
    counts["passed"] += 1
    report_refit("passed", version=shadow.version, reasons=(), extras=extras)
    return shadow.version, "passed"


def _promote(
    conn: connection,
    ctx: StepContext,
    active: StoredVersion,
    shadow: StoredVersion,
    summary: dict[str, Any],
    extras: dict[str, Any],
    counts: dict[str, int],
) -> tuple[str, str]:
    """Promote in the one transaction `rescore_all` runs, or defer to the next night.

    Not called while promotion is disabled. It starts only with PROMOTION_MIN_SECONDS left
    before both the step's deadline and the cutoff, and its rescore gets whichever of the
    two comes first as its deadline (`_promotion_window`). A rescore that then hits that
    deadline, or waits out the lock timeout, has rolled back whole, so the version is
    still a shadow and the next night judges it again. Nothing here retries it.

    `summary` is the decision the promotion rests on, the same one a pass stores through
    `decide`. `rescore_all` merges it into `gate_report.verdict` in the promotion
    transaction, so the decision that rewrites the live scores is on record with them.

    `rescore_all` needs a connection with no open transaction: `connect_db` gives an
    autocommit one, and everything this step ran on it before is a SELECT, so none is open.

    Any other `OperationalError` from it (a dropped connection, a cancelled statement) is
    either a rollback or a COMMIT the server applied whose acknowledgement never arrived,
    and the exception does not say which. The `active` pointer does: it moves in the same
    transaction as the scores. So the step reads it on a connection of its own. If it names
    the shadow, the promotion is real and is counted and announced like any other, without
    the row counts, which only the lost result held (`commit_ack` says so). If it does not,
    or that read fails too, the original error propagates and fails the step.
    """
    seconds_left, deadline = _promotion_window(ctx)
    if seconds_left < PROMOTION_MIN_SECONDS:
        return _defer_promotion(conn, ctx, shadow, counts)
    try:
        result = rescore_all(
            conn,
            to_version=shadow.version,
            weights=shadow.weights,
            reason="promotion",
            expect_active=active.version,
            dry_run=False,
            deadline=deadline,
            verdict=summary,
        )
    except (RescoreDeadline, LockNotAvailable):
        return _defer_promotion(conn, ctx, shadow, counts)
    except OperationalError:
        if not _active_names(ctx, shadow.version):
            raise
        log.warning(
            "%s %s: the commit was applied, its acknowledgement lost",
            REFIT_STEP_NAME,
            shadow.version,
        )
        counts["promoted"] += 1
        report_refit(
            "promoted",
            version=shadow.version,
            reasons=(),
            extras={**extras, "commit_ack": "lost"},
        )
        return shadow.version, "promoted"
    counts["promoted"] += 1
    counts["rows_rescored"] = int(result.changed)
    report_refit(
        "promoted",
        version=shadow.version,
        reasons=(),
        extras={
            **extras,
            "rows_rescored": int(result.changed),
            "scores_changed": int(result.score_changed),
        },
    )
    return shadow.version, "promoted"


def _defer_promotion(
    conn: connection, ctx: StepContext, shadow: StoredVersion, counts: dict[str, int]
) -> tuple[str, str]:
    """Leave the shadow as it is for the next night, record the night on it, and tell the
    owner when it is the `DEFERRED_NOTICE_NIGHTS`th.

    The write is keyed by the run's UTC date, so a re-run the same night records nothing and
    sends no second notice. The step is `partial` either way (`promotion_deferred`).
    """
    counts["promotion_deferred"] += 1
    nights = record_deferral(conn, shadow.version, _run_date(ctx))
    if nights == DEFERRED_NOTICE_NIGHTS:
        report_refit(
            "deferred",
            version=shadow.version,
            reasons=(),
            extras={"deferred_nights": nights},
        )
    return shadow.version, "promotion deferred"


def _active_names(ctx: StepContext, version: str) -> bool:
    """Whether the `active` pointer names `version`, read on a connection of its own.

    False when it names another version and when the read fails: the caller then re-raises
    the error it was handling. A failed read is logged by its class alone, because a
    connection error's text can carry the database host.
    """
    try:
        with connect_db(ctx.settings) as fresh:
            return load_active(fresh).version == version
    except Exception as exc:
        log.warning(
            "%s %s: could not read the active pointer (%s)",
            REFIT_STEP_NAME,
            version,
            type(exc).__name__,
        )
        return False


def _promotion_window(ctx: StepContext) -> tuple[float, float]:
    """The seconds left and the `monotonic()` deadline for a promotion that starts now:
    the step's own, or today's `PROMOTION_CUTOFF_UTC`, whichever comes first.

    A rescore locks every fire it rewrites, and from 13:00 UTC the live detect cron and the
    other writers touch those fires, so it must be over before then. The cutoff is read
    against the wall clock at this moment, not `ctx.now_utc`, which is when the run
    STARTED: a run that began at 07:15 and reaches this step at 12:20, or one started by
    hand at 12:00, differs from its start by hours. A cutoff already past gives a negative
    time left, so the promotion is deferred.
    """
    now = datetime.now(UTC)
    cutoff = datetime.combine(now.date(), PROMOTION_CUTOFF_UTC, tzinfo=UTC)
    to_cutoff = (cutoff - now).total_seconds()
    return min(ctx.seconds_left(), to_cutoff), min(ctx.deadline, monotonic() + to_cutoff)


# --- what goes into a report or a notice ------------------------------------------------


def _session_dates(frame: pd.DataFrame) -> pd.Series:
    return pd.to_datetime(frame["date"]).dt.date


def _session_entries(
    candidate: Mapping[str, Any],
    active: Mapping[str, Any],
    eval_frame: pd.DataFrame,
    feed_frame: pd.DataFrame,
    sessions: Sequence[date],
) -> dict[date, dict[str, Any]]:
    """What is recorded for each session once it is evaluable: the rows both versions
    score with an outcome, whether that is enough to count as evaluated, each version's rho
    on them and the session's fires.

    The record is a write-once snapshot for the owner reading `gate_report`: it is not what
    the decision rested on. `decide_shadow` reads fresh frames every night, so a late
    enrich pass can make a recorded session differ from what the decision then saw.
    `gate_report.verdict`, stored with the decision, is the record of that."""
    candidate_scores = score_frame(candidate, eval_frame)
    active_scores = score_frame(active, eval_frame)
    outcome = eval_frame[OUTCOME_COLUMN]
    usable = (candidate_scores.notna() & active_scores.notna() & outcome.notna()).to_numpy()
    eval_dates = _session_dates(eval_frame)
    feed_dates = _session_dates(feed_frame)
    entries: dict[date, dict[str, Any]] = {}
    for day in sessions:
        rows = usable & (eval_dates == day).to_numpy()
        n_rows = int(rows.sum())
        entries[day] = {
            "eval_rows": n_rows,
            "evaluated": n_rows >= MIN_EVAL_ROWS_PER_SESSION,
            "rho_candidate": float(spearman(candidate_scores[rows], outcome[rows])),
            "rho_active": float(spearman(active_scores[rows], outcome[rows])),
            "feed_fires": int((feed_dates == day).sum()),
        }
    return entries


def _verdict_summary(verdict: ShadowVerdict) -> dict[str, Any]:
    """The decision as it is stored under `gate_report.verdict`."""
    return {
        "decision": verdict.decision,
        "reasons": list(verdict.reasons),
        "sessions": [day.isoformat() for day in verdict.sessions],
        "eval_rows": int(verdict.eval_rows),
        "rho_candidate": float(verdict.rho_candidate),
        "rho_active": float(verdict.rho_active),
        "tier1_ratio": float(verdict.tier1_ratio),
        "tier12_ratio": float(verdict.tier12_ratio),
        "tier1_share": float(verdict.tier1_share),
    }


def _verdict_extras(verdict: ShadowVerdict) -> dict[str, Any]:
    """The verdict's numbers for a notice. The reasons travel separately."""
    return {
        "sessions": len(verdict.sessions),
        "eval_rows": int(verdict.eval_rows),
        "rho_candidate": float(verdict.rho_candidate),
        "rho_active": float(verdict.rho_active),
        "tier1_ratio": float(verdict.tier1_ratio),
        "tier12_ratio": float(verdict.tier12_ratio),
        "tier1_share": float(verdict.tier1_share),
    }


def _cutoff_extras(before: FeedCutoffs, after: FeedCutoffs) -> dict[str, int]:
    """The feed cutoffs of the active version and of the candidate, as plain ints."""
    return {
        "feed_tier1_before": int(before.tier1_min_score),
        "feed_tier2_before": int(before.tier2_min_score),
        "feed_tier1_after": int(after.tier1_min_score),
        "feed_tier2_after": int(after.tier2_min_score),
    }


def _sign(value: float) -> int:
    return (value > 0) - (value < 0)


def _change_extras(candidate: Mapping[str, Any], active: Mapping[str, Any]) -> dict[str, Any]:
    """How far the candidate moved from the active version, without naming a ticker: the
    number of ticker weights that differ and the labels of the signs that flipped."""
    new, old = candidate["features"], active["features"]
    tickers = set(new["ticker_weights"]) | set(old["ticker_weights"])
    changed = sum(
        new["ticker_weights"].get(ticker, 0) != old["ticker_weights"].get(ticker, 0)
        for ticker in tickers
    )
    flipped: list[str] = []
    if _sign(new["option_type_weights"]["C"] - new["option_type_weights"]["P"]) != _sign(
        old["option_type_weights"]["C"] - old["option_type_weights"]["P"]
    ):
        flipped.append("C/P")
    if _sign(new["dte_weights"]["0"]) != _sign(old["dte_weights"]["0"]):
        flipped.append("DTE0")
    return {"ticker_weights_changed": int(changed), "flipped_signs": flipped}
