"""Python port of the lottery_finder v4 detector.

Faithful translation of api/_lib/lottery-finder.ts. Used by
scripts/backfill_lottery_fires_for_ticker.py to replay the detector
against EOD parquets for tickers the WS daemon doesn't subscribe to
(e.g., SPXW). Parity-tested against the TS source-of-truth in
scripts/test_lottery_detector_py.py.

DO NOT diverge from the TS algorithm without updating both sides.
The TS file is the canonical version; this is its mirror. If you find
a bug here, also fix it there. If you change a constant here, also
change it there.

Spec: docs/superpowers/specs/lottery-finder-2026-05-02.md
Backfill spec: docs/superpowers/specs/spxw-backfill-2026-05-07.md
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional
from zoneinfo import ZoneInfo

# ============================================================
# Spec constants — mirror LOTTERY_SPEC_V4 exactly. Frozen.
# ============================================================

VOL_TO_OI_WINDOW_MIN = 0.05
VOL_TO_OI_CUM_MIN = 0.10
IV_MIN = 0.35
ABS_DELTA_MIN = 0.13
ASK_PCT_MIN = 0.52
DTE_MAX = 7
CNT_WINDOW_MIN = 5
COOLDOWN_MIN = 5
LOTTERY_WINDOW_MIN = 5

# ============================================================
# Universe — mirror LOTTERY_V3_TICKERS / LOTTERY_EXTENDED_TICKERS.
# Keep in sync with api/_lib/lottery-finder.ts manually until we
# have a JSON canonical source.
# ============================================================

LOTTERY_V3_TICKERS = frozenset({
    'USAR', 'WMT', 'STX', 'SOUN', 'RIVN', 'TSM', 'SNDK', 'XOM', 'WDC',
    'SQQQ', 'NDXP', 'USO', 'TNA', 'RDDT', 'SMCI', 'TSLL', 'SNOW',
    'TEAM', 'RKLB', 'SOFI', 'RUTW', 'TSLA', 'SOXS', 'WULF', 'SLV',
    'SMH', 'UBER', 'MSTR', 'TQQQ', 'RIOT', 'SOXL', 'UNH', 'QQQ',
    'RBLX', 'SPY', 'IWM', 'SPXW',
    # 2026-05-07 ticker-discovery batch (Option B audit additions)
    'CRWV', 'IBIT', 'ARM', 'OKLO', 'APLD', 'IONQ',
    'HIMS', 'CAR', 'IREN', 'ASTS', 'NBIS', 'CRCL', 'LITE', 'NVTS',
})

LOTTERY_EXTENDED_TICKERS = frozenset({
    'SPY', 'IWM', 'MU', 'META', 'AMD', 'NVDA', 'INTC', 'MSFT', 'AMZN',
    'PLTR', 'AVGO', 'GOOGL', 'GOOG', 'COIN', 'MSTR', 'HOOD', 'MRVL',
    'ORCL', 'AAPL',
    # 2026-05-07 mega-cap peer-class additions
    'QCOM', 'NFLX', 'LLY', 'BABA', 'NOW', 'CRWD',
    # Dual-listed 2026-05-07: also in V3. Speculative names where most
    # fire volume is on 1-3 DTE not 0DTE.
    'CRWV', 'IBIT', 'ARM', 'OKLO', 'APLD', 'IONQ',
    'HIMS', 'CAR', 'IREN', 'ASTS', 'NBIS', 'CRCL', 'LITE', 'NVTS',
})

LOTTERY_MODE_B_IN_PLAY_PCT = 0.10

_CT_TZ = ZoneInfo('America/Chicago')


# ============================================================
# Types
# ============================================================

OptionTypeLit = Literal['C', 'P']
SideLit = Literal['ask', 'bid', 'mid', 'no_side']
TimeOfDayLit = Literal['AM_open', 'MID', 'LUNCH', 'PM']
ModeLit = Literal['A_intraday_0DTE', 'B_multi_day_DTE1_3', 'OUT_OF_UNIVERSE']


@dataclass
class OptionTradeTick:
    """Mirror of OptionTradeTick in lottery-finder.ts."""
    executed_at: datetime
    option_chain: str
    option_type: OptionTypeLit
    strike: float
    expiry: datetime
    price: float
    size: int
    underlying_price: Optional[float]
    side: SideLit
    implied_volatility: Optional[float]
    delta: Optional[float]
    open_interest: Optional[int]


@dataclass
class LotteryFire:
    """Mirror of LotteryFire in lottery-finder.ts."""
    trigger_time_ct: datetime
    entry_time_ct: datetime
    entry_price: float
    trigger_vol_to_oi_window: float
    trigger_vol_to_oi_cum: float
    trigger_iv: float
    trigger_delta: float
    trigger_ask_pct: float
    trigger_window_prints: int
    trigger_window_size: int
    open_interest: int
    spot_at_first: float
    alert_seq: int = 0
    minutes_since_prev_fire: float = 0.0


@dataclass
class LotteryFireRecord:
    """Mirror of LotteryFireRecord — LotteryFire + per-fire metadata."""
    # Inlined from LotteryFire (Python dataclass inheritance + fields
    # gets awkward when adding required fields; flatten instead).
    trigger_time_ct: datetime
    entry_time_ct: datetime
    entry_price: float
    trigger_vol_to_oi_window: float
    trigger_vol_to_oi_cum: float
    trigger_iv: float
    trigger_delta: float
    trigger_ask_pct: float
    trigger_window_prints: int
    trigger_window_size: int
    open_interest: int
    spot_at_first: float
    alert_seq: int
    minutes_since_prev_fire: float
    # Metadata
    date: str  # YYYY-MM-DD CT
    underlying_symbol: str
    option_chain_id: str
    option_type: OptionTypeLit
    strike: float
    expiry: str  # YYYY-MM-DD
    dte: int
    mode: ModeLit
    flow_quad: str
    tod: TimeOfDayLit
    reload_tagged: bool
    cheap_call_pm_tagged: bool
    burst_ratio_vs_prev: Optional[float]
    entry_drop_pct_vs_prev: Optional[float]


# ============================================================
# Pure helpers — exact mirror of TS exports
# ============================================================


def get_ct_time(dt: datetime) -> tuple[int, int]:
    """Mirror getCTTime — returns (hour, minute) in CT."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ct = dt.astimezone(_CT_TZ)
    return ct.hour, ct.minute


