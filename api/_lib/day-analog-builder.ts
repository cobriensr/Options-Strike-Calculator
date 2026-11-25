/**
 * The cash-open day-analog builder's pure core: ES one-minute bars in,
 * 08:30 CT window fingerprints, prediction-only summaries and full-session
 * range labels out. No I/O; the async read lands on top of these exports.
 *
 * Spec: `docs/superpowers/specs/day-analogs-rebuild-2026-10-02.md`
 * ("Window decision", "P1 - P1a"). Plan:
 * `docs/superpowers/plans/2026-11-24-day-analogs-p1a.md`.
 *
 * The window, for minutes 0..N-1 after the 08:30 CT open (America/Chicago,
 * so DST is handled): take each bar's close, carried forward over missing
 * minutes, divide by the open of the 08:30 bar and subtract 1.
 *
 * `bars` is the whole ts-sorted series the caller read, lead-in included,
 * with whole-minute UTC stamps. Each function picks its own bars by the
 * minute relative to the 08:30 anchor, so the gap check can see the bar
 * before the anchor and the bar after the last one.
 *
 * Every rule below is mirrored by P2's Python writer
 * (`ml/src/day_analog_backfill.py`), which must pass every case in
 * `api/__tests__/fixtures/day-analog-parity.json` (plan decisions 6, 10
 * and 12):
 *
 *   - Window bars are relative minutes 0..N-1; session bars are relative
 *     minutes 0..cashSessionMinutes(date)-1 (390, or 210 on a half day).
 *     Nothing later is read, except the bar after the last one for the gap
 *     check.
 *   - The checks run in this order; the first failure names the refusal:
 *     `not_trading_day`, `no_anchor` (no bar stamped exactly 08:30 CT),
 *     `too_few_bars` (a window under MIN_BARS; a session under
 *     cashSessionMinutes), `bad_bar`, `mixed_contract`, `flagged`.
 *   - `bad_bar`: a price that is not finite or not above 0, or a volume
 *     that is not finite or is negative. It covers the bar before the
 *     anchor and the bar after the last one, because the gap check reads
 *     their close and open. NUMERIC can hold `NaN`, which compares false
 *     with everything, so it must be refused here, before it reaches a
 *     vector, a range or the gap rule.
 *   - `mixed_contract`: two distinct non-null contracts after folding the
 *     spelling to root, month code and last year digit (`ESZ26` is
 *     `ESZ6`). A NULL contract is unknown and is accepted.
 *   - `flagged` (open gap only): a bar has a gap when its open is more
 *     than PROXY_JUMP_PTS from the close of the neighbouring bar before it
 *     in the series, whatever that bar's minute. A window or session is
 *     flagged when one of its bars, or the first bar after its last one,
 *     has a gap. A reverting close spike with no open gap is a real fast
 *     move and is kept. No date span is excluded.
 *   - What is aggregated, over the bars present in the window or session
 *     (the slice above, not the bar after it): `high` is the largest high,
 *     `low` the smallest low, `volume` the sum of volume and `bars` the
 *     count. A window's `open` is the anchor bar's open and its `close` is
 *     the last bar's close (the close carried to minute N-1). The labels,
 *     in ES points: `open` is the anchor bar's open, `close` the last
 *     session bar's close, `rangePt` = high - low, `upExc` = high - open
 *     and `downExc` = open - low.
 *   - The summary line has no date and a generic `ES` symbol. Prices print
 *     with two decimals and the delta with its sign (`+12.25`, `-3.50`,
 *     `+0.00` for zero). The volume is formatted from a float: `v / 1000`
 *     to one decimal with a `K` from 1,000, `v / 1e6` to two decimals with
 *     an `M` from 1,000,000, the bare integer below that. That is
 *     `toFixed`, which rounds the exact binary value of the float half up,
 *     so an exact tie rounds up (`(412.25).toFixed(1)` is `412.3`) and a
 *     float just below a decimal tie rounds down. P2's Python must divide
 *     as a float first (`v / 1000` or `v / 1e6`), then round that exact
 *     float value half up (`Decimal(float).quantize(...,
 *     ROUND_HALF_UP)`; Python's own formatting rounds a tie to even). It
 *     must never round the integer volume: 1,150 is `1.1K` because the
 *     float 1.15 sits just below the tie, and rounding 1150 would give
 *     `1.2K`. 999,999 prints `1000.0K`.
 */

