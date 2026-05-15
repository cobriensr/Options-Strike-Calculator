/**
 * Lottery Finder — v4 event-based trigger detector + discriminators.
 *
 * Pure TS port of docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py
 * (detector) + p26_canonical_realized.py (RE-LOAD, tod, flow_quad, mode tags)
 * + p28_lottery_discriminator.py (cheap-call-PM rule).
 *
 * The detector runs over per-tick option trades for one chain on one day
 * and emits one fire per qualifying 5-min rolling window (with a 5-min
 * cooldown between fires on the same chain).
 *
 * See docs/superpowers/specs/lottery-finder-2026-05-02.md.
 */
import { getCTTime } from '../../src/utils/timezone.js';

// ============================================================
// Spec constants — frozen against the 15-day backtest window.
// Changing any of these silently changes the fire universe and
// invalidates the calibration. Treat as load-bearing.
// ============================================================
export const LOTTERY_SPEC_V4 = {
  /** Fraction of OI traded in the rolling 5-min window. */
  volToOiWindowMin: 0.05,
  /** Cumulative-since-open vol/OI floor — chain context. */
  volToOiCumMin: 0.1,
  /** Minimum mean implied volatility in the window. */
  ivMin: 0.35,
  /** Minimum |mean delta| in the window. */
  absDeltaMin: 0.13,
  /** Minimum ask-side fraction in the window. */
  askPctMin: 0.52,
  /** Maximum DTE eligible to fire. */
  dteMax: 7,
  /** Minimum prints in the rolling window. */
  cntWindowMin: 5,
  /** Cooldown between successive fires on the same chain. */
  cooldownMin: 5,
} as const;

/** Rolling-window length in minutes. */
export const LOTTERY_WINDOW_MIN = 5;

/**
 * Mode A V3 ticker list (intraday 0DTE scalp universe + SPY/IWM/SPXW).
 *
 * Curation methodology: see docs/tmp/ticker-discovery-audit-2026-05-06.md.
 * Tickers below the 18-day-fire-count threshold may be hand-added with a
 * comment when a high-profile setup is missed, but re-validate at the
 * next audit cadence.
 */
export const LOTTERY_V3_TICKERS = [
  'USAR',
  'WMT',
  'STX',
  'SOUN',
  'RIVN',
  'TSM',
  'SNDK',
  'XOM',
  'WDC',
  'SQQQ',
  'NDXP',
  'USO',
  'TNA',
  'RDDT',
  'SMCI',
  'TSLL',
  'SNOW',
  'TEAM',
  'RKLB',
  'SOFI',
  'RUTW',
  'TSLA',
  'SOXS',
  'WULF',
  'SLV',
  'SMH',
  'UBER',
  'MSTR',
  'TQQQ',
  'RIOT',
  'SOXL',
  'UNH',
  'QQQ',
  'RBLX',
  'SPY',
  'IWM',
  'SPXW', // Added 2026-05-07: 0DTE SPX weeklies — the user's primary
  // traded chain. Backfilled from parquet via
  // scripts/backfill_lottery_fires_for_ticker.py since the WS
  // daemon doesn't subscribe to SPXW. See spec
  // docs/superpowers/specs/spxw-backfill-2026-05-07.md.
  // Added 2026-05-07 from ticker discovery audit
  // (docs/tmp/ticker-discovery-audit-2026-05-06.md): top-volume V3
  // candidates that cleared >450 qualifying fires across the 18-day
  // parquet window. AI / quantum / space / crypto-adjacent specs that
  // exhibit the explosive 0DTE pattern V3 was designed for.
  'CRWV',
  'IBIT',
  'ARM',
  'OKLO',
  'APLD',
  'IONQ',
  'HIMS',
  'CAR',
  'IREN',
  'ASTS',
  'NBIS',
  'CRCL',
  'LITE',
  'NVTS',
  // Hand-added 2026-05-15 ahead of the next discovery-audit re-run.
  // SEDG 54C 0DTE on 2026-05-15 had a textbook V3 setup (vol/OI 12.5x,
  // ask% 55%, $58K single-leg premium burst, 3x mover) and would have
  // cleared every threshold except universe membership. Will be
  // re-validated against the next parquet-window audit.
  'SEDG',
] as const;

