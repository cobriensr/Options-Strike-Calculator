"""Multileg pattern matcher for UW Full Tape trades.

PUBLIC API:
    classify_trades(trades, window_seconds=90, strike_tolerance=0.05,
                    size_tolerance=0.1) -> pl.DataFrame

Adds these columns to the input DataFrame:
    inferred_structure  — one of 'vertical', 'strangle', 'risk_reversal',
                          'butterfly', 'isolated_leg'
    match_confidence    — float in [0, 1]
    is_isolated_leg     — bool (match_confidence < 0.5)
    pattern_group_id    — UUID-like string; all trades in a matched group
                          share an ID, isolated legs each get their own.

Algorithm (per ticker, per (expiry, option_type) cell, per time-batch):

    1. Sort trades by executed_at and assign a per-ticker chronological
       row index ``ridx``. Bucket each trade into a fixed time slice of
       size ``window_seconds`` (``tbk``). Any pair within the rolling
       window must lie in the same OR adjacent bucket.

    2. Process per (expiry, option_type) cell so the per-call data
       footprint is bounded. Within each cell we iterate ``tbk`` values
       in fixed-size batches (``_CELL_BATCH_BUCKETS`` buckets per batch);
       for each batch the anchor frame is the batch buckets and the
       partner frame additionally includes one overlap bucket past the
       batch's end (for the adjacent-bucket pair rule).

    3. Per batch:
       a) 2-leg same-type pairs (vertical): self-join the anchor against
          the partner frame on (tbk) for same-bucket, then a separate
          join on (tbk = tbk + 1) for adjacent-bucket. ridx_b > ridx_a
          dedups and bounds to chronologically ordered pairs.
       b) 2-leg cross-type pairs (strangle, risk_reversal): same idea
          but join calls × puts (within the matching expiry). The
          (expiry, option_type) iteration is replayed at the expiry
          level for this case so a "cell" contains both call and put.
       c) 3-leg butterfly: body-centric. For each body trade, look up
          low-wing and high-wing candidates in the body's bucket ± 1.

    4. All pairs are filtered + scored as polars expressions. Confidence
       drops by penalties for strike-spacing error (butterflies only),
       size-ratio error, and per-mid-leg penalty.

    5. Greedy non-overlapping assignment: sort candidates by descending
       confidence (leftmost-ridx tiebreak) and assign FCFS, skipping any
       candidate whose trades are already used. Inherently sequential;
       runs in Python over the candidate frame (small relative to N).

    6. Anything unmatched → ``isolated_leg``, confidence=0, unique gid.

Confidence scoring (deterministic):
    1.0 base for a clean match, minus penalties:
      - strike spacing error  → up to -0.15 (butterfly only)
      - size ratio error      → up to -0.15
      - mid-priced legs       → -0.05 per mid leg (direction less certain)

This is a PURE COMPUTATION module — no I/O. The validation runner that
reads parquet is a separate task.

Motivating analysis:
    docs/tmp/fulltape-tag-stratification-and-multileg-2026-05-07.md
    — 76% of $1M+ "whale" trades are spread legs.

Known limitation — SPY / SPXW on full-day workloads
---------------------------------------------------
On full-day Eod-Full-Tape workloads, SPY (~1.27M rows/day) is borderline
tractable (~6 min wall-clock) and SPXW (~1.33M rows/day, with ~1.09M
concentrated in a single 0DTE expiry) exceeds the 600s budget and trends
toward OOM on 8GB hardware. The bottleneck is the per-expiry cross-type
(calls × puts) join on the 0DTE expiry, where each side has ~540K rows.
Bucket-bounded size keys reduce but do not eliminate the join's
intermediate frame size.

Per-ticker guard: any ticker whose largest single ``(expiry,
option_type)`` cell exceeds ``_MAX_CELL_ROWS_PER_CLASSIFY`` is skipped —
its trades remain unclassified (null structure columns) and the matcher
emits a warning instead of crashing. This is best-effort behavior:
production callers (Lottery / Silent Boom detect crons) already treat a
null matcher result as a no-op.

Follow-ups that would unlock SPY/SPXW, in order of complexity:
  1. Streaming top-K-per-trade heap (Python-loop overhead, moderate;
     unlikely to help — bottleneck is join output size, not accumulator)
  2. Per-expiry sub-batching that drives ``_CELL_BATCH_BUCKETS`` down to
     1 on dense cells (smaller intermediate, more passes)
  3. Cython/Rust hot loop for the per-batch cross-join
  4. Different algorithm (bipartite matching / approximation)

For the Lottery / Silent Boom production use case this limitation is
acceptable — those detectors' ticker universe does not include
SPX/SPXW, and their per-alert windows (±45s) are far below the cell
density threshold.
"""

from __future__ import annotations

import hashlib
import warnings
from collections.abc import Iterable
from typing import Final

import numpy as np
import polars as pl

from multileg_patterns import PATTERNS, PatternSpec

# ── Constants ──────────────────────────────────────────────────────────────

_ISOLATED_NAME: Final = "isolated_leg"
_MIN_ACCEPT_CONFIDENCE: Final = 0.5

# Penalty knobs for confidence scoring.
_STRIKE_PENALTY_MAX: Final = 0.15
_SIZE_PENALTY_MAX: Final = 0.15
_MID_PENALTY: Final = 0.05

# Strikes within this fraction of the larger strike count as the same
# contract (float noise). Distinct from ``strike_tolerance`` which governs
# how loose the layout match can be.
_NEAR_DUPLICATE_STRIKE_FRACTION: Final = 1e-4

# Time-batch size: how many consecutive ``tbk`` buckets to process in one
# join call. Smaller = lower peak memory; higher = less Python loop
# overhead. With the default 90s window, 8 buckets ≈ 12 minutes per
# batch — small enough that the densest single-bucket cell still leaves
# the join frame under ~50M rows, big enough to keep iteration overhead
# under ~100 batches per (expiry, option_type) cell.
_CELL_BATCH_BUCKETS: Final = 4

# Per-trade candidate cap. Before greedy assignment, for each trade
# we keep at most the top-K candidates (by confidence) that involve it.
# A candidate survives the prune if it is in the top-K of ANY of its
# legs. K=8 preserves >99.99% of winners on realistic data (the K-th
# best candidate for a trade almost never wins greedy — the top 1-2 do)
# while collapsing 100x-200x candidate-per-trade densities to ~16x on
# mega-tickers. Greedy walk cost drops in proportion.
_TOPK_PER_TRADE: Final = 8

# Size-bucket explosion cap. Partner side (B) of a 2-leg join is exploded
# into one row per integer in its size band [floor(s*(1-tol)),
# ceil(s*(1+tol))]. Band width scales linearly with size: for
# size_tolerance=0.1, size=10 → 3 buckets, size=100 → 21, size=1000 →
# 201. Past a threshold the explosion factor dwarfs the selectivity
# benefit, so we cap the per-row expansion. Rows whose band exceeds the
# cap are routed onto a fallback non-size-key join path (slower
# per-pair but rare). With cap=30, partner-side expansion peaks at 30x
# and the size threshold for fallback is ~150 (at tol=0.1). Bigger
# trades fall through.
_SIZE_BUCKET_CAP: Final = 30

# Minimum partner-batch size for engaging the bucket-bounded join. Below
# this row count the cartesian product (~N²) of a bare equi-join on
# (tbk + key_extra) is already small and cheap, while the bucket
# explosion's constant overhead (band computation, int_ranges,
# explode, extra hash key, two join paths) dominates. Empirically at
# AMZN scale (~100K rows / ~1K rows-per-batch) the bucket path adds
# ~2x wall-clock vs. the bare join. At NVDA/QQQ scale (~1K-10K
# rows-per-batch) the explosion's selectivity wins decisively. Crossover
# is around batch.height ~ 500-1000; we pick 500 to keep AMZN-shaped
# tickers on the fast path.
_BUCKET_BATCH_MIN_ROWS: Final = 500

# Per-batch prune threshold. When a single batch emits more than this
# many candidates we run the top-K-per-trade prune inline so the
# per-cell accumulator stays bounded. Without it, a dense hot-cell
# (SPXW 0DTE size=1) can emit tens of millions of low-confidence
# candidates per batch and OOM during cell accumulation.
# TODO: re-tune after SPY/SPXW OOM is resolved.
_PER_BATCH_PRUNE_THRESHOLD: Final = 50_000


# Cross-type cross-join pair cap. The cross-type step joins calls × puts
# within one expiry; a dense 0DTE open-burst bucket (e.g. 2,600 calls ×
# 4,400 puts ≈ 11.5M pairs, run twice for both orientations) materializes
# a multi-GB intermediate BEFORE _PER_BATCH_PRUNE_THRESHOLD (which prunes
# the join OUTPUT) can help — that transient spike × concurrency-4 OOM's
# the 24GB Classifier box at the open. When |A| × |B| exceeds this cap we
# iterate side A in row-chunks of ~(cap // |B|) and concat the per-chunk
# results, bounding the per-join intermediate to ~cap rows. A cross /
# size-band join is row-independent in A, so chunking is output-identical:
# (A1 ∪ A2) ⋈ B == (A1 ⋈ B) ∪ (A2 ⋈ B). 1M pairs → sub-GB per request, 4
# concurrent comfortably under 24GB; tunable. At/under the cap the path is
# byte-for-byte the prior single-shot join (no chunking overhead). See
# docs/superpowers/specs/classifier-cross-type-subbatch-2026-06-04.md.
_CROSS_JOIN_PAIR_CAP: Final = 1_000_000


# Butterfly skip threshold. A 3-leg butterfly body × low_wing × high_wing
# join is structurally O(N²) in the per-cell row count (size-constraints
# selectivity is high but the intermediate cross-product is not). For
# (expiry, option_type) cells over this size the body-wing-pair join
# can produce billions of rows in the intermediate frame, OOM'ing even
# with time-bucketing. Butterflies are ≪0.1% of trades so the
# trade-off is favourable: we trade a tiny butterfly-recall loss for
# headroom to classify SPXW/SPY/QQQ at all. Vertical / strangle /
# risk_reversal continue on these cells unaffected.
# TODO: re-tune after SPY/SPXW OOM is resolved.
_BUTTERFLY_CELL_LIMIT: Final = 30_000


