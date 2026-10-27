/**
 * The VIX field on a past date, from real useVixData and useAutoFill state,
 * called in App's order (useVixData's effects run first in a commit).
 *
 * useVixData fills the date's daily VIX OHLC (the table, else the API).
 * useAutoFill fills today's live VIX on today and, on a date with intraday
 * history, the snapshot's VIX at the selected time, which wins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState, useCallback } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAutoFill } from '../../hooks/useAutoFill';
import { useVixData } from '../../hooks/useVixData';
import { useVix1dData } from '../../hooks/useVix1dData';
import { IV_MODES } from '../../constants';
import { getETToday } from '../../utils/timezone';
import { loadCachedVixData } from '../../utils/vixStorage';
import type { IVMode, VIXDataMap } from '../../types';
import type { MarketDataState } from '../../hooks/useMarketData';
import type {
  UseHistoryDataReturn,
  HistorySnapshot,
} from '../../hooks/useHistoryData';
import type { QuotesResponse, HistoryResponse } from '../../types/api';

vi.mock('../../utils/vixStorage', () => ({
  cacheVixData: vi.fn(),
  loadCachedVixData: vi.fn(),
  loadStaticVixData: vi.fn(() => Promise.resolve(null)),
}));

// ============================================================
// DATA
// ============================================================

const P1 = '2026-03-10';
const P2 = '2026-03-11';
/** In the VIX OHLC table, not in the VIX1D table. */
const IN_VIX_TABLE = '2026-03-12';
/** In neither table: its daily VIX OHLC comes from /api/vix-ohlc. */
const IN_NO_TABLE = '2026-03-13';

/** useVixData's daily VIX OHLC table. */
const VIX_OHLC: VIXDataMap = {
  [P1]: { open: 21, high: 22, low: 20.5, close: 21.5 },
  [P2]: { open: 23, high: 24, low: 22.5, close: 23.5 },
  [IN_VIX_TABLE]: { open: 25, high: 26, low: 24.5, close: 25.5 },
};

/** The static VIX1D table (useVix1dData). */
const VIX1D_TABLE = {
  [P1]: { o: 16.5, h: 17.2, l: 16.1, c: 16.9 },
  [P2]: { o: 17.5, h: 18.2, l: 17.1, c: 17.9 },
};

const quote = (price: number) => ({
  price,
  open: price,
  high: price,
  low: price,
  prevClose: price,
  change: 0,
  changePct: 0,
});

/** Today's live quotes: VIX 18.50, VIX1D 14.20. */
const LIVE_QUOTES: QuotesResponse = {
  spy: quote(580),
  spx: quote(5820),
  vix: quote(18.5),
  vix1d: quote(14.2),
  vix9d: null,
  vvix: null,
  marketOpen: false,
  asOf: '2026-03-17T16:30:00Z',
};

const MARKET: MarketDataState = {
  data: {
    quotes: LIVE_QUOTES,
    intraday: null,
    yesterday: null,
    events: null,
    movers: null,
  },
  loading: false,
  hasData: true,
  needsAuth: false,
  fetchedAt: null,
  quotesFetchedAt: null,
  session: 'closed',
  marketOpen: false,
};

const NO_HISTORY: UseHistoryDataReturn = {
  history: null,
  loading: false,
  error: null,
  getStateAtTime: () => null,
  hasHistory: false,
};

/** Intraday history for `date`: VIX 20.50 at every time. */
function historyFor(date: string, vix1d: number | null): UseHistoryDataReturn {
  const empty = { candles: [], previousClose: 0, previousDay: null };
  const history: HistoryResponse = {
    date,
    spx: empty,
    vix: empty,
    vix1d: empty,
    vix9d: empty,
    vvix: empty,
    candleCount: 78,
    asOf: '2026-03-17T16:30:00Z',
  };
  const snapshot: HistorySnapshot = {
    spot: 5750,
    spy: 575,
    runningOHLC: { open: 5740, high: 5760, low: 5730, last: 5750 },
    openingRange: null,
    yesterday: null,
    vix: 20.5,
    vixPrevClose: 21,
    vix1d,
    vix9d: null,
    vvix: null,
    previousClose: 5740,
    candle: {
      datetime: Date.parse(`${date}T15:30:00Z`),
      time: '11:30',
      open: 5748,
      high: 5752,
      low: 5746,
      close: 5750,
    },
    candleIndex: 24,
    totalCandles: 78,
  };
  return {
    history,
    loading: false,
    error: null,
    getStateAtTime: () => snapshot,
    hasHistory: true,
  };
}

