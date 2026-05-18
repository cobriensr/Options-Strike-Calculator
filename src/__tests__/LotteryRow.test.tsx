/**
 * LotteryRow unit tests — pragmatic smoke + key-interaction coverage.
 *
 * The 3 data hooks (useContractTape, useNetFlowHistory, useTickerCandles)
 * are mocked so the row doesn't trigger network calls. The two child
 * charts are stubbed because their internal recharts/lightweight-charts /
 * SVG layout isn't what we're testing here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type {
  LotteryFire,
  LotteryFireMacro,
  LotteryTickerStats,
} from '../components/LotteryFinder/types';

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
import { LotteryRow } from '../components/LotteryFinder/LotteryRow';

// ── Fixture factories ─────────────────────────────────────────────────

function makeMacro(
  overrides: Partial<LotteryFireMacro> = {},
): LotteryFireMacro {
  return {
    mktTideNcp: null,
    mktTideNpp: null,
    mktTideDiff: null,
    mktTideOtmDiff: null,
    tickerCumNcpAtFire: null,
    tickerCumNppAtFire: null,
    spxFlowDiff: null,
    spyEtfDiff: null,
    qqqEtfDiff: null,
    zeroDteDiff: null,
    spxSpotGammaOi: null,
    spxSpotGammaVol: null,
    spxSpotCharmOi: null,
    spxSpotVannaOi: null,
    gexStrikeCallMinusPut: null,
    gexStrikeCallAskMinusBid: null,
    gexStrikePutAskMinusBid: null,
    gexStrikeActualStrike: null,
    ...overrides,
  };
}

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-08',
    triggerTimeCt: '2026-05-08T14:30:00Z',
    entryTimeCt: '2026-05-08T14:31:00Z',
    optionChainId: 'AAPL260508C00200000',
    underlyingSymbol: 'AAPL',
    optionType: 'C',
    strike: 200,
    expiry: '2026-05-08',
    dte: 0,
    score: 15,
    scoreTier: 'tier2',
    directionGated: false,
    forecastHighPeakPct: '40-60%',
    avgHoldMinutes: 160,
    tickerStats: null,
    fireCount: 1,
    firstFireTimeCt: '2026-05-08T14:30:00Z',
    trigger: {
      volToOiWindow: 1.5,
      volToOiCum: 2.2,
      iv: 0.35,
      delta: 0.25,
      askPct: 0.7,
      windowSize: 5,
      windowPrints: 50,
    },
    entry: {
      price: 0.85,
      openInterest: 5000,
      spotAtFirst: 198.5,
      alertSeq: 7,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'PM',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: true,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: makeMacro({ mktTideDiff: 1500 }),
    outcomes: {
      realizedTrail30_10Pct: 22.5,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: -10,
      peakCeilingPct: 47,
      minutesToPeak: 12,
      enrichedAt: '2026-05-08T20:00:00Z',
    },
    hoursToNextMacroEvent: null,
    rangePosAtTrigger: null,
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

function makeStats(
  overrides: Partial<LotteryTickerStats> = {},
): LotteryTickerStats {
  return {
    nFires: 220,
    highPeakRate: 65.5,
    ciLower: 60.2,
    ciUpper: 70.8,
    ciWidth: 10.6,
    tier: '',
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

describe('LotteryRow: smoke', () => {
  it('renders ticker, strike, and option type for a basic fire', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // Option-type badge with the letter "C".
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders the realized return percentage for the selected exit policy', () => {
    render(
      <LotteryRow
        fire={makeFire({
          outcomes: {
            realizedTrail30_10Pct: 22.5,
            realizedHard30mPct: null,
            realizedTier50HoldEodPct: null,
            realizedFlowInversionPct: null,
            realizedEodPct: null,
            peakCeilingPct: 47,
            minutesToPeak: 12,
            enrichedAt: '2026-05-08T20:00:00Z',
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('+22.5%')).toBeInTheDocument();
  });

  it('renders RE-LOAD and cheap-call-PM badges when the matching tags are set', () => {
    render(
      <LotteryRow
        fire={makeFire({
          tags: {
            flowQuad: 'call_ask',
            tod: 'PM',
            mode: 'A_intraday_0DTE',
            reload: true,
            cheapCallPm: true,
            burstRatioVsPrev: 2.5,
            entryDropPctVsPrev: -45,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('RE-LOAD')).toBeInTheDocument();
    expect(screen.getByText('cheap-call-PM')).toBeInTheDocument();
  });
});

// ============================================================
// AVG HOLD MINUTES — cohort hint chip
// ============================================================

describe('LotteryRow: avgHoldMinutes chip', () => {
  it('renders the cohort avg-hold-minutes chip with the fire value', () => {
    render(
      <LotteryRow
        fire={makeFire({ avgHoldMinutes: 343 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('~343min')).toBeInTheDocument();
  });

  it('uses the tier1-specific tooltip phrasing on tier1 fires', () => {
    render(
      <LotteryRow
        fire={makeFire({
          scoreTier: 'tier1',
          score: 22,
          avgHoldMinutes: 343,
          underlyingSymbol: 'RKLB',
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const chip = screen.getByText('~343min');
    expect(chip.getAttribute('title')).toMatch(
      /tier 1 .* often run on slow tail moves/,
    );
  });

  it('uses the generic tooltip on tier2/tier3 fires', () => {
    render(
      <LotteryRow
        fire={makeFire({
          scoreTier: 'tier3',
          score: 5,
          avgHoldMinutes: 50,
          underlyingSymbol: 'SPXW',
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const chip = screen.getByText('~50min');
    expect(chip.getAttribute('title')).toMatch(/tier3 SPXW fires/);
    expect(chip.getAttribute('title')).not.toMatch(/slow tail moves/);
  });
});

// ============================================================
// EXIT-POLICY FALLBACK + EM-DASH BRANCHES
// ============================================================

describe('LotteryRow: exit-policy fallback', () => {
  it('renders an em-dash for the realized number when the selected policy is null', () => {
    render(
      <LotteryRow
        fire={makeFire({
          outcomes: {
            realizedTrail30_10Pct: null,
            realizedHard30mPct: null,
            realizedTier50HoldEodPct: null,
            realizedFlowInversionPct: null,
            realizedEodPct: null,
            peakCeilingPct: null,
            minutesToPeak: null,
            enrichedAt: null,
          },
        })}
        exitPolicy="realizedFlowInversionPct"
        marketOpen={false}
      />,
    );
    // Both realized and peak are null → at least two em-dashes appear in the
    // realized + peak block. We assert that "—" is present at least once.
    expect(screen.getAllByText(/—/).length).toBeGreaterThan(0);
  });

  it('shows the EOD fallback when the selected policy is null but realizedEodPct is populated', () => {
    render(
      <LotteryRow
        fire={makeFire({
          outcomes: {
            realizedTrail30_10Pct: null,
            realizedHard30mPct: null,
            realizedTier50HoldEodPct: null,
            realizedFlowInversionPct: null,
            realizedEodPct: -12.5,
            peakCeilingPct: 5,
            minutesToPeak: 3,
            enrichedAt: '2026-05-08T20:00:00Z',
          },
        })}
        exitPolicy="realizedFlowInversionPct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('-12.5%')).toBeInTheDocument();
    expect(screen.getByText(/eod/)).toBeInTheDocument();
  });
});

// ============================================================
// TIER + CI BADGES
// ============================================================

describe('LotteryRow: tier + reliability badges', () => {
  it('renders the Tier 1 emoji badge for tier1 fires', () => {
    render(
      <LotteryRow
        fire={makeFire({ scoreTier: 'tier1', score: 20 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('🔥🔥🔥')).toBeInTheDocument();
  });

  it('renders the reliable ✓ indicator when ticker stats tier is "reliable"', () => {
    render(
      <LotteryRow
        fire={makeFire({
          tickerStats: makeStats({ tier: 'reliable', ciWidth: 8 }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('✓')).toBeInTheDocument();
  });
});

// ============================================================
// PHASE 4: DIRECTION-GATE PILL
// ============================================================

describe('LotteryRow: direction-gate pill', () => {
  it('renders the Gated pill when directionGated is true', () => {
    render(
      <LotteryRow
        fire={makeFire({ directionGated: true })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const pill = screen.getByTestId('lottery-gated-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('Gated');
  });

  it('does not render the Gated pill when directionGated is false', () => {
    render(
      <LotteryRow
        fire={makeFire({ directionGated: false })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByTestId('lottery-gated-pill')).not.toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — expand / collapse
// ============================================================

describe('LotteryRow: expand / collapse', () => {
  it('starts collapsed and renders neither chart panel', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
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

    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );

    const toggle = screen.getByRole('button', { name: /▸ expand/ });
    fireEvent.click(toggle);

    expect(screen.getByTestId('contract-tape-chart')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-netflow-chart')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /▾ collapse/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('renders OI / Prem / %OTM / NCV / NPV / Δv in the expanded headers', () => {
    // Same fixtures as the smoke expand test so the header maths is
    // computable: tapeStats.total = 175, avgFill = 1.25 → premium $22K;
    // OI = 5000 → 5.0K; strike 200 vs spot 198.5 (call) → +0.8% OTM;
    // cumNcv 50, cumNpv 30 → Δv = +20.
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
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));

    // CONTRACT header carries OI / Prem / %OTM.
    expect(screen.getByText('OI')).toBeInTheDocument();
    // 5000 OI → '5.0K' via formatVol.
    expect(screen.getByText('5.0K')).toBeInTheDocument();
    expect(screen.getByText('Prem')).toBeInTheDocument();
    // Premium = 175 * 1.25 * 100 = 21875 → '$22K' via formatPremiumAmount.
    expect(screen.getByText('$22K')).toBeInTheDocument();
    expect(screen.getByText('%OTM')).toBeInTheDocument();

    // NET FLOW header carries NCV / NPV / Δv with computed totals.
    expect(screen.getByText('NCV')).toBeInTheDocument();
    expect(screen.getByText('NPV')).toBeInTheDocument();
    expect(screen.getByText('Δv')).toBeInTheDocument();
  });

  it('shows the loading text when the tape hook is loading and series is empty', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      loading: true,
      series: [],
    });
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/Loading tape…/)).toBeInTheDocument();
  });

  it('renders the tape error message when the tape hook surfaces an error', () => {
    mockUseContractTape.mockReturnValue({
      ...defaultHookState,
      error: 'HTTP 500',
      series: [],
    });
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /▸ expand/ }));
    expect(screen.getByText(/tape error: HTTP 500/)).toBeInTheDocument();
  });
});

describe('LotteryRow: flow-match badge', () => {
  it('renders "Flow Match" (emerald) for a call when live NCP > NPP', () => {
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'C' })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 31_500_000,
          cumNpp: -13_400_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    const badge = screen.getByTestId('lottery-flow-match-badge');
    expect(badge).toHaveTextContent('Flow Match');
    expect(badge.className).toContain('emerald');
  });

  it('renders "Flow Mismatch" (red) for a call when live NCP < NPP', () => {
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'C' })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 5_000_000,
          cumNpp: 12_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    const badge = screen.getByTestId('lottery-flow-match-badge');
    expect(badge).toHaveTextContent('Flow Mismatch');
    expect(badge.className).toContain('red');
  });

  it('omits the badge when liveFlowSnapshot is null (cold start)', () => {
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'C' })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={null}
      />,
    );
    expect(
      screen.queryByTestId('lottery-flow-match-badge'),
    ).not.toBeInTheDocument();
  });

  it('flips polarity for puts — NCP < NPP renders Flow Match', () => {
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'P' })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 5_000_000,
          cumNpp: 12_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    expect(screen.getByTestId('lottery-flow-match-badge')).toHaveTextContent(
      'Flow Match',
    );
  });
});

describe('LotteryRow: flow-inverted badge', () => {
  it('renders Flow Inverted (amber) when call alert was matched at fire and current is mismatch', () => {
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          macro: {
            ...makeFire().macro,
            tickerCumNcpAtFire: 10_000_000,
            tickerCumNppAtFire: 1_000_000,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 2_000_000,
          cumNpp: 15_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    const badge = screen.getByTestId('lottery-flow-inverted-badge');
    expect(badge).toHaveTextContent('Flow Inverted');
    expect(badge.className).toContain('amber');
  });

  it('omits Flow Inverted when fire-time was mismatched (no tailwind to lose)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          macro: {
            ...makeFire().macro,
            tickerCumNcpAtFire: 1_000_000,
            tickerCumNppAtFire: 10_000_000,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 2_000_000,
          cumNpp: 15_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    expect(
      screen.queryByTestId('lottery-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits Flow Inverted when current still matches (stable)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          macro: {
            ...makeFire().macro,
            tickerCumNcpAtFire: 10_000_000,
            tickerCumNppAtFire: 1_000_000,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 20_000_000,
          cumNpp: 5_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    expect(
      screen.queryByTestId('lottery-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });

  it('omits Flow Inverted when fire-time snapshot is null (pre-LATERAL row)', () => {
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'C' })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 2_000_000,
          cumNpp: 15_000_000,
          asOfTs: '2026-05-15T19:59:00.000Z',
        }}
      />,
    );
    expect(
      screen.queryByTestId('lottery-flow-inverted-badge'),
    ).not.toBeInTheDocument();
  });
});

describe('LotteryRow: EXIT badge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders EXIT (red) when cohort hold has expired', () => {
    // Trigger far enough in the past that avgHoldMinutes has elapsed.
    const trigger = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(
      new Date(Date.parse(trigger) + 1000 * 60_000), // 1000m later
    );
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          triggerTimeCt: trigger,
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const exit = screen.getByTestId('lottery-exit-now-badge');
    expect(exit).toHaveTextContent('EXIT');
    expect(exit).toHaveAttribute(
      'title',
      expect.stringContaining('Cohort P75 hold elapsed'),
    );
  });

  it('renders EXIT when flow has inverted (countdown still in window)', () => {
    const trigger = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 30 * 60_000));
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          triggerTimeCt: trigger,
          macro: {
            ...makeFire().macro,
            tickerCumNcpAtFire: 10_000_000,
            tickerCumNppAtFire: 1_000_000,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 1_000_000,
          cumNpp: 20_000_000,
          asOfTs: '2026-05-15T14:00:00.000Z',
        }}
      />,
    );
    const exit = screen.getByTestId('lottery-exit-now-badge');
    expect(exit).toHaveAttribute(
      'title',
      expect.stringContaining('Ticker net flow inverted'),
    );
  });

  it('renders EXIT with combined tooltip when both rules fire', () => {
    const trigger = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 1000 * 60_000));
    render(
      <LotteryRow
        fire={makeFire({
          optionType: 'C',
          triggerTimeCt: trigger,
          macro: {
            ...makeFire().macro,
            tickerCumNcpAtFire: 10_000_000,
            tickerCumNppAtFire: 1_000_000,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen
        liveFlowSnapshot={{
          cumNcp: 1_000_000,
          cumNpp: 20_000_000,
          asOfTs: '2026-05-15T14:00:00.000Z',
        }}
      />,
    );
    expect(screen.getByTestId('lottery-exit-now-badge')).toHaveAttribute(
      'title',
      expect.stringContaining('Hold expired + flow inverted'),
    );
  });

  it('omits EXIT when nothing has fired', () => {
    const trigger = '2026-05-15T13:30:00.000Z';
    vi.setSystemTime(new Date(Date.parse(trigger) + 30 * 60_000));
    render(
      <LotteryRow
        fire={makeFire({ optionType: 'C', triggerTimeCt: trigger })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-exit-now-badge'),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// Phase 3 of lottery-reignition-ui-2026-05-17 — REIGNITED chip
// ============================================================

describe('LotteryRow: REIGNITED chip', () => {
  it('renders the REIGNITED chip when fire.reignited is true', () => {
    render(
      <LotteryRow
        fire={makeFire({ reignited: true, fireCount: 8 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('REIGNITED')).toBeInTheDocument();
  });

  it('hides the REIGNITED chip when fire.reignited is undefined', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('REIGNITED')).not.toBeInTheDocument();
  });

  it('hides the REIGNITED chip when fire.reignited is explicitly false', () => {
    render(
      <LotteryRow
        fire={makeFire({ reignited: false, fireCount: 8 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('REIGNITED')).not.toBeInTheDocument();
  });
});

// ============================================================
// MEGA-CLUSTER chip (cluster-2026-05-15-1205ct-findings.md)
// ============================================================

describe('LotteryRow: MEGA-CLUSTER chip', () => {
  it('renders the chip with the ticker count when megaCluster=true + megaClusterSize is set', () => {
    render(
      <LotteryRow
        fire={makeFire({ megaCluster: true, megaClusterSize: 18 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('CLUSTER ×18')).toBeInTheDocument();
  });

  it('falls back to "MEGA CLUSTER" label when size is undefined but flag is true', () => {
    render(
      <LotteryRow
        fire={makeFire({ megaCluster: true })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('MEGA CLUSTER')).toBeInTheDocument();
  });

  it('hides the chip when megaCluster is false / undefined', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByText(/MEGA CLUSTER|CLUSTER ×/),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// DUAL-FLAG chip (lf-vs-sb-backtest-findings-2026-05-17.md)
// ============================================================

describe('LotteryRow: DUAL-FLAG chip', () => {
  it('renders the chip when fire.dualFlag is true', () => {
    render(
      <LotteryRow
        fire={makeFire({ dualFlag: true })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('DUAL FLAG')).toBeInTheDocument();
  });

  it('hides the chip when dualFlag is undefined', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('DUAL FLAG')).not.toBeInTheDocument();
  });

  it('hides the chip when dualFlag is explicitly false', () => {
    render(
      <LotteryRow
        fire={makeFire({ dualFlag: false })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('DUAL FLAG')).not.toBeInTheDocument();
  });
});

// ============================================================
// Flow chip (net-flow-chip-and-filter-design-2026-05-18)
// ============================================================

describe('LotteryRow: Flow chip', () => {
  it('renders Flow ⬆ when ticker NCP > NPP at fire', () => {
    render(
      <LotteryRow
        fire={makeFire({
          macro: makeMacro({
            mktTideDiff: 1500,
            tickerCumNcpAtFire: 5_000_000,
            tickerCumNppAtFire: 2_000_000,
          }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByTestId('lottery-row-flow-chip')).toHaveTextContent(
      'Flow ⬆',
    );
  });

  it('renders Flow ⬇ when ticker NCP < NPP at fire', () => {
    render(
      <LotteryRow
        fire={makeFire({
          macro: makeMacro({
            mktTideDiff: 1500,
            tickerCumNcpAtFire: 1_000_000,
            tickerCumNppAtFire: 4_000_000,
          }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByTestId('lottery-row-flow-chip')).toHaveTextContent(
      'Flow ⬇',
    );
  });

  it('does not render Flow chip when either field is null', () => {
    render(
      <LotteryRow
        fire={makeFire({
          macro: makeMacro({
            mktTideDiff: 1500,
            tickerCumNcpAtFire: null,
            tickerCumNppAtFire: 2_000_000,
          }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByTestId('lottery-row-flow-chip')).toBeNull();
  });
});

// ============================================================
// HIGH-Γ chip (gamma-deep-dive-findings-2026-05-17.md)
// ============================================================

describe('LotteryRow: HIGH-Γ chip', () => {
  it('renders the chip when gammaScoreAdjustment > 0', () => {
    render(
      <LotteryRow
        fire={makeFire({
          gammaAtTrigger: 0.05,
          gammaScoreAdjustment: 1,
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('HIGH-Γ')).toBeInTheDocument();
  });

  it('hides the chip when gammaScoreAdjustment is 0 (gamma below threshold)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          gammaAtTrigger: 0.01,
          gammaScoreAdjustment: 0,
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('HIGH-Γ')).not.toBeInTheDocument();
  });

  it('hides the chip when gammaScoreAdjustment is undefined (older fires)', () => {
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('HIGH-Γ')).not.toBeInTheDocument();
  });
});
