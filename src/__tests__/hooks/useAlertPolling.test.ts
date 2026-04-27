import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAlertPolling } from '../../hooks/useAlertPolling';
import type { MarketAlert } from '../../hooks/useAlertPolling';
import { POLL_INTERVALS } from '../../constants';

// ── Mocks ─────────────────────────────────────────────────

vi.mock('../../utils/auth', () => ({
  checkIsOwner: vi.fn(() => true),
}));

import { checkIsOwner } from '../../utils/auth';

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ alerts: [] }),
});
vi.stubGlobal('fetch', mockFetch);

const mockNotification = vi.fn(function () {});
Object.defineProperty(mockNotification, 'permission', {
  value: 'default',
  writable: true,
});
Object.defineProperty(mockNotification, 'requestPermission', {
  value: vi.fn().mockResolvedValue('granted'),
});
vi.stubGlobal('Notification', mockNotification);

class DefaultMockAudioContext {
  destination = {};
  currentTime = 0;
  createOscillator() {
    return {
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    };
  }
  close = vi.fn();
}

vi.stubGlobal('AudioContext', DefaultMockAudioContext);

// ── Helpers ───────────────────────────────────────────────

function makeAlert(overrides: Partial<MarketAlert> = {}): MarketAlert {
  return {
    id: 1,
    type: 'iv_spike',
    severity: 'warning',
    direction: 'BEARISH',
    title: 'IV Spike: +3.5 vol pts in 5min',
    body: 'ATM 0DTE IV expanded rapidly',
    current_values: { iv: 0.277 },
    delta_values: { ivDelta: 0.035 },
    created_at: '2026-03-24T17:30:00Z',
    acknowledged: false,
    ...overrides,
  };
}

// ── Lifecycle ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ alerts: [] }),
  });
  vi.mocked(checkIsOwner).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();

  // Re-stub globals for subsequent tests
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('Notification', mockNotification);
  vi.stubGlobal('AudioContext', DefaultMockAudioContext);
});

// ============================================================
// INITIAL STATE
// ============================================================

describe('useAlertPolling: initial state', () => {
  it('returns empty alerts array initially', async () => {
    const { result } = renderHook(() => useAlertPolling(true));
    expect(result.current.alerts).toEqual([]);
    expect(result.current.unacknowledgedCount).toBe(0);
    // Flush the mount fetch
    await act(async () => {});
  });

  it('returns notificationPermission from Notification API', async () => {
    const { result } = renderHook(() => useAlertPolling(true));
    expect(result.current.notificationPermission).toBe('default');
    await act(async () => {});
  });
});

// ============================================================
// POLLING GATING
// ============================================================

describe('useAlertPolling: polling gating', () => {
  it('does NOT poll when marketOpen is false', async () => {
    renderHook(() => useAlertPolling(false));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT poll when isOwner is false', async () => {
    vi.mocked(checkIsOwner).mockReturnValue(false);

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT poll when both marketOpen and isOwner are false', async () => {
    vi.mocked(checkIsOwner).mockReturnValue(false);

    renderHook(() => useAlertPolling(false));

    await act(async () => {});

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// FETCH BEHAVIOR
// ============================================================

describe('useAlertPolling: fetch behavior', () => {
  it('polls /api/alerts on mount when marketOpen && isOwner', async () => {
    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/alerts'),
      expect.any(Object),
    );
  });

  it('sends credentials: same-origin', async () => {
    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe('same-origin');
  });

  it('updates alerts state when fetch returns new alerts', async () => {
    const alerts = [makeAlert({ id: 1 }), makeAlert({ id: 2 })];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(2));

    expect(result.current.alerts[0]!.id).toBe(1);
    expect(result.current.alerts[1]!.id).toBe(2);
  });

  it('deduplicates alerts by id on subsequent fetches', async () => {
    const firstBatch = [makeAlert({ id: 1 })];
    const secondBatch = [
      makeAlert({ id: 1 }),
      makeAlert({ id: 2, created_at: '2026-03-24T17:35:00Z' }),
    ];

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ alerts: firstBatch }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ alerts: secondBatch }),
      });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(1));

    // Advance to next poll interval
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ALERTS);
    });

    await waitFor(() => expect(result.current.alerts.length).toBe(2));
  });

  it('handles non-ok fetch response silently', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal error' }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await act(async () => {});

    expect(result.current.alerts).toEqual([]);
  });

  it('handles network error silently', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useAlertPolling(true));

    await act(async () => {});

    expect(result.current.alerts).toEqual([]);
  });

  it('passes since param on subsequent fetches', async () => {
    const alert = makeAlert({
      id: 1,
      created_at: '2026-03-24T17:30:00Z',
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    // Reset mock to track the next call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [] }),
    });

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ALERTS);
    });

    const secondCallUrl = mockFetch.mock.calls.at(-1)?.[0] as string;
    expect(secondCallUrl).toContain('since=');
    expect(secondCallUrl).toContain(encodeURIComponent('2026-03-24T17:30:00Z'));
  });
});

