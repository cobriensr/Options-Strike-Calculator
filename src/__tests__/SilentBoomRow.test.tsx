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
import type {
  SilentBoomAlert,
  SilentBoomExitPolicy,
} from '../components/SilentBoom/types';

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
    directionGated: false,
    mktTideDiff: 1500,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    underlyingPriceAtSpike: null,
    avgHoldMinutes: 197,
    outcomes: {
      peakCeilingPct: 47,
      minutesToPeak: 12,
      realized30mPct: null,
      realized60mPct: 22.5,
      realized120mPct: null,
      realizedEodPct: -10,
      realizedTrail3010Pct: null,
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

/**
 * Helper to render a row with a default exitPolicy. Tests that need
 * to vary the policy pass `policy=...`. Defaults to '60m' which is
 * the section's default.
 */
function renderRow(
  alert: SilentBoomAlert,
  marketOpen = false,
  policy: SilentBoomExitPolicy = 'realized60mPct',
) {
  return render(
    <SilentBoomRow alert={alert} marketOpen={marketOpen} exitPolicy={policy} />,
  );
}

// ============================================================
// SMOKE
// ============================================================

describe('SilentBoomRow: smoke', () => {
  it('renders ticker, strike, and option type for a basic alert', () => {
    renderRow(makeAlert());
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // Option-type "C" badge.
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders the +60m realized return as the primary number under the default exitPolicy', () => {
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: 47,
          minutesToPeak: 12,
          realized30mPct: null,
          realized60mPct: 22.5,
          realized120mPct: null,
          realizedEodPct: -10,
          realizedTrail3010Pct: null,
          enrichedAt: '2026-05-08T20:00:00Z',
        },
      }),
    );
    // Default exitPolicy = realized60mPct → +22.5% is the big primary
    // number with a "60m" label next to it. Peak shows as a small
    // reference chip ("peak +47.0%"). t+Nm only shows when peak is
    // primary.
    expect(screen.getByText('+22.5%')).toBeInTheDocument();
    expect(screen.getByText('60m')).toBeInTheDocument();
    expect(screen.getByText(/peak \+47\.0%/)).toBeInTheDocument();
  });

  it('renders the UW contract link with the correct href', () => {
    renderRow(makeAlert());
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
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: null,
          minutesToPeak: null,
          realized30mPct: null,
          realized60mPct: null,
          realized120mPct: null,
          realizedEodPct: null,
          realizedTrail3010Pct: null,
          enrichedAt: null,
        },
      }),
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
    renderRow(makeAlert({ scoreTier: 'tier1', score: 22 }));
    expect(screen.getByText('🔥🔥🔥')).toBeInTheDocument();
  });

  it('renders the Tier 3 single-flame badge for tier3 alerts', () => {
    renderRow(makeAlert({ scoreTier: 'tier3', score: 5 }));
    expect(screen.getByText('🔥')).toBeInTheDocument();
  });

  it('renders the spike-ratio "burst" badge with an integer multiplier', () => {
    renderRow(makeAlert({ spikeRatio: 17.7 }));
    // 17.7 → "×18" via toFixed(0) — followed by "burst"
    expect(screen.getByText(/×18 burst/)).toBeInTheDocument();
  });

  it('omits the Tide badge when mktTideDiff is null', () => {
    renderRow(makeAlert({ mktTideDiff: null }));
    expect(screen.queryByText(/^Tide /)).not.toBeInTheDocument();
  });
});

// ============================================================
// PHASE 4: DIRECTION-GATE PILL + TRAIL-30/10 ROW
// ============================================================

describe('SilentBoomRow: direction-gate pill', () => {
  it('renders the Gated pill when directionGated is true', () => {
    renderRow(makeAlert({ directionGated: true }));
    const pill = screen.getByTestId('silent-boom-gated-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('Gated');
  });

  it('does not render the Gated pill when directionGated is false', () => {
    renderRow(makeAlert({ directionGated: false }));
    expect(
      screen.queryByTestId('silent-boom-gated-pill'),
    ).not.toBeInTheDocument();
  });
});

describe('SilentBoomRow: trail-30/10 row', () => {
  it('renders trail30 with the realized value when populated', () => {
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: 80,
          minutesToPeak: 22,
          realized30mPct: 30,
          realized60mPct: 50,
          realized120mPct: 60,
          realizedEodPct: -5,
          realizedTrail3010Pct: 35.7,
          enrichedAt: '2026-05-08T20:00:00Z',
        },
      }),
    );
    const trail = screen.getByTestId('silent-boom-trail3010');
    expect(trail).toHaveTextContent('trail30 +35.7%');
  });

  it('renders trail30 with em-dash when null (legacy / pending enrich)', () => {
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: 80,
          minutesToPeak: 22,
          realized30mPct: null,
          realized60mPct: null,
          realized120mPct: null,
          realizedEodPct: null,
          realizedTrail3010Pct: null,
          enrichedAt: null,
        },
      }),
    );
    const trail = screen.getByTestId('silent-boom-trail3010');
    expect(trail).toHaveTextContent('trail30 —');
  });
});

