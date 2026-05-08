/**
 * SilentBoomRow unit tests — pragmatic smoke + key-interaction coverage.
 *
 * The 3 data hooks (useContractTape, useNetFlowHistory, useTickerCandles)
 * are mocked so the row doesn't trigger network calls. The two child
 * charts (ContractTapeChart, TickerNetFlowChart) are stubbed because
 * their internal recharts/lightweight-charts / SVG layout isn't what
 * we're testing here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SilentBoomAlert } from '../components/SilentBoom/types';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseContractTape, mockUseNetFlowHistory, mockUseTickerCandles } =
  vi.hoisted(() => ({
    mockUseContractTape: vi.fn(),
    mockUseNetFlowHistory: vi.fn(),
    mockUseTickerCandles: vi.fn(),
  }));

vi.mock('../hooks/useContractTape', () => ({
  useContractTape: mockUseContractTape,
}));
vi.mock('../hooks/useNetFlowHistory', () => ({
  useNetFlowHistory: mockUseNetFlowHistory,
}));
vi.mock('../hooks/useTickerCandles', () => ({
  useTickerCandles: mockUseTickerCandles,
}));

// Stub the heavy chart components so the row's expand-state branch
// renders without dragging in lightweight-charts or SVG layout. Use
// data-testid markers so the expanded panel is detectable.
vi.mock('../components/LotteryFinder/ContractTapeChart', () => ({
  ContractTapeChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="contract-tape-chart" aria-label={ariaLabel} />
  ),
}));
vi.mock('../components/LotteryFinder/TickerNetFlowChart', () => ({
  TickerNetFlowChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="ticker-netflow-chart" aria-label={ariaLabel} />
  ),
}));

// Static import AFTER mocks so the mocks are registered first.
import { SilentBoomRow } from '../components/SilentBoom/SilentBoomRow';

// ── Fixture factory ───────────────────────────────────────────────────

function makeAlert(overrides: Partial<SilentBoomAlert> = {}): SilentBoomAlert {
  return {
    id: 1,
    date: '2026-05-08',
    bucketCt: '2026-05-08T14:30:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    spikeVolume: 1500,
    baselineVolume: 100,
    spikeRatio: 15,
    askPct: 0.75,
    volOi: 0.45,
    entryPrice: 1.5,
    openInterest: 5000,
    score: 12,
    scoreTier: 'tier2',
    mktTideDiff: 1500,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    outcomes: {
      peakCeilingPct: 47,
      minutesToPeak: 12,
      realized30mPct: null,
      realized60mPct: 22.5,
      realized120mPct: null,
      realizedEodPct: -10,
      enrichedAt: '2026-05-08T20:00:00Z',
    },
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

const defaultHookState = {
  loading: false,
  error: null,
  fetchedAt: null,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseContractTape.mockReturnValue({ ...defaultHookState, series: [] });
  mockUseNetFlowHistory.mockReturnValue({ ...defaultHookState, series: [] });
  mockUseTickerCandles.mockReturnValue({
    ...defaultHookState,
    candles: [],
    previousClose: null,
  });
});

// ============================================================
// SMOKE
// ============================================================

describe('SilentBoomRow: smoke', () => {
  it('renders ticker, strike, and option type for a basic alert', () => {
    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // Option-type "C" badge.
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders the peak-ceiling percent with a plus sign for positive returns', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({
          outcomes: {
            peakCeilingPct: 47,
            minutesToPeak: 12,
            realized30mPct: null,
            realized60mPct: 22.5,
            realized120mPct: null,
            realizedEodPct: -10,
            enrichedAt: '2026-05-08T20:00:00Z',
          },
        })}
        marketOpen={false}
      />,
    );
    expect(screen.getByText('+47.0%')).toBeInTheDocument();
    // Realized 60m line includes the prefix "60m".
    expect(screen.getByText(/60m \+22\.5%/)).toBeInTheDocument();
  });

  it('renders the UW contract link with the correct href', () => {
    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);
    // The link's accessible name is the concatenation of its child
    // text nodes (ticker, strike, type letter, expiry chip). Match on
    // the title attribute directly via getAllByRole + filter on title.
    const link = screen
      .getAllByRole('link')
      .find(
        (el) =>
          el.getAttribute('title') ===
          'Open AAPL260508C00200000 on Unusual Whales',
      );
    expect(link).toBeDefined();
    expect(link).toHaveAttribute(
      'href',
      'https://unusualwhales.com/flow/option_chains?chain=AAPL260508C00200000',
    );
  });
});

// ============================================================
// EM-DASH FALLBACKS — null outcomes
// ============================================================

describe('SilentBoomRow: null outcomes', () => {
  it('renders em-dashes when peak / realized / eod are all null (pending enrich)', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({
          outcomes: {
            peakCeilingPct: null,
            minutesToPeak: null,
            realized30mPct: null,
            realized60mPct: null,
            realized120mPct: null,
            realizedEodPct: null,
            enrichedAt: null,
          },
        })}
        marketOpen={false}
      />,
    );
    // At least one em-dash present in the realized/peak block.
    expect(screen.getAllByText(/—/).length).toBeGreaterThan(0);
    expect(screen.getByText('pending enrich')).toBeInTheDocument();
  });
});

// ============================================================
// TIER + BURST + TIDE BADGES
// ============================================================

describe('SilentBoomRow: badges', () => {
  it('renders the Tier 1 emoji badge for tier1 alerts', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({ scoreTier: 'tier1', score: 22 })}
        marketOpen={false}
      />,
    );
    expect(screen.getByText('🔥🔥🔥')).toBeInTheDocument();
  });

  it('renders the Tier 3 single-flame badge for tier3 alerts', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({ scoreTier: 'tier3', score: 5 })}
        marketOpen={false}
      />,
    );
    expect(screen.getByText('🔥')).toBeInTheDocument();
  });

  it('renders the spike-ratio "burst" badge with an integer multiplier', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({ spikeRatio: 17.7 })}
        marketOpen={false}
      />,
    );
    // 17.7 → "×18" via toFixed(0) — followed by "burst"
    expect(screen.getByText(/×18 burst/)).toBeInTheDocument();
  });

  it('omits the Tide badge when mktTideDiff is null', () => {
    render(
      <SilentBoomRow
        alert={makeAlert({ mktTideDiff: null })}
        marketOpen={false}
      />,
    );
    expect(screen.queryByText(/^Tide /)).not.toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — expand / collapse
// ============================================================

describe('SilentBoomRow: expand / collapse', () => {
  it('starts collapsed and renders neither chart panel', () => {
    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);
    expect(screen.queryByTestId('contract-tape-chart')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('ticker-netflow-chart'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /▸ expand/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('expands to render both chart panels when the expand toggle is clicked', () => {
    // Provide non-empty tape + flow data so the component renders charts
    // (instead of the inline "Loading…" branch).
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      series: [
        {
          ts: '2026-05-08T14:30:00Z',
          askVol: 100,
          bidVol: 50,
          midVol: 25,
          noSideVol: 0,
          totalVol: 175,
          avgPrice: 1.25,
          highPrice: 1.3,
          lowPrice: 1.2,
        },
      ],
    });
    mockUseNetFlowHistory.mockReturnValue({
      ...defaultHookState,
      series: [
        {
          ts: '2026-05-08T14:30:00Z',
          ncp: 100,
          ncv: 50,
          npp: 60,
          npv: 30,
          cumNcp: 100,
          cumNcv: 50,
          cumNpp: 60,
          cumNpv: 30,
        },
      ],
    });
    mockUseTickerCandles.mockReturnValue({
      ...defaultHookState,
      candles: [
        {
          ts: '2026-05-08T14:30:00Z',
          open: 200,
          high: 200.5,
          low: 199.8,
          close: 200.2,
          volume: 1_000_000,
        },
      ],
      previousClose: 199.5,
    });

    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);

    const toggle = screen.getByRole('button', { name: /▸ expand/ });
    fireEvent.click(toggle);

    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-netflow-chart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /▾ collapse/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('shows the loading text when the tape hook is loading and series is empty', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      loading: true,
      series: [],
    });
    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/Loading tape…/)).toBeInTheDocument();
  });

  it('renders the tape error message when the tape hook surfaces an error', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      error: 'HTTP 500',
      series: [],
    });
    render(<SilentBoomRow alert={makeAlert()} marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/tape error: HTTP 500/)).toBeInTheDocument();
  });
});
