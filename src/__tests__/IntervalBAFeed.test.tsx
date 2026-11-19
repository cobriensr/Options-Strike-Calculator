// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { IntervalBAFeed } from '../components/IntervalBAFeed/IntervalBAFeed';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';

// Shorten the feed's auto-poll so the polling cases below step a few
// milliseconds, not ten seconds, each. Only the polling cases set marketOpen.
vi.mock('../constants', async () => {
  const actual =
    await vi.importActual<typeof import('../constants')>('../constants');
  return {
    ...actual,
    POLL_INTERVALS: { ...actual.POLL_INTERVALS, ALERTS: 30 },
  };
});

// The expanded row's charts are stubbed: their layout is not under test, and
// the rows' own requests are.
vi.mock('../components/charts/ContractTapeChart', () => ({
  ContractTapeChart: () => <div data-testid="contract-tape-chart" />,
}));
vi.mock('../components/charts/TickerNetFlowChart', () => ({
  TickerNetFlowChart: () => <div data-testid="ticker-netflow-chart" />,
}));

// The feed's date follows today on the shared ET clock, so every test that
// renders it runs on a pinned clock: a run that crossed ET midnight would
// refetch for the new day in the middle of a test. The pin is Thursday
// 2026-05-14, 13:00 ET. The rollover cases at the end set their own clocks.
const PINNED_NOW = '2026-05-14T17:00:00Z';

const SAMPLE_ALERT: IntervalBAFeedAlert = {
  id: 1,
  option_chain: 'SPXW260327C05800000',
  ticker: 'SPXW',
  option_type: 'C',
  strike: 5800,
  expiry: '2026-03-27',
  bucket_start: '2026-03-27T17:05:00.000Z',
  bucket_end: '2026-03-27T17:10:00.000Z',
  fired_at: '2026-03-27T17:06:24.000Z',
  ratio_pct: 85.5,
  ask_premium: 1200000,
  total_premium: 1400000,
  trade_count: 8,
  top_trade_premium: 600000,
  top_trade_size: 1000,
  top_trade_executed_at: '2026-03-27T17:06:23.000Z',
  top_trade_is_sweep: true,
  top_trade_is_floor: false,
  underlying_price: 5795,
  confluence_tickers: [],
  severity: 'extreme',
};

function mockFetch(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Error',
    json: vi.fn().mockResolvedValue(payload),
  });
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

function feedPayload(alert: IntervalBAFeedAlert) {
  return {
    alerts: [alert],
    summary: {
      count: 1,
      total_premium: alert.total_premium,
      extreme: 1,
      critical: 0,
      warning: 0,
    },
  };
}

/**
 * A fetch that answers the feed and its expanded rows' three endpoints by URL,
 * and returns every request so far as `"<path> <date>"`, in order. The feed
 * answers with `alertFor(date)`; a row endpoint answers with the date it was
 * asked for, which its hook checks against its own. With `latencyMs` (real
 * timers only) a response waits that long, so React renders between a request
 * and its response, as it does with a real network. An instant mock can hide a
 * loading flip, because the two state updates batch into one render: 10 ms of
 * latency makes the feed test deterministic.
 */
function routeFetch(
  alertFor: (date: string) => IntervalBAFeedAlert,
  latencyMs = 0,
): string[] {
  const requests: string[] = [];
  globalThis.fetch = vi.fn((url: string) => {
    const u = new URL(url, 'http://x');
    const date = u.searchParams.get('date') ?? '';
    requests.push(`${u.pathname} ${date}`);
    const payload =
      u.pathname === '/api/interval-ba-feed'
        ? feedPayload(alertFor(date))
        : { date, series: [], candles: [], previousClose: null };
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(payload),
    };
    if (latencyMs === 0) return Promise.resolve(response);
    return new Promise((resolve) => {
      setTimeout(() => resolve(response), latencyMs);
    });
  }) as unknown as typeof globalThis.fetch;
  return requests;
}