/** Mode B extended ticker list (DTE 1-3 trend universe). */
export const LOTTERY_EXTENDED_TICKERS = [
  'SPY',
  'IWM',
  'MU',
  'META',
  'AMD',
  'NVDA',
  'INTC',
  'MSFT',
  'AMZN',
  'PLTR',
  'AVGO',
  'GOOGL',
  'GOOG',
  'COIN',
  'MSTR',
  'HOOD',
  'MRVL',
  'ORCL',
  'AAPL',
  // Added 2026-05-07 from ticker discovery audit
  // (docs/tmp/ticker-discovery-audit-2026-05-06.md): mega-cap peer
  // stocks whose 18-day fire counts (~500-1000 qualifying) place them
  // squarely in the multi-day-trend cohort alongside META/NVDA/etc.
  'QCOM',
  'NFLX',
  'LLY',
  'BABA',
  'NOW',
  'CRWD',
  // Dual-listed 2026-05-07: speculative AI/quantum/crypto-adjacent
  // names that the discovery audit found also fire heavily on 1-3 DTE
  // (in-play) chains, not just 0DTE. Without inclusion here they only
  // qualify as Mode A (V3, DTE=0), which captures <5% of their fire
  // volume. SPY/IWM are special-cased OUT of Mode B in classifyMode;
  // these 14 are naturally in via membership.
  'CRWV',
  'IBIT',
  'ARM',
  'OKLO',
  'APLD',
  'IONQ',
  'HIMS',
  'CAR',
  'IREN',
  'ASTS',
  'NBIS',
  'CRCL',
  'LITE',
  'NVTS',
] as const;

// ============================================================
// Input + output types
// ============================================================

/**
 * Per-tick option trade as written to ws_option_trades. Fields the
 * detector reads — see api/_lib/db-migrations.ts migration #109 for the
 * full schema.
 */
export interface OptionTradeTick {
  /** Tape execution time. */
  executedAt: Date;
  /** OCC OSI symbol — natural per-chain key. */
  optionChain: string;
  /** 'C' or 'P'. */
  optionType: 'C' | 'P';
  /** Numeric strike. */
  strike: number;
  /** Expiry date (UTC midnight is fine — only the date is read). */
  expiry: Date;
  /** Trade price in dollars. */
  price: number;
  /** Contract count. */
  size: number;
  /** Underlying spot at trade time. May be null on early prints. */
  underlyingPrice: number | null;
  /** Side classification. */
  side: 'ask' | 'bid' | 'mid' | 'no_side';
  /** Trade-time IV. May be null when UW couldn't compute. */
  impliedVolatility: number | null;
  /** Trade-time delta. May be null. */
  delta: number | null;
  /** OI snapshot at trade time. May be null. */
  openInterest: number | null;
}

/** One v4 trigger fire emitted by the detector. */
export interface LotteryFire {
  /** Time of the bar that satisfied all V4 gates. */
  triggerTimeCt: Date;
  /** Time of the next print after triggerTimeCt — the entry tick. */
  entryTimeCt: Date;
  /** Entry-tick price. */
  entryPrice: number;

  /** Vol/OI in the rolling 5-min window. */
  triggerVolToOiWindow: number;
  /** Cumulative-since-open vol/OI. */
  triggerVolToOiCum: number;
  /** Mean IV in the rolling window. */
  triggerIv: number;
  /** Mean delta in the rolling window. */
  triggerDelta: number;
  /** Ask-side fraction in the rolling window (0-1). */
  triggerAskPct: number;
  /** Print count in the rolling window. */
  triggerWindowPrints: number;
  /** Sum of contract sizes in the rolling window. */
  triggerWindowSize: number;
  /** OI used in vol/OI calculations (max across day). */
  openInterest: number;
  /** Underlying spot at the chain's first qualifying print. */
  spotAtFirst: number;

  /** 1 = first fire on this chain today, 2 = second, ... */
  alertSeq: number;
  /** Minutes since the prior fire on the same chain. 0 on alertSeq=1. */
  minutesSincePrevFire: number;
}

/**
 * Output of buildFires() — the per-chain fire stream + the per-fire
 * derived discriminators that get persisted to lottery_finder_fires.
 */
export interface LotteryFireRecord extends LotteryFire {
  date: string; // YYYY-MM-DD (CT) for the trading day
  underlyingSymbol: string;
  optionChainId: string;
  optionType: 'C' | 'P';
  strike: number;
  expiry: string; // YYYY-MM-DD
  dte: number;
  /** A_intraday_0DTE | B_multi_day_DTE1_3 | OUT_OF_UNIVERSE */
  mode: LotteryMode;
  /** call_ask | call_bid | call_mixed | put_ask | put_bid | put_mixed */
  flowQuad: string;
  /** AM_open | MID | LUNCH | PM */
  tod: TimeOfDay;
  /** RE-LOAD discriminator (Phase 1 selection). */
  reloadTagged: boolean;
  /** Cheap-call-PM rule (Phase 1 selection within RE-LOAD). */
  cheapCallPmTagged: boolean;
  /** triggerWindowSize / prevTriggerWindowSize (NULL on alertSeq=1). */
  burstRatioVsPrev: number | null;
  /** (entry - prevEntry) / prevEntry × 100 (NULL on alertSeq=1). */
  entryDropPctVsPrev: number | null;
}

