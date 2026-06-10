/**
 * useFetchedData cross-request staleness gate (primitive level). The gate
 * is now folded INTO `useFetchedData` as the generic `requestKey` /
 * `responseKey` option pair (the former standalone `gateResponseToDate`
 * helper was removed). When both are provided, the held response's `data`
 * is nulled while its extracted key does not match the in-flight request
 * key — dropping a stale-while-revalidate response retained from a PRIOR
 * request key (e.g. a prior trading day) so consumers never see yesterday's
 * data under today's key. These tests pin the primitive contract; the four
 * consuming hooks have their own thin-wiring tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFetchedData } from '../hooks/useFetchedData';

interface Dated {
  date?: string;
  value: number;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const dateKey = (d: Dated): string | null | undefined => d.date?.slice(0, 10);

describe('useFetchedData cross-request staleness gate', () => {
  it('(a) keeps data when the response key matches the request key', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ date: '2026-05-07', value: 42 }),
    );
    const { result } = renderHook(() =>
      useFetchedData<Dated>({
        url: '/api/x?date=2026-05-07',
        marketOpen: false,
        requestKey: '2026-05-07',
        responseKey: dateKey,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ date: '2026-05-07', value: 42 });
  });

  it('(b) nulls data when the response key does not match (stale window)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ date: '2026-05-06', value: 7 }),
    );
    const { result } = renderHook(() =>
      useFetchedData<Dated>({
        url: '/api/x?date=2026-05-07',
        marketOpen: false,
        requestKey: '2026-05-07',
        responseKey: dateKey,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The fetch resolved (no error) but the gate nulled the prior-day data.
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('(c) nulls data on a requestKey flip while the held response still carries the OLD key', async () => {
    // End-to-end stale-while-revalidate coverage: page 0 resolves under
    // 2026-05-07, then the date flips to 2026-05-08 and a slow re-fetch is
    // held open. The primitive retains the OLD (2026-05-07) response until
    // the new fetch resolves; the gate must null it because its key no
    // longer matches the new request key.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ date: '2026-05-07', value: 1 }),
    );
    let resolveSecond: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveSecond = res;
      }),
    );

    const { result, rerender } = renderHook(
      ({ date }: { date: string }) =>
        useFetchedData<Dated>({
          url: `/api/x?date=${date}`,
          marketOpen: false,
          requestKey: date,
          responseKey: dateKey,
        }),
      { initialProps: { date: '2026-05-07' } },
    );

    await waitFor(() => expect(result.current.data?.value).toBe(1));

    // Flip the date; the second fetch is held open so the held response
    // is still the stale 2026-05-07 payload.
    rerender({ date: '2026-05-08' });
    await waitFor(() => expect(result.current.data).toBeNull());

    // Cleanup — resolve the held fetch so it doesn't leak into other tests.
    resolveSecond(jsonResponse({ date: '2026-05-08', value: 2 }));
    await waitFor(() => expect(result.current.data?.value).toBe(2));
  });

  it('(d) tolerates an ISO-timestamp echo: slice still matches the request key', async () => {
    // The server echoes the date as a full ISO timestamp; `responseKey`
    // slices it to YYYY-MM-DD, which matches the YYYY-MM-DD request key,
    // so the data is NOT blanked.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ date: '2026-05-07T00:00:00.000Z', value: 99 }),
    );
    const { result } = renderHook(() =>
      useFetchedData<Dated>({
        url: '/api/x?date=2026-05-07',
        marketOpen: false,
        requestKey: '2026-05-07',
        responseKey: dateKey,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.value).toBe(99);
  });

  it('(e) passthrough: a missing key (responseKey → undefined) is NOT nulled', async () => {
    // The server dropped the `date` field, so `responseKey` returns
    // undefined. The gate must degrade to pre-gate behavior (pass the data
    // through) rather than permanently blanking the feed.
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: 5 }));
    const { result } = renderHook(() =>
      useFetchedData<Dated>({
        url: '/api/x?date=2026-05-07',
        marketOpen: false,
        requestKey: '2026-05-07',
        responseKey: dateKey,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ value: 5 });
  });
});
