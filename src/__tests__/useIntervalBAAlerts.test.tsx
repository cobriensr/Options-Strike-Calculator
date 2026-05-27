// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as const),
}));

vi.mock('../utils/anomaly-sound', () => ({
  playSweepAlarm: vi.fn(),
}));

// Shorten the poll interval to 30 ms so waitFor() catches the second
// fetch in <100 ms instead of waiting the production 10 s. Fake timers
// don't play well with @testing-library/waitFor (it polls via
// setTimeout internally, which freezes under vi.useFakeTimers).
vi.mock('../constants', async () => {
  const actual =
    await vi.importActual<typeof import('../constants')>('../constants');
  return {
    ...actual,
    POLL_INTERVALS: { ...actual.POLL_INTERVALS, ALERTS: 30 },
  };
});

import {
  useIntervalBAAlerts,
  formatIntervalBATitle,
  formatIntervalBANotificationTitle,
  formatIntervalBABody,
  __resetChimesForTests,
  type IntervalBAAlert,
} from '../hooks/useIntervalBAAlerts';
import { getAccessMode } from '../utils/auth';
import { playSweepAlarm } from '../utils/anomaly-sound';

const baseAlert: IntervalBAAlert = {
  id: 1,
  option_chain: 'SPXW260512C07360000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: 7360,
  expiry: '2026-05-12',
  bucket_start: '2026-05-12T17:05:00.000Z',
  bucket_end: '2026-05-12T17:10:00.000Z',
  fired_at: '2026-05-12T17:06:24.000Z',
  ratio_pct: 71.23,
  ask_premium: 950000,
  total_premium: 1330000,
  trade_count: 5,
  top_trade_premium: 408480,
  top_trade_size: 888,
  top_trade_executed_at: '2026-05-12T17:06:23.000Z',
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: 7355,
  confluence_tickers: [],
  acknowledged: false,
  severity: 'extreme',
};

function mockFetchJson(payload: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as typeof fetch;
}

describe('formatIntervalBATitle', () => {
  it('formats ticker + strike + type + ratio rounded to int', () => {
    expect(formatIntervalBATitle(baseAlert)).toBe('SPXW 7360C 71% ASK');
  });

  it('renders put option_type', () => {
    expect(
      formatIntervalBATitle({ ...baseAlert, option_type: 'P', strike: 7350 }),
    ).toBe('SPXW 7350P 71% ASK');
  });

  it('rounds non-integer strike', () => {
    expect(formatIntervalBATitle({ ...baseAlert, strike: 7355.5 })).toBe(
      'SPXW 7356C 71% ASK',
    );
  });

  it('does NOT decorate with confluence partners (banner pill carries it)', () => {
    // formatIntervalBATitle stays pure — the in-banner display adds a
    // separate +PARTNER pill so we don't duplicate. The OS-notification
    // formatter below is the one that suffixes.
    expect(
      formatIntervalBATitle({
        ...baseAlert,
        confluence_tickers: ['SPY', 'QQQ'],
      }),
    ).toBe('SPXW 7360C 71% ASK');
  });
});

describe('formatIntervalBANotificationTitle', () => {
  it('returns the bare title when no confluence partners', () => {
    expect(formatIntervalBANotificationTitle(baseAlert)).toBe(
      'SPXW 7360C 71% ASK',
    );
  });

  it('appends single +TICKER suffix', () => {
    expect(
      formatIntervalBANotificationTitle({
        ...baseAlert,
        confluence_tickers: ['SPY'],
      }),
    ).toBe('SPXW 7360C 71% ASK +SPY');
  });

  it('sorts and appends multiple +TICKER suffixes alphabetically', () => {
    // Insert reverse-sorted to confirm the formatter re-sorts.
    expect(
      formatIntervalBANotificationTitle({
        ...baseAlert,
        confluence_tickers: ['SPY', 'QQQ'],
      }),
    ).toBe('SPXW 7360C 71% ASK +QQQ +SPY');
  });
});