export type LotteryMode =
  | 'A_intraday_0DTE'
  | 'B_multi_day_DTE1_3'
  | 'OUT_OF_UNIVERSE';

export type TimeOfDay = 'AM_open' | 'MID' | 'LUNCH' | 'PM';

// ============================================================
// Pure helpers (exported for unit testing)
// ============================================================

/**
 * Bucket a UTC trigger time into the AM_open / MID / LUNCH / PM buckets
 * used by the discriminator analysis. Identical thresholds to p26.
 *
 * Input is a UTC Date (the natural shape of TIMESTAMPTZ from Postgres).
 * The bucket is determined from the CT-localized hour/minute via
 * `getCTTime`, which uses Intl.DateTimeFormat — handles CDT/CST cleanly.
 */
export function getTimeOfDay(triggerUtc: Date): TimeOfDay {
  const { hour, minute } = getCTTime(triggerUtc);
  return getTimeOfDayFromCtHourMin(hour, minute);
}

/**
 * Time-of-day bucketing from a CT timestamp expressed as hours+min.
 * Exposed separately so cron handlers that already have the CT hour/min
 * can avoid a Date round-trip.
 */
export function getTimeOfDayFromCtHourMin(
  hour: number,
  minute: number,
): TimeOfDay {
  const h = hour + minute / 60;
  if (h < 9.5) return 'AM_open';
  if (h < 11.5) return 'MID';
  if (h < 12.5) return 'LUNCH';
  return 'PM';
}

/** Map ask-side fraction to the dominant-side label used in flow_quad. */
export function getDominantSide(askPct: number): 'ask' | 'bid' | 'mixed' {
  if (askPct >= 0.6) return 'ask';
  if (askPct <= 0.4) return 'bid';
  return 'mixed';
}

/**
 * Compose flow_quad from option type + ask-side fraction. Matches p26.
 */
export function buildFlowQuad(optionType: 'C' | 'P', askPct: number): string {
  const sideLabel = getDominantSide(askPct);
  const typeLabel = optionType === 'C' ? 'call' : 'put';
  return `${typeLabel}_${sideLabel}`;
}

/**
 * Mode B in-play gate — Python p26 requires `|strike/spot - 1| ≤ 0.10`
 * (the `in_play` mask). Far-OTM stock contracts on a Mode B ticker are
 * suppressed because the v4 detector's IV/delta thresholds are noisy
 * out there and the trade dynamics aren't lottery-shaped.
 */
const LOTTERY_MODE_B_IN_PLAY_PCT = 0.1;

/**
 * Classify a chain into Mode A, Mode B, or OUT_OF_UNIVERSE.
 *
 * Mode A (intraday 0DTE scalp): V3 ticker list ∪ {SPY, IWM}, DTE = 0,
 * ask% ≥ 0.52. No moneyness gate.
 *
 * Mode B (multi-day trend): EXTENDED list \ {SPY, IWM}, DTE 1-3,
 * ask% ≥ 0.52, AND |strike/spot - 1| ≤ 0.10 (the in_play gate from p26).
 *
 * Returns 'OUT_OF_UNIVERSE' when the chain doesn't fit either mode —
 * the cron filters those out before insertion. We keep them in the
 * record type for completeness so callers don't lose visibility into
 * why a fire was suppressed.
 */
export function classifyMode(
  ticker: string,
  dte: number,
  askPct: number,
  strike: number,
  spot: number,
): LotteryMode {
  if (askPct < LOTTERY_SPEC_V4.askPctMin) return 'OUT_OF_UNIVERSE';
  const tickerUpper = ticker.toUpperCase();
  // Mode A: V3 list + SPY + IWM, DTE = 0. No moneyness gate.
  if (
    dte === 0 &&
    (LOTTERY_V3_TICKERS as readonly string[]).includes(tickerUpper)
  ) {
    return 'A_intraday_0DTE';
  }
  // Mode B: extended list (excluding SPY/IWM), DTE 1-3, in-play.
  if (
    dte > 0 &&
    dte <= 3 &&
    (LOTTERY_EXTENDED_TICKERS as readonly string[]).includes(tickerUpper) &&
    tickerUpper !== 'SPY' &&
    tickerUpper !== 'IWM' &&
    spot > 0 &&
    Math.abs(strike / spot - 1) <= LOTTERY_MODE_B_IN_PLAY_PCT
  ) {
    return 'B_multi_day_DTE1_3';
  }
  return 'OUT_OF_UNIVERSE';
}

