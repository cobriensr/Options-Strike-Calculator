"""Phase 1 of the futures contract-month repair: rebuild front-month ES/NQ bars.

From 2026-04-05 evening to 2026-06-15 14:11Z, `futures_bars` merged every
contract month of each root into one row per minute. This extract rebuilds the
true front-month (ESM6 / NQM6) 1-minute bars for ES and NQ and writes them to
files. It is read-only: the archive is local Parquet, Postgres is read in
read-only transactions, and nothing is written to any database. Phase 2 (a
TypeScript apply tool) turns the files into writes.

Spec: docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.
Rulings and evidence: .superpowers/sdd/futures-contract-mix-repair-2026-11-06/
(task-1-fix1.md, task-1-fix2.md, task-1-report.md).

Sources (UTC, bar-open minutes):

  * Archive span 2026-04-05 22:00 -> 04-17 20:59: the frozen Databento archive's
    `ohlcv_1m`, which carries the raw symbol. Each UTC day's front month is its
    volume leader among the root's outrights; any leader other than ESM6 / NQM6
    stops the run.
  * Tick span 2026-04-20 01:56 -> 06-15 14:11: Postgres `futures_trade_ticks`,
    whose `symbol` is only the root. The contract is recovered from price.

The cluster rule (tick span), per root and minute:

  1. Round every print to the 0.25 tick and sort the minute's prints by price.
  2. Split into clusters wherever two adjacent prices are more than G apart.
  3. Keep the lowest-priced cluster. ES and NQ carry is positive, so the front
     month is the cheapest contract.
  4. Build the bar from that cluster in time order: open = first print, close =
     last, high / low = max / min, volume = sum of sizes. Prints with the same
     timestamp keep the tick table's own `id` order (its insert order, which
     follows `ts`); on the archive the file row order plays that part.

Limit: a gap in the front month's own prints inside one minute, wider than G
and narrower than CARRY_HALF, with no prints in between, is split silently. The
upper part becomes the second cluster and is dropped, and nothing in this
extract flags the minute. A gap of CARRY_HALF or more is flagged only if the new
level persists: an upward gap on the next minute (a post-check step, or
front_absent when that minute stands alone), a downward gap on the same minute
(a step). A gap that reverts within the minute is not flagged at any width.

The time-order pass. Step 2 fails when the front month's own sweep inside one
minute is about as wide as the carry: the front's extreme and the back month's
nearest print sit within G and the clusters merge. The ticks showed this on ES
2026-04-21 20:09Z and NQ 06-09 16:38Z. The pass walks the kept prints in time
order and tracks the front level, the last accepted print.

  * A print more than CARRY_HALF (half the carry) above that level is dropped
    as back-month, but only if the front prints again near the level within
    WALK_CONFIRM_SECONDS. The look-ahead reaches into the next minute.
  * If the front never comes back, the jump is the front's own move and the
    print is kept. Without this rule the walk truncated the genuine +31 ES jump
    at the 08:30 ET data on 06-10 12:30Z, dropping 5,220 of 7,848 lots.
  * A print below the level is always kept. A wrong (too high) level is
    therefore replaced by the first front print, and can't outlive its minute.
  * The walk is seeded with the previous minute's close, when that minute is
    contiguous, is a bar and passed the post-check below. Otherwise it is
    seeded with the minute's lowest kept price.
  * It runs only on minutes where a drop is possible: kept range above
    CARRY_HALF, a high more than CARRY_HALF above the previous minute's low,
    or the first minute of a page. Everywhere else the walk provably keeps
    every print.
  * Over the whole tick span it changes exactly the two minutes above. Its
    output there equals the verifier's re-derivation from raw ticks, and W =
    1, 2 and 5 s give the same bars.
  * The 5-second confirmation assumes a back-month print always has a
    front-month print nearby. A genuine front spike that retraces within 5 s
    would be erased, and the post-check can't see it: walked.csv lists every
    minute where the walk dropped a print, with the bar before and after, so a
    reviewer can.

Back-month-only minutes. When the front month didn't print, the lowest cluster
is the next contract, about one carry above the front.

  * Each minute's kept level (the median of its kept prints) is compared with
    the median kept level of its neighbours: the nearest 5 minutes with prints
    on each side, within 30 minutes.
  * A minute at least CARRY_HALF above that reference is `front_absent`: it
    gets no bar and is listed in front_absent.csv, so Phase 2 can delete that
    row.
  * The reference uses only the neighbours' own stateless picks, so a single
    wrong minute can't latch the series onto another contract.
  * A run of 6 or more back-only minutes masks its own middle, though: its
    neighbours' median sits on the back month too. The post-check below
    catches such a run by its carry-sized step on entry and exit.
  * One shape is uncovered: a back-only stretch with no contiguous minute on
    either side, a short run between two outages. It has no entry or exit step
    for the post-check to list. The absent test finds no reference when no
    minute with prints lies within 30 minutes, and flags only the ends of a
    long run when some does.

The post-check (fails the run). Over each stretch of contiguous tick minutes
(front_absent minutes don't break a stretch), a bar is listed when either

  * high - max(open, close) > CARRY_HALF ("wick"), or
  * |open - the previous bar's close| > CARRY_HALF ("step").

Every listed minute must be in the reviewed allowlist (--allowlist: symbol, ts,
reason, with 5-second-slice evidence that it is a genuine front-month move).
Any other listed minute goes to unsplittable.csv and the run fails without
writing bars.

Carry (Root.carry) is measured on the tick span: in every multi-cluster minute,
the median price of the second cluster minus that of the first.

| Root | Minutes | Median | p1 | p95 | Weekly medians |
|---|---|---|---|---|---|
| ES | 18,605 | 60.75 | 53.75 | 63.75 | 55 in April to 64 by mid-June |
| NQ | 17,523 | 279.75 | 239.25 | 300 | 245 to 301 |

CARRY_HALF is half the median: ES 30.375, NQ 139.875.

G per root: the midpoint of the band of G where the gap rule alone (no walk)
keeps the ground-truth result (ts_recv clock, exact OHLC and volume within 1%)
flat, rounded to the tick. The band edges are the measured margins: the widest
step between adjacent prices of one contract inside a minute, and the narrowest
gap between contracts. With the walk, the ground truth scores 13,680 exact on
both roots from the lower edge up to at least ES 40 / NQ 130, because the walk
repairs the merges a wide G makes. That leaves no upper edge, so G stays at the
gap rule's own midpoint and only has to separate clean minutes.

  * ES 17.0. Flat from 8.25 to 26.0: 13,677 exact, 13,680 volume.
    - Lower edge: the widest ESM6 step inside a minute is 8.25 (archive
      `tbbo`). Below that the front splits and a minute loses volume.
    - Upper edge: the narrowest inter-contract gap in the ground truth is
      26.25 (04-07). The tick span's narrowest, outside the merged minute,
      is 20.75 (06-11).
    - Midpoint 17.125, rounded half-to-even to 17.0, so 8.25 < 17 < 20.75.
    - G = 3..4 scores 13,679 exact by cutting the three 04-07 overlap
      minutes apart, but the front itself starts to split there (volume
      13,679), so it is not a band.
  * NQ 65.0. Flat from 25.75 to 104.25: 13,680 exact, 13,680 volume.
    - Lower edge: the widest NQM6 step inside a minute is 25.75.
    - Upper edge: the narrowest inter-contract gap in the ground truth is
      104.5; on the tick span it is 87.75 (06-11 17:28Z).
    - Midpoint 65.0, so 25.75 < 65 < 87.75.

  Sweep of the gap rule alone, exact-OHLC minutes out of 13,680 (ts_recv;
  ts_event in brackets). With the walk added, ES scores 13,680 from G 8.25
  (the three 04-07 overlap minutes are repaired) and NQ from G 25.75.

      ES G   1-2: 13,678   3-4: 13,679   5-8: 13,677-678 (volume < 13,680)
             8.25-26.0: 13,677 (13,660)   27-29: 13,676   30: 13,674
             35: 13,667   40: 13,647
      NQ G   5-15: 13,678   20-25.5: 13,679   25.75-104.25: 13,680 (13,638)
             104.5-130: 13,679

Minutes and clocks.

  * A print belongs to the minute of its `ts`.
  * The tick table's `ts` is Databento's ts_event, the only clock the sidecar
    stored, so tick-span bars use ts_event.
  * Databento built the archive's `ohlcv_1m` by ts_recv instead. A print whose
    two clocks straddle a minute boundary lands one minute earlier here, which
    moves that minute's close and the next minute's open by about a tick. That
    happened to 43 ES and 48 NQ trades in 04-06..04-17.
  * Phase 2 writes a rebuilt bar wherever it differs from the row. `n_clusters`
    is informational: single-cluster minutes can still differ, when the tick
    table had no back-month prints but the row did.

Coverage.

  * `partial` is true when an open-market tick-stream silence of at least
    PARTIAL_GAP_SECONDS overlaps the minute. Phase 2 then keeps the row's
    volume.
  * A silence is two consecutive ticks that far apart, including the span's
    own edges: the stream started at 04-20 01:56:53 and stopped at 06-15
    14:11:30.
  * The part of a silence that falls in a scheduled closure doesn't count:
    the daily 16:00-17:00 CT halt, the weekend, and the 2026-05-25 Memorial
    Day halt from 12:00 CT.
  * So the 20:59 close and the 22:00 open are whole minutes, and an interior
    drop-out (often 13:00Z) is partial.
  * tickless_windows.csv lists every whole minute in the span with no ticks.

Usage (from the repo root; the archive lives in the main checkout only):

    ml/.venv/Scripts/python ml/src/futures_contract_repair.py \\
        --archive F:/dev/strike-calculator/ml/data/archive

A run builds into a staging folder next to --out-dir, named <out-dir>.staging
(ml/data/futures-contract-repair.staging/ by default), and replaces --out-dir
only after the gate and the post-check both pass. A failed run leaves --out-dir
as it was; its diagnostics and a failed manifest are in the staging folder, and
the run prints where. --ground-truth-only writes there too and never replaces
--out-dir. The staging folder's own earlier outputs are deleted when a run
starts.

Outputs (--out-dir, default ml/data/futures-contract-repair/, gitignored). On a
pass the run deletes the earlier outputs there, moves the new ones in and lands
`manifest.json` last. Files that aren't outputs stay. Phase 2 refuses a
directory whose manifest doesn't say "passed".

| File | Contents |
|---|---|
| `rebuilt_bars.parquet` | symbol, ts (UTC bar-open minute), open, high, low, close (float64, on the 0.25 tick), volume (int64), n_clusters (int64: 1 on the archive, +1 where the walk dropped prints), partial (bool), source (archive or ticks). Only minutes the source covers. |
| `ndjson/{ROOT}-{YYYY-MM-DD}.ndjson` | The same rows, one JSON object per line, UTC day files. |
| `per_day.csv` | Per root, UTC day and source: bars, front_absent, multi-cluster, walked and partial minutes, prints, the widest bar, the first and last minute, and G's margins. |
| `front_absent.csv` | symbol, ts of each tick minute where only a back month printed. |
| `post_check.csv` | Every minute the post-check listed, with its allowlist status. |
| `unsplittable.csv` | The listed minutes not on the allowlist. Empty when the run passes. |
| `walked.csv` | symbol, ts, dropped_prints, volume_before, volume_after, high_before, high_after: every minute where the walk dropped a print. Read it before accepting a run. |
| `suspect.csv` | Tick bars with a range above 0.7 x carry. |
| `tickless_windows.csv` | Tick-span windows with no ticks. |
| `ground_truth.csv` | The gate below, per root, day and archive clock. |
| `manifest.json` | The status, G and carry per root, spans, gate, counts, and the git commit. |

The ground-truth gate runs first.

  * It runs the full tick rule (clusters, walk, absent test) on the archive's
    TBBO trades for 04-06..04-17, with the symbol dropped so every month is
    merged as in the ticks. It compares the result with the archive's
    front-month bars.
  * It needs, per root, an exact open/high/low/close on at least 99.9% of
    minutes and volume within 1% on at least 99.9%. Below that the run stops
    and writes no bars.
  * The trades are bucketed by ts_recv, the archive bars' own clock, with ties
    in file order, so the gate tests the rule alone (team-lead ruling,
    2026-11-06). It scores 100% on both roots.
  * The ts_event rows are written next to it to record the clock effect. By
    ts_event the rule scores 99.876% (ES) and 99.693% (NQ).

DATABASE_URL comes from --env-file, else this checkout's .env.local, else the
main checkout's. It is never printed.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import time
import warnings
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# `anchor_backfill_extract` lives beside this file; -I doesn't put it on the path.
_SRC_DIR = str(Path(__file__).resolve().parent)
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

from anchor_backfill_extract import parse_env_file, resolve_env_file  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "ml" / "data" / "futures-contract-repair"


@dataclass(frozen=True)
class Root:
    symbol: str  # the root as futures_bars stores it
    front: str  # the front-month contract for the whole window
    gap: float  # G: a larger gap between adjacent prices splits contracts
    carry: float  # the next contract's premium, measured on the tick span
    tick: float = 0.25

    @property
    def carry_half(self) -> float:
        """CARRY_HALF: the walk's drop threshold, the absent and post-check limit."""
        return self.carry / 2