import {
  cashSessionMinutes,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { ctWallClockToUtcIso } from '../../src/utils/timezone.js';
import { formatDelta, formatVolume } from './postgres-day-summary.js';

export const DAY_ANALOG_FEATURE_SET = 'cash_open_pct_change_v2';
export const ANALOG_WINDOW_MINUTES = [15, 30, 60] as const;
export type AnalogWindowMinutes = (typeof ANALOG_WINDOW_MINUTES)[number];
export const CASH_OPEN_MIN_CT = 8 * 60 + 30;
export const MIN_BARS = 10;
export const PROXY_JUMP_PTS = 15;
export const WINDOW_GRACE_MS = 75_000;

/** One ES minute bar; ts is the UTC ISO minute stamp. */
export interface AnalogBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  contract: string | null;
}

export type Refusal =
  | 'not_trading_day'
  | 'incomplete'
  | 'no_anchor'
  | 'too_few_bars'
  | 'bad_bar'
  | 'mixed_contract'
  | 'flagged';

export interface AnalogWindow {
  nMinutes: AnalogWindowMinutes;
  features: number[];
  summary: string;
  open: number;
  close: number; // last carried close, minute N−1
  high: number;
  low: number;
  volume: number;
  bars: number; // window bars present, ≤ N
  contract: string | null; // canonical, or null when every bar is NULL
}

export type WindowResult =
  | { ok: true; window: AnalogWindow }
  | { ok: false; nMinutes: AnalogWindowMinutes; reason: Refusal };

export interface CashSessionLabels {
  open: number;
  high: number;
  low: number;
  close: number;
  rangePt: number;
  upExc: number;
  downExc: number;
}

export type LabelResult =
  | { ok: true; labels: CashSessionLabels }
  | { ok: false; reason: Refusal };

const MS_PER_MINUTE = 60_000;

/** gaps[i]: i > 0 and |bars[i].open − bars[i−1].close| > PROXY_JUMP_PTS. */
export function openGaps(bars: readonly AnalogBar[]): boolean[] {
  return bars.map((bar, i) => {
    const previous = bars[i - 1];
    return (
      previous !== undefined &&
      Math.abs(bar.open - previous.close) > PROXY_JUMP_PTS
    );
  });
}

function isBadBar(bar: AnalogBar): boolean {
  const badPrice = [bar.open, bar.high, bar.low, bar.close].some(
    (price) => !Number.isFinite(price) || price <= 0,
  );
  return badPrice || !Number.isFinite(bar.volume) || bar.volume < 0;
}

/**
 * The one spelling of an ES contract: root, month code and the last year
 * digit, so `ESZ26` is `ESZ6`. Anything else passes through unchanged.
 * Not the `canonicalContract` of `futures-contracts.ts`: that one takes a
 * root and a reference date and pulls in the UW client, and this check only
 * compares the names of two bars.
 */
function foldEsContract(contract: string): string {
  return contract.replace(/^(ES[FGHJKMNQUVXZ])\d?(\d)$/, '$1$2');
}

type Selection =
  | {
      ok: true;
      anchor: AnalogBar;
      slice: AnalogBar[];
      contract: string | null;
    }
  | { ok: false; reason: Refusal };

/**
 * The shared checks, in order, over the bars at relative minutes
 * 0..count-1 from the 08:30 CT anchor. `minBars` is the fewest bars the
 * caller accepts in that range.
 */
