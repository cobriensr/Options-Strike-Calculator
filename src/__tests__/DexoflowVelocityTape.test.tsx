import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DexoflowVelocityTape } from '../components/Gexbot/DexoflowVelocityTape';
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
    spot: 5985,
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

describe('<DexoflowVelocityTape>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('shows empty-state when no rows have flow data', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({
          ticker: 'SPX',
          dexoflow: null,
          gexoflow: null,
          cvroflow: null,
        }),
      ],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-empty')).toBeInTheDocument();
  });

  it('shows loading placeholder', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-loading')).toBeInTheDocument();
  });

  it('shows error when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<DexoflowVelocityTape marketOpen />);
    expect(screen.getByTestId('dexoflow-tape-error')).toBeInTheDocument();
  });

  it('renders rows with at least one non-null flow scalar', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({
          ticker: 'SPX',
          dexoflow: 1234.5,
          gexoflow: -340,
          cvroflow: 0.04,
        }),
        makeRow({
          ticker: 'QQQ',
          dexoflow: null,
          gexoflow: null,
          cvroflow: null,
        }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<DexoflowVelocityTape marketOpen />);
    const tape = screen.getByTestId('dexoflow-tape');
    const rows = tape.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveTextContent('SPX');
  });

  it('formats large values with K/M suffixes and proper sign glyph', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({
          ticker: 'SPX',
          dexoflow: 1_500_000,
          gexoflow: -2_500,
          cvroflow: 0.04,
        }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    const tape = container.querySelector('[data-testid="dexoflow-tape"]')!;
    expect(tape).toHaveTextContent(/\+1\.50M/);
    expect(tape).toHaveTextContent(/−2\.50K/);
    expect(tape).toHaveTextContent(/\+0\.04/);
  });

  it('uses emerald for positive, rose for negative, tertiary for null', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({
          ticker: 'SPX',
          dexoflow: 100,
          gexoflow: -100,
          cvroflow: null,
        }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    const { container } = render(<DexoflowVelocityTape marketOpen />);
    expect(container.querySelector('.text-emerald-300')).not.toBeNull();
    expect(container.querySelector('.text-rose-300')).not.toBeNull();
  });

  it('sorts rows by combined dex+gex flow magnitude desc', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeRow({
          ticker: 'SPY',
          dexoflow: 100,
          gexoflow: 50,
          cvroflow: 0.01,
        }),
        makeRow({
          ticker: 'SPX',
          dexoflow: -1_500_000,
          gexoflow: 200,
          cvroflow: 0.01,
        }),
        makeRow({
          ticker: 'QQQ',
          dexoflow: 500,
          gexoflow: -1_000,
          cvroflow: 0.01,
        }),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T14:00:00Z',
    });
    render(<DexoflowVelocityTape marketOpen />);
    const tickerCells = screen.getAllByRole('row').slice(1);
    // Magnitudes: SPX 1500200 > QQQ 1500 > SPY 150
    expect(tickerCells[0]).toHaveTextContent('SPX');
    expect(tickerCells[1]).toHaveTextContent('QQQ');
    expect(tickerCells[2]).toHaveTextContent('SPY');
  });
});