describe('IntervalBAFeed', () => {
  beforeEach(() => {
    // Only Date is faked, so timers, waitFor and user-event keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PINNED_NOW));
    // Default to an empty response so the loading transition completes.
    mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the section heading + methodology text', async () => {
    render(<IntervalBAFeed />);
    expect(screen.getByText(/Interval B\/A History/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Historical SPXW Interval B\/A/i),
    ).toBeInTheDocument();
  });

  it('shows empty-state copy when no alerts return', async () => {
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(
        screen.getByText(/No SPXW Interval B\/A alerts/i),
      ).toBeInTheDocument();
    });
  });

  it('renders a row when alerts are returned', async () => {
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/5800/)).toBeInTheDocument();
    });
    expect(screen.getByText('CALL')).toBeInTheDocument();
    expect(screen.getByText('EXTREME')).toBeInTheDocument();
    // Summary banner pieces
    expect(screen.getByText('extreme 1')).toBeInTheDocument();
  });

  it('renders a UW deep link for each row', async () => {
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(
        screen.getByLabelText(/Open SPXW260327C05800000 on Unusual Whales/i),
      ).toBeInTheDocument();
    });
    const link = screen.getByLabelText(
      /Open SPXW260327C05800000 on Unusual Whales/i,
    );
    expect(link.getAttribute('href')).toContain(
      'unusualwhales.com/flow/option_chains?chain=SPXW260327C05800000',
    );
  });

  it('surfaces a fetch error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('pg down')) as unknown as typeof fetch;
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/pg down/);
  });

  it('builds the fetch URL with the default time window', async () => {
    const fetch = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    const url = fetch.mock.calls[0]![0] as string;
    expect(url).toMatch(/^\/api\/interval-ba-feed\?/);
    expect(url).toContain('startTime=08%3A30');
    expect(url).toContain('endTime=15%3A00');
    // Confluence filter is OFF by default → param absent from URL.
    expect(url).not.toContain('confluenceOnly');
  });

  it('renders the +PARTNER pill when a row has confluence_tickers', async () => {
    const partnered: IntervalBAFeedAlert = {
      ...SAMPLE_ALERT,
      confluence_tickers: ['SPY', 'QQQ'],
    };
    mockFetch({
      alerts: [partnered],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/5800/)).toBeInTheDocument();
    });
    // Pill content is the alphabetically sorted "+QQQ +SPY" string.
    expect(screen.getByText('+QQQ +SPY')).toBeInTheDocument();
  });

  it('does NOT render the pill when confluence_tickers is empty', async () => {
    // SAMPLE_ALERT defaults to empty confluence_tickers — solo fire.
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/5800/)).toBeInTheDocument();
    });
    // No "+TICKER" pill rendered.
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders the moneyness pill — call OTM 0.09% for strike above spot', async () => {
    // SAMPLE_ALERT: call, strike 5800, spot 5795 → OTM by ~0.09%
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/OTM 0\.09%/i)).toBeInTheDocument();
    });
  });

  it('renders ITM pill for a call with strike below spot', async () => {
    const itmAlert: IntervalBAFeedAlert = {
      ...SAMPLE_ALERT,
      strike: 5700,
      underlying_price: 5800,
    };
    mockFetch({
      alerts: [itmAlert],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/ITM/)).toBeInTheDocument();
    });
  });

  it('exposes an expand toggle on each row', async () => {
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 1,
        total_premium: 1400000,
        extreme: 1,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Expand charts for SPXW/i }),
      ).toBeInTheDocument();
    });
  });

  it('toggles ?confluenceOnly=1 into the fetch URL', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const fetch = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /confluence only/i }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('confluenceOnly=1'))).toBe(true);
    });
  });

  it('filters by call/put when the type chips are clicked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const fetch = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^calls$/i }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('optionType=C'))).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: /^puts$/i }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('optionType=P'))).toBe(true);
    });
  });

  it('filters by min premium when a floor chip is clicked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const fetch = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /≥\$1M/ }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('minPremium=1000000'))).toBe(true);
    });
  });

  it('filters by moneyness when the ITM/OTM chip is clicked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const fetch = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^ITM$/ }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('moneyness=ITM'))).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: /^OTM$/ }));
    await waitFor(() => {
      const urls = fetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('moneyness=OTM'))).toBe(true);
    });
  });

  it('renders the "updated HH:MM:SS CT" timestamp once a fetch completes', async () => {
    mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(
        screen.getByText(/^updated \d{2}:\d{2}:\d{2} CT$/),
      ).toBeInTheDocument();
    });
  });

  it('renders the loading skeleton before the first response resolves', async () => {
    // Hold the fetch promise open so the initial render is still loading.
    const resolverRef: { resolve(r: Response): void } = {
      resolve() {
        /* replaced by the promise constructor */
      },
    };
    const pending = new Promise<Response>((r) => {
      resolverRef.resolve = r;
    });
    globalThis.fetch = vi.fn(() => pending) as unknown as typeof fetch;
    render(<IntervalBAFeed />);
    expect(screen.getByText(/Loading interval B\/A feed/i)).toBeInTheDocument();
    resolverRef.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        alerts: [],
        summary: {
          count: 0,
          total_premium: 0,
          extreme: 0,
          critical: 0,
          warning: 0,
        },
      }),
    } as Response);
    await waitFor(() => {
      expect(
        screen.getByText(/No SPXW Interval B\/A alerts/i),
      ).toBeInTheDocument();
    });
  });

  it('renders the summary banner with critical and warning chips', async () => {
    mockFetch({
      alerts: [SAMPLE_ALERT],
      summary: {
        count: 3,
        total_premium: 2_400_000,
        extreme: 1,
        critical: 1,
        warning: 1,
      },
    });
    render(<IntervalBAFeed />);
    await waitFor(() => {
      expect(screen.getByText(/extreme 1/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/critical 1/i)).toBeInTheDocument();
    expect(screen.getByText(/warning 1/i)).toBeInTheDocument();
    // "3" and "alerts · …" sit in adjacent spans inside the banner;
    // assert each piece individually rather than the merged string.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/^alerts ·/)).toBeInTheDocument();
  });

  // The feed polls today during market hours (30 ms here, the mock above). A
  // poll used to flip `loading` on, which swapped the rows for the loading
  // text and back: every row remounted collapsed, so a row the owner had
  // opened closed itself every ten seconds.
  it('leaves an expanded row open across polls of the same day', async () => {
    // 10 ms of latency against the 30 ms poll: a render lands between each
    // poll's request and its response.
    const requests = routeFetch(() => SAMPLE_ALERT, 10);
    const feedRequests = () =>
      requests.filter((r) => r.startsWith('/api/interval-ba-feed')).length;
    render(<IntervalBAFeed marketOpen />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Expand charts for SPXW' }),
    );
    expect(
      screen.getByRole('button', { name: 'Collapse charts' }),
    ).toBeInTheDocument();
    const asked = feedRequests();

    // Three polls: each one's response lands, and the row is still open.
    await waitFor(() => {
      expect(feedRequests()).toBeGreaterThanOrEqual(asked + 3);
    });
    await act(async () => {});

    expect(
      screen.getByRole('button', { name: 'Collapse charts' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
  });
});

// ============================================================
// Midnight rollover (docs/superpowers/specs/panel-date-rollover-2026-11-14.md,
// Phase 8, design items 2 and 3)
//
// The feed kept its date in `useState(todayCt())`, so a tab left open past
// midnight stayed on yesterday and `max` blocked the new day. Clearing the
// date field sent `date=` and the server answered 400. The date follows the
// shared ET clock now (`useFollowedDate`): the owner's pick, else today; a
// pick of today, or an emptied field, follows again; any other date stays
// put. (The date is the CT date of the SPXW expiry, but nothing fires or polls
// from 23:00 to 24:00 CT, the only hour the two differ.) The Start and End
// times are filters that apply to any date, so they stay across the roll. The
// hook holds a changed date for 250 ms (useDebounced) before it fetches, so a
// date that follows the roll, or a pick, refetches once, 250 ms after it: each
// case settles after a change. Every case starts 30 s before an ET midnight
// (the polling case, 5 ms); the clock's timer is armed for 1 s past it, so
// 31 s lands just after (23:00:01 CT the evening before). The auto-poll is off
// (marketOpen defaults to false) except in the one case that rolls a polling
// feed; the gate itself is tested on the hook. Every assertion on requests
// reads the whole sequence, and no case calls `rerender`.
//
// A row's date is the feed's date, but its alerts are the ones last fetched.
// The feed is `loading` from the roll until the new date's response lands, so
// no row is drawn with a date its alerts were not fetched for, and an expanded
// row never asks for the new date with the old day's contract.
// ============================================================

describe.each([
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    midnight: '2026-11-10T05:00:00Z',
    night: '2026-11-09',
    morning: '2026-11-10',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    midnight: '2026-07-15T04:00:00Z',
    night: '2026-07-14',
    morning: '2026-07-15',
  },
])('IntervalBAFeed: across the $zone midnight', (m) => {
  /** useDebounced's default delay: a changed date waits this long to fetch. */
  const SETTLE_MS = 250;
  // Distinct strikes tell the night's alert from the morning's on screen.
  const NIGHT_ALERT: IntervalBAFeedAlert = {
    ...SAMPLE_ALERT,
    id: 1,
    strike: 5822,
  };
  const MORNING_ALERT: IntervalBAFeedAlert = {
    ...SAMPLE_ALERT,
    id: 2,
    strike: 5811,
  };
  const alertFor = (date: string) =>
    date === m.night ? NIGHT_ALERT : MORNING_ALERT;
  // The summary banner's first line: "1 alert · $1.4M total premium".
  const SUMMARY_BANNER = /^alerts? ·/;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // setInterval is faked for the one case that polls (usePolling).
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    });
    vi.setSystemTime(new Date(m.start));
    fetchSpy = mockFetch({
      alerts: [],
      summary: {
        count: 0,
        total_premium: 0,
        extreme: 0,
        critical: 0,
        warning: 0,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** The shared clock's timer fires, just past midnight. */
  function crossMidnight() {
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }
  const flush = () => act(async () => {});
  /** Let a changed date settle: past the debounce, with its fetch resolved. */
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 50);
    });

  const dateInput = () => screen.getByLabelText<HTMLInputElement>('Date');
  function pick(date: string) {
    fireEvent.change(dateInput(), { target: { value: date } });
  }
  /** The query string of every request so far, in order. */
  const requested = () =>
    fetchSpy.mock.calls.map(
      (c) => new URL(c[0] as string, 'http://x').searchParams,
    );
  const datesRequested = () => requested().map((p) => p.get('date'));

  it('follows the new ET day with no parent re-render: field, max, and one refetch for the new date after the debounce', async () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <IntervalBAFeed />;
    }
    render(<Parent />);
    await flush();
    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.night);
    expect(datesRequested()).toEqual([m.night]);

    crossMidnight();
    await flush();

    expect(parentRenders).toBe(1);
    expect(dateInput().value).toBe(m.morning);
    expect(dateInput().max).toBe(m.morning);
    // The new date is held for the debounce: no request for it yet, and none
    // for the night again.
    expect(datesRequested()).toEqual([m.night]);

    await settle();

    expect(datesRequested()).toEqual([m.night, m.morning]);
    // The time window is a filter, not part of the day: it stays.
    expect(requested().every((p) => p.get('startTime') === '08:30')).toBe(true);
    expect(requested().every((p) => p.get('endTime') === '15:00')).toBe(true);
  });

  it('keeps a picked past date across the roll, and moves max', async () => {
    render(<IntervalBAFeed />);
    await flush();
    pick('2026-04-20');
    await settle();
    expect(datesRequested()).toEqual([m.night, '2026-04-20']);

    crossMidnight();
    await flush();
    await settle();

    expect(dateInput().value).toBe('2026-04-20');
    expect(dateInput().max).toBe(m.morning);
    // Nothing was requested for the new day: the pick held.
    expect(datesRequested()).toEqual([m.night, '2026-04-20']);
  });

  it('follows again when today is picked back, across the roll', async () => {
    render(<IntervalBAFeed />);
    await flush();
    pick('2026-04-20');
    await settle();
    pick(m.night);
    await settle();

    crossMidnight();
    await flush();
    await settle();

    // A stored date would stay on the night. A pick of today is following.
    expect(dateInput().value).toBe(m.morning);
    expect(datesRequested()).toEqual([
      m.night,
      '2026-04-20',
      m.night,
      m.morning,
    ]);
  });

  it('follows today when the field is left empty, not when it empties, and never sends an empty date', async () => {
    render(<IntervalBAFeed />);
    await flush();
    pick('2026-04-20');
    await settle();

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit: no request, even after the debounce, and the field shows what
    // was typed.
    pick('');
    await settle();
    expect(datesRequested()).toEqual([m.night, '2026-04-20']);
    expect(dateInput().value).toBe('');

    fireEvent.blur(dateInput());
    await settle();

    // `date=` is a 400 from the server.
    expect(datesRequested()).toEqual([m.night, '2026-04-20', m.night]);
    expect(dateInput().value).toBe(m.night);
  });

  it('passes a future date on and keeps it in the field', async () => {
    render(<IntervalBAFeed />);
    await flush();

    // `max` is a hint the browser does not enforce on typing; a partial date on
    // the way to a past one is often a future one.
    pick(m.morning);
    await settle();

    expect(datesRequested()).toEqual([m.night, m.morning]);
    expect(dateInput().value).toBe(m.morning);
  });

  it('draws no row from the roll until the new date has answered, and then only its alerts', async () => {
    routeFetch(alertFor);
    render(<IntervalBAFeed />);
    await settle();
    expect(screen.getByText('5822')).toBeInTheDocument();
    expect(screen.getByText(SUMMARY_BANNER)).toBeInTheDocument();
    expect(screen.getByText('extreme 1')).toBeInTheDocument();

    crossMidnight();
    await flush();

    // The field reads the new day while the held alerts are still the night's,
    // and the date is held by the debounce: no row, so none carries a date its
    // alert was not fetched for, and no summary of the night's totals beside
    // the loading text.
    expect(dateInput().value).toBe(m.morning);
    expect(screen.queryByText('5822')).toBeNull();
    expect(screen.queryByText(SUMMARY_BANNER)).toBeNull();
    expect(screen.queryByText('extreme 1')).toBeNull();
    expect(screen.getByText(/Loading interval B\/A feed/)).toBeInTheDocument();

    // Still inside the debounce, a moment before the new date settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 10);
    });
    expect(screen.queryByText(SUMMARY_BANNER)).toBeNull();

    await settle();

    expect(screen.getByText('5811')).toBeInTheDocument();
    expect(screen.queryByText('5822')).toBeNull();
    expect(screen.getByText(SUMMARY_BANNER)).toBeInTheDocument();
  });

  // The roll's fetch fails, then the owner refreshes. The error is the new
  // date's answer: the night's rows and totals do not come back while the
  // retry is in flight, and the error stays until it succeeds.
  it('shows no night row or total when the new date fails and the feed is refreshed', async () => {
    let morningRequests = 0;
    globalThis.fetch = vi.fn((url: string) => {
      const date = new URL(url, 'http://x').searchParams.get('date');
      if (date === m.night) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(feedPayload(NIGHT_ALERT)),
        });
      }
      morningRequests += 1;
      // The first request for the new date fails; the retry never answers.
      if (morningRequests > 1) return new Promise(() => {});
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({ error: 'upstream down' }),
      });
    }) as unknown as typeof globalThis.fetch;
    render(<IntervalBAFeed />);
    await settle();
    expect(screen.getByText('5822')).toBeInTheDocument();

    crossMidnight();
    await flush();
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('upstream down');
    expect(screen.queryByText('5822')).toBeNull();
    expect(screen.queryByText(SUMMARY_BANNER)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh feed' }));
    await flush();

    // The retry is out and unanswered.
    expect(morningRequests).toBe(2);
    expect(screen.getByRole('alert')).toHaveTextContent('upstream down');
    expect(screen.queryByText('5822')).toBeNull();
    expect(screen.queryByText(SUMMARY_BANNER)).toBeNull();
  });

  it('keeps an open row from asking for the new date with the night contract', async () => {
    const requests = routeFetch(alertFor);
    render(<IntervalBAFeed />);
    await settle();
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand charts for SPXW' }),
    );
    await settle();
    const night = [
      `/api/interval-ba-feed ${m.night}`,
      `/api/lottery-contract-tape ${m.night}`,
      `/api/net-flow-history ${m.night}`,
      `/api/ticker-candles ${m.night}`,
    ];
    expect(requests).toEqual(night);

    crossMidnight();
    await flush();

    // The roll unmounts the open row: its three hooks do not re-point at the
    // new date while their alert is still the night's.
    expect(requests).toEqual(night);

    await settle();

    expect(requests).toEqual([...night, `/api/interval-ba-feed ${m.morning}`]);
    // The new day's rows start closed.
    expect(
      screen.getByRole('button', { name: 'Expand charts for SPXW' }),
    ).toBeInTheDocument();
  });

  it('stops polling the night at the roll and polls the new day once its date settles, with one request for it', async () => {
    // Off the poll grid: a 30 ms poll ticks at 990 and 1020 ms, and the roll
    // is 1005 ms in. The date settles 250 ms after the roll commits, the
    // gate reopens then, and polling starts over from there.
    vi.setSystemTime(new Date(Date.parse(m.midnight) - 5));
    render(<IntervalBAFeed marketOpen />);
    await flush();
    // Each poll in its own act: one act around a long advance batches the
    // state-driven polls into one refetch.
    for (let i = 0; i < 33; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30);
      });
    }
    const before = fetchSpy.mock.calls.length;
    expect(before).toBeGreaterThan(10);
    expect(new Set(datesRequested())).toEqual(new Set([m.night]));

    // The roll. The date is held: the poll gate closes with the settled date
    // still on the night, and nothing is requested for either day.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(dateInput().value).toBe(m.morning);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchSpy.mock.calls.length).toBe(before);

    // The date settles: exactly one request, for the new day.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });
    await flush();
    expect(datesRequested().slice(before)).toEqual([m.morning]);

    // And the new day polls from then.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flush();
    expect(datesRequested().slice(before)).toEqual([m.morning, m.morning]);
  });

  it('does not let the night response, arriving after the roll, replace the new day', async () => {
    // A fetch that never looks at its abort signal, held until the test
    // answers it: the night's request is still in flight at the roll.
    const held: { date: string; answer: (p: unknown) => void }[] = [];
    globalThis.fetch = vi.fn((url: string) => {
      const date = new URL(url, 'http://x').searchParams.get('date') ?? '';
      return new Promise((resolve) => {
        held.push({
          date,
          answer: (payload) =>
            resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              json: () => Promise.resolve(payload),
            }),
        });
      });
    }) as unknown as typeof globalThis.fetch;
    render(<IntervalBAFeed />);
    await flush();
    crossMidnight();
    await flush();
    await settle();
    expect(held.map((h) => h.date)).toEqual([m.night, m.morning]);

    await act(async () => {
      held[1]?.answer(feedPayload(MORNING_ALERT));
    });
    expect(screen.getByText('5811')).toBeInTheDocument();

    // The night's answer arrives last. Its request was aborted when the date
    // settled, so it must not reach state.
    await act(async () => {
      held[0]?.answer(feedPayload(NIGHT_ALERT));
    });

    expect(screen.getByText('5811')).toBeInTheDocument();
    expect(screen.queryByText('5822')).toBeNull();
  });
});