ROOTS: dict[str, Root] = {
    "ES": Root("ES", "ESM6", 17.0, 60.75),
    "NQ": Root("NQ", "NQM6", 65.0, 279.75),
}

# [start, end) in UTC; each end is one minute past the last bar-open minute.
ARCHIVE_SPAN = (
    pd.Timestamp("2026-04-05 22:00", tz="UTC"),
    pd.Timestamp("2026-04-17 21:00", tz="UTC"),
)
TICK_SPAN = (
    pd.Timestamp("2026-04-20 01:56", tz="UTC"),
    pd.Timestamp("2026-06-15 14:12", tz="UTC"),
)
GROUND_TRUTH_SPAN = (
    pd.Timestamp("2026-04-06 00:00", tz="UTC"),
    pd.Timestamp("2026-04-18 00:00", tz="UTC"),
)

GATE_RATE = 0.999
VOLUME_TOLERANCE = 0.01
NEIGHBOURS = 5  # per side
NEIGHBOUR_WINDOW_MINUTES = 30
WALK_CONFIRM_SECONDS = 5
PARTIAL_GAP_SECONDS = 20
SUSPECT_RANGE_SHARE = 0.7  # of the carry
# The archive clock the gate scores; the other one is written for the record.
GATE_CLOCK = "ts_recv"
ARCHIVE_CLOCKS = ("ts_recv", "ts_event")

# CME equity-index futures closures in the window, in exchange (Chicago) time:
# the daily 16:00-17:00 halt Monday to Thursday, the weekend from Friday 16:00
# to Sunday 17:00, and Memorial Day 2026-05-25 from 12:00 (the data has no
# ticks or bars 17:00-22:00Z that day).
_EXCHANGE_TZ = "America/Chicago"
_HOLIDAY_CLOSURES = (("2026-05-25 12:00", "2026-05-25 17:00"),)

OUTPUT_COLUMNS = (
    "symbol",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "n_clusters",
    "partial",
    "source",
)
MINUTE_COLUMNS = (
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "level",
    "clusters",
    "prints",
    "kept_gap",
    "split_gap",
)
MANIFEST = "manifest.json"
# Every file a passing run writes. The manifest comes first because a folder
# being cleaned must stop reading as passed before any other file goes.
OUTPUT_FILES = (
    MANIFEST,
    "rebuilt_bars.parquet",
    "per_day.csv",
    "front_absent.csv",
    "post_check.csv",
    "unsplittable.csv",
    "walked.csv",
    "suspect.csv",
    "tickless_windows.csv",
    "ground_truth.csv",
)
NDJSON_DIR = "ndjson"
# Outright month codes; spreads ("ESM6-ESU6") and options ("ESM6 C6475") don't match.
_OUTRIGHT = "^{root}[FGHJKMNQUVXZ][0-9]{{1,2}}$"
_EPOCH = pd.Timestamp("1970-01-01", tz="UTC")
_MINUTE = pd.Timedelta(minutes=1)


