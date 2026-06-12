// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────
// Sentry helper is a no-op in tests — we only care it isn't a hard
// dependency that crashes the error path.
vi.mock('../lib/sentry-helpers', () => ({
  captureUnlessAuth: vi.fn(),
}));

// Shorten the auto-poll cadence so the "polls on today + open" assertion
// resolves quickly instead of waiting the production interval.
vi.mock('../constants', async () => {
  const actual =
    await vi.importActual<typeof import('../constants')>('../constants');
  return {
    ...actual,
    POLL_INTERVALS: { ...actual.POLL_INTERVALS, ALERTS: 30 },
  };
});

import {
  useIntervalBAFeed,
  type IntervalBAFeedAlert,
  type IntervalBAFeedSummary,
  type UseIntervalBAFeedParams,
} from '../hooks/useIntervalBAFeed';

// CT calendar "today" — mirrors the hook's own todayCt() so the polling
// gate predicate matches regardless of the wall-clock day the suite runs.
function todayCt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const baseAlert: IntervalBAFeedAlert = {
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
  severity: 'extreme',
};

const baseSummary: IntervalBAFeedSummary = {
  count: 1,
  total_premium: 1330000,
  extreme: 1,
  critical: 0,
  warning: 0,
};

const baseParams: UseIntervalBAFeedParams = {
  date: '2026-05-12',
  startTime: '08:30',
  endTime: '15:00',
  optionType: null,
  minPremium: 0,
  confluenceOnly: false,
  moneyness: null,
};

function mockFetchJson(payload: unknown, ok = true): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as typeof fetch;
}

describe('useIntervalBAFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in the loading state with empty data', () => {
    // Never-resolving fetch so we can observe the initial state.
    globalThis.fetch = vi
      .fn()
      .mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    expect(result.current.loading).toBe(true);
    expect(result.current.alerts).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).toBeNull();
  });

  it('fetches the historical slice and transitions to parsed data', async () => {
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.alerts).toHaveLength(1);
    expect(result.current.alerts[0]?.id).toBe(1);
    expect(result.current.summary).toEqual(baseSummary);
    expect(result.current.error).toBeNull();
    expect(result.current.fetchedAt).not.toBeNull();
  });

  it('builds the request URL from the date + time window params', async () => {
    mockFetchJson({ alerts: [], summary: { ...baseSummary, count: 0 } });

    renderHook(() =>
      useIntervalBAFeed({
        ...baseParams,
        optionType: 'C',
        minPremium: 250000,
        confluenceOnly: true,
        moneyness: 'OTM',
      }),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(url).toContain('/api/interval-ba-feed?');
    expect(url).toContain('date=2026-05-12');
    expect(url).toContain('startTime=08%3A30');
    expect(url).toContain('endTime=15%3A00');
    expect(url).toContain('optionType=C');
    expect(url).toContain('minPremium=250000');
    expect(url).toContain('confluenceOnly=1');
    expect(url).toContain('moneyness=OTM');
  });

  it('does NOT auto-poll when the market is closed (historical view)', async () => {
    // Today's date but marketOpen=false → the mount fetch fires once, but
    // the recurring poll gate stays closed, so no further fetches arrive.
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { unmount } = renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: todayCt() }, false),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    // Wait through several would-be poll cycles (30 ms × 3).
    await new Promise((r) => setTimeout(r, 120));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('auto-polls when viewing today during market hours', async () => {
    mockFetchJson({ alerts: [baseAlert], summary: baseSummary });

    const { unmount } = renderHook(() =>
      useIntervalBAFeed({ ...baseParams, date: todayCt() }, true),
    );

    // Mount fetch + at least one poll-driven refetch.
    await waitFor(
      () => {
        expect(
          (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 1_000 },
    );

    unmount();
  });

  it('surfaces an error message on a non-ok response', async () => {
    mockFetchJson({ error: 'boom' }, false);

    const { result } = renderHook(() => useIntervalBAFeed(baseParams));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.alerts).toEqual([]);
  });
});
