/**
 * Outcome definitions for periscope_lottery_fires, shared by the two
 * writers of the outcome columns:
 *
 *   - api/cron/enrich-periscope-lottery-outcomes.ts reads the trade tape
 *     (ws_option_trades, 2-day retention) for recent fires.
 *   - scripts/backfill-periscope-lottery-outcomes.ts reads UW per-contract
 *     minute bars (/option-contract/{id}/intraday) for fires older than
 *     that retention.
 *
 * Both take their windows from `periscopeFireWindow`, so they cannot drift
 * apart on what "peak", "EOD" and "settled" mean.
 *
 * ── Trade-tape definitions (the cron; the source of truth) ──────────────
 *   peak_px       MAX(price) over prints in [fire_time, horizon_end]
 *   peak_time     earliest print at that price
 *   eod_close_px  last print in [fire_time, close_cutoff]
 *   R             (px - entry_px) / entry_px; peak_pct = peak_px / entry_px
 *   prints = SPXW, same expiry/strike/type, canceled = FALSE, price > 0.
 *   entry_px is the first such print in [fire_time, fire_time + 5 min]
 *   (PERISCOPE_LOTTERY_ENTRY_WINDOW_MINUTES; periscope-lottery-finder.ts
 *   fetchEntryPx), so it is itself a print in both windows.
 *
 * ── Minute-bar mapping (the backfill) ────────────────────────────────────
 * A UW bar [start, start + 60 s) carries the OHLC of that minute's prints.
 * The parser rejects any bar that does not start on a minute boundary.
 * Fire times carry seconds (e.g. 13:49:22.776), so a window edge usually
 * falls INSIDE a bar. Each bar is classified against the closed peak window
 * [F, H]:
 *   head      start < F < start + 60 s — mixes pre-fire and post-fire
 *             prints;
 *   interior  wholly inside [F, H] — every print counts;
 *   tail      H - 60 s < start < H — mixes in-window and late prints.
 * A bar that starts exactly at a window end holds only that one
 * millisecond inside the window. It is treated as outside, and so is a
 * print stamped exactly at a cutoff. That is the only deliberate
 * approximation.
 *
 *   entry in the head  The entry print is the first print at or after F.
 *            If it is not in the head minute, it is the open of the next
 *            bar, inside the entry window. So unless the next bar opens at
 *            entry_px inside that window, the entry is in the head, and
 *            the head must bracket entry_px. If it does not, UW's bars
 *            disagree with the tape: 'bars_miss_entry'.
 *   peak_px  The provable lower bound LB = max(entry_px, interior highs,
 *            and head.close when the entry print is provably in the head
 *            minute, since the head's last print then follows the entry).
 *            The upper bound UB also counts the head and tail highs. When
 *            UB > LB, an edge minute may hold the peak, or may hold only an
 *            out-of-window print above it. The fire ABSTAINS
 *            ('ambiguous_peak') rather than guess.
 *   peak_time  Minute precision: the start of the earliest bar whose high
 *            is the peak. In the head minute it is clamped to fire_time,
 *            and is used only when the head's at-peak print is provably
 *            post-fire (it is entry_px or head.close). When the head ties
 *            the peak without that proof and a later bar also reaches it,
 *            the minute is undecidable. peak_time is then NULL while the
 *            prices and R still lock. The cron's peak_time keeps the exact
 *            print time.
 *   eod      close of the last bar wholly inside [F, close_cutoff). The
 *            head minute's close counts only when the entry print is
 *            provably in it; otherwise the result is 'ambiguous_eod'.
 *   R / peak_pct  The cron's formulas, unchanged.
 *
 * Settlement and liveness, both checked by the caller:
 *   - A fire is settled once `settledAt` has passed:
 *     min(max(H, close_cutoff), contract close). The contract close is
 *     getMarketCloseHourET, so 12:00 CT on early-close days.
 *   - The tape-tail rule: no outcome is written unless some bar lies
 *     wholly inside [tailStart, settledAt]. That bar comes from the trade
 *     tape (cron) or from any contract fetched for that day (backfill).
 *     A silent tail means the source may have stopped early.
 *
 * Specs: docs/superpowers/specs/periscope-lottery-alerts-2026-05-19.md
 * (outcome definitions) and
 * docs/superpowers/specs/periscope-lottery-outcome-backfill-2026-10-02.md
 * (minute-bar backfill, thresholds, parity results).
 */

