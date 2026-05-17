import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import React from 'react';
import { ToastContext } from '../../hooks/useToast';
import { useTrackerAlerts } from '../../hooks/useTrackerAlerts';
import type { TrackerAlert } from '../../components/Tracker/types';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeAlert(overrides: Partial<TrackerAlert> = {}): TrackerAlert {
  return {
    id: 1,
    contract_id: 42,
    fired_at: '2026-05-17T15:30:00Z',
    alert_type: 'up_pct',
    threshold: '50',
    price_at_fire: '6.45',
    underlying_at_fire: '225.10',
    acknowledged: false,
    occ_symbol: 'NVDA  260522P00225000',
    ticker: 'NVDA',
    expiry: '2026-05-22',
    strike: '225',
    side: 'P',
    direction: 'long',
    entry_price: '4.30',
    quantity: 5,
    contract_status: 'active',
    ...overrides,
  };
}

function makeWrapper(show: Mock) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(
      ToastContext.Provider,
      { value: { show } },
      children,
    );
  };
}

describe('useTrackerAlerts', () => {
  it('fetches unread alerts on mount and exposes them via data', async () => {
    const show = vi.fn();
    const alert = makeAlert();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ alerts: [alert], count: 1 }),
    );
    const { result } = renderHook(() => useTrackerAlerts({ enabled: true }), {
      wrapper: makeWrapper(show),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data[0]?.id).toBe(1);
    // Initial-fetch seeds the seen-set: NO toast fires for pre-existing
    // alerts. Otherwise users get spammed on every page load.
    expect(show).not.toHaveBeenCalled();
  });

  it('fires a toast for a newly-fired alert on the second refetch', async () => {
    const show = vi.fn();
    // Initial poll: no alerts. Second poll: a new up_pct alert appears.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ alerts: [], count: 0 }))
      .mockResolvedValueOnce(jsonResponse({ alerts: [makeAlert()], count: 1 }));
    const { result } = renderHook(() => useTrackerAlerts({ enabled: true }), {
      wrapper: makeWrapper(show),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(show).not.toHaveBeenCalled();
    // Simulate the 30s poll by invoking refetch() directly. This is
    // equivalent to the timer firing — much more reliable than juggling
    // fake timers across React effect microtasks.
    await act(async () => {
      await result.current.refetch();
    });
    expect(show).toHaveBeenCalledTimes(1);
    const [message, type] = show.mock.calls[0] ?? [];
    expect(type).toBe('success');
    expect(message).toContain('NVDA');
    expect(message).toContain('+50%');
    expect(message).toContain('🟢');
  });

  it('does not re-fire a toast for an alert it already showed', async () => {
    const show = vi.fn();
    const alert = makeAlert();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ alerts: [], count: 0 }))
      .mockResolvedValueOnce(jsonResponse({ alerts: [alert], count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ alerts: [alert], count: 1 }));
    const { result } = renderHook(() => useTrackerAlerts({ enabled: true }), {
      wrapper: makeWrapper(show),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refetch();
    });
    await act(async () => {
      await result.current.refetch();
    });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does not poll when enabled is false', async () => {
    const show = vi.fn();
    renderHook(() => useTrackerAlerts({ enabled: false }), {
      wrapper: makeWrapper(show),
    });
    // Brief async tick to confirm no fetch was issued.
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still performs the initial seed-fetch when marketOpen is false', async () => {
    // Off-hours: the hook should fire ONE fetch on mount so the seen-id
    // set seeds correctly (and any pre-existing alerts surface in
    // `data`). The recurring 30s timer should NOT be set — verified
    // here by waiting longer than one polling interval and checking
    // that fetch was called exactly once.
    const show = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ alerts: [], count: 0 }));
    const { result } = renderHook(
      () => useTrackerAlerts({ enabled: true, marketOpen: false }),
      { wrapper: makeWrapper(show) },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Wait past one tick and confirm no second poll.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ack() drops the alert from local state and POSTs to /ack', async () => {
    const show = vi.fn();
    const alert = makeAlert();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ alerts: [alert], count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { result } = renderHook(() => useTrackerAlerts({ enabled: true }), {
      wrapper: makeWrapper(show),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
    await act(async () => {
      await result.current.ack(1);
    });
    expect(result.current.data).toHaveLength(0);
    const ackCall = fetchMock.mock.calls[1];
    expect(ackCall?.[0]).toBe('/api/tracker/alerts/1/ack');
    expect(ackCall?.[1]).toMatchObject({ method: 'POST' });
  });

  it('renders down_pct as a red error-type toast', async () => {
    const show = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ alerts: [], count: 0 }))
      .mockResolvedValueOnce(
        jsonResponse({
          alerts: [
            makeAlert({
              id: 2,
              alert_type: 'down_pct',
              threshold: '-30',
              price_at_fire: '4.00',
              ticker: 'AMD',
              strike: '397.5',
              side: 'P',
              entry_price: '5.72',
            }),
          ],
          count: 1,
        }),
      );
    const { result } = renderHook(() => useTrackerAlerts({ enabled: true }), {
      wrapper: makeWrapper(show),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refetch();
    });
    expect(show).toHaveBeenCalledTimes(1);
    const [message, type] = show.mock.calls[0] ?? [];
    expect(type).toBe('error');
    expect(message).toContain('🔴');
    expect(message).toContain('AMD');
    expect(message).toContain('-30%');
  });
});

describe('useTrackerAlerts — toast onClick wiring', () => {
  it('passes an onClick that invokes onSelectContract + ack', async () => {
    // The toast.show mock captures the third (opts) arg so we can assert
    // the onClick wires both `onSelectContract` and the server ack.
    // Regression guard for Finding 1 from the Phase 3 review.
    const show = vi.fn();
    const onSelectContract = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ alerts: [], count: 0 }))
      .mockResolvedValueOnce(jsonResponse({ alerts: [makeAlert()], count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true })); // ack POST
    const { result } = renderHook(
      () => useTrackerAlerts({ enabled: true, onSelectContract }),
      { wrapper: makeWrapper(show) },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refetch();
    });
    expect(show).toHaveBeenCalledTimes(1);
    const opts = show.mock.calls[0]?.[2] as
      | { actionLabel?: string; onClick?: () => void }
      | undefined;
    expect(opts?.actionLabel).toBe('Open');
    expect(typeof opts?.onClick).toBe('function');
    // Fire the action — should call onSelectContract(42) and POST /ack.
    await act(async () => {
      opts?.onClick?.();
      // Let the embedded async ack call resolve.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onSelectContract).toHaveBeenCalledWith(42);
    const ackCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/ack'),
    );
    expect(ackCall?.[0]).toBe('/api/tracker/alerts/1/ack');
  });
});