class FrontMonthMismatch(ValueError):
    """The archive's volume leader for a day isn't the expected front month."""


# ── Pure helpers ────────────────────────────────────────────────────────────


def round_to_tick(values: pd.Series, tick: float) -> pd.Series:
    """Prices on the instrument tick (Phase 2 compares them with NUMERIC(12,4))."""
    return (values / tick).round() * tick


def _minute_numbers(stamps) -> np.ndarray:
    return ((pd.Series(stamps) - _EPOCH) // _MINUTE).to_numpy()


def build_minutes(ticks: pd.DataFrame, cfg: Root) -> tuple[pd.DataFrame, pd.DataFrame]:
    """The lowest cluster's bar per minute, and the prints the walk needs.

    `ticks` has ts (tz-aware UTC), seq (the tie-break order), price and size,
    for one root. The first result has MINUTE_COLUMNS; `level` is the median
    kept price, `clusters` the minute's cluster count and `prints` every print
    in it. `kept_gap` (the widest step between adjacent kept prices) and
    `split_gap` (the step to the next cluster) show how far each side sat from G.

    The second result holds kept prints (minute, ts, seq, price, size) for the
    minutes the time-order pass may change, and the first WALK_CONFIRM_SECONDS
    of the minute after each, plus the frame's first minute (its predecessor
    lives in another frame).
    """
    empty = pd.DataFrame({c: [] for c in ("minute", "ts", "seq", "price", "size")})
    if ticks.empty:
        return pd.DataFrame({c: [] for c in MINUTE_COLUMNS}), empty
    t = pd.DataFrame(
        {
            "minute": ticks["ts"].dt.floor("min"),
            "ts": ticks["ts"],
            "seq": ticks["seq"],
            "price": round_to_tick(ticks["price"].astype("float64"), cfg.tick),
            "size": ticks["size"].astype("int64"),
        }
    ).sort_values(["minute", "price"], kind="stable", ignore_index=True)

    minute = t["minute"].dt.tz_localize(None).to_numpy()
    price = t["price"].to_numpy()
    starts = np.r_[True, minute[1:] != minute[:-1]]
    # The step up from the next-lower print in the same minute (NaN for the lowest).
    step = np.where(starts, np.nan, np.r_[np.nan, np.diff(price)])
    new_cluster = starts | (step > cfg.gap)
    cluster = np.cumsum(new_cluster)
    # 0 for the lowest cluster of each minute, 1 for the next, ...
    t["rank"] = cluster - np.maximum.accumulate(np.where(starts, cluster, 0))
    t["step"] = step

    per_minute = t.groupby("minute", sort=True)
    kept = t[t["rank"] == 0].sort_values(["ts", "seq"], kind="stable")
    out = kept.groupby("minute", sort=True).agg(
        open=("price", "first"),
        high=("price", "max"),
        low=("price", "min"),
        close=("price", "last"),
        volume=("size", "sum"),
        level=("price", "median"),
        kept_gap=("step", "max"),
    )
    out["clusters"] = per_minute["rank"].max() + 1
    out["prints"] = per_minute.size()
    # The step that opened the second cluster: G's margin on the split side.
    second = t[(t["rank"] == 1) & new_cluster]
    out["split_gap"] = second.set_index("minute")["step"]
    minutes = out.rename_axis("ts").reset_index()[list(MINUTE_COLUMNS)]

    walk = _walk_minutes(minutes, cfg)
    after = walk + 1
    numbers = _minute_numbers(kept["minute"])
    into = (kept["ts"] - kept["minute"]) < pd.Timedelta(seconds=WALK_CONFIRM_SECONDS)
    keep = np.isin(numbers, walk) | (np.isin(numbers, after) & into.to_numpy())
    columns = ["minute", "ts", "seq", "price", "size"]
    return minutes, kept.loc[keep, columns].reset_index(drop=True)


def _walk_minutes(minutes: pd.DataFrame, cfg: Root) -> np.ndarray:
    """Minute numbers where the time-order pass can drop a print.

    Elsewhere every kept print lies within CARRY_HALF of whatever level the walk
    can hold (the seed is a print of the previous minute or the minute's own
    lowest print), so the walk keeps them all.
    """
    numbers = _minute_numbers(minutes["ts"])
    high = minutes["high"].to_numpy(dtype="float64")
    low = minutes["low"].to_numpy(dtype="float64")
    wide = high - low > cfg.carry_half
    contiguous = np.r_[False, np.diff(numbers) == 1]
    previous_low = np.r_[np.nan, low[:-1]]
    above = contiguous & (high > previous_low + cfg.carry_half)
    first = np.zeros(len(numbers), dtype=bool)
    first[:1] = True
    return numbers[wide | above | first]


def walk_front(
    prints: pd.DataFrame, lookahead: pd.DataFrame, seed: float, cfg: Root
) -> np.ndarray:
    """Which of the minute's kept prints (time order) are the front month.

    A print more than CARRY_HALF above the front level (the last accepted print,
    seeded with `seed`) is dropped when a later print within WALK_CONFIRM_SECONDS
    (this minute's, then the next minute's `lookahead`) comes back to within
    CARRY_HALF of that level. Otherwise it is the front's own jump and is kept.
    """
    price = prints["price"].to_numpy(dtype="float64")
    # Both arrays are in time order, the look-ahead after the minute's own prints.
    ahead_price = np.r_[price, lookahead["price"].to_numpy(dtype="float64")]
    ahead_ns = np.r_[_nanoseconds(prints["ts"]), _nanoseconds(lookahead["ts"])]
    window = pd.Timedelta(seconds=WALK_CONFIRM_SECONDS).value
    level = seed
    keep = np.ones(len(price), dtype=bool)
    for i, p in enumerate(price):
        if p <= level + cfg.carry_half:
            level = p
            continue
        end = np.searchsorted(ahead_ns, ahead_ns[i] + window, side="right")
        if (ahead_price[i + 1 : end] <= level + cfg.carry_half).any():
            keep[i] = False  # the front printed again near its level: back month
        else:
            level = p  # the front itself moved
    return keep


def _nanoseconds(stamps: pd.Series) -> np.ndarray:
    return (
        stamps.dt.tz_convert("UTC")
        .dt.tz_localize(None)
        .astype("datetime64[ns]")
        .astype("int64")
        .to_numpy()
    )


def time_order_pass(
    minutes: pd.DataFrame,
    walk_prints: pd.DataFrame,
    cfg: Root,
    allowlisted: frozenset[pd.Timestamp] = frozenset(),
) -> pd.DataFrame:
    """Walk the minutes that need it, then run the post-check on every bar.

    Adds `dropped` (prints the walk removed), `high_before` and `volume_before`
    (the bar before the walk), `wick`, `step` and `passed` (the bar passed the
    post-check, or its minute is in `allowlisted`). A minute's walk is seeded
    from the previous minute's close only when that minute is contiguous, is a
    bar and passed. See the module docstring.
    """
    out = minutes.sort_values("ts", ignore_index=True)
    n = len(out)
    numbers = _minute_numbers(out["ts"])
    prices = ("open", "high", "low", "close")
    cols = {c: out[c].to_numpy(dtype="float64").copy() for c in prices}
    volume = out["volume"].to_numpy(dtype="int64").copy()
    high_before = cols["high"].copy()
    volume_before = volume.copy()
    clusters = out["clusters"].to_numpy(dtype="int64").copy()
    absent = out["front_absent"].to_numpy(dtype=bool)
    dropped = np.zeros(n, dtype="int64")
    wick = np.zeros(n, dtype=bool)
    step = np.zeros(n, dtype=bool)
    passed = np.zeros(n, dtype=bool)

    groups = {}
    if len(walk_prints):
        keys = _minute_numbers(walk_prints["minute"])
        for number, group in walk_prints.groupby(keys):
            groups[int(number)] = group.sort_values(["ts", "seq"], kind="stable")
    stamps = pd.Series(list(allowlisted), dtype="datetime64[ns, UTC]")
    allowed = set(_minute_numbers(stamps).tolist())

    stretch_close = np.nan  # the last bar's close in this contiguous stretch
    previous = (-2, False, np.nan)  # (minute number, a passed bar?, close)
    for i in range(n):
        number = int(numbers[i])
        if i == 0 or number - int(numbers[i - 1]) != 1:
            stretch_close = np.nan
        if absent[i]:
            previous = (number, False, np.nan)
            continue
        prints = groups.get(number)
        if prints is not None and len(prints):
            seeded = previous[0] == number - 1 and previous[1]
            seed = previous[2] if seeded else float(prints["price"].min())
            ahead = groups.get(number + 1, prints.iloc[:0])
            keep = walk_front(prints, ahead, seed, cfg)
            if not keep.all():
                front = prints[keep]
                cols["open"][i] = front["price"].iloc[0]
                cols["high"][i] = front["price"].max()
                cols["low"][i] = front["price"].min()
                cols["close"][i] = front["price"].iloc[-1]
                volume[i] = int(front["size"].sum())
                dropped[i] = int((~keep).sum())
                clusters[i] += 1
        high, open_, close = cols["high"][i], cols["open"][i], cols["close"][i]
        wick[i] = high - max(open_, close) > cfg.carry_half
        step[i] = (
            not np.isnan(stretch_close) and abs(open_ - stretch_close) > cfg.carry_half
        )
        passed[i] = not (wick[i] or step[i]) or number in allowed
        stretch_close = close
        previous = (number, bool(passed[i]), close)

    return out.assign(
        **cols,
        volume=volume,
        clusters=clusters,
        dropped=dropped,
        high_before=high_before,
        volume_before=volume_before,
        wick=wick,
        step=step,
        passed=passed,
    )


def mark_front_absent(minutes: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """Add `ref` (the neighbours' median level) and `front_absent`.

    A minute is front_absent when its level sits at least CARRY_HALF above
    `ref`: the only contract that printed was a back month. See the module
    docstring for the 6-minute limit and the post-check backstop.
    """
    out = minutes.sort_values("ts", ignore_index=True)
    n = len(out)
    if n == 0:
        return out.assign(ref=pd.Series(dtype="float64"), front_absent=False)
    level = out["level"].to_numpy(dtype="float64")
    minute_no = _minute_numbers(out["ts"])
    rows = np.arange(n)
    columns = []
    for distance in range(1, NEIGHBOURS + 1):
        for other in (rows - distance, rows + distance):
            inside = (other >= 0) & (other < n)
            other = np.clip(other, 0, n - 1)
            near = inside & (
                np.abs(minute_no[other] - minute_no) <= NEIGHBOUR_WINDOW_MINUTES
            )
            columns.append(np.where(near, level[other], np.nan))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN rows: no ref
        ref = np.nanmedian(np.column_stack(columns), axis=1)
    return out.assign(ref=ref, front_absent=(level - ref) >= cfg.carry_half)


def rebuild_from_ticks(
    ticks: pd.DataFrame,
    cfg: Root,
    allowlisted: frozenset[pd.Timestamp] = frozenset(),
) -> pd.DataFrame:
    """The whole tick rule for one root's prints: clusters, absent test, walk."""
    minutes, walk_prints = build_minutes(ticks, cfg)
    return time_order_pass(
        mark_front_absent(minutes, cfg), walk_prints, cfg, allowlisted
    )


def closures_between(
    lo: pd.Timestamp, hi: pd.Timestamp
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """The scheduled closures overlapping [lo, hi), in UTC."""
    first = lo.tz_convert(_EXCHANGE_TZ).normalize() - pd.Timedelta(days=3)
    last = hi.tz_convert(_EXCHANGE_TZ).normalize() + pd.Timedelta(days=1)
    spans = []
    for day in pd.date_range(first.tz_localize(None), last.tz_localize(None), freq="D"):
        if day.weekday() <= 3:  # Monday..Thursday: the daily halt
            spans.append((day + pd.Timedelta(hours=16), day + pd.Timedelta(hours=17)))
        elif day.weekday() == 4:  # Friday 16:00 to Sunday 17:00
            spans.append(
                (day + pd.Timedelta(hours=16), day + pd.Timedelta(days=2, hours=17))
            )
    spans += [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in _HOLIDAY_CLOSURES]
    merged: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    for a, b in sorted(spans):
        start = a.tz_localize(_EXCHANGE_TZ).tz_convert("UTC")
        end = b.tz_localize(_EXCHANGE_TZ).tz_convert("UTC")
        if merged and start <= merged[-1][1]:  # overlapping (holiday + halt)
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [(a, b) for a, b in merged if a < hi and b > lo]


def open_pieces(
    start: pd.Timestamp, end: pd.Timestamp
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """[start, end) minus the scheduled closures: the open-market parts."""
    pieces = [(start, end)]
    for a, b in closures_between(start, end):
        cut = []
        for s, e in pieces:
            if b <= s or a >= e:
                cut.append((s, e))
                continue
            if s < a:
                cut.append((s, a))
            if b < e:
                cut.append((b, e))
        pieces = cut
    return pieces


def tick_gaps(stamps: pd.Series) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Consecutive ticks (time order) at least PARTIAL_GAP_SECONDS apart."""
    if len(stamps) < 2:
        return []
    s = stamps.sort_values(ignore_index=True)
    apart = s.diff() >= pd.Timedelta(seconds=PARTIAL_GAP_SECONDS)
    idx = np.flatnonzero(apart.to_numpy())
    return [(s.iloc[i - 1], s.iloc[i]) for i in idx]


def stream_gaps(
    pages: list[tuple[pd.Timestamp, pd.Timestamp, list]],
    span: tuple[pd.Timestamp, pd.Timestamp],
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """All silences of the stream over `span` from per-page (first, last, gaps).

    Adds the span's own edges (start to the first tick, last tick to the end)
    and the joins between pages. Pages with no ticks are passed as None.
    """
    gaps: list[tuple[pd.Timestamp, pd.Timestamp]] = []
    cursor = span[0]  # the last tick so far, or the span start
    for page in pages:
        if page is None:
            continue
        first, last, inner = page
        gaps.append((cursor, first))
        gaps.extend(inner)
        cursor = last
    gaps.append((cursor, span[1]))
    limit = pd.Timedelta(seconds=PARTIAL_GAP_SECONDS)
    return [(a, b) for a, b in gaps if b - a >= limit]


def mark_partial(
    minutes: pd.DataFrame, gaps: list[tuple[pd.Timestamp, pd.Timestamp]]
) -> pd.DataFrame:
    """Add `partial`: an open-market stream silence of >= 20 s overlaps the minute."""
    limit = pd.Timedelta(seconds=PARTIAL_GAP_SECONDS)
    touched: set[int] = set()
    for a, b in gaps:
        for s, e in open_pieces(a, b):
            if e - s >= limit:
                first = int(_minute_numbers([s])[0])
                last = int(_minute_numbers([e - pd.Timedelta(microseconds=1)])[0])
                touched.update(range(first, last + 1))
    numbers = _minute_numbers(minutes["ts"])
    return minutes.assign(partial=np.isin(numbers, list(touched)))


def tickless_windows(
    gaps: list[tuple[pd.Timestamp, pd.Timestamp]],
    span: tuple[pd.Timestamp, pd.Timestamp],
    symbol: str,
) -> pd.DataFrame:
    """Every run of whole minutes in `span` with no ticks, from the silences.

    open_minutes counts the window's minutes outside the scheduled closures.
    """
    rows = []
    for a, b in gaps:
        start = a if a == span[0] else a.floor("min") + _MINUTE
        stop = b if b == span[1] else b.floor("min")  # exclusive
        if stop <= start:
            continue
        minutes = int((stop - start) / _MINUTE)
        closed = sum(
            (min(e, stop) - max(s, start) for s, e in closures_between(start, stop)),
            pd.Timedelta(0),
        )
        open_minutes = int(round((stop - start - closed) / _MINUTE))
        rows.append((symbol, start, stop - _MINUTE, minutes, open_minutes))
    return pd.DataFrame(
        rows,
        columns=["symbol", "first_minute", "last_minute", "minutes", "open_minutes"],
    )


def bars_output(minutes: pd.DataFrame, symbol: str, source: str) -> pd.DataFrame:
    """The rebuilt_bars.parquet rows: every minute that has a front-month bar."""
    kept = minutes[~minutes["front_absent"].astype(bool)]
    out = pd.DataFrame(
        {
            "symbol": symbol,
            "ts": kept["ts"].astype("datetime64[us, UTC]"),
            "open": kept["open"].astype("float64"),
            "high": kept["high"].astype("float64"),
            "low": kept["low"].astype("float64"),
            "close": kept["close"].astype("float64"),
            "volume": kept["volume"].astype("int64"),
            "n_clusters": kept["clusters"].astype("int64"),
            "partial": kept["partial"].astype(bool),
            "source": source,
        }
    )
    return out[list(OUTPUT_COLUMNS)].reset_index(drop=True)


def ndjson_lines(bars: pd.DataFrame) -> dict[str, list[str]]:
    """One JSON line per bar, grouped by file name ({ROOT}-{YYYY-MM-DD}.ndjson)."""
    files: dict[str, list[str]] = {}
    for row in bars.sort_values(["symbol", "ts"]).itertuples(index=False):
        record = {
            "symbol": row.symbol,
            "ts": row.ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "open": float(row.open),
            "high": float(row.high),
            "low": float(row.low),
            "close": float(row.close),
            "volume": int(row.volume),
            "source": row.source,
            "n_clusters": int(row.n_clusters),
            "partial": bool(row.partial),
        }
        name = f"{row.symbol}-{row.ts:%Y-%m-%d}.ndjson"
        files.setdefault(name, []).append(json.dumps(record, separators=(",", ":")))
    return files


def post_check_rows(
    minutes: pd.DataFrame, symbol: str, allowlist: pd.DataFrame
) -> pd.DataFrame:
    """The bars the post-check listed, with their allowlist reason (or none)."""
    listed = minutes[(minutes["wick"] | minutes["step"]) & ~minutes["front_absent"]]
    rules = np.where(
        listed["wick"] & listed["step"],
        "wick+step",
        np.where(listed["wick"], "wick", "step"),
    )
    out = pd.DataFrame(
        {
            "symbol": symbol,
            "ts": listed["ts"].astype("datetime64[us, UTC]"),
            "rule": rules,
            "open": listed["open"],
            "high": listed["high"],
            "low": listed["low"],
            "close": listed["close"],
        }
    )
    reasons = allowlist[allowlist["symbol"] == symbol].set_index("ts")["reason"]
    out["allowlisted"] = out["ts"].isin(reasons.index)
    out["reason"] = out["ts"].map(reasons)
    return out.reset_index(drop=True)


def walked_rows(minutes: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """Every minute where the walk dropped prints, with the bar before and after.

    The post-check can't see a genuine front spike the walk erased, so this list
    is where a reviewer looks. Needs time_order_pass's output.
    """
    walked = minutes[minutes["dropped"] > 0]
    return pd.DataFrame(
        {
            "symbol": symbol,
            "ts": walked["ts"].astype("datetime64[us, UTC]"),
            "dropped_prints": walked["dropped"],
            "volume_before": walked["volume_before"],
            "volume_after": walked["volume"],
            "high_before": walked["high_before"],
            "high_after": walked["high"],
        }
    ).reset_index(drop=True)


def suspect_rows(minutes: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """Tick bars whose range exceeds SUSPECT_RANGE_SHARE of the carry."""
    bars = minutes[~minutes["front_absent"]]
    wide = bars[bars["high"] - bars["low"] > SUSPECT_RANGE_SHARE * cfg.carry]
    return pd.DataFrame(
        {
            "symbol": cfg.symbol,
            "ts": wide["ts"].astype("datetime64[us, UTC]"),
            "range": wide["high"] - wide["low"],
            "n_clusters": wide["clusters"],
            "dropped": wide["dropped"],
            "partial": wide["partial"],
        }
    ).reset_index(drop=True)


def per_day_summary(minutes: pd.DataFrame, symbol: str, source: str) -> pd.DataFrame:
    """Per UTC day: bars, front_absent, multi-cluster, walked and partial minutes,
    prints.

    Archive minutes are one contract each and carry no print counts, so their
    prints column stays empty.
    """
    absent = minutes["front_absent"].astype(bool)
    frame = pd.DataFrame(
        {
            "day": minutes["ts"].dt.strftime("%Y-%m-%d"),
            "bars": (~absent).astype("int64"),
            "front_absent": absent.astype("int64"),
            "multi_cluster": (minutes["clusters"] > 1).astype("int64"),
            "walked": (minutes["dropped"] > 0).astype("int64"),
            "partial": (minutes["partial"].astype(bool) & ~absent).astype("int64"),
            "prints": minutes["prints"].astype("Int64"),
            "max_range": (minutes["high"] - minutes["low"]).where(~absent),
            "ts": minutes["ts"],
        }
    )
    grouped = frame.groupby("day", sort=True)
    out = pd.DataFrame(
        {
            "bars": grouped["bars"].sum(),
            "front_absent": grouped["front_absent"].sum(),
            "multi_cluster": grouped["multi_cluster"].sum(),
            "walked": grouped["walked"].sum(),
            "partial": grouped["partial"].sum(),
            "prints": grouped["prints"].sum(min_count=1),
            "max_range": grouped["max_range"].max(),
            "first_minute": grouped["ts"].min(),
            "last_minute": grouped["ts"].max(),
        }
    ).join(_gap_stats(minutes), how="left")
    out = out.rename_axis("day").reset_index()
    out.insert(0, "root", symbol)
    out.insert(2, "source", source)
    return out


def _gap_stats(minutes: pd.DataFrame) -> pd.DataFrame:
    """Per UTC day over the bars built: the widest kept step, the narrowest split."""
    kept = minutes[~minutes["front_absent"].astype(bool)]
    day = kept["ts"].dt.strftime("%Y-%m-%d").rename("day")
    return pd.DataFrame(
        {
            "max_kept_gap": kept["kept_gap"].groupby(day).max(),
            "min_split_gap": kept["split_gap"].groupby(day).min(),
        }
    )


def _outright(symbols: pd.Series, cfg: Root) -> pd.Series:
    return symbols.str.fullmatch(_OUTRIGHT.format(root=cfg.symbol)).astype(bool)


def pick_front_by_day(bars: pd.DataFrame, cfg: Root) -> dict[str, str]:
    """Each UTC day's volume leader among the root's outrights.

    Raises FrontMonthMismatch when a leader isn't `cfg.front`, or when there are
    no outright bars at all: either means the archive isn't what the spec read.
    """
    outright = bars[_outright(bars["symbol"], cfg)]
    if outright.empty:
        raise FrontMonthMismatch(f"no {cfg.symbol} outright bars in the archive span")
    volume = outright.groupby(
        [outright["ts"].dt.strftime("%Y-%m-%d").rename("day"), "symbol"]
    )["volume"].sum()
    leaders = volume.groupby(level="day").idxmax().map(lambda key: key[1]).to_dict()
    wrong = {day: sym for day, sym in leaders.items() if sym != cfg.front}
    if wrong:
        listed = "; ".join(
            f"{day}: the {cfg.symbol} volume leader is {sym}, not the expected "
            f"{cfg.front}"
            for day, sym in sorted(wrong.items())
        )
        raise FrontMonthMismatch(listed)
    return leaders


def archive_front_bars(bars: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """The leader's bars (ts, OHLC on the tick, volume), checked per day."""
    pick_front_by_day(bars, cfg)
    front = bars[bars["symbol"] == cfg.front].sort_values("ts", ignore_index=True)
    out = pd.DataFrame({"ts": front["ts"]})
    for col in ("open", "high", "low", "close"):
        out[col] = round_to_tick(front[col].astype("float64"), cfg.tick)
    out["volume"] = front["volume"].astype("int64")
    return out


def archive_minutes(front: pd.DataFrame) -> pd.DataFrame:
    """Archive bars in the minutes shape: one contract each, no print counts,
    whole minutes (Databento built them from its full feed), never walked."""
    return front.assign(
        level=np.nan,
        clusters=1,
        prints=pd.array([pd.NA] * len(front), dtype="Int64"),
        kept_gap=np.nan,
        split_gap=np.nan,
        ref=np.nan,
        front_absent=False,
        dropped=0,
        wick=False,
        step=False,
        passed=True,
        partial=False,
    )


def compare_with_archive(
    rebuilt: pd.DataFrame, archive: pd.DataFrame, root: str
) -> pd.DataFrame:
    """Per UTC day, rebuilt bars vs the archive's front-month bars.

    `minutes` is the union of both sides' minutes, so a missing or extra bar
    counts against the match rates. front_absent minutes are not bars.
    """
    cols = ["ts", "open", "high", "low", "close", "volume"]
    bars = rebuilt.loc[~rebuilt["front_absent"].astype(bool), cols]
    bars = bars.assign(ts=bars["ts"].astype("datetime64[us, UTC]"))
    archive = archive[cols].assign(ts=archive["ts"].astype("datetime64[us, UTC]"))
    merged = bars.merge(
        archive,
        on="ts",
        how="outer",
        suffixes=("_r", "_a"),
        indicator=True,
        validate="1:1",
    )
    both = merged["_merge"] == "both"
    exact = both.copy()
    for col in ("open", "high", "low", "close"):
        exact &= merged[f"{col}_r"] == merged[f"{col}_a"]
    within = both & (
        (merged["volume_r"] - merged["volume_a"]).abs()
        <= VOLUME_TOLERANCE * merged["volume_a"]
    )
    frame = pd.DataFrame(
        {
            "day": merged["ts"].dt.strftime("%Y-%m-%d"),
            "minutes": 1,
            "exact_ohlc": exact.astype("int64"),
            "volume_within_1pct": within.astype("int64"),
            "rebuilt_only": (merged["_merge"] == "left_only").astype("int64"),
            "archive_only": (merged["_merge"] == "right_only").astype("int64"),
        }
    )
    out = frame.groupby("day", sort=True).sum()
    extras = pd.DataFrame(
        {
            "day": rebuilt["ts"].dt.strftime("%Y-%m-%d"),
            "front_absent": rebuilt["front_absent"].astype("int64"),
            "multi_cluster": (rebuilt["clusters"] > 1).astype("int64"),
        }
    )
    out = out.join(extras.groupby("day").sum(), how="left").fillna(0)
    out = out.astype("int64").join(_gap_stats(rebuilt), how="left").reset_index()
    out.insert(0, "root", root)
    return out


def gate_result(gt: pd.DataFrame) -> dict[str, dict]:
    """Per root: the match rates over all its minutes, and whether it passed."""
    result = {}
    for root, rows in gt.groupby("root", sort=True):
        minutes = int(rows["minutes"].sum())
        exact = int(rows["exact_ohlc"].sum())
        volume = int(rows["volume_within_1pct"].sum())
        # A root with no minutes rates 0 and fails.
        exact_rate = exact / minutes if minutes else 0.0
        volume_rate = volume / minutes if minutes else 0.0
        result[root] = {
            "minutes": minutes,
            "exact_ohlc": exact,
            "volume_within_1pct": volume,
            "exact_rate": exact_rate,
            "volume_rate": volume_rate,
            "passed": exact_rate >= GATE_RATE and volume_rate >= GATE_RATE,
        }
    return result


def tick_pages(
    start: pd.Timestamp, end: pd.Timestamp
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """[start, end) split into UTC days, the unit the tick reads page by."""
    pages = []
    lo = start
    while lo < end:
        hi = min(lo.floor("D") + pd.Timedelta(days=1), end)
        pages.append((lo, hi))
        lo = hi
    return pages


# ── Archive (local Parquet via DuckDB) ──────────────────────────────────────


def _duckdb():
    import duckdb

    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    return con


def read_archive_bars(
    archive: Path, cfg: Root, span: tuple[pd.Timestamp, pd.Timestamp]
) -> pd.DataFrame:
    """Every `ohlcv_1m` row for the root's symbols in [span) (ts, symbol, OHLCV)."""
    path = (archive / "ohlcv_1m" / "year=2026" / "part.parquet").as_posix()
    con = _duckdb()
    try:
        frame = con.execute(
            """SELECT ts_event AS ts, symbol, open, high, low, close, volume
               FROM read_parquet(?)
               WHERE ts_event >= ? AND ts_event < ? AND starts_with(symbol, ?)""",
            [path, span[0].to_pydatetime(), span[1].to_pydatetime(), cfg.symbol],
        ).df()
    finally:
        con.close()
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)
    return frame


def read_archive_trades(
    archive: Path,
    cfg: Root,
    span: tuple[pd.Timestamp, pd.Timestamp],
    clock: str = GATE_CLOCK,
) -> pd.DataFrame:
    """The root's outright TBBO trades in [span), symbol dropped (ts, seq, price, size).

    `clock` picks the timestamp that places a trade in its minute: ts_recv, as
    Databento built the archive bars, or ts_event, as the ticks carry it.
    seq is the file row number: the file is in order of both clocks, and
    DuckDB's microsecond timestamps tie where Databento's nanoseconds didn't.
    """
    if clock not in ARCHIVE_CLOCKS:
        raise ValueError(f"unknown clock {clock!r}; want one of {ARCHIVE_CLOCKS}")
    path = (archive / "tbbo" / "year=2026" / "part.parquet").as_posix()
    con = _duckdb()
    try:
        # `clock` is one of two column names, checked above.
        frame = con.execute(
            f"""SELECT {clock} AS ts, file_row_number AS seq, price, size
               FROM read_parquet(?, file_row_number = true)
               WHERE {clock} >= ? AND {clock} < ? AND regexp_full_match(symbol, ?)""",
            [
                path,
                span[0].to_pydatetime(),
                span[1].to_pydatetime(),
                _OUTRIGHT.format(root=cfg.symbol),
            ],
        ).df()
    finally:
        con.close()
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)
    return frame


# ── Postgres (read-only) ────────────────────────────────────────────────────

# 5 minutes per statement: a full ES day is up to ~2M rows over COPY.
_STATEMENT_TIMEOUT_MS = 300_000
_PAGE_ATTEMPTS = 3
# COPY takes no bind parameters, so the SELECT is mogrified first.
_SELECT_TICKS = (
    "SELECT id, (extract(epoch FROM ts) * 1000000)::bigint, price::float8, size "
    "FROM futures_trade_ticks WHERE symbol = %s AND ts >= %s AND ts < %s "
    "ORDER BY ts, id"
)


def connect_readonly(env_file: Path):
    """A connection holding one open read-only transaction with a statement timeout.

    Use it for one read, then close it (which rolls back). Neon's pooler runs
    in transaction mode, so a session-level SET may land on another server
    connection, and it refuses statement_timeout as a startup option.
    Everything therefore lives in one transaction: the session default
    (startup option), psycopg2's BEGIN READ ONLY, SET LOCAL statement_timeout,
    and a check that the transaction really is read-only. Never prints the URL.
    """
    import psycopg2

    url = parse_env_file(env_file).get("DATABASE_URL")
    if not url:
        raise RuntimeError(f"no DATABASE_URL in {env_file}")
    con = psycopg2.connect(url, options="-c default_transaction_read_only=on")
    con.set_session(readonly=True, autocommit=False)
    with con.cursor() as cur:
        cur.execute("SET default_transaction_read_only = on")
        cur.execute(f"SET LOCAL statement_timeout = {_STATEMENT_TIMEOUT_MS}")
        cur.execute("SHOW transaction_read_only")
        if cur.fetchone()[0] != "on":
            con.close()
            raise RuntimeError("the transaction is not read-only; not reading")
    return con


def _copy_out(env_file: Path, select: str, params: tuple) -> io.StringIO:
    """One read-only SELECT as CSV, retried on a dropped connection.

    A statement timeout (QueryCanceled) would recur on a retry, so it isn't
    retried.
    """
    import psycopg2
    import psycopg2.errors

    for attempt in range(1, _PAGE_ATTEMPTS + 1):
        try:
            con = connect_readonly(env_file)
            try:
                buf = io.StringIO()
                with con.cursor() as cur:
                    query = cur.mogrify(select, params).decode()
                    cur.copy_expert(f"COPY ({query}) TO STDOUT WITH (FORMAT csv)", buf)
            finally:
                con.close()
            buf.seek(0)
            return buf
        except psycopg2.errors.QueryCanceled:
            raise
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            if attempt == _PAGE_ATTEMPTS:
                raise
            time.sleep(2 * attempt)
    raise AssertionError("unreachable")


def fetch_tick_page(
    env_file: Path, cfg: Root, lo: pd.Timestamp, hi: pd.Timestamp
) -> pd.DataFrame:
    """The root's ticks in [lo, hi) as (ts, seq, price, size); seq is the row id."""
    buf = _copy_out(
        env_file, _SELECT_TICKS, (cfg.symbol, lo.to_pydatetime(), hi.to_pydatetime())
    )
    frame = pd.read_csv(
        buf,
        names=["seq", "us", "price", "size"],
        dtype={"seq": "int64", "us": "int64", "price": "float64", "size": "int64"},
    )
    frame.insert(0, "ts", pd.to_datetime(frame.pop("us"), unit="us", utc=True))
    return frame


# ── Run ─────────────────────────────────────────────────────────────────────


def _log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def run_ground_truth(archive: Path) -> pd.DataFrame:
    """The per-day table for both roots under both archive clocks.

    The gate scores the GATE_CLOCK rows; the others record the clock effect.
    """
    tables = []
    for cfg in ROOTS.values():
        front = archive_front_bars(
            read_archive_bars(archive, cfg, GROUND_TRUTH_SPAN), cfg
        )
        for clock in ARCHIVE_CLOCKS:
            trades = read_archive_trades(archive, cfg, GROUND_TRUTH_SPAN, clock)
            rebuilt = rebuild_from_ticks(trades, cfg)
            table = compare_with_archive(rebuilt, front, cfg.symbol)
            table.insert(2, "clock", clock)
            tables.append(table)
            _log(
                f"ground truth {cfg.symbol} by {clock}: {len(trades):,} trades, "
                f"{len(front):,} bars, {int((rebuilt['dropped'] > 0).sum())} walked"
            )
    return pd.concat(tables, ignore_index=True)


def run_archive_span(archive: Path, cfg: Root) -> pd.DataFrame:
    front = archive_front_bars(read_archive_bars(archive, cfg, ARCHIVE_SPAN), cfg)
    return archive_minutes(front)


def run_tick_span(
    env_file: Path, cfg: Root, workers: int, allowlisted: frozenset[pd.Timestamp]
) -> tuple[pd.DataFrame, list[tuple[pd.Timestamp, pd.Timestamp]]]:
    """Every tick page of the root, built per page, then walked and checked as
    one series. Returns the minutes and the stream's silences."""
    pages = tick_pages(*TICK_SPAN)

    def one(page: tuple[pd.Timestamp, pd.Timestamp]):
        started = time.monotonic()
        try:
            ticks = fetch_tick_page(env_file, cfg, *page)
        except Exception as err:
            raise RuntimeError(f"{cfg.symbol} page {page[0]:%Y-%m-%d} failed") from err
        minutes, walk_prints = build_minutes(ticks, cfg)
        _log(
            f"{cfg.symbol} {page[0]:%Y-%m-%d}: {len(ticks):,} ticks, "
            f"{len(minutes):,} minutes, {time.monotonic() - started:.1f}s"
        )
        if ticks.empty:
            return minutes, walk_prints, None
        stamps = ticks["ts"]
        return minutes, walk_prints, (stamps.min(), stamps.max(), tick_gaps(stamps))

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(one, pages))
    parts = [minutes for minutes, _, _ in results if not minutes.empty]
    if not parts:
        raise RuntimeError(f"no {cfg.symbol} ticks in the tick span")
    walk_prints = pd.concat([w for _, w, _ in results if len(w)], ignore_index=True)
    minutes = mark_front_absent(pd.concat(parts, ignore_index=True), cfg)
    minutes = time_order_pass(minutes, walk_prints, cfg, allowlisted)
    gaps = stream_gaps([info for _, _, info in results], TICK_SPAN)
    return mark_partial(minutes, gaps), gaps


def load_allowlist(path: Path | None) -> pd.DataFrame:
    """The reviewed post-check allowlist (symbol, ts, reason); none means empty."""
    if path is None or not path.is_file():
        return pd.DataFrame(
            {
                "symbol": [],
                "ts": pd.Series([], dtype="datetime64[us, UTC]"),
                "reason": [],
            }
        )
    frame = pd.read_csv(path, dtype={"symbol": str, "reason": str})
    missing = {"symbol", "ts", "reason"} - set(frame.columns)
    if missing:
        raise ValueError(f"{path} lacks columns {sorted(missing)}")
    if frame["reason"].isna().any():
        raise ValueError(f"{path}: every allowlisted minute needs a reason")
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True).astype("datetime64[us, UTC]")
    return frame[["symbol", "ts", "reason"]]


def clean_outputs(out_dir: Path) -> None:
    """Delete every earlier output in `out_dir`, and nothing else."""
    for name in OUTPUT_FILES:
        (out_dir / name).unlink(missing_ok=True)
    ndjson = out_dir / NDJSON_DIR
    if ndjson.is_dir():
        for file in ndjson.glob("*.ndjson"):
            file.unlink()


def staging_dir(out_dir: Path) -> Path:
    """Where a run builds its output: next to `out_dir`, on the same drive."""
    return out_dir.with_name(out_dir.name + ".staging")


def promote_staged(staging: Path, out_dir: Path) -> None:
    """Replace the earlier output in `out_dir` with the staged one.

    Called only after the gate and the post-check passed. The manifest goes
    first and lands last, so a folder caught half-way never reads as passed.
    Other files in `out_dir` stay. A file that can't be moved (open in another
    program) stops the run with the complete new output still in `staging`.
    """
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        clean_outputs(out_dir)
        (out_dir / NDJSON_DIR).mkdir(exist_ok=True)
        for name in OUTPUT_FILES:
            if name != MANIFEST:
                os.replace(staging / name, out_dir / name)
        for file in sorted((staging / NDJSON_DIR).glob("*.ndjson")):
            os.replace(file, out_dir / NDJSON_DIR / file.name)
        os.replace(staging / MANIFEST, out_dir / MANIFEST)
    except OSError as err:
        raise RuntimeError(
            f"could not replace {out_dir} ({err}); the complete new output is in "
            f"{staging}"
        ) from err
    # Anything else left in the staging folder is not ours; leave it.
    for leftover in (staging / NDJSON_DIR, staging):
        with contextlib.suppress(OSError):
            leftover.rmdir()


def git_state() -> dict:
    """The commit the extract ran from, and whether its module was edited."""

    def git(*args: str) -> str:
        try:
            return subprocess.run(
                ["git", *args],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return ""

    module = Path(__file__).resolve().relative_to(REPO_ROOT).as_posix()
    return {
        "head": git("rev-parse", "HEAD") or "unknown",
        "module_edited": bool(git("status", "--porcelain", "--", module)),
    }


def _write_atomic(path: Path, write: Callable[[Path], None]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    write(tmp)
    os.replace(tmp, path)


def _write_csv(path: Path, frame: pd.DataFrame) -> None:
    _write_atomic(path, lambda p: frame.to_csv(p, index=False, lineterminator="\n"))


def _write_text(path: Path, text: str) -> None:
    def write(p: Path) -> None:
        with open(p, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

    _write_atomic(path, write)


def _manifest(status: str, reason: str, started: float, **parts) -> dict:
    return {
        "status": status,
        "reason": reason,
        "git": git_state(),
        "finished_utc": pd.Timestamp.now(tz="UTC").isoformat(),
        "run_seconds": round(time.monotonic() - started, 1),
        "spans": {
            "archive": [str(t) for t in ARCHIVE_SPAN],
            "ticks": [str(t) for t in TICK_SPAN],
            "ground_truth": [str(t) for t in GROUND_TRUTH_SPAN],
        },
        "roots": {
            r.symbol: {
                "front": r.front,
                "gap": r.gap,
                "carry": r.carry,
                "carry_half": r.carry_half,
            }
            for r in ROOTS.values()
        },
        "walk_confirm_seconds": WALK_CONFIRM_SECONDS,
        "partial_gap_seconds": PARTIAL_GAP_SECONDS,
        **parts,
    }


def _write_manifest(folder: Path, manifest: dict) -> None:
    _write_text(folder / MANIFEST, json.dumps(manifest, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--archive", type=Path, required=True, help="the archive dir (ml/data/archive)"
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="the output folder; built in <out-dir>.staging, replaced on a pass",
    )
    parser.add_argument("--env-file", help="path to .env.local")
    parser.add_argument("--workers", type=int, default=3, help="parallel tick pages")
    parser.add_argument(
        "--allowlist", type=Path, help="reviewed post-check allowlist CSV"
    )
    parser.add_argument(
        "--ground-truth-only",
        action="store_true",
        help="stop after the gate; its files go to the staging folder only",
    )
    args = parser.parse_args(argv)
    started = time.monotonic()

    env_file = None
    if not args.ground_truth_only:
        env_file = resolve_env_file(args.env_file)
        if env_file is None:
            print("no .env.local found; pass --env-file", file=sys.stderr)
            return 2
    allowlist = load_allowlist(args.allowlist)
    out_dir = args.out_dir.resolve()
    staging = staging_dir(out_dir)
    staging.mkdir(parents=True, exist_ok=True)
    clean_outputs(staging)

    gt = run_ground_truth(args.archive)
    _write_csv(staging / "ground_truth.csv", gt)
    gates = {}
    for clock in ARCHIVE_CLOCKS:
        scored = "gate" if clock == GATE_CLOCK else "record"
        gates[clock] = gate_result(gt[gt["clock"] == clock])
        for root, res in gates[clock].items():
            verdict = "PASS" if res["passed"] else "FAIL"
            _log(
                f"{scored} {root} by {clock}: {res['exact_ohlc']:,}/"
                f"{res['minutes']:,} exact OHLC ({res['exact_rate']:.4%}), "
                f"{res['volume_within_1pct']:,} volume within 1% "
                f"({res['volume_rate']:.4%}) -> {verdict}"
            )
    gate = gates[GATE_CLOCK]
    if not all(res["passed"] for res in gate.values()) or set(gate) != set(ROOTS):
        _write_manifest(
            staging, _manifest("failed", "ground-truth gate", started, gate=gates)
        )
        print(
            f"ground-truth gate failed; no bars written; {out_dir} untouched, "
            f"diagnostics in {staging}",
            file=sys.stderr,
        )
        return 1
    if args.ground_truth_only:
        _write_manifest(staging, _manifest("gate-only", "", started, gate=gates))
        _log(f"gate only: results in {staging}; {out_dir} untouched")
        return 0

    bars, summaries, absent, checks, suspects, windows = [], [], [], [], [], []
    walks = []
    partial_counts = {}
    for cfg in ROOTS.values():
        listed = allowlist[allowlist["symbol"] == cfg.symbol]["ts"]
        archived = run_archive_span(args.archive, cfg)
        ticked, gaps = run_tick_span(env_file, cfg, args.workers, frozenset(listed))
        for minutes, source in ((archived, "archive"), (ticked, "ticks")):
            bars.append(bars_output(minutes, cfg.symbol, source))
            summaries.append(per_day_summary(minutes, cfg.symbol, source))
        flagged = ticked[ticked["front_absent"]]
        absent.append(pd.DataFrame({"symbol": cfg.symbol, "ts": flagged["ts"]}))
        checks.append(post_check_rows(ticked, cfg.symbol, allowlist))
        walks.append(walked_rows(ticked, cfg.symbol))
        suspects.append(suspect_rows(ticked, cfg))
        windows.append(tickless_windows(gaps, TICK_SPAN, cfg.symbol))
        built = ticked[~ticked["front_absent"]]
        partial_counts[cfg.symbol] = int(built["partial"].sum())
        _log(
            f"{cfg.symbol}: {len(archived):,} archive bars, {len(built):,} tick bars "
            f"({partial_counts[cfg.symbol]:,} partial, "
            f"{int((built['dropped'] > 0).sum())} walked), "
            f"{len(flagged):,} front_absent"
        )

    check = pd.concat(checks, ignore_index=True)
    unsplittable = check[~check["allowlisted"]]
    _write_csv(staging / "post_check.csv", check)
    _write_csv(staging / "unsplittable.csv", unsplittable)
    _write_csv(staging / "walked.csv", pd.concat(walks, ignore_index=True))
    post = {
        "listed": len(check),
        "allowlisted": int(check["allowlisted"].sum()),
        "unsplittable": len(unsplittable),
    }
    if len(unsplittable):
        _write_manifest(
            staging,
            _manifest("failed", "post-check", started, gate=gates, post_check=post),
        )
        print(
            f"post-check failed: {len(unsplittable)} minute(s) in unsplittable.csv; "
            f"no bars written; {out_dir} untouched, diagnostics in {staging}",
            file=sys.stderr,
        )
        return 1

    out = pd.concat(bars, ignore_index=True).sort_values(
        ["symbol", "ts"], ignore_index=True
    )
    if out.duplicated(["symbol", "ts"]).any():
        raise RuntimeError("duplicate (symbol, ts) rows in the rebuild")
    _write_atomic(
        staging / "rebuilt_bars.parquet",
        lambda p: out.to_parquet(p, index=False),
    )
    files = ndjson_lines(out)
    (staging / NDJSON_DIR).mkdir(exist_ok=True)
    for name, lines in files.items():
        _write_text(staging / NDJSON_DIR / name, "\n".join(lines) + "\n")
    _write_csv(staging / "per_day.csv", pd.concat(summaries, ignore_index=True))
    _write_csv(staging / "front_absent.csv", pd.concat(absent, ignore_index=True))
    _write_csv(staging / "suspect.csv", pd.concat(suspects, ignore_index=True))
    _write_csv(staging / "tickless_windows.csv", pd.concat(windows, ignore_index=True))
    rows = out.groupby(["symbol", "source"]).size()
    _write_manifest(
        staging,
        _manifest(
            "passed",
            "",
            started,
            gate=gates,
            post_check=post,
            rows={f"{s}/{src}": int(n) for (s, src), n in rows.items()},
            partial=partial_counts,
            front_absent=int(sum(len(a) for a in absent)),
            ndjson_files=len(files),
        ),
    )
    promote_staged(staging, out_dir)
    _log(
        f"wrote {len(out):,} bars and {len(files)} NDJSON files to {out_dir} in "
        f"{time.monotonic() - started:.0f}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