/**
 * RE-LOAD tag — fires when this fire's burst is ≥2× the prior fire's
 * burst AND entry price has dropped ≥30% since the prior fire on the
 * same chain. The SNDK 1175C 5/1 fire #4 archetype.
 */
export function isReload(
  burstRatioVsPrev: number | null,
  entryDropPctVsPrev: number | null,
): boolean {
  if (burstRatioVsPrev == null || entryDropPctVsPrev == null) return false;
  return burstRatioVsPrev >= 2 && entryDropPctVsPrev <= -30;
}

/**
 * Cheap-call-PM tag — the Phase 1 selection rule on top of RE-LOAD.
 * 18.9% historical lottery rate vs 9.1% on RE-LOAD baseline.
 */
export function isCheapCallPm(
  optionType: 'C' | 'P',
  entryPrice: number,
  tod: TimeOfDay,
): boolean {
  return optionType === 'C' && tod === 'PM' && entryPrice < 1;
}

// ============================================================
// Detector core
// ============================================================

/**
 * Run the v4 detector on a single chain's per-tick stream for one day.
 *
 * Returns all qualifying fires (cooldown-filtered). Caller is responsible
 * for filtering canceled trades and price>0 before passing in.
 *
 * NOTE on tick ordering: ticks must be sorted by executedAt ascending.
 * The function does not re-sort because the cron passes pre-sorted rows
 * straight from a Postgres ORDER BY.
 *
 * `priorLastFireMs` (optional) seeds the cooldown gate from a fire that
 * landed before the current tick window — used by the cron handler to
 * persist the 5-min cooldown across invocations. Without it, a 1-min
 * cron with a 7-min scan window re-qualifies the next available tick
 * each run and emits a duplicate fire with a slightly later timestamp.
 */
export function detectChainFires(
  ticks: OptionTradeTick[],
  oi: number,
  dte: number,
  priorLastFireMs: number | null = null,
): LotteryFire[] {
  if (dte > LOTTERY_SPEC_V4.dteMax || oi <= 0) return [];
  if (ticks.length < LOTTERY_SPEC_V4.cntWindowMin) return [];

  const n = ticks.length;
  const windowMs = LOTTERY_WINDOW_MIN * 60 * 1000;
  const cooldownMs = LOTTERY_SPEC_V4.cooldownMin * 60 * 1000;

  // Cumulative size (for cum vol/OI).
  let cumVol = 0;
  // First-tick underlying spot — matches Python p14 `iloc[0]` exactly so
  // the TS detector can't silently emit fires on a stream Python would
  // skip (per feedback_no_silent_methodology_changes).
  const firstTick = ticks[0]!;
  if (firstTick.underlyingPrice == null || firstTick.underlyingPrice <= 0) {
    return [];
  }
  const spotAtFirst = firstTick.underlyingPrice;

  const fires: LotteryFire[] = [];
  // Seed from caller so the cooldown gate honors fires emitted in
  // prior cron invocations on the same chain.
  let lastFireTs: number | null = priorLastFireMs;

  // Two-pointer rolling window: windowStart slides right as ticks fall
  // out of the 5-min trailing window. Each iteration advances cumVol by
  // the current tick's size (so the trigger check uses the fresh sum).
  let windowStart = 0;
  let askSum = 0;
  let abSum = 0;
  let ivSum = 0;
  let ivCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  let sizeSum = 0;
  let printCount = 0;

  const applyTick = (t: OptionTradeTick, sign: 1 | -1): void => {
    if (t.side === 'ask') askSum += sign;
    if (t.side === 'ask' || t.side === 'bid') abSum += sign;
    if (t.impliedVolatility != null) {
      ivSum += sign * t.impliedVolatility;
      ivCount += sign;
    }
    if (t.delta != null) {
      deltaSum += sign * t.delta;
      deltaCount += sign;
    }
    sizeSum += sign * t.size;
    printCount += sign;
  };

  for (let i = 0; i < n; i++) {
    const cur = ticks[i]!;
    applyTick(cur, 1);
    cumVol += cur.size;
    const tsMs = cur.executedAt.getTime();

    // Slide windowStart forward until every tick in [windowStart, i] is
    // strictly within the trailing 5-min window. Pandas `rolling('5min')`
    // is closed='right' = (t-5min, t], so a tick at exactly t-5min is
    // EXCLUDED. Hence `>=`, not `>`.
    while (
      windowStart < i &&
      tsMs - ticks[windowStart]!.executedAt.getTime() >= windowMs
    ) {
      applyTick(ticks[windowStart]!, -1);
      windowStart += 1;
    }

    if (printCount < LOTTERY_SPEC_V4.cntWindowMin) continue;

    const volToOiWindow = sizeSum / oi;
    if (volToOiWindow < LOTTERY_SPEC_V4.volToOiWindowMin) continue;

    const volToOiCum = cumVol / oi;
    if (volToOiCum < LOTTERY_SPEC_V4.volToOiCumMin) continue;

    if (ivCount === 0) continue;
    const ivMean = ivSum / ivCount;
    if (ivMean < LOTTERY_SPEC_V4.ivMin) continue;

    if (deltaCount === 0) continue;
    const deltaMean = deltaSum / deltaCount;
    if (Math.abs(deltaMean) < LOTTERY_SPEC_V4.absDeltaMin) continue;

    if (abSum === 0) continue;
    const askPct = askSum / abSum;
    if (askPct < LOTTERY_SPEC_V4.askPctMin) continue;

    // Cooldown gate.
    if (lastFireTs != null && tsMs - lastFireTs < cooldownMs) continue;

    // Entry = next print (or current if last in series).
    const entryIdx = Math.min(i + 1, n - 1);
    const entry = ticks[entryIdx]!;
    if (entry.price <= 0) continue;

    fires.push({
      triggerTimeCt: cur.executedAt,
      entryTimeCt: entry.executedAt,
      entryPrice: entry.price,
      triggerVolToOiWindow: volToOiWindow,
      triggerVolToOiCum: volToOiCum,
      triggerIv: ivMean,
      triggerDelta: deltaMean,
      triggerAskPct: askPct,
      triggerWindowPrints: printCount,
      triggerWindowSize: sizeSum,
      openInterest: oi,
      spotAtFirst,
      alertSeq: 0, // tagged below
      minutesSincePrevFire: 0,
    });
    lastFireTs = tsMs;
  }

  // Tag alert_seq + minutes_since_prev_fire.
  for (let k = 0; k < fires.length; k++) {
    const f = fires[k]!;
    f.alertSeq = k + 1;
    if (k === 0) {
      f.minutesSincePrevFire = 0;
    } else {
      const prev = fires[k - 1]!;
      f.minutesSincePrevFire =
        (f.triggerTimeCt.getTime() - prev.triggerTimeCt.getTime()) / 60_000;
    }
  }
  return fires;
}