def get_time_of_day_from_ct_hour_min(hour: int, minute: int) -> TimeOfDayLit:
    """Mirror getTimeOfDayFromCtHourMin."""
    h = hour + minute / 60.0
    if h < 9.5:
        return 'AM_open'
    if h < 11.5:
        return 'MID'
    if h < 12.5:
        return 'LUNCH'
    return 'PM'


def get_time_of_day(trigger_utc: datetime) -> TimeOfDayLit:
    """Mirror getTimeOfDay."""
    h, m = get_ct_time(trigger_utc)
    return get_time_of_day_from_ct_hour_min(h, m)


def get_dominant_side(ask_pct: float) -> Literal['ask', 'bid', 'mixed']:
    """Mirror getDominantSide."""
    if ask_pct >= 0.6:
        return 'ask'
    if ask_pct <= 0.4:
        return 'bid'
    return 'mixed'


def build_flow_quad(option_type: OptionTypeLit, ask_pct: float) -> str:
    """Mirror buildFlowQuad."""
    side_label = get_dominant_side(ask_pct)
    type_label = 'call' if option_type == 'C' else 'put'
    return f'{type_label}_{side_label}'


def classify_mode(
    ticker: str,
    dte: int,
    ask_pct: float,
    strike: float,
    spot: float,
) -> ModeLit:
    """Mirror classifyMode."""
    if ask_pct < ASK_PCT_MIN:
        return 'OUT_OF_UNIVERSE'
    ticker_upper = ticker.upper()
    # Mode A: V3 list (incl. SPY/IWM/SPXW), DTE = 0, no moneyness gate.
    if dte == 0 and ticker_upper in LOTTERY_V3_TICKERS:
        return 'A_intraday_0DTE'
    # Mode B: extended list \ {SPY, IWM}, DTE 1-3, in-play moneyness.
    if (
        0 < dte <= 3
        and ticker_upper in LOTTERY_EXTENDED_TICKERS
        and ticker_upper != 'SPY'
        and ticker_upper != 'IWM'
        and spot > 0
        and abs(strike / spot - 1) <= LOTTERY_MODE_B_IN_PLAY_PCT
    ):
        return 'B_multi_day_DTE1_3'
    return 'OUT_OF_UNIVERSE'


