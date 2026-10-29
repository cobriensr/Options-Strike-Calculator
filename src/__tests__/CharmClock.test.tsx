import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { CharmClock } from '../components/Gexbot/CharmClock';
import type { SnapshotsLatestRow } from '../hooks/useGexbotData';

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

function makeRow(overrides: Partial<SnapshotsLatestRow>): SnapshotsLatestRow {
  return {
    ticker: 'SPX',
    capturedAt: '2026-05-19T14:00:00Z',
    spot: 5985.2,
    zeroGamma: 5990,
    zMlgamma: null,
    zMsgamma: null,
    zcvr: null,
    zgr: null,
    zvanna: null,
    zcharm: null,
    oMlgamma: null,
    oMsgamma: null,
    ocvr: null,
    ogr: null,
    ovanna: null,
    ocharm: null,
    dexoflow: null,
    gexoflow: null,
    cvroflow: null,
    oneDexoflow: null,
    oneGexoflow: null,
    oneCvroflow: null,
    deltaRiskReversal: null,
    minDte: 0,
    ...overrides,
  };
}

describe('<CharmClock>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
    // Fix wall time to a mid-session moment so hours-to-close calc is
    // deterministic. 2026-05-19T17:00:00Z == 13:00 ET (DST) == 3 hours
    // before 16:00 ET close.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T17:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows empty-state when no rows have zcharm', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', zcharm: null })],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-clock-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-clock-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-clock-error')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('renders one row per ticker that has zcharm', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 }),
        makeRow({ ticker: 'SPY', spot: 596, zcharm: 12_000_000 }),
        makeRow({ ticker: 'QQQ', spot: 540, zcharm: null }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    const table = screen.getByTestId('charm-clock');
    expect(table).toHaveTextContent('SPX');
    expect(table).toHaveTextContent('SPY');
    expect(table).not.toHaveTextContent(/^QQQ/m);
  });

  it('formats zcharm as $MM per hour, not raw dollars', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 53.6 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    const row = screen.getByTestId('charm-net-SPX');
    expect(row).toHaveTextContent('+$53.6 MM/hr');
    expect(row).not.toHaveTextContent('$53.60');
  });

  it('formats large negative zcharm with separators and a minus sign', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'QQQ', spot: 540, zcharm: -15_342 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-net-QQQ')).toHaveTextContent(
      '−$15,342 MM/hr',
    );
  });

  it('keeps precision on small-magnitude charm so the value is visible', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SLV', spot: 28, zcharm: 0.85 }),
        makeRow({ ticker: 'GLD', spot: 280, zcharm: 0.004 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-net-SLV')).toHaveTextContent(
      '+$0.85 MM/hr',
    );
    expect(screen.getByTestId('charm-net-GLD')).toHaveTextContent(
      '+$0.004 MM/hr',
    );
  });

  it('describes the value as GEXBot net charm, not dealer hedging', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 53.6 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    const root = screen.getByTestId('charm-clock');
    expect(root).toHaveTextContent(/GEXBot net charm/);
    expect(root).not.toHaveTextContent(/dealer/i);
  });

  it('shows "By close" as zcharm × (hoursRemaining / 6.5) in the same unit', () => {
    // At 3h to close, session fraction = 3 / 6.5 ≈ 0.4615.
    // zcharm = 47  →  By close ≈ 21.69 (scaled rate; the math is unchanged)
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-by-close-SPX')).toHaveTextContent(
      '+$21.7 MM/hr',
    );
  });

  it('labels each ticker with its own nearest-expiry DTE from min_dte', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'HYG', spot: 80, zcharm: 1, minDte: 2 }),
        makeRow({ ticker: 'SPX', spot: 5985, zcharm: 2, minDte: 0 }),
        makeRow({ ticker: 'VIX', spot: 18, zcharm: 3, minDte: null }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-dte-HYG')).toHaveTextContent('2DTE');
    expect(screen.getByTestId('charm-dte-SPX')).toHaveTextContent('0DTE');
    expect(screen.getByTestId('charm-dte-VIX')).not.toHaveTextContent('0DTE');
    expect(screen.getByTestId('charm-clock')).not.toHaveTextContent(
      '0DTE hedge drift',
    );
  });

  it('advances the time-to-close readout every minute', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByText(/time to close: 3h 00m/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    expect(screen.getByText(/time to close: 2h 30m/)).toBeInTheDocument();
  });

  it('recomputes By close from the advanced clock', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 65 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    // 3h left: 65 × 3/6.5 = 30
    expect(screen.getByTestId('charm-by-close-SPX')).toHaveTextContent(
      '+$30.0 MM/hr',
    );
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    // 2h left: 65 × 2/6.5 = 20
    expect(screen.getByTestId('charm-by-close-SPX')).toHaveTextContent(
      '+$20.0 MM/hr',
    );
  });

  it('clears its interval on unmount', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    const { unmount } = render(<CharmClock marketOpen />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('labels EOD bias as ▲ BUYS for positive zcharm', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-bias-SPX')).toHaveTextContent(/▲\s*BUYS/);
  });

  it('labels EOD bias as ▼ SELLS for negative zcharm', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'QQQ', spot: 540, zcharm: -29_950_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-bias-QQQ')).toHaveTextContent(/▼\s*SELLS/);
  });

  it('labels EOD bias as — FLAT for zero zcharm', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'HYG', spot: 80, zcharm: 0 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByTestId('charm-bias-HYG')).toHaveTextContent(/—\s*FLAT/);
  });

  it('colors negative-bias cells in rose tone', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: -10_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    const { container } = render(<CharmClock marketOpen />);
    const roseCell = container.querySelector('td.text-rose-300');
    expect(roseCell).not.toBeNull();
  });

  it('sorts rows by absolute By-close descending', () => {
    // Session fraction is constant across rows, so |By close| ordering
    // matches |zcharm| ordering: SPX (47M) > QQQ (15M) > SPY (3M).
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'SPY', spot: 596, zcharm: 3_000_000 }),
        makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 }),
        makeRow({ ticker: 'QQQ', spot: 540, zcharm: 15_000_000 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    const tickerCells = screen.getAllByRole('row').slice(1); // skip header
    expect(tickerCells[0]).toHaveTextContent('SPX');
    expect(tickerCells[1]).toHaveTextContent('QQQ');
    expect(tickerCells[2]).toHaveTextContent('SPY');
  });

  it('shows hours-to-close in the header', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    // 17:00 UTC → 13:00 ET (DST), close at 16:00 ET → 3h 00m
    expect(screen.getByText(/time to close: 3h 00m/)).toBeInTheDocument();
  });
});
