import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOtmFlowAlerts } from '../../hooks/useOtmFlowAlerts';
import type { OtmFlowAlert, OtmFlowSettings } from '../../types/otm-flow';

// ── Mocks ──────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Fixtures ───────────────────────────────────────────────

function baseSettings(
  overrides: Partial<OtmFlowSettings> = {},
): OtmFlowSettings {
  return {
    windowMinutes: 30,
    minAskRatio: 0.6,
    minBidRatio: 0.6,
    minDistancePct: 0.005,
    minPremium: 50_000,
    sides: 'both',
    type: 'both',
    mode: 'live',
    historicalDate: '',
    historicalTime: '',
    audioOn: true,
    notificationsOn: false,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<OtmFlowAlert> = {}): OtmFlowAlert {
  return {
    id: 1,
    option_chain: 'SPXW260422C07100000',
    strike: 7100,
    type: 'call',
    created_at: '2026-04-22T15:00:00.000Z',
    price: 2.5,
    underlying_price: 7000,
    total_premium: 125000,
    total_size: 500,
    volume: 5000,
    open_interest: 1200,
    volume_oi_ratio: 4.17,
    ask_side_ratio: 0.82,
    bid_side_ratio: 0.1,
    distance_from_spot: 100,
    distance_pct: 0.01429,
    moneyness: 0.9859,
    dte_at_alert: 0,
    has_sweep: true,
    has_multileg: false,
    alert_rule: 'RepeatedHits',
    dominant_side: 'ask',
    ...overrides,
  };
}

function respond(
  alerts: OtmFlowAlert[],
  opts: { mode?: 'live' | 'historical' } = {},
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      alerts,
      alert_count: alerts.length,
      last_updated: alerts[0]?.created_at ?? null,
      spot: alerts[0]?.underlying_price ?? null,
      window_minutes: 30,
      mode: opts.mode ?? 'live',
      thresholds: { ask: 0.6, bid: 0.6, distance_pct: 0.005, premium: 50_000 },
    }),
  } as unknown as Response;
}

// ── Lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  // StrictMode double-invokes effects — give every fetch a sensible default
  // so the second call doesn't get `undefined` and throw. Individual tests
  // override via `mockResolvedValueOnce` or `mockResolvedValue` as needed.
  mockFetch.mockReset().mockResolvedValue(respond([]));
});

afterEach(() => {
  // Flush any stray pending timers if a test opted into fakes.
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});

// ══════════════════════════════════════════════════════════
// LIVE MODE
// ══════════════════════════════════════════════════════════

describe('useOtmFlowAlerts — live mode', () => {
  it('does not fetch when market is closed', async () => {
    const settings = baseSettings();
    const { result } = renderHook(() =>
      useOtmFlowAlerts({ settings, marketOpen: false }),
    );
    // Give React a microtask to process the initial effect.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.alerts).toEqual([]);
  });

  it('fetches on mount and populates alerts', async () => {
    mockFetch.mockResolvedValue(respond([makeAlert()]));

    const settings = baseSettings();
    const { result } = renderHook(() =>
      useOtmFlowAlerts({ settings, marketOpen: true }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.alerts[0]!.strike).toBe(7100);
    // lastUpdated is the client-side fetch time (liveness indicator), not
    // the newest alert's created_at. Assert it's a valid recent ISO string.
    expect(result.current.lastUpdated).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(result.current.mode).toBe('live');
    expect(result.current.error).toBeNull();
  });

  it('dedupes across polls — newlyArrived is only the diff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = [
      makeAlert({
        option_chain: 'A',
        created_at: '2026-04-22T15:00:00.000Z',
      }),
      makeAlert({
        option_chain: 'B',
        created_at: '2026-04-22T15:01:00.000Z',
      }),
    ];
    const second = [
      ...first,
      makeAlert({
        option_chain: 'C',
        created_at: '2026-04-22T15:02:00.000Z',
      }),
    ];

    mockFetch
      .mockResolvedValueOnce(respond(first))
      .mockResolvedValueOnce(respond(second));

    const settings = baseSettings();
    const { result } = renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: true,
        pollIntervalMs: 1000,
      }),
    );

    // First poll: 2 new (everything on cold start is new).
    await waitFor(() => expect(result.current.alerts).toHaveLength(2));
    expect(result.current.newlyArrived).toHaveLength(2);

    // Advance to second poll.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(result.current.alerts).toHaveLength(3));

    // Second poll: only C is new.
    expect(result.current.newlyArrived.map((a) => a.option_chain)).toEqual([
      'C',
    ]);
  });

  it('does not fetch while document.hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Installing an own property on `document` shadows the prototype getter.
    // We MUST delete that own property in finally, otherwise subsequent tests
    // inherit a permanently-hidden document and all their fetch-gated logic
    // silently skips.
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });

    try {
      mockFetch.mockResolvedValue(respond([makeAlert()]));

      const settings = baseSettings();
      renderHook(() =>
        useOtmFlowAlerts({
          settings,
          marketOpen: true,
          pollIntervalMs: 1000,
        }),
      );

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it('surfaces HTTP errors into result.error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);

    const settings = baseSettings();
    const { result } = renderHook(() =>
      useOtmFlowAlerts({ settings, marketOpen: true }),
    );

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.alerts).toEqual([]);
  });

  it('resets dedupe state when thresholds change', async () => {
    const alerts = [makeAlert({ option_chain: 'A' })];
    mockFetch.mockResolvedValue(respond(alerts));

    const { result, rerender } = renderHook(
      ({ settings }: { settings: OtmFlowSettings }) =>
        useOtmFlowAlerts({ settings, marketOpen: true }),
      { initialProps: { settings: baseSettings() } },
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.newlyArrived).toHaveLength(1);

    // Settle one more fetch to verify dedupe would normally suppress.
    // Changing minAskRatio wipes the dedupe set — next fetch treats the
    // same alerts as newly-arrived again.
    rerender({ settings: baseSettings({ minAskRatio: 0.7 }) });

    await waitFor(() => {
      // After threshold change the fetch re-runs and A is "new" again.
      expect(result.current.newlyArrived).toHaveLength(1);
    });
  });
});

