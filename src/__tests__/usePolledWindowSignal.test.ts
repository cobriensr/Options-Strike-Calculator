import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  usePolledWindowSignal,
  type PolledWindowSignalOptions,
} from '../hooks/usePolledWindowSignal';

interface TestPayload {
  date: string;
  value: number;
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const URL = '/api/test-signal';
const STORAGE_KEY = 'test-signal:lastgood';
const TODAY = '2026-06-05';

function makeOpts(
  overrides: Partial<PolledWindowSignalOptions> = {},
): PolledWindowSignalOptions {
  return {
    url: URL,
    storageKey: STORAGE_KEY,
    pollMs: 45_000,
    inWindow: () => true,
    todayStr: () => TODAY,
    ...overrides,
  };
}

function payload(overrides: Partial<TestPayload> = {}): TestPayload {
  return { date: TODAY, value: 1, ...overrides };
}

function seedCache(date: string, value: number) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      data: { date, value },
      savedAt: `${date}T20:00:00Z`,
      date,
    }),
  );
}

describe('usePolledWindowSignal', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    localStorage.clear();
  });

  it('fetches on mount when in-window and exposes displayData', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts()),
    );

    await waitFor(() => {
      expect(result.current.displayData?.value).toBe(1);
    });
    expect(result.current.isWindowOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('does not fetch on mount when out-of-window', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts({ inWindow: () => false })),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.isWindowOpen).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not schedule the recurring poll out-of-window (no fetch churn)', () => {
    vi.useFakeTimers();
    try {
      renderHook(() =>
        usePolledWindowSignal<TestPayload>(makeOpts({ inWindow: () => false })),
      );

      act(() => {
        vi.advanceTimersByTime(45_000 * 5);
      });

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a today-dated cache as displayData on mount (out-of-window)', () => {
    seedCache(TODAY, 7);

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts({ inWindow: () => false })),
    );

    expect(result.current.displayData?.value).toBe(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores and evicts a prior-day cache (staleness guard)', () => {
    // Cache from a previous day must never surface as today's displayData.
    seedCache('2026-06-04', 99);

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts({ inWindow: () => false })),
    );

    expect(result.current.displayData).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('writes the fresh payload to the last-good cache after a fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => payload({ value: 42 }),
    });

    renderHook(() => usePolledWindowSignal<TestPayload>(makeOpts()));

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      data: TestPayload;
      date: string;
    };
    expect(parsed.data.value).toBe(42);
    expect(parsed.date).toBe(TODAY);
  });

  it('surfaces an error and keeps the today-dated cache on a failed fetch', async () => {
    seedCache(TODAY, 5);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts()),
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.displayData?.value).toBe(5);
  });
});
