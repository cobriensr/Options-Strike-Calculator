import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCallback, useState } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAutoFill } from '../../hooks/useAutoFill';
import { useVix1dData } from '../../hooks/useVix1dData';
import { IV_MODES } from '../../constants';
import { getETToday } from '../../utils/timezone';
import type { IVMode } from '../../types';
import type { MarketDataState } from '../../hooks/useMarketData';
import type { UseVixDataReturn } from '../../hooks/useVixData';
import type {
  UseHistoryDataReturn,
  HistorySnapshot,
} from '../../hooks/useHistoryData';
import type { UseVix1dDataReturn } from '../../hooks/useVix1dData';
import type { QuotesResponse, HistoryResponse } from '../../types/api';

// ============================================================
// MOCK DATA
// ============================================================

const mockQuotes: QuotesResponse = {
  spy: {
    price: 580,
    open: 577,
    high: 582,
    low: 576,
    prevClose: 578,
    change: 2,
    changePct: 0.35,
  },
  spx: {
    price: 5820,
    open: 5800,
    high: 5840,
    low: 5790,
    prevClose: 5810,
    change: 10,
    changePct: 0.17,
  },
  vix: {
    price: 18.5,
    open: 19.0,
    high: 19.5,
    low: 18.0,
    prevClose: 19.2,
    change: -0.7,
    changePct: -3.6,
  },
  vix1d: {
    price: 14.2,
    open: 13.8,
    high: 15.0,
    low: 13.5,
    prevClose: 14.8,
    change: -0.6,
    changePct: -4.0,
  },
  vix9d: null,
  vvix: null,
  marketOpen: true,
  asOf: '2026-03-17T16:30:00Z',
};

const emptySymbol = { candles: [], previousClose: 0, previousDay: null };

function mockHistory(date: string): HistoryResponse {
  return {
    date,
    spx: { candles: [], previousClose: 5740, previousDay: null },
    vix: emptySymbol,
    vix1d: emptySymbol,
    vix9d: emptySymbol,
    vvix: emptySymbol,
    candleCount: 0,
    asOf: '2026-03-17T16:30:00Z',
  };
}

function makeHistorySnapshot(
  overrides: Partial<HistorySnapshot> = {},
): HistorySnapshot {
  return {
    spot: 5750,
    spy: 575,
    runningOHLC: { open: 5740, high: 5760, low: 5730, last: 5750 },
    openingRange: null,
    yesterday: null,
    vix: 20.5,
    vixPrevClose: 21.0,
    vix1d: null,
    vix9d: null,
    vvix: null,
    previousClose: 5740,
    candle: {
      datetime: 1710000000000,
      time: '11:30',
      open: 5748,
      high: 5752,
      low: 5746,
      close: 5750,
    },
    candleIndex: 5,
    totalCandles: 78,
    ...overrides,
  };
}

// ============================================================
// MOCK HELPERS
// ============================================================

function createSetters() {
  return {
    setSpotPrice: vi.fn(),
    setSpxDirect: vi.fn(),
    setVixInput: vi.fn(),
    setIvMode: vi.fn(),
    setDirectIVInput: vi.fn(),
    setTimeHour: vi.fn(),
    setTimeMinute: vi.fn(),
    setTimeAmPm: vi.fn(),
    setTimezone: vi.fn(),
  };
}

function createMarket(quotes: QuotesResponse | null = null): MarketDataState {
  return {
    data: {
      quotes,
      intraday: null,
      yesterday: null,
      events: null,
      movers: null,
    },
    loading: false,
    hasData: !!quotes,
    needsAuth: false,
    fetchedAt: null,
    // FE-STATE-001 quote freshness (staleness derives from it in
    // useQuoteStaleness).
    quotesFetchedAt: null,
    // FE-STATE-002 tri-state session.
    session: 'closed',
    marketOpen: false,
  };
}

function createVix(
  overrides: Partial<UseVixDataReturn> = {},
): UseVixDataReturn {
  return {
    vixData: {},
    vixDataLoaded: false,
    vixDataSource: '',
    vixOHLC: null,
    setVixOHLC: vi.fn(),
    vixOHLCField: 'smart',
    setVixOHLCField: vi.fn(),
    selectedDate: '',
    setSelectedDate: vi.fn(),
    fileInputRef: { current: null },
    handleFileUpload: vi.fn(),
    ...overrides,
  };
}