describe('formatIntervalBABody', () => {
  it('renders sub-million premium in $K', () => {
    expect(
      formatIntervalBABody({
        ...baseAlert,
        total_premium: 408480,
        trade_count: 1,
        top_trade_premium: 408480,
        top_trade_size: 888,
        top_trade_is_sweep: true,
        top_trade_is_floor: false,
      }),
    ).toBe('$408K premium / 1 trade — top: $408K sweep');
  });

  it('renders >= $1M premium in $X.XXM form', () => {
    expect(
      formatIntervalBABody({
        ...baseAlert,
        total_premium: 1_330_000,
        trade_count: 5,
        top_trade_premium: 408_480,
        top_trade_is_sweep: true,
      }),
    ).toBe('$1.33M premium / 5 trades — top: $408K sweep');
  });

  it('omits top-trade clause when fields are null', () => {
    expect(
      formatIntervalBABody({
        ...baseAlert,
        total_premium: 300_000,
        trade_count: 2,
        top_trade_premium: null,
        top_trade_size: null,
        top_trade_is_sweep: null,
        top_trade_is_floor: null,
      }),
    ).toBe('$300K premium / 2 trades');
  });

  it('includes floor flag when set', () => {
    expect(
      formatIntervalBABody({
        ...baseAlert,
        total_premium: 500_000,
        trade_count: 1,
        top_trade_premium: 500_000,
        top_trade_size: 100,
        top_trade_is_sweep: false,
        top_trade_is_floor: true,
      }),
    ).toBe('$500K premium / 1 trade — top: $500K floor');
  });

  it('joins sweep + floor when both set', () => {
    expect(
      formatIntervalBABody({
        ...baseAlert,
        top_trade_is_sweep: true,
        top_trade_is_floor: true,
        top_trade_premium: 200_000,
      }),
    ).toContain('sweep floor');
  });
});