import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';
import { eodCtForTrigger } from './flow-inversion.js';
import {
  PERISCOPE_LOTTERY_ENTRY_WINDOW_MINUTES,
  PERISCOPE_LOTTERY_THRESHOLDS,
} from './periscope-lottery-types.js';

export type PeriscopeLotteryFireType = 'call_lottery' | 'put_lottery';

/** SPXW prints every few seconds into the close, so a silent 10 min = feed down. */
const TAPE_TAIL_MINUTES = 10;

const MINUTE_MS = 60_000;

/** entry_px is the first print within this long after fire_time. */
const ENTRY_WINDOW_MS = PERISCOPE_LOTTERY_ENTRY_WINDOW_MINUTES * MINUTE_MS;

/**
 * Two prices are the same print price when they differ by less than half a
 * NUMERIC(10,4) unit. Option prices sit on a $0.01 grid; this only absorbs
 * float noise from parsing '0.35' vs NUMERIC '0.3500'.
 */
const PRICE_EPS = 5e-5;

export interface PeriscopeFireWindow {
  fireTime: Date;
  /** fire_time + hold (120 min call_lottery, 180 min put_lottery). */
  horizonEnd: Date;
  /** 15:00 CT on the fire's day (DST-aware): the EOD print cutoff. */
  closeCutoff: Date;
  /** No print can land in the read window after this instant. */
  settledAt: Date;
  /** Tape-liveness tail: [max(fireTime, settledAt - tail), settledAt]. */
  tailStart: Date;
}

/** Hold horizon per filter — PERISCOPE_LOTTERY_THRESHOLDS is the source. */
function holdMinutes(fireType: PeriscopeLotteryFireType): number {
  return fireType === 'call_lottery'
    ? PERISCOPE_LOTTERY_THRESHOLDS.CALL.HOLD_MINUTES
    : PERISCOPE_LOTTERY_THRESHOLDS.PUT.HOLD_MINUTES;
}

/**
 * When SPXW on this expiry stops trading: the NYSE close in ET (16:00, or
 * 13:00 on early-close days) — 15:00 / 12:00 CT. No print can land later
 * (the fires are 0DTE, making this the fire-day close).
 */
function expiryClose(expiry: string): Date {
  const closeHourEt = getMarketCloseHourET(expiry) ?? 16;
  const iso = etWallClockToUtcIso(expiry, closeHourEt * 60);
  // Unparseable expiry (DATE NOT NULL, so not expected): regular close.
  return iso === null
    ? eodCtForTrigger(new Date(`${expiry}T17:00:00Z`))
    : new Date(iso);
}

/**
 * The read windows for one fire. Settled = no more prints can land in
 * [fireTime, readEnd]: the window has passed, or the contract has stopped
 * trading (a late fire's horizon can run past the close; on early-close
 * days that is 12:00 CT).
 */
export function periscopeFireWindow(
  fireType: PeriscopeLotteryFireType,
  fireTime: Date,
  expiry: string,
): PeriscopeFireWindow {
  const horizonEnd = new Date(
    fireTime.getTime() + holdMinutes(fireType) * MINUTE_MS,
  );
  // 15:00 CT (DST-aware) — 20:00 UTC during CDT, 21:00 UTC during CST.
  const closeCutoff = eodCtForTrigger(fireTime);
  const readEnd = horizonEnd > closeCutoff ? horizonEnd : closeCutoff;
  const contractClose = expiryClose(expiry);
  const settledAt = readEnd < contractClose ? readEnd : contractClose;
  const tailFloor = new Date(
    settledAt.getTime() - TAPE_TAIL_MINUTES * MINUTE_MS,
  );
  return {
    fireTime,
    horizonEnd,
    closeCutoff,
    settledAt,
    tailStart: tailFloor > fireTime ? tailFloor : fireTime,
  };
}

// ── Minute bars ──────────────────────────────────────────────────────────