function createHistoryData(
  overrides: Partial<UseHistoryDataReturn> = {},
): UseHistoryDataReturn {
  return {
    history: null,
    loading: false,
    error: null,
    getStateAtTime: vi.fn().mockReturnValue(null),
    hasHistory: false,
    ...overrides,
  };
}

function createVix1dStatic(
  overrides: Partial<UseVix1dDataReturn> = {},
): UseVix1dDataReturn {
  return {
    loaded: false,
    ensureLoaded: vi.fn(),
    getVix1d: vi.fn().mockReturnValue(null),
    getOHLC: vi.fn().mockReturnValue(null),
    dayCount: 0,
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('useAutoFill', () => {
  let setters: ReturnType<typeof createSetters>;

  beforeEach(() => {
    setters = createSetters();
    vi.useFakeTimers();
    // Set to a known CT time — 2026-03-17 10:30 AM CT = 11:30 AM ET = 16:30 UTC
    vi.setSystemTime(new Date('2026-03-17T16:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Live auto-fill ──

  it('auto-fills empty fields from live quotes', () => {
    const market = createMarket(mockQuotes);
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market,
        vix,
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setSpotPrice).toHaveBeenCalledWith('580.00');
    expect(setters.setSpxDirect).toHaveBeenCalledWith('5820');
    expect(setters.setVixInput).toHaveBeenCalledWith('18.50');
  });

  it('does not overwrite existing user input when market is closed', () => {
    // When session is 'closed', the edited guards apply — manual input
    // is preserved for after-hours exploration.
    const market = createMarket(mockQuotes);
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '2',
        timeMinute: '15',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix,
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    // VIX field is only set by the first effect, so if non-empty it should be skipped
    expect(setters.setVixInput).not.toHaveBeenCalled();
  });

  it('always applies live quotes during active sessions even when edited', () => {
    // During pre-market / regular / after-hours, live quotes always
    // overwrite — the trader expects current prices on every 60s poll.
    const market: MarketDataState = {
      ...createMarket(mockQuotes),
      session: 'regular',
      marketOpen: true,
    };
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '2',
        timeMinute: '15',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix,
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setSpotPrice).toHaveBeenCalledWith('580.00');
    expect(setters.setSpxDirect).toHaveBeenCalledWith('5820');
    expect(setters.setVixInput).toHaveBeenCalledWith('18.50');
  });

  it('auto-switches to direct IV mode when VIX1D is available', () => {
    const market = createMarket(mockQuotes);
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market,
        vix,
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setIvMode).toHaveBeenCalledWith(IV_MODES.DIRECT);
    expect(setters.setDirectIVInput).toHaveBeenCalledWith('0.1420');
  });

  it('does not set IV mode when VIX1D price is 0', () => {
    const quotes: QuotesResponse = {
      ...mockQuotes,
      vix1d: {
        price: 0,
        open: 13.8,
        high: 15.0,
        low: 13.5,
        prevClose: 14.8,
        change: -0.6,
        changePct: -4.0,
      },
    };
    const market = createMarket(quotes);

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '2',
        timeMinute: '00',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix(),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setIvMode).not.toHaveBeenCalled();
  });

  it('auto-sets today as selectedDate if not set', () => {
    const market = createMarket(mockQuotes);
    const vix = createVix({ selectedDate: '' });

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '2',
        timeMinute: '00',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix,
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(vix.setSelectedDate).toHaveBeenCalledWith('2026-03-17');
  });

  it('auto-sets current CT time when time is at default 10:00', () => {
    const market = createMarket(mockQuotes);

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    // 16:30 UTC in March (CDT) = 11:30 AM CT
    expect(setters.setTimeHour).toHaveBeenCalledWith('11');
    expect(setters.setTimeMinute).toHaveBeenCalledWith('30');
    expect(setters.setTimeAmPm).toHaveBeenCalledWith('AM');
    expect(setters.setTimezone).toHaveBeenCalledWith('CT');
  });

  it('does not touch time when already set to non-default and market closed', () => {
    const market = createMarket(mockQuotes);

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '2',
        timeMinute: '15',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setTimeHour).not.toHaveBeenCalled();
    expect(setters.setTimeMinute).not.toHaveBeenCalled();
  });

  it('advances time on each poll during active sessions', () => {
    // During regular hours, time should sync to current CT on every
    // 60s quote refresh so DTE calculations stay accurate.
    const market: MarketDataState = {
      ...createMarket(mockQuotes),
      session: 'regular',
      marketOpen: true,
    };

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    // 16:30 UTC in March (CDT) = 11:30 AM CT — time advances from 11:00
    expect(setters.setTimeHour).toHaveBeenCalledWith('11');
    expect(setters.setTimeMinute).toHaveBeenCalledWith('30');
    expect(setters.setTimeAmPm).toHaveBeenCalledWith('AM');
    expect(setters.setTimezone).toHaveBeenCalledWith('CT');
  });

  it('does NOT advance time during active sessions when timeEdited is true', () => {
    // User manually picked a past time — the poll must not stomp it,
    // even though session is active and `live` is true.
    const market: MarketDataState = {
      ...createMarket(mockQuotes),
      session: 'after-hours',
      marketOpen: false,
    };

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: true },
        ivModeEdited: { current: false },
        timeHour: '4',
        timeMinute: '00',
        timeAmPm: 'PM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setTimeHour).not.toHaveBeenCalled();
    expect(setters.setTimeMinute).not.toHaveBeenCalled();
    expect(setters.setTimeAmPm).not.toHaveBeenCalled();
    expect(setters.setTimezone).not.toHaveBeenCalled();
  });

  it('does NOT seed time from 10:00 default when timeEdited is true', () => {
    // Edge case: even on the sentinel default, an edited flag must block
    // the one-shot initial sync (e.g. user cleared the field intentionally).
    const market = createMarket(mockQuotes);

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: true },
        spxEdited: { current: true },
        vixEdited: { current: true },
        timeEdited: { current: true },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setTimeHour).not.toHaveBeenCalled();
    expect(setters.setTimeMinute).not.toHaveBeenCalled();
  });

  it('does nothing when no market data', () => {
    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market: createMarket(null),
        vix: createVix(),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setSpotPrice).not.toHaveBeenCalled();
    expect(setters.setSpxDirect).not.toHaveBeenCalled();
  });

  // ── History auto-fill ──

  it('fills inputs from historical snapshot', () => {
    const snapshot = makeHistorySnapshot({ vix: 20.5, vix1d: 15.0 });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(snapshot),
    });

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setSpotPrice).toHaveBeenCalledWith('575.00');
    expect(setters.setSpxDirect).toHaveBeenCalledWith('5750');
    expect(setters.setVixInput).toHaveBeenCalledWith('20.50');
    expect(setters.setIvMode).toHaveBeenCalledWith(IV_MODES.DIRECT);
    expect(setters.setDirectIVInput).toHaveBeenCalledWith('0.1500');
  });

  it('falls back to VIX mode when no VIX1D in historical data', () => {
    const snapshot = makeHistorySnapshot({ vix: 20.5, vix1d: null });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(snapshot),
    });

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic: createVix1dStatic({ loaded: false }),
      }),
    );

    expect(setters.setIvMode).toHaveBeenCalledWith(IV_MODES.VIX);
  });

  it('uses static VIX1D fallback when Schwab data unavailable', () => {
    const snapshot = makeHistorySnapshot({ vix: 20.5, vix1d: null });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(snapshot),
    });
    const vix1dStatic = createVix1dStatic({
      loaded: true,
      getVix1d: vi.fn().mockReturnValue(16.5),
    });

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic,
      }),
    );

    expect(setters.setIvMode).toHaveBeenCalledWith(IV_MODES.DIRECT);
    expect(setters.setDirectIVInput).toHaveBeenCalledWith('0.1650');
  });

  it('restores live prices when switching back from history', () => {
    const market = createMarket(mockQuotes);
    const historyData = createHistoryData({ hasHistory: false });

    renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market,
        vix: createVix({ selectedDate: '2026-03-17' }),
        historyData,
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(setters.setSpotPrice).toHaveBeenCalledWith('580.00');
    expect(setters.setSpxDirect).toHaveBeenCalledWith('5820');
  });

  // ── History snapshot return value ──

  it('returns null when no history', () => {
    const { result } = renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '10',
        timeMinute: '00',
        timeAmPm: 'AM',
        timezone: 'CT',
        ...setters,
        market: createMarket(null),
        vix: createVix(),
        historyData: createHistoryData(),
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(result.current).toBeNull();
  });

  it('returns snapshot with static VIX1D fallback', () => {
    const snapshot = makeHistorySnapshot({ vix1d: null });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(snapshot),
    });
    const vix1dStatic = createVix1dStatic({
      loaded: true,
      getVix1d: vi.fn().mockReturnValue(16.5),
    });

    const { result } = renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic,
      }),
    );

    expect(result.current).not.toBeNull();
    expect(result.current!.vix1d).toBe(16.5);
  });

  it('returns snapshot as-is when VIX1D already present', () => {
    const snapshot = makeHistorySnapshot({ vix1d: 14.8 });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(snapshot),
    });

    const { result } = renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(result.current).not.toBeNull();
    expect(result.current!.vix1d).toBe(14.8);
  });

  it("returns null for another date's history, held while the selected date's loads", () => {
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(makeHistorySnapshot()),
    });

    const { result } = renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-11' }),
        historyData,
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(result.current).toBeNull();
    // Nor does the history effect fill the inputs from it.
    expect(setters.setVixInput).not.toHaveBeenCalled();
    expect(setters.setSpotPrice).not.toHaveBeenCalled();
  });

  it('returns null when history exists but getStateAtTime returns null', () => {
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(null),
    });

    const { result } = renderHook(() =>
      useAutoFill({
        spotEdited: { current: false },
        spxEdited: { current: false },
        vixEdited: { current: false },
        timeEdited: { current: false },
        ivModeEdited: { current: false },
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        ...setters,
        market: createMarket(null),
        vix: createVix({ selectedDate: '2026-03-10' }),
        historyData,
        vix1dStatic: createVix1dStatic(),
      }),
    );

    expect(result.current).toBeNull();
  });
});

