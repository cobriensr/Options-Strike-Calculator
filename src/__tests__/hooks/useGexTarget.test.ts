import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGexTarget } from '../../hooks/useGexTarget';
import type { SPXCandle } from '../../hooks/useGexTarget';
import { POLL_INTERVALS } from '../../constants';
import type {
  StrikeScore,
  TargetScore,
  MagnetFeatures,
  ComponentScores,
} from '../../utils/gex-target';

// -- Mocks

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const emptyResponse = {
  availableDates: [],
  date: null,
  timestamps: [],
  timestamp: null,
  spot: null,
  oi: null,
  vol: null,
  dir: null,
  candles: [],
  previousClose: null,
  snapshots: [],
};

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => emptyResponse,
});
vi.stubGlobal('fetch', mockFetch);

// -- Helpers

function makeFeatures(overrides: Partial<MagnetFeatures> = {}): MagnetFeatures {
  return {
    strike: 5800,
    spot: 5795,
    distFromSpot: 5,
    gexDollars: 1_000_000_000,
    callGexDollars: 600_000_000,
    putGexDollars: 400_000_000,
    callDelta: null,
    putDelta: null,
    deltaGex_1m: 10_000_000,
    deltaGex_5m: 50_000_000,
    deltaGex_20m: 150_000_000,
    deltaGex_60m: 300_000_000,
    prevGexDollars_1m: 990_000_000,
    prevGexDollars_5m: 950_000_000,
    prevGexDollars_20m: 850_000_000,
    prevGexDollars_60m: 700_000_000,
    deltaPct_1m: 0.01,
    deltaPct_5m: 0.053,
    deltaPct_20m: 0.18,
    deltaPct_60m: 0.43,
    callRatio: 0.2,
    charmNet: 1e7,
    deltaNet: 5e8,
    vannaNet: 1e7,
    minutesAfterNoonCT: 60,
    ...overrides,
  };
}

function makeComponents(
  overrides: Partial<ComponentScores> = {},
): ComponentScores {
  return {
    flowConfluence: 0.6,
    priceConfirm: 0.4,
    charmScore: 0.3,
    dominance: 0.7,
    clarity: 0.8,
    proximity: 0.9,
    ...overrides,
  };
}

function makeStrike(overrides: Partial<StrikeScore> = {}): StrikeScore {
  return {
    strike: 5800,
    features: makeFeatures(),
    components: makeComponents(),
    finalScore: 0.55,
    tier: 'HIGH',
    wallSide: 'CALL',
    rankByScore: 1,
    rankBySize: 2,
    isTarget: true,
    ...overrides,
  };
}

function makeTargetScore(overrides: Partial<TargetScore> = {}): TargetScore {
  const target = makeStrike();
  return {
    target,
    leaderboard: [target],
    ...overrides,
  };
}

function makeCandle(overrides: Partial<SPXCandle> = {}): SPXCandle {
  return {
    open: 5790,
    high: 5800,
    low: 5785,
    close: 5795,
    volume: 12_000,
    datetime: 1_743_609_600_000,
    ...overrides,
  };
}

interface SnapshotOptions {
  timestamp: string;
  timestamps: string[];
  availableDates?: string[];
  oi?: TargetScore | null;
  vol?: TargetScore | null;
  dir?: TargetScore | null;
  candles?: SPXCandle[];
  previousClose?: number | null;
  spot?: number | null;
  date?: string;
}

/** Local copy for mockBulkSnapshot helper. */
interface BulkSnapshot {
  timestamp: string;
  spot: number | null;
  oi: TargetScore | null;
  vol: TargetScore | null;
  dir: TargetScore | null;
}

