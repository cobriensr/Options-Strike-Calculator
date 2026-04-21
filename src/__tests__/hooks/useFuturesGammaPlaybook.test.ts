import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GexStrikeLevel } from '../../hooks/useGexPerStrike';
import type { FuturesDataState } from '../../hooks/useFuturesData';

// ── Mocks ────────────────────────────────────────────────────
//
// We mock the two upstream hooks at the module level so the aggregator
// hook's reducer logic is exercised against deterministic fixtures rather
// than the real fetchers.

vi.mock('../../hooks/useGexPerStrike', () => ({
  useGexPerStrike: vi.fn(),
}));
vi.mock('../../hooks/useFuturesData', () => ({
  useFuturesData: vi.fn(),
}));
vi.mock('../../hooks/useSpotGexHistory', () => ({
  useSpotGexHistory: vi.fn(),
}));
vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useGexPerStrike } from '../../hooks/useGexPerStrike';
import { useFuturesData } from '../../hooks/useFuturesData';
import { useSpotGexHistory } from '../../hooks/useSpotGexHistory';
import type { UseSpotGexHistoryReturn } from '../../hooks/useSpotGexHistory';
import { useFuturesGammaPlaybook } from '../../hooks/useFuturesGammaPlaybook';

// ── Fixtures ─────────────────────────────────────────────────

function makeStrike(
  strike: number,
  netGamma: number,
  price: number,
): GexStrikeLevel {
  return {
    strike,
    price,
    callGammaOi: 0,
    putGammaOi: 0,
    netGamma,
    callGammaVol: 0,
    putGammaVol: 0,
    netGammaVol: 0,
    volReinforcement: 'neutral',
    callGammaAsk: 0,
    callGammaBid: 0,
    putGammaAsk: 0,
    putGammaBid: 0,
    callCharmOi: 0,
    putCharmOi: 0,
    netCharm: 0,
    callCharmVol: 0,
    putCharmVol: 0,
    netCharmVol: 0,
    callDeltaOi: 0,
    putDeltaOi: 0,
    netDelta: 0,
    callVannaOi: 0,
    putVannaOi: 0,
    netVanna: 0,
    callVannaVol: 0,
    putVannaVol: 0,
    netVannaVol: 0,
  };
}

