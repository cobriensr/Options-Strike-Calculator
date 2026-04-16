/**
 * useAutoFill — Auto-populates calculator inputs from live or historical data.
 *
 * Two responsibilities:
 *   1. Live auto-fill: When Schwab quotes arrive, populate empty fields
 *      (spot, SPX, VIX, VIX1D) and set the current time.
 *   2. History auto-fill: When a past date is selected, fill inputs from
 *      historical candle data; restore live data when switching back to today.
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
import { getCTTime } from '../utils/timezone';
import type { MarketDataState } from './useMarketData';
import type { UseVixDataReturn } from './useVixData';
import type { UseHistoryDataReturn, HistorySnapshot } from './useHistoryData';
import type { UseVix1dDataReturn } from './useVix1dData';

interface UseAutoFillInputs {
  // Refs tracking whether the user has manually edited each field
  spotEdited: { current: boolean };
  spxEdited: { current: boolean };
  vixEdited: { current: boolean };
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

export function useAutoFill(inputs: UseAutoFillInputs): HistorySnapshot | null {
  const {
    spotEdited,
    spxEdited,
    vixEdited,
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

  // Track which date we last auto-set IV mode for so we don't override the
  // user's manual toggle on every re-render (historyData is a new object ref
  // each render, which would otherwise re-trigger the history effect).
  const ivModeAutoFilledDate = useRef<string | null>(null);

  // ── Auto-fill from live Schwab data (owner-only, silently skipped for public) ──
  useEffect(() => {
    if (!market.data.quotes) return;
    const q = market.data.quotes;

    // During active sessions (pre-market / regular / after-hours), always
    // apply live quotes so prices stay current on every 60s poll. The edited
    // guards only apply when the market is closed — after-hours exploration
    // or when the initial fetch races with a manual keystroke.
    const live = market.session !== 'closed';

    if (q.spy && (live || !spotEdited.current))
      setSpotPrice(q.spy.price.toFixed(2));
    if (q.spx && (live || !spxEdited.current))
      setSpxDirect(q.spx.price.toFixed(0));

    // VIX — same live-session override
    if (q.vix && (live || !vixEdited.current))
      setVixInput(q.vix.price.toFixed(2));

    // Auto-use VIX1D as σ when available (most accurate 0DTE IV).
    // Updates on every quote refresh — VIX1D changes intraday.
    if (q.vix1d && q.vix1d.price > 0) {
      setIvMode(IV_MODES.DIRECT);
      setDirectIVInput((q.vix1d.price / 100).toFixed(4));
    }

    // Auto-set today's date if not already set
    if (!selectedDate) {
      const today = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });
      setSelectedDate(today);
    }
    // Keep current CT time in sync during active sessions so DTE
    // calculations stay accurate on every 60s poll. When the market
    // is closed, only set time once from the default 10:00 value.
    if (live || (timeHour === '10' && timeMinute === '00')) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs (spotEdited, spxEdited, vixEdited) are stable; listing them is misleading
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
  ]);

  // ── Auto-fill from historical data when a past date is selected,
  //    or restore live data when switching back to today ──
  useEffect(() => {
    if (historyData.hasHistory) {
      // Past date: fill from historical candles
      const { etHour, etMinute } = toETTime(
        timeHour,
        timeMinute,
        timeAmPm,
        timezone,
      );

      const snapshot = historyData.getStateAtTime(etHour, etMinute);
      if (!snapshot) return;

      // SPX/SPY prices
      setSpotPrice(snapshot.spy.toFixed(2));
      setSpxDirect(snapshot.spot.toFixed(0));

      // VIX always populates the VIX field (regime analysis needs it)
      if (snapshot.vix != null) {
        setVixInput(snapshot.vix.toFixed(2));
      }

      // Auto-use VIX1D as σ when available (from Schwab intraday or CBOE static).
      // getVix1d triggers ensureLoaded() on first call; returns null until the
      // fetch completes, then its reference changes → effect re-runs with data.
      const vix1dVal =
        snapshot.vix1d ??
        vix1dStatic.getVix1d(historyData.history!.date, etHour);
      const isNewDate =
        ivModeAutoFilledDate.current !== historyData.history!.date;
      if (vix1dVal != null && vix1dVal > 0) {
        // Only auto-switch IV mode when the date changes; always update the
        // σ value so it stays current as the user scrubs time.
        if (isNewDate) setIvMode(IV_MODES.DIRECT);
        setDirectIVInput((vix1dVal / 100).toFixed(4));
      } else if (snapshot.vix != null && isNewDate) {
        // No VIX1D available — fall back to VIX mode (new date only)
        setIvMode(IV_MODES.VIX);
      }
      if (isNewDate) {
        ivModeAutoFilledDate.current = historyData.history!.date;
      }
    } else if (market.data.quotes) {
      // Today (or no history): restore live prices if available
      ivModeAutoFilledDate.current = null;
      const q = market.data.quotes;
      if (q.spy) setSpotPrice(q.spy.price.toFixed(2));
      if (q.spx) setSpxDirect(q.spx.price.toFixed(0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- destructured to specific props to avoid re-firing on every render from unstable parent objects
  }, [
    historyData.hasHistory,
    historyData.history,
    historyData.getStateAtTime,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    vix1dStatic.loaded,
    vix1dStatic.getVix1d,
    setSpotPrice,
    setSpxDirect,
    setVixInput,
    setIvMode,
    setDirectIVInput,
    market.data.quotes,
  ]);

  // ── Compute current history snapshot for downstream components ──
  if (!historyData.hasHistory) return null;

  const { etHour, etMinute } = toETTime(
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
  );
  const snapshot = historyData.getStateAtTime(etHour, etMinute);
  if (!snapshot) return null;

  // Fall back to static VIX1D daily data if Schwab intraday unavailable.
  // Always call getVix1d (not guarded by .loaded) so it triggers ensureLoaded()
  // on the first render; returns null until the fetch completes, then the
  // getVix1d reference changes → callers re-render with the real value.
  if (snapshot.vix1d == null) {
    const staticVal = vix1dStatic.getVix1d(historyData.history!.date, etHour);
    if (staticVal != null) {
      return { ...snapshot, vix1d: staticVal };
    }
  }
  return snapshot;
}