# Ticker overload threshold. Any ticker whose largest single
# (expiry, option_type) cell exceeds this row count is skipped entirely
# (trades remain unclassified with null structure columns and a warning
# is logged). The cross-type (calls × puts) join on the densest cell
# dominates per-ticker wall-clock and peak memory; past this threshold
# the cell + its mirror push the matcher past the 600s budget on 8GB
# hardware. Empirically (full-day 2026-05-15 Eod-Full-Tape, 8GB MBP):
#   - NVDA densest cell  ≈ 168K rows → ~70s total  (tractable)
#   - QQQ  densest cell  ≈ 293K rows → ~170s total (tractable)
#   - SPY  densest cell  ≈ 432K rows → ~354s total (marginal but OK)
#   - SPXW densest cell  ≈ 548K rows → timeout / OOM
# 500K leaves SPY tractable while ruling out SPXW. Lottery / Silent
# Boom detect crons send per-alert windows (±45s, single ticker, single
# chain) well below this density, so production use is unaffected.
_MAX_CELL_ROWS_PER_CLASSIFY: Final = 500_000


# Pattern dispatch: the 2-leg patterns drive the per-cell + per-expiry
# matching loops. ``PATTERNS`` (from ``multileg_patterns``) is the single
# source of truth; adding a new 2-leg pattern there will pick it up here
# automatically, provided the new pattern's join shape is expressible as
# (same_option_type, direction_rule). Butterfly remains its own dedicated
# code path because it's structurally 3-leg.
_TWO_LEG_PATTERNS: Final[tuple[PatternSpec, ...]] = tuple(
    p for p in PATTERNS if p.leg_count == 2
)

# Fields the matcher uses. Optional fields (delta, premium, nbbo_*) are
# tolerated if absent.
_REQUIRED_FIELDS: Final = (
    "id",
    "underlying_symbol",
    "executed_at",
    "strike",
    "expiry",
    "option_type",
    "size",
    "price",
)


# ── Public API ────────────────────────────────────────────────────────────


def classify_trades(
    trades: pl.DataFrame,
    window_seconds: int = 90,
    strike_tolerance: float = 0.05,
    size_tolerance: float = 0.1,
) -> pl.DataFrame:
    """Classify trades by multileg structure pattern.

    See module docstring for full algorithm and column semantics.
    """
    if trades.height == 0:
        return _empty_with_columns(trades)

    _validate_schema(trades)

    # Side classification (buy/sell/mid) up front so downstream is simple.
    with_side = _classify_side(trades)

    # Capture the original row order so we can rebuild output columns in the
    # same order as the input.
    indexed = with_side.with_row_index(name="_orig_idx")

    # Stable string id column (matcher works in string-id space throughout).
    indexed = indexed.with_columns(pl.col("id").cast(pl.Utf8).alias("_sid"))

    assignments: dict[str, _Assignment] = {}
    # Trades belonging to a ticker that was skipped by the overload guard
    # receive null structure columns (best-effort matcher semantics) —
    # distinct from "tested, no match found" (isolated_leg). Track the
    # sid set per skipped ticker so we can null those rows on output.
    skipped_sids: set[str] = set()

    # Process per ticker in sorted order for determinism.
    tickers: list[str] = sorted(
        indexed.get_column("underlying_symbol").unique().to_list()
    )
    for ticker in tickers:
        ticker_df = indexed.filter(
            pl.col("underlying_symbol") == ticker
        ).sort(["executed_at", "_sid"])
        if ticker_df.height < 2:
            continue
        classified = _classify_ticker(
            ticker_df,
            window_seconds=window_seconds,
            strike_tolerance=strike_tolerance,
            size_tolerance=size_tolerance,
            assignments=assignments,
        )
        if not classified:
            skipped_sids.update(ticker_df.get_column("_sid").to_list())

    # Build the output columns in original input order. Skipped-ticker
    # rows emit null structure columns; everything else falls through
    # the normal assigned-or-isolated path.
    ids_in_order = indexed.sort("_orig_idx").get_column("_sid").to_list()
    structures: list[str | None] = []
    confidences: list[float | None] = []
    group_ids: list[str | None] = []
    is_isolated: list[bool | None] = []
    for tid in ids_in_order:
        if tid in skipped_sids:
            structures.append(None)
            confidences.append(None)
            group_ids.append(None)
            is_isolated.append(None)
            continue
        a = assignments.get(tid)
        if a is None:
            a = _Assignment(
                structure=_ISOLATED_NAME,
                confidence=0.0,
                group_id=_isolated_group_id(tid),
            )
        structures.append(a.structure)
        confidences.append(a.confidence)
        group_ids.append(a.group_id)
        is_isolated.append(a.confidence < _MIN_ACCEPT_CONFIDENCE)

    return trades.with_columns(
        [
            pl.Series("inferred_structure", structures, dtype=pl.Utf8),
            pl.Series("match_confidence", confidences, dtype=pl.Float64),
            pl.Series("is_isolated_leg", is_isolated, dtype=pl.Boolean),
            pl.Series("pattern_group_id", group_ids, dtype=pl.Utf8),
        ]
    )


# ── Internal types ────────────────────────────────────────────────────────


class _Assignment:
    """Mutable per-trade assignment record."""

    __slots__ = ("structure", "confidence", "group_id")

    def __init__(self, structure: str, confidence: float, group_id: str) -> None:
        self.structure = structure
        self.confidence = confidence
        self.group_id = group_id


# ── Schema + side classification ──────────────────────────────────────────


def _validate_schema(df: pl.DataFrame) -> None:
    missing = [f for f in _REQUIRED_FIELDS if f not in df.columns]
    if missing:
        raise ValueError(f"classify_trades: missing required columns: {missing}")


def _empty_with_columns(df: pl.DataFrame) -> pl.DataFrame:
    return df.with_columns(
        [
            pl.lit(None, dtype=pl.Utf8).alias("inferred_structure"),
            pl.lit(None, dtype=pl.Float64).alias("match_confidence"),
            pl.lit(None, dtype=pl.Boolean).alias("is_isolated_leg"),
            pl.lit(None, dtype=pl.Utf8).alias("pattern_group_id"),
        ]
    )


def _classify_side(df: pl.DataFrame) -> pl.DataFrame:
    """Tag each row with side ∈ {buy, sell, mid}.

    Uses NBBO if present; otherwise defaults to 'mid'. Tolerance of 1c
    around bid/ask matches the spec.

    Raises ``ValueError`` if exactly one of ``nbbo_bid`` / ``nbbo_ask``
    is present — that's a caller bug, and silently degrading every trade
    to ``side='mid'`` would massively over-classify random pairs as
    verticals at ~0.85 confidence. See Phase 1.5 hardening spec
    (Finding 1.5).
    """
    has_bid = "nbbo_bid" in df.columns
    has_ask = "nbbo_ask" in df.columns
    if has_bid != has_ask:
        raise ValueError(
            "classify_trades: caller provided exactly one of nbbo_bid / "
            "nbbo_ask. Either provide both (recommended) or omit both to "
            "fall back to side='mid' for all trades."
        )
    if has_bid and has_ask:
        side_expr = (
            pl.when(pl.col("price") >= pl.col("nbbo_ask") - 0.01)
            .then(pl.lit("buy"))
            .when(pl.col("price") <= pl.col("nbbo_bid") + 0.01)
            .then(pl.lit("sell"))
            .otherwise(pl.lit("mid"))
        )
    else:
        side_expr = pl.lit("mid")
    return df.with_columns(side_expr.alias("side"))


# ── Per-ticker classification (cell × time-batch) ─────────────────────────


