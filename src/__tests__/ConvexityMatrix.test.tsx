import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ConvexityMatrix } from '../components/Gexbot/ConvexityMatrix';
import type { ConvexityTrendRow } from '../hooks/useGexbotData';

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

function makeTrend(
  ticker: string,
  values: number[],
): ConvexityTrendRow {
  return {
    ticker,
    series: values.map(
      (v, i) =>
        [
          new Date(2026, 4, 19, 9, 30 + i).toISOString(),
          v,
        ] as [string, number],
    ),
  };
}

describe('<ConvexityMatrix>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows empty-state when no tickers have data', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<ConvexityMatrix marketOpen />);
    expect(screen.getByTestId('convexity-matrix-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<ConvexityMatrix marketOpen />);
    expect(screen.getByTestId('convexity-matrix-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<ConvexityMatrix marketOpen />);
    expect(screen.getByTestId('convexity-matrix-error')).toBeInTheDocument();
  });

  it('renders all 16 cells in fixed order, even with partial data', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [1.0, 1.1, 1.2])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    // All 16 tickers should be present as cells.
    const tickers = [
      'SPX', 'ES_SPX', 'NDX', 'NQ_NDX', 'RUT', 'VIX',
      'SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'USO',
      'TQQQ', 'UVXY', 'HYG', 'SLV',
    ];
    for (const t of tickers) {
      expect(screen.getByTestId(`convexity-cell-${t}`)).toBeInTheDocument();
    }
  });

  it('applies emerald tone to call-heavy cells (zcvr ≥ 1.2)', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [1.0, 1.1, 1.3])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell.className).toMatch(/emerald/);
  });

  it('applies rose tone to put-heavy cells (zcvr ≤ 0.8)', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [1.0, 0.9, 0.7])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell.className).toMatch(/rose/);
  });

  it('shows em-dash for tickers with no data', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [1.0, 1.1])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const vixCell = screen.getByTestId('convexity-cell-VIX');
    expect(vixCell).toHaveTextContent('—');
  });

  it('shows the latest zcvr value as the cell number', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [0.9, 1.1, 1.35])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell).toHaveTextContent('1.35');
  });
});
