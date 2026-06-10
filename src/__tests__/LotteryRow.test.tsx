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

const {
  mockUseContractTape,
  mockUseNetFlowHistory,
  mockUseTickerCandles,
  mockUseNowMinute,
} = vi.hoisted(() => ({
  mockUseContractTape: vi.fn(),
  mockUseNetFlowHistory: vi.fn(),
  mockUseTickerCandles: vi.fn(),
  mockUseNowMinute: vi.fn(),
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
// Mock the per-minute clock so `nowMs` is deterministic. The "still hot"
// badge must derive from this value (NOT an inline Date.now() read), so a
// controlled `nowMs` is what decides whether the badge shows.
vi.mock('../hooks/useNowMinute', () => ({
  useNowMinute: mockUseNowMinute,
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
      spotAtTrigger: 198.5,
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
    qualityAdjustedScore: 15,
    inversionQuintile: null,
    inversionBlend: null,
    inversionN21d: null,
    inversionN90d: null,
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
  // Default `nowMs`: delegate to the real clock so tests that drive time
  // via vi.setSystemTime (EXIT badge countdown) keep working exactly as
  // before — the production hook also reads Date.now(). Hot-badge tests
  // override this with an explicit mockReturnValue to pin `nowMs`.
  mockUseNowMinute.mockImplementation(() => Date.now());
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

  it('renders spot and %OTM in the always-visible row footer (frozen snapshot)', () => {
    // Fixture: strike 200 (call), spotAtTrigger 198.5 → (200-198.5)/198.5
    // = +0.755% → "+0.8%" formatted. Spot displays from spotAtTrigger,
    // not from live candles, because OTM% is frozen at fire time.
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    // Always-visible spot field (no expand click).
    expect(screen.getByText('198.50')).toBeInTheDocument();
    // Always-visible %OTM chip — disambiguated via testid because the
    // expanded CONTRACT strip also renders a %OTM chip. No sign on the
    // numeric: positive means OTM (neutral color), negative means ITM
    // (amber). Matches the convention of the existing expanded chip.
    expect(
      screen.getByTestId('lottery-row-otm-pct-AAPL260508C00200000'),
    ).toHaveTextContent('%OTM 0.8%');
  });

  it('falls back to spotAtFirst when spotAtTrigger is null (pre-#176 row)', () => {
    // Legacy row from before migration #176: spotAtTrigger is null, so
    // the visible footer + %OTM should drive off spotAtFirst (199.0).
    // Strike 200 vs spot 199.0 (call) → +0.5% OTM rounded.
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.85,
            openInterest: 5000,
            spotAtFirst: 199.0,
            spotAtTrigger: null,
            alertSeq: 7,
            minutesSincePrevFire: 30,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('199.00')).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-otm-pct-AAPL260508C00200000'),
    ).toHaveTextContent('%OTM 0.5%');
  });

  it('renders "—" for spot when neither snapshot is usable (resolveFireSpot null)', () => {
    // Both spot snapshots are non-positive, so resolveFireSpot returns null
    // (usableSpot rejects <= 0). The footer must render the em-dash, never
    // call .toFixed on the already-rejected fallback (which would print a
    // misleading "0.00"/negative).
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 1.2,
            openInterest: 5000,
            spotAtFirst: 0,
            spotAtTrigger: 0,
            alertSeq: 1,
            minutesSincePrevFire: 30,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    // Em-dash placeholder is shown.
    expect(screen.getByText('—')).toBeInTheDocument();
    // The misleading "0.00" fallback must NOT appear.
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  });

  it('renders the cheap-call-PM badge when the tag is set', () => {
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
    expect(screen.getByText('cheap-call-PM')).toBeInTheDocument();
  });
});

// ============================================================
// "STILL HOT" badge — derives from useNowMinute (nowMs), not Date.now()
// ============================================================

describe('LotteryRow: still-hot badge', () => {
  // Fixture trigger is 2026-05-08T14:30:00Z.
  const TRIGGER_MS = new Date('2026-05-08T14:30:00Z').getTime();

  it('shows the hot badge when nowMs is within 10 min of the trigger and market is open', () => {
    // nowMs = trigger + 5 min → inside the 10-minute window. This proves
    // the badge reads the mocked `nowMs`: the real clock (2026-06) is far
    // outside the window, so a Date.now() read would hide the badge.
    mockUseNowMinute.mockReturnValue(TRIGGER_MS + 5 * 60_000);
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={true}
      />,
    );
    expect(screen.getByText('hot')).toBeInTheDocument();
  });

  it('hides the hot badge when nowMs is more than 10 min past the trigger', () => {
    mockUseNowMinute.mockReturnValue(TRIGGER_MS + 20 * 60_000);
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={true}
      />,
    );
    expect(screen.queryByText('hot')).not.toBeInTheDocument();
  });

  it('hides the hot badge when the market is closed even within the window', () => {
    mockUseNowMinute.mockReturnValue(TRIGGER_MS + 5 * 60_000);
    render(
      <LotteryRow
        fire={makeFire()}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('hot')).not.toBeInTheDocument();
  });
});

