"""PAC engine orchestrator.

Single entry point that combines upstream `smartmoneyconcepts` primitives
with our CHoCH+ and OB z-score extensions. Designed to run in two modes:

1. **Batch mode** (`batch_state(df)`): Given a full DataFrame of bars
   (typically from `archive_loader.load_bars()`), return an enriched
   DataFrame with structure events inlined column-by-column. Used by
   the backtest harness in E1.3.

2. **Streaming mode** (`current_state(bars_up_to_now)`): Given bars up
   to timestamp T, return the currently active structure state as a
   dict: most recent HH/LL, active OBs, active FVGs, current session
   VWAP. Used by E1.6's live auto-tagging — the manual-trade journal
   UI calls this when the user taps [Long] or [Short] so the setup tag
   auto-populates.

The streaming method is designed to run in <50ms on a typical RTH bar
window (~390 1-minute bars). All upstream `smc` primitives are
vectorized pandas ops so the bottleneck is the 2-pass iteration over
swings inside our `tag_choch_plus` helper — O(n_swings²) but with
n_swings typically < 50 per session, that's microseconds.

Both modes take the same params so results are deterministic: the same
DataFrame passed to either method produces the same structure events
at the same timestamps.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

# Suppress upstream credit print BEFORE importing
os.environ.setdefault("SMC_CREDIT", "0")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from smartmoneyconcepts import smc  # noqa: E402

from pac.causal_smc import causal_order_blocks  # noqa: E402
from pac.features import add_all_features  # noqa: E402
from pac.order_blocks import (  # noqa: E402
    enrich_ob_with_z,
    session_vwap_and_std,
)
from pac.structure import tag_choch_plus  # noqa: E402


@dataclass(frozen=True)
class PACParams:
    """Parameters that affect detection. Kept minimal for v1 — the sweep
    in E1.4 will expand this surface when exploring the parameter space.
    """

    swing_length: int = 5
    choch_plus_lookback: int = 6
    ob_mitigation: str = "close"  # "close" | "wick" | "average"
    close_mitigation: bool = True  # kept for forward compat with smc.ob()


@dataclass
class CurrentState:
    """Snapshot of active PAC structure at a given timestamp.

    Returned by `PACEngine.current_state()` and consumed by the manual-
    trade journal UI to auto-populate the entry form.
    """

    ts: pd.Timestamp
    close: float
    session_vwap: float
    session_std: float

    # Most recent confirmed swing
    last_swing_kind: str | None = None  # "HH" | "LL"
    last_swing_level: float | None = None
    last_swing_bar_idx: int | None = None

    # Most recent structure events (may be None if none yet this session)
    last_bos_direction: str | None = None  # "up" | "dn"
    last_bos_bar_idx: int | None = None
    last_choch_direction: str | None = None  # "up" | "dn"
    last_choch_plus: bool = False
    last_choch_bar_idx: int | None = None

    # Currently active (unmitigated) OBs and FVGs
    active_obs: list[dict[str, Any]] = field(default_factory=list)
    active_fvgs: list[dict[str, Any]] = field(default_factory=list)


class PACEngine:
    """Runs upstream smc primitives + PAC extensions over an OHLC DataFrame."""

    def __init__(self, params: PACParams | None = None) -> None:
        self.params = params or PACParams()

    def batch_state(self, df: pd.DataFrame) -> pd.DataFrame:
        """Run all PAC primitives over `df` and return an enriched DataFrame.

        Expected input columns: ts_event, open, high, low, close, volume.
        Extra columns (like `symbol`) are preserved.

        Output adds columns (NaN on bars where the event didn't fire):
            HighLow, Level_shl               : from smc.swing_highs_lows
            BOS, CHOCH, Level_bc              : from smc.bos_choch
            CHOCHPlus                         : our extension
            OB, OB_Top, OB_Bottom, OBVolume,
            OB_Percentage, OB_MitigatedIndex  : from smc.ob
            OB_mid, OB_width,
            OB_z_top, OB_z_bot, OB_z_mid      : our extension
            FVG, FVG_Top, FVG_Bottom,
            FVG_MitigatedIndex                : from smc.fvg
            session_vwap, session_std         : per-bar session stats
        """
        if len(df) == 0:
            return df.copy()

        # smc primitives — take OHLC DataFrame, return event DataFrames.
        # `ob` uses our causal reimplementation: detection matches smc.ob
        # exactly but the retroactive reset step is removed so OBs that
        # existed live aren't erased in hindsight. See
        # docs/superpowers/specs/pac-residual-causality-fix-2026-04-24.md.
        shl = smc.swing_highs_lows(df, swing_length=self.params.swing_length)
        bc = smc.bos_choch(df, shl, close_break=self.params.close_mitigation)
        ob = causal_order_blocks(
            df,
            shl,
            close_mitigation=self.params.close_mitigation,
        )
        fvg = smc.fvg(df)

        # Our extensions
        choch_plus = tag_choch_plus(
            shl, bc, lookback_swings=self.params.choch_plus_lookback
        )
        stats = session_vwap_and_std(df)
        ob_enriched = enrich_ob_with_z(df, ob, stats=stats)

        # Merge into a single frame. Using .values to avoid any index
        # alignment surprises — all these outputs are positionally aligned
        # to `df` by construction.
        out = df.copy().reset_index(drop=True)
        out["HighLow"] = shl["HighLow"].values
        out["Level_shl"] = shl["Level"].values
        out["BOS"] = bc["BOS"].values
        out["CHOCH"] = bc["CHOCH"].values
        out["Level_bc"] = bc["Level"].values
        out["CHOCHPlus"] = choch_plus.values
        out["OB"] = ob_enriched["OB"].values
        out["OB_Top"] = ob_enriched["Top"].values
        out["OB_Bottom"] = ob_enriched["Bottom"].values
        out["OBVolume"] = ob_enriched["OBVolume"].values
        out["OB_Percentage"] = ob_enriched["Percentage"].values
        out["OB_MitigatedIndex"] = ob_enriched["MitigatedIndex"].values
        out["OB_mid"] = ob_enriched["OB_mid"].values
        out["OB_width"] = ob_enriched["OB_width"].values
        out["OB_z_top"] = ob_enriched["OB_z_top"].values
        out["OB_z_bot"] = ob_enriched["OB_z_bot"].values
        out["OB_z_mid"] = ob_enriched["OB_z_mid"].values
        out["FVG"] = fvg["FVG"].values
        out["FVG_Top"] = fvg["Top"].values
        out["FVG_Bottom"] = fvg["Bottom"].values
        out["FVG_MitigatedIndex"] = fvg["MitigatedIndex"].values
        out["session_vwap"] = stats["session_vwap"].values
        out["session_std"] = stats["session_std"].values

        # ── CAUSALITY FIXES ──
        #
        # 2026-04-21 (first pass): smc.swing_highs_lows uses `.shift(-swing_length)`
        # internally to check if a bar is the extreme over its centered window,
        # peeking `swing_length` bars into the future. A swing at bar T is only
        # confirmable at bar T + swing_length. We shifted every structure-detection
        # column forward by swing_length.
        #
        # 2026-04-23 (second pass): BOS/CHOCH need more than a uniform shift.
        # smc.bos_choch layers two additional lookahead sources on top of
        # swing_highs_lows:
        #
        #   * Labeling peek: bos_choch labels BOS at `last_positions[-2]` —
        #     the 3rd-most-recent swing in the current 4-swing pattern. A
        #     label at original position P0 is only placeable when swings
        #     P1, P2, P3 (the three swings after P0) are all observed AND
        #     P3 is itself confirmed. That means BOS[P0] becomes knowable
        #     at bar max(P3 + swing_length) — where P3 varies per event
        #     because swings are spaced irregularly. A uniform shift can't
        #     capture this without leaking when swings are wider than the
        #     shift or over-lagging when swings are packed.
        #
        #   * Broken-filter peek: bos_choch drops any BOS/CHOCH event
        #     whose level was never broken later in the series (smc.py
        #     lines 335-360). Events appear in the output because of a
        #     future break. We need to hide them until that break occurs.
        #
        # The correct fix is per-event: for each surviving BOS/CHOCH at
        # pre-shift position P0, compute knowable_at = max(P3+swing_length,
        # broken[P0]), then place the event at that position in the output.
        # Events whose knowable_at >= len(df) disappear entirely (they were
        # only confirmed by data beyond our frame).
        #
        # smc.ob's detection is streaming/causal (np.searchsorted for
        # last_top_index < current_close_index), so it only inherits the
        # swing_length lookahead. Its MitigatedIndex column stores a future
        # bar index but downstream consumers (pac_backtest/loop.py) read it
        # as `mit <= current_bar` which is naturally causal.
        #
        # Known residual: smc.ob has a *reset* step (lines 427-439) that
        # zeroes out an OB when a future high re-crosses its top. This
        # causes under-counting (live trader would have seen OBs that the
        # post-hoc output erases) rather than over-counting. Documented as
        # a follow-up; deferred until we measure its impact on sweep numbers.
        #
        # smc.fvg uses `.shift(-1)` so FVGs need 1-bar confirmation.
        lag_swing = self.params.swing_length

        # Columns driven only by swing_highs_lows (plus smc.ob's streaming
        # detection, which we established is causal beyond the swing input).
        swing_only_cols = (
            "HighLow", "Level_shl",
            "OB", "OB_Top", "OB_Bottom", "OBVolume",
            "OB_Percentage", "OB_MitigatedIndex",
            "OB_mid", "OB_width",
            "OB_z_top", "OB_z_bot", "OB_z_mid",
        )
        for col in swing_only_cols:
            out[col] = out[col].shift(lag_swing)

        # Fail loud if upstream smc.bos_choch stops emitting BrokenIndex —
        # the BOS/CHOCH causality fix is load-bearing on this column.
        assert "BrokenIndex" in bc.columns, (
            "smc.bos_choch no longer returns BrokenIndex — PAC causality "
            "fix is broken. Upstream library change required attention."
        )

        # Per-event relocation: compute each BOS/CHOCH's knowable_at bar
        # and place the event's value there rather than at a uniform shift
        # offset. Events with knowable_at >= N (confirmed only by data
        # beyond our frame) are dropped. This single transform handles
        # both the labeling peek AND the broken-filter peek — once an
        # event lands at knowable_at[P0], by definition the live trader
        # had all the info to see it.
        out = _relocate_bos_events_causally(
            out=out,
            shl=shl,
            bc=bc,
            swing_length=lag_swing,
        )

        # FVG has a 1-bar lookahead, not swing_length.
        for col in ("FVG", "FVG_Top", "FVG_Bottom", "FVG_MitigatedIndex"):
            out[col] = out[col].shift(1)

        # E1.4d feature additions: session bucket, ATR/ADX, VWAP z, OB strength,
        # event-day flags. These are computed from the shifted structure cols
        # so derived features (ob_pct_atr, ob_volume_z_50) are also causal.
        out = add_all_features(out)
        return out

    def current_state(self, bars_up_to_now: pd.DataFrame) -> CurrentState:
        """Streaming-mode entry point. Returns current active structure.

        `bars_up_to_now` is typically the most recent N bars (e.g., the
        full session plus a small warmup). The engine runs batch detection
        over it and distills the results into a CurrentState snapshot
        keyed at the last bar.

        Target latency: <50ms for ~400 bars (1 RTH session). In practice
        upstream smc primitives + our extensions run in single-digit ms
        on that size; the bulk of the budget is a safety margin.
        """
        if len(bars_up_to_now) == 0:
            raise ValueError("bars_up_to_now is empty; cannot produce state")

        enriched = self.batch_state(bars_up_to_now)
        last = enriched.iloc[-1]

        # Most recent non-null HighLow swing (scan backwards)
        last_swing_kind = None
        last_swing_level = None
        last_swing_idx = None
        hl_col = enriched["HighLow"]
        lv_col = enriched["Level_shl"]
        for i in range(len(enriched) - 1, -1, -1):
            val = hl_col.iloc[i]
            if pd.notna(val) and val != 0:
                last_swing_kind = "HH" if val == 1 else "LL"
                last_swing_level = float(lv_col.iloc[i])
                last_swing_idx = i
                break

        # Most recent BOS
        last_bos_dir = None
        last_bos_idx = None
        for i in range(len(enriched) - 1, -1, -1):
            val = enriched["BOS"].iloc[i]
            if pd.notna(val) and val != 0:
                last_bos_dir = "up" if val == 1 else "dn"
                last_bos_idx = i
                break

        # Most recent CHoCH (and its +/- tag)
        last_choch_dir = None
        last_choch_plus = False
        last_choch_idx = None
        for i in range(len(enriched) - 1, -1, -1):
            val = enriched["CHOCH"].iloc[i]
            if pd.notna(val) and val != 0:
                last_choch_dir = "up" if val == 1 else "dn"
                last_choch_plus = bool(enriched["CHOCHPlus"].iloc[i] != 0)
                last_choch_idx = i
                break

        # Active (unmitigated) OBs: OB non-null AND MitigatedIndex
        # is either NaN or > last bar index.
        last_idx = len(enriched) - 1
        active_obs: list[dict[str, Any]] = []
        for i in range(len(enriched)):
            ob_val = enriched["OB"].iloc[i]
            if pd.isna(ob_val) or ob_val == 0:
                continue
            mit = enriched["OB_MitigatedIndex"].iloc[i]
            if pd.notna(mit) and mit != 0 and mit <= last_idx:
                continue  # already mitigated
            active_obs.append(
                {
                    "bar_idx": i,
                    "direction": "bullish" if ob_val == 1 else "bearish",
                    "top": float(enriched["OB_Top"].iloc[i]),
                    "bottom": float(enriched["OB_Bottom"].iloc[i]),
                    "volume": float(enriched["OBVolume"].iloc[i]),
                    "pct_share": float(enriched["OB_Percentage"].iloc[i]),
                    "z_top": float(enriched["OB_z_top"].iloc[i]),
                    "z_bot": float(enriched["OB_z_bot"].iloc[i]),
                    "z_mid": float(enriched["OB_z_mid"].iloc[i]),
                }
            )

        # Active FVGs (unmitigated)
        active_fvgs: list[dict[str, Any]] = []
        for i in range(len(enriched)):
            fvg_val = enriched["FVG"].iloc[i]
            if pd.isna(fvg_val) or fvg_val == 0:
                continue
            mit = enriched["FVG_MitigatedIndex"].iloc[i]
            if pd.notna(mit) and mit != 0 and mit <= last_idx:
                continue
            active_fvgs.append(
                {
                    "bar_idx": i,
                    "direction": "bullish" if fvg_val == 1 else "bearish",
                    "top": float(enriched["FVG_Top"].iloc[i]),
                    "bottom": float(enriched["FVG_Bottom"].iloc[i]),
                }
            )

        return CurrentState(
            ts=last["ts_event"],
            close=float(last["close"]),
            session_vwap=float(last["session_vwap"]),
            session_std=float(last["session_std"]),
            last_swing_kind=last_swing_kind,
            last_swing_level=last_swing_level,
            last_swing_bar_idx=last_swing_idx,
            last_bos_direction=last_bos_dir,
            last_bos_bar_idx=last_bos_idx,
            last_choch_direction=last_choch_dir,
            last_choch_plus=last_choch_plus,
            last_choch_bar_idx=last_choch_idx,
            active_obs=active_obs,
            active_fvgs=active_fvgs,
        )


# Columns whose events are relocated by `_relocate_bos_events_causally`.
# Anything touched by smc.bos_choch's 4-swing labeling + broken-filter
# pipeline belongs here; columns derived purely from swing_highs_lows
# (HighLow/Level_shl + the whole OB cluster) are shifted uniformly
# upstream and do NOT go through this path.
_BOS_COLS = ("BOS", "CHOCH", "Level_bc", "CHOCHPlus")


def _relocate_bos_events_causally(
    *,
    out: pd.DataFrame,
    shl: pd.DataFrame,
    bc: pd.DataFrame,
    swing_length: int,
) -> pd.DataFrame:
    """Move each BOS/CHOCH event from its raw smc-output position to the
    bar at which a live trader could first see it confirmed.

    For an event whose raw smc.bos_choch position is P0:

    - The label was placed when smc iterated to the 3rd swing after P0
      (call it P3). A live observer can only verify P3 is a swing at
      bar ``P3 + swing_length`` (swing_highs_lows's centered-window
      peek).
    - The event only survives smc's own broken-filter if the level was
      later broken at some bar ``j = broken[P0]``.

    So the earliest bar at which the live chart could show BOS[P0] is
    ``knowable_at = max(P3 + swing_length, broken[P0])``. We relocate
    each event's value from row P0 to row knowable_at. Events whose
    knowable_at >= len(out) are dropped — they were only confirmed by
    data beyond the frame and wouldn't have been visible during the
    window being backtested.

    This single transform supersedes the older uniform-shift approach
    and handles BOTH the labeling peek and the broken-filter peek in
    one pass. Collisions (two P0s mapping to the same knowable_at) are
    resolved by "last wins" — rare in practice.
    """
    n = len(out)
    hl_raw = shl["HighLow"].to_numpy(dtype=np.float64, na_value=np.nan)
    swing_positions = np.flatnonzero((~np.isnan(hl_raw)) & (hl_raw != 0))

    broken = bc["BrokenIndex"].to_numpy(dtype=np.float64, na_value=np.nan)

    src_values: dict[str, np.ndarray] = {
        col: out[col].to_numpy(dtype=np.float64, na_value=np.nan)
        for col in _BOS_COLS
    }
    new_cols: dict[str, np.ndarray] = {
        col: np.full(n, np.nan, dtype=np.float64) for col in _BOS_COLS
    }

    event_positions = np.where(~np.isnan(broken))[0]
    for p0 in event_positions:
        after_idx = int(np.searchsorted(swing_positions, p0, side="right"))
        swings_after = swing_positions[after_idx:]
        if len(swings_after) < 3:
            continue
        p3 = int(swings_after[2])
        knowable_at = max(p3 + swing_length, int(broken[p0]))
        if knowable_at >= n:
            continue
        for col in _BOS_COLS:
            new_cols[col][knowable_at] = src_values[col][p0]

    for col in _BOS_COLS:
        out[col] = new_cols[col]
    return out
