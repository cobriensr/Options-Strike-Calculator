// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWhaleAnomalies } from '../../hooks/useWhaleAnomalies';
import type { WhaleAnomaliesResponse } from '../../components/WhaleAnomalies/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = (json: WhaleAnomaliesResponse) =>
  ({
    ok: true,
    status: 200,
    json: async () => json,
  }) as unknown as Response;

const sampleResp = (override?: Partial<WhaleAnomaliesResponse>): WhaleAnomaliesResponse => ({
  date: '2026-04-29',
  asOf: null,
  whales: [
    {
      id: 1,
      ticker: 'SPXW',
      option_chain: 'SPXW260429P07150000',
      strike: 7150,
      option_type: 'put',
      expiry: '2026-04-29',
      first_ts: '2026-04-29T16:56:52Z',
      last_ts: '2026-04-29T19:33:07Z',
      detected_at: '2026-04-29T16:57:00Z',
      side: 'BID',
      ask_pct: 0.05,
      total_premium: 12_037_400,
      trade_count: 5,
      vol_oi_ratio: 10.2,
      underlying_price: 7120.12,
      moneyness: 0.0042,
      dte: 0,
      whale_type: 1,
      direction: 'bullish',
      pairing_status: 'sequential',
      source: 'eod_backfill',
      resolved_at: null,
      hit_target: null,
      pct_to_target: null,
    },
  ],
  ...override,
});

describe('useWhaleAnomalies', () => {
  it('fetches on mount and exposes the whales array', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp()));
    const { result } = renderHook(() =>
      useWhaleAnomalies({ date: '2026-04-29', marketOpen: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.whales).toHaveLength(1);
    expect(result.current.whales[0]!.ticker).toBe('SPXW');
    expect(result.current.error).toBeNull();
  });

  it('builds the URL with the date param', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp()));
    renderHook(() =>
      useWhaleAnomalies({ date: '2026-04-29', marketOpen: false }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/whale-anomalies?');
    expect(url).toContain('date=2026-04-29');
  });

  it('includes the at param when scrubbing', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp({ asOf: '2026-04-29T17:00:00Z' })));
    renderHook(() =>
      useWhaleAnomalies({
        date: '2026-04-29',
        at: '2026-04-29T17:00:00Z',
        marketOpen: false,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('at=');
  });

  it('includes the ticker param when filtering', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp()));
    renderHook(() =>
      useWhaleAnomalies({
        date: '2026-04-29',
        marketOpen: false,
        ticker: 'NDXP',
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('ticker=NDXP');
  });

  it('exposes the error string when fetch fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    const { result } = renderHook(() =>
      useWhaleAnomalies({ date: '2026-04-29', marketOpen: false }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();
  });

  it('refetches when refetch() is called', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp()));
    fetchMock.mockResolvedValueOnce(okResponse(sampleResp()));

    const { result } = renderHook(() =>
      useWhaleAnomalies({ date: '2026-04-29', marketOpen: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    result.current.refetch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