def _classify_ticker(
    ticker_df: pl.DataFrame,
    *,
    window_seconds: int,
    strike_tolerance: float,
    size_tolerance: float,
    assignments: dict[str, _Assignment],
) -> bool:
    """Greedy non-overlapping match within one ticker.

    Trades are processed per (expiry, option_type) cell, with each cell
    iterated in fixed-size time-batches so the per-call join frame is
    bounded regardless of ticker size.

    Returns ``True`` if the ticker was classified (assignments populated
    or empty result), ``False`` if the ticker was skipped due to an
    overload guard (e.g. a single cell exceeding
    ``_MAX_CELL_ROWS_PER_CLASSIFY``). Skipped tickers have no entries in
    ``assignments`` — the caller is responsible for emitting null
    structure columns for those rows (best-effort matcher semantics).
    """
    # Defensive: normalize option_type case so any direct caller of
    # classify_trades that doesn't normalize upstream still gets correct
    # cross-type pairing. Without this, _two_leg_cross_type_from_batch's
    # ``option_type[0] == "call"`` literal compare silently zeros out
    # strangles and risk_reversals on uppercase input. Defense-in-depth
    # alongside classifier/src/multileg_routes.py's existing ``.lower()``
    # normalization. See Phase 1.5 hardening spec (Finding 1.4 +
    # Agent C F8 in the red-team review).
    ticker_df = ticker_df.with_columns(
        pl.col("option_type").str.to_lowercase()
    )

    # Slim, sorted, indexed leg frame.
    legs = ticker_df.with_row_index(name="ridx").select(
        [
            pl.col("ridx").cast(pl.UInt32),
            pl.col("_sid").alias("sid"),
            pl.col("executed_at"),
            pl.col("strike").cast(pl.Float64),
            pl.col("expiry"),
            pl.col("option_type"),
            pl.col("size").cast(pl.Float64),
            pl.col("side"),
        ]
    )

    # Time bucket: window-sized slices anchored on this ticker's first
    # trade. Any pair within ``window_seconds`` is in same or adjacent
    # buckets. Microsecond arithmetic avoids float drift.
    ts0 = legs.get_column("executed_at").min()
    win_us = int(window_seconds) * 1_000_000
    legs = legs.with_columns(
        ((pl.col("executed_at") - pl.lit(ts0)).dt.total_microseconds() // win_us)
        .cast(pl.Int64)
        .alias("tbk")
    )

    two_leg_candidates: list[pl.DataFrame] = []
    butterfly_candidates: list[pl.DataFrame] = []

    # Iterate cells in deterministic (expiry, option_type) order.
    cells = legs.partition_by(
        ["expiry", "option_type"], as_dict=True, include_key=True
    )

    # Overload guard: any cell exceeding the per-classify density ceiling
    # would push the cross-type / size-bucket joins past the 600s budget
    # on 8GB hardware. Skip the ticker entirely so the matcher returns
    # best-effort null structure columns for these rows instead of
    # hanging or OOM'ing. See the module docstring's "Known limitation"
    # section for the SPY/SPXW context that motivated this guard.
    max_cell_rows = max(
        (c.height for c in cells.values()), default=0
    )
    if max_cell_rows > _MAX_CELL_ROWS_PER_CLASSIFY:
        ticker_name = ticker_df.get_column("underlying_symbol")[0]
        warnings.warn(
            f"multileg matcher: skipping ticker {ticker_name!r} — "
            f"densest cell has {max_cell_rows:,} rows (> "
            f"{_MAX_CELL_ROWS_PER_CLASSIFY:,} threshold). Trades will "
            f"have null structure columns.",
            RuntimeWarning,
            stacklevel=2,
        )
        return False

    cell_keys = sorted(cells.keys(), key=lambda k: (str(k[0]), str(k[1])))

    # For cross-type (strangle, risk_reversal) we need to pair calls vs.
    # puts within the SAME expiry. Group by expiry alone for that case.
    cells_by_expiry: dict[object, pl.DataFrame] = {}
    for k, v in cells.items():
        # k is a tuple like (expiry, option_type)
        cells_by_expiry.setdefault(k[0], []).append(v)
    expiry_keys = sorted(cells_by_expiry.keys(), key=str)

    # Per-cell candidate collectors. We materialize each cell's candidate
    # contribution then immediately prune it to top-K-per-trade so the
    # accumulated frames stay bounded by ~K × (rows-in-ticker) across all
    # cells. Without per-cell pruning, hot cells (e.g. SPXW 0DTE) emit
    # tens of millions of low-confidence candidates that would OOM the
    # concat step.

    def _accumulate(cell_two: list[pl.DataFrame], cell_three: list[pl.DataFrame]) -> None:
        ct = (
            pl.concat(cell_two, how="vertical_relaxed")
            if cell_two
            else _empty_candidates_2leg()
        )
        c3 = (
            pl.concat(cell_three, how="vertical_relaxed")
            if cell_three
            else _empty_candidates_3leg()
        )
        ct, c3 = _prune_top_k_per_trade(ct, c3)
        if ct.height > 0:
            two_leg_candidates.append(ct)
        if c3.height > 0:
            butterfly_candidates.append(c3)

    # Split 2-leg pattern set by join shape — same-type patterns share one
    # self-join per cell, cross-type patterns share one cross-join per
    # expiry. Direction filter + scoring are per-pattern downstream.
    same_type_patterns = tuple(
        p for p in _TWO_LEG_PATTERNS if p.same_option_type
    )
    cross_type_patterns = tuple(
        p for p in _TWO_LEG_PATTERNS if not p.same_option_type
    )

    # ── Per-cell: same-type 2-leg + butterfly (same expiry, same opttype) ──
    for k in cell_keys:
        cell = cells[k]
        if cell.height < 2:
            continue
        cell_two: list[pl.DataFrame] = []
        cell_three: list[pl.DataFrame] = []
        if same_type_patterns:
            for batch in _iter_two_leg_batches(cell):
                vcand = _two_leg_same_type_from_batch(
                    batch,
                    patterns=same_type_patterns,
                    window_seconds=window_seconds,
                    size_tolerance=size_tolerance,
                )
                if vcand.height > 0:
                    # Per-batch prune: very dense hot-cell batches can emit
                    # millions of candidates which would OOM if accumulated
                    # across the cell's 100+ batches before per-cell prune.
                    if vcand.height > _PER_BATCH_PRUNE_THRESHOLD:
                        vcand, _ = _prune_top_k_per_trade(
                            vcand, _empty_candidates_3leg()
                        )
                    cell_two.append(vcand)
        if cell.height >= 3 and cell.height <= _BUTTERFLY_CELL_LIMIT:
            for batch in _iter_butterfly_batches(cell):
                bcand = _butterfly_from_batch(
                    batch,
                    window_seconds=window_seconds,
                    strike_tolerance=strike_tolerance,
                    size_tolerance=size_tolerance,
                )
                if bcand.height > 0:
                    if bcand.height > _PER_BATCH_PRUNE_THRESHOLD:
                        _, bcand = _prune_top_k_per_trade(
                            _empty_candidates_2leg(), bcand
                        )
                    cell_three.append(bcand)
        if cell_two or cell_three:
            _accumulate(cell_two, cell_three)

    # ── Per-expiry: cross-type 2-leg (strangle, risk_reversal, …) ────────
    if cross_type_patterns:
        for ek in expiry_keys:
            cells_for_expiry = cells_by_expiry[ek]
            if len(cells_for_expiry) < 2:
                continue
            calls = next(
                (
                    c
                    for c in cells_for_expiry
                    if c.get_column("option_type")[0] == "call"
                ),
                None,
            )
            puts = next(
                (
                    c
                    for c in cells_for_expiry
                    if c.get_column("option_type")[0] == "put"
                ),
                None,
            )
            if calls is None or puts is None:
                continue
            if calls.height == 0 or puts.height == 0:
                continue
            cell_two_xtype: list[pl.DataFrame] = []
            for chunk_calls, chunk_puts in _iter_cross_type_batches(
                calls, puts
            ):
                ccand = _two_leg_cross_type_from_batch(
                    chunk_calls,
                    chunk_puts,
                    patterns=cross_type_patterns,
                    window_seconds=window_seconds,
                    size_tolerance=size_tolerance,
                )
                if ccand.height > 0:
                    if ccand.height > _PER_BATCH_PRUNE_THRESHOLD:
                        ccand, _ = _prune_top_k_per_trade(
                            ccand, _empty_candidates_3leg()
                        )
                    cell_two_xtype.append(ccand)
            if cell_two_xtype:
                _accumulate(cell_two_xtype, [])

    two_leg = (
        pl.concat(two_leg_candidates, how="vertical_relaxed")
        if two_leg_candidates
        else _empty_candidates_2leg()
    )
    three_leg = (
        pl.concat(butterfly_candidates, how="vertical_relaxed")
        if butterfly_candidates
        else _empty_candidates_3leg()
    )

    # Final global prune: candidates surviving per-cell prune may still
    # exceed top-K-per-trade globally (a trade can appear in candidates
    # from multiple cells via cross-type). Re-run.
    two_leg, three_leg = _prune_top_k_per_trade(two_leg, three_leg)

    _greedy_assign(two_leg, three_leg, assignments=assignments)
    return True


# ── Batch iteration ───────────────────────────────────────────────────────


def _iter_two_leg_batches(cell: pl.DataFrame) -> Iterable[pl.DataFrame]:
    """Yield a single frame per time-batch over a (expiry, opttype) cell.

    Each batch covers ``_CELL_BATCH_BUCKETS`` consecutive ``tbk`` values
    plus one overlap bucket past the batch end (so adjacent-bucket pairs
    that straddle a batch boundary are emitted exactly once — they
    appear in the earlier batch where the anchor lives, since the anchor
    selector ``ridx_a in this_batch_bucket_set_minus_overlap`` is
    enforced inside the join filter).

    Note: callers receive ONE frame per batch that contains both anchor
    rows AND overlap rows. The join is responsible for restricting the
    anchor side to non-overlap buckets via ``tbk_a`` filtering.
    """
    buckets = cell.get_column("tbk").unique().sort().to_list()
    if not buckets:
        return
    n = len(buckets)
    step = max(1, _CELL_BATCH_BUCKETS)
    for i in range(0, n, step):
        anchor_buckets = buckets[i : i + step]
        # Overlap = one bucket past the batch's max bucket (if any). The
        # overlap supplies the partner side for adjacent pairs that
        # straddle the batch boundary.
        all_buckets = set(anchor_buckets)
        if i + step < n:
            all_buckets.add(buckets[i + step])
        max_anchor = anchor_buckets[-1]
        batch = cell.filter(pl.col("tbk").is_in(list(all_buckets)))
        if batch.height < 2:
            continue
        # Annotate which rows are anchors (ridx_a is allowed) vs.
        # overlap-only (allowed only as ridx_b). max_anchor demarcates.
        batch = batch.with_columns(
            (pl.col("tbk") <= max_anchor).alias("_is_anchor")
        )
        yield batch


def _iter_butterfly_batches(cell: pl.DataFrame) -> Iterable[pl.DataFrame]:
    """Yield (body, wings) frames per time-batch.

    Body anchors live in the batch buckets; wings live in body bucket
    ± 1. Frame uses ``_is_body`` to demarcate.

    Similar to ``_iter_two_leg_batches`` but with overlap on BOTH sides
    because a body in the first bucket of a batch may have a wing in the
    previous batch's last bucket. For chronological consistency we
    consider only wings in the current batch's bucket range — the prior
    batch already handled (body=prev_last, wing=this_first) when
    iterating bodies. We use ``ridx`` ordering at filter time to keep
    each triple emitted exactly once.
    """
    buckets = cell.get_column("tbk").unique().sort().to_list()
    if not buckets:
        return
    n = len(buckets)
    step = max(1, _CELL_BATCH_BUCKETS)
    for i in range(0, n, step):
        anchor_buckets = buckets[i : i + step]
        all_buckets = set(anchor_buckets)
        # Bring in one prior bucket (for low-wing) and one subsequent
        # bucket (for high-wing or late-arriving partners). Bodies remain
        # anchored to anchor_buckets; wings may live in the wider set.
        if i > 0:
            all_buckets.add(buckets[i - 1])
        if i + step < n:
            all_buckets.add(buckets[i + step])
        anchor_set = set(anchor_buckets)
        batch = cell.filter(pl.col("tbk").is_in(list(all_buckets)))
        if batch.height < 3:
            continue
        # Annotate body vs. wing-only rows so the join restricts the
        # body anchor to anchor_set while wings come from the full set.
        batch = batch.with_columns(
            pl.col("tbk").is_in(list(anchor_set)).alias("_is_body")
        )
        yield batch


def _iter_cross_type_batches(
    calls: pl.DataFrame, puts: pl.DataFrame
) -> Iterable[tuple[pl.DataFrame, pl.DataFrame]]:
    """Yield (calls_chunk, puts_chunk) per time-batch.

    Anchors come from the batch buckets on the larger side; partners
    include the batch buckets PLUS overlap on the opposing side.
    """
    # Use the union of buckets across both sides as the iteration axis,
    # so an expiry where calls and puts trade at different times still
    # works (rare but possible at the open).
    union_buckets = sorted(
        set(calls.get_column("tbk").unique().to_list())
        | set(puts.get_column("tbk").unique().to_list())
    )
    if not union_buckets:
        return
    n = len(union_buckets)
    step = max(1, _CELL_BATCH_BUCKETS)
    for i in range(0, n, step):
        anchor_buckets = union_buckets[i : i + step]
        all_buckets = set(anchor_buckets)
        if i + step < n:
            all_buckets.add(union_buckets[i + step])
        max_anchor = anchor_buckets[-1]
        c_batch = calls.filter(pl.col("tbk").is_in(list(all_buckets)))
        p_batch = puts.filter(pl.col("tbk").is_in(list(all_buckets)))
        if c_batch.height == 0 or p_batch.height == 0:
            continue
        c_batch = c_batch.with_columns(
            (pl.col("tbk") <= max_anchor).alias("_is_anchor")
        )
        p_batch = p_batch.with_columns(
            (pl.col("tbk") <= max_anchor).alias("_is_anchor")
        )
        yield c_batch, p_batch


# ── 2-leg same-type (vertical and any future same-type patterns) ─────────


def _two_leg_same_type_from_batch(
    batch: pl.DataFrame,
    *,
    patterns: tuple[PatternSpec, ...],
    window_seconds: int,
    size_tolerance: float,
) -> pl.DataFrame:
    """Pattern-driven self-join for same-option-type 2-leg patterns.

    Runs ONE self-join per batch (the expensive step) and then loops over
    ``patterns`` to apply each pattern's direction filter and emit scored
    candidates labelled with the pattern's name. New same-type 2-leg
    patterns added to ``PATTERNS`` in ``multileg_patterns`` flow through
    here automatically.
    """
    if batch.height < 2 or not patterns:
        return _empty_candidates_2leg()

    pairs = _self_join_two_leg(
        batch, key_extra=["option_type"], size_tolerance=size_tolerance
    )
    if pairs.height == 0:
        return _empty_candidates_2leg()

    # Restrict to anchor-on-A: A must come from the batch's anchor
    # buckets. B may come from anchor OR the single overlap bucket.
    pairs = pairs.filter(pl.col("_is_anchor"))

    pairs = _apply_two_leg_window_and_size(
        pairs,
        window_seconds=window_seconds,
        size_tolerance=size_tolerance,
    )
    if pairs.height == 0:
        return _empty_candidates_2leg()

    return _score_per_pattern(
        pairs, patterns=patterns, size_tolerance=size_tolerance
    )


# ── 2-leg cross-type (strangle, risk_reversal, any future cross-type) ────


def _two_leg_cross_type_from_batch(
    calls: pl.DataFrame,
    puts: pl.DataFrame,
    *,
    patterns: tuple[PatternSpec, ...],
    window_seconds: int,
    size_tolerance: float,
) -> pl.DataFrame:
    """Pattern-driven cross-type join (calls × puts) for one batch.

    Runs the cross-join in BOTH orientations (calls-as-A and puts-as-A so
    ridx_b > ridx_a covers both directions) and then loops over
    ``patterns`` to apply each pattern's direction filter and emit scored
    candidates. New cross-type 2-leg patterns added to ``PATTERNS`` flow
    through here automatically.

    Peak memory is bounded by ~``_CROSS_JOIN_PAIR_CAP`` rows per
    cross-join: when an orientation's ``|A| × |B|`` exceeds the cap, side
    A is iterated in row-chunks so the largest single intermediate stays
    ~cap-sized instead of materializing the full cartesian product (which
    OOM's the box on a dense 0DTE open burst). Each orientation is scored
    independently and the per-orientation results are concatenated; below
    the cap the path is byte-for-byte the prior single-shot join.
    """
    if calls.height == 0 or puts.height == 0 or not patterns:
        return _empty_candidates_2leg()

    scored = [
        _cross_type_scored_one_orientation(
            a=a,
            b=b,
            patterns=patterns,
            window_seconds=window_seconds,
            size_tolerance=size_tolerance,
        )
        for a, b in ((calls, puts), (puts, calls))
    ]
    frames = [f for f in scored if f.height > 0]
    if not frames:
        return _empty_candidates_2leg()
    if len(frames) == 1:
        return frames[0]
    return pl.concat(frames, how="vertical_relaxed")


def _cross_type_scored_one_orientation(
    *,
    a: pl.DataFrame,
    b: pl.DataFrame,
    patterns: tuple[PatternSpec, ...],
    window_seconds: int,
    size_tolerance: float,
) -> pl.DataFrame:
    """Cross-join one orientation (a × b), then anchor-filter, window/size
    filter, and score — sub-batching side A when ``|a| × |b|`` exceeds
    ``_CROSS_JOIN_PAIR_CAP``.

    Output-identical to a single-shot ``_cross_join_two_leg(a, b)`` + the
    shared scoring tail: the cross / size-band join is row-independent in
    A, and the ``_is_anchor`` filter, ``_apply_two_leg_window_and_size``,
    and ``_score_per_pattern`` steps are all per-row, so
    ``(A1 ∪ A2) ⋈ B`` scored == ``(A1 ⋈ B) ∪ (A2 ⋈ B)`` scored. When
    chunking is not triggered, this is one ``_cross_join_two_leg`` call
    and one scoring pass, exactly as the prior code.
    """
    if a.height == 0 or b.height == 0:
        return _empty_candidates_2leg()

    def _score(pairs: pl.DataFrame) -> pl.DataFrame:
        # Restrict anchor side to non-overlap (A's _is_anchor tells us if
        # A is in the anchor set), then window/size filter and score.
        pairs = pairs.filter(pl.col("_is_anchor"))
        pairs = _apply_two_leg_window_and_size(
            pairs,
            window_seconds=window_seconds,
            size_tolerance=size_tolerance,
        )
        if pairs.height == 0:
            return _empty_candidates_2leg()
        return _score_per_pattern(
            pairs, patterns=patterns, size_tolerance=size_tolerance
        )

    # Common case: cartesian product fits under the cap → single-shot,
    # byte-for-byte the prior path (no chunking overhead, no extra prune).
    if a.height * b.height <= _CROSS_JOIN_PAIR_CAP:
        return _score(
            _cross_join_two_leg(a=a, b=b, size_tolerance=size_tolerance)
        )

    # Dense bucket: chunk side A so each cross-join intermediate stays
    # ~cap-sized. n_chunks = ceil(|a| / chunk_rows).
    chunk_rows = max(1, _CROSS_JOIN_PAIR_CAP // max(1, b.height))
    n_chunks = (a.height + chunk_rows - 1) // chunk_rows
    warnings.warn(
        f"multileg matcher: sub-batching dense cross-type join "
        f"(n_calls/n_puts side-A={a.height:,}, side-B={b.height:,}, "
        f"{a.height * b.height:,} pairs > {_CROSS_JOIN_PAIR_CAP:,} cap) "
        f"into {n_chunks} sub-chunks of {chunk_rows:,} rows.",
        RuntimeWarning,
        stacklevel=2,
    )
    chunk_out: list[pl.DataFrame] = []
    for start in range(0, a.height, chunk_rows):
        a_chunk = a.slice(start, chunk_rows)
        scored = _score(
            _cross_join_two_leg(
                a=a_chunk, b=b, size_tolerance=size_tolerance
            )
        )
        if scored.height == 0:
            continue
        # Mirror the surrounding loop's per-batch prune so the chunked
        # accumulator stays bounded on a hot cell.
        if scored.height > _PER_BATCH_PRUNE_THRESHOLD:
            scored, _ = _prune_top_k_per_trade(
                scored, _empty_candidates_3leg()
            )
        chunk_out.append(scored)
    if not chunk_out:
        return _empty_candidates_2leg()
    if len(chunk_out) == 1:
        return chunk_out[0]
    return pl.concat(chunk_out, how="vertical_relaxed")


def _score_per_pattern(
    pairs: pl.DataFrame,
    *,
    patterns: tuple[PatternSpec, ...],
    size_tolerance: float,
) -> pl.DataFrame:
    """Apply each pattern's direction filter and emit scored candidates."""
    frames_out: list[pl.DataFrame] = []
    for pattern in patterns:
        scored = _score_two_leg(
            pairs.filter(_dir_expr_for(pattern)),
            pattern_name=pattern.name,
            size_tolerance=size_tolerance,
        )
        if scored.height > 0:
            frames_out.append(scored)
    if not frames_out:
        return _empty_candidates_2leg()
    if len(frames_out) == 1:
        return frames_out[0]
    return pl.concat(frames_out, how="vertical_relaxed")


# ── Low-level self-join helpers (vectorized, time-bucketed) ───────────────


# A-side column set carried into 2-leg pair frames. We project these on
# both sides of every join (B columns get a ``_b`` suffix). The shared
# layout keeps polars.concat across same-bucket and adjacent-bucket join
# results schema-compatible.
_A_COLS_TWO_LEG = (
    "ridx",
    "sid",
    "executed_at",
    "strike",
    "size",
    "side",
    "_is_anchor",
)


def _split_b_for_bucket_join(
    batch: pl.DataFrame, *, size_tolerance: float
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Partition a batch's rows into (in-band, overflow) by size-band width.

    For each row compute ``[lo, hi]`` = ``[floor(size*(1-tol)),
    ceil(size*(1+tol))]`` (both clamped to ≥1). Rows whose band has
    ``hi - lo + 1 <= _SIZE_BUCKET_CAP`` are *in-band* and will be
    exploded onto a per-bucket key. Rows whose band exceeds the cap are
    *overflow* and routed through the legacy no-size-key fallback join
    (rare but unbounded explosion would otherwise dominate runtime).

    The in-band frame gains an integer column ``_size_bucket`` (one row
    per integer in the band, exploded). The overflow frame is passed
    through untouched so the caller can join it with a non-size key.
    """
    if batch.height == 0:
        # Both halves are empty but the in-band frame still needs the
        # ``_size_bucket`` column so downstream projections type-check.
        empty_in_band = batch.with_columns(
            pl.lit(0, dtype=pl.Int64).alias("_size_bucket")
        )
        return empty_in_band, batch
    tol_lit = pl.lit(float(size_tolerance))
    with_band = batch.with_columns(
        pl.max_horizontal(
            [
                pl.lit(1, dtype=pl.Int64),
                (pl.col("size") * (pl.lit(1.0) - tol_lit))
                .floor()
                .cast(pl.Int64),
            ]
        ).alias("_band_lo"),
        pl.max_horizontal(
            [
                pl.lit(1, dtype=pl.Int64),
                (pl.col("size") * (pl.lit(1.0) + tol_lit))
                .ceil()
                .cast(pl.Int64),
            ]
        ).alias("_band_hi"),
    ).with_columns(
        (pl.col("_band_hi") - pl.col("_band_lo") + 1).alias("_band_n")
    )

    in_band = with_band.filter(pl.col("_band_n") <= _SIZE_BUCKET_CAP)
    overflow = with_band.filter(pl.col("_band_n") > _SIZE_BUCKET_CAP).drop(
        ["_band_lo", "_band_hi", "_band_n"]
    )

    if in_band.height > 0:
        in_band = (
            in_band.with_columns(
                pl.int_ranges(
                    pl.col("_band_lo"), pl.col("_band_hi") + 1
                ).alias("_size_bucket")
            )
            .explode("_size_bucket")
            .with_columns(pl.col("_size_bucket").cast(pl.Int64))
            .drop(["_band_lo", "_band_hi", "_band_n"])
        )
    else:
        in_band = with_band.drop(["_band_lo", "_band_hi", "_band_n"]).with_columns(
            pl.lit(0, dtype=pl.Int64).alias("_size_bucket")
        ).head(0)
    return in_band, overflow


def _self_join_no_size_key(
    a_proj: pl.DataFrame,
    b_proj: pl.DataFrame,
    *,
    key_extra: list[str],
) -> list[pl.DataFrame]:
    """Same-type join (same bucket + adjacent) WITHOUT a size key.

    Returns the list of non-empty result frames (caller concats). Used by
    the small-batch fast path and as the overflow fallback for large-size
    rows that can't be bucket-exploded without OOM.
    """
    out: list[pl.DataFrame] = []
    same = a_proj.join(b_proj, on=list(key_extra) + ["tbk"], how="inner")
    if same.height > 0:
        same = same.filter(pl.col("ridx_b") > pl.col("ridx"))
        if same.height > 0:
            out.append(same)
    a_adj = a_proj.with_columns((pl.col("tbk") + 1).alias("_tbk_next"))
    adj = a_adj.join(
        b_proj,
        left_on=list(key_extra) + ["_tbk_next"],
        right_on=list(key_extra) + ["tbk"],
        how="inner",
    )
    if adj.height > 0:
        adj = adj.filter(pl.col("ridx_b") > pl.col("ridx")).drop("_tbk_next")
        if adj.height > 0:
            out.append(adj)
    return out


def _self_join_two_leg(
    batch: pl.DataFrame, *, key_extra: list[str], size_tolerance: float
) -> pl.DataFrame:
    """Same-type self-join: A × B on (tbk, size key) for same bucket OR
    (A.tbk + 1, size key) for adjacent. Caller pre-partitioned by
    (expiry, option_type) so ``key_extra`` is mostly a safety belt.

    Bucket-bounded size key
    -----------------------
    ``size_tolerance`` is pushed into the join key via a partner-side
    explosion. Each B row is replaced with N rows, where N = band width
    ``ceil(s*(1+tol)) - floor(s*(1-tol)) + 1``. The join key is
    ``key_extra + tbk + size`` on A and ``key_extra + tbk +
    _size_bucket`` on B. A pair surfaces iff A's integer size falls in
    B's band — the same set the post-join ``_size_err <= tol`` filter
    would have admitted (within band approximation; ``_size_err`` is
    still computed downstream so the size penalty fires unchanged).

    Small-batch fast path
    ---------------------
    Below ``_BUCKET_BATCH_MIN_ROWS`` partner-side rows, the bucket
    explosion's constant overhead exceeds the cartesian-product cost of
    a bare equi-join. We skip the explosion entirely and use the legacy
    no-size-key join, letting the post-join ``_size_err <= tol`` filter
    do the size gating. Empirically critical for AMZN-shaped tickers
    where most cells are small.

    Pathological-size protection
    ----------------------------
    Band width grows linearly with size (size=1000 → 201 buckets at
    tol=0.1). To prevent OOM/stall on mega-tickers, B rows with band
    width > ``_SIZE_BUCKET_CAP`` are NOT exploded — they're peeled off
    and run through the same legacy no-size-key join used by the
    fast path. On real data the overflow slice is small (size>~150
    prints are rare), so the O(N²) cost there is bounded.

    Returns one frame with A's columns and B's columns suffixed _b,
    plus ``tbk`` (A's bucket; preserved for parity, not used downstream).
    """
    # ── Small-batch fast path: skip the bucket explosion entirely. ────
    if batch.height < _BUCKET_BATCH_MIN_ROWS:
        a_proj = batch.select(
            *(pl.col(c) for c in _A_COLS_TWO_LEG),
            pl.col("tbk"),
            *(pl.col(k) for k in key_extra),
        )
        b_proj = batch.select(
            pl.col("ridx").alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("tbk"),
            *(pl.col(k) for k in key_extra),
        )
        frames = _self_join_no_size_key(
            a_proj, b_proj, key_extra=key_extra
        )
        if not frames:
            return _empty_two_leg_pairs(with_keys=key_extra)
        return pl.concat(frames, how="vertical_relaxed")

    # ── A side: one row per anchor, integer size key for the join. ────
    a_size_int = pl.col("size").round(0).cast(pl.Int64).alias("_size_a_key")
    a_with_keys = batch.select(
        *(pl.col(c) for c in _A_COLS_TWO_LEG),
        pl.col("tbk"),
        *(pl.col(k) for k in key_extra),
        a_size_int,
    )

    # ── B side: split into in-band (exploded) and overflow (raw). ─────
    b_in_band, b_overflow = _split_b_for_bucket_join(
        batch, size_tolerance=size_tolerance
    )

    b_in_band_proj = (
        b_in_band.select(
            pl.col("ridx").alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("tbk"),
            *(pl.col(k) for k in key_extra),
            pl.col("_size_bucket"),
        )
        if b_in_band.height > 0
        else b_in_band.select(
            pl.col("ridx").cast(pl.UInt32).alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("tbk"),
            *(pl.col(k) for k in key_extra),
            pl.col("_size_bucket"),
        )
    )

    b_overflow_proj = b_overflow.select(
        pl.col("ridx").alias("ridx_b"),
        pl.col("sid").alias("sid_b"),
        pl.col("executed_at").alias("executed_at_b"),
        pl.col("strike").alias("strike_b"),
        pl.col("size").alias("size_b"),
        pl.col("side").alias("side_b"),
        pl.col("_is_anchor").alias("_is_anchor_b"),
        pl.col("tbk"),
        *(pl.col(k) for k in key_extra),
    )

    frames: list[pl.DataFrame] = []

    # ── Bucket-bounded path: A.size_int == B._size_bucket ──────────────
    if b_in_band_proj.height > 0:
        same = a_with_keys.join(
            b_in_band_proj,
            left_on=list(key_extra) + ["tbk", "_size_a_key"],
            right_on=list(key_extra) + ["tbk", "_size_bucket"],
            how="inner",
        )
        if same.height > 0:
            same = same.filter(pl.col("ridx_b") > pl.col("ridx"))
        a_adj = a_with_keys.with_columns(
            (pl.col("tbk") + 1).alias("_tbk_next")
        )
        adj = a_adj.join(
            b_in_band_proj,
            left_on=list(key_extra) + ["_tbk_next", "_size_a_key"],
            right_on=list(key_extra) + ["tbk", "_size_bucket"],
            how="inner",
        )
        if adj.height > 0:
            adj = adj.filter(pl.col("ridx_b") > pl.col("ridx")).drop(
                "_tbk_next"
            )
        for f in (same, adj):
            if f.height > 0:
                frames.append(f.drop("_size_a_key"))

    # ── Fallback path: large-size B rows, no size key in join. ────────
    if b_overflow_proj.height > 0:
        a_fallback = a_with_keys.drop("_size_a_key")
        frames.extend(
            _self_join_no_size_key(
                a_fallback, b_overflow_proj, key_extra=key_extra
            )
        )

    if not frames:
        return _empty_two_leg_pairs(with_keys=key_extra)
    return pl.concat(frames, how="vertical_relaxed")


def _cross_join_no_size_key(
    a_proj: pl.DataFrame, b_proj: pl.DataFrame
) -> list[pl.DataFrame]:
    """Cross-type join (calls × puts, same bucket + adjacent) without
    a size key. Used by the small-batch fast path and as the overflow
    fallback for large-size rows.
    """
    out: list[pl.DataFrame] = []
    same = a_proj.join(b_proj, on="tbk", how="inner")
    if same.height > 0:
        same = same.filter(pl.col("ridx_b") > pl.col("ridx"))
        if same.height > 0:
            out.append(same)
    a_adj = a_proj.with_columns((pl.col("tbk") + 1).alias("_tbk_next"))
    adj = a_adj.join(
        b_proj, left_on="_tbk_next", right_on="tbk", how="inner"
    )
    if adj.height > 0:
        adj = adj.filter(pl.col("ridx_b") > pl.col("ridx")).drop("_tbk_next")
        if adj.height > 0:
            out.append(adj)
    return out


def _cross_join_two_leg(
    *, a: pl.DataFrame, b: pl.DataFrame, size_tolerance: float
) -> pl.DataFrame:
    """Cross-type join: a × b on tbk (same bucket) OR a.tbk + 1 = b.tbk
    (adjacent). Same bucket-bounded size-key approach as
    ``_self_join_two_leg`` — partner side (b) is exploded into one row
    per integer in the size band, and the join keys on ``A.size_int ==
    B._size_bucket`` plus tbk. Pathological-size rows (band >
    ``_SIZE_BUCKET_CAP``) fall through to a no-size-key fallback path.

    Below ``_BUCKET_BATCH_MIN_ROWS`` (measured on the partner side ``b``)
    we skip the bucket explosion entirely — at that scale the bucket
    overhead dominates the cartesian join cost it would have saved.

    ``a`` and ``b`` must share ``expiry``. Caller does the per-expiry
    grouping. ridx_b > ridx_a deduplicates within one pass. Unlike the
    self-join, the two sides are DIFFERENT (calls vs. puts) — so we do
    NOT need a second orientation: the caller invokes this helper twice
    (a=calls,b=puts AND a=puts,b=calls) to cover both directions.
    """
    # ── Small-batch fast path: bare cross-type join, no size key. ────
    if b.height < _BUCKET_BATCH_MIN_ROWS:
        a_proj = a.select(
            *(pl.col(c) for c in _A_COLS_TWO_LEG),
            pl.col("option_type"),
            pl.col("tbk"),
        )
        b_proj_no_key = b.select(
            pl.col("ridx").alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("option_type").alias("option_type_b"),
            pl.col("tbk"),
        )
        frames = _cross_join_no_size_key(a_proj, b_proj_no_key)
        if not frames:
            return _empty_two_leg_pairs(with_keys=["option_type"])
        return pl.concat(frames, how="vertical_relaxed")

    a_size_int = pl.col("size").round(0).cast(pl.Int64).alias("_size_a_key")
    a_with_opttype = a.select(
        *(pl.col(c) for c in _A_COLS_TWO_LEG),
        pl.col("option_type"),
        pl.col("tbk"),
        a_size_int,
    )

    b_in_band, b_overflow = _split_b_for_bucket_join(
        b, size_tolerance=size_tolerance
    )
    b_in_band_proj = (
        b_in_band.select(
            pl.col("ridx").alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("option_type").alias("option_type_b"),
            pl.col("tbk"),
            pl.col("_size_bucket"),
        )
        if b_in_band.height > 0
        else b_in_band.select(
            pl.col("ridx").cast(pl.UInt32).alias("ridx_b"),
            pl.col("sid").alias("sid_b"),
            pl.col("executed_at").alias("executed_at_b"),
            pl.col("strike").alias("strike_b"),
            pl.col("size").alias("size_b"),
            pl.col("side").alias("side_b"),
            pl.col("_is_anchor").alias("_is_anchor_b"),
            pl.col("option_type").alias("option_type_b"),
            pl.col("tbk"),
            pl.col("_size_bucket"),
        )
    )
    b_overflow_proj = b_overflow.select(
        pl.col("ridx").alias("ridx_b"),
        pl.col("sid").alias("sid_b"),
        pl.col("executed_at").alias("executed_at_b"),
        pl.col("strike").alias("strike_b"),
        pl.col("size").alias("size_b"),
        pl.col("side").alias("side_b"),
        pl.col("_is_anchor").alias("_is_anchor_b"),
        pl.col("option_type").alias("option_type_b"),
        pl.col("tbk"),
    )

    frames: list[pl.DataFrame] = []

    if b_in_band_proj.height > 0:
        same = a_with_opttype.join(
            b_in_band_proj,
            left_on=["tbk", "_size_a_key"],
            right_on=["tbk", "_size_bucket"],
            how="inner",
        )
        if same.height > 0:
            same = same.filter(pl.col("ridx_b") > pl.col("ridx"))
        a_adj = a_with_opttype.with_columns(
            (pl.col("tbk") + 1).alias("_tbk_next")
        )
        adj = a_adj.join(
            b_in_band_proj,
            left_on=["_tbk_next", "_size_a_key"],
            right_on=["tbk", "_size_bucket"],
            how="inner",
        )
        if adj.height > 0:
            adj = adj.filter(pl.col("ridx_b") > pl.col("ridx")).drop(
                "_tbk_next"
            )
        for f in (same, adj):
            if f.height > 0:
                frames.append(f.drop("_size_a_key"))

    if b_overflow_proj.height > 0:
        a_fallback = a_with_opttype.drop("_size_a_key")
        frames.extend(
            _cross_join_no_size_key(a_fallback, b_overflow_proj)
        )

    if not frames:
        return _empty_two_leg_pairs(with_keys=["option_type"])
    return pl.concat(frames, how="vertical_relaxed")


def _apply_two_leg_window_and_size(
    pairs: pl.DataFrame, *, window_seconds: int, size_tolerance: float
) -> pl.DataFrame:
    """Filter pairs by time-window, near-duplicate strikes, equal sizes.

    Adds ``_size_err`` column for downstream confidence scoring.
    """
    dt_sec = (
        pl.col("executed_at_b") - pl.col("executed_at")
    ).dt.total_microseconds().cast(pl.Float64) / 1_000_000.0

    strike_a = pl.col("strike")
    strike_b = pl.col("strike_b")
    larger_strike = pl.max_horizontal([strike_a.abs(), strike_b.abs()])
    strikes_differ = (
        (strike_a - strike_b).abs()
        > _NEAR_DUPLICATE_STRIKE_FRACTION * larger_strike
    )

    size_a = pl.col("size")
    size_b = pl.col("size_b")
    size_sum = size_a + size_b
    size_err_expr = (
        pl.when(size_sum > 0)
        .then((size_a - size_b).abs() / size_sum)
        .otherwise(pl.lit(float("inf")))
    )

    return (
        pairs.with_columns(size_err_expr.alias("_size_err"))
        .filter(
            (dt_sec >= 0)
            & (dt_sec <= float(window_seconds))
            & strikes_differ
            & (pl.col("_size_err") <= size_tolerance)
        )
    )


def _dir_opposite_expr() -> pl.Expr:
    side_a = pl.col("side")
    side_b = pl.col("side_b")
    return (side_a == "mid") | (side_b == "mid") | (side_a != side_b)


def _dir_same_expr() -> pl.Expr:
    side_a = pl.col("side")
    side_b = pl.col("side_b")
    return (side_a == "mid") | (side_b == "mid") | (side_a == side_b)


def _dir_expr_for(pattern: PatternSpec) -> pl.Expr:
    """Return the vectorized direction filter expression for a 2-leg pattern.

    Maps ``pattern.direction_rule`` ∈ {'opposite', 'same'} to the equivalent
    polars expression used by the matcher. 'mid' is compatible with either
    side (matches ``_dirs_compatible`` in ``multileg_patterns``).
    """
    if pattern.direction_rule == "opposite":
        return _dir_opposite_expr()
    if pattern.direction_rule == "same":
        return _dir_same_expr()
    raise ValueError(
        f"unsupported 2-leg direction_rule: {pattern.direction_rule!r}"
    )


def _score_two_leg(
    pairs: pl.DataFrame, *, pattern_name: str, size_tolerance: float
) -> pl.DataFrame:
    """Compute confidence and project to candidate schema."""
    if pairs.height == 0:
        return _empty_candidates_2leg()

    is_mid_a = pl.col("side") == "mid"
    is_mid_b = pl.col("side_b") == "mid"
    size_err = pl.col("_size_err")
    size_penalty = pl.when(size_tolerance > 0).then(
        pl.min_horizontal(
            [
                pl.lit(_SIZE_PENALTY_MAX),
                pl.lit(_SIZE_PENALTY_MAX) * size_err / pl.lit(size_tolerance),
            ]
        )
    ).otherwise(pl.lit(0.0))
    mid_penalty = (
        is_mid_a.cast(pl.Float64) + is_mid_b.cast(pl.Float64)
    ) * _MID_PENALTY
    raw_confidence = pl.lit(1.0) - size_penalty - mid_penalty
    confidence_expr = pl.max_horizontal(
        [pl.lit(0.0), pl.min_horizontal([pl.lit(1.0), raw_confidence])]
    )

    return pairs.select(
        [
            pl.lit(pattern_name).alias("pattern"),
            confidence_expr.alias("confidence"),
            pl.col("ridx").alias("ridx_a"),
            pl.col("ridx_b"),
            pl.col("sid").alias("sid_a"),
            pl.col("sid_b"),
        ]
    ).filter(pl.col("confidence") >= _MIN_ACCEPT_CONFIDENCE)


def _empty_two_leg_pairs(*, with_keys: list[str]) -> pl.DataFrame:
    """Schema for an intermediate pair frame."""
    base = {
        "ridx": pl.UInt32,
        "sid": pl.Utf8,
        "executed_at": pl.Datetime(time_zone="UTC"),
        "strike": pl.Float64,
        "size": pl.Float64,
        "side": pl.Utf8,
        "tbk": pl.Int64,
        "_is_anchor": pl.Boolean,
        "ridx_b": pl.UInt32,
        "sid_b": pl.Utf8,
        "executed_at_b": pl.Datetime(time_zone="UTC"),
        "strike_b": pl.Float64,
        "size_b": pl.Float64,
        "side_b": pl.Utf8,
        "_is_anchor_b": pl.Boolean,
    }
    for k in with_keys:
        base[k] = pl.Utf8
    return pl.DataFrame(schema=base)


def _empty_candidates_2leg() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "pattern": pl.Utf8,
            "confidence": pl.Float64,
            "ridx_a": pl.UInt32,
            "ridx_b": pl.UInt32,
            "sid_a": pl.Utf8,
            "sid_b": pl.Utf8,
        }
    )


# ── 3-leg butterfly (body-centric, bucketed) ──────────────────────────────


def _butterfly_from_batch(
    batch: pl.DataFrame,
    *,
    window_seconds: int,
    strike_tolerance: float,
    size_tolerance: float,
) -> pl.DataFrame:
    """Body-centric butterfly enumeration over one (expiry, opttype) batch.

    Bodies are anchored to ``_is_body`` rows; wings come from the full
    batch (bodies' bucket + 1 either side, via the batch iterator's
    ``all_buckets`` set).
    """
    if batch.height < 3:
        return _empty_candidates_3leg()

    bodies = batch.filter(pl.col("_is_body"))
    if bodies.height == 0:
        return _empty_candidates_3leg()

    # Body × wing self-join keyed on tbk (body's tbk or body's tbk ± 1).
    # Use three explicit equi-joins offset (-1, 0, +1).
    body_sel = bodies.select(
        pl.col("ridx").alias("ridx_body"),
        pl.col("sid").alias("sid_body"),
        pl.col("executed_at").alias("executed_at_body"),
        pl.col("strike").alias("strike_body"),
        pl.col("size").alias("size_body"),
        pl.col("side").alias("side_body"),
        pl.col("tbk").alias("tbk_body"),
    )
    wing_sel = batch.select(
        pl.col("ridx").alias("ridx_w"),
        pl.col("sid").alias("sid_w"),
        pl.col("executed_at").alias("executed_at_w"),
        pl.col("strike").alias("strike_w"),
        pl.col("size").alias("size_w"),
        pl.col("side").alias("side_w"),
        pl.col("tbk").alias("tbk_w"),
    )

    bw_frames: list[pl.DataFrame] = []
    for offset in (-1, 0, 1):
        body_with_offset = body_sel.with_columns(
            (pl.col("tbk_body") + offset).alias("_join_tbk")
        )
        joined = body_with_offset.join(
            wing_sel, left_on="_join_tbk", right_on="tbk_w", how="inner"
        )
        if joined.height > 0:
            bw_frames.append(joined.drop("_join_tbk"))

    if not bw_frames:
        return _empty_candidates_3leg()
    bw = pl.concat(bw_frames, how="vertical_relaxed")

    # Filter body-wing constraints: in-window, half-size, opposite dir,
    # distinct ridx.
    dt_w = (
        pl.col("executed_at_w") - pl.col("executed_at_body")
    ).dt.total_microseconds().cast(pl.Float64).abs() / 1_000_000.0
    half_body = pl.col("size_body") / 2.0
    wing_half_ok = (
        (half_body > 0)
        & ((pl.col("size_w") - half_body).abs() <= 2.0 * size_tolerance * half_body)
    )
    side_body = pl.col("side_body")
    side_w = pl.col("side_w")
    body_wing_opposite = (
        (side_body == "mid") | (side_w == "mid") | (side_body != side_w)
    )

    bw = bw.filter(
        (dt_w <= float(window_seconds))
        & wing_half_ok
        & body_wing_opposite
        & (pl.col("ridx_w") != pl.col("ridx_body"))
    )
    if bw.height == 0:
        return _empty_candidates_3leg()

    # Split into low (strike_w < strike_body) and high (strike_w > strike_body).
    lo = bw.filter(pl.col("strike_w") < pl.col("strike_body")).select(
        pl.col("ridx_body"),
        pl.col("ridx_w").alias("ridx_lo"),
        pl.col("sid_w").alias("sid_lo"),
        pl.col("strike_w").alias("strike_lo"),
        pl.col("size_w").alias("size_lo"),
        pl.col("side_w").alias("side_lo"),
    )
    hi = bw.filter(pl.col("strike_w") > pl.col("strike_body")).select(
        pl.col("ridx_body"),
        pl.col("ridx_w").alias("ridx_hi"),
        pl.col("sid_w").alias("sid_hi"),
        pl.col("strike_w").alias("strike_hi"),
        pl.col("size_w").alias("size_hi"),
        pl.col("side_w").alias("side_hi"),
    )
    if lo.height == 0 or hi.height == 0:
        return _empty_candidates_3leg()

    # Re-attach body context for sizing/scoring.
    body_ctx = bodies.select(
        pl.col("ridx").alias("ridx_body"),
        pl.col("sid").alias("sid_body"),
        pl.col("strike").alias("strike_body"),
        pl.col("size").alias("size_body"),
        pl.col("side").alias("side_body"),
    )
    lo_with_body = lo.join(body_ctx, on="ridx_body", how="inner")
    tri = lo_with_body.join(hi, on="ridx_body", how="inner")
    if tri.height == 0:
        return _empty_candidates_3leg()

    distinct = (
        (pl.col("ridx_lo") != pl.col("ridx_body"))
        & (pl.col("ridx_hi") != pl.col("ridx_body"))
        & (pl.col("ridx_lo") != pl.col("ridx_hi"))
    )

    gap_lo = pl.col("strike_body") - pl.col("strike_lo")
    gap_hi = pl.col("strike_hi") - pl.col("strike_body")
    avg_gap = (gap_lo + gap_hi) / 2.0
    strike_err = (
        pl.when(avg_gap > 0)
        .then((gap_lo - gap_hi).abs() / avg_gap)
        .otherwise(pl.lit(float("inf")))
    )
    equidistant = strike_err <= float(strike_tolerance)

    avg_wing = (pl.col("size_lo") + pl.col("size_hi")) / 2.0
    wing_err = (
        pl.when(avg_wing > 0)
        .then((pl.col("size_lo") - pl.col("size_hi")).abs() / avg_wing)
        .otherwise(pl.lit(float("inf")))
    )
    expected_body = 2.0 * avg_wing
    body_err = (
        pl.when(expected_body > 0)
        .then((pl.col("size_body") - expected_body).abs() / expected_body)
        .otherwise(pl.lit(float("inf")))
    )
    size_ok = (wing_err <= float(size_tolerance)) & (
        body_err <= float(size_tolerance)
    )

    wings_same_dir = (
        (pl.col("side_lo") == "mid")
        | (pl.col("side_hi") == "mid")
        | (pl.col("side_lo") == pl.col("side_hi"))
    )

    tri = tri.filter(distinct & equidistant & size_ok & wings_same_dir)
    if tri.height == 0:
        return _empty_candidates_3leg()

    strike_penalty = pl.when(float(strike_tolerance) > 0).then(
        pl.min_horizontal(
            [
                pl.lit(_STRIKE_PENALTY_MAX),
                pl.lit(_STRIKE_PENALTY_MAX)
                * strike_err
                / pl.lit(float(strike_tolerance)),
            ]
        )
    ).otherwise(pl.lit(0.0))

    butterfly_size_err = pl.max_horizontal([body_err, wing_err])
    size_penalty = pl.when(float(size_tolerance) > 0).then(
        pl.min_horizontal(
            [
                pl.lit(_SIZE_PENALTY_MAX),
                pl.lit(_SIZE_PENALTY_MAX)
                * butterfly_size_err
                / pl.lit(float(size_tolerance)),
            ]
        )
    ).otherwise(pl.lit(0.0))

    n_mids = (
        (pl.col("side_lo") == "mid").cast(pl.Float64)
        + (pl.col("side_body") == "mid").cast(pl.Float64)
        + (pl.col("side_hi") == "mid").cast(pl.Float64)
    )
    mid_penalty = n_mids * _MID_PENALTY

    raw_confidence = pl.lit(1.0) - strike_penalty - size_penalty - mid_penalty
    confidence_expr = pl.max_horizontal(
        [pl.lit(0.0), pl.min_horizontal([pl.lit(1.0), raw_confidence])]
    )

    cand = tri.select(
        [
            pl.lit("butterfly").alias("pattern"),
            confidence_expr.alias("confidence"),
            pl.col("ridx_lo"),
            pl.col("ridx_body"),
            pl.col("ridx_hi"),
            pl.col("sid_lo"),
            pl.col("sid_body"),
            pl.col("sid_hi"),
        ]
    ).filter(pl.col("confidence") >= _MIN_ACCEPT_CONFIDENCE)

    if cand.height == 0:
        return _empty_candidates_3leg()

    # Dedup triples that may surface from multiple offset joins.
    return cand.unique(
        subset=["ridx_lo", "ridx_body", "ridx_hi"], keep="first"
    )


def _empty_candidates_3leg() -> pl.DataFrame:
    return pl.DataFrame(
        schema={
            "pattern": pl.Utf8,
            "confidence": pl.Float64,
            "ridx_lo": pl.UInt32,
            "ridx_body": pl.UInt32,
            "ridx_hi": pl.UInt32,
            "sid_lo": pl.Utf8,
            "sid_body": pl.Utf8,
            "sid_hi": pl.Utf8,
        }
    )


# ── Greedy non-overlapping assignment ─────────────────────────────────────


def _prune_top_k_per_trade(
    two_leg: pl.DataFrame, three_leg: pl.DataFrame
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Drop candidates that are outside the top-K-by-confidence for ALL of
    their legs.

    Greedy always picks the highest-confidence candidate among those that
    haven't had any leg consumed. A candidate at rank K+1 for ALL of its
    legs (i.e. dominated by K alternatives on every leg) cannot win
    because those K alternatives are by definition higher-confidence and
    would each consume at least one of this candidate's legs before it
    is considered. Pruning these dominated candidates does not change the
    greedy outcome (assuming K is generous enough that no chain of
    alternatives leaves a rank-(K+1) candidate eligible — empirically
    K=8 is more than enough; the actual winners are almost always rank 1
    or 2).
    """
    if two_leg.height == 0 and three_leg.height == 0:
        return two_leg, three_leg

    # Build a long-format frame: one row per (trade_id, candidate-source)
    # so we can rank within trade and then keep only candidates whose
    # rank is ≤ K on ANY leg.
    two_long_parts: list[pl.DataFrame] = []
    if two_leg.height > 0:
        two_long_parts.append(
            two_leg.with_row_index("_cidx").select(
                pl.col("_cidx"),
                pl.col("ridx_a").alias("ridx"),
                pl.col("confidence"),
                pl.lit("two", dtype=pl.Utf8).alias("_kind"),
            )
        )
        two_long_parts.append(
            two_leg.with_row_index("_cidx").select(
                pl.col("_cidx"),
                pl.col("ridx_b").alias("ridx"),
                pl.col("confidence"),
                pl.lit("two", dtype=pl.Utf8).alias("_kind"),
            )
        )
    three_long_parts: list[pl.DataFrame] = []
    if three_leg.height > 0:
        base = three_leg.with_row_index("_cidx")
        for leg_col in ("ridx_lo", "ridx_body", "ridx_hi"):
            three_long_parts.append(
                base.select(
                    pl.col("_cidx"),
                    pl.col(leg_col).alias("ridx"),
                    pl.col("confidence"),
                    pl.lit("three", dtype=pl.Utf8).alias("_kind"),
                )
            )

    parts = two_long_parts + three_long_parts
    if not parts:
        return two_leg, three_leg

    long = pl.concat(parts, how="vertical_relaxed")
    # Per (kind, trade-id), rank by confidence descending; keep candidates
    # whose rank ≤ K on at least one leg.
    ranked = long.with_columns(
        pl.col("confidence")
        .rank(method="ordinal", descending=True)
        .over("ridx")
        .alias("_rank")
    )
    keep_two = (
        ranked.filter((pl.col("_kind") == "two") & (pl.col("_rank") <= _TOPK_PER_TRADE))
        .get_column("_cidx")
        .unique()
    )
    keep_three = (
        ranked.filter((pl.col("_kind") == "three") & (pl.col("_rank") <= _TOPK_PER_TRADE))
        .get_column("_cidx")
        .unique()
    )

    if two_leg.height > 0:
        two_leg = two_leg.with_row_index("_cidx").filter(
            pl.col("_cidx").is_in(keep_two.implode())
        ).drop("_cidx")
    if three_leg.height > 0:
        three_leg = three_leg.with_row_index("_cidx").filter(
            pl.col("_cidx").is_in(keep_three.implode())
        ).drop("_cidx")
    return two_leg, three_leg


def _greedy_assign(
    two_leg: pl.DataFrame,
    three_leg: pl.DataFrame,
    *,
    assignments: dict[str, _Assignment],
) -> None:
    """Assign candidates greedily by descending confidence.

    Tiebreak: candidates with the same confidence are taken in ascending
    order of their leg row-index tuple (leftmost first).

    Trade ids already assigned to a higher-confidence group are skipped.

    Implementation: vectorized to numpy arrays for the sort + walk. The
    inner walk MUST be sequential (each assignment changes the ``used``
    set), but pulling per-row data via numpy bulk-arrays is 50–100x
    faster than ``iter_rows(named=True)`` on millions of candidates.
    """
    # ── Materialize 2-leg candidates into bulk arrays ────────────────────
    if two_leg.height > 0:
        # Dedup identical (pattern, ridx_a, ridx_b) — bucketed joins can
        # re-emit the same pair when batches overlap.
        dedup = (
            two_leg.sort("confidence", descending=True)
            .unique(subset=["pattern", "ridx_a", "ridx_b"], keep="first")
        )
        # Per-row order on (-conf, min(ridx_a,ridx_b)). Within the dedup
        # frame we already have ridx_b > ridx_a from upstream construction
        # so min == ridx_a. Sort by (-conf, ridx_a, ridx_b) for tiebreak.
        dedup = dedup.sort(
            ["confidence", "ridx_a", "ridx_b"],
            descending=[True, False, False],
        )
        two_conf = dedup.get_column("confidence").to_numpy()
        two_ra = dedup.get_column("ridx_a").to_numpy()
        two_rb = dedup.get_column("ridx_b").to_numpy()
        two_pat = dedup.get_column("pattern").to_list()
        two_sa = dedup.get_column("sid_a").to_list()
        two_sb = dedup.get_column("sid_b").to_list()
    else:
        two_conf = np.array([], dtype=np.float64)
        two_ra = np.array([], dtype=np.int64)
        two_rb = np.array([], dtype=np.int64)
        two_pat = []
        two_sa = []
        two_sb = []

    # ── Materialize 3-leg candidates into bulk arrays ────────────────────
    if three_leg.height > 0:
        # Sort ridx triples ascending for each row, then sort the frame
        # by (-conf, min_ridx, mid_ridx, max_ridx) to match the prior
        # tiebreak semantics.
        triples = three_leg.with_columns(
            pl.min_horizontal(
                pl.col("ridx_lo"), pl.col("ridx_body"), pl.col("ridx_hi")
            ).alias("_rmin"),
            pl.max_horizontal(
                pl.col("ridx_lo"), pl.col("ridx_body"), pl.col("ridx_hi")
            ).alias("_rmax"),
        )
        # Middle = sum - min - max.
        triples = triples.with_columns(
            (
                pl.col("ridx_lo") + pl.col("ridx_body") + pl.col("ridx_hi")
                - pl.col("_rmin") - pl.col("_rmax")
            ).alias("_rmid")
        )
        triples = triples.sort(
            ["confidence", "_rmin", "_rmid", "_rmax"],
            descending=[True, False, False, False],
        )
        three_conf = triples.get_column("confidence").to_numpy()
        three_lo = triples.get_column("ridx_lo").to_numpy()
        three_bd = triples.get_column("ridx_body").to_numpy()
        three_hi = triples.get_column("ridx_hi").to_numpy()
        three_slo = triples.get_column("sid_lo").to_list()
        three_sbd = triples.get_column("sid_body").to_list()
        three_shi = triples.get_column("sid_hi").to_list()
    else:
        three_conf = np.array([], dtype=np.float64)
        three_lo = np.array([], dtype=np.int64)
        three_bd = np.array([], dtype=np.int64)
        three_hi = np.array([], dtype=np.int64)
        three_slo = []
        three_sbd = []
        three_shi = []

    if two_conf.size == 0 and three_conf.size == 0:
        return

    # ── Greedy walk via numpy boolean mask (faster than set lookups) ─────
    # Both streams are sorted by descending confidence with ridx tiebreak
    # inside each kind. We merge them in a single pass, respecting the
    # tiebreak (same-confidence: 2-leg wins, mirroring Python's tuple
    # comparison `(a, b) < (a, b, c)`). Replacing the Python ``set`` with
    # a numpy bool mask cuts the inner-loop cost from ~2.5μs (set lookup
    # + tuple unpack) to ~0.3μs per candidate.
    max_ridx = 0
    if two_ra.size > 0:
        max_ridx = max(max_ridx, int(two_ra.max()), int(two_rb.max()))
    if three_lo.size > 0:
        max_ridx = max(
            max_ridx,
            int(three_lo.max()),
            int(three_bd.max()),
            int(three_hi.max()),
        )
    used = np.zeros(max_ridx + 1, dtype=np.bool_)

    n2 = two_conf.size
    n3 = three_conf.size
    i2 = 0
    i3 = 0

    while i2 < n2 or i3 < n3:
        # Pick the next candidate: higher confidence wins; tie → 2-leg.
        take_two = i2 < n2 and (
            i3 >= n3 or two_conf[i2] >= three_conf[i3]
        )
        if take_two:
            conf = two_conf[i2]
            if conf < _MIN_ACCEPT_CONFIDENCE:
                break
            ra = two_ra[i2]
            rb = two_rb[i2]
            if used[ra] or used[rb]:
                i2 += 1
                continue
            used[ra] = True
            used[rb] = True
            sa = two_sa[i2]
            sb = two_sb[i2]
            pat = two_pat[i2]
            i2 += 1
            gid = _group_id_for((sa, sb))
            conf_f = float(conf)
            assignments[sa] = _Assignment(
                structure=pat, confidence=conf_f, group_id=gid
            )
            assignments[sb] = _Assignment(
                structure=pat, confidence=conf_f, group_id=gid
            )
        else:
            conf = three_conf[i3]
            if conf < _MIN_ACCEPT_CONFIDENCE:
                break
            lo = three_lo[i3]
            bd = three_bd[i3]
            hi = three_hi[i3]
            if used[lo] or used[bd] or used[hi]:
                i3 += 1
                continue
            used[lo] = True
            used[bd] = True
            used[hi] = True
            slo = three_slo[i3]
            sbd = three_sbd[i3]
            shi = three_shi[i3]
            i3 += 1
            gid = _group_id_for((slo, sbd, shi))
            conf_f = float(conf)
            assignments[slo] = _Assignment(
                structure="butterfly", confidence=conf_f, group_id=gid
            )
            assignments[sbd] = _Assignment(
                structure="butterfly", confidence=conf_f, group_id=gid
            )
            assignments[shi] = _Assignment(
                structure="butterfly", confidence=conf_f, group_id=gid
            )


# ── Group ID generation ──────────────────────────────────────────────────


def _group_id_for(trade_ids: tuple[str, ...]) -> str:
    """Stable hash of sorted trade ids — deterministic per group."""
    joined = "|".join(sorted(trade_ids))
    digest = hashlib.sha1(joined.encode("utf-8")).hexdigest()
    return f"grp-{digest[:16]}"


def _isolated_group_id(trade_id: str) -> str:
    digest = hashlib.sha1(trade_id.encode("utf-8")).hexdigest()
    return f"iso-{digest[:16]}"
