"""Walk-forward backtest harness for the 8 futures setups.

Design choices, locked here so per-setup evaluators stay simple:

* **Bar resolution = 1 minute.** Decisions are made at the *close* of bar T;
  entry executes at the *open* of bar T+1 (next-bar-open fill). This is the
  cleanest no-look-ahead convention for 1m futures data.
* **Stop/target on subsequent bars.** Each bar's high/low after entry is
  checked against target/stop. Conflict-day convention: if both target and
  stop are touched in the same bar, conservatively count as a stop hit
  (worst-case fill — common backtest convention).
* **EoD closeout.** Any open position is force-closed at the last bar of RTH
  (20:00 UTC = 16:00 ET) at the close price.
* **One position at a time per setup.** Signals that fire while a position is
  open are dropped (logged in metadata).
* **Disqualifier checked once at entry**, not re-checked while in position.
  The spec's disqualifiers are pre-entry filters.
* **Cost model**: 1.5 ticks slippage per side + $1.25/side commission. Applied
  symmetrically; favorable side hits don't get a discount.

Output: a list of ``Trade`` records (see dataclass below) suitable for direct
DataFrame conversion.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, time
from enum import Enum
from typing import Any, Protocol

import pandas as pd

from . import data_loaders

log = logging.getLogger("setups_backtest.harness")


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class Direction(Enum):
    LONG = "LONG"
    SHORT = "SHORT"

    @property
    def sign(self) -> int:
        return 1 if self is Direction.LONG else -1


class ExitReason(Enum):
    TARGET = "TARGET"
    STOP = "STOP"
    EOD = "EOD"
    DISQUALIFIED = "DISQUALIFIED"  # never entered


@dataclass(frozen=True)
class ContractSpec:
    """Tick size and dollar value per tick for a futures contract."""

    prefix: str
    tick_size: float
    tick_value: float

    @property
    def slippage_dollars(self) -> float:
        """1.5 ticks of slippage per side, in $ per contract."""
        return 1.5 * self.tick_value

    @property
    def slippage_price(self) -> float:
        """1.5 ticks of slippage per side, in price units."""
        return 1.5 * self.tick_size


# Per-spec cost model (docs/superpowers/specs/futures-setups-backtest-2026-05-15.md).
CONTRACT_SPECS: dict[str, ContractSpec] = {
    "ES": ContractSpec(prefix="ES", tick_size=0.25, tick_value=12.50),
    "NQ": ContractSpec(prefix="NQ", tick_size=0.25, tick_value=5.00),
}

COMMISSION_PER_SIDE = 1.25  # $1.25 entry + $1.25 exit = $2.50 RT


@dataclass(frozen=True)
class Signal:
    """A setup-evaluator's "GO" decision at one minute.

    The harness converts this into a Trade by simulating execution at the
    next bar's open price plus slippage.
    """

    setup_name: str
    decision_ts: pd.Timestamp  # close of bar T; entry at open of T+1
    direction: Direction
    contract: str  # e.g. "ESM6" — the actual instrument to trade
    stop_price: float
    target_price: float
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Trade:
    """Full lifecycle record of one round trip."""

    setup_name: str
    direction: Direction
    contract: str
    entry_ts: pd.Timestamp
    exit_ts: pd.Timestamp
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    exit_reason: ExitReason
    gross_pnl_dollars: float
    net_pnl_dollars: float
    r_multiple: float
    metadata: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Evaluator Protocol
# ---------------------------------------------------------------------------


class SetupEvaluator(Protocol):
    """Interface implemented by each setup_N_*.py file.

    Lifecycle per backtest run:
      1. ``prepare(start, end, conn, pg)`` — load any historical context the
         evaluator needs (multi-day rolling features, cross-asset bars, DB
         pulls). Returns an opaque object the evaluator uses inside
         ``evaluate_minute``.
      2. For each trading day in [start, end]:
         For each minute of RTH:
           ``evaluate_minute(now, ctx, bars)`` -> Signal | None
    """

    name: str
    contract_prefix: str  # "ES" or "NQ" — drives ContractSpec lookup

    def prepare(
        self,
        conn,
        pg,
        start: date,
        end: date,
    ) -> Any: ...

    def evaluate_minute(
        self,
        now: pd.Timestamp,
        ctx: Any,
        bars: pd.DataFrame,
    ) -> Signal | None: ...


# ---------------------------------------------------------------------------
# Session bounds
# ---------------------------------------------------------------------------

RTH_OPEN_UTC = time(13, 30)  # 09:30 ET
RTH_CLOSE_UTC = time(20, 0)  # 16:00 ET


def _rth_window(d: date) -> tuple[pd.Timestamp, pd.Timestamp]:
    """RTH session bounds for ``d`` in UTC (tz-aware)."""
    base = pd.Timestamp(d, tz="UTC")
    return (
        base + pd.Timedelta(hours=13, minutes=30),
        base + pd.Timedelta(hours=20),
    )


# ---------------------------------------------------------------------------
# Position simulation
# ---------------------------------------------------------------------------


def _simulate_exit(
    signal: Signal,
    bars: pd.DataFrame,
) -> tuple[pd.Timestamp, float, ExitReason]:
    """Walk forward through ``bars`` from signal entry to determine exit.

    ``bars`` must be the entry contract's 1m OHLCV bars from the entry bar
    onward, sorted ascending by ts. Returns (exit_ts, exit_price, reason).

    Stop/target hit rules:
      * LONG: stop = price <= stop_price; target = price >= target_price
      * SHORT: stop = price >= stop_price; target = price <= target_price
      * Gap-through: on the FIRST post-entry bar, if ``bar_open`` is already
        past the stop, fill at ``bar_open`` (worse than stop_price — honest
        about gap risk). On any bar, if open is already past the target,
        fill at ``target_price`` (no gap bonus — conservative). Both
        asymmetries favor caution.
      * If both target and stop are touched in the same bar: conservative
        stop hit (assume the adverse extreme came first — standard backtest
        convention since we can't reconstruct intra-bar ordering from OHLCV).
    """
    if bars.empty:
        # Shouldn't happen — caller should have rejected this signal — but
        # defensively close at the signal price with no P&L.
        return signal.decision_ts, signal.stop_price, ExitReason.EOD

    sign = signal.direction.sign

    for i, (_, bar) in enumerate(bars.iterrows()):
        bar_open = float(bar["open"])
        bar_high = float(bar["high"])
        bar_low = float(bar["low"])
        bar_ts = bar["ts"]

        # Gap-through stop on first post-entry bar: open already past stop.
        if i == 0:
            if sign > 0 and bar_open <= signal.stop_price:
                return bar_ts, bar_open, ExitReason.STOP
            if sign < 0 and bar_open >= signal.stop_price:
                return bar_ts, bar_open, ExitReason.STOP

        if sign > 0:
            hit_stop = bar_low <= signal.stop_price
            hit_target = bar_high >= signal.target_price
        else:
            hit_stop = bar_high >= signal.stop_price
            hit_target = bar_low <= signal.target_price

        if hit_stop and hit_target:
            return bar_ts, signal.stop_price, ExitReason.STOP
        if hit_stop:
            return bar_ts, signal.stop_price, ExitReason.STOP
        if hit_target:
            return bar_ts, signal.target_price, ExitReason.TARGET

    # No exit triggered — close at last bar of session at its close price.
    last = bars.iloc[-1]
    return last["ts"], float(last["close"]), ExitReason.EOD


def _bar_hits_exit(
    signal: Signal, bar: pd.Series
) -> tuple[pd.Timestamp, float, ExitReason] | None:
    """Check an already-entered bar's H/L for a stop/target hit.

    Used for the ENTRY bar, whose fill price is the bar's open — so there is no
    gap-through-at-open to model (the open IS the entry). Both extremes touched
    in the same bar → conservative stop (same convention as ``_simulate_exit``).
    Returns ``None`` if neither level is touched.
    """
    sign = signal.direction.sign
    bar_high = float(bar["high"])
    bar_low = float(bar["low"])
    if sign > 0:
        hit_stop = bar_low <= signal.stop_price
        hit_target = bar_high >= signal.target_price
    else:
        hit_stop = bar_high >= signal.stop_price
        hit_target = bar_low <= signal.target_price
    if hit_stop:  # both-touched resolves here too (conservative)
        return bar["ts"], signal.stop_price, ExitReason.STOP
    if hit_target:
        return bar["ts"], signal.target_price, ExitReason.TARGET
    return None


def _resolve_trade(
    signal: Signal,
    entry_bar: pd.Series,
    exit_bars: pd.DataFrame,
    spec: ContractSpec,
) -> Trade:
    """Resolve a signal into a complete Trade record with realistic costs."""
    sign = signal.direction.sign

    # Entry: next bar's open, +/- slippage against us.
    raw_entry = float(entry_bar["open"])
    entry_price = raw_entry + sign * spec.slippage_price

    # Exit simulation uses raw prices; slippage applied after.
    # AUD-H9: examine the ENTRY bar's own H/L FIRST. We fill at T+1's open and
    # hold through T+1, so a stop/target touched during the entry minute must
    # count — but `exit_bars` starts at T+2 and never saw it, understating
    # tight-stop (setups 5/6/6b) entry-minute losses.
    entry_hit = _bar_hits_exit(signal, entry_bar)
    if entry_hit is not None:
        exit_ts, raw_exit, reason = entry_hit
    elif not exit_bars.empty:
        exit_ts, raw_exit, reason = _simulate_exit(signal, exit_bars)
    else:
        # Entry bar didn't trigger and there are no post-entry bars (signal on
        # the second-to-last RTH bar). Close at the entry bar's close (EOD) — NOT
        # at the pre-entry decision_ts/stop_price, which fabricated a ~-1R loss
        # with exit_ts BEFORE entry_ts (AUD-H9).
        exit_ts = entry_bar["ts"]
        raw_exit = float(entry_bar["close"])
        reason = ExitReason.EOD
    exit_price = raw_exit - sign * spec.slippage_price

    # P&L: (exit - entry) * direction * tick_value / tick_size.
    price_diff = (exit_price - entry_price) * sign
    gross_pnl = price_diff * (spec.tick_value / spec.tick_size)
    net_pnl = gross_pnl - 2 * COMMISSION_PER_SIDE

    # R-multiple denominator uses RAW (pre-slippage) entry — the risk-as-planned
    # the trader sees on the chart. The slippage penalty falls only into the
    # numerator (realized P&L), which is the honest "what the trader risked vs
    # what they actually got" framing. Deliberate; do not change without
    # updating every comparative report that reads R-multiples.
    risk_per_contract_pts = abs(raw_entry - signal.stop_price)
    risk_dollars = risk_per_contract_pts * (spec.tick_value / spec.tick_size)
    r_multiple = net_pnl / risk_dollars if risk_dollars > 0 else 0.0

    return Trade(
        setup_name=signal.setup_name,
        direction=signal.direction,
        contract=signal.contract,
        entry_ts=entry_bar["ts"],
        exit_ts=exit_ts,
        entry_price=entry_price,
        exit_price=exit_price,
        stop_price=signal.stop_price,
        target_price=signal.target_price,
        exit_reason=reason,
        gross_pnl_dollars=gross_pnl,
        net_pnl_dollars=net_pnl,
        r_multiple=r_multiple,
        metadata=signal.metadata,
    )


# ---------------------------------------------------------------------------
# Backtest driver
# ---------------------------------------------------------------------------


def run_backtest(
    evaluator: SetupEvaluator,
    trading_days: Sequence[date],
    conn=None,
    pg=None,
    *,
    progress_every: int = 10,
) -> list[Trade]:
    """Run ``evaluator`` over ``trading_days`` and return the trade log.

    The caller supplies an open DuckDB ``conn`` and (optionally) a psycopg2
    ``pg`` connection. The harness does not open or close these — it's on
    the caller so a single run can amortize connection setup.

    For each trading day:
      1. Pick the front-month contract for the evaluator's symbol prefix.
      2. Load 1m OHLCV for that contract.
      3. Iterate minutes of RTH; call ``evaluator.evaluate_minute``.
      4. If a Signal is returned and no position is open, simulate execution.
      5. Append resolved Trade to the log.
    """
    if conn is None:
        raise ValueError("conn (DuckDB) is required")
    if evaluator.contract_prefix not in CONTRACT_SPECS:
        raise ValueError(
            f"Unknown contract_prefix {evaluator.contract_prefix!r}; "
            f"add it to CONTRACT_SPECS."
        )
    spec = CONTRACT_SPECS[evaluator.contract_prefix]

    if not trading_days:
        return []

    log.info(
        "Backtest: %s over %d days [%s -> %s]",
        evaluator.name,
        len(trading_days),
        trading_days[0],
        trading_days[-1],
    )
    ctx = evaluator.prepare(conn, pg, trading_days[0], trading_days[-1])

    trades: list[Trade] = []

    for i, d in enumerate(trading_days):
        contract = data_loaders.pick_front_month(conn, evaluator.contract_prefix, d)
        if contract is None:
            log.debug("No %s contract on %s; skipping.", evaluator.contract_prefix, d)
            continue

        ohlcv = data_loaders.load_ohlcv_day(conn, [contract], d)
        if ohlcv.empty:
            log.debug("No OHLCV bars for %s on %s; skipping.", contract, d)
            continue

        rth_open, rth_close = _rth_window(d)
        rth_bars = ohlcv[
            (ohlcv["ts"] >= rth_open) & (ohlcv["ts"] < rth_close)
        ].reset_index(drop=True)
        if rth_bars.empty:
            continue

        position_active = False
        exit_ts: pd.Timestamp | None = None
        for idx, bar in rth_bars.iterrows():
            # Clear the in-position flag once we're past the trade's exit bar.
            # This restores intraday re-entry — multiple trades per day per setup
            # are allowed and expected for high-frequency setups (CVD divergence,
            # zero-gamma magnet).
            if position_active and exit_ts is not None and bar["ts"] > exit_ts:
                position_active = False
                exit_ts = None
            if position_active:
                continue
            now = bar["ts"]
            # `rth_bars.loc[:idx]` is inclusive on both ends for the
            # post-reset_index integer label, so the evaluator sees bars
            # [0..idx] — including the bar whose close just printed (bar T),
            # excluding the next bar (T+1, where entry would execute).
            signal = evaluator.evaluate_minute(now, ctx, rth_bars.loc[:idx])
            if signal is None:
                continue
            # Need at least one more bar to execute the open-of-T+1 fill.
            if idx + 1 >= len(rth_bars):
                continue
            entry_bar = rth_bars.iloc[idx + 1]
            exit_bars = rth_bars.iloc[idx + 2 :].reset_index(drop=True)
            # Re-tag the signal's contract if the evaluator left it blank.
            if not signal.contract:
                signal = Signal(
                    setup_name=signal.setup_name,
                    decision_ts=signal.decision_ts,
                    direction=signal.direction,
                    contract=contract,
                    stop_price=signal.stop_price,
                    target_price=signal.target_price,
                    metadata=signal.metadata,
                )
            trade = _resolve_trade(signal, entry_bar, exit_bars, spec)
            trades.append(trade)
            position_active = True
            exit_ts = trade.exit_ts

        if (i + 1) % progress_every == 0:
            log.info(
                "Backtest progress: %d/%d days, %d trades so far",
                i + 1,
                len(trading_days),
                len(trades),
            )

    log.info("Backtest complete: %d trades", len(trades))
    return trades


def trades_to_dataframe(trades: Sequence[Trade]) -> pd.DataFrame:
    """Convert a Trade log to a DataFrame for analysis / parquet output."""
    if not trades:
        return pd.DataFrame(
            columns=[
                "setup_name",
                "direction",
                "contract",
                "entry_ts",
                "exit_ts",
                "entry_price",
                "exit_price",
                "stop_price",
                "target_price",
                "exit_reason",
                "gross_pnl_dollars",
                "net_pnl_dollars",
                "r_multiple",
            ]
        )
    rows = []
    for t in trades:
        rows.append(
            {
                "setup_name": t.setup_name,
                "direction": t.direction.value,
                "contract": t.contract,
                "entry_ts": t.entry_ts,
                "exit_ts": t.exit_ts,
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "stop_price": t.stop_price,
                "target_price": t.target_price,
                "exit_reason": t.exit_reason.value,
                "gross_pnl_dollars": t.gross_pnl_dollars,
                "net_pnl_dollars": t.net_pnl_dollars,
                "r_multiple": t.r_multiple,
            }
        )
    return pd.DataFrame(rows)