function mockBulkSnapshot(
  opts: SnapshotOptions & {
    extraSnapshots?: Array<{
      timestamp: string;
      oi?: TargetScore;
      vol?: TargetScore;
      dir?: TargetScore;
    }>;
  },
) {
  const date = opts.date ?? opts.timestamp.slice(0, 10);
  const snapshots: BulkSnapshot[] = [
    ...(opts.extraSnapshots ?? []).map((s) => ({
      timestamp: s.timestamp,
      spot: 5795,
      oi: s.oi ?? null,
      vol: s.vol ?? null,
      dir: s.dir ?? null,
    })),
    {
      timestamp: opts.timestamp,
      spot: opts.spot ?? 5795,
      oi:
        opts.oi ??
        makeTargetScore({
          target: makeStrike(),
          leaderboard: [makeStrike()],
        }),
      vol:
        opts.vol ??
        makeTargetScore({
          target: makeStrike({ strike: 5810 }),
          leaderboard: [makeStrike({ strike: 5810 })],
        }),
      dir:
        opts.dir ??
        makeTargetScore({
          target: makeStrike({ strike: 5820 }),
          leaderboard: [makeStrike({ strike: 5820 })],
        }),
    },
  ];
  return {
    ok: true,
    json: async () => ({
      availableDates: opts.availableDates ?? [date],
      date,
      timestamps: opts.timestamps,
      candles: opts.candles ?? [makeCandle()],
      previousClose: opts.previousClose ?? 5780,
      snapshots,
    }),
  };
}

// -- Lifecycle

// Fixed wall-clock anchor for the suite. Most snapshot mocks use timestamps
// in the 19:58-20:00 UTC range, so anchoring `Date.now()` at 20:00:00 keeps
// them within the hook's 2-minute freshness threshold and makes `isLive`
// assertions deterministic. Tests that exercise staleness can advance the
// clock past this anchor.
const TEST_NOW = new Date('2026-04-02T20:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TEST_NOW);
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => emptyResponse,
  });
  vi.mocked(useIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();

  vi.stubGlobal('fetch', mockFetch);
});

// ============================================================
// INITIAL STATE
// ============================================================

describe('useGexTarget: initial state', () => {
  it('returns empty payload initially', async () => {
    const { result } = renderHook(() => useGexTarget(true));

    await act(async () => {});

    expect(result.current.oi).toBeNull();
    expect(result.current.vol).toBeNull();
    expect(result.current.dir).toBeNull();
    expect(result.current.candles).toEqual([]);
    expect(result.current.availableDates).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('starts in loading state', () => {
    const { result } = renderHook(() => useGexTarget(true));
    expect(result.current.loading).toBe(true);
  });
});

// ============================================================
// FETCHING
// ============================================================

describe('useGexTarget: fetching', () => {
  it('fetches on mount with the seeded date', async () => {
    renderHook(() => useGexTarget(true));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // TEST_NOW = 2026-04-02T20:00:00Z -> todayET = 2026-04-02.
    // Initial fetch is now a bulk request (?all=true).
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/gex-target-history?date=2026-04-02&all=true',
      {
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('populates the three-mode payload from the response', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:59:00Z'],
        oi: makeTargetScore({
          target: makeStrike({ strike: 5700, finalScore: 0.6 }),
          leaderboard: [makeStrike({ strike: 5700, finalScore: 0.6 })],
        }),
        vol: makeTargetScore({
          target: makeStrike({ strike: 5800, finalScore: 0.5 }),
          leaderboard: [makeStrike({ strike: 5800, finalScore: 0.5 })],
        }),
        dir: makeTargetScore({
          target: makeStrike({ strike: 5900, finalScore: 0.4 }),
          leaderboard: [makeStrike({ strike: 5900, finalScore: 0.4 })],
        }),
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.oi).not.toBeNull());

    expect(result.current.oi?.target?.strike).toBe(5700);
    expect(result.current.vol?.target?.strike).toBe(5800);
    expect(result.current.dir?.target?.strike).toBe(5900);
    // The three modes are independent -- a good sanity check that the hook
    // isn't accidentally mirroring one slot into another.
    expect(result.current.oi?.target?.strike).not.toBe(
      result.current.vol?.target?.strike,
    );
  });

  it('populates candles, previousClose, spot, and availableDates', async () => {
    const candles = [makeCandle(), makeCandle({ close: 5800 })];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:59:00Z'],
        candles,
        previousClose: 5755,
        spot: 5799.5,
        availableDates: ['2026-04-01', '2026-04-02'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.candles).toHaveLength(2));

    expect(result.current.previousClose).toBe(5755);
    expect(result.current.spot).toBe(5799.5);
    expect(result.current.availableDates).toEqual(['2026-04-01', '2026-04-02']);
  });

  it('sets timestamp from the API response', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:59:00Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() =>
      expect(result.current.timestamp).toBe('2026-04-02T19:59:00Z'),
    );
  });
});

