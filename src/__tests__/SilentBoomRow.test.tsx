/**
 * SilentBoomRow unit tests — pragmatic smoke + key-interaction coverage.
 *
 * The 3 data hooks (useContractTape, useNetFlowHistory, useTickerCandles)
 * are mocked so the row doesn't trigger network calls. The two child
 * charts (ContractTapeChart, TickerNetFlowChart) are stubbed because
 * their internal recharts/lightweight-charts / SVG layout isn't what
 * we're testing here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../components/charts/ContractTapeChart', () => ({
  ContractTapeChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="contract-tape-chart" aria-label={ariaLabel} />
  ),
}));
vi.mock('../components/charts/TickerNetFlowChart', () => ({
  TickerNetFlowChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div data-testid="ticker-netflow-chart" aria-label={ariaLabel} />
  ),
}));

// Static import AFTER mocks so the mocks are registered first.
import { SilentBoomRow } from '../components/SilentBoom/SilentBoomRow';
import type { TickerNetFlowSnapshot } from '../hooks/useTickerNetFlowBatch';

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
    multiLegShare: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    gex: {
      oneCvroflow: null,
      netPutDex: null,
      oneDexoflow: null,
      oneGexoflow: null,
      zcvr: null,
      zeroGamma: null,
      spot: null,
      capturedAt: null,
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockUseContractTape.mockReturnValue({
    data: { series: [] },
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
  mockUseNetFlowHistory.mockReturnValue({
    data: { series: [] },
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
  mockUseTickerCandles.mockReturnValue({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
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
  liveFlowSnapshot: TickerNetFlowSnapshot | null = null,
) {
  return render(
    <SilentBoomRow
      alert={alert}
      marketOpen={marketOpen}
      exitPolicy={policy}
      liveFlowSnapshot={liveFlowSnapshot}
    />,
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

  it('renders spot and %OTM in the visible footer when underlyingPriceAtSpike is present (frozen at fire time)', () => {
    // Strike 200 (call) vs spot 198.50 → (200 - 198.50) / 198.50
    // = +0.755% → "+0.8%" formatted. Spot displays from the snapshot,
    // not from live candles, so the moneyness is what it was when the
    // spike fired.
    renderRow(makeAlert({ underlyingPriceAtSpike: 198.5 }));
    expect(
      screen.getByTestId(
        'silent-boom-row-spot-AAPL260508C00200000-2026-05-08T14:30:00Z',
      ),
    ).toHaveTextContent('198.50');
    expect(
      screen.getByTestId(
        'silent-boom-row-otm-pct-AAPL260508C00200000-2026-05-08T14:30:00Z',
      ),
    ).toHaveTextContent('%OTM 0.8%');
  });

  it('flips the OTM sign for puts (positive = OTM regardless of side)', () => {
    // Put with strike 195 vs spot 200 → raw (195 - 200) / 200 = -0.025
    // → flipped for puts → +0.025 → "2.5%" OTM. Sign convention: the
    // displayed % is positive when OTM and negative when ITM, so the
    // reader can compare calls and puts with a single mental model.
    renderRow(
      makeAlert({
        optionType: 'P',
        strike: 195,
        underlyingPriceAtSpike: 200,
      }),
    );
    expect(
      screen.getByTestId(
        'silent-boom-row-otm-pct-AAPL260508C00200000-2026-05-08T14:30:00Z',
      ),
    ).toHaveTextContent('%OTM 2.5%');
  });

  it('omits spot and %OTM when underlyingPriceAtSpike is null (legacy / pending row)', () => {
    renderRow(makeAlert({ underlyingPriceAtSpike: null }));
    expect(
      screen.queryByTestId(
        'silent-boom-row-spot-AAPL260508C00200000-2026-05-08T14:30:00Z',
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        'silent-boom-row-otm-pct-AAPL260508C00200000-2026-05-08T14:30:00Z',
      ),
    ).toBeNull();
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
    // Display ratio is computed from spikeVolume / max(baselineVolume,
    // 100) so the badge stays mathematically grounded when the detector
    // gate's safety floor (100) was the qualifying denominator. With
    // baseline=100 the floor is a no-op and the badge equals the raw
    // ratio. 17.7 → "×18" via toFixed(0).
    renderRow(
      makeAlert({ spikeRatio: 17.7, spikeVolume: 1770, baselineVolume: 100 }),
    );
    expect(screen.getByText(/×18 burst/)).toBeInTheDocument();
  });

  it('caps the burst ratio at the 100-contract baseline floor when the real baseline is tiny', () => {
    // Small-denominator artifact case the detector gate at
    // silent-boom.ts:253 silently floors when qualifying, but the
    // stored `spike_ratio` doesn't — so e.g. baseline=2 produced
    // 8502× headlines that contradicted what the score model said.
    // The badge re-applies the floor: 17000 / max(2, 100) = 170×.
    renderRow(
      makeAlert({
        spikeRatio: 8502,
        spikeVolume: 17_000,
        baselineVolume: 2,
      }),
    );
    expect(screen.getByText(/×170 burst/)).toBeInTheDocument();
  });

  it('mutes the ≥100× penalty bucket with neutral styling (score model classifies it as -3 ghost prints)', () => {
    // Spike-ratio bucket ≥100× scores -3 per silent-boom-score.ts;
    // the badge should NOT paint these red "extreme outlier" since
    // that contradicts the model. Asserts the muted neutral classes
    // win over the rose classes used for the 50-100 bucket.
    renderRow(
      makeAlert({
        spikeRatio: 250,
        spikeVolume: 25_000,
        baselineVolume: 100,
      }),
    );
    const label = screen.getByText(/×250/);
    const badge = label.closest('span');
    expect(badge?.className).toMatch(/text-neutral-400/);
    expect(badge?.className).not.toMatch(/text-rose-200/);
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
    // scoreTier: 'tier3' is explicit so this remains the hard-gate case
    // after the Soft-variant change (default scoreTier is tier2).
    renderRow(makeAlert({ directionGated: true, scoreTier: 'tier3' }));
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

  it('renders a "Soft" Gated pill when directionGated is true AND scoreTier is non-tier3', () => {
    renderRow(makeAlert({ directionGated: true, scoreTier: 'tier2' }));
    const pill = screen.getByTestId('silent-boom-gated-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/Gated.*Soft/);
    expect(pill.getAttribute('title')).toMatch(/TAKE-IT|conviction|preserved/i);
  });

  it('renders the standard "Gated" pill (no Soft suffix) when directionGated is true AND scoreTier is tier3', () => {
    renderRow(makeAlert({ directionGated: true, scoreTier: 'tier3' }));
    const pill = screen.getByTestId('silent-boom-gated-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('Gated');
    expect(pill).not.toHaveTextContent(/Soft/);
  });

  it('renders the standard (hard) "Gated" pill when scoreTier is null even if directionGated is true', () => {
    renderRow(
      makeAlert({
        directionGated: true,
        scoreTier: null,
      } as Partial<SilentBoomAlert> as SilentBoomAlert),
    );
    const pill = screen.getByTestId('silent-boom-gated-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).not.toHaveTextContent(/Soft/);
  });
});

describe('SilentBoomRow: spread-confirmed badge', () => {
  it('renders the Spread-Confirmed badge when multiLegShare is in the 10-50% sweet spot', () => {
    renderRow(makeAlert({ multiLegShare: 0.3 }));
    const badge = screen.getByTestId('silent-boom-spread-confirmed-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Spread-Confirmed');
    expect(badge).toHaveAttribute('title', expect.stringContaining('30%'));
  });

  it('renders the badge at the 10% lower boundary (inclusive)', () => {
    renderRow(makeAlert({ multiLegShare: 0.1 }));
    expect(
      screen.getByTestId('silent-boom-spread-confirmed-badge'),
    ).toBeInTheDocument();
  });

  it('renders the badge at the 50% upper boundary (inclusive)', () => {
    renderRow(makeAlert({ multiLegShare: 0.5 }));
    expect(
      screen.getByTestId('silent-boom-spread-confirmed-badge'),
    ).toBeInTheDocument();
  });

  it('omits the badge below the 10% threshold (single-leg dominated)', () => {
    renderRow(makeAlert({ multiLegShare: 0.05 }));
    expect(
      screen.queryByTestId('silent-boom-spread-confirmed-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits the badge above the 50% threshold (dealer-hedge bucket)', () => {
    renderRow(makeAlert({ multiLegShare: 0.75 }));
    expect(
      screen.queryByTestId('silent-boom-spread-confirmed-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits the badge when multiLegShare is null (pre-#146 rows)', () => {
    renderRow(makeAlert({ multiLegShare: null }));
    expect(
      screen.queryByTestId('silent-boom-spread-confirmed-badge'),
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
      data: {
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
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    mockUseNetFlowHistory.mockReturnValue({
      data: {
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
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    mockUseTickerCandles.mockReturnValue({
      data: {
        ticker: 'SPY',
        date: '2026-05-08',
        previousClose: 199.5,
        count: 1,
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
        marketOpen: false,
        asOf: '2026-05-08T20:00:00Z',
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
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
      data: { series: [] },
      loading: true,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/Loading tape…/)).toBeInTheDocument();
  });

  it('renders the tape error message when the tape hook surfaces an error', () => {
    mockUseContractTape.mockReturnValue({
      data: { series: [] },
      loading: false,
      error: 'HTTP 500',
      fetchedAt: null,
      refresh: vi.fn(),
    });
    renderRow(makeAlert());
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/tape error: HTTP 500/)).toBeInTheDocument();
  });
});

describe('SilentBoomRow: flow-match badge', () => {
  it('renders "Flow Match" (emerald) for a call when live NCP > NPP', () => {
    renderRow(makeAlert({ optionType: 'C' }), true, 'realized60mPct', {
      cumNcp: 31_500_000,
      cumNpp: -13_400_000,
      asOfTs: '2026-05-15T19:59:00.000Z',
    });
    const badge = screen.getByTestId('silent-boom-flow-match-badge');
    expect(badge).toHaveTextContent('Flow Match');
    expect(badge.className).toContain('emerald');
  });

  it('renders "Flow Mismatch" (red) for a call when live NCP < NPP', () => {
    renderRow(makeAlert({ optionType: 'C' }), true, 'realized60mPct', {
      cumNcp: 5_000_000,
      cumNpp: 12_000_000,
      asOfTs: '2026-05-15T19:59:00.000Z',
    });
    const badge = screen.getByTestId('silent-boom-flow-match-badge');
    expect(badge).toHaveTextContent('Flow Mismatch');
    expect(badge.className).toContain('red');
  });

  it('omits the badge when liveFlowSnapshot is null (cold start)', () => {
    renderRow(makeAlert({ optionType: 'C' }), true, 'realized60mPct', null);
    expect(
      screen.queryByTestId('silent-boom-flow-match-badge'),
    ).not.toBeInTheDocument();
  });

  it('flips polarity for puts — NCP < NPP renders Flow Match', () => {
    renderRow(makeAlert({ optionType: 'P' }), true, 'realized60mPct', {
      cumNcp: 5_000_000,
      cumNpp: 12_000_000,
      asOfTs: '2026-05-15T19:59:00.000Z',
    });
    expect(
      screen.getByTestId('silent-boom-flow-match-badge'),
    ).toHaveTextContent('Flow Match');
  });
});

describe('SilentBoomRow: flow-inverted badge', () => {
  it('renders Flow Inverted (amber) when call alert was matched at fire and current is mismatch', () => {
    renderRow(
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 10_000_000,
        tickerCumNppAtFire: 1_000_000,
      }),
      true,
      'realized60mPct',
      {
        cumNcp: 2_000_000,
        cumNpp: 15_000_000,
        asOfTs: '2026-05-15T19:59:00.000Z',
      },
    );
    const badge = screen.getByTestId('silent-boom-flow-inverted-badge');
    expect(badge).toHaveTextContent('Flow Inverted');
    expect(badge.className).toContain('amber');
  });

  it('omits Flow Inverted when fire-time was mismatched (no tailwind to lose)', () => {
    renderRow(
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 10_000_000,
      }),
      true,
      'realized60mPct',
      {
        cumNcp: 2_000_000,
        cumNpp: 15_000_000,
        asOfTs: '2026-05-15T19:59:00.000Z',
      },
    );
    expect(
      screen.queryByTestId('silent-boom-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits Flow Inverted when current still matches (stable)', () => {
    renderRow(
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 10_000_000,
        tickerCumNppAtFire: 1_000_000,
      }),
      true,
      'realized60mPct',
      {
        cumNcp: 20_000_000,
        cumNpp: 5_000_000,
        asOfTs: '2026-05-15T19:59:00.000Z',
      },
    );
    expect(
      screen.queryByTestId('silent-boom-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits Flow Inverted when fire-time snapshot is null (pre-LATERAL row)', () => {
    renderRow(makeAlert({ optionType: 'C' }), true, 'realized60mPct', {
      cumNcp: 2_000_000,
      cumNpp: 15_000_000,
      asOfTs: '2026-05-15T19:59:00.000Z',
    });
    expect(
      screen.queryByTestId('silent-boom-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });
});

describe('SilentBoomRow: Flow chip', () => {
  it('renders Flow ⬆ when ticker NCP > NPP at fire', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 2_000_000,
      }),
    );
    expect(screen.getByTestId('silent-boom-row-flow-chip')).toHaveTextContent(
      'Flow ⬆',
    );
  });

  it('renders Flow ⬇ when ticker NCP < NPP at fire', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 4_000_000,
      }),
    );
    expect(screen.getByTestId('silent-boom-row-flow-chip')).toHaveTextContent(
      'Flow ⬇',
    );
  });

  it('renders Flow → when ticker NCP === NPP at fire (flat)', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: 3_000_000,
        tickerCumNppAtFire: 3_000_000,
      }),
    );
    expect(screen.getByTestId('silent-boom-row-flow-chip')).toHaveTextContent(
      'Flow →',
    );
  });

  it('does not render Flow chip when either field is null', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: null,
        tickerCumNppAtFire: 2_000_000,
      }),
    );
    expect(screen.queryByTestId('silent-boom-row-flow-chip')).toBeNull();
  });
});

describe('SilentBoomRow: EXIT badge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders EXIT (red) when cohort hold has expired', () => {
    const bucket = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(bucket) + 1000 * 60_000));
    renderRow(makeAlert({ bucketCt: bucket }));
    const exit = screen.getByTestId('silent-boom-exit-now-badge');
    expect(exit).toHaveTextContent('EXIT');
    expect(exit).toHaveAttribute(
      'title',
      expect.stringContaining('Cohort P75 hold elapsed'),
    );
  });

  it('renders EXIT when flow has inverted', () => {
    const bucket = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(bucket) + 30 * 60_000));
    renderRow(
      makeAlert({
        optionType: 'C',
        bucketCt: bucket,
        tickerCumNcpAtFire: 10_000_000,
        tickerCumNppAtFire: 1_000_000,
      }),
      true,
      'realized60mPct',
      {
        cumNcp: 1_000_000,
        cumNpp: 20_000_000,
        asOfTs: '2026-05-15T14:00:00.000Z',
      },
    );
    expect(screen.getByTestId('silent-boom-exit-now-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('Ticker net flow inverted'),
    );
  });

  it('renders EXIT with combined tooltip when both rules fire', () => {
    const bucket = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(bucket) + 1000 * 60_000));
    renderRow(
      makeAlert({
        optionType: 'C',
        bucketCt: bucket,
        tickerCumNcpAtFire: 10_000_000,
        tickerCumNppAtFire: 1_000_000,
      }),
      true,
      'realized60mPct',
      {
        cumNcp: 1_000_000,
        cumNpp: 20_000_000,
        asOfTs: '2026-05-15T14:00:00.000Z',
      },
    );
    expect(screen.getByTestId('silent-boom-exit-now-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('Hold expired + flow inverted'),
    );
  });

  it('omits EXIT when nothing has fired', () => {
    const bucket = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(bucket) + 30 * 60_000));
    renderRow(makeAlert({ bucketCt: bucket }));
    expect(
      screen.queryByTestId('silent-boom-exit-now-badge'),
    ).not.toBeInTheDocument();
  });
});