def is_reload(
    burst_ratio_vs_prev: Optional[float],
    entry_drop_pct_vs_prev: Optional[float],
) -> bool:
    """Mirror isReload."""
    if burst_ratio_vs_prev is None or entry_drop_pct_vs_prev is None:
        return False
    return burst_ratio_vs_prev >= 2.0 and entry_drop_pct_vs_prev <= -30.0


def is_cheap_call_pm(
    option_type: OptionTypeLit, entry_price: float, tod: TimeOfDayLit
) -> bool:
    """Mirror isCheapCallPm."""
    return option_type == 'C' and tod == 'PM' and entry_price < 1.0


# ============================================================
# Detector core — port of detectChainFires
# ============================================================


def detect_chain_fires(
    ticks: list[OptionTradeTick],
    oi: int,
    dte: int,
    prior_last_fire_ms: Optional[float] = None,
) -> list[LotteryFire]:
    """Mirror detectChainFires.

    Caller responsibilities (per TS docstring):
    - ticks must be filtered for canceled=False and price>0
    - ticks must be sorted by executed_at ascending
    """
    if dte > DTE_MAX or oi <= 0:
        return []
    if len(ticks) < CNT_WINDOW_MIN:
        return []

    n = len(ticks)
    window_ms = LOTTERY_WINDOW_MIN * 60 * 1000
    cooldown_ms = COOLDOWN_MIN * 60 * 1000

    # First-tick spot is load-bearing — matches Python p14 iloc[0].
    first_tick = ticks[0]
    if first_tick.underlying_price is None or first_tick.underlying_price <= 0:
        return []
    spot_at_first = first_tick.underlying_price

    fires: list[LotteryFire] = []
    last_fire_ts: Optional[float] = prior_last_fire_ms

    # Two-pointer rolling window mirroring the TS code.
    window_start = 0
    ask_sum = 0
    ab_sum = 0
    iv_sum = 0.0
    iv_count = 0
    delta_sum = 0.0
    delta_count = 0
    size_sum = 0
    print_count = 0
    cum_vol = 0

    def apply_tick(t: OptionTradeTick, sign: int) -> None:
        nonlocal ask_sum, ab_sum, iv_sum, iv_count, delta_sum, delta_count
        nonlocal size_sum, print_count
        if t.side == 'ask':
            ask_sum += sign
        if t.side == 'ask' or t.side == 'bid':
            ab_sum += sign
        if t.implied_volatility is not None:
            iv_sum += sign * t.implied_volatility
            iv_count += sign
        if t.delta is not None:
            delta_sum += sign * t.delta
            delta_count += sign
        size_sum += sign * t.size
        print_count += sign

    def epoch_ms(dt: datetime) -> float:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000.0

    for i in range(n):
        cur = ticks[i]
        apply_tick(cur, 1)
        cum_vol += cur.size
        ts_ms = epoch_ms(cur.executed_at)

        # Slide window forward — closed='right' = (t-5min, t], so a
        # tick at exactly t-5min is EXCLUDED. Hence `>=`, not `>`.
        while (
            window_start < i
            and ts_ms - epoch_ms(ticks[window_start].executed_at) >= window_ms
        ):
            apply_tick(ticks[window_start], -1)
            window_start += 1

        if print_count < CNT_WINDOW_MIN:
            continue

        vol_to_oi_window = size_sum / oi
        if vol_to_oi_window < VOL_TO_OI_WINDOW_MIN:
            continue

        vol_to_oi_cum = cum_vol / oi
        if vol_to_oi_cum < VOL_TO_OI_CUM_MIN:
            continue

        if iv_count == 0:
            continue
        iv_mean = iv_sum / iv_count
        if iv_mean < IV_MIN:
            continue

        if delta_count == 0:
            continue
        delta_mean = delta_sum / delta_count
        if abs(delta_mean) < ABS_DELTA_MIN:
            continue

        if ab_sum == 0:
            continue
        ask_pct = ask_sum / ab_sum
        if ask_pct < ASK_PCT_MIN:
            continue

        # Cooldown gate.
        if last_fire_ts is not None and ts_ms - last_fire_ts < cooldown_ms:
            continue

        # Entry = next print (or current if last in series).
        entry_idx = min(i + 1, n - 1)
        entry = ticks[entry_idx]
        if entry.price <= 0:
            continue

        fires.append(LotteryFire(
            trigger_time_ct=cur.executed_at,
            entry_time_ct=entry.executed_at,
            entry_price=entry.price,
            trigger_vol_to_oi_window=vol_to_oi_window,
            trigger_vol_to_oi_cum=vol_to_oi_cum,
            trigger_iv=iv_mean,
            trigger_delta=delta_mean,
            trigger_ask_pct=ask_pct,
            trigger_window_prints=print_count,
            trigger_window_size=size_sum,
            open_interest=oi,
            spot_at_first=spot_at_first,
            alert_seq=0,  # tagged below
            minutes_since_prev_fire=0.0,
        ))
        last_fire_ts = ts_ms

    # Tag alert_seq + minutes_since_prev_fire.
    for k in range(len(fires)):
        f = fires[k]
        f.alert_seq = k + 1
        if k == 0:
            f.minutes_since_prev_fire = 0.0
        else:
            prev = fires[k - 1]
            delta_ms = (
                f.trigger_time_ct - prev.trigger_time_ct
            ).total_seconds() * 1000.0
            f.minutes_since_prev_fire = delta_ms / 60_000.0
    return fires