// ============================================================
// EMPTY RESPONSE
// ============================================================

describe('useGexTarget: empty response', () => {
  it('handles an empty-database response without errors', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => emptyResponse,
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.oi).toBeNull();
    expect(result.current.vol).toBeNull();
    expect(result.current.dir).toBeNull();
    expect(result.current.candles).toEqual([]);
    expect(result.current.timestamps).toEqual([]);
    expect(result.current.availableDates).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

// ============================================================
// POLLING
// ============================================================

describe('useGexTarget: polling', () => {
  it('polls at POLL_INTERVALS.GEX_TARGET interval', async () => {
    renderHook(() => useGexTarget(true));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET);
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useGexTarget(true));

    await act(async () => {});

    const callsAfterMount = mockFetch.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET * 3);
    });

    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);
  });
});

// ============================================================
// GATING
// ============================================================

describe('useGexTarget: gating', () => {
  it('does not fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    renderHook(() => useGexTarget(true));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sets loading to false when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);

    const { result } = renderHook(() => useGexTarget(true));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });

  it('fetches once but does not poll when market is closed', async () => {
    // After-hours today: still show today's latest snapshot (BACKTEST mode),
    // but no point polling -- no fresh snapshots are being written.
    renderHook(() => useGexTarget(false));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Verify the initial fetch is a bulk request
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('&all=true');

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets loading to false when market closed', async () => {
    const { result } = renderHook(() => useGexTarget(false));

    await act(async () => {});

    expect(result.current.loading).toBe(false);
  });
});

// ============================================================
// ERROR HANDLING
// ============================================================

describe('useGexTarget: error handling', () => {
  it('sets error on non-ok response (not 401)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() =>
      expect(result.current.error).toBe('Failed to load GexTarget data'),
    );
  });

  it('does not set error on 401 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Not authenticated' }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await act(async () => {});

    expect(result.current.error).toBeNull();
  });

  it('sets error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.error).toBe('Network error'));
  });
});

// ============================================================
// BACKTEST MODE (initialDate)
// ============================================================

describe('useGexTarget: backtest mode', () => {
  it('fetches with date param when initialDate provided and does not poll', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-03-28T15:00:00Z',
        timestamps: ['2026-03-28T15:00:00Z'],
        date: '2026-03-28',
      }),
    );

    renderHook(() => useGexTarget(true, '2026-03-28'));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('?date=2026-03-28');
    expect(url).toContain('&all=true');

    // No polling on a past date.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns strikes from the backtest date and reports isLive=false', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-03-28T15:00:00Z',
        timestamps: ['2026-03-28T15:00:00Z'],
        date: '2026-03-28',
        oi: makeTargetScore({
          target: makeStrike({ strike: 5750 }),
          leaderboard: [makeStrike({ strike: 5750 })],
        }),
      }),
    );

    const { result } = renderHook(() => useGexTarget(true, '2026-03-28'));

    await waitFor(() => expect(result.current.oi?.target?.strike).toBe(5750));

    expect(result.current.loading).toBe(false);
    expect(result.current.isLive).toBe(false);
  });
});

// ============================================================
// SCRUB CONTROLS
// ============================================================

