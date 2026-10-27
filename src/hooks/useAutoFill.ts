/**
 * useAutoFill — Auto-populates calculator inputs from live or historical data.
 *
 * Two responsibilities:
 *   1. Live auto-fill: When Schwab quotes arrive, populate empty fields
 *      (spot, SPX, VIX, VIX1D) and set the current time.
 *   2. History auto-fill: When a past date is selected, fill inputs from
 *      historical candle data; restore live data when switching back to today.
 *      A past date without intraday history still gets its own IV mode and
 *      σ: the static VIX1D table's value, else VIX mode on the date's daily
 *      VIX OHLC (useVixData). No past date gets today's live VIX1D or VIX.
 *
 * Also computes and returns `historySnapshot` — the resolved historical
 * state at the selected time (with VIX1D static fallback).
 *
 * Extracted from App.tsx to reduce the root component's complexity.
 */

import { useEffect, useRef } from 'react';
import type { AmPm, IVMode } from '../types';
import { IV_MODES } from '../constants';
import { toETTime } from '../utils/calculator';
import { getCTTime, getETToday } from '../utils/timezone';
import type { MarketDataState } from './useMarketData';
import type { UseVixDataReturn } from './useVixData';
import type { UseHistoryDataReturn, HistorySnapshot } from './useHistoryData';
import type { UseVix1dDataReturn } from './useVix1dData';

interface UseAutoFillInputs {
  // Refs tracking whether the user has manually edited each field
  spotEdited: { current: boolean };
  spxEdited: { current: boolean };
  vixEdited: { current: boolean };
  // timeEdited suppresses the live-session time-sync below so manually
  // selected past times aren't overwritten on the next 60s poll. Cleared
  // when the user changes the date or clicks "Resume live" in DateTimeSection.
  timeEdited: { current: boolean };
  // ivModeEdited is set when the user picks an IV mode (the mode toggle or
  // "Use VIX1D as σ"). It stops the re-choice that settles a provisional
  // mode (see ivModeAutoFill below) from overriding that pick. Cleared here
  // when a new date gets its choice.
  ivModeEdited: { current: boolean };
  timeHour: string;
  timeMinute: string;

  // State setters
  setSpotPrice: (v: string) => void;
  setSpxDirect: (v: string) => void;
  setVixInput: (v: string) => void;
  setIvMode: (v: IVMode) => void;
  setDirectIVInput: (v: string) => void;
  setTimeHour: (v: string) => void;
  setTimeMinute: (v: string) => void;
  setTimeAmPm: (v: AmPm) => void;
  setTimezone: (v: 'ET' | 'CT') => void;

  // External hook data
  market: MarketDataState;
  vix: Pick<UseVixDataReturn, 'selectedDate' | 'setSelectedDate'>;
  historyData: UseHistoryDataReturn;
  vix1dStatic: UseVix1dDataReturn;

  // Time values for ET conversion
  timeAmPm: AmPm;
  timezone: 'ET' | 'CT';
}

/**
 * How much of a past date's VIX1D an IV-mode choice could see, least first:
 *   none:    no Schwab VIX1D, and the static table still loading or failed
 *   table:   the static table, with no intraday history for the date (none
 *            exists, or its fetch is still in flight)
 *   history: the date's history snapshot, plus the table when the snapshot
 *            has no VIX1D
 * A re-run that knows more than the last choice chooses once more.
 */
const VIX1D_KNOWLEDGE = ['none', 'table', 'history'] as const;
type Vix1dKnowledge = (typeof VIX1D_KNOWLEDGE)[number];

/** True when `date` (YYYY-MM-DD) is before today's ET date. */
function isPastDate(date: string): boolean {
  return !!date && date < getETToday();
}