// ============================================================
// Per-fire enrichment (RE-LOAD, cheap-call-PM, mode, flow_quad, tod)
// ============================================================

/**
 * Enrich a chain's bare fires with per-fire discriminators. Caller
 * provides the trading date (CT) and the contract metadata that doesn't
 * vary by fire. The returned records are ready to insert into
 * lottery_finder_fires verbatim (modulo the macro snapshot, which is
 * attached separately by the cron handler).
 *
 * Notes on RE-LOAD computation: burstRatio + entryDrop are computed
 * within the chain's own fire stream — they are NULL on alertSeq=1.
 */
export function enrichFires(
  fires: LotteryFire[],
  meta: {
    date: string;
    optionChainId: string;
    underlyingSymbol: string;
    optionType: 'C' | 'P';
    strike: number;
    expiry: string;
    dte: number;
  },
): LotteryFireRecord[] {
  const out: LotteryFireRecord[] = [];
  for (let i = 0; i < fires.length; i++) {
    const f = fires[i]!;
    const prev = i > 0 ? fires[i - 1]! : null;
    const burstRatioVsPrev =
      prev && prev.triggerWindowSize > 0
        ? f.triggerWindowSize / prev.triggerWindowSize
        : null;
    const entryDropPctVsPrev =
      prev && prev.entryPrice > 0
        ? ((f.entryPrice - prev.entryPrice) / prev.entryPrice) * 100
        : null;

    const tod = getTimeOfDay(f.triggerTimeCt);
    const flowQuad = buildFlowQuad(meta.optionType, f.triggerAskPct);
    const mode = classifyMode(
      meta.underlyingSymbol,
      meta.dte,
      f.triggerAskPct,
      meta.strike,
      f.spotAtFirst,
    );
    const reloadTagged = isReload(burstRatioVsPrev, entryDropPctVsPrev);
    const cheapCallPmTagged = isCheapCallPm(meta.optionType, f.entryPrice, tod);

    out.push({
      ...f,
      ...meta,
      mode,
      flowQuad,
      tod,
      reloadTagged,
      cheapCallPmTagged,
      burstRatioVsPrev,
      entryDropPctVsPrev,
    });
  }
  return out;
}