# ============================================================
# enrichFires port
# ============================================================


@dataclass
class EnrichMeta:
    date: str
    option_chain_id: str
    underlying_symbol: str
    option_type: OptionTypeLit
    strike: float
    expiry: str
    dte: int


def enrich_fires(
    fires: list[LotteryFire], meta: EnrichMeta
) -> list[LotteryFireRecord]:
    """Mirror enrichFires."""
    out: list[LotteryFireRecord] = []
    for i, f in enumerate(fires):
        prev = fires[i - 1] if i > 0 else None
        burst_ratio = (
            f.trigger_window_size / prev.trigger_window_size
            if prev and prev.trigger_window_size > 0
            else None
        )
        entry_drop = (
            (f.entry_price - prev.entry_price) / prev.entry_price * 100.0
            if prev and prev.entry_price > 0
            else None
        )

        tod = get_time_of_day(f.trigger_time_ct)
        flow_quad = build_flow_quad(meta.option_type, f.trigger_ask_pct)
        mode = classify_mode(
            meta.underlying_symbol,
            meta.dte,
            f.trigger_ask_pct,
            meta.strike,
            f.spot_at_first,
        )
        reload_tagged = is_reload(burst_ratio, entry_drop)
        cheap_call_pm_tagged = is_cheap_call_pm(meta.option_type, f.entry_price, tod)

        out.append(LotteryFireRecord(
            trigger_time_ct=f.trigger_time_ct,
            entry_time_ct=f.entry_time_ct,
            entry_price=f.entry_price,
            trigger_vol_to_oi_window=f.trigger_vol_to_oi_window,
            trigger_vol_to_oi_cum=f.trigger_vol_to_oi_cum,
            trigger_iv=f.trigger_iv,
            trigger_delta=f.trigger_delta,
            trigger_ask_pct=f.trigger_ask_pct,
            trigger_window_prints=f.trigger_window_prints,
            trigger_window_size=f.trigger_window_size,
            open_interest=f.open_interest,
            spot_at_first=f.spot_at_first,
            alert_seq=f.alert_seq,
            minutes_since_prev_fire=f.minutes_since_prev_fire,
            date=meta.date,
            underlying_symbol=meta.underlying_symbol,
            option_chain_id=meta.option_chain_id,
            option_type=meta.option_type,
            strike=meta.strike,
            expiry=meta.expiry,
            dte=meta.dte,
            mode=mode,
            flow_quad=flow_quad,
            tod=tod,
            reload_tagged=reload_tagged,
            cheap_call_pm_tagged=cheap_call_pm_tagged,
            burst_ratio_vs_prev=burst_ratio,
            entry_drop_pct_vs_prev=entry_drop,
        ))
    return out
