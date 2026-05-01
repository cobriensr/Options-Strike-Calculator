import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGammaSqueezes } from '../../hooks/useGammaSqueezes';
import type {
  GammaSqueezeRow,
  GammaSqueezesResponse,
} from '../../components/GammaSqueezes/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a row whose ts is `minutesAgo` minutes before "now". */
function makeRow(
  minutesAgo: number,
  overrides: Partial<GammaSqueezeRow> = {},
): GammaSqueezeRow {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id: Math.floor(Math.random() * 1_000_000),
    ticker: 'NVDA',
    strike: 212.5,
    side: 'call',
    expiry: '2026-04-28',
    ts,
    spotAtDetect: 211.4,
    pctFromStrike: -0.0052,
    spotTrend5m: 0.0012,
    volOi15m: 8.4,
    volOi15mPrior: 3.1,
    volOiAcceleration: 5.3,
    volOiTotal: 11.5,
    netGammaSign: 'unknown',
    squeezePhase: 'forming',
    contextSnapshot: null,
    spotAtClose: null,
    reachedStrike: null,
    maxCallPnlPct: null,
    freshnessMin: 0,
    progressPct: null,
    isStale: false,
    hhiNeighborhood: null,
    ivMorningVolCorr: null,
    precisionStackPass: false,
    tapeAgreement: { signals: [], agreeCount: 0, total: 0 },
    ...overrides,
  };
}

function emptyResponse(): GammaSqueezesResponse {
  return {
    mode: 'list',
    latest: {
      SPY: null,
      SPXW: null,
      NDXP: null,
      RUTW: null,
      QQQ: null,
      IWM: null,
      SMH: null,
      NVDA: null,
      TSLA: null,
      META: null,
      MSFT: null,
      GOOGL: null,
      NFLX: null,
      TSM: null,
      SNDK: null,
      MSTR: null,
      MU: null,
    },
    history: {
      SPY: [],
      SPXW: [],
      NDXP: [],
      RUTW: [],
      QQQ: [],
      IWM: [],
      SMH: [],
      NVDA: [],
      TSLA: [],
      META: [],
      MSFT: [],
      GOOGL: [],
      NFLX: [],
      TSM: [],
      SNDK: [],
      MSTR: [],
      MU: [],
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', mockFetch);
});

describe('useGammaSqueezes', () => {
  it('fetches and aggregates a single active squeeze by compound key', async () => {
    const resp = emptyResponse();
    resp.history.NVDA = [makeRow(1)]; // 1 minute ago — fresh
    mockFetch.mockResolvedValue({ ok: true, json: async () => resp });

    const { result } = renderHook(() => useGammaSqueezes({ marketOpen: true }));

    await waitFor(() => expect(result.current.active).toHaveLength(1));
    expect(result.current.active[0]!.ticker).toBe('NVDA');
    expect(result.current.active[0]!.firingCount).toBe(1);
    expect(result.current.active[0]!.latest.volOi15m).toBeCloseTo(8.4);
  });

  it('groups multiple firings on the same compound key into one row', async () => {
    const resp = emptyResponse();
    resp.history.NVDA = [
      makeRow(1, { id: 3 }), // newest
      makeRow(3, { id: 2 }),
      makeRow(5, { id: 1 }),
    ];
    mockFetch.mockResolvedValue({ ok: true, json: async () => resp });

    const { result } = renderHook(() => useGammaSqueezes({ marketOpen: true }));

    await waitFor(() => expect(result.current.active).toHaveLength(1));
    expect(result.current.active[0]!.firingCount).toBe(3);
    expect(result.current.active[0]!.latest.id).toBe(3);
    // First-seen walks back to the oldest in span (5 min ago).
    const firstSeenMs = Date.parse(result.current.active[0]!.firstSeenTs);
    expect(Date.now() - firstSeenMs).toBeGreaterThan(4 * 60_000);
  });

  it('demotes silent (>8min) compound keys to "exhausted" instead of evicting', async () => {
    const resp = emptyResponse();
    // 11 min ago, originally tagged 'active' — should be demoted to
    // 'exhausted' so the trader still sees the throughout-day history.
    resp.history.NVDA = [makeRow(11, { squeezePhase: 'active' })];
    mockFetch.mockResolvedValue({ ok: true, json: async () => resp });

    const { result } = renderHook(() => useGammaSqueezes({ marketOpen: true }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.active).toHaveLength(1);
    expect(result.current.active[0]!.latest.squeezePhase).toBe('exhausted');
  });

  it('sorts active phase before forming phase', async () => {
    const resp = emptyResponse();
    resp.history.NVDA = [makeRow(1, { id: 1, squeezePhase: 'forming' })];
    resp.history.TSLA = [
      makeRow(1, {
        id: 2,
        ticker: 'TSLA',
        strike: 375,
        squeezePhase: 'active',
      }),
    ];
    mockFetch.mockResolvedValue({ ok: true, json: async () => resp });

    const { result } = renderHook(() => useGammaSqueezes({ marketOpen: true }));

    await waitFor(() => expect(result.current.active).toHaveLength(2));
    expect(result.current.active[0]!.latest.squeezePhase).toBe('active');
    expect(result.current.active[1]!.latest.squeezePhase).toBe('forming');
  });

  it('handles HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useGammaSqueezes({ marketOpen: true }));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.active).toHaveLength(0);
  });

  it('does not fetch when disabled', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => emptyResponse(),
    });
    renderHook(() => useGammaSqueezes({ enabled: false, marketOpen: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