// ============================================================
// UNACKNOWLEDGED COUNT
// ============================================================

describe('useAlertPolling: unacknowledgedCount', () => {
  it('computes unacknowledgedCount correctly', async () => {
    const alerts = [
      makeAlert({ id: 1, acknowledged: false }),
      makeAlert({ id: 2, acknowledged: true }),
      makeAlert({ id: 3, acknowledged: false }),
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    // Only unacknowledged alerts (id 1, 3) are added to state
    await waitFor(() => expect(result.current.alerts.length).toBe(2));

    expect(result.current.unacknowledgedCount).toBe(2);
  });

  it('returns 0 when all alerts are acknowledged', async () => {
    // Acknowledged alerts are filtered out during fetch
    const alerts = [
      makeAlert({ id: 1, acknowledged: true }),
      makeAlert({ id: 2, acknowledged: true }),
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    // No alerts added — all were acknowledged
    await act(async () => {});

    expect(result.current.alerts.length).toBe(0);
    expect(result.current.unacknowledgedCount).toBe(0);
  });
});

// ============================================================
// ACKNOWLEDGE
// ============================================================

describe('useAlertPolling: acknowledge', () => {
  it('calls POST /api/alerts-ack and updates state', async () => {
    const alerts = [makeAlert({ id: 42, acknowledged: false })];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(1));

    // Reset to capture the ack call
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    await act(async () => {
      await result.current.acknowledge(42);
    });

    // Verify POST call
    const ackCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes('/api/alerts-ack'),
    );
    expect(ackCall).toBeDefined();

    const init = ackCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ id: 42 });

    // State should be updated
    expect(result.current.alerts[0]!.acknowledged).toBe(true);
    expect(result.current.unacknowledgedCount).toBe(0);
  });

  it('handles ack failure silently', async () => {
    const alerts = [makeAlert({ id: 7, acknowledged: false })];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(1));

    // Ack call fails
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await act(async () => {
      await result.current.acknowledge(7);
    });

    // Alert remains unacknowledged since the call failed
    expect(result.current.alerts[0]!.acknowledged).toBe(false);
    expect(result.current.unacknowledgedCount).toBe(1);
  });
});

// ============================================================
// NOTIFICATION PERMISSION
// ============================================================

describe('useAlertPolling: notification permission', () => {
  it('requestPermission() calls Notification.requestPermission()', async () => {
    const { result } = renderHook(() => useAlertPolling(true));

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(Notification.requestPermission).toHaveBeenCalled();
  });

  it('updates notificationPermission after requestPermission()', async () => {
    const { result } = renderHook(() => useAlertPolling(true));

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.notificationPermission).toBe('granted');
  });

  it('sets notificationPermission to unsupported when Notification is undefined', async () => {
    // Remove Notification from global
    const saved = globalThis.Notification;
    // @ts-expect-error -- deliberately removing Notification for test
    delete globalThis.Notification;

    const { result } = renderHook(() => useAlertPolling(true));

    expect(result.current.notificationPermission).toBe('unsupported');

    // Restore
    globalThis.Notification = saved;
    await act(async () => {});
  });

  it('requestPermission() is a no-op when Notification is undefined', async () => {
    const saved = globalThis.Notification;
    // @ts-expect-error -- deliberately removing Notification for test
    delete globalThis.Notification;

    const { result } = renderHook(() => useAlertPolling(true));

    await act(async () => {
      await result.current.requestPermission();
    });

    // Should remain unsupported, no error thrown
    expect(result.current.notificationPermission).toBe('unsupported');

    globalThis.Notification = saved;
  });
});

// ============================================================
// INTERVAL POLLING
// ============================================================

describe('useAlertPolling: interval polling', () => {
  it('polls at POLL_INTERVALS.ALERTS interval', async () => {
    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    const initialCalls = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ALERTS);
    });

    expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('cleans up interval on unmount', async () => {
    const { unmount } = renderHook(() => useAlertPolling(true));

    await act(async () => {});

    const callsAfterMount = mockFetch.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVALS.ALERTS * 3);
    });

    // No new calls after unmount
    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);
  });

  it('fires browser notification on new alert', async () => {
    // Set Notification.permission to 'granted' for this test
    Object.defineProperty(mockNotification, 'permission', {
      value: 'granted',
      writable: true,
    });

    const alert = makeAlert({ id: 1, severity: 'critical' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    // Notification constructor should have been called
    expect(mockNotification).toHaveBeenCalledWith(
      alert.title,
      expect.objectContaining({
        body: alert.body,
        tag: `iv_spike-1`,
      }),
    );

    // Reset permission for other tests
    Object.defineProperty(mockNotification, 'permission', {
      value: 'default',
      writable: true,
    });
  });

  it('keeps max 50 alerts in state', async () => {
    const bigBatch = Array.from({ length: 55 }, (_, i) =>
      makeAlert({
        id: i + 1,
        created_at: `2026-03-24T17:${String(i).padStart(2, '0')}:00Z`,
      }),
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: bigBatch }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(50));
  });
});