function selectCashBars(
  date: string,
  bars: readonly AnalogBar[],
  count: number,
  minBars: number,
): Selection {
  const anchorIso = isTradingDay(date)
    ? ctWallClockToUtcIso(date, CASH_OPEN_MIN_CT)
    : null;
  if (anchorIso === null) return { ok: false, reason: 'not_trading_day' };

  const anchorMs = Date.parse(anchorIso);
  const anchor = bars.find((bar) => Date.parse(bar.ts) === anchorMs);
  if (anchor === undefined) return { ok: false, reason: 'no_anchor' };

  const anchorIndex = bars.indexOf(anchor);
  const tail = bars.slice(anchorIndex);
  const endMs = anchorMs + count * MS_PER_MINUTE;
  const cut = tail.findIndex((bar) => Date.parse(bar.ts) >= endMs);
  const slice = cut < 0 ? tail : tail.slice(0, cut);
  const before = bars[anchorIndex - 1];
  const after = cut < 0 ? undefined : tail[cut];

  if (slice.length < minBars) return { ok: false, reason: 'too_few_bars' };

  const checked = [before, ...slice, after];
  if (checked.some((bar) => bar !== undefined && isBadBar(bar))) {
    return { ok: false, reason: 'bad_bar' };
  }

  const contracts = new Set<string>();
  for (const bar of slice) {
    if (bar.contract !== null) contracts.add(foldEsContract(bar.contract));
  }
  if (contracts.size > 1) return { ok: false, reason: 'mixed_contract' };

  // The anchor's gap reads `before`; the bar after the last reads the last.
  const flagged = openGaps(bars)
    .slice(anchorIndex, anchorIndex + slice.length + 1)
    .some(Boolean);
  if (flagged) return { ok: false, reason: 'flagged' };

  return {
    ok: true,
    anchor,
    slice,
    contract: contracts.values().next().value ?? null,
  };
}

/** High, low, volume and last close over bars that already passed the checks. */
function aggregate(slice: readonly AnalogBar[]): {
  high: number;
  low: number;
  volume: number;
  close: number;
} {
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let volume = 0;
  let close = Number.NaN;
  for (const bar of slice) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    volume += bar.volume;
    close = bar.close;
  }
  return { high, low, volume, close };
}

/**
 * The 08:30 CT window of `nMinutes` for `date`: a percent-change vector
 * from the 08:30 open and its summary, or the first refusal.
 */
export function buildCashWindow(
  date: string,
  nMinutes: AnalogWindowMinutes,
  bars: readonly AnalogBar[],
): WindowResult {
  const selected = selectCashBars(date, bars, nMinutes, MIN_BARS);
  if (!selected.ok) return { ok: false, nMinutes, reason: selected.reason };

  const { anchor, slice, contract } = selected;
  const anchorMs = Date.parse(anchor.ts);
  const closeByMinute = new Map<number, number>(
    slice.map((bar) => [
      (Date.parse(bar.ts) - anchorMs) / MS_PER_MINUTE,
      bar.close,
    ]),
  );
  const features: number[] = [];
  let carried = anchor.close;
  for (let minute = 0; minute < nMinutes; minute++) {
    carried = closeByMinute.get(minute) ?? carried;
    features.push(carried / anchor.open - 1);
  }

  const { high, low, volume, close } = aggregate(slice);
  const fields = { nMinutes, open: anchor.open, close, high, low, volume };
  return {
    ok: true,
    window: {
      ...fields,
      features,
      summary: summaryLine(fields),
      bars: slice.length,
      contract,
    },
  };
}

/** What the summary line reads from a window, so it can be built first. */
type SummaryFields = Pick<
  AnalogWindow,
  'nMinutes' | 'open' | 'close' | 'high' | 'low' | 'volume'
>;

function summaryLine(w: SummaryFields): string {
  const n = w.nMinutes;
  return [
    'ES',
    `open ${w.open.toFixed(2)}`,
    `${n}m delta ${formatDelta(w.close - w.open)}`,
    `${n}m high ${w.high.toFixed(2)}`,
    `${n}m low ${w.low.toFixed(2)}`,
    `${n}m range ${(w.high - w.low).toFixed(2)}`,
    `${n}m vol ${formatVolume(w.volume)}`,
  ].join(' | ');
}

/**
 * The prediction-only summary line: open, the N-minute delta, high, low,
 * range and volume. Nothing after minute N−1 and no date.
 */
export function formatWindowSummary(w: AnalogWindow): string {
  return summaryLine(w);
}

/**
 * The full cash-session range labels from the 08:30 CT open: 390 bars, or
 * 210 on an early-close day. All of the session's bars must be present.
 */
export function cashSessionLabels(
  date: string,
  bars: readonly AnalogBar[],
): LabelResult {
  const minutes = cashSessionMinutes(date);
  const selected = selectCashBars(date, bars, minutes, minutes);
  if (!selected.ok) return { ok: false, reason: selected.reason };

  const { anchor, slice } = selected;
  const { high, low, close } = aggregate(slice);
  return {
    ok: true,
    labels: {
      open: anchor.open,
      high,
      low,
      close,
      rangePt: high - low,
      upExc: high - anchor.open,
      downExc: anchor.open - low,
    },
  };
}
