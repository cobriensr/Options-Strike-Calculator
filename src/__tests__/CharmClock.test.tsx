import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
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

  it('formats positive charm with leading + and dollar+M suffix', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByText(/\+\$47\.00M/)).toBeInTheDocument();
  });

  it('formats small-magnitude charm with extra precision so the value is visible', () => {
    // GEXBot ships small zcharm values for smaller ETFs and VIX.
    // Previously formatCharm rounded everything < 50K to "$0.0M" —
    // every row collapsed to the same display and the relative
    // ordering (the actionable signal per the spec) was lost.
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({ ticker: 'VIX', spot: 18, zcharm: 4_200 }),
        makeRow({ ticker: 'SLV', spot: 28, zcharm: 0.85 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    expect(screen.getByText(/\+\$4\.20K/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$0\.85/)).toBeInTheDocument();
  });

  it('shows "By close" as zcharm × (hoursRemaining / 6.5) in the same unit', () => {
    // At 3h to close, session fraction = 3 / 6.5 ≈ 0.4615.
    // zcharm = 47M  →  By close ≈ 21.69M
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: 47_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<CharmClock marketOpen />);
    const cell = screen.getByTestId('charm-by-close-SPX');
    expect(cell).toHaveTextContent(/\+\$21\.69M/);
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
