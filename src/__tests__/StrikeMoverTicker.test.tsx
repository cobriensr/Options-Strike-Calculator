import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { StrikeMoverTicker } from '../components/Gexbot/StrikeMoverTicker';
import type { MaxchangeWinnerRow } from '../hooks/useGexbotData';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/useGexbotData')>(
      '../hooks/useGexbotData',
    );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

function makeRow(
  ticker: string,
  category: string,
  windows: Partial<MaxchangeWinnerRow['windows']> = {},
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint: category.startsWith('gex_') ? 'classic' : 'state',
    category,
    capturedAt: '2026-05-19T14:00:00Z',
    windows: {
      current: null,
      one: null,
      five: null,
      ten: null,
      fifteen: null,
      thirty: null,
      ...windows,
    },
  };
}

describe('<StrikeMoverTicker>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows empty-state when no rows have a 5-min window', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPX', 'gex_zero/maxchange', { current: [5950, 1.2] })],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverTicker marketOpen />);
    expect(screen.getByTestId('strike-mover-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverTicker marketOpen />);
    expect(screen.getByTestId('strike-mover-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<StrikeMoverTicker marketOpen />);
    expect(screen.getByTestId('strike-mover-error')).toBeInTheDocument();
  });

  it('renders one chip per row with a 5-min window, sorted by |change| desc', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', 'gex_zero/maxchange', { five: [5950, 50_000] }),
        makeRow('QQQ', 'gamma_zero/maxchange', { five: [535, 1_500_000] }),
        makeRow('SPY', 'gex_full/maxchange', { five: [615, -800_000] }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<StrikeMoverTicker marketOpen />);
    const chips = screen.getAllByTestId(/^strike-mover-chip-/);
    expect(chips.length).toBe(3);
    // Order: QQQ (1.5M abs) > SPY (800K abs) > SPX (50K abs)
    expect(chips[0]).toHaveTextContent('QQQ');
    expect(chips[1]).toHaveTextContent('SPY');
    expect(chips[2]).toHaveTextContent('SPX');
  });

  it('applies emerald to positive change and rose to negative', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', 'gex_zero/maxchange', { five: [5950, 50_000] }),
        makeRow('QQQ', 'gex_zero/maxchange', { five: [535, -50_000] }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<StrikeMoverTicker marketOpen />);
    const spx = screen.getByTestId(
      'strike-mover-chip-SPX-gex_zero/maxchange',
    );
    const qqq = screen.getByTestId(
      'strike-mover-chip-QQQ-gex_zero/maxchange',
    );
    expect(spx.className).toMatch(/emerald/);
    expect(qqq.className).toMatch(/rose/);
  });

  it('formats large changes with K/M suffixes', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', 'gex_zero/maxchange', { five: [5950, 1_500_000] }),
        makeRow('QQQ', 'gex_zero/maxchange', { five: [535, -2_500] }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<StrikeMoverTicker marketOpen />);
    expect(container).toHaveTextContent(/\+1\.5M/);
    expect(container).toHaveTextContent(/−2\.5K/);
  });

  it('caps the chip count at MAX_CHIPS (30)', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      makeRow(`T${i}`, 'gex_zero/maxchange', { five: [100 + i, i * 10] }),
    );
    mockUseGexbotData.mockReturnValue({
      rows: many,
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<StrikeMoverTicker marketOpen />);
    const chips = screen.getAllByTestId(/^strike-mover-chip-/);
    expect(chips.length).toBe(30);
  });

  it('translates raw categories to trader-friendly short labels', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', 'gamma_zero/maxchange', { five: [5950, 10_000] }),
        makeRow('SPX', 'charm_zero/maxchange', { five: [5950, 5_000] }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<StrikeMoverTicker marketOpen />);
    expect(screen.getByText('γ-0DTE')).toBeInTheDocument();
    expect(screen.getByText('CH-0DTE')).toBeInTheDocument();
  });
});