describe('useGexTarget: scrub controls', () => {
  it('exposes timestamps from the API response', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({ timestamp: '2026-04-02T19:59:00Z', timestamps: ts }),
    );

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.timestamps).toEqual(ts));
    expect(result.current.isLive).toBe(true);
  });

  it('canScrubPrev is true when at least one earlier snapshot exists', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.canScrubPrev).toBe(true));
    // canScrubNext is false on live with no scrub set.
    expect(result.current.canScrubNext).toBe(false);
  });

  it('scrubPrev updates state from cache without fetching', async () => {
    // The bulk response includes TWO snapshots: an earlier one at 19:57 and
    // the latest at 19:59. After mount, scrubbing back should serve the
    // 19:58 timestamp instantly from the in-memory cache -- no extra fetch.
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: [
          '2026-04-02T19:57:00Z',
          '2026-04-02T19:58:00Z',
          '2026-04-02T19:59:00Z',
        ],
        oi: makeTargetScore({
          target: makeStrike({ strike: 5800 }),
          leaderboard: [makeStrike({ strike: 5800 })],
        }),
        extraSnapshots: [
          {
            timestamp: '2026-04-02T19:57:00Z',
            oi: makeTargetScore({
              target: makeStrike({ strike: 5750 }),
              leaderboard: [makeStrike({ strike: 5750 })],
            }),
          },
          {
            timestamp: '2026-04-02T19:58:00Z',
            oi: makeTargetScore({
              target: makeStrike({ strike: 5750 }),
              leaderboard: [makeStrike({ strike: 5750 })],
            }),
          },
        ],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.oi?.target?.strike).toBe(5800));

    const fetchCalls = mockFetch.mock.calls.length;

    act(() => {
      result.current.scrubPrev();
    });

    // State should flip to the cached 19:58 snapshot's oi (strike 5750)
    await waitFor(() => expect(result.current.oi?.target?.strike).toBe(5750));

    // No new fetch should have fired -- served from cache
    expect(mockFetch.mock.calls.length).toBe(fetchCalls);
    expect(result.current.isLive).toBe(false);
    expect(result.current.isScrubbed).toBe(true);
  });

  it('scrubPrev falls back to fetch on cache miss', async () => {
    // Bulk response only has ONE snapshot (19:59). The timestamp list
    // includes 19:58 but no bulk snapshot for it -- cache miss forces a fetch.
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'],
        extraSnapshots: [],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const fetchCalls = mockFetch.mock.calls.length;

    act(() => {
      result.current.scrubPrev();
    });

    // A new fetch should fire for the missing timestamp
    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBe(fetchCalls + 1),
    );
    const scrubUrl = mockFetch.mock.calls[fetchCalls]?.[0] as string;
    expect(scrubUrl).toContain('ts=2026-04-02T19%3A58%3A00Z');
  });

  it('scrubNext from a scrubbed position resumes live at the end', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({ timestamp: '2026-04-02T19:59:00Z', timestamps: ts }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));

    act(() => {
      result.current.scrubNext();
    });
    await waitFor(() => expect(result.current.isLive).toBe(true));
  });

  it('scrubPrev is a no-op when no history exists', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({ timestamp: '2026-04-02T19:59:00Z', timestamps: [] }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual([]));

    const callsBefore = mockFetch.mock.calls.length;
    act(() => {
      result.current.scrubPrev();
    });
    await act(async () => {});
    expect(result.current.isScrubbed).toBe(false);
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('visibleCandles filters candles to the scrub timestamp', async () => {
    // Three candles at 1-minute intervals. Two snapshots in the bulk cache:
    // one at candle-2's time, one at candle-3's time (latest).
    const dt1 = 1_743_606_000_000;
    const dt2 = 1_743_606_060_000;
    const dt3 = 1_743_606_120_000;
    const ts1 = new Date(dt1).toISOString();
    const ts2 = new Date(dt2).toISOString();
    const ts3 = new Date(dt3).toISOString();

    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: ts3,
        timestamps: [ts1, ts2, ts3],
        candles: [
          makeCandle({ datetime: dt1 }),
          makeCandle({ datetime: dt2 }),
          makeCandle({ datetime: dt3 }),
        ],
        extraSnapshots: [{ timestamp: ts2 }],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // In live mode all three candles are visible
    expect(result.current.visibleCandles).toHaveLength(3);

    // Scrub back to ts2 -- only candles 1 and 2 should be visible
    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    expect(result.current.visibleCandles).toHaveLength(2);
    expect(result.current.visibleCandles.every((c) => c.datetime <= dt2)).toBe(
      true,
    );
  });
});

// ============================================================
// SCRUB LIVE
// ============================================================

