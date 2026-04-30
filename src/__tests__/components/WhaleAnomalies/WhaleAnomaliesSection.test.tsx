// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WhaleAnomaly } from '../../../components/WhaleAnomalies/types';

// Mock the data hook so the section renders deterministically.
const mockUseWhaleAnomalies = vi.fn();
vi.mock('../../../hooks/useWhaleAnomalies', () => ({
  useWhaleAnomalies: (args: unknown) => mockUseWhaleAnomalies(args),
}));

import { WhaleAnomaliesSection } from '../../../components/WhaleAnomalies/WhaleAnomaliesSection';

function makeWhale(over: Partial<WhaleAnomaly> = {}): WhaleAnomaly {
  return {
    id: 1,
    ticker: 'SPXW',
    option_chain: 'SPXW260429P07150000',
    strike: 7150,
    option_type: 'put',
    expiry: '2026-04-29',
    first_ts: '2026-04-29T16:56:52Z',
    last_ts: '2026-04-29T19:33:07Z',
    detected_at: '2026-04-29T16:57:00Z',
    side: 'BID',
    ask_pct: 0.05,
    total_premium: 12_037_400,
    trade_count: 5,
    vol_oi_ratio: 10.2,
    underlying_price: 7120.12,
    moneyness: 0.0042,
    dte: 0,
    whale_type: 1,
    direction: 'bullish',
    pairing_status: 'sequential',
    source: 'eod_backfill',
    resolved_at: null,
    hit_target: null,
    pct_close_vs_strike: null,
    ...over,
  };
}

const baseHookState = {
  whales: [],
  loading: false,
  error: null,
  asOf: null,
  fetchedAt: Date.parse('2026-04-30T01:00:00Z'),
  refetch: vi.fn(),
};

describe('WhaleAnomaliesSection', () => {
  it('renders the section title', () => {
    mockUseWhaleAnomalies.mockReturnValue(baseHookState);
    render(<WhaleAnomaliesSection marketOpen={false} />);
    expect(screen.getByText('Whale Anomalies')).toBeInTheDocument();
  });

  it('renders empty-state copy when no whales are returned', () => {
    mockUseWhaleAnomalies.mockReturnValue(baseHookState);
    render(<WhaleAnomaliesSection marketOpen={false} />);
    expect(
      screen.getByText(/No whales matched the checklist/i),
    ).toBeInTheDocument();
  });

  it('renders a row for each whale', () => {
    mockUseWhaleAnomalies.mockReturnValue({
      ...baseHookState,
      whales: [
        makeWhale({ id: 1, ticker: 'SPXW' }),
        makeWhale({
          id: 2,
          ticker: 'NDXP',
          option_chain: 'NDXP260505C24500000',
          strike: 24500,
          option_type: 'call',
          whale_type: 4,
          direction: 'bullish',
          side: 'ASK',
        }),
      ],
    });
    render(<WhaleAnomaliesSection marketOpen={false} />);
    expect(screen.getByTestId('whale-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('whale-row-2')).toBeInTheDocument();
  });

  it('renders all 7 ticker tabs with counts', () => {
    mockUseWhaleAnomalies.mockReturnValue({
      ...baseHookState,
      whales: [
        makeWhale({ id: 1, ticker: 'SPXW' }),
        makeWhale({ id: 2, ticker: 'SPXW' }),
        makeWhale({ id: 3, ticker: 'NDXP' }),
      ],
    });
    render(<WhaleAnomaliesSection marketOpen={false} />);
    // "All" + 7 ticker tabs
    expect(
      screen.getByRole('button', { name: /^All\s*3/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^SPXW\s*2/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^NDXP\s*1/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^QQQ\s*0/i }),
    ).toBeInTheDocument();
  });

  it('switches tickerFilter when a ticker tab is clicked', () => {
    mockUseWhaleAnomalies.mockReturnValue({
      ...baseHookState,
      whales: [makeWhale({ id: 1, ticker: 'SPXW' })],
    });
    render(<WhaleAnomaliesSection marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^SPY\s*0/i }));
    // After click, the hook should be called again with ticker='SPY'.
    const lastCallArgs = mockUseWhaleAnomalies.mock.calls.at(-1)![0];
    expect(lastCallArgs.ticker).toBe('SPY');
  });

  it('renders an error message when the hook returns an error', () => {
    mockUseWhaleAnomalies.mockReturnValue({
      ...baseHookState,
      error: 'Bad gateway',
    });
    render(<WhaleAnomaliesSection marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Bad gateway/);
  });

  it('shows Loading message before any data arrives', () => {
    mockUseWhaleAnomalies.mockReturnValue({
      ...baseHookState,
      loading: true,
      whales: [],
      fetchedAt: null,
    });
    render(<WhaleAnomaliesSection marketOpen={false} />);
    expect(screen.getByText(/Loading whales…/i)).toBeInTheDocument();
  });

  it("renders the Live button when on today's date", () => {
    mockUseWhaleAnomalies.mockReturnValue(baseHookState);
    render(<WhaleAnomaliesSection marketOpen={true} />);
    expect(
      screen.getByRole('button', { name: /^Live$|^Latest$/ }),
    ).toBeInTheDocument();
  });
});
