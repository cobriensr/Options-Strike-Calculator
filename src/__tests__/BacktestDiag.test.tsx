import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BacktestDiag from '../components/BacktestDiag';
import type {
  HistorySnapshot,
  UseHistoryDataReturn,
} from '../hooks/useHistoryData';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<HistorySnapshot> = {},
): HistorySnapshot {
  return {
    spot: 5800.25,
    spy: 580.03,
    runningOHLC: { open: 5790.0, high: 5810.5, low: 5785.0, last: 5800.25 },
    openingRange: { high: 5810, low: 5785, rangePts: 25.0, complete: true },
    yesterday: {
      date: '2026-03-11',
      open: 5780,
      high: 5820,
      low: 5770,
      close: 5795,
      rangePct: 0.86,
      rangePts: 50,
    },
    vix: 18.45,
    vixPrevClose: 17.8,
    vix1d: 14.2,
    vix9d: 16.3,
    vvix: 92.5,
    previousClose: 5795.0,
    candle: {
      datetime: 1741795200000,
      time: '10:30',
      open: 5798,
      high: 5802,
      low: 5796,
      close: 5800.25,
    },
    candleIndex: 12,
    totalCandles: 78,
    ...overrides,
  };
}

function makeHistory(
  overrides: Partial<UseHistoryDataReturn> = {},
): UseHistoryDataReturn {
  return {
    history: {
      date: '2026-03-12',
      spx: {} as any,
      vix: {} as any,
      vix1d: {} as any,
      vix9d: {} as any,
      vvix: {} as any,
      candleCount: 78,
      asOf: '2026-03-12T16:00:00Z',
    },
    loading: false,
    error: null,
    getStateAtTime: () => null,
    hasHistory: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BacktestDiag', () => {
  it('renders nothing when snapshot is null', () => {
    const { container } = render(
      <BacktestDiag snapshot={null} history={makeHistory()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the diagnostic overlay when snapshot is provided', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('Backtest Diagnostic')).toBeInTheDocument();
  });

  it('displays core snapshot values', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);

    expect(screen.getByText('5800.25')).toBeInTheDocument(); // SPX Spot
    expect(screen.getByText('580.03')).toBeInTheDocument(); // SPY
    expect(screen.getByText('18.45')).toBeInTheDocument(); // VIX
    expect(screen.getByText('17.80')).toBeInTheDocument(); // VIX prevClose
    expect(screen.getByText('14.20')).toBeInTheDocument(); // VIX1D
    expect(screen.getByText('16.30')).toBeInTheDocument(); // VIX9D
    expect(screen.getByText('92.50')).toBeInTheDocument(); // VVIX
  });

  it('displays candle info with index', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('10:30 (13/78)')).toBeInTheDocument();
  });

  it('displays OHLC and previous close', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);

    expect(screen.getByText('5790.00')).toBeInTheDocument(); // SPX Open
    expect(screen.getByText('5810.50')).toBeInTheDocument(); // SPX Hi
    expect(screen.getByText('5785.00')).toBeInTheDocument(); // SPX Lo
    expect(screen.getByText('5795.00')).toBeInTheDocument(); // Prev Close
  });

  it('calculates gap percentage correctly', () => {
    // gap = (open - prevClose) / prevClose * 100
    // (5790 - 5795) / 5795 * 100 ≈ -0.09%
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('-0.09%')).toBeInTheDocument();
  });

  it('shows "—" for gap when previousClose is 0', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot({ previousClose: 0 })}
        history={makeHistory()}
      />,
    );
    // Two dashes: one from Gap row, one from date row if history is null
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('displays opening range when present', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('5785–5810 (25.0 pts)')).toBeInTheDocument();
  });

  it('shows "incomplete" when opening range is null', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot({ openingRange: null })}
        history={makeHistory()}
      />,
    );
    expect(screen.getByText('incomplete')).toBeInTheDocument();
  });

  it('displays yesterday data when present', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('2026-03-11: 0.86% range')).toBeInTheDocument();
  });

  it('shows "no data" when yesterday is null', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot({ yesterday: null })}
        history={makeHistory()}
      />,
    );
    expect(screen.getByText('no data')).toBeInTheDocument();
  });

  it('shows "no data" for null VIX fields', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot({
          vix: null,
          vixPrevClose: null,
          vix1d: null,
          vix9d: null,
          vvix: null,
        })}
        history={makeHistory()}
      />,
    );
    const noDataCells = screen.getAllByText('no data');
    expect(noDataCells).toHaveLength(5);
  });

  it('displays the date from history', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.getByText('2026-03-12')).toBeInTheDocument();
  });

  it('shows "—" for date when history is null', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot()}
        history={makeHistory({ history: null })}
      />,
    );
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('shows error message when history has an error', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot()}
        history={makeHistory({ error: 'Network timeout' })}
      />,
    );
    expect(screen.getByText('Error: Network timeout')).toBeInTheDocument();
  });

  it('does not show error div when there is no error', () => {
    render(<BacktestDiag snapshot={makeSnapshot()} history={makeHistory()} />);
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('styles "no data" values in red', () => {
    render(
      <BacktestDiag
        snapshot={makeSnapshot({ vix: null })}
        history={makeHistory()}
      />,
    );
    const noDataCell = screen.getAllByText('no data')[0]!;
    expect(noDataCell).toHaveStyle({ color: '#f44' });
  });
});