// ============================================================
// AUDIO CHIME (lines 43-97)
// ============================================================

describe('useAlertPolling: audio chime', () => {
  /** Create a proper AudioContext class mock that works with `new`. */
  function makeAudioContextClass(spies: {
    start?: ReturnType<typeof vi.fn>;
    stop?: ReturnType<typeof vi.fn>;
    close?: ReturnType<typeof vi.fn>;
    connect?: ReturnType<typeof vi.fn>;
    setValueAtTime?: ReturnType<typeof vi.fn>;
    expRamp?: ReturnType<typeof vi.fn>;
  }) {
    return class MockAudioContext {
      destination = {};
      currentTime = 0;
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect: spies.connect ?? vi.fn(),
          start: spies.start ?? vi.fn(),
          stop: spies.stop ?? vi.fn(),
        };
      }
      createGain() {
        return {
          connect: vi.fn(),
          gain: {
            setValueAtTime: spies.setValueAtTime ?? vi.fn(),
            exponentialRampToValueAtTime: spies.expRamp ?? vi.fn(),
          },
        };
      }
      close = spies.close ?? vi.fn();
    };
  }

  it('plays chime with extreme severity (double repeat)', async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const setVal = vi.fn();
    const expRamp = vi.fn();

    vi.stubGlobal(
      'AudioContext',
      makeAudioContextClass({
        start,
        stop,
        setValueAtTime: setVal,
        expRamp,
      }),
    );

    const alert = makeAlert({ id: 99, severity: 'extreme' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    // extreme severity = 2 repeats × 3 notes = 6 oscillators
    expect(start).toHaveBeenCalledTimes(6);
    expect(stop).toHaveBeenCalledTimes(6);
    expect(setVal).toHaveBeenCalledTimes(6);
    expect(expRamp).toHaveBeenCalledTimes(6);
  });

  it('plays chime with warning severity (single repeat)', async () => {
    const start = vi.fn();
    const stop = vi.fn();

    vi.stubGlobal('AudioContext', makeAudioContextClass({ start, stop }));

    const alert = makeAlert({ id: 100, severity: 'warning' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    // warning severity = 1 repeat × 3 notes = 3 oscillators
    expect(start).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('repeats chime on interval for active alerts', async () => {
    const start = vi.fn();

    vi.stubGlobal('AudioContext', makeAudioContextClass({ start }));

    const alert = makeAlert({ id: 101, severity: 'critical' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    const initialCalls = start.mock.calls.length;

    // Advance past the critical chime interval (10s)
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    // Should have played the chime again
    expect(start.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('stops chime on acknowledge', async () => {
    const start = vi.fn();

    vi.stubGlobal('AudioContext', makeAudioContextClass({ start }));

    const alert = makeAlert({ id: 102, severity: 'extreme' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(1));

    const callsBeforeAck = start.mock.calls.length;

    // Acknowledge the alert — should stop the chime interval
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await act(async () => {
      await result.current.acknowledge(102);
    });

    // Advance past several chime intervals
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    // No additional chime plays after acknowledge
    expect(start.mock.calls.length).toBe(callsBeforeAck);
  });

  it('handles AudioContext construction failure silently', async () => {
    vi.stubGlobal(
      'AudioContext',
      class FailingAudioContext {
        constructor() {
          throw new Error('AudioContext not supported');
        }
      },
    );

    const alert = makeAlert({ id: 103, severity: 'critical' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    const { result } = renderHook(() => useAlertPolling(true));

    await waitFor(() => expect(result.current.alerts.length).toBe(1));

    // Alert still added despite audio failure
    expect(result.current.alerts[0]!.id).toBe(103);
  });

  it('closes AudioContext after playback finishes', async () => {
    const close = vi.fn();

    vi.stubGlobal('AudioContext', makeAudioContextClass({ close }));

    const alert = makeAlert({ id: 104, severity: 'warning' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ alerts: [alert] }),
    });

    renderHook(() => useAlertPolling(true));

    await act(async () => {});

    // ctx.close() called via setTimeout — advance past the timeout
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(close).toHaveBeenCalled();
  });
});
