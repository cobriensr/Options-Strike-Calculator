import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAnomalyCrossAsset } from '../../hooks/useAnomalyCrossAsset';
import type {
  ActiveAnomaly,
  IVAnomalyRow,
} from '../../components/IVAnomalies/types';
import { POLL_INTERVALS } from '../../constants';

vi.mock('../../hooks/useIsOwner', () => ({
  useIsOwner: vi.fn(() => true),
}));

import { useIsOwner } from '../../hooks/useIsOwner';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeRow(over: Partial<IVAnomalyRow> = {}): IVAnomalyRow {
  return {
    id: 1,
    ticker: 'SPXW',
    strike: 7100,
    side: 'call',
    expiry: '2026-04-23',
    spotAtDetect: 7100,
    ivAtDetect: 0.2,
    skewDelta: 0.01,
    zScore: 2.5,
    askMidDiv: 0.1,
    volOiRatio: 25,
    sideSkew: 0.85,
    sideDominant: 'ask',
    flagReasons: ['skew_delta'],
    flowPhase: 'mid',
    contextSnapshot: {},
    resolutionOutcome: null,
    ts: '2026-04-23T15:30:00Z',
    ...over,
  };
}

function makeAnomaly(over: Partial<ActiveAnomaly> = {}): ActiveAnomaly {
  const row = makeRow();
  return {
    compoundKey: 'SPXW:7100:call:2026-04-23',
    ticker: 'SPXW',
    strike: 7100,
    side: 'call',
    expiry: '2026-04-23',
    latest: row,
    firstSeenTs: '2026-04-23T15:30:00Z',
    lastFiredTs: '2026-04-23T15:30:00Z',
    firingCount: 1,
    phase: 'active',
    exitReason: null,
    entryIv: 0.2,
    peakIv: 0.2,
    peakTs: '2026-04-23T15:30:00Z',
    entryAskMidDiv: 0.1,
    askMidPeakTs: null,
    ivHistory: [],
    firingHistory: [],
    tapeVolumeHistory: [],
    accumulatedAskSideVol: 0,
    accumulatedBidSideVol: 0,
    ...over,
  };
}

function okResponse(contexts: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ contexts }),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset();
  vi.mocked(useIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.stubGlobal('fetch', mockFetch);
});

describe('useAnomalyCrossAsset', () => {
  it('returns empty contexts when anomaly list is empty', async () => {
    const { result } = renderHook(() => useAnomalyCrossAsset([], true));
    await act(async () => {});
    expect(result.current.contexts).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when market is closed', async () => {
    renderHook(() => useAnomalyCrossAsset([makeAnomaly()], false));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fetch when not owner', async () => {
    vi.mocked(useIsOwner).mockReturnValue(false);
    renderHook(() => useAnomalyCrossAsset([makeAnomaly()], true));
    await act(async () => {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs the keys array when owner + market open', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        'SPXW:7100:call:2026-04-23': {
          regime: 'mild_trend_up',
          tapeAlignment: 'aligned',
          dpCluster: 'medium',
          gexZone: 'below_spot',
          vixDirection: 'flat',
        },
      }),
    );

    const { result } = renderHook(() =>
      useAnomalyCrossAsset([makeAnomaly()], true),
    );

    await waitFor(() =>
      expect(
        result.current.contexts['SPXW:7100:call:2026-04-23'],
      ).toBeDefined(),
    );

    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toBe('/api/iv-anomalies-cross-asset');
    const init = call?.[1] as { method: string; body: string };
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as {
      keys: Array<{ ticker: string; alertTs: string }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.ticker).toBe('SPXW');
    expect(body.keys[0]?.alertTs).toBe('2026-04-23T15:30:00Z');
  });

  it('returns the parsed contexts map keyed by compound key', async () => {
    const ctx = {
      regime: 'mild_trend_up' as const,
      tapeAlignment: 'aligned' as const,
      dpCluster: 'large' as const,
      gexZone: 'below_spot' as const,
      vixDirection: 'falling' as const,
    };
    mockFetch.mockResolvedValue(
      okResponse({ 'SPXW:7100:call:2026-04-23': ctx }),
    );

    const { result } = renderHook(() =>
      useAnomalyCrossAsset([makeAnomaly()], true),
    );

    await waitFor(() =>
      expect(result.current.contexts['SPXW:7100:call:2026-04-23']).toEqual(ctx),
    );
  });

  it('polls every ANOMALY_CROSS_ASSET interval when market open', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    renderHook(() => useAnomalyCrossAsset([makeAnomaly()], true));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ANOMALY_CROSS_ASSET);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('silently ignores 401 (not owner) without setting error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const { result } = renderHook(() =>
      useAnomalyCrossAsset([makeAnomaly()], true),
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
  });

  it('surfaces error on non-401 non-200', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const { result } = renderHook(() =>
      useAnomalyCrossAsset([makeAnomaly()], true),
    );
    await waitFor(() =>
      expect(result.current.error).toBe('Cross-asset fetch failed'),
    );
  });

  it('handles fetch throws (e.g. network failure) without crashing', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      useAnomalyCrossAsset([makeAnomaly()], true),
    );
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.contexts).toEqual({});
  });
});
