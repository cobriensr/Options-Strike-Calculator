/**
 * PeriscopeLotteryPanel — dual-column UI for Periscope-derived 0DTE
 * lottery fires. Mocks usePeriscopeLotteryFeed and asserts the
 * sectioning, empty states, badge rendering, and outcome pill.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PeriscopeLotteryPanel } from './PeriscopeLotteryPanel';
import type { PeriscopeLotteryFire } from './types';

const mockFeed = vi.fn();
vi.mock('../../hooks/usePeriscopeLotteryFeed.js', () => ({
  usePeriscopeLotteryFeed: () => mockFeed(),
}));

beforeEach(() => {
  mockFeed.mockReset();
});

function baseFire(
  overrides: Partial<PeriscopeLotteryFire>,
): PeriscopeLotteryFire {
  return {
    id: 1,
    fireType: 'call_lottery',
    fireTime: '2026-05-18T18:43:12Z',
    expiry: '2026-05-18',
    eventStrike: 7380,
    tradeStrike: 7430,
    spotAtEvent: 7362.14,
    strikeDist: 17.86,
    greekPost: -7403.4,
    greekDelta: -4513.3,
    greekLvlRank: 0.95,
    greekChgRank: 0.999,
    gexDollars: -974008661,
    callRatio: -3.58,
    qqqNetPremBalance30m: 0.6,
    entryPx: 0.1,
    vix: 18.31,
    v3StrictPass: true,
    v4Badge: true,
    peakPx: 25,
    peakPct: 250,
    peakTime: '2026-05-18T19:01:47Z',
    eodClosePx: 0.05,
    realizedRPeak: 249,
    realizedREod: -0.5,
    outcomeLocked: true,
    createdAt: '2026-05-18T18:43:50Z',
    ...overrides,
  };
}

describe('PeriscopeLotteryPanel', () => {
  it('renders both columns with empty-state messages when no fires', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: null,
      fetchedAt: null,
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={false} />);

    expect(screen.getByText('Call Lottery')).toBeInTheDocument();
    expect(screen.getByText('Put Lottery')).toBeInTheDocument();
    const emptyMsgs = screen.getAllByText(/No fires today yet/);
    expect(emptyMsgs).toHaveLength(2);
  });

  it('splits fires between columns by fireType', () => {
    const callFire = baseFire({
      id: 1,
      fireType: 'call_lottery',
      tradeStrike: 7430,
    });
    const putFire = baseFire({
      id: 2,
      fireType: 'put_lottery',
      tradeStrike: 7055,
      eventStrike: 7100,
      strikeDist: 12.5,
      greekPost: 5500,
      greekDelta: 3200,
      qqqNetPremBalance30m: null,
      entryPx: 0.42,
      v3StrictPass: true,
      v4Badge: false,
      peakPct: 80,
      realizedRPeak: 0.9,
    });
    mockFeed.mockReturnValue({
      fires: [callFire, putFire],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);

    const callCol = screen.getByLabelText('Call Lottery');
    const putCol = screen.getByLabelText('Put Lottery');
    expect(within(callCol).getByText('7430C')).toBeInTheDocument();
    expect(within(putCol).getByText('7055P')).toBeInTheDocument();
    // Each column shows exactly one row
    expect(
      within(callCol).getAllByTestId('periscope-lottery-row'),
    ).toHaveLength(1);
    expect(within(putCol).getAllByTestId('periscope-lottery-row')).toHaveLength(
      1,
    );
  });

  it('renders V4 badge over V3 when v4Badge=true', () => {
    mockFeed.mockReturnValue({
      fires: [baseFire({ v3StrictPass: true, v4Badge: true })],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByText('V4')).toBeInTheDocument();
    expect(screen.queryByText('V3')).not.toBeInTheDocument();
  });

  it('renders V3 badge when only v3StrictPass is true', () => {
    mockFeed.mockReturnValue({
      fires: [baseFire({ v3StrictPass: true, v4Badge: false })],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByText('V3')).toBeInTheDocument();
    expect(screen.queryByText('V4')).not.toBeInTheDocument();
  });

  it('renders outcome pill with peak% and EOD R when locked', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          outcomeLocked: true,
          peakPct: 250,
          realizedRPeak: 249,
          realizedREod: -0.5,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    // peak 250% · eod -0.50R
    expect(screen.getByText(/peak 250%/)).toBeInTheDocument();
    expect(screen.getByText(/-0.50R/)).toBeInTheDocument();
  });

  it('omits outcome pill when outcome not yet locked', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({ outcomeLocked: false, peakPct: null, realizedRPeak: null }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.queryByText(/peak/i)).not.toBeInTheDocument();
  });

  it('surfaces hook error with role=alert', () => {
    mockFeed.mockReturnValue({
      fires: [],
      loading: false,
      error: 'HTTP 500',
      fetchedAt: null,
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });

  it('links the strike label to the UW chain page for SPXW 0DTE', () => {
    mockFeed.mockReturnValue({
      fires: [
        baseFire({
          fireType: 'call_lottery',
          expiry: '2026-05-18',
          tradeStrike: 7430,
        }),
      ],
      loading: false,
      error: null,
      fetchedAt: Date.now(),
      refetch: vi.fn(),
    });
    render(<PeriscopeLotteryPanel marketOpen={true} />);
    const link = screen.getByRole('link', { name: '7430C' });
    // The expiry segment of OCC is YYMMDD from today() (the date the
    // panel runs on). We only assert the deterministic pieces — the
    // root + side + strike — so the test doesn't depend on the mock
    // date matching today's real date.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toMatch(
      /unusualwhales\.com\/flow\/option_chains\?chain=SPXW\d{6}C07430000/,
    );
  });
});
