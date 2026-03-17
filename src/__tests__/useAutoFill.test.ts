import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoFill } from '../hooks/useAutoFill';
import { IV_MODES } from '../constants';
import type { MarketDataState } from '../hooks/useMarketData';
import type { UseVixDataReturn } from '../hooks/useVixData';
import type {
  UseHistoryDataReturn,
  HistorySnapshot,
} from '../hooks/useHistoryData';
import type { UseVix1dDataReturn } from '../hooks/useVix1dData';
import type { QuotesResponse, HistoryResponse } from '../types/api';

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
    refresh: vi.fn(),
    lastUpdated: null,
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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

  it('does not overwrite existing user input in the live-fill effect', () => {
    // The first effect (live auto-fill) skips non-empty fields.
    // The second effect (history restore) may still call setSpotPrice
    // when hasHistory=false and quotes exist — that's the "restore live"
    // path. Here we only check that the first effect respects non-empty inputs
    // by verifying VIX is not overwritten (setVixInput), since the second
    // effect doesn't touch VIX.
    const market = createMarket(mockQuotes);
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotPrice: '590.00',
        spxDirect: '5900',
        vixInput: '22.00',
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

  it('auto-switches to direct IV mode when VIX1D is available', () => {
    const market = createMarket(mockQuotes);
    const vix = createVix();

    renderHook(() =>
      useAutoFill({
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '580',
        spxDirect: '5800',
        vixInput: '18',
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
        spotPrice: '580',
        spxDirect: '5800',
        vixInput: '18',
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
        spotPrice: '580',
        spxDirect: '5800',
        vixInput: '18',
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

  it('does not touch time when already set to non-default', () => {
    const market = createMarket(mockQuotes);

    renderHook(() =>
      useAutoFill({
        spotPrice: '580',
        spxDirect: '5800',
        vixInput: '18',
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

  it('does nothing when no market data', () => {
    renderHook(() =>
      useAutoFill({
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '575',
        spxDirect: '5750',
        vixInput: '20',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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

  it('returns null when history exists but getStateAtTime returns null', () => {
    const historyData = createHistoryData({
      hasHistory: true,
      history: mockHistory('2026-03-10'),
      getStateAtTime: vi.fn().mockReturnValue(null),
    });

    const { result } = renderHook(() =>
      useAutoFill({
        spotPrice: '',
        spxDirect: '',
        vixInput: '',
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
