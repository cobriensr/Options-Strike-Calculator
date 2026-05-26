import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DealerStateSummaryStrip } from '../components/Gexbot/DealerStateSummaryStrip';
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

function makeRow(
  ticker: string,
  overrides: Partial<SnapshotsLatestRow> = {},
): SnapshotsLatestRow {
  return {
    ticker,
    capturedAt: '2026-05-19T19:30:00Z',
    spot: null,
    zeroGamma: null,
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

describe('<DealerStateSummaryStrip>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows a loading chip while loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-loading'),
    ).toBeInTheDocument();
  });

  it('shows an error chip when the hook surfaces an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-error'),
    ).toHaveTextContent(/HTTP 500/);
  });

  it('shows an empty chip when there are no rows', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip-empty'),
    ).toBeInTheDocument();
  });

  it('renders all four tiles on a full payload', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', { spot: 5847, zeroGamma: 5820, dexoflow: 1_200_000 }),
        makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 }),
        makeRow('NDX', {
          spot: 19_200,
          zeroGamma: 19_100,
          dexoflow: 2_500_000,
        }),
        makeRow('NQ_NDX', {
          spot: 19_210,
          zeroGamma: 19_080,
          dexoflow: -5_000_000,
        }),
        makeRow('SPY', { spot: 584, zeroGamma: 582 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    expect(
      screen.getByTestId('dealer-state-summary-strip'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('dealer-state-strip-spx')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-state-strip-vix')).toBeInTheDocument();
    expect(
      screen.getByTestId('dealer-state-strip-breadth'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('dealer-state-strip-loudest'),
    ).toBeInTheDocument();
  });

  it('renders SPX LONG γ when spot > zeroGamma', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPX', { spot: 5847, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(tile).toHaveTextContent(/LONG γ/i);
    expect(tile.className).toMatch(/emerald/);
  });

  it('renders SPX SHORT γ when spot < zeroGamma', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPX', { spot: 5800, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(tile).toHaveTextContent(/SHORT γ/i);
    expect(tile.className).toMatch(/rose/);
  });

  it('renders VIX SHORT γ when VIX spot < zeroGamma (vol expansion regime)', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-vix');
    expect(tile).toHaveTextContent(/SHORT γ/i);
  });

  it('shows "—" in SPX tile when the SPX row is missing but VIX is present', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('VIX', { spot: 14.3, zeroGamma: 15.8 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-spx');
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });

  it('counts cross-asset breadth as long vs short majorities', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', { spot: 5847, zeroGamma: 5820 }), // long
        makeRow('NDX', { spot: 19_200, zeroGamma: 19_100 }), // long
        makeRow('SPY', { spot: 584, zeroGamma: 582 }), // long
        makeRow('VIX', { spot: 14, zeroGamma: 15 }), // short
        makeRow('IWM', { spot: 210, zeroGamma: 212 }), // short
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-breadth');
    // 3 long, 2 short, 11 unknown across 16-ticker universe.
    expect(tile).toHaveTextContent(/3 \/ 16/);
    expect(tile).toHaveTextContent(/LONG γ/i);
  });

  it('picks the ticker with the largest |dexoflow| as loudest', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow('SPX', { dexoflow: 1_200_000 }),
        makeRow('NDX', { dexoflow: 2_500_000 }),
        makeRow('NQ_NDX', { dexoflow: -5_000_000 }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-loudest');
    expect(tile).toHaveTextContent(/NQ_NDX/);
  });

  it('shows "—" in the loudest tile when no row has a dexoflow value', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeRow('SPX', { spot: 5847, zeroGamma: 5820 })],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T19:32:11Z',
    });
    render(<DealerStateSummaryStrip marketOpen />);
    const tile = screen.getByTestId('dealer-state-strip-loudest');
    expect(within(tile).getByText('—')).toBeInTheDocument();
  });
});
