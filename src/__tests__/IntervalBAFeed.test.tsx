// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { IntervalBAFeed } from '../components/IntervalBAFeed/IntervalBAFeed';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';

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

describe('IntervalBAFeed', () => {
  beforeEach(() => {
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

  it('toggles ?confluenceOnly=1 into the fetch URL', async () => {
    const { default: userEvent } = await import(
      '@testing-library/user-event'
    );
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
});
