import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTrackerContracts } from '../../hooks/useTrackerContracts';
import type { TrackerContract } from '../../components/Tracker/types';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

let nextId = 100;
function makeContract(
  overrides: Partial<TrackerContract> = {},
): TrackerContract {
  return {
    id: nextId++,
    occ_symbol: 'NVDA  260522P00225000',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P',
    direction: 'long',
    entry_price: '5.00',
    quantity: 1,
    notes: null,
    status: 'active',
    closed_at: null,
    closed_price: null,
    up_thresholds: null,
    down_thresholds: null,
    spot_alerts: null,
    created_at: '2026-05-15T14:30:00.000Z',
    updated_at: '2026-05-15T14:30:00.000Z',
    latest_last: null,
    latest_bid: null,
    latest_ask: null,
    latest_underlying: null,
    latest_fetched_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTrackerContracts — initial fetch + state', () => {
  it('disabled hook returns loading=false immediately and skips fetch', async () => {
    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active', enabled: false }),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
  });

  it('fetches /api/tracker/contracts?status=active on mount and populates data', async () => {
    const c = makeContract();
    fetchMock.mockResolvedValueOnce(jsonResponse({ contracts: [c], count: 1 }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual([c]);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).toBeTypeOf('number');

    // Verifies the URL the hook composed
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/tracker/contracts?status=active');
  });

  it('surfaces a non-OK response as an error string and leaves data unchanged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => {
      expect(result.current.error).toBe('HTTP 500');
    });
    expect(result.current.data).toEqual([]);
  });
});

describe('useTrackerContracts — polling', () => {
  it('refetches every POLL_INTERVAL_MS when marketOpen=true', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ contracts: [], count: 0 }));

    renderHook(() =>
      useTrackerContracts({ status: 'active', marketOpen: true }),
    );

    // Initial fetch
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Two polling ticks → two more fetches
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT poll when marketOpen=false (one-shot fetch only)', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ contracts: [], count: 0 }));

    renderHook(() =>
      useTrackerContracts({ status: 'active', marketOpen: false }),
    );
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useTrackerContracts — mutate', () => {
  it('mutate applies a synchronous patch to the data state', async () => {
    const c1 = makeContract({ id: 1 });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ contracts: [c1], count: 1 }),
    );

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.mutate((prev) => [
        ...prev,
        makeContract({ id: 2, ticker: 'TSLA' }),
      ]);
    });
    expect(result.current.data.length).toBe(2);
  });
});

describe('useTrackerContracts — create', () => {
  it('POSTs body and optimistically inserts when returned status matches filter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ contracts: [], count: 0 }));
    const created = makeContract({ id: 999, status: 'active' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ contract: created }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: TrackerContract | undefined;
    await act(async () => {
      returned = await result.current.create({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        strike: 225,
        side: 'P',
        direction: 'long',
        entry_price: 5,
        quantity: 1,
      });
    });

    expect(returned).toEqual(created);
    expect(result.current.data).toContainEqual(created);
    // Second fetch call is the POST
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
  });

  it('does NOT optimistically insert when returned status mismatches filter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ contracts: [], count: 0 }));
    const created = makeContract({ id: 999, status: 'closed' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ contract: created }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({
        ticker: 'NVDA',
        expiry: '2026-05-22',
        strike: 225,
        side: 'P',
        direction: 'long',
        entry_price: 5,
        quantity: 1,
      });
    });
    expect(result.current.data).toEqual([]);
  });

  it('throws with server error text on non-OK create response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ contracts: [], count: 0 }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Duplicate OCC' }, 409),
    );

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      act(async () => {
        await result.current.create({
          ticker: 'NVDA',
          expiry: '2026-05-22',
          strike: 225,
          side: 'P',
          direction: 'long',
          entry_price: 5,
          quantity: 1,
        });
      }),
    ).rejects.toThrow(/Duplicate OCC/);
  });
});

describe('useTrackerContracts — update + close', () => {
  it('update PATCHes and replaces in place when status stays in filter', async () => {
    const c1 = makeContract({ id: 1, notes: null });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ contracts: [c1], count: 1 }),
    );
    const updated = makeContract({ id: 1, notes: 'updated', status: 'active' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ contract: updated }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.update(1, { notes: 'updated' });
    });

    expect(result.current.data[0]?.notes).toBe('updated');
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
  });

  it('update drops the row from local state when patched status falls out of filter', async () => {
    const c1 = makeContract({ id: 1, status: 'active' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ contracts: [c1], count: 1 }),
    );
    // Server returns the row with status flipped to 'closed' — hook
    // sees it no longer matches the 'active' filter and drops it.
    const updated = makeContract({ id: 1, status: 'closed' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ contract: updated }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.length).toBe(1);

    await act(async () => {
      await result.current.update(1, { status: 'closed' });
    });
    expect(result.current.data).toEqual([]);
  });

  it('close delegates to update with {status: closed, closed_price}', async () => {
    const c1 = makeContract({ id: 1, status: 'active' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ contracts: [c1], count: 1 }),
    );
    const closed = makeContract({ id: 1, status: 'closed' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ contract: closed }));

    const { result } = renderHook(() =>
      useTrackerContracts({ status: 'active' }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.close(1, 7.5);
    });

    // PATCH body carries the two close fields
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ status: 'closed', closed_price: 7.5 });
  });
});