describe('useIntervalBAAlerts', () => {
  beforeEach(() => {
    vi.mocked(getAccessMode).mockReturnValue('owner');
    vi.mocked(playSweepAlarm).mockClear();
    // Clear the module-level chime dedupe map so alert id=1 in test A
    // doesn't suppress alert id=1 in test B.
    __resetChimesForTests();
  });

  afterEach(() => {
    __resetChimesForTests();
    vi.restoreAllMocks();
  });

  it('does not poll for public (signed-out) visitors', () => {
    vi.mocked(getAccessMode).mockReturnValue('public');
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    renderHook(() => useIntervalBAAlerts(true));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('polls for guests with a valid guest-key session', async () => {
    vi.mocked(getAccessMode).mockReturnValue('guest');
    mockFetchJson({ alerts: [baseAlert] });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));
    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    expect(globalThis.fetch).toHaveBeenCalled();
    unmount();
  });

  it('does not poll when market closed', () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    renderHook(() => useIntervalBAAlerts(false));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches on mount when owner + marketOpen, surfaces new alerts', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { result } = renderHook(() => useIntervalBAAlerts(true));

    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    expect(result.current.alerts[0]?.id).toBe(1);
    expect(result.current.unacknowledgedCount).toBe(1);
    expect(vi.mocked(playSweepAlarm)).toHaveBeenCalledWith('extreme');
  });

  it('deduplicates alerts across polls (does not re-fire chime)', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));

    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    expect(vi.mocked(playSweepAlarm)).toHaveBeenCalledTimes(1);

    // Wait through several poll cycles (30 ms × 3 = 90 ms). The same
    // alert id arrives each time but must not re-fire the chime.
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(playSweepAlarm)).toHaveBeenCalledTimes(1);

    unmount(); // Stop the polling interval cleanly.
  });

  it('appends ?since= on subsequent polls', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { unmount } = renderHook(() => useIntervalBAAlerts(true));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const firstCallUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(firstCallUrl).toBe('/api/interval-ba-alerts');

    await waitFor(
      () => {
        expect(
          (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1_000 },
    );
    const secondCallUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as string;
    expect(secondCallUrl).toContain('?since=');
    expect(secondCallUrl).toContain('2026-05-12T17%3A06%3A24.000Z');

    unmount();
  });

  it('ignores acknowledged alerts in the response', async () => {
    mockFetchJson({ alerts: [{ ...baseAlert, acknowledged: true }] });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    // Tick the microtask queue so the post-fetch state settle resolves
    // even though no alerts are pushed (the hook short-circuits).
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.alerts).toHaveLength(0);
    expect(vi.mocked(playSweepAlarm)).not.toHaveBeenCalled();

    unmount();
  });

  it('acknowledge() POSTs and marks the alert acknowledged', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));
    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });

    // Swap fetch mock so the ack call returns a fresh fixture.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ acknowledged: 1 }),
    }) as unknown as typeof fetch;

    await act(async () => {
      await result.current.acknowledge(1);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/interval-ba-alerts-ack',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(result.current.alerts[0]?.acknowledged).toBe(true);
    expect(result.current.unacknowledgedCount).toBe(0);

    unmount();
  });

  it('does NOT mark alert acknowledged when ack POST returns non-ok', async () => {
    // Reproduces the bug where dismissed alerts reappeared on refresh:
    // a 401/403/500 on POST /api/interval-ba-alerts-ack resolved
    // silently and the local state lied that the dismiss succeeded.
    // Now the alert must stay visible so the user notices + retries.
    mockFetchJson({ alerts: [baseAlert] });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));
    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'unauthorized' }),
    }) as unknown as typeof fetch;

    await act(async () => {
      await result.current.acknowledge(1);
    });

    expect(result.current.alerts[0]?.acknowledged).toBe(false);
    expect(result.current.unacknowledgedCount).toBe(1);

    unmount();
  });

  it('does not crash when fetch returns malformed payload', async () => {
    mockFetchJson({ unexpected: 'shape' });

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.alerts).toHaveLength(0);

    unmount();
  });

  it('silently handles fetch failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useIntervalBAAlerts(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.alerts).toHaveLength(0);

    unmount();
  });

  it('when muted, populates alerts but does NOT chime or notify', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { result, unmount } = renderHook(() =>
      useIntervalBAAlerts(true, true),
    );

    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    // Alert IS in state so the count badge + restored stack reflect it.
    expect(result.current.unacknowledgedCount).toBe(1);
    // ...but the chime never fires.
    expect(vi.mocked(playSweepAlarm)).not.toHaveBeenCalled();

    unmount();
  });

  it('flipping muted=true mid-flight stops the repeating chime', async () => {
    // Without the [muted] effect that loops stopChime over seenIdsRef,
    // an extreme alert's 5s repeating chime would keep ringing for the
    // full interval after the user hit mute. Spy on clearInterval since
    // stopChime is module-private; it's the smoking gun for the stop.
    mockFetchJson({ alerts: [baseAlert] });
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const { result, rerender, unmount } = renderHook(
      ({ muted }: { muted: boolean }) => useIntervalBAAlerts(true, muted),
      { initialProps: { muted: false } },
    );

    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    // Chime started. Now flip mute on.
    expect(vi.mocked(playSweepAlarm)).toHaveBeenCalled();
    const clearsBeforeMute = clearSpy.mock.calls.length;

    rerender({ muted: true });

    // The [muted] effect ran stopChime over the seen id; that calls
    // clearInterval on the active chime handle. At least one new
    // clearInterval call must appear vs. before the mute flip.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearsBeforeMute);

    clearSpy.mockRestore();
    unmount();
  });

  it('un-muting after a muted fire does not retroactively chime past alerts', async () => {
    mockFetchJson({ alerts: [baseAlert] });

    const { result, rerender, unmount } = renderHook(
      ({ muted }: { muted: boolean }) => useIntervalBAAlerts(true, muted),
      { initialProps: { muted: true } },
    );

    await waitFor(() => {
      expect(result.current.alerts).toHaveLength(1);
    });
    expect(vi.mocked(playSweepAlarm)).not.toHaveBeenCalled();

    // Flip mute off — the past alert is already in the dedupe set so
    // the next poll should NOT re-emit a chime for it. Only NEW fires
    // would chime.
    rerender({ muted: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(playSweepAlarm)).not.toHaveBeenCalled();

    unmount();
  });
});