// ============================================================
// RELOAD delta badge (lottery-reload-deltas-2026-05-21.md)
// ============================================================

describe('LotteryRow: RELOAD delta badge', () => {
  it('omits the badge on the first fire of a chain (no historicalFires)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 1.5,
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 1,
            minutesSincePrevFire: 0,
          },
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-row-reload-delta'),
    ).not.toBeInTheDocument();
  });

  it('renders green strict badge with option AND spx deltas when strict tag fires + opt drop ≥30%', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.58, // 0.58 / 1.0 - 1 = -42%
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 201, // 201 / 200 - 1 = +0.5% (rounds to +1%)
            alertSeq: 3,
            minutesSincePrevFire: 15,
          },
          tags: {
            flowQuad: 'call_ask',
            tod: 'PM',
            mode: 'A_intraday_0DTE',
            reload: true,
            cheapCallPm: false,
            burstRatioVsPrev: 2.5,
            entryDropPctVsPrev: -42,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const badge = screen.getByTestId('lottery-row-reload-delta');
    // U+2212 minus for negative; round-to-int; literal "spx" segment per spec.
    expect(badge).toHaveTextContent('RELOAD opt −42% · spx +1%');
    expect(badge.className).toContain('emerald');
  });

  it('renders amber soft badge when option drop is -18% and strict tag is false', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.82, // -18% from 1.00
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 4,
            minutesSincePrevFire: 20,
          },
          tags: {
            flowQuad: 'call_ask',
            tod: 'PM',
            mode: 'A_intraday_0DTE',
            reload: false,
            cheapCallPm: false,
            burstRatioVsPrev: 1.2,
            entryDropPctVsPrev: -18,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const badge = screen.getByTestId('lottery-row-reload-delta');
    expect(badge).toHaveTextContent('RELOAD opt −18%');
    expect(badge.className).toContain('amber');
    expect(badge.getAttribute('title')).toMatch(/Soft reload/);
  });

  it('renders neutral badge when option drop is shallow (-5%)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.95, // -5% from 1.00
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 2,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const badge = screen.getByTestId('lottery-row-reload-delta');
    expect(badge).toHaveTextContent('RELOAD opt −5%');
    expect(badge.className).toContain('neutral');
  });

  it('renders green strict badge when backend reload tag is set even if display Δ is only -20%', () => {
    // Spec amendment: fire.tags.reload is the backend cohort gate
    // (validated vs prior fire). optPct is the display delta vs FIRST
    // fire of the day. These legitimately diverge — a late-day re-fire
    // can pass the backend gate but only be -20% vs first fire. The
    // strict tag should always win the tier.
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.8, // -20% from 1.00 — NOT meeting the -30% display threshold
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 5,
            minutesSincePrevFire: 60,
          },
          tags: {
            flowQuad: 'call_ask',
            tod: 'PM',
            mode: 'A_intraday_0DTE',
            reload: true, // backend gate IS set
            cheapCallPm: false,
            burstRatioVsPrev: 2.5,
            entryDropPctVsPrev: -35,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const badge = screen.getByTestId('lottery-row-reload-delta');
    expect(badge.className).toContain('emerald');
    expect(badge.getAttribute('title')).toMatch(/RE-LOAD cohort/);
  });

  it('suppresses the badge when |rounded optPct| < 1 (e.g. -0.3% rounds to 0)', () => {
    // formatDeltaWhole guard: a re-fire entry within ±1% of the first
    // fire has no reload opportunity to surface, and the label would
    // read "0%" which is misleading. Suppress entirely.
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.997, // -0.3% from 1.00 — rounds to 0
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 2,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-row-reload-delta'),
    ).not.toBeInTheDocument();
  });

  it('suppresses the badge entirely when re-fire entry is flat or higher (+3%)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 1.03, // +3% from 1.00
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 2,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-row-reload-delta'),
    ).not.toBeInTheDocument();
  });

  it('omits the spx segment when the first fire has no spotAtTrigger (pre-#176 row)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.6, // -40% from 1.00
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 201,
            alertSeq: 2,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: null,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const badge = screen.getByTestId('lottery-row-reload-delta');
    expect(badge).toHaveTextContent('RELOAD opt −40%');
    expect(badge.textContent).not.toMatch(/spx/);
  });

  it('suppresses the badge when the first fire entryPrice is non-positive (divide-by-zero guard)', () => {
    // reloadDelta bails when historicalFires[0].entryPrice <= 0 (or NaN) —
    // a zero/garbage first-fire price would make the option-delta % a
    // divide-by-zero. alertSeq > 1 AND a historicalFires entry are present,
    // so this exercises the entryPrice guard specifically (not the
    // alertSeq<=1 or missing-firstFire early returns).
    render(
      <LotteryRow
        fire={makeFire({
          entry: {
            price: 0.6,
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 201,
            alertSeq: 3,
            minutesSincePrevFire: 15,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 0, // non-positive → guarded
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-row-reload-delta'),
    ).not.toBeInTheDocument();
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

  it('renders the uncertain ⚠️ indicator when ticker stats tier is "uncertain"', () => {
    // CI >15pp → the small-sample / noisy-estimate warning branch of
    // ciIndicator (the sibling of the "reliable" ✓ path).
    render(
      <LotteryRow
        fire={makeFire({
          tickerStats: makeStats({ tier: 'uncertain', ciWidth: 22 }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByText('⚠️')).toBeInTheDocument();
  });

  it('renders NO ci indicator for the middle band (tier neither reliable nor uncertain)', () => {
    // Default makeStats tier is '' (10<CI<15 dead band) → ciIndicator returns
    // null, so neither ✓ nor ⚠️ is shown.
    render(
      <LotteryRow
        fire={makeFire({ tickerStats: makeStats({ tier: '', ciWidth: 12 }) })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
    expect(screen.queryByText('⚠️')).not.toBeInTheDocument();
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

  it('renders OI / Prem / %OTM in the expanded CONTRACT header', () => {
    // Same fixtures as the smoke expand test so the header maths is
    // computable: tapeStats.total = 175, avgFill = 1.25 → premium $22K;
    // OI = 5000 → 5.0K; strike 200 vs spot 198.5 (call) → +0.8% OTM.
    // (The cumulative net-flow header — Vol/NPP/NCP — now lives inside
    // TickerNetFlowChart and is covered by its own unit tests.)
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
    // %OTM appears twice now: once in the always-visible row footer
    // (spot-at-fire moneyness chip) and once in the expanded CONTRACT
    // detail strip.
    expect(screen.getAllByText('%OTM')).toHaveLength(2);
  });

  it('shows the loading text when the tape hook is loading and series is empty', () => {
    mockUseContractTape.mockReturnValue({
      data: { series: [] },
      loading: true,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
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
      data: { series: [] },
      loading: false,
      error: 'HTTP 500',
      fetchedAt: null,
      refresh: vi.fn(),
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

  it('renders Flow → when ticker NCP === NPP at fire (flat)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          macro: makeMacro({
            mktTideDiff: 1500,
            tickerCumNcpAtFire: 3_000_000,
            tickerCumNppAtFire: 3_000_000,
          }),
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(screen.getByTestId('lottery-row-flow-chip')).toHaveTextContent(
      'Flow →',
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

describe('LotteryRow: round-tripped dim treatment', () => {
  it('dims the container and renders the round-tripped pill when deduct < 0', () => {
    render(
      <LotteryRow
        fire={makeFire({ roundTripScoreDeduct: -2 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );

    const row = screen.getByTestId('lottery-row');
    expect(row).toHaveAttribute('data-round-tripped', 'true');
    expect(row.className).toMatch(/opacity-60/);

    const pill = screen.getByTestId('lottery-row-round-tripped-pill');
    expect(pill).toHaveTextContent('round-tripped -2');
  });

  it('leaves the container at full opacity and omits the pill when deduct is 0', () => {
    render(
      <LotteryRow
        fire={makeFire({ roundTripScoreDeduct: 0 })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );

    const row = screen.getByTestId('lottery-row');
    expect(row).not.toHaveAttribute('data-round-tripped');
    expect(row.className).not.toMatch(/opacity-60/);
    expect(
      screen.queryByTestId('lottery-row-round-tripped-pill'),
    ).not.toBeInTheDocument();
  });

  it('treats missing roundTripScoreDeduct as 0 (legacy fires render normally)', () => {
    const fire = makeFire();
    delete (fire as { roundTripScoreDeduct?: number }).roundTripScoreDeduct;

    render(
      <LotteryRow
        fire={fire}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );

    const row = screen.getByTestId('lottery-row');
    expect(row).not.toHaveAttribute('data-round-tripped');
    expect(
      screen.queryByTestId('lottery-row-round-tripped-pill'),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// FIRST-FIRE HEADER ANCHOR + REIGNITES EXPANDER
// (lottery-feed-quickwins-2026-06-08)
// ============================================================

/**
 * Mirror of the component's own America/Chicago HH:mm conversion, so the
 * expected strings track the same TZ math the row renders with — no
 * hardcoded offsets that drift with DST.
 */
const ctTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  });

describe('LotteryRow: first-fire header anchor + reignites expander', () => {
  it('anchors the header timestamp on the FIRST fire, not the latest (multi-fire chain)', () => {
    const firstFireTimeCt = '2026-05-08T14:00:00Z'; // 09:00 CT
    const triggerTimeCt = '2026-05-08T16:45:00Z'; // 11:45 CT
    render(
      <LotteryRow
        fire={makeFire({
          fireCount: 3,
          firstFireTimeCt,
          triggerTimeCt,
          historicalFires: [
            {
              triggerTimeCt: firstFireTimeCt,
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
            {
              triggerTimeCt: '2026-05-08T15:10:00Z', // 10:10 CT
              entryPrice: 0.8,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    // Header shows the FIRST fire (09:00), never the latest (11:45).
    expect(
      screen.getByText(`${ctTime(firstFireTimeCt)} CT`),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(`${ctTime(triggerTimeCt)} CT`),
    ).not.toBeInTheDocument();
  });

  it('header timestamp carries a first/latest title on multi-fire chains', () => {
    const firstFireTimeCt = '2026-05-08T14:00:00Z';
    const triggerTimeCt = '2026-05-08T16:45:00Z';
    render(
      <LotteryRow
        fire={makeFire({
          fireCount: 2,
          firstFireTimeCt,
          triggerTimeCt,
          historicalFires: [
            {
              triggerTimeCt: firstFireTimeCt,
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const header = screen.getByText(`${ctTime(firstFireTimeCt)} CT`);
    expect(header.getAttribute('title')).toBe(
      `First fire ${ctTime(firstFireTimeCt)} CT · latest ${ctTime(triggerTimeCt)} CT`,
    );
  });

  it('renders a "+N reignites" toggle for a multi-fire chain (fireCount 4 → +3 reignites)', () => {
    render(
      <LotteryRow
        fire={makeFire({
          fireCount: 4,
          firstFireTimeCt: '2026-05-08T14:00:00Z',
          triggerTimeCt: '2026-05-08T16:45:00Z',
          entry: {
            price: 0.5,
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 4,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: '2026-05-08T14:00:00Z',
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
            {
              triggerTimeCt: '2026-05-08T15:10:00Z',
              entryPrice: 0.8,
              spotAtTrigger: 200,
            },
            {
              triggerTimeCt: '2026-05-08T15:55:00Z',
              entryPrice: 0.6,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    const toggle = screen.getByTestId('lottery-reignites-toggle');
    expect(toggle).toHaveTextContent('+3 reignites');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // List body is collapsed by default.
    expect(
      screen.queryByTestId('lottery-reignites-list'),
    ).not.toBeInTheDocument();
  });

  it('expanding reveals the LATER fires (historicalFires[1..] + latest) but NOT the first fire', () => {
    const firstFireTimeCt = '2026-05-08T14:00:00Z'; // 09:00 CT
    const secondFireTimeCt = '2026-05-08T15:10:00Z'; // 10:10 CT
    const thirdFireTimeCt = '2026-05-08T15:55:00Z'; // 10:55 CT
    const triggerTimeCt = '2026-05-08T16:45:00Z'; // 11:45 CT (latest)
    render(
      <LotteryRow
        fire={makeFire({
          fireCount: 4,
          firstFireTimeCt,
          triggerTimeCt,
          entry: {
            price: 0.5,
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 4,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: firstFireTimeCt,
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
            {
              triggerTimeCt: secondFireTimeCt,
              entryPrice: 0.8,
              spotAtTrigger: 200,
            },
            {
              triggerTimeCt: thirdFireTimeCt,
              entryPrice: 0.6,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    fireEvent.click(screen.getByTestId('lottery-reignites-toggle'));
    const list = screen.getByTestId('lottery-reignites-list');
    expect(list).toBeInTheDocument();
    // Later fires = slice(1) of historicalFires (10:10, 10:55) + latest (11:45).
    expect(list).toHaveTextContent(`${ctTime(secondFireTimeCt)} CT`);
    expect(list).toHaveTextContent(`${ctTime(thirdFireTimeCt)} CT`);
    expect(list).toHaveTextContent(`${ctTime(triggerTimeCt)} CT`);
    // First fire time is NOT a reignite — it's the header anchor.
    expect(list).not.toHaveTextContent(`${ctTime(firstFireTimeCt)} CT`);
    // aria-expanded flips true on the toggle.
    expect(screen.getByTestId('lottery-reignites-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('single-fire chain: no reignites toggle, header is that fire time', () => {
    const fire = makeFire(); // fireCount 1, first==latest
    render(
      <LotteryRow
        fire={fire}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    expect(
      screen.queryByTestId('lottery-reignites-toggle'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(`${ctTime(fire.triggerTimeCt)} CT`),
    ).toBeInTheDocument();
  });

  it('fireCount 2 with one historicalFires element → expander shows exactly the latest fire', () => {
    const firstFireTimeCt = '2026-05-08T14:00:00Z'; // 09:00 CT
    const triggerTimeCt = '2026-05-08T16:45:00Z'; // 11:45 CT
    render(
      <LotteryRow
        fire={makeFire({
          fireCount: 2,
          firstFireTimeCt,
          triggerTimeCt,
          entry: {
            price: 0.7,
            openInterest: 5000,
            spotAtFirst: 200,
            spotAtTrigger: 200,
            alertSeq: 2,
            minutesSincePrevFire: 10,
          },
          historicalFires: [
            {
              triggerTimeCt: firstFireTimeCt,
              entryPrice: 1.0,
              spotAtTrigger: 200,
            },
          ],
        })}
        exitPolicy="realizedTrail30_10Pct"
        marketOpen={false}
      />,
    );
    // slice(1) of a one-element historicalFires is empty → only the latest fire.
    expect(screen.getByTestId('lottery-reignites-toggle')).toHaveTextContent(
      '+1 reignite',
    );
    fireEvent.click(screen.getByTestId('lottery-reignites-toggle'));
    const list = screen.getByTestId('lottery-reignites-list');
    expect(list).toHaveTextContent(`${ctTime(triggerTimeCt)} CT`);
    expect(list).not.toHaveTextContent(`${ctTime(firstFireTimeCt)} CT`);
    // Exactly one reignite row.
    expect(list.querySelectorAll('li')).toHaveLength(1);
  });
});