// ============================================================
// STATIC VIX1D LOADING (F4c)
// ============================================================

describe('useAutoFill: static VIX1D loading', () => {
  const baseInputs = {
    spotEdited: { current: false },
    spxEdited: { current: false },
    vixEdited: { current: false },
    timeEdited: { current: false },
    ivModeEdited: { current: false },
    timeHour: '11',
    timeMinute: '30',
    timeAmPm: 'AM' as const,
    timezone: 'ET' as const,
    market: createMarket(null),
    vix: createVix({ selectedDate: '2026-03-10' }),
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the static table from an effect, never during render, and the value still arrives', async () => {
    // Real useVix1dData so the I/O is observable: count fetches that
    // start while the hooks' render body is running.
    let rendering = false;
    let fetchesDuringRender = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        if (rendering) fetchesDuringRender++;
        return new Response(
          JSON.stringify({
            '2026-03-10': { o: 16.5, h: 17.2, l: 16.1, c: 16.9 },
          }),
          { status: 200 },
        );
      });
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi
        .fn()
        .mockReturnValue(makeHistorySnapshot({ vix1d: null })),
    });
    const setters = createSetters();

    const { result } = renderHook(() => {
      rendering = true;
      const vix1dStatic = useVix1dData();
      const snapshot = useAutoFill({
        ...baseInputs,
        ...setters,
        historyData,
        vix1dStatic,
      });
      rendering = false;
      return snapshot;
    });

    expect(fetchesDuringRender).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 11:30 ET is before noon, so the static fallback uses the open.
    await waitFor(() => expect(result.current?.vix1d).toBe(16.5));
    expect(setters.setDirectIVInput).toHaveBeenCalledWith('0.1650');
    expect(fetchesDuringRender).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not load the static table in live mode', () => {
    const vix1dStatic = createVix1dStatic();

    renderHook(() =>
      useAutoFill({
        ...baseInputs,
        ...createSetters(),
        vix: createVix({ selectedDate: getETToday() }),
        historyData: createHistoryData({ hasHistory: false }),
        vix1dStatic,
      }),
    );

    expect(vix1dStatic.ensureLoaded).not.toHaveBeenCalled();
  });

  it('does not load the static table when the snapshot already has VIX1D', () => {
    const vix1dStatic = createVix1dStatic();

    renderHook(() =>
      useAutoFill({
        ...baseInputs,
        ...createSetters(),
        historyData: createHistoryData({
          hasHistory: true,
          history: mockHistory('2026-03-10'),
          getStateAtTime: vi
            .fn()
            .mockReturnValue(makeHistorySnapshot({ vix1d: 14.8 })),
        }),
        vix1dStatic,
      }),
    );

    expect(vix1dStatic.ensureLoaded).not.toHaveBeenCalled();
  });

  // ── IV mode when the table arrives after the first visit ──
  // Real useVix1dData plus real ivMode / σ state, so a user's toggle is a
  // real state change that the hook's later re-runs must leave alone.

  /** fetch that stays pending until the test settles it, one call at a time. */
  function pendingFetches() {
    const pending: {
      resolve: (res: Response) => void;
      reject: (err: unknown) => void;
    }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    return {
      fetchSpy,
      respond: (table: Record<string, unknown>) =>
        pending
          .shift()!
          .resolve(new Response(JSON.stringify(table), { status: 200 })),
      fail: () => pending.shift()!.reject(new TypeError('Failed to fetch')),
    };
  }

  const VIX1D_TABLE = { '2026-03-10': { o: 16.5, h: 17.2, l: 16.1, c: 16.9 } };

  interface IvStateProps {
    timeMinute: string;
    historyData: UseHistoryDataReturn;
    /** A new selected date; `vix`'s setter stays the same. */
    date?: string;
  }

  function renderWithIvState(
    initialHistory: UseHistoryDataReturn,
    initialMode: IVMode,
    {
      quotes = null,
      selectedDate = '2026-03-10',
    }: { quotes?: QuotesResponse | null; selectedDate?: string } = {},
  ) {
    // Built once, outside the render callback: a fresh object per render
    // would change the live effect's deps and re-run it on every render.
    const setters = createSetters();
    const ivModeEdited = { current: false };
    const market = createMarket(quotes);
    const vix = createVix({ selectedDate });
    const initialProps: IvStateProps = {
      timeMinute: '30',
      historyData: initialHistory,
    };
    const rendered = renderHook(
      ({ timeMinute, historyData, date = selectedDate }: IvStateProps) => {
        const [ivMode, setIvModeState] = useState<IVMode>(initialMode);
        const [directIV, setDirectIVState] = useState('');
        const [vixInput, setVixInputState] = useState('');
        // Real state, with every call also recorded on `setters`, so a test
        // can assert a value was never set even when a later call in the
        // same flush replaced it.
        const setIvMode = useCallback((mode: IVMode) => {
          setters.setIvMode(mode);
          setIvModeState(mode);
        }, []);
        const setDirectIVInput = useCallback((v: string) => {
          setters.setDirectIVInput(v);
          setDirectIVState(v);
        }, []);
        const setVixInput = useCallback((v: string) => {
          setters.setVixInput(v);
          setVixInputState(v);
        }, []);
        const vix1dStatic = useVix1dData();
        useAutoFill({
          ...baseInputs,
          ...setters,
          market,
          vix: { ...vix, selectedDate: date },
          ivModeEdited,
          setIvMode,
          setDirectIVInput,
          setVixInput,
          timeMinute,
          historyData,
          vix1dStatic,
        });
        // The user's two ways to pick a mode, the way App's handlers make
        // them (App.iv-mode-wiring.test.ts guards that App sets the flag).
        const userSetsIvMode = (mode: IVMode) => {
          ivModeEdited.current = true;
          setIvMode(mode);
        };
        const userUsesVix1dAsSigma = (sigma: number) => {
          ivModeEdited.current = true;
          setIvMode(IV_MODES.DIRECT);
          setDirectIVInput(sigma.toFixed(4));
        };
        return {
          ivMode,
          userSetsIvMode,
          userUsesVix1dAsSigma,
          directIV,
          vixInput,
          loaded: vix1dStatic.loaded,
        };
      },
      { initialProps },
    );
    return { ...rendered, ivModeEdited, setters };
  }

  function pastDateWithoutSchwabVix1d() {
    return createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi
        .fn()
        .mockReturnValue(makeHistorySnapshot({ vix: 20.5, vix1d: null })),
    });
  }

  it('with no manual pick, switches to DIRECT once the late table has VIX1D for the date', async () => {
    const fetches = pendingFetches();
    // The previous date left DIRECT; this date has no Schwab VIX1D.
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.DIRECT,
    );

    // Table still loading: VIX until the table can answer.
    expect(fetches.fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    fetches.respond(VIX1D_TABLE);

    await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));
    expect(result.current.directIV).toBe('0.1650');
  });

  // The owner's mount fetch loads today's quotes even when the market is
  // closed, so the live effect runs on a past date too, on every time scrub.
  it.each([
    ['without live quotes', null],
    ["with today's live quotes loaded", mockQuotes],
  ] as const)(
    "keeps a manual VIX pick and the date's σ on a later time scrub once the table has loaded (%s)",
    async (_label, quotes) => {
      const fetches = pendingFetches();
      const historyData = pastDateWithoutSchwabVix1d();
      const { result, rerender } = renderWithIvState(
        historyData,
        IV_MODES.VIX,
        { quotes },
      );
      fetches.respond(VIX1D_TABLE);
      await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));

      act(() => result.current.userSetsIvMode(IV_MODES.VIX));
      rerender({ timeMinute: '35', historyData }); // a time scrub re-runs the effect

      expect(historyData.getStateAtTime).toHaveBeenLastCalledWith(11, 35);
      expect(result.current.ivMode).toBe(IV_MODES.VIX);
      // The date's VIX1D from the table, not today's live 0.1420.
      expect(result.current.directIV).toBe('0.1650');
    },
  );

  it('stays in VIX mode when the loaded table has no entry for the date', async () => {
    const fetches = pendingFetches();
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.DIRECT,
    );

    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.directIV).toBe('');
  });

  it('falls back to VIX mode when the table fails to load', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetches = pendingFetches();
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.DIRECT,
    );

    fetches.fail();

    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(result.current.loaded).toBe(false);
    expect(result.current.ivMode).toBe(IV_MODES.VIX);
  });

  it('keeps a manual IV mode choice on a re-run that retries a failed load', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetches = pendingFetches();
    const historyData = pastDateWithoutSchwabVix1d();
    const { result, rerender } = renderWithIvState(historyData, IV_MODES.VIX);
    fetches.fail();
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());

    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    rerender({ timeMinute: '35', historyData });

    expect(fetches.fetchSpy).toHaveBeenCalledTimes(2); // the re-run retried
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });

  // ── A manual pick while the choice is provisional (ivModeEdited) ──

  it('keeps a manual VIX pick made before the table loads when the table then has VIX1D for the date', async () => {
    const fetches = pendingFetches();
    // The previous date left DIRECT; VIX is provisional while the table loads.
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.DIRECT,
    );
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    // The user tries Direct IV, then goes back to VIX on purpose.
    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    act(() => result.current.userSetsIvMode(IV_MODES.VIX));
    fetches.respond(VIX1D_TABLE);

    // σ still tracks the table, so the effect re-ran after the load; the
    // settle was skipped and the user's mode stands.
    await waitFor(() => expect(result.current.directIV).toBe('0.1650'));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);
  });

  it('keeps a manual DIRECT pick made before the table loads when the table then has no entry for the date', async () => {
    const fetches = pendingFetches();
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.VIX,
    );

    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });

  it('counts "Use VIX1D as σ" before the table loads as a manual pick', async () => {
    const fetches = pendingFetches();
    const { result } = renderWithIvState(
      pastDateWithoutSchwabVix1d(),
      IV_MODES.VIX,
    );

    // VIX1D typed from TradingView into the term-structure card.
    act(() => result.current.userUsesVix1dAsSigma(0.185));
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1850');
  });

  it('replaces a "Use VIX1D as σ" value with the table value on a time scrub when the table has the date', async () => {
    // Pinned on purpose: σ tracks time scrubs, and the manual pick keeps
    // only the mode. Sticky manual σ values are a separate decided phase.
    const fetches = pendingFetches();
    const historyData = pastDateWithoutSchwabVix1d();
    const { result, rerender } = renderWithIvState(historyData, IV_MODES.VIX);
    fetches.respond(VIX1D_TABLE);
    await waitFor(() => expect(result.current.directIV).toBe('0.1650'));

    act(() => result.current.userUsesVix1dAsSigma(0.185));
    expect(result.current.directIV).toBe('0.1850');
    rerender({ timeMinute: '35', historyData });

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1650');
  });

  it('keeps a manual DIRECT pick made after a failed load when a later retry has no entry for the date', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetches = pendingFetches();
    const historyData = pastDateWithoutSchwabVix1d();
    const { result, rerender } = renderWithIvState(historyData, IV_MODES.VIX);
    fetches.fail();
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());

    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    rerender({ timeMinute: '35', historyData }); // the scrub retries the load
    expect(fetches.fetchSpy).toHaveBeenCalledTimes(2);
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });

  it('clears the manual-pick flag on a new date, so the next date auto-chooses again', async () => {
    const fetches = pendingFetches();
    const withSchwabVix1d = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-09'),
      getStateAtTime: vi
        .fn()
        .mockReturnValue(makeHistorySnapshot({ vix: 20.5, vix1d: 14.8 })),
    });
    const { result, rerender, ivModeEdited } = renderWithIvState(
      withSchwabVix1d,
      IV_MODES.VIX,
      { selectedDate: '2026-03-09' },
    );
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    act(() => result.current.userSetsIvMode(IV_MODES.VIX));

    // Next date has no Schwab VIX1D: VIX while the table loads, then DIRECT.
    rerender({
      timeMinute: '30',
      historyData: pastDateWithoutSchwabVix1d(),
      date: '2026-03-10',
    });
    expect(ivModeEdited.current).toBe(false);
    expect(fetches.fetchSpy).toHaveBeenCalledTimes(1);
    fetches.respond(VIX1D_TABLE);

    await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));
    expect(result.current.directIV).toBe('0.1650');
  });

  it('chooses the mode once per date: a scrub to a candle without VIX1D keeps DIRECT', async () => {
    const fetches = pendingFetches();
    // Schwab VIX1D at 11:30 but not at 11:35; the table lacks the date.
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn((_hour: number, minute: number) =>
        makeHistorySnapshot({ vix: 20.5, vix1d: minute === 30 ? 14.8 : null }),
      ),
    });
    const { result, rerender } = renderWithIvState(historyData, IV_MODES.VIX);
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);

    rerender({ timeMinute: '35', historyData });
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1480');
  });

  it('never loads the table or changes IV mode in live mode', () => {
    const fetches = pendingFetches();
    const { result } = renderWithIvState(
      createHistoryData({ hasHistory: false }),
      IV_MODES.DIRECT,
      { selectedDate: getETToday() },
    );

    expect(fetches.fetchSpy).not.toHaveBeenCalled();
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });

  // ── Today's live quotes vs the selected date ──

  it("never applies today's live VIX1D to a past date that has no VIX1D anywhere", async () => {
    const fetches = pendingFetches();
    const historyData = pastDateWithoutSchwabVix1d();
    const { result, rerender, setters } = renderWithIvState(
      historyData,
      IV_MODES.VIX,
      { quotes: mockQuotes },
    );
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    rerender({ timeMinute: '35', historyData });

    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.directIV).toBe('');
    // Not even transiently, inside a flush that a later call overwrote.
    expect(setters.setIvMode).not.toHaveBeenCalledWith(IV_MODES.DIRECT);
    expect(setters.setDirectIVInput).not.toHaveBeenCalled();
  });

  it("still sets DIRECT with today's live VIX1D as σ on today", () => {
    const fetches = pendingFetches();
    const { result, setters } = renderWithIvState(
      createHistoryData({ hasHistory: false }),
      IV_MODES.VIX,
      { quotes: mockQuotes, selectedDate: getETToday() },
    );

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1420');
    expect(setters.setDirectIVInput).toHaveBeenCalledWith('0.1420');
    // Today also keeps today's live VIX and prices, and needs no table.
    expect(setters.setVixInput).toHaveBeenCalledWith('18.50');
    expect(setters.setSpotPrice).toHaveBeenCalledWith('580.00');
    expect(fetches.fetchSpy).not.toHaveBeenCalled();
  });

  // ── A past date without intraday history ──
  // Older than ~60 days, a failed history fetch, a weekend or a holiday, or
  // a history fetch still in flight: the same rule as a date with history,
  // from the static table alone. Today's live quotes are loaded throughout,
  // as they are for the owner on any date.

  /** No intraday history for the selected date. */
  const noHistory = () => createHistoryData({ hasHistory: false });

  it("sets DIRECT with the table's VIX1D as σ once the table loads, VIX until then", async () => {
    const fetches = pendingFetches();
    // Today's live VIX1D left DIRECT before the owner picked the date.
    const { result, setters } = renderWithIvState(
      noHistory(),
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );

    expect(fetches.fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    fetches.respond(VIX1D_TABLE);

    await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));
    expect(result.current.directIV).toBe('0.1650');
    expect(setters.setDirectIVInput).not.toHaveBeenCalledWith('0.1420');
  });

  it("sets VIX mode, off neither today's VIX1D nor today's VIX, when the table lacks the date", async () => {
    const fetches = pendingFetches();
    const { result, rerender, setters } = renderWithIvState(
      noHistory(),
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    rerender({ timeMinute: '35', historyData: noHistory() });

    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.directIV).toBe('');
    expect(setters.setIvMode).not.toHaveBeenCalledWith(IV_MODES.DIRECT);
    expect(setters.setDirectIVInput).not.toHaveBeenCalled();
    // VIX mode prices off the VIX field, which useVixData fills from the
    // date's daily OHLC; today's live 18.50 must not overwrite it.
    expect(setters.setVixInput).not.toHaveBeenCalledWith('18.50');
  });

  it('keeps a manual VIX pick made while the table loads, and σ follows the table', async () => {
    const fetches = pendingFetches();
    const historyData = noHistory();
    const { result, rerender } = renderWithIvState(
      historyData,
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    act(() => result.current.userSetsIvMode(IV_MODES.VIX));
    fetches.respond(VIX1D_TABLE);
    await waitFor(() => expect(result.current.directIV).toBe('0.1650'));
    rerender({ timeMinute: '35', historyData });

    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.directIV).toBe('0.1650');
  });

  it('chooses again on a new date without intraday history, dropping the manual pick', async () => {
    const fetches = pendingFetches();
    const historyData = noHistory();
    const { result, rerender, ivModeEdited } = renderWithIvState(
      historyData,
      IV_MODES.VIX,
      { quotes: mockQuotes },
    );
    fetches.respond({
      ...VIX1D_TABLE,
      '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 },
    });
    await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));
    act(() => result.current.userSetsIvMode(IV_MODES.VIX));

    rerender({ timeMinute: '30', historyData, date: '2026-03-09' });

    expect(ivModeEdited.current).toBe(false);
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1500');
  });

  it("chooses again from the snapshot when the date's history arrives after a table-only choice", async () => {
    const fetches = pendingFetches();
    // History still loading; the table answers first, without the date.
    const { result, rerender } = renderWithIvState(
      noHistory(),
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    rerender({
      timeMinute: '30',
      historyData: createHistoryData({
        hasHistory: true,
        history: mockHistory('2026-03-10'),
        getStateAtTime: vi
          .fn()
          .mockReturnValue(makeHistorySnapshot({ vix: 20.5, vix1d: 14.8 })),
      }),
    });

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1480');
  });

  it("keeps a manual pick when the date's history arrives after a table-only choice", async () => {
    const fetches = pendingFetches();
    const { result, rerender } = renderWithIvState(
      noHistory(),
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.userSetsIvMode(IV_MODES.VIX));

    rerender({
      timeMinute: '30',
      historyData: createHistoryData({
        hasHistory: true,
        history: mockHistory('2026-03-10'),
        getStateAtTime: vi
          .fn()
          .mockReturnValue(makeHistorySnapshot({ vix: 20.5, vix1d: 14.8 })),
      }),
    });

    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.directIV).toBe('0.1480');
  });

  it('chooses again on a past date after today, which settled its own mode', async () => {
    const fetches = pendingFetches();
    const today = getETToday();
    const historyData = noHistory();
    const { result, rerender, setters } = renderWithIvState(
      historyData,
      IV_MODES.DIRECT,
      { quotes: mockQuotes },
    );
    fetches.respond({ '2026-03-09': { o: 15, h: 16, l: 14, c: 15.5 } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);

    // Today: DIRECT on today's live VIX1D.
    rerender({ timeMinute: '30', historyData, date: today });
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1420');

    // Back to the past date: VIX again, not today's DIRECT and σ.
    setters.setDirectIVInput.mockClear();
    rerender({ timeMinute: '30', historyData, date: '2026-03-10' });

    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(setters.setDirectIVInput).not.toHaveBeenCalledWith('0.1420');
  });

  // ── Another date's history, still held while the selected date's loads ──
  // useHistoryData keeps the last date's history until the new date's fetch
  // settles. The new date has none of it yet.

  it("restores today's VIX and σ when today has no candles after a past date with history", () => {
    pendingFetches();
    const today = getETToday();
    const pastHistory = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi
        .fn()
        .mockReturnValue(makeHistorySnapshot({ vix: 20.5, vix1d: 14.8 })),
    });
    const { result, rerender } = renderWithIvState(noHistory(), IV_MODES.VIX, {
      quotes: mockQuotes,
      selectedDate: today,
    });
    expect(result.current.vixInput).toBe('18.50');

    rerender({
      timeMinute: '30',
      historyData: pastHistory,
      date: '2026-03-10',
    });
    expect(result.current.vixInput).toBe('20.50');
    expect(result.current.directIV).toBe('0.1480');

    // Back to today: the past date's history stays up while today's loads,
    // then today's fetch returns no candles (pre-market, a weekend, a
    // holiday or a closed session).
    rerender({ timeMinute: '30', historyData: pastHistory, date: today });
    rerender({ timeMinute: '30', historyData: noHistory(), date: today });

    expect(result.current.vixInput).toBe('18.50');
    expect(result.current.directIV).toBe('0.1420');
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
  });
});
