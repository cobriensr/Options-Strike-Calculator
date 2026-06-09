// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────
// Owner gate must be true so the eager-fetch effect runs.
vi.mock('../../utils/auth', () => ({
  checkIsOwner: () => true,
}));

// usePolling owns the recurring poll setInterval. We stub it to a no-op so
// the only chime intervals in play are the ones startChime() creates — this
// isolates the leak under test (chime intervals) from the poll interval.
vi.mock('../usePolling', () => ({
  usePolling: () => undefined,
}));

import { useAlertPolling } from '../useAlertPolling';

function criticalAlert(id: number) {
  return {
    id,
    type: 'iv_spike' as const,
    severity: 'critical' as const,
    direction: 'BEARISH' as const,
    title: 'IV spike',
    body: 'big move',
    current_values: {},
    delta_values: {},
    created_at: '2026-06-08T14:00:00Z',
    acknowledged: false,
  };
}

// activeChimes is module-scoped and survives across test cases (the very
// property that makes the leak dangerous). Use a distinct alert id per test
// so a leaked entry from one case can't suppress startChime() in the next.
function mockFetchWithAlert(id: number): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ alerts: [criticalAlert(id)] }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // A real (non-jsdom) AudioContext is unavailable; playChimeOnce swallows the
  // resulting error, but startChime still schedules its setInterval. We stub it
  // so the chime path is fully exercised without throwing noise.
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 0;
      destination = {};
      createGain() {
        return {
          connect: () => undefined,
          gain: {
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
          },
        };
      }
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect: () => undefined,
          start: () => undefined,
          stop: () => undefined,
        };
      }
      close() {
        return Promise.resolve();
      }
    },
  );

  // Notification is irrelevant to the chime leak; stub as denied so the
  // browser-notification path is a no-op.
  vi.stubGlobal(
    'Notification',
    class {
      static readonly permission = 'denied';
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useAlertPolling — chime interval cleanup', () => {
  it('clears the chime interval when the marketOpen gate flips to false', async () => {
    mockFetchWithAlert(1001);
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const { rerender } = renderHook(
      ({ marketOpen }) => useAlertPolling(marketOpen),
      { initialProps: { marketOpen: true } },
    );

    // Wait for the eager fetch to resolve and startChime() to schedule its
    // repeating interval.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // Let the post-fetch microtasks (state update + startChime) flush.
    await act(async () => {
      await Promise.resolve();
    });

    // The chime interval handle that startChime() created. usePolling is
    // stubbed to a no-op, so this is the only setInterval in play.
    expect(setIntervalSpy).toHaveBeenCalled();
    const chimeHandle = setIntervalSpy.mock.results.at(-1)!.value;

    // Gate flips closed (e.g. 4:01 PM ET). The hook's effect cleanup must stop
    // every chime it started, otherwise the chime keeps ringing every 10s.
    act(() => {
      rerender({ marketOpen: false });
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(chimeHandle);
  });

  it('clears the chime interval on unmount', async () => {
    mockFetchWithAlert(1002);
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    const { unmount } = renderHook(
      ({ marketOpen }) => useAlertPolling(marketOpen),
      { initialProps: { marketOpen: true } },
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(setIntervalSpy).toHaveBeenCalled();
    const chimeHandle = setIntervalSpy.mock.results.at(-1)!.value;

    act(() => {
      unmount();
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(chimeHandle);
  });
});
