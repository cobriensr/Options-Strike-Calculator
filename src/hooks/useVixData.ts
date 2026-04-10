import { useState, useEffect, useCallback, useRef } from 'react';
import type { VIXDayData, VIXDataMap, IVMode } from '../types';
import { IV_MODES } from '../constants';
import { parseVixCSV } from '../utils/csvParser';
import {
  cacheVixData,
  loadCachedVixData,
  loadStaticVixData,
} from '../utils/vixStorage';
import { to24Hour } from '../utils/calculator';
import { convertCTToET } from '../utils/timezone';

type AmPm = 'AM' | 'PM';
type Timezone = 'ET' | 'CT';
export type OHLCField = 'smart' | 'open' | 'high' | 'low' | 'close';

export interface UseVixDataReturn {
  vixData: VIXDataMap;
  vixDataLoaded: boolean;
  vixDataSource: string;
  vixOHLC: VIXDayData | null;
  setVixOHLC: (v: VIXDayData | null) => void;
  vixOHLCField: OHLCField;
  setVixOHLCField: (field: OHLCField) => void;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
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
  const [selectedDate, setSelectedDate] = useState(() =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // VIX data lookup on date change
  useEffect(() => {
    if (!selectedDate || Object.keys(vixData).length === 0) {
      setVixOHLC(null);
      return;
    }
    const entry = vixData[selectedDate];
    if (entry) {
      setVixOHLC(entry);
      if (vixOHLCField === 'smart' && ivMode === IV_MODES.VIX) {
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
    } else {
      setVixOHLC(null);
    }
  }, [
    selectedDate,
    vixData,
    vixOHLCField,
    ivMode,
    timezone,
    timeHour,
    timeAmPm,
    setVixInput,
  ]);

  // API fallback: fetch from /api/vix-ohlc when static data has no entry
  useEffect(() => {
    if (!vixDataLoaded || !selectedDate) return;
    if (vixData[selectedDate] != null) return; // static data covers this date

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
        if (!data || data.count === 0) return;
        setVixOHLC({
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
        });
      })
      .catch(() => {
        // Silently ignore AbortError on cleanup, network errors, and 401 for guests
      });

    return () => controller.abort();
  }, [selectedDate, vixData, vixDataLoaded]);

  // Re-apply OHLC selection when field or time changes
  useEffect(() => {
    if (!vixOHLC || ivMode !== IV_MODES.VIX) return;
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
    ivMode,
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
        const sourceName = file.name + ' (' + count.toLocaleString() + ' days)';
        setVixData((prev) => {
          const merged = { ...prev, ...parsed };
          cacheVixData(merged, sourceName);
          return merged;
        });
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
    fileInputRef,
    handleFileUpload,
  };
}
