import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DealerRegimeTile } from '../../components/DealerRegimeTile';
import type {
  DealerRegimeRow,
  DealerRegimeResponse,
  UseDealerRegimeReturn,
} from '../../hooks/useDealerRegime';

vi.mock('../../hooks/useDealerRegime', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useDealerRegime')
  >('../../hooks/useDealerRegime');
  return { ...actual, useDealerRegime: vi.fn() };
});

import { useDealerRegime } from '../../hooks/useDealerRegime';
const mockHook = vi.mocked(useDealerRegime);

// Pin classifier's "now" so staleness assertions stay deterministic.
const TEST_NOW = Date.parse('2026-05-04T18:00:00Z');
const FRESH_TS = '2026-05-04T17:55:00Z'; // 5 min before TEST_NOW
const STALE_TS = '2026-05-04T17:30:00Z'; // 30 min before TEST_NOW

beforeEach(() => {
  mockHook.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TEST_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

function row(
  ticker: 'SPX' | 'NDX' | 'SPY' | 'QQQ',
  overrides: Partial<DealerRegimeRow> = {},
): DealerRegimeRow {
  return {
    ticker,
    ts: FRESH_TS,
    spot: 7240,
    zeroGamma: 7180,
    confidence: 0.4,
    netGammaAtSpot: 3_500_000_000,
    ...overrides,
  };
}

function ret(rows: DealerRegimeRow[]): UseDealerRegimeReturn {
  const data: DealerRegimeResponse = {
    rows,
    asOf: '2026-05-04T18:00:00Z',
  };
  return { data, loading: false, error: null, refresh: vi.fn() };
}

describe('DealerRegimeTile', () => {
  it('renders the heading on initial mount', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /dealer regime/i }),
    ).toBeInTheDocument();
  });

  it('shows loading message before data arrives', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders an alert when fetch errors and no data exists', () => {
    mockHook.mockReturnValue({
      data: null,
      loading: false,
      error: 'Network blip',
      refresh: vi.fn(),
    });
    render(<DealerRegimeTile marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/network blip/i);
  });

  it('renders all four ticker cells on the happy path', () => {
    mockHook.mockReturnValue(
      ret([row('SPX'), row('NDX'), row('SPY'), row('QQQ')]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByTestId('dealer-regime-cell-SPX')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-regime-cell-NDX')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-regime-cell-SPY')).toBeInTheDocument();
    expect(screen.getByTestId('dealer-regime-cell-QQQ')).toBeInTheDocument();
  });

  it('classifies fresh rows with positive net γ + clear zero-gamma as long-γ', () => {
    mockHook.mockReturnValue(
      ret([
        row('SPX', {
          spot: 7240,
          zeroGamma: 7180, // 0.83% away — well outside boundary
          confidence: 0.4,
          netGammaAtSpot: 3_500_000_000,
        }),
      ]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/long-γ/);
  });

  it('classifies negative net γ rows as short-γ', () => {
    mockHook.mockReturnValue(
      ret([row('SPX', { netGammaAtSpot: -2_500_000_000 })]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/short-γ/);
  });

  it('classifies low-confidence rows as uncertain', () => {
    mockHook.mockReturnValue(ret([row('SPX', { confidence: 0.05 })]));
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/uncertain/);
  });

  it('classifies stale rows as uncertain even when other gates pass', () => {
    mockHook.mockReturnValue(ret([row('SPX', { ts: STALE_TS })]));
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/uncertain/);
  });

  it('classifies spot near zero-gamma as transition', () => {
    mockHook.mockReturnValue(
      ret([
        row('SPX', {
          spot: 7240,
          zeroGamma: 7239, // 0.014% — inside 0.3% boundary
        }),
      ]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/transition/);
  });

  it('shows uncertain placeholder cells for tickers absent from the response', () => {
    // Only SPX returned; NDX/SPY/QQQ should still render with uncertain.
    mockHook.mockReturnValue(ret([row('SPX')]));
    render(<DealerRegimeTile marketOpen={true} />);
    const ndx = screen.getByTestId('dealer-regime-cell-NDX');
    expect(ndx.textContent).toMatch(/uncertain/);
    expect(ndx.textContent).toMatch(/—/); // placeholder dash for missing values
  });

  it('formats net gamma as a signed abbreviation', () => {
    mockHook.mockReturnValue(
      ret([row('SPX', { netGammaAtSpot: 3_500_000_000 })]),
    );
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/\+3\.5B/);
  });
});
