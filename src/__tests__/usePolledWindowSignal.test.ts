import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
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

/**
 * Shape validator for the test payload — the same contract production
 * callers wire in (client-shape-hardening-2026-08-20): typed payload out,
 * `null` for a shapeless envelope.
 */
function validateTestPayload(raw: unknown): TestPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.date !== 'string' ||
    typeof r.value !== 'number' ||
    !Number.isFinite(r.value)
  ) {
    return null;
  }
  return { date: r.date, value: r.value };
}

function makeOpts(
  overrides: Partial<PolledWindowSignalOptions<TestPayload>> = {},
): PolledWindowSignalOptions<TestPayload> {
  return {
    url: URL,
    storageKey: STORAGE_KEY,
    pollMs: 45_000,
    inWindow: () => true,
    todayStr: () => TODAY,
    validate: validateTestPayload,
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
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    fetchMock.mockReset();
    localStorage.clear();
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('rejects a shapeless {} payload: error state, no data, today-cache kept', async () => {
    seedCache(TODAY, 5);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts()),
    );

    await waitFor(() => {
      expect(result.current.error).toBe('Unexpected response shape');
    });
    expect(result.current.data).toBeNull();
    // The last-good (today-dated) cache still backs the display.
    expect(result.current.displayData?.value).toBe(5);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('rejects a garbage (HTML-ish string) payload as an error state', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => '<!doctype html><html>oops</html>',
    });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts()),
    );

    await waitFor(() => {
      expect(result.current.error).toBe('Unexpected response shape');
    });
    expect(result.current.displayData).toBeNull();
    // A rejected payload is never mirrored into the last-good cache.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('stores the validator OUTPUT (not the raw payload) in state and cache', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...payload({ value: 9 }), junk: 'extra' }),
    });

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts()),
    );

    await waitFor(() => {
      expect(result.current.displayData?.value).toBe(9);
    });
    expect(result.current.data).toEqual({ date: TODAY, value: 9 });
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      data: TestPayload;
    };
    expect(parsed.data).toEqual({ date: TODAY, value: 9 });
  });

  it('runs the validator on the cache read — a malformed today-dated cache never surfaces', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        data: { date: TODAY, value: 'garbage' },
        savedAt: `${TODAY}T20:00:00Z`,
        date: TODAY,
      }),
    );

    const { result } = renderHook(() =>
      usePolledWindowSignal<TestPayload>(makeOpts({ inWindow: () => false })),
    );

    expect(result.current.displayData).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
