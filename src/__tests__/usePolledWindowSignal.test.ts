import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
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

// ============================================================
// A day boundary crossed while mounted (docs/superpowers/specs/
// panel-date-rollover-2026-11-14.md, Phase 10)
//
// A tab left open from Friday's close shows Monday's open. Friday's payload sat
// in `state.data`, which `displayData` did not date-check (only the cache), so
// it painted as live; and the only fetch was the one at mount, so the first
// Monday fetch was a 45 s poll away, a minute or two after the open. On a failed
// first fetch the stale payload stayed for good. The payload is now date-checked
// like the cache, and the window opening fetches at once. The caller owns
// `inWindow` and `todayStr`; both are variables here, changed between steps. One
// `act` per step: a single act around a whole weekend batches the close and the
// open into one commit, and the flag never flips.
// ============================================================

describe('usePolledWindowSignal: a day boundary crossed while mounted', () => {
  const FRI = '2026-06-05';
  const MON = '2026-06-08';
  let open: boolean;
  let today: string;

  beforeEach(() => {
    fetchMock.mockReset();
    localStorage.clear();
    vi.useFakeTimers();
    open = true;
    today = FRI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Records, for every committed render, the window flag, the payload shown and
   * the error returned.
   */
  function renderRecorded() {
    const committed: {
      open: boolean;
      value: number | null;
      error: string | null;
    }[] = [];
    const hook = renderHook(() => {
      const r = usePolledWindowSignal<TestPayload>(
        makeOpts({ inWindow: () => open, todayStr: () => today }),
      );
      useEffect(() => {
        committed.push({
          open: r.isWindowOpen,
          value: r.displayData?.value ?? null,
          error: r.error,
        });
      });
      return r;
    });
    return { ...hook, committed };
  }
  const step = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const ok = (p: TestPayload) => ({ ok: true, json: async () => p });

  it('drops Friday’s payload at the Monday open and fetches at once, not a poll later', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    const { result, committed } = renderRecorded();
    await step(0);
    expect(result.current.displayData?.value).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Friday's close: the flag flips, and the day's last read stays on screen.
    open = false;
    await step(60_000);
    expect(result.current.isWindowOpen).toBe(false);
    expect(result.current.displayData?.value).toBe(1);

    // Monday's open: the flag and the date turn in the same watcher tick. The
    // fetch is held, so a stale render has nothing to hide behind.
    let answer: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const calls = fetchMock.mock.calls.length;
    const before = committed.length;
    open = true;
    today = MON;
    await step(60_000);

    expect(result.current.isWindowOpen).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.displayData).toBeNull();
    for (const c of committed.slice(before)) expect(c.value).not.toBe(1);

    await act(async () => {
      answer(ok(payload({ date: MON, value: 2 })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.displayData?.value).toBe(2);
  });

  it('shows no payload and surfaces the error when the first fetch after the open fails', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    const { result, committed } = renderRecorded();
    await step(0);
    open = false;
    await step(60_000);

    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const before = committed.length;
    open = true;
    today = MON;
    await step(60_000);

    expect(result.current.error).toBe('HTTP 500');
    expect(result.current.displayData).toBeNull();
    // Several polls on, every one failing: Friday's payload never comes back.
    for (let i = 0; i < 4; i += 1) {
      await step(45_000);
      expect(result.current.displayData).toBeNull();
      expect(result.current.error).toBe('HTTP 500');
    }
    for (const c of committed.slice(before)) expect(c.value).toBeNull();
  });

  it('date-checks the payload when the date turns with the window closed', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    const { result, rerender } = renderRecorded();
    await step(0);
    open = false;
    await step(60_000);
    expect(result.current.displayData?.value).toBe(1);

    today = MON;
    rerender();

    expect(result.current.isWindowOpen).toBe(false);
    expect(result.current.displayData).toBeNull();
  });

  // A 2xx whose payload is not dated today (a client clock that lags after
  // sleep, a server on another day) is hidden by the date check. Saying nothing
  // would leave the panel on "loading" for as long as the dates disagree, so it
  // is an error, by value, and it clears on the first poll where they agree.
  it('surfaces an error naming both dates when a 2xx is not dated today, and clears it once they agree', async () => {
    today = MON;
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe(
      'Payload is dated 2026-06-05, but today is 2026-06-08',
    );
    expect(result.current.displayData).toBeNull();
    expect(result.current.loading).toBe(false);

    fetchMock.mockResolvedValue(ok(payload({ date: MON, value: 2 })));
    await step(45_000);

    expect(result.current.error).toBeNull();
    expect(result.current.displayData?.value).toBe(2);
  });

  it('names an undated 2xx as undated', async () => {
    today = MON;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ value: 1 }) });
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe(
      'Payload is undated, but today is 2026-06-08',
    );
    expect(result.current.displayData).toBeNull();
  });

  // `JSON.parse('null')` is a valid 2xx body. It must be named, not thrown on
  // ("Cannot read properties of null (reading 'date')" in the panel's alert).
  it('names a null 2xx body as undated instead of throwing on it', async () => {
    today = MON;
    fetchMock.mockResolvedValue({ ok: true, json: async () => null });
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe(
      'Payload is undated, but today is 2026-06-08',
    );
    expect(result.current.displayData).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // A null body carries nothing to keep, so it must not wipe what is.
  it('leaves the last-good cache in place when a 2xx body is null', async () => {
    today = MON;
    seedCache(MON, 7);
    fetchMock.mockResolvedValue({ ok: true, json: async () => null });
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe(
      'Payload is undated, but today is 2026-06-08',
    );
    expect(result.current.displayData?.value).toBe(7);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
      data: TestPayload;
      date: string;
    };
    expect(stored.data.value).toBe(7);
    expect(stored.date).toBe(MON);
  });

  // The wrong-date error is a verdict on the payload against the clock at the
  // time. The shared ET clock can lag the server's date (a store that has not
  // ticked yet), so the fetch lands first and the clock catches up after: the
  // payload is then dated today, and the alert must go with it, not stay up
  // until the next poll.
  it('drops the wrong-date error in the render where the clock catches up with the payload', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: MON, value: 1 })));
    const { result, rerender, committed } = renderRecorded();
    await step(0);
    expect(result.current.error).toBe(
      'Payload is dated 2026-06-08, but today is 2026-06-05',
    );
    expect(result.current.displayData).toBeNull();

    const before = committed.length;
    today = MON;
    rerender();

    expect(result.current.error).toBeNull();
    expect(result.current.displayData?.value).toBe(1);
    // No committed render shows the payload together with the alert.
    for (const c of committed.slice(before)) {
      expect(c.error).toBeNull();
      expect(c.value).toBe(1);
    }
  });

  // The clock catching up clears only the wrong-date error. A later failed
  // fetch is a different error, and the catch-up must not hide it.
  it('keeps a fetch failure that follows a wrong-dated read when the clock then catches up', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: MON, value: 1 })));
    const { result, rerender } = renderRecorded();
    await step(0);

    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await step(45_000);
    expect(result.current.error).toBe('HTTP 500');

    today = MON;
    rerender();

    expect(result.current.error).toBe('HTTP 500');
    expect(result.current.displayData?.value).toBe(1);
  });

  // The error is the standing verdict on the last read. While the next request
  // is out it must not flip to nothing, which the panel reads as "loading".
  it('keeps the error up while the next request is in flight', async () => {
    today = MON;
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    const { result, committed } = renderRecorded();
    await step(0);
    const wrongDated = 'Payload is dated 2026-06-05, but today is 2026-06-08';
    expect(result.current.error).toBe(wrongDated);

    let answer: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const before = committed.length;
    await step(45_000);

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe(wrongDated);
    expect(committed.length).toBeGreaterThan(before);
    for (const c of committed.slice(before)) expect(c.error).toBe(wrongDated);

    // The answer, once it agrees with the clock, clears it.
    await act(async () => {
      answer(ok(payload({ date: MON, value: 2 })));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.displayData?.value).toBe(2);
  });

  // Nothing fetches while the window is closed, so an error left from the last
  // fetch would sit over "waiting for the open" all weekend.
  it.each([
    {
      name: 'a wrong-dated read',
      arrange: () => {
        today = MON;
        fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
      },
      error: 'Payload is dated 2026-06-05, but today is 2026-06-08',
    },
    {
      name: 'a failed fetch',
      arrange: () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
      },
      error: 'HTTP 500',
    },
  ])(
    'returns no error once the window closes after $name',
    async ({ arrange, error }) => {
      arrange();
      const { result, committed } = renderRecorded();
      await step(0);
      expect(result.current.error).toBe(error);

      const before = committed.length;
      open = false;
      await step(60_000);
      expect(result.current.isWindowOpen).toBe(false);
      expect(result.current.error).toBeNull();
      for (const c of committed.slice(before)) {
        if (!c.open) expect(c.error).toBeNull();
      }

      // Hours later, still nothing.
      await step(60 * 60_000);
      expect(result.current.error).toBeNull();
    },
  );

  it('surfaces a network failure by its message and shows no payload', async () => {
    today = MON;
    fetchMock.mockRejectedValue(new Error('network down'));
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe('network down');
    expect(result.current.displayData).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a 2xx whose body is not JSON by its message and shows no payload', async () => {
    today = MON;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    const { result } = renderRecorded();
    await step(0);

    expect(result.current.error).toBe(
      'Unexpected token < in JSON at position 0',
    );
    expect(result.current.displayData).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('makes exactly one fetch for a mount inside the window', async () => {
    fetchMock.mockResolvedValue(ok(payload({ date: FRI, value: 1 })));
    renderRecorded();

    await step(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await step(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The poll takes over at its own cadence.
    await step(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
