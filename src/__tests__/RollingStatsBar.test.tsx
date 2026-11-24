// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { RollingStatsBar } from '../components/GammaNodeDetector/RollingStatsBar';
import type { AggregateStats } from '../hooks/useGammaWeeklyStats';
import { srHintText, titledGenericsWithoutHint } from './helpers/aria';

// Auth-mode mock — RollingStatsBar uses `getAccessMode()` indirectly via
// useGammaWeeklyStats; we need it to return a non-public value so the
// hook actually fetches.
vi.mock('../utils/auth', () => ({
  getAccessMode: () => 'owner',
}));

// usePolling is a real timer-based hook; for these tests we only care
// about the eager mount fetch + reactivity, not the recurring poll.
// Stub it to a no-op so vitest doesn't keep timers alive between tests.
vi.mock('../hooks/usePolling', () => ({
  usePolling: () => undefined,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeStats(overrides: Partial<AggregateStats> = {}): AggregateStats {
  return {
    from: '2026-04-21',
    to: '2026-05-21',
    n_total: 18,
    n_with_outcome: 15,
    n_winners: 10,
    win_rate: 10 / 15,
    mean_edge_pts: 6.4,
    by_signal: [
      {
        signal_type: 'e1_long_call',
        n_total: 10,
        n_with_outcome: 8,
        n_winners: 5,
        win_rate: 5 / 8,
        mean_edge_pts: 4.2,
        expected_edge_pts: 5.36,
        edge_ratio: 4.2 / 5.36,
      },
      {
        signal_type: 'e5_long_put',
        n_total: 5,
        n_with_outcome: 4,
        n_winners: 3,
        win_rate: 3 / 4,
        mean_edge_pts: 8.0,
        expected_edge_pts: 8.95,
        edge_ratio: 8.0 / 8.95,
      },
      {
        signal_type: 'pcs_monday',
        n_total: 3,
        n_with_outcome: 3,
        n_winners: 2,
        win_rate: 2 / 3,
        mean_edge_pts: 12.0,
        expected_edge_pts: 16.27,
        edge_ratio: 12.0 / 16.27,
      },
    ],
    ...overrides,
  };
}

function mockResponse(stats: AggregateStats) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(stats), { status: 200 }),
  );
}

describe('RollingStatsBar', () => {
  it('renders fire count + win rate + mean edge after fetch resolves', async () => {
    mockResponse(makeStats());
    render(<RollingStatsBar marketOpen />);
    expect(await screen.findByText('18 fires')).toBeDefined();
    expect(screen.getByText(/67% win/)).toBeDefined();
    expect(screen.getByText(/\+6\.4 pts mean/)).toBeDefined();
  });

  it('shows window buttons and highlights the active one', () => {
    mockResponse(makeStats());
    render(<RollingStatsBar marketOpen />);
    expect(screen.getByRole('button', { name: '7d' })).toBeDefined();
    expect(screen.getByRole('button', { name: '14d' })).toBeDefined();
    const thirty = screen.getByRole('button', { name: '30d' });
    expect(thirty.getAttribute('aria-pressed')).toBe('true');
  });

  it('changes window when a button is clicked and re-fetches', async () => {
    mockResponse(makeStats());
    render(<RollingStatsBar marketOpen />);
    // Wait for the initial fetch to settle so the next click triggers a
    // new request rather than racing the mount-fetch.
    await screen.findByText('18 fires');
    mockResponse(makeStats({ n_total: 4 }));
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await waitFor(() => expect(screen.getByText('4 fires')).toBeDefined());
    expect(
      screen.getByRole('button', { name: '7d' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('falls back to em-dashes when win rate / mean edge are null', async () => {
    mockResponse(
      makeStats({ win_rate: null, mean_edge_pts: null, n_with_outcome: 0 }),
    );
    render(<RollingStatsBar marketOpen />);
    expect(await screen.findByText(/— win/)).toBeDefined();
    expect(screen.getByText(/— pts mean/)).toBeDefined();
  });

  it('exposes a CSV export link with the current window', async () => {
    mockResponse(makeStats({ from: '2026-04-21', to: '2026-05-21' }));
    render(<RollingStatsBar marketOpen />);
    const link = (await screen.findByText('export csv')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('from=2026-04-21');
    expect(link.getAttribute('href')).toContain('to=2026-05-21');
    expect(link.getAttribute('href')).toContain('format=csv');
  });

  describe('hover text for screen readers', () => {
    it('gives the stats error its message as a hint, keeping the title', async () => {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
      const { container } = render(<RollingStatsBar marketOpen />);
      const badge = await screen.findByText('stats error');
      expect(srHintText(badge)).toBe('fetch failed: 500');
      expect(badge).toHaveAttribute('title', 'fetch failed: 500');
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it('hints a request that threw, with the thrown message', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      render(<RollingStatsBar marketOpen />);
      const badge = await screen.findByText('stats error');
      expect(srHintText(badge)).toBe('network down');
      expect(badge).toHaveAttribute('title', 'network down');
    });

    it('says how many fires still await their +30m backfill', async () => {
      mockResponse(makeStats({ n_total: 18, n_with_outcome: 15 }));
      const { container } = render(<RollingStatsBar marketOpen />);
      const note = await screen.findByText('(15 outcomes)');
      expect(srHintText(note)).toBe('3 fires still awaiting +30m backfill');
      expect(note).toHaveAttribute(
        'title',
        '3 fires still awaiting +30m backfill',
      );
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });

    it('uses the singular for one fire awaiting its backfill', async () => {
      mockResponse(makeStats({ n_total: 18, n_with_outcome: 17 }));
      render(<RollingStatsBar marketOpen />);
      const note = await screen.findByText('(17 outcomes)');
      expect(srHintText(note)).toBe('1 fire still awaiting +30m backfill');
      expect(note).toHaveAttribute(
        'title',
        '1 fire still awaiting +30m backfill',
      );
    });

    it('says all outcomes are resolved when none are pending', async () => {
      mockResponse(makeStats({ n_total: 18, n_with_outcome: 18 }));
      const { container } = render(<RollingStatsBar marketOpen />);
      const note = await screen.findByText('(18 outcomes)');
      expect(srHintText(note)).toBe('all resolved');
      expect(note).toHaveAttribute('title', 'All outcomes resolved');
      expect(titledGenericsWithoutHint(container)).toEqual([]);
    });
  });
});