// ============================================================
// HARNESS
// ============================================================

/**
 * fetch for the two tables' endpoints: the VIX1D table answers at once;
 * each /api/vix-ohlc call waits until the test answers it.
 */
function routeFetches() {
  const vixOhlc = new Map<string, (res: Response) => void>();
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === '/api/vix1d-daily') {
      return Promise.resolve(
        new Response(JSON.stringify(VIX1D_TABLE), { status: 200 }),
      );
    }
    if (url.startsWith('/api/vix-ohlc')) {
      return new Promise<Response>((resolve) => vixOhlc.set(url, resolve));
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  return {
    answerVixOhlc: (date: string, open: number, close: number) =>
      vixOhlc.get(`/api/vix-ohlc?date=${date}`)!(
        new Response(
          JSON.stringify({
            open,
            high: open + 1,
            low: open - 1,
            close,
            count: 78,
          }),
          { status: 200 },
        ),
      ),
  };
}

function renderCalculator(initialMode: IVMode) {
  // Built once, outside the render callback, so the effects' deps hold.
  const fixed = {
    spotEdited: { current: false },
    spxEdited: { current: false },
    vixEdited: { current: false },
    timeEdited: { current: false },
    ivModeEdited: { current: false },
    setSpotPrice: vi.fn(),
    setSpxDirect: vi.fn(),
    setTimeHour: vi.fn(),
    setTimeMinute: vi.fn(),
    setTimeAmPm: vi.fn(),
    setTimezone: vi.fn(),
  };
  // Every VIX field write, in order, so a test can assert a value was never
  // written even when a later write in the same flush replaced it.
  const vixWrites: string[] = [];
  const rendered = renderHook(
    ({ historyData }: { historyData: UseHistoryDataReturn }) => {
      const [ivMode, setIvMode] = useState<IVMode>(initialMode);
      const [vixInput, setVixInputState] = useState('');
      const [directIV, setDirectIVInput] = useState('');
      const setVixInput = useCallback((v: string) => {
        vixWrites.push(v);
        setVixInputState(v);
      }, []);
      // The user's mode toggle, the way App's handler makes it.
      const userSetsIvMode = (mode: IVMode) => {
        fixed.ivModeEdited.current = true;
        setIvMode(mode);
      };
      // 11:30 AM ET: the daily open's half of the session.
      const vix = useVixData(ivMode, '11', 'AM', 'ET', setVixInput);
      const vix1dStatic = useVix1dData();
      useAutoFill({
        ...fixed,
        timeHour: '11',
        timeMinute: '30',
        timeAmPm: 'AM',
        timezone: 'ET',
        setVixInput,
        setIvMode,
        setDirectIVInput,
        market: MARKET,
        vix,
        historyData,
        vix1dStatic,
      });
      return {
        ivMode,
        userSetsIvMode,
        vixInput,
        directIV,
        vixOHLC: vix.vixOHLC,
        setSelectedDate: vix.setSelectedDate,
        vix1dLoaded: vix1dStatic.loaded,
      };
    },
    { initialProps: { historyData: NO_HISTORY } },
  );
  return { ...rendered, vixWrites };
}

// ============================================================
// TESTS
// ============================================================

