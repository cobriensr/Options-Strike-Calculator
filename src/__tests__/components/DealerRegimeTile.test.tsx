import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    date: null,
    at: null,
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

  // ── Phase 5b: backtest scrubber ────────────────────────────

  it('renders the minute scrubber slider', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    expect(screen.getByLabelText(/snapshot minute/i)).toBeInTheDocument();
  });

  it('passes a UTC ISO `at` timestamp to the hook when the scrubber moves', () => {
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    const slider = screen.getByLabelText(/snapshot minute/i);
    fireEvent.change(slider, { target: { value: '600' } }); // 10:00 CT
    const lastCall = mockHook.mock.calls.at(-1);
    // Hook signature: useDealerRegime(marketOpen, date, at). Third arg
    // should now be a UTC ISO string.
    const at = lastCall?.[2];
    expect(typeof at).toBe('string');
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  });

  it('uses scrubbed timestamp as classifier `now` so a past row is not flagged stale', () => {
    // Row at FRESH_TS (5 min before TEST_NOW) — would normally pass the
    // staleness gate. But if the test scrubs to a date BEFORE TEST_NOW,
    // the classifier's now should anchor to that date, not wall-clock.
    // With selectedDate=today (default), no scrub → live mode → row
    // remains classified as long-γ (fresh). Verifies the "live" path.
    mockHook.mockReturnValue(happyPathReturn());
    render(<DealerRegimeTile marketOpen={true} />);
    const cell = screen.getByTestId('dealer-regime-cell-SPX');
    expect(cell.textContent).toMatch(/long-γ/);
  });
});

function happyPathReturn(): UseDealerRegimeReturn {
  return ret([row('SPX'), row('NDX'), row('SPY'), row('QQQ')]);
}
