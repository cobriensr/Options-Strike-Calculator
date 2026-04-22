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

import pandas as pd  # noqa: E402
from smartmoneyconcepts import smc  # noqa: E402

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

        # smc primitives — take OHLC DataFrame, return event DataFrames
        shl = smc.swing_highs_lows(df, swing_length=self.params.swing_length)
        bc = smc.bos_choch(df, shl, close_break=self.params.close_mitigation)
        ob = smc.ob(
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

        # ── CAUSALITY FIX (2026-04-21) ──
        # smc.swing_highs_lows uses `.shift(-swing_length)` internally to
        # check if a bar is the extreme over its centered window, peeking
        # `swing_length` bars INTO THE FUTURE. A swing at bar T is only
        # confirmable at bar T + swing_length. bos_choch, ob, and our
        # tag_choch_plus all consume this biased output. smc.fvg uses
        # `.shift(-1)` so FVGs similarly need 1-bar confirmation.
        #
        # We shift every structure-detection column forward by the lookahead
        # budget the upstream primitive required. Callers reading these
        # columns at bar T now see only what was knowable at bar T — no
        # future info leaks into backtest entry/exit decisions.
        lag = self.params.swing_length
        struct_cols = (
            "HighLow", "Level_shl",
            "BOS", "CHOCH", "Level_bc", "CHOCHPlus",
            "OB", "OB_Top", "OB_Bottom", "OBVolume",
            "OB_Percentage", "OB_MitigatedIndex",
            "OB_mid", "OB_width",
            "OB_z_top", "OB_z_bot", "OB_z_mid",
        )
        for col in struct_cols:
            out[col] = out[col].shift(lag)
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
