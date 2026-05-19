import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { StrikeMoverLadder } from '../components/Gexbot/StrikeMoverLadder';
import type { MaxchangeWinnerRow } from '../hooks/useGexbotData';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useGexbotData')>(
    '../hooks/useGexbotData',
  );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

function makeWinner(
  ticker: string,
  category: string,
  strike: number,
  change: number,
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint: `/foo/${ticker}`,
    category,
    capturedAt: '2026-05-19T17:00:00Z',
    windows: {
      current: null,
      one: null,
      five: [strike, change],
      ten: null,
      fifteen: null,
      thirty: null,
    },
  };
}

describe('<StrikeMoverLadder>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('renders loading placeholder when hook is loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-loading')).toBeInTheDocument();
  });

  it('renders error tile when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-error')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('renders empty state when no SPX winners are present', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
  });

  it('shows the spot in the header when available', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750.5} />);
    expect(screen.getByText(/spot 6750\.5/)).toBeInTheDocument();
  });

  it('renders a row for each SPX winner inside the active category', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 2_050),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 1_500),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    const row = screen.getByTestId('strike-mover-ladder-row-6750');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('6750');
    expect(row).toHaveTextContent('3✓');
  });

  it('switches the active category when a tab is clicked', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('SPX', 'gamma_zero/maxchange', 6700, 800),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    // Default = GEX → shows strike 6750.
    expect(screen.getByTestId('strike-mover-ladder-row-6750')).toBeInTheDocument();
    // Switch to γ tab → shows strike 6700.
    fireEvent.click(screen.getByRole('button', { name: /^γ$/ }));
    expect(screen.getByTestId('strike-mover-ladder-row-6700')).toBeInTheDocument();
  });

  it('renders the ATM badge on a magnet row', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByText('◈ ATM')).toBeInTheDocument();
  });

  it('renders the spot divider when at least one row is present', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeWinner('SPX', 'gex_zero/maxchange', 6800, -820)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-spot-divider')).toBeInTheDocument();
  });

  it('falls back gracefully when spxSpot is null', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={null} />);
    // Empty state still renders.
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
  });
});
