import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ConvexityMatrix } from '../components/Gexbot/ConvexityMatrix';
import type { ConvexityTrendRow } from '../hooks/useGexbotData';

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

function makeTrend(
  ticker: string,
  values: number[],
  minDte: number | null = 0,
): ConvexityTrendRow {
  return {
    ticker,
    minDte,
    series: values.map(
      (v, i) =>
        [new Date(2026, 4, 19, 9, 30 + i).toISOString(), v] as [string, number],
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

  it('renders the 14 underlying cells in fixed order, even with partial data', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [1.0, 1.1, 1.2])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    // The 14 underlyings are present; the futures views of SPX/NDX are not.
    const tickers = [
      'SPX',
      'NDX',
      'RUT',
      'VIX',
      'SPY',
      'QQQ',
      'IWM',
      'TLT',
      'GLD',
      'USO',
      'TQQQ',
      'UVXY',
      'HYG',
      'SLV',
    ];
    for (const t of tickers) {
      expect(screen.getByTestId(`convexity-cell-${t}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId('convexity-cell-ES_SPX')).toBeNull();
    expect(screen.queryByTestId('convexity-cell-NQ_NDX')).toBeNull();
  });

  it('splits at zero: positive net convexity is net option buying (emerald)', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [100, 300, 500])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell.className).toMatch(/emerald/);
    expect(cell).toHaveAttribute('title', expect.stringContaining('buying'));
    expect(cell).toHaveTextContent('+500');
  });

  it('negative net convexity is net option selling (rose), not "put-heavy" at -1,310', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [-900, -1100, -1310])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell.className).toMatch(/rose/);
    expect(cell).toHaveAttribute('title', expect.stringContaining('selling'));
    expect(cell).toHaveTextContent('−1,310');
  });

  it('does not read small positive values as a 1.0-centred ratio', () => {
    // Under the old ratio reading 0.9 was "balanced"; now it is simply > 0.
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [0.9, 0.9])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    expect(screen.getByTestId('convexity-cell-SPX').className).toMatch(
      /emerald/,
    );
  });

  it('is neutral at exactly zero', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [5, 0])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cls = screen.getByTestId('convexity-cell-SPX').className;
    expect(cls).not.toMatch(/emerald/);
    expect(cls).not.toMatch(/rose/);
  });

  describe('intensity vs the ticker typical size (median |zcvr|)', () => {
    const flat = (v: number, n = 12) => Array.from({ length: n }, () => v);
    const intensityOf = (ticker: string): string | undefined =>
      screen.getByTestId(`convexity-cell-${ticker}`).dataset.intensity;

    it('scales per ticker: same shape, different magnitude, same band', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [
          makeTrend('SPX', [...flat(-1000), -2500]),
          makeTrend('UVXY', [...flat(-10), -25]),
          makeTrend('TLT', [...flat(-10), -12]),
          makeTrend('GLD', [...flat(-10), -5]),
        ],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T14:00:00Z',
      });
      render(<ConvexityMatrix marketOpen />);
      expect(intensityOf('SPX')).toBe('strong'); // 2.5x typical
      expect(intensityOf('UVXY')).toBe('strong'); // 2.5x typical
      expect(intensityOf('TLT')).toBe('medium'); // 1.2x typical
      expect(intensityOf('GLD')).toBe('faint'); // 0.5x typical
    });

    it('does not paint a normal reading strong (SPX flat at -1,310)', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [makeTrend('SPX', flat(-1310, 20))],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T14:00:00Z',
      });
      render(<ConvexityMatrix marketOpen />);
      expect(intensityOf('SPX')).toBe('medium');
    });

    it('stays faint with fewer than 10 samples, incl. a one-point series', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [
          makeTrend('SPX', [-1310]),
          makeTrend('QQQ', flat(-500, 9)),
          makeTrend('IWM', [...flat(-10, 9), -500]),
        ],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T14:00:00Z',
      });
      render(<ConvexityMatrix marketOpen />);
      expect(intensityOf('SPX')).toBe('faint');
      expect(intensityOf('QQQ')).toBe('faint');
      expect(intensityOf('IWM')).toBe('strong');
    });

    it('stays faint when the typical size is zero', () => {
      mockUseGexbotData.mockReturnValue({
        rows: [makeTrend('SPX', [...flat(0), 50])],
        loading: false,
        error: null,
        freshestAt: '2026-05-19T14:00:00Z',
      });
      render(<ConvexityMatrix marketOpen />);
      expect(intensityOf('SPX')).toBe('faint');
    });
  });

  it('exposes the cell details to assistive tech via aria-label', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [-1310], 0)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const cell = screen.getByTestId('convexity-cell-SPX');
    expect(cell).toHaveAttribute('aria-label', cell.getAttribute('title'));
    expect(cell).toHaveAttribute(
      'aria-label',
      expect.stringContaining('net option selling'),
    );
  });

  it('legend says shade is vs typical and never bullish/bearish', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [-1310])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const root = screen.getByTestId('convexity-matrix');
    expect(root).toHaveTextContent(/typical in the last hour/i);
    expect(root).not.toHaveTextContent(/bullish|bearish/i);
  });

  it('names the quantity "net convexity (zcvr)" in the legend', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('SPX', [-1310])],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    const root = screen.getByTestId('convexity-matrix');
    expect(root).toHaveTextContent(/net convexity \(zcvr\)/i);
    expect(root).toHaveTextContent(/net option buying/i);
    expect(root).toHaveTextContent(/net option selling/i);
    expect(root).not.toHaveTextContent(/call-heavy|put-heavy|0DTE zcvr/i);
  });

  it('labels each cell with the ticker nearest-expiry DTE from min_dte', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeTrend('HYG', [-5, -6], 2), makeTrend('SPX', [1, 2], 0)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<ConvexityMatrix marketOpen />);
    expect(screen.getByTestId('convexity-dte-HYG')).toHaveTextContent('2DTE');
    expect(screen.getByTestId('convexity-dte-SPX')).toHaveTextContent('0DTE');
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
    expect(cell).toHaveTextContent('+1.35');
  });
});