export function useAutoFill(inputs: UseAutoFillInputs): HistorySnapshot | null {
  const {
    spotEdited,
    spxEdited,
    vixEdited,
    timeEdited,
    // The Ref suffix lets the React Compiler lint treat this as a ref, which
    // the history effect below may write; it reads arguments as immutable.
    ivModeEdited: ivModeEditedRef,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    setSpotPrice,
    setSpxDirect,
    setVixInput,
    setIvMode,
    setDirectIVInput,
    setTimeHour,
    setTimeMinute,
    setTimeAmPm,
    setTimezone,
    market,
    vix,
    historyData,
    vix1dStatic,
  } = inputs;

  // Destructure stable references so they can be listed in dependency arrays
  // without including the entire vix object (which is new on every render).
  const { selectedDate, setSelectedDate } = vix;

  // useHistoryData keeps the last date's history while the new date's fetch
  // is in flight. History for another date counts as none for the selected
  // date, so its spot, VIX and σ never land there: that fetch may return no
  // candles (pre-market, a weekend, a holiday, a closed session) or fail,
  // and nothing would replace them. api/history echoes the requested date,
  // so the two match exactly.
  const ownHistory =
    historyData.hasHistory && historyData.history?.date === selectedDate;

  // Track which date we last auto-set IV mode for so we don't override the
  // user's manual toggle on every re-run (the effect re-runs on every time
  // scrub, table load and quote refresh).
  // `knew` is how much of the date's VIX1D that choice could see. A choice
  // that knew less is provisional: the VIX fallback while the static table
  // is still loading or failed to load (re-runs retry a failed load), or a
  // table-only choice before the date's intraday history arrives. When a
  // re-run knows more, even on a later retry, the mode is chosen once more,
  // unless the user has picked one since (`ivModeEdited`).
  const ivModeAutoFill = useRef<{ date: string; knew: Vix1dKnowledge } | null>(
    null,
  );

  // ── Auto-fill from live Schwab data (owner-only, silently skipped for public) ──
  useEffect(() => {
    if (!market.data.quotes) return;
    const q = market.data.quotes;

    // During active sessions (pre-market / regular / after-hours), always
    // apply live quotes so prices stay current on every 60s poll. The edited
    // guards only apply when the market is closed — after-hours exploration
    // or when the initial fetch races with a manual keystroke.
    const live = market.session !== 'closed';
    // Quotes are today's, and they load on any date (the owner's mount fetch
    // runs even when the market is closed). A past date never gets today's
    // VIX or VIX1D, which price strikes in VIX and DIRECT mode, nor the
    // switch to DIRECT from VIX1D. The history effect picks that date's mode
    // and σ from the date's own data, with or without intraday history.
    const pastDate = isPastDate(selectedDate);

    if (q.spy && (live || !spotEdited.current))
      setSpotPrice(q.spy.price.toFixed(2));
    if (q.spx && (live || !spxEdited.current))
      setSpxDirect(q.spx.price.toFixed(0));

    // VIX — same live-session override
    if (!pastDate && q.vix && (live || !vixEdited.current))
      setVixInput(q.vix.price.toFixed(2));

    // Auto-use VIX1D as σ when available (most accurate 0DTE IV).
    // Updates on every quote refresh — VIX1D changes intraday.
    if (!pastDate && q.vix1d && q.vix1d.price > 0) {
      setIvMode(IV_MODES.DIRECT);
      setDirectIVInput((q.vix1d.price / 100).toFixed(4));
    }

    // Auto-set today's date if not already set
    if (!selectedDate) setSelectedDate(getETToday());
    // Keep current CT time in sync during active sessions so DTE
    // calculations stay accurate on every 60s poll. When the market
    // is closed, only set time once from the default 10:00 value.
    // timeEdited suppresses this entirely — manual picks survive polls.
    if (
      !timeEdited.current &&
      (live || (timeHour === '10' && timeMinute === '00'))
    ) {
      const now = new Date();
      const ct = getCTTime(now);
      let h = ct.hour;
      const m = ct.minute;
      const snappedMin = Math.floor(m / 5) * 5;
      const ampm: AmPm = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      setTimeHour(String(h));
      setTimeMinute(String(snappedMin).padStart(2, '0'));
      setTimeAmPm(ampm);
      setTimezone('CT');
    }
    // `spotEdited`, `spxEdited`, `vixEdited` are useRef objects owned by the
    // parent and passed through props — listing them is safe (stable
    // identity) and satisfies exhaustive-deps.
  }, [
    market.data.quotes,
    market.session,
    selectedDate,
    setSelectedDate,
    setSpotPrice,
    setSpxDirect,
    setVixInput,
    setIvMode,
    setDirectIVInput,
    setTimeHour,
    setTimeMinute,
    setTimeAmPm,
    setTimezone,
    timeHour,
    timeMinute,
    spotEdited,
    spxEdited,
    vixEdited,
    timeEdited,
  ]);

  // ── Auto-fill from historical data when a past date is selected,
  //    or restore live data when switching back to today ──
  useEffect(() => {
    const { etHour, etMinute } = toETTime(
      timeHour,
      timeMinute,
      timeAmPm,
      timezone,
    );

    // Auto-use the date's VIX1D as σ when available. Choose the IV mode on
    // a new date, which also drops the last date's manual pick. Choose once
    // more when this run knows more of the date's VIX1D than the last
    // choice did, unless the user picked a mode in the meantime.
    const fillIv = (
      date: string,
      vix1dVal: number | null,
      knew: Vix1dKnowledge,
      vixFallback: boolean,
    ) => {
      const prev = ivModeAutoFill.current;
      const newDate = prev?.date !== date;
      if (newDate) ivModeEditedRef.current = false;
      const knowsMore =
        prev != null &&
        VIX1D_KNOWLEDGE.indexOf(knew) > VIX1D_KNOWLEDGE.indexOf(prev.knew);
      const chooseMode = newDate || (knowsMore && !ivModeEditedRef.current);
      if (vix1dVal != null && vix1dVal > 0) {
        // Only auto-switch IV mode when choosing; always update the σ value
        // so it stays current as the user scrubs time.
        if (chooseMode) setIvMode(IV_MODES.DIRECT);
        setDirectIVInput((vix1dVal / 100).toFixed(4));
      } else if (vixFallback && chooseMode) {
        // No VIX1D available (yet) — fall back to VIX mode
        setIvMode(IV_MODES.VIX);
      }
      if (chooseMode) ivModeAutoFill.current = { date, knew };
    };

    if (ownHistory) {
      // Past date: fill from historical candles
      const snapshot = historyData.getStateAtTime(etHour, etMinute);
      if (!snapshot) return;

      // SPX/SPY prices
      setSpotPrice(snapshot.spy.toFixed(2));
      setSpxDirect(snapshot.spot.toFixed(0));

      // VIX always populates the VIX field (regime analysis needs it)
      if (snapshot.vix != null) {
        setVixInput(snapshot.vix.toFixed(2));
      }

      // VIX1D from Schwab intraday, else the CBOE static table. Without
      // Schwab VIX1D, start the static table's load here (idempotent;
      // retried after a failure), in an effect, so render stays free of I/O.
      // getVix1d returns null until the fetch completes, then its reference
      // changes → effect re-runs.
      if (snapshot.vix1d == null) vix1dStatic.ensureLoaded();
      fillIv(
        selectedDate,
        snapshot.vix1d ?? vix1dStatic.getVix1d(selectedDate, etHour),
        snapshot.vix1d != null || vix1dStatic.loaded ? 'history' : 'none',
        snapshot.vix != null,
      );
      return;
    }

    // No intraday history: today, or a past date with none (older than ~60
    // days, a failed fetch, a weekend or holiday) or whose fetch is in
    // flight. Restore live prices if available.
    if (market.data.quotes) {
      const q = market.data.quotes;
      if (q.spy) setSpotPrice(q.spy.price.toFixed(2));
      if (q.spx) setSpxDirect(q.spx.price.toFixed(0));
    }
    if (isPastDate(selectedDate)) {
      // Same rule as a date with history, from the static table alone: its
      // VIX1D for the date, else VIX mode, so the date's daily VIX OHLC
      // (useVixData) drives σ. The table loads as above.
      vix1dStatic.ensureLoaded();
      fillIv(
        selectedDate,
        vix1dStatic.getVix1d(selectedDate, etHour),
        vix1dStatic.loaded ? 'table' : 'none',
        true,
      );
    } else {
      ivModeAutoFill.current = null;
    }
    // Listing individual props (not whole `historyData` / `vix1dStatic`
    // objects) is intentional — both parents re-create a fresh wrapper on
    // every render, so listing the whole object would retrigger this
    // effect unnecessarily. The specific props we read ARE stable across
    // renders when their underlying data hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ownHistory,
    historyData.history,
    historyData.getStateAtTime,
    selectedDate,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    vix1dStatic.loaded,
    vix1dStatic.ensureLoaded,
    vix1dStatic.getVix1d,
    setSpotPrice,
    setSpxDirect,
    setVixInput,
    setIvMode,
    setDirectIVInput,
    market.data.quotes,
    ivModeEditedRef,
  ]);

  // ── Compute current history snapshot for downstream components ──
  // Only the selected date's: none while its history loads after another
  // date's.
  if (!ownHistory) return null;

  const { etHour, etMinute } = toETTime(
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
  );
  const snapshot = historyData.getStateAtTime(etHour, etMinute);
  if (!snapshot) return null;

  // Fall back to static VIX1D daily data if Schwab intraday unavailable.
  // getVix1d is a pure lookup: null until the effect above has loaded the
  // table; the load's state update re-renders App and this lookup then
  // returns the value.
  if (snapshot.vix1d == null) {
    const staticVal = vix1dStatic.getVix1d(selectedDate, etHour);
    if (staticVal != null) {
      return { ...snapshot, vix1d: staticVal };
    }
  }
  return snapshot;
}