// ============================================================
// A hung upstream
//
// Each poll aborts the request before it, so a hung upstream never reaches the
// 15 s timeout and raises no error: the last rows would sit under a frozen
// "updated" stamp and look fresh. While the feed polls, a newest response more
// than three polls old (30 ms each here, the mock above) is labelled "stale".
// ============================================================

describe('IntervalBAFeed: a live feed whose upstream hangs', () => {
  /** Every request, unanswered until the test answers it. */
  const held: { answer: (payload: unknown) => void }[] = [];

  beforeEach(() => {
    held.length = 0;
    vi.useFakeTimers({ now: new Date(PINNED_NOW) });
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          held.push({
            answer: (payload) =>
              resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: () => Promise.resolve(payload),
              }),
          });
        }),
    ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const step = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const answerLatest = () =>
    act(async () => {
      held.at(-1)?.answer(feedPayload(SAMPLE_ALERT));
      await vi.advanceTimersByTimeAsync(0);
    });
  const UPDATED = /^updated \d{2}:\d{2}:\d{2} CT$/;

  it('labels the updated stamp stale after three polls with no answer, and a fresh response clears it', async () => {
    render(<IntervalBAFeed marketOpen />);
    await answerLatest();
    expect(screen.getByText(UPDATED)).toBeInTheDocument();
    expect(screen.queryByText('stale')).toBeNull();

    for (let i = 0; i < 3; i += 1) {
      await step(30);
      expect(screen.queryByText('stale')).toBeNull();
    }
    await step(30);

    // A word, not only a colour; the rows and the stamp stay where they were.
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText(UPDATED)).toBeInTheDocument();
    expect(screen.getByText('5800')).toBeInTheDocument();

    await answerLatest();

    expect(screen.queryByText('stale')).toBeNull();
  });

  it('clears the label when the feed moves to a past date, which does not poll', async () => {
    render(<IntervalBAFeed marketOpen />);
    await answerLatest();
    await step(120);
    expect(screen.getByText('stale')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Date'), {
      target: { value: '2026-04-20' },
    });
    await step(300);

    // The past date's request is still unanswered, and no poll is coming.
    expect(screen.queryByText('stale')).toBeNull();
  });
});
