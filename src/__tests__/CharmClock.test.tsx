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
    expect(screen.getByText(/\+\$47\.0M/)).toBeInTheDocument();
  });

  it('formats negative drift in rose color tone', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow({ ticker: 'SPX', spot: 5985, zcharm: -10_000_000 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    const { container } = render(<CharmClock marketOpen />);
    const driftCell = container.querySelector('td.text-rose-300');
    expect(driftCell).not.toBeNull();
  });

  it('sorts rows by absolute projected drift descending', () => {
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
    // |projected drift| = |zcharm × (hours / 6.5) / (spot × 1e9)|
    // QQQ ≈ 15e6 / 540 / 1e9  ≈ 2.78e-8
    // SPX ≈ 47e6 / 5985 / 1e9 ≈ 7.85e-9
    // SPY ≈ 3e6  / 596 / 1e9  ≈ 5.03e-9
    // Order (largest first): QQQ, SPX, SPY
    expect(tickerCells[0]).toHaveTextContent('QQQ');
    expect(tickerCells[1]).toHaveTextContent('SPX');
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