describe('useGexTarget: scrubLive', () => {
  it('scrubLive clears scrub state and resumes polling', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({ timestamp: '2026-04-02T19:59:00Z', timestamps: ts }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));

    act(() => {
      result.current.scrubLive();
    });
    await waitFor(() => expect(result.current.isLive).toBe(true));

    const callsAfterResume = mockFetch.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET);
    });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterResume);
  });

  it('scrubLive resets selectedDate back to today when viewing a past date', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2020-01-02T15:00:00Z',
        timestamps: ['2020-01-02T15:00:00Z'],
        date: '2020-01-02',
      }),
    );

    const { result } = renderHook(() => useGexTarget(true, '2020-01-02'));
    await waitFor(() => expect(result.current.timestamps.length).toBe(1));
    expect(result.current.selectedDate).toBe('2020-01-02');
    expect(result.current.isLive).toBe(false);

    // Click "Live" -- date should snap back to today (2026-04-02 per
    // TEST_NOW) and polling should resume.
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:30Z',
        timestamps: ['2026-04-02T19:59:30Z'],
      }),
    );
    act(() => {
      result.current.scrubLive();
    });

    await waitFor(() => expect(result.current.selectedDate).toBe('2026-04-02'));
    await waitFor(() => expect(result.current.isLive).toBe(true));
  });
});

// ============================================================
// LIVE POLLING + WALL-CLOCK FRESHNESS
// ============================================================

describe('useGexTarget: live polling and freshness', () => {
  it('isLive=true when displayed snapshot is within freshness threshold', async () => {
    // Snapshot is 30s old at TEST_NOW (20:00:00) -- within 2-min threshold.
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:30Z',
        timestamps: ['2026-04-02T19:59:30Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.isLive).toBe(true));
  });

  it('isLive=false when displayed snapshot is older than freshness threshold', async () => {
    // Snapshot is 5 minutes old at TEST_NOW -- beyond 2-min threshold. This
    // covers the defense-in-depth path where polling silently fails and
    // the badge must still correctly report BACKTEST instead of lying.
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:55:00Z',
        timestamps: ['2026-04-02T19:55:00Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps.length).toBe(1));

    expect(result.current.isLive).toBe(false);
    expect(result.current.isScrubbed).toBe(false);
  });

  it('isLive flips from true to false as the wall clock advances past staleness', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:30Z',
        timestamps: ['2026-04-02T19:59:30Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.isLive).toBe(true));

    // Advance 3 minutes. Polling fires (refetches the same stale snapshot)
    // and the wall-clock ticker fires (re-snapping `nowMs`). The freshness
    // check should now flip to false because (now - timestamp) > 2 min.
    await act(async () => {
      vi.advanceTimersByTime(3 * 60 * 1000);
    });

    await waitFor(() => expect(result.current.isLive).toBe(false));
    expect(result.current.isScrubbed).toBe(false);
  });

  it('does not poll on a past date (backtest mode)', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2020-01-02T15:00:00Z',
        timestamps: ['2020-01-02T15:00:00Z'],
        date: '2020-01-02',
      }),
    );

    renderHook(() => useGexTarget(true, '2020-01-02'));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.GEX_TARGET * 5);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// REFRESH
// ============================================================

describe('useGexTarget: refresh', () => {
  it('refresh() triggers a new fetch', async () => {
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ['2026-04-02T19:59:00Z'],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const callsBefore = mockFetch.mock.calls.length;
    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('refresh() when scrubbed sends the scrub timestamp', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ts,
        extraSnapshots: [{ timestamp: '2026-04-02T19:58:00Z' }],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    const callsBefore = mockFetch.mock.calls.length;
    act(() => {
      result.current.refresh();
    });

    await waitFor(() =>
      expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    const refreshUrl = mockFetch.mock.calls.at(-1)![0] as string;
    expect(refreshUrl).toContain('ts=');
  });
});

// ============================================================
// OPENING STRIKES
// ============================================================

describe('useGexTarget: opening strikes', () => {
  it('derives openingCallStrike and openingPutStrike from first snapshot leaderboard', async () => {
    // callRatio: 0.8 → most call-dominant = callStrike
    // callRatio: -0.6 → most put-dominant = putStrike
    const callDominantStrike = makeStrike({
      strike: 5900,
      features: makeFeatures({ callRatio: 0.8 }),
    });
    const putDominantStrike = makeStrike({
      strike: 5600,
      features: makeFeatures({ callRatio: -0.6 }),
    });
    const neutralStrike = makeStrike({
      strike: 5750,
      features: makeFeatures({ callRatio: 0.0 }),
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        availableDates: ['2026-04-02'],
        date: '2026-04-02',
        timestamps: ['2026-04-02T19:59:00Z'],
        candles: [],
        previousClose: null,
        snapshots: [
          {
            timestamp: '2026-04-02T19:59:00Z',
            spot: 5795,
            oi: {
              target: callDominantStrike,
              leaderboard: [
                callDominantStrike,
                neutralStrike,
                putDominantStrike,
              ],
            },
            vol: null,
            dir: null,
          },
        ],
      }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.openingCallStrike).toBe(5900));
    expect(result.current.openingPutStrike).toBe(5600);
  });

  it('sets openingCallStrike and openingPutStrike to null when first snapshot has no oi leaderboard', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        availableDates: ['2026-04-02'],
        date: '2026-04-02',
        timestamps: ['2026-04-02T19:59:00Z'],
        candles: [],
        previousClose: null,
        snapshots: [
          {
            timestamp: '2026-04-02T19:59:00Z',
            spot: 5795,
            oi: null,
            vol: null,
            dir: null,
          },
        ],
      }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openingCallStrike).toBeNull();
    expect(result.current.openingPutStrike).toBeNull();
  });

  it('sets openingCallStrike and openingPutStrike to null when snapshots list is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        availableDates: ['2026-04-02'],
        date: '2026-04-02',
        timestamps: [],
        candles: [],
        previousClose: null,
        snapshots: [],
      }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openingCallStrike).toBeNull();
    expect(result.current.openingPutStrike).toBeNull();
  });

  it('sets openingCallStrike and openingPutStrike to null when first snapshot oi leaderboard is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        availableDates: ['2026-04-02'],
        date: '2026-04-02',
        timestamps: ['2026-04-02T19:59:00Z'],
        candles: [],
        previousClose: null,
        snapshots: [
          {
            timestamp: '2026-04-02T19:59:00Z',
            spot: 5795,
            oi: { target: makeStrike(), leaderboard: [] },
            vol: null,
            dir: null,
          },
        ],
      }),
    });

    const { result } = renderHook(() => useGexTarget(true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.openingCallStrike).toBeNull();
    expect(result.current.openingPutStrike).toBeNull();
  });
});