// ============================================================
// EXIT POLICY CHIP — primary % swaps with the active policy
// ============================================================

describe('SilentBoomRow: exitPolicy', () => {
  const fixture = makeAlert({
    outcomes: {
      peakCeilingPct: 80,
      minutesToPeak: 22,
      realized30mPct: 30,
      realized60mPct: 50,
      realized120mPct: 60,
      realizedEodPct: -5,
      realizedTrail3010Pct: null,
      enrichedAt: '2026-05-08T20:00:00Z',
    },
  });

  it.each<[SilentBoomExitPolicy, string, string]>([
    ['realized30mPct', '+30.0%', '30m'],
    ['realized60mPct', '+50.0%', '60m'],
    ['realized120mPct', '+60.0%', '120m'],
    ['realizedEodPct', '-5.0%', 'eod'],
  ])(
    'renders the realized %s value as the primary number (%s) with the %s label',
    (policy, expectedPct, expectedLabel) => {
      renderRow(fixture, false, policy);
      expect(screen.getByText(expectedPct)).toBeInTheDocument();
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      // Peak is shown as a small reference chip when not primary.
      expect(screen.getByText(/peak \+80\.0%/)).toBeInTheDocument();
    },
  );

  it('renders peak as the primary number with t+Nm hint when peakCeilingPct is selected', () => {
    renderRow(fixture, false, 'peakCeilingPct');
    expect(screen.getByText('+80.0%')).toBeInTheDocument();
    expect(screen.getByText('peak')).toBeInTheDocument();
    expect(screen.getByText('t+22m')).toBeInTheDocument();
    // No "peak +X%" reference chip when peak IS the primary.
    expect(screen.queryByText(/peak \+80\.0%/)).not.toBeInTheDocument();
  });

  it('renders em-dash for null primary value but still shows the peak reference chip', () => {
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: 65,
          minutesToPeak: 18,
          realized30mPct: null,
          realized60mPct: 22.5,
          realized120mPct: null,
          realizedEodPct: -10,
          realizedTrail3010Pct: null,
          enrichedAt: '2026-05-08T20:00:00Z',
        },
      }),
      false,
      'realized30mPct',
    );
    // Primary slot shows em-dash for the null 30m value.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
    // Peak reference chip is still rendered since peak is non-null.
    expect(screen.getByText(/peak \+65\.0%/)).toBeInTheDocument();
  });

  it('omits t+Nm when peak is the primary policy but peak/mtp are both null', () => {
    renderRow(
      makeAlert({
        outcomes: {
          peakCeilingPct: null,
          minutesToPeak: null,
          realized30mPct: null,
          realized60mPct: null,
          realized120mPct: null,
          realizedEodPct: null,
          realizedTrail3010Pct: null,
          enrichedAt: null,
        },
      }),
      false,
      'peakCeilingPct',
    );
    expect(screen.getByText('peak')).toBeInTheDocument();
    // No t+Nm chip when there's no peak to point at.
    expect(screen.queryByText(/^t\+\d+m$/)).not.toBeInTheDocument();
  });
});

// ============================================================
// AVG HOLD MINUTES — cohort hint chip
// ============================================================

describe('SilentBoomRow: avgHoldMinutes chip', () => {
  it('renders the cohort avg-hold-minutes chip with the alert value', () => {
    renderRow(makeAlert({ avgHoldMinutes: 89 }));
    expect(screen.getByText('~89min')).toBeInTheDocument();
  });

  it('uses the alert value verbatim — does not look up the cohort table itself', () => {
    // The row trusts the API response. SPXW tier3 happens to be 296 in
    // the helper, but if the API returned 250 for some reason, that's
    // what we display.
    renderRow(makeAlert({ avgHoldMinutes: 250 }));
    expect(screen.getByText('~250min')).toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — expand / collapse
// ============================================================

describe('SilentBoomRow: expand / collapse', () => {
  it('starts collapsed and renders neither chart panel', () => {
    renderRow(makeAlert());
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

    renderRow(makeAlert());

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
    renderRow(makeAlert());
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/Loading tape…/)).toBeInTheDocument();
  });

  it('renders the tape error message when the tape hook surfaces an error', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      error: 'HTTP 500',
      series: [],
    });
    renderRow(makeAlert());
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/tape error: HTTP 500/)).toBeInTheDocument();
  });
});
