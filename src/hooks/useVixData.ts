import { useState, useEffect, useCallback, useRef } from 'react';
import { captureUnlessAuth } from '../lib/sentry-helpers';
import type { VIXDayData, VIXDataMap, IVMode } from '../types';
import { IV_MODES } from '../constants';
import { parseVixCSV } from '../utils/csvParser';
import {
  cacheVixData,
  loadCachedVixData,
  loadStaticVixData,
} from '../utils/vixStorage';
import { to24Hour } from '../utils/calculator';
import { convertCTToET, getETToday, isPastETDate } from '../utils/timezone';
import { useETToday } from './useETToday';

type AmPm = 'AM' | 'PM';
type Timezone = 'ET' | 'CT';
export type OHLCField = 'smart' | 'open' | 'high' | 'low' | 'close';

/**
 * Whether the date's daily VIX goes in the VIX field. VIX mode prices
 * strikes off it. On a past date DIRECT mode needs it too, for regime
 * analysis, since today's live VIX must not stand in for that date's. So
 * on a past date it is true in both modes, and a mode toggle there
 * rewrites nothing. On a past date with intraday history, useAutoFill
 * writes the snapshot's VIX at the selected time over it, but only on a
 * change that re-runs its history effect too: the date, the time or the
 * date's VIX OHLC. A pick of the OHLC field re-runs only this hook's
 * effects, so the picked field shows.
 */
function fillsDailyVix(
  ivMode: IVMode,
  selectedDate: string,
  etToday: string,
): boolean {
  return ivMode === IV_MODES.VIX || isPastETDate(selectedDate, etToday);
}

export interface UseVixDataReturn {
  vixData: VIXDataMap;
  vixDataLoaded: boolean;
  vixDataSource: string;
  vixOHLC: VIXDayData | null;
  setVixOHLC: (v: VIXDayData | null) => void;
  vixOHLCField: OHLCField;
  setVixOHLCField: (field: OHLCField) => void;
  /**
   * The date the calculator is on: the owner's pick, else today's ET date,
   * which it follows across ET midnight.
   */
  selectedDate: string;
  /** Pick a date. Picking today's ET date means following today again. */
  setSelectedDate: (date: string) => void;
  /**
   * Today's ET date, from the one clock `selectedDate` follows, so App's
   * "the selected date is past" check turns in the render the date moves.
   */
  etToday: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
}