/** One UW minute bar: OHLC of the prints in [start, start + 60 s). */
export interface MinuteBar {
  start: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type BarAbstainReason =
  /** UW's bars cannot hold the entry print where it must be: they disagree with the tape. */
  | 'bars_miss_entry'
  /** An edge minute's high exceeds every provably in-window price. */
  | 'ambiguous_peak'
  /** The only EOD candidate is the head minute, with no post-fire print proven. */
  | 'ambiguous_eod';

export interface BarOutcomeValues {
  peakPx: number;
  peakPct: number;
  /** Minute precision; null when the peak minute is undecidable. */
  peakTime: Date | null;
  /** null = no print in [fire_time, close_cutoff] (R_eod = -1, as the cron). */
  eodClosePx: number | null;
  realizedRPeak: number;
  realizedREod: number;
}

export type BarOutcome =
  | { kind: 'locked'; values: BarOutcomeValues }
  | { kind: 'abstain'; reason: BarAbstainReason };

const samePrice = (a: number, b: number): boolean =>
  Math.abs(a - b) < PRICE_EPS;

/** Last print instant a bar can hold (ms resolution). */
const barEnd = (b: MinuteBar): number => b.start.getTime() + MINUTE_MS - 1;

/**
 * Turn one contract-day's minute bars into the cron's outcome for one fire,
 * or abstain when the bars cannot prove it. Pure: no I/O, no clock. The
 * caller has already checked that the fire is settled and its tape tail
 * live (see `barTapeLive`).
 */
export function outcomeFromMinuteBars(
  w: PeriscopeFireWindow,
  entryPx: number,
  bars: readonly MinuteBar[],
): BarOutcome {
  const fireMs = w.fireTime.getTime();
  const horizonMs = w.horizonEnd.getTime();
  const cutoffMs = w.closeCutoff.getTime();
  const sorted = [...bars].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  // Bars that hold at least one print at or after fire_time.
  const fromFire = sorted.filter((b) => barEnd(b) >= fireMs);

  // The entry print lies in [F, F + 5 min]; some bar there must bracket it,
  // or UW's data disagrees with the tape the fire was entered on.
  const entryWindowEnd = fireMs + ENTRY_WINDOW_MS;
  const entryBracketed = fromFire.some(
    (b) =>
      b.start.getTime() <= entryWindowEnd &&
      b.low - PRICE_EPS <= entryPx &&
      entryPx <= b.high + PRICE_EPS,
  );
  if (!entryBracketed) return { kind: 'abstain', reason: 'bars_miss_entry' };

  // The head minute straddles fire_time; it exists only when fire_time
  // carries seconds. Every later bar starts at or after fire_time.
  const head = fromFire.find((b) => b.start.getTime() < fireMs);
  const afterHead = fromFire.filter((b) => b.start.getTime() >= fireMs);
  // Entry is NOT in the head only if it is the first print after it — the
  // open of the next bar, inside the entry window. Otherwise it IS in the
  // head, which must then bracket entry_px.
  const next = afterHead[0];
  const nextMayHoldEntry =
    next !== undefined &&
    next.start.getTime() <= entryWindowEnd &&
    samePrice(next.open, entryPx);
  const entryInHead = head !== undefined && !nextMayHoldEntry;
  if (
    head !== undefined &&
    entryInHead &&
    !(head.low - PRICE_EPS <= entryPx && entryPx <= head.high + PRICE_EPS)
  ) {
    // The only place the entry print can be has no such price: the bars
    // and the tape disagree, so head.close proves nothing.
    return { kind: 'abstain', reason: 'bars_miss_entry' };
  }

  // ── Peak over [F, H] ──
  const interior = afterHead.filter((b) => barEnd(b) <= horizonMs);
  const tail = afterHead.find(
    (b) => b.start.getTime() < horizonMs && barEnd(b) > horizonMs,
  );
  let lower = entryPx;
  for (const b of interior) lower = Math.max(lower, b.high);
  // The head's close is post-fire once the entry print is in the head.
  if (head !== undefined && entryInHead) lower = Math.max(lower, head.close);
  let upper = lower;
  if (head !== undefined) upper = Math.max(upper, head.high);
  if (tail !== undefined) upper = Math.max(upper, tail.high);
  if (!samePrice(upper, lower)) {
    return { kind: 'abstain', reason: 'ambiguous_peak' };
  }
  const peakPx = lower;

  // ── peak_time: earliest bar whose high is the peak ──
  // The head is the earliest candidate. Its at-peak print counts only when
  // it is provably post-fire: the entry print or the head's close.
  const firstInterior = interior.find((b) => samePrice(b.high, peakPx));
  let peakTime: Date | null;
  if (head !== undefined && samePrice(head.high, peakPx)) {
    const headProven =
      entryInHead &&
      (samePrice(entryPx, peakPx) || samePrice(head.close, peakPx));
    // Unproven: the head's print may be pre-fire, so the minute is undecidable.
    peakTime = headProven ? w.fireTime : null;
  } else {
    peakTime = firstInterior === undefined ? null : firstInterior.start;
  }

  // ── EOD: last print in [F, close_cutoff] ──
  // A bar straddling the cutoff would be partial. The cutoff is 15:00 CT
  // (minute-aligned), so this cannot happen — but never guess if it does.
  if (
    fromFire.some((b) => b.start.getTime() < cutoffMs && barEnd(b) > cutoffMs)
  ) {
    return { kind: 'abstain', reason: 'ambiguous_eod' };
  }
  let eodBar: MinuteBar | undefined;
  for (const b of fromFire) if (barEnd(b) <= cutoffMs) eodBar = b;
  // The head's close is post-fire only when the entry print is in the head.
  if (eodBar !== undefined && eodBar === head && !entryInHead) {
    return { kind: 'abstain', reason: 'ambiguous_eod' };
  }
  const eodClosePx = eodBar === undefined ? null : eodBar.close;

  return {
    kind: 'locked',
    values: {
      peakPx,
      peakPct: peakPx / entryPx,
      peakTime,
      eodClosePx,
      realizedRPeak: (peakPx - entryPx) / entryPx,
      realizedREod: eodClosePx === null ? -1 : (eodClosePx - entryPx) / entryPx,
    },
  };
}

/** Outcome columns as the cron stored them (NUMERIC(10,4), so rounded). */
export interface StoredOutcome {
  peakPx: number | null;
  peakPct: number | null;
  peakTime: Date | null;
  eodClosePx: number | null;
  realizedRPeak: number | null;
  realizedREod: number | null;
}

/**
 * Parity tolerance: half a NUMERIC(10,4) unit (the cron's stored values are
 * rounded to 4 dp; the bar values are not) plus float noise. Tick rounding
 * only — any real price difference is at least $0.01.
 */
const PARITY_TOLERANCE = 5e-5 + 1e-9;

const closeOrBothNull = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= PARITY_TOLERANCE;

/** One outcome column on which the bars disagree with the cron. */
export interface ParityMismatch {
  column: string;
  cron: string;
  bars: string;
}

const show = (v: number | Date | null): string =>
  v instanceof Date ? v.toISOString() : String(v);

/**
 * The outcome columns on which a bar-derived outcome disagrees with what the
 * cron stored for the same fire. An empty list means parity. peak_time is
 * compared at minute precision; a NULL bar peak_time (undecidable minute) is
 * not a disagreement, because the backfill writes NULL there rather than a
 * guess.
 */
export function barParityMismatches(
  stored: StoredOutcome,
  bars: BarOutcomeValues,
): ParityMismatch[] {
  const numeric: [string, number | null, number | null][] = [
    ['peak_px', stored.peakPx, bars.peakPx],
    ['peak_pct', stored.peakPct, bars.peakPct],
    ['eod_close_px', stored.eodClosePx, bars.eodClosePx],
    ['realized_r_peak', stored.realizedRPeak, bars.realizedRPeak],
    ['realized_r_eod', stored.realizedREod, bars.realizedREod],
  ];
  const out: ParityMismatch[] = [];
  for (const [column, cron, barValue] of numeric) {
    if (!closeOrBothNull(cron, barValue)) {
      out.push({ column, cron: show(cron), bars: show(barValue) });
    }
  }
  if (bars.peakTime !== null) {
    const minute = (d: Date): number =>
      Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS;
    if (
      stored.peakTime === null ||
      minute(stored.peakTime) !== minute(bars.peakTime)
    ) {
      out.push({
        column: 'peak_time',
        cron: show(stored.peakTime),
        bars: show(bars.peakTime),
      });
    }
  }
  return out;
}

/**
 * The tape-tail rule on minute bars: true when some bar lies wholly inside
 * [tailStart, settledAt]. Pass every bar fetched for the fire's day (any
 * contract), mirroring the cron's any-SPXW-print probe.
 */
export function barTapeLive(
  w: PeriscopeFireWindow,
  dayBars: Iterable<MinuteBar>,
): boolean {
  const tailMs = w.tailStart.getTime();
  const settledMs = w.settledAt.getTime();
  for (const b of dayBars) {
    const s = b.start.getTime();
    if (s >= tailMs && s + MINUTE_MS - 1 <= settledMs) return true;
  }
  return false;
}