describe('the VIX field on a past date (useVixData + useAutoFill)', () => {
  const today = getETToday();

  beforeEach(() => {
    vi.mocked(loadCachedVixData).mockReturnValue({
      data: VIX_OHLC,
      source: 'test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds the past date's daily VIX in DIRECT mode, not today's live VIX", async () => {
    routeFetches();
    const { result } = renderCalculator(IV_MODES.VIX);
    act(() => result.current.setSelectedDate(today));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.vixInput).toBe('18.50');

    // P1 loads the VIX1D table (both dates are in it): DIRECT on P1's VIX1D.
    act(() => result.current.setSelectedDate(P1));
    await waitFor(() => expect(result.current.vix1dLoaded).toBe(true));
    await waitFor(() => expect(result.current.directIV).toBe('0.1650'));
    expect(result.current.vixInput).toBe('21.00');

    act(() => result.current.setSelectedDate(today));
    expect(result.current.vixInput).toBe('18.50');

    // P2, with the table loaded: DIRECT at once, and P2's daily open.
    act(() => result.current.setSelectedDate(P2));

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1750');
    expect(result.current.vixInput).toBe('23.00');
  });

  it("keeps the snapshot's VIX over the daily VIX when the date's history arrives later", async () => {
    routeFetches();
    const { result, rerender } = renderCalculator(IV_MODES.VIX);
    act(() => result.current.setSelectedDate(today));

    act(() => result.current.setSelectedDate(IN_VIX_TABLE));
    rerender({ historyData: historyFor(IN_VIX_TABLE, 14.8) });
    await waitFor(() => expect(result.current.vix1dLoaded).toBe(true));

    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.directIV).toBe('0.1480');
    expect(result.current.vixInput).toBe('20.50');
  });

  it.each([
    ['DIRECT, on the snapshot VIX1D', 14.8, IV_MODES.DIRECT],
    ['VIX, with no VIX1D for the date', null, IV_MODES.VIX],
  ] as const)(
    "keeps the snapshot's VIX when the API's daily VIX lands after the date's history (%s)",
    async (_label, vix1d, mode) => {
      const fetches = routeFetches();
      const { result, rerender } = renderCalculator(IV_MODES.VIX);
      act(() => result.current.setSelectedDate(today));

      act(() => result.current.setSelectedDate(IN_NO_TABLE));
      rerender({ historyData: historyFor(IN_NO_TABLE, vix1d) });
      await waitFor(() => expect(result.current.ivMode).toBe(mode));
      expect(result.current.vixInput).toBe('20.50');

      act(() => fetches.answerVixOhlc(IN_NO_TABLE, 27, 28));
      await waitFor(() => expect(result.current.vixOHLC?.open).toBe(27));

      expect(result.current.ivMode).toBe(mode);
      expect(result.current.vixInput).toBe('20.50');
    },
  );

  it("keeps the snapshot's VIX when the date's history switches VIX mode to DIRECT", async () => {
    routeFetches();
    const { result, rerender } = renderCalculator(IV_MODES.VIX);
    act(() => result.current.setSelectedDate(today));

    // No VIX1D for the date in the table: VIX mode on its daily open.
    act(() => result.current.setSelectedDate(IN_VIX_TABLE));
    await waitFor(() => expect(result.current.vix1dLoaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.vixInput).toBe('25.00');

    // Its intraday history lands, with Schwab VIX1D: DIRECT on it.
    rerender({ historyData: historyFor(IN_VIX_TABLE, 14.8) });
    await waitFor(() => expect(result.current.ivMode).toBe(IV_MODES.DIRECT));

    expect(result.current.directIV).toBe('0.1480');
    expect(result.current.vixInput).toBe('20.50');
  });

  it("keeps the snapshot's VIX when the user toggles the IV mode on a past date with history", async () => {
    routeFetches();
    const { result, rerender } = renderCalculator(IV_MODES.VIX);
    act(() => result.current.setSelectedDate(today));

    act(() => result.current.setSelectedDate(P1));
    rerender({ historyData: historyFor(P1, 14.8) });
    await waitFor(() => expect(result.current.vix1dLoaded).toBe(true));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.vixInput).toBe('20.50');

    act(() => result.current.userSetsIvMode(IV_MODES.VIX));
    expect(result.current.ivMode).toBe(IV_MODES.VIX);
    expect(result.current.vixInput).toBe('20.50');

    act(() => result.current.userSetsIvMode(IV_MODES.DIRECT));
    expect(result.current.ivMode).toBe(IV_MODES.DIRECT);
    expect(result.current.vixInput).toBe('20.50');
  });

  it.each([
    ['in the table', P2, '23.00'],
    ['in neither table, once the API answers', IN_NO_TABLE, '27.00'],
  ] as const)(
    "never writes the last date's daily VIX on the next past date (%s)",
    async (_label, next, nextVix) => {
      const fetches = routeFetches();
      const { result, vixWrites } = renderCalculator(IV_MODES.VIX);
      act(() => result.current.setSelectedDate(today));

      act(() => result.current.setSelectedDate(P1));
      await waitFor(() => expect(result.current.vix1dLoaded).toBe(true));
      expect(result.current.vixInput).toBe('21.00');

      vixWrites.length = 0;
      act(() => result.current.setSelectedDate(next));
      if (next === IN_NO_TABLE) {
        act(() => fetches.answerVixOhlc(IN_NO_TABLE, 27, 28));
      }
      await waitFor(() => expect(result.current.vixInput).toBe(nextVix));

      // P1's daily open never shows on the next date, even for one commit.
      expect(vixWrites).not.toContain('21.00');
    },
  );
});
