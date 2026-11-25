/**
 * The cash-open day-analog builder: ES one-minute bars in, 08:30 CT window
 * fingerprints, prediction-only summaries and full-session range labels
 * out. The core functions do no I/O; `buildDayAnalogWindows`, at the bottom,
 * is the one read and decides which windows are finished.
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
 * The read span is part of the rule set. `buildDayAnalogWindows` reads
 * exactly the bars in [07:30 CT, session end + 1 min), so the labels' bar
 * after the session can only be the 15:00 bar (12:00 on a half day), while
 * a window's bar after is the first later bar in that span, whatever its
 * minute. A port must trim its series to exactly that span before it applies
 * the rules below. Without the trim, a missing 15:00 bar plus a 15:01 bar
 * 20 pt off the 14:59 close would be `flagged` instead of `ok`.
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
 *     that is not finite or is negative. It checks the whole bar, all four
 *     prices and the volume, on every window or session bar and on the bar
 *     before the anchor and the bar after the last one, not only the close
 *     and open the gap rule reads. NUMERIC can hold `NaN`, which compares
 *     false with everything, so it must be refused here, before it reaches
 *     a vector, a range or the gap rule. A price text that does not parse
 *     is `bad_bar` too: JS `Number('abc')` is NaN, but Python
 *     `float('abc')` raises, so a port must map the error to `bad_bar`.
 *   - `mixed_contract`: two distinct non-null contracts after folding the
 *     spelling to root, month code and last year digit (`ESZ26` is
 *     `ESZ6`), compared over the window or session bars only, not the bar
 *     before the anchor or the bar after the last one. A NULL contract is
 *     unknown and is accepted. A window's `contract` is that one folded
 *     name, or null when every bar's contract is NULL.
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
 *
 * Callers of `buildDayAnalogWindows` (P1b): `asOf` must be a valid Date, as
 * an invalid one drops every bar and returns `no_anchor` everywhere. A
 * backtest passes the simulated analysis time. On a trading day, a
 * `no_anchor` from a window that is ready (the 15-minute window at
 * 08:46:15 CT) means the read had no anchor bar: surface it as an outage.
 */

import {
  cashSessionMinutes,
  isTradingDay,
} from '../../src/data/marketHours.js';
import { ctWallClockToUtcIso } from '../../src/utils/timezone.js';
import { SESSION_OPEN_MIN_CT } from './constants.js';
import { fetchFuturesBars, type StoredFuturesBar } from './futures-bars.js';
import { formatDelta, formatVolume } from './postgres-day-summary.js';

export const DAY_ANALOG_FEATURE_SET = 'cash_open_pct_change_v2';
export const ANALOG_WINDOW_MINUTES = [15, 30, 60] as const;
export type AnalogWindowMinutes = (typeof ANALOG_WINDOW_MINUTES)[number];
export const CASH_OPEN_MIN_CT = SESSION_OPEN_MIN_CT;
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
 * Not the `canonicalContract` of `futures-contracts.ts`: that one is called
 * with a root, a contract symbol and a reference time, `(root, sym, refIso)`,
 * and pulls in the UW client, and this check only compares the names of two
 * bars.
 */
function foldEsContract(contract: string): string {
  return contract.replace(/^(ES[FGHJKMNQUVXZ])\d?(\d)$/, '$1$2');
}

/**
 * The 08:30 CT open of `date` as a UTC instant in ms, or null when `date`
 * is not a trading day. The one place the anchor instant is derived.
 */
function cashOpenMs(date: string): number | null {
  const iso = isTradingDay(date)
    ? ctWallClockToUtcIso(date, CASH_OPEN_MIN_CT)
    : null;
  return iso === null ? null : Date.parse(iso);
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
  const anchorMs = cashOpenMs(date);
  if (anchorMs === null) return { ok: false, reason: 'not_trading_day' };

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
      summary: formatWindowSummary(fields),
      bars: slice.length,
      contract,
    },
  };
}

/** What the summary line reads from a window, so it can be built first. */
export type SummaryFields = Pick<
  AnalogWindow,
  'nMinutes' | 'open' | 'close' | 'high' | 'low' | 'volume'
>;

/**
 * The prediction-only summary line: open, the N-minute delta, high, low,
 * range and volume. Nothing after minute N−1 and no date.
 */
export function formatWindowSummary(w: SummaryFields): string {
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

/** One date's results: a window per ANALOG_WINDOW_MINUTES, then the labels. */
export interface DayAnalogBuild {
  date: string;
  windows: WindowResult[]; // in ANALOG_WINDOW_MINUTES order
  labels: LabelResult;
}

/**
 * The read starts an hour before the open. The anchor's gap check compares
 * it with the nearest earlier bar, which on a thin pre-open can be some
 * minutes back.
 */
const LEAD_IN_MINUTES = 60;

/** The stored bar as the core takes it. A malformed price text stays NaN. */
function toAnalogBar(row: StoredFuturesBar): AnalogBar {
  return {
    ts: row.ts,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume,
    contract: row.contract,
  };
}

/**
 * Reads the ES bars for `date` (CT) once and builds its windows and labels
 * as of `asOf`.
 *
 * - A non-trading day is refused `not_trading_day` without a read.
 * - The read runs from 07:30 CT to one minute past the session end. Its end
 *   is exclusive, so it includes the bar after the session, which the gap
 *   check on the last close needs.
 * - A bar counts only once it has finished (`ts` + 1 minute ≤ `asOf`), so a
 *   bar still forming never reaches the series.
 * - A window (or the session, for the labels) is `incomplete` until its end
 *   plus WINDOW_GRACE_MS. uw-stream writes minute M only once a print in
 *   minute M+1 arrives, so the grace lets the last bar and the bar after it
 *   land before the gap check reads them (plan decision 8).
 *
 * A database error rejects. The callers decide how to degrade.
 */
export async function buildDayAnalogWindows(
  date: string,
  asOf: Date = new Date(),
): Promise<DayAnalogBuild> {
  const anchorMs = cashOpenMs(date);
  if (anchorMs === null) {
    return {
      date,
      windows: ANALOG_WINDOW_MINUTES.map(
        (nMinutes): WindowResult => ({
          ok: false,
          nMinutes,
          reason: 'not_trading_day',
        }),
      ),
      labels: { ok: false, reason: 'not_trading_day' },
    };
  }

  // A zone change falls on a Sunday at 02:00 local, so on a trading day the
  // minutes either side of the 08:30 CT open are elapsed minutes.
  const sessionMinutes = cashSessionMinutes(date);
  const stamp = (minutesFromOpen: number): string =>
    new Date(anchorMs + minutesFromOpen * MS_PER_MINUTE).toISOString();
  const asOfMs = asOf.getTime();
  const series = (
    await fetchFuturesBars(
      'ES',
      stamp(-LEAD_IN_MINUTES),
      stamp(sessionMinutes + 1),
    )
  )
    .filter((row) => Date.parse(row.ts) + MS_PER_MINUTE <= asOfMs)
    .map(toAnalogBar);
  const incomplete = (minutes: number): boolean =>
    asOfMs < anchorMs + minutes * MS_PER_MINUTE + WINDOW_GRACE_MS;

  return {
    date,
    windows: ANALOG_WINDOW_MINUTES.map(
      (nMinutes): WindowResult =>
        incomplete(nMinutes)
          ? { ok: false, nMinutes, reason: 'incomplete' }
          : buildCashWindow(date, nMinutes, series),
    ),
    labels: incomplete(sessionMinutes)
      ? { ok: false, reason: 'incomplete' }
      : cashSessionLabels(date, series),
  };
}