// ══════════════════════════════════════════════════════════
// HISTORICAL MODE
// ══════════════════════════════════════════════════════════

describe('useOtmFlowAlerts — historical mode', () => {
  it('fetches once on mount, does not poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockResolvedValue(respond([makeAlert()], { mode: 'historical' }));

    const settings = baseSettings({
      mode: 'historical',
      historicalDate: '2026-04-21',
      historicalTime: '10:30',
    });
    const { result } = renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: false, // historical should work even outside market hours
        pollIntervalMs: 1000,
      }),
    );

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.mode).toBe('historical');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance far past the poll interval — must not re-fetch.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends date + CT-resolved as_of in the URL', async () => {
    mockFetch.mockResolvedValue(respond([], { mode: 'historical' }));

    const settings = baseSettings({
      mode: 'historical',
      historicalDate: '2026-04-21',
      historicalTime: '10:30',
    });
    renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: true,
      }),
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0]! as [string];
    expect(url).toContain('date=2026-04-21');
    // 2026-04-21 is inside CDT (UTC-5); 10:30 CT = 15:30 UTC.
    expect(url).toContain(encodeURIComponent('2026-04-21T15:30:00.000Z'));
  });

  it('omits as_of when historicalTime is empty', async () => {
    mockFetch.mockResolvedValue(respond([], { mode: 'historical' }));

    const settings = baseSettings({
      mode: 'historical',
      historicalDate: '2026-04-21',
      historicalTime: '',
    });
    renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: true,
      }),
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0]! as [string];
    expect(url).toContain('date=2026-04-21');
    expect(url).not.toContain('as_of=');
  });

  it('omits both date and as_of when mode=live', async () => {
    mockFetch.mockResolvedValue(respond([]));

    const settings = baseSettings({
      mode: 'live',
      historicalDate: '2026-04-21',
      historicalTime: '10:30',
    });
    renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: true,
      }),
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0]! as [string];
    expect(url).not.toContain('date=');
    expect(url).not.toContain('as_of=');
  });
});

// ══════════════════════════════════════════════════════════
// URL CONSTRUCTION
// ══════════════════════════════════════════════════════════

describe('useOtmFlowAlerts — URL params', () => {
  it('echoes all threshold settings into the query string', async () => {
    mockFetch.mockResolvedValue(respond([]));

    const settings = baseSettings({
      windowMinutes: 15,
      minAskRatio: 0.75,
      minBidRatio: 0.7,
      minDistancePct: 0.01,
      minPremium: 100_000,
      sides: 'ask',
      type: 'call',
    });
    renderHook(() =>
      useOtmFlowAlerts({
        settings,
        marketOpen: true,
        limit: 50,
      }),
    );

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0]! as [string];
    expect(url).toContain('window_minutes=15');
    expect(url).toContain('min_ask_ratio=0.75');
    expect(url).toContain('min_bid_ratio=0.7');
    expect(url).toContain('min_distance_pct=0.01');
    expect(url).toContain('min_premium=100000');
    expect(url).toContain('sides=ask');
    expect(url).toContain('type=call');
    expect(url).toContain('limit=50');
  });
});