export function useVixData(
  ivMode: IVMode,
  timeHour: string,
  timeAmPm: AmPm,
  timezone: Timezone,
  setVixInput: (v: string) => void,
): UseVixDataReturn {
  const [vixData, setVixData] = useState<VIXDataMap>({});
  const [vixDataLoaded, setVixDataLoaded] = useState(false);
  const [vixDataSource, setVixDataSource] = useState('');
  const [vixOHLC, setVixOHLC] = useState<VIXDayData | null>(null);
  const [vixOHLCField, setVixOHLCField] = useState<OHLCField>('smart');
  // Today's ET date, the date isPastETDate and isBacktestMode judge "past"
  // by (the CT date read the 23:00-24:00 CT hour as yesterday). It turns over
  // at ET midnight. App reads it from here, so the selected date and its
  // "past" check share one clock and flip in the same render.
  const etToday = useETToday();
  // Only the owner's pick is state. null follows today, so the date moves at
  // ET midnight with nothing to sync. A pick of today's date is null too (the
  // owner is on today, so it keeps following); any other date stays put
  // across midnight. '' is a pick: the date field is mid-edit.
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const selectedDate = pickedDate ?? etToday;
  // Compare with the clock at the pick, not the render's etToday: in the
  // second after midnight, before the clock ticks, a pick of the new today
  // must still follow. Stable, as the state setter it replaces was.
  const setSelectedDate = useCallback((date: string) => {
    setPickedDate(date === getETToday() ? null : date);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The effects below key on this, not on ivMode: on a past date a mode
  // toggle leaves it true, so it re-runs neither effect.
  const fillsDaily = fillsDailyVix(ivMode, selectedDate, etToday);
  // The date the re-apply effect last ran for (see that effect).
  const reapplyDate = useRef(selectedDate);

  // Mirror the latest committed VIX map so handleFileUpload (whose deps are
  // [] so it stays referentially stable) can merge against the current data
  // and run the localStorage write OUTSIDE the setState updater. Keeping the
  // updater pure avoids double-writing the cache under React StrictMode,
  // which double-invokes updaters.
  const vixDataRef = useRef<VIXDataMap>(vixData);
  useEffect(() => {
    vixDataRef.current = vixData;
  }, [vixData]);

  // Load VIX data on mount: try localStorage cache first, then static JSON
  useEffect(() => {
    const cached = loadCachedVixData();
    if (cached) {
      setVixData(cached.data);
      setVixDataLoaded(true);
      setVixDataSource(cached.source);
      return;
    }
    loadStaticVixData().then((result) => {
      if (result) {
        setVixData(result.data);
        setVixDataLoaded(true);
        setVixDataSource(result.source);
        cacheVixData(result.data, result.source);
      }
    });
  }, []);

  // Single effect handles both static-data lookup and API fallback so the
  // two paths can't race. Prior version split them; when `selectedDate`
  // changed faster than an in-flight fetch could complete, a late API
  // response could overwrite a freshly-set static-data entry. The merged
  // path checks static first and only starts a fetch when static is
  // missing, with AbortController cleanup cancelling any pending request
  // before the next effect run begins.
  useEffect(() => {
    if (!selectedDate || Object.keys(vixData).length === 0) {
      setVixOHLC(null);
      return;
    }

    const entry = vixData[selectedDate];
    if (entry) {
      setVixOHLC(entry);
      if (vixOHLCField === 'smart' && fillsDaily) {
        // DST-safe CT→ET conversion (see FE-STATE-004 + follow-up).
        // The ~1-hour spring-forward window each March has a real
        // 120-minute offset, not the steady-state 60, so we use
        // convertCTToET instead of a hardcoded +1. Minute is passed
        // as 0 because the VIX open/close pick is hour-granular.
        const ctH24 = to24Hour(Number.parseInt(timeHour), timeAmPm);
        const etH = timezone === 'CT' ? convertCTToET(ctH24, 0).hour : ctH24;
        const v = etH < 13 ? entry.open : entry.close;
        if (v != null) setVixInput(v.toFixed(2));
      }
      return;
    }

    // No static entry — fall back to the API (only once initial load is
    // complete, otherwise we'd fire during the bootstrap phase).
    setVixOHLC(null);
    if (!vixDataLoaded) return;

    const controller = new AbortController();

    fetch(`/api/vix-ohlc?date=${selectedDate}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{
          open: number | null;
          high: number | null;
          low: number | null;
          close: number | null;
          count: number;
        }>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data || data.count === 0) return;
        const fromSnapshots = {
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
        };
        // This answer is OHLC over the snapshots saved that day, a sample.
        // It only fills an empty slot: the one other writer is App's history
        // fallback, whose candles cover the date's session and stand.
        setVixOHLC((prev) => prev ?? fromSnapshots);
      })
      .catch((err: unknown) => {
        // An AbortError (cleanup) is expected, so it is filtered out before
        // capturing. /api/vix-ohlc is public ("no owner check"), so no auth
        // gate answers 401 here, and a non-2xx reply returns null above
        // instead of throwing. Network failures, a body that fails to parse
        // and any other error reach Sentry.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (controller.signal.aborted) return;
        captureUnlessAuth(err, {
          level: 'warning',
          tags: { context: 'vix_ohlc_fetch' },
        });
      });

    return () => controller.abort();
  }, [
    selectedDate,
    vixData,
    vixDataLoaded,
    vixOHLCField,
    fillsDaily,
    timezone,
    timeHour,
    timeAmPm,
    setVixInput,
  ]);

  // Re-apply OHLC selection when the OHLC, field or time changes
  useEffect(() => {
    // Skip the commit in which the date changed. The effect above owns that
    // change, and vixOHLC here is still the last date's, so writing it would
    // put the last date's daily VIX on the new date. The new date's vixOHLC
    // re-runs this effect.
    const dateChanged = reapplyDate.current !== selectedDate;
    reapplyDate.current = selectedDate;
    if (dateChanged || !vixOHLC || !fillsDaily) return;
    if (vixOHLCField === 'smart') {
      // DST-safe CT→ET conversion — same pattern as the selectedDate
      // effect above. See FE-STATE-004 for the DST window rationale.
      const ctH24 = to24Hour(Number.parseInt(timeHour), timeAmPm);
      const etH = timezone === 'CT' ? convertCTToET(ctH24, 0).hour : ctH24;
      const v = etH < 13 ? vixOHLC.open : vixOHLC.close;
      if (v != null) setVixInput(v.toFixed(2));
    } else {
      const v = vixOHLC[vixOHLCField];
      if (v != null) setVixInput(v.toFixed(2));
    }
  }, [
    vixOHLCField,
    vixOHLC,
    timeHour,
    timeAmPm,
    timezone,
    fillsDaily,
    selectedDate,
    setVixInput,
  ]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Guard: reject files larger than 10MB to prevent browser freeze
      if (file.size > 10 * 1024 * 1024) return;
      const text = await file.text();
      const parsed = parseVixCSV(text);
      const count = Object.keys(parsed).length;
      if (count > 0) {
        const sourceName = count.toLocaleString() + ' days';
        // Merge against the latest committed map (via ref) so the setState
        // updater stays pure and the cache write happens exactly once.
        const merged = { ...vixDataRef.current, ...parsed };
        cacheVixData(merged, sourceName);
        setVixData(merged);
        setVixDataLoaded(true);
        setVixDataSource(sourceName);
      }
    },
    [],
  );

  return {
    vixData,
    vixDataLoaded,
    vixDataSource,
    vixOHLC,
    setVixOHLC,
    vixOHLCField,
    setVixOHLCField,
    selectedDate,
    setSelectedDate,
    etToday,
    fileInputRef,
    handleFileUpload,
  };
}
