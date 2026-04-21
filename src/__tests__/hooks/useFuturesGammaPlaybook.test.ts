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

import { useGexPerStrike } from '../../hooks/useGexPerStrike';
import { useFuturesData } from '../../hooks/useFuturesData';
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MORNING_UTC);
  vi.mocked(useGexPerStrike).mockReturnValue(gexReturn());
  vi.mocked(useFuturesData).mockReturnValue(futuresReturn());
});

afterEach(() => {
  vi.restoreAllMocks();
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
});
