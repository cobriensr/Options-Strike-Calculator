/**
 * IntervalBARow unit tests — pragmatic smoke + key-interaction coverage.
 *
 * Hooks that fetch chart data (useContractTape, useNetFlowHistory,
 * useTickerCandles) are mocked so we can drive the expanded-panel
 * branches deterministically. The two chart components are stubbed for
 * the same reason — internal recharts/lightweight-charts layout isn't
 * what we're testing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { IntervalBAFeedAlert } from '../hooks/useIntervalBAFeed';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseContractTape, mockUseNetFlowHistory, mockUseTickerCandles } =
  vi.hoisted(() => ({
    mockUseContractTape: vi.fn(),
    mockUseNetFlowHistory: vi.fn(),
    mockUseTickerCandles: vi.fn(),
  }));

vi.mock('../hooks/useContractTape', () => ({
  useContractTape: mockUseContractTape,
}));
vi.mock('../hooks/useNetFlowHistory', () => ({
  useNetFlowHistory: mockUseNetFlowHistory,
}));
vi.mock('../hooks/useTickerCandles', () => ({
  useTickerCandles: mockUseTickerCandles,
}));

vi.mock('../components/charts/ContractTapeChart', () => ({
  ContractTapeChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="contract-tape-chart" aria-label={ariaLabel} />
  ),
}));
vi.mock('../components/charts/TickerNetFlowChart', () => ({
  TickerNetFlowChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="ticker-netflow-chart" aria-label={ariaLabel} />
  ),
}));

// Static import AFTER mocks so the mocks are registered first.
import { IntervalBARow } from '../components/IntervalBAFeed/IntervalBARow';

// ── Fixture factory ───────────────────────────────────────────────────

function makeAlert(
  overrides: Partial<IntervalBAFeedAlert> = {},
): IntervalBAFeedAlert {
  return {
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
    ask_premium: 1_200_000,
    total_premium: 1_400_000,
    trade_count: 8,
    top_trade_premium: 600_000,
    top_trade_size: 1000,
    top_trade_executed_at: '2026-03-27T17:06:23.000Z',
    top_trade_is_sweep: false,
    top_trade_is_floor: false,
    underlying_price: 5795,
    confluence_tickers: [],
    severity: 'extreme',
    ...overrides,
  };
}

const defaultHookState = {
  loading: false,
  error: null,
  fetchedAt: null,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseContractTape.mockReturnValue({ ...defaultHookState, series: [] });
  mockUseNetFlowHistory.mockReturnValue({ ...defaultHookState, series: [] });
  mockUseTickerCandles.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
});

function renderRow(alert: IntervalBAFeedAlert) {
  return render(
    <IntervalBARow alert={alert} date="2026-03-27" marketOpen={false} />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('IntervalBARow — summary line', () => {
  it('renders ticker, strike, CALL pill, severity, ratio + premium', () => {
    renderRow(makeAlert());
    expect(screen.getByText('SPXW')).toBeInTheDocument();
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('CALL')).toBeInTheDocument();
    expect(screen.getByText('EXTREME')).toBeInTheDocument();
    expect(screen.getByText(/86%/)).toBeInTheDocument(); // ratio.toFixed(0)
    expect(screen.getByText('$1.40M')).toBeInTheDocument(); // total premium
  });

  it('renders the PUT pill when option_type is P', () => {
    renderRow(makeAlert({ option_type: 'P', strike: 5790 }));
    expect(screen.getByText('PUT')).toBeInTheDocument();
  });

  it.each([
    ['critical' as const, 'CRITICAL'],
    ['warning' as const, 'WARNING'],
  ])('renders %s severity label', (severity, label) => {
    renderRow(makeAlert({ severity }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows ATM pill when spot is within ±0.05% of strike', () => {
    renderRow(makeAlert({ strike: 5800, underlying_price: 5800 }));
    expect(screen.getByText('ATM')).toBeInTheDocument();
  });

  it('shows ITM pill when call strike is below spot', () => {
    renderRow(makeAlert({ strike: 5700, underlying_price: 5800 }));
    expect(screen.getByText(/ITM/)).toBeInTheDocument();
  });

  it('shows ITM pill for a put with strike above spot', () => {
    renderRow(
      makeAlert({ option_type: 'P', strike: 5900, underlying_price: 5800 }),
    );
    expect(screen.getByText(/ITM/)).toBeInTheDocument();
  });

  it('hides the moneyness pill when underlying_price is missing', () => {
    renderRow(makeAlert({ underlying_price: null }));
    expect(screen.queryByText(/ATM|ITM|OTM/)).not.toBeInTheDocument();
  });

  it('renders the +PARTNER pill (alphabetically sorted) when confluence_tickers is populated', () => {
    renderRow(makeAlert({ confluence_tickers: ['SPY', 'QQQ'] }));
    expect(screen.getByText('+QQQ +SPY')).toBeInTheDocument();
  });

  it('omits the confluence pill when the array is empty', () => {
    renderRow(makeAlert({ confluence_tickers: [] }));
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });

  it('renders sweep + floor flag tail when both top_trade flags are true', () => {
    renderRow(
      makeAlert({ top_trade_is_sweep: true, top_trade_is_floor: true }),
    );
    expect(screen.getByText(/sweep/)).toBeInTheDocument();
    expect(screen.getByText(/floor/)).toBeInTheDocument();
  });

  it('renders only "top" when no flags are set', () => {
    const { container } = renderRow(
      makeAlert({ top_trade_is_sweep: false, top_trade_is_floor: false }),
    );
    expect(container.textContent).toContain('top');
    expect(container.textContent).not.toContain('sweep');
    expect(container.textContent).not.toContain('floor');
  });

  it('renders the underlying spot block', () => {
    renderRow(makeAlert({ underlying_price: 5795 }));
    expect(screen.getByText('5795')).toBeInTheDocument();
    expect(screen.getByText('spx')).toBeInTheDocument();
  });

  it('omits the underlying spot block when missing', () => {
    renderRow(makeAlert({ underlying_price: null }));
    expect(screen.queryByText('spx')).not.toBeInTheDocument();
  });

  it('omits the top trade block when top_trade_premium is null', () => {
    renderRow(makeAlert({ top_trade_premium: null }));
    expect(screen.queryByText('top')).not.toBeInTheDocument();
  });

  it('renders 1 trade as singular not plural', () => {
    renderRow(makeAlert({ trade_count: 1 }));
    expect(screen.getByText(/1 trade$/)).toBeInTheDocument();
  });
});

describe('IntervalBARow — UW deep link', () => {
  it('renders an external link to the per-contract Unusual Whales page', () => {
    renderRow(makeAlert({ option_chain: 'SPXW260327C05800000' }));
    const link = screen.getByLabelText(
      /Open SPXW260327C05800000 on Unusual Whales/i,
    );
    expect(link.getAttribute('href')).toContain(
      'unusualwhales.com/flow/option_chains?chain=SPXW260327C05800000',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('IntervalBARow — expand toggle', () => {
  it('starts collapsed and exposes an expand button', () => {
    renderRow(makeAlert());
    expect(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('contract-tape-chart')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('ticker-netflow-chart'),
    ).not.toBeInTheDocument();
  });

  it('renders both chart panels when expanded', () => {
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-netflow-chart')).toBeInTheDocument();
  });

  it('shows a loading hint in the tape panel while the tape series is empty + loading', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      series: [],
      loading: true,
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText(/Loading tape/i)).toBeInTheDocument();
  });

  it('surfaces a tape error message in the expanded tape panel', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      series: [],
      error: 'feed unavailable',
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(
      screen.getByText(/tape error: feed unavailable/i),
    ).toBeInTheDocument();
  });

  it('surfaces a net-flow error message in the expanded flow panel', () => {
    mockUseNetFlowHistory.mockReturnValue({
      ...defaultHookState,
      series: [],
      error: 'pg down',
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText(/net flow error: pg down/i)).toBeInTheDocument();
  });

  it('renders aggregated tape stats (bid, mid, ask, avg fill) when tape series has data', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      series: [
        {
          ts: '2026-03-27T17:00:00Z',
          bidVol: 100,
          midVol: 50,
          askVol: 800,
          noSideVol: 0,
          totalVol: 950,
          avgPrice: 2.5,
        },
        {
          ts: '2026-03-27T17:01:00Z',
          bidVol: 200,
          midVol: 100,
          askVol: 1700,
          noSideVol: 50,
          totalVol: 2050,
          avgPrice: 3.5,
        },
      ],
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText('Bid')).toBeInTheDocument();
    expect(screen.getByText('Ask')).toBeInTheDocument();
    expect(screen.getByText('Mid')).toBeInTheDocument();
    expect(screen.getByText(/Avg fill/i)).toBeInTheDocument();
  });

  it('renders cumulative NCP / NPP / Δ stats when netFlow series has data', () => {
    mockUseNetFlowHistory.mockReturnValue({
      ...defaultHookState,
      series: [
        { ts: '2026-03-27T17:00:00Z', cumNcp: 1_000_000, cumNpp: 400_000 },
      ],
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText('NCP')).toBeInTheDocument();
    expect(screen.getByText('NPP')).toBeInTheDocument();
    // Δ block uses the green tint when the difference is positive.
    expect(screen.getByText(/Δ/)).toBeInTheDocument();
  });

  it('renders the spot price from ticker candles when available in expanded mode', () => {
    mockUseTickerCandles.mockReturnValue({
      data: {
        ticker: 'SPXW',
        date: '2026-03-27',
        previousClose: 5800,
        count: 1,
        candles: [
          {
            ts: '2026-03-27T17:00:00Z',
            open: 5790,
            high: 5810,
            low: 5785,
            close: 5795.12,
            volume: 1000,
          },
        ],
        marketOpen: false,
        asOf: '2026-03-27T20:00:00Z',
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    mockUseNetFlowHistory.mockReturnValue({
      ...defaultHookState,
      series: [{ ts: '2026-03-27T17:00:00Z', cumNcp: 1, cumNpp: 0 }],
    });
    renderRow(makeAlert());
    fireEvent.click(
      screen.getByRole('button', { name: /Expand charts for SPXW/i }),
    );
    expect(screen.getByText('5795.12')).toBeInTheDocument();
    expect(screen.getByText('spot')).toBeInTheDocument();
  });
});