function gexReturn(
  overrides: Partial<{
    strikes: GexStrikeLevel[];
    loading: boolean;
    error: string | null;
    timestamp: string | null;
    isScrubbed: boolean;
    isLive: boolean;
  }> = {},
) {
  return {
    strikes: [],
    loading: false,
    error: null,
    timestamp: null,
    timestamps: [],
    selectedDate: '2026-04-20',
    setSelectedDate: vi.fn(),
    isLive: true,
    isToday: true,
    isScrubbed: false,
    canScrubPrev: false,
    canScrubNext: false,
    scrubPrev: vi.fn(),
    scrubNext: vi.fn(),
    scrubTo: vi.fn(),
    scrubLive: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

function historyReturn(
  overrides: Partial<UseSpotGexHistoryReturn> = {},
): UseSpotGexHistoryReturn {
  return {
    series: [],
    availableDates: [],
    timestamp: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

function futuresReturn(
  overrides: Partial<FuturesDataState> = {},
): FuturesDataState {
  return {
    snapshots: [
      {
        symbol: 'ES',
        price: 5812,
        change1hPct: 0,
        changeDayPct: 0,
        volumeRatio: null,
      },
    ],
    vxTermSpread: null,
    vxTermStructure: null,
    esSpxBasis: 12,
    updatedAt: '2026-04-20T15:00:00Z',
    oldestTs: null,
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
    ...overrides,
  };
}

// 14:00 UTC on 2026-04-20 → 09:00 CT (MORNING).
const MORNING_UTC = new Date('2026-04-20T14:00:00Z');

// ── Lifecycle ────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MORNING_UTC);
  vi.mocked(useGexPerStrike).mockReturnValue(gexReturn());
  vi.mocked(useFuturesData).mockReturnValue(futuresReturn());
  vi.mocked(useSpotGexHistory).mockReturnValue(historyReturn());
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ticker: 'SPX', maxPain: null, asOf: '' }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────

describe('useFuturesGammaPlaybook', () => {
  it('returns neutral defaults when both hooks are empty', () => {
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    // Empty strikes → no zero-gamma → TRANSITIONING.
    expect(result.current.regime).toBe('TRANSITIONING');
    expect(result.current.verdict).toBe('STAND_ASIDE');
    expect(result.current.levels).toEqual([]);
    expect(result.current.rules).toEqual([]);
    expect(result.current.bias.esCallWall).toBeNull();
    expect(result.current.bias.esPutWall).toBeNull();
    expect(result.current.bias.esZeroGamma).toBeNull();
    expect(result.current.bias.firedTriggers).toEqual([]);
  });

  it('reports loading while either upstream hook is loading', () => {
    vi.mocked(useGexPerStrike).mockReturnValue(gexReturn({ loading: true }));
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.loading).toBe(true);
  });

  it('surfaces upstream errors as Error instances', () => {
    vi.mocked(useFuturesData).mockReturnValue(
      futuresReturn({ error: 'Network down' }),
    );
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Network down');
  });

  it('derives POSITIVE regime when spot is clearly above zero-gamma with net-long gamma', () => {
    // Build a strike ladder so cumulative gamma crosses zero near 5797.5
    // and spot sits well outside the 0.5% TRANSITIONING band
    // (band half-width ≈ 5797.5 × 0.005 ≈ 29 pts, so spot must be > ~5826).
    const spot = 5870;
    const strikes = [
      makeStrike(5780, -100, spot),
      makeStrike(5790, -50, spot),
      // Flip: cumulative goes positive past 5800
      makeStrike(5800, 200, spot),
      makeStrike(5810, 150, spot),
      makeStrike(5820, 400, spot), // call wall (largest positive)
    ];
    vi.mocked(useGexPerStrike).mockReturnValue(gexReturn({ strikes }));

    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.regime).toBe('POSITIVE');
    expect(result.current.verdict).toBe('MEAN_REVERT');
    expect(result.current.phase).toBe('MORNING');

    // ES levels: call wall 5820 + basis 12 = 5832 rounded to nearest tick.
    const callWall = result.current.levels.find((l) => l.kind === 'CALL_WALL');
    expect(callWall?.spxStrike).toBe(5820);
    expect(callWall?.esPrice).toBeCloseTo(5832, 2);

    // Rule IDs in POSITIVE + MORNING: fade + lift, no charm drift.
    const ids = result.current.rules.map((r) => r.id);
    expect(ids).toContain('pos-fade-call-wall');
    expect(ids).toContain('pos-lift-put-wall');
    expect(ids).not.toContain('pos-charm-drift');

    // Bias payload exports the ES-mapped levels.
    expect(result.current.bias.regime).toBe('POSITIVE');
    expect(result.current.bias.esCallWall).toBeCloseTo(5832, 2);
  });

  it('yields empty ES levels when basis is missing', () => {
    const spot = 5810;
    const strikes = [makeStrike(5790, -50, spot), makeStrike(5810, 200, spot)];
    vi.mocked(useGexPerStrike).mockReturnValue(gexReturn({ strikes }));
    vi.mocked(useFuturesData).mockReturnValue(
      futuresReturn({ esSpxBasis: null }),
    );

    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.levels).toEqual([]);
    // Rules rely on ES levels — they collapse too.
    expect(result.current.rules).toEqual([]);
  });

  it('uses scrubbed timestamp for session phase when scrubbed', () => {
    // 22:30 UTC = 17:30 CT → POST_CLOSE.
    const strikes = [makeStrike(5800, 100, 5800)];
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({
        strikes,
        isScrubbed: true,
        timestamp: '2026-04-20T22:30:00Z',
      }),
    );
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.phase).toBe('POST_CLOSE');
    // Outside RTH → no rules regardless of regime.
    expect(result.current.rules).toEqual([]);
  });

  it('re-aligns ES data to the pinned timestamp when scrubbed', () => {
    // When scrubbed, the hook must pass the GEX timestamp into useFuturesData
    // so the ES price/basis being rendered matches the pinned GEX snapshot.
    const scrubTs = '2026-04-20T18:15:00Z';
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({
        strikes: [],
        isScrubbed: true,
        timestamp: scrubTs,
      }),
    );
    renderHook(() => useFuturesGammaPlaybook(true));
    expect(useFuturesData).toHaveBeenCalledWith(scrubTs);
  });

  it('passes undefined to useFuturesData when live (not scrubbed)', () => {
    renderHook(() => useFuturesGammaPlaybook(true));
    expect(useFuturesData).toHaveBeenCalledWith(undefined);
  });

  it('re-exports scrub controls from useGexPerStrike', () => {
    const scrubPrev = vi.fn();
    const scrubNext = vi.fn();
    const scrubTo = vi.fn();
    const scrubLive = vi.fn();
    const setSelectedDate = vi.fn();
    const refresh = vi.fn();
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({
        strikes: [],
        timestamp: '2026-04-20T14:30:00Z',
        // Override the scrub-handler fields directly — the gexReturn helper
        // spreads `overrides` last, so these replace the default vi.fn()s.
      }),
    );
    // Re-mock with explicit handlers so we can assert identity passthrough.
    vi.mocked(useGexPerStrike).mockReturnValue({
      ...gexReturn(),
      timestamp: '2026-04-20T14:30:00Z',
      timestamps: ['2026-04-20T14:30:00Z'],
      scrubPrev,
      scrubNext,
      scrubTo,
      scrubLive,
      setSelectedDate,
      refresh,
      canScrubPrev: true,
      canScrubNext: false,
      isLive: true,
      isScrubbed: false,
    });

    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.scrubPrev).toBe(scrubPrev);
    expect(result.current.scrubNext).toBe(scrubNext);
    expect(result.current.scrubTo).toBe(scrubTo);
    expect(result.current.scrubLive).toBe(scrubLive);
    expect(result.current.setSelectedDate).toBe(setSelectedDate);
    expect(result.current.refresh).toBe(refresh);
    expect(result.current.timestamp).toBe('2026-04-20T14:30:00Z');
    expect(result.current.timestamps).toEqual(['2026-04-20T14:30:00Z']);
    expect(result.current.canScrubPrev).toBe(true);
    expect(result.current.canScrubNext).toBe(false);
    expect(result.current.isLive).toBe(true);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('exposes ES price and basis from useFuturesData', () => {
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.esPrice).toBe(5812);
    expect(result.current.esSpxBasis).toBe(12);
  });

  it('returns an empty regimeTimeline when history has no series', () => {
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.regimeTimeline).toEqual([]);
  });

  it('populates regimeTimeline from useSpotGexHistory', () => {
    // Strike ladder so zero-gamma resolves above the spot used in the
    // timeline points — the classifier needs a concrete zeroGamma to pick
    // POSITIVE / NEGATIVE.
    const strikes = [
      makeStrike(5790, -100, 5812),
      makeStrike(5800, 200, 5812),
      makeStrike(5810, 300, 5812),
    ];
    vi.mocked(useGexPerStrike).mockReturnValue(gexReturn({ strikes }));
    vi.mocked(useSpotGexHistory).mockReturnValue(
      historyReturn({
        series: [
          {
            ts: '2026-04-20T14:00:00Z',
            netGex: 1_000_000,
            spot: 5870,
          },
          {
            ts: '2026-04-20T14:30:00Z',
            netGex: -500_000,
            spot: 5750,
          },
        ],
      }),
    );
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    expect(result.current.regimeTimeline).toHaveLength(2);
    expect(result.current.regimeTimeline[0]?.ts).toBe('2026-04-20T14:00:00Z');
    // Each point carries the classified regime
    expect(result.current.regimeTimeline[0]?.regime).toBeDefined();
  });

  it('calls useSpotGexHistory with the selected date', () => {
    renderHook(() => useFuturesGammaPlaybook(true));
    expect(useSpotGexHistory).toHaveBeenCalledWith('2026-04-20', true);
  });

  it('fetches live max-pain from the endpoint when isLive and not scrubbed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticker: 'SPX', maxPain: 5800, asOf: '' }),
    });
    const strikes = [
      makeStrike(5790, -100, 5812),
      makeStrike(5800, 200, 5812),
      makeStrike(5810, 300, 5812),
    ];
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({ strikes, isLive: true, isScrubbed: false }),
    );

    const { result, rerender } = renderHook(() =>
      useFuturesGammaPlaybook(true),
    );
    // Let the async fetch settle.
    await vi.runOnlyPendingTimersAsync();
    rerender();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/max-pain-current',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    const maxPain = result.current.levels.find((l) => l.kind === 'MAX_PAIN');
    // Basis 12 → ES 5812 from SPX 5800
    expect(maxPain?.esPrice).toBeCloseTo(5812, 1);
  });

  it('does not populate MAX_PAIN in scrub mode (raw OI unavailable)', async () => {
    // Scrub mode should NOT call the live endpoint and should resolve to
    // null because the gamma-weighted OI fields aren't valid max-pain
    // inputs. Documented tradeoff.
    const strikes = [
      makeStrike(5790, -100, 5812),
      makeStrike(5800, 200, 5812),
      makeStrike(5810, 300, 5812),
    ];
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({
        strikes,
        isLive: false,
        isScrubbed: true,
        timestamp: '2026-04-20T18:15:00Z',
      }),
    );

    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    await vi.runOnlyPendingTimersAsync();

    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/max-pain-current',
      expect.anything(),
    );
    const maxPain = result.current.levels.find((l) => l.kind === 'MAX_PAIN');
    expect(maxPain).toBeUndefined();
  });

  it('handles missing/null max-pain gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticker: 'SPX', maxPain: null, asOf: '' }),
    });
    const strikes = [makeStrike(5800, 200, 5812)];
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({ strikes, isLive: true, isScrubbed: false }),
    );

    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    await vi.runOnlyPendingTimersAsync();

    const maxPain = result.current.levels.find((l) => l.kind === 'MAX_PAIN');
    expect(maxPain).toBeUndefined();
    expect(result.current.bias.esCallWall).not.toBeNull();
  });

  it('exposes CT session phase boundaries derived from the active date', () => {
    vi.mocked(useGexPerStrike).mockReturnValue(
      gexReturn({ strikes: [], timestamp: null }),
    );
    const { result } = renderHook(() => useFuturesGammaPlaybook(true));
    const b = result.current.sessionPhaseBoundaries;
    // Default selectedDate from the gexReturn helper is '2026-04-20'.
    expect(b.open).toMatch(/2026-04-20T09:30:00/);
    expect(b.lunch).toMatch(/2026-04-20T12:30:00/);
    expect(b.power).toMatch(/2026-04-20T15:30:00/);
    expect(b.close).toMatch(/2026-04-20T16:30:00/);
  });
});