// ============================================================
// SCRUB NEXT — additional branches
// ============================================================

describe('useGexTarget: scrubNext branches', () => {
  it('scrubNext steps forward one position from a mid-list scrub', async () => {
    const ts = [
      '2026-04-02T19:57:00Z',
      '2026-04-02T19:58:00Z',
      '2026-04-02T19:59:00Z',
    ];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ts,
        extraSnapshots: [
          { timestamp: '2026-04-02T19:57:00Z' },
          { timestamp: '2026-04-02T19:58:00Z' },
        ],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    // Go back 2 steps to 19:57
    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() =>
      expect(result.current.timestamp).toBe('2026-04-02T19:57:00Z'),
    );

    // Step forward one — should land on 19:58, not clear scrub
    act(() => {
      result.current.scrubNext();
    });
    await waitFor(() =>
      expect(result.current.timestamp).toBe('2026-04-02T19:58:00Z'),
    );
    expect(result.current.isScrubbed).toBe(true);
  });

  it('scrubNext clears scrub when at second-to-last or beyond', async () => {
    const ts = ['2026-04-02T19:58:00Z', '2026-04-02T19:59:00Z'];
    mockFetch.mockResolvedValue(
      mockBulkSnapshot({
        timestamp: '2026-04-02T19:59:00Z',
        timestamps: ts,
        extraSnapshots: [{ timestamp: '2026-04-02T19:58:00Z' }],
      }),
    );

    const { result } = renderHook(() => useGexTarget(true));
    await waitFor(() => expect(result.current.timestamps).toEqual(ts));

    // Scrub back to 19:58 (idx=0, second-to-last when list has 2 entries)
    act(() => {
      result.current.scrubPrev();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(true));

    // scrubNext: idx=0, timestamps.length-2=0, so 0 >= 0 → clears scrub
    act(() => {
      result.current.scrubNext();
    });
    await waitFor(() => expect(result.current.isScrubbed).toBe(false));
    expect(result.current.isLive).toBe(true);
  });
});
