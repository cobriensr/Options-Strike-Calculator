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

import { useEffect } from 'react';
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

  // ── Auto-fill from live Schwab data (owner-only, silently skipped for public) ──
  useEffect(() => {
    if (!market.data.quotes) return;
    const q = market.data.quotes;

    // Auto-fill from API — overwrites defaults but respects user edits
    if (q.spy && !spotEdited.current) setSpotPrice(q.spy.price.toFixed(2));
    if (q.spx && !spxEdited.current) setSpxDirect(q.spx.price.toFixed(0));

    // VIX — overwrites defaults but respects user edits
    if (q.vix && !vixEdited.current) setVixInput(q.vix.price.toFixed(2));

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
    // Auto-set current time in CT
    if (timeHour === '10' && timeMinute === '00') {
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
  }, [
    market.data.quotes,
    spotEdited,
    spxEdited,
    vixEdited,
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

      // Auto-use VIX1D as σ when available (from Schwab intraday or CBOE static)
      const vix1dVal =
        snapshot.vix1d ??
        (vix1dStatic.loaded
          ? vix1dStatic.getVix1d(historyData.history!.date, etHour)
          : null);
      if (vix1dVal != null && vix1dVal > 0) {
        setIvMode(IV_MODES.DIRECT);
        setDirectIVInput((vix1dVal / 100).toFixed(4));
      } else if (snapshot.vix != null) {
        // No VIX1D available — fall back to VIX mode
        setIvMode(IV_MODES.VIX);
      }
    } else if (market.data.quotes) {
      // Today (or no history): restore live prices if available
      const q = market.data.quotes;
      if (q.spy) setSpotPrice(q.spy.price.toFixed(2));
      if (q.spx) setSpxDirect(q.spx.price.toFixed(0));
    }
  }, [
    historyData,
    timeHour,
    timeMinute,
    timeAmPm,
    timezone,
    vix1dStatic,
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

  // Fall back to static VIX1D daily data if Schwab intraday unavailable
  if (snapshot.vix1d == null && vix1dStatic.loaded) {
    const staticVal = vix1dStatic.getVix1d(historyData.history!.date, etHour);
    if (staticVal != null) {
      return { ...snapshot, vix1d: staticVal };
    }
  }
  return snapshot;
}
