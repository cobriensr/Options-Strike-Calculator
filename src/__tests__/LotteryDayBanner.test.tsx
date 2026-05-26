import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LotteryDayBanner } from '../components/LotteryFinder/LotteryDayBanner';
import type {
  LotteryFire,
  LotteryFireMacro,
} from '../components/LotteryFinder/types';

// ── Fixture factory ──────────────────────────────────────────

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
      price: 1.5,
      openInterest: 5000,
      spotAtFirst: 198,
      spotAtTrigger: 198,
      alertSeq: 1,
      minutesSincePrevFire: 30,
    },
    tags: {
      flowQuad: 'call_ask',
      tod: 'AM_open',
      mode: 'A_intraday_0DTE',
      reload: false,
      cheapCallPm: false,
      burstRatioVsPrev: null,
      entryDropPctVsPrev: null,
    },
    macro: makeMacro(),
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
      realizedTrail30_10Pct: null,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: null,
      peakCeilingPct: null,
      minutesToPeak: null,
      enrichedAt: null,
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

// ============================================================
// EMPTY STATE
// ============================================================

describe('LotteryDayBanner: empty state', () => {
  it('renders the empty-state line when fires array is empty', () => {
    render(<LotteryDayBanner fires={[]} />);
    expect(
      screen.getByText(
        'Regime context will appear with the first fire of the day.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the headline when there are no fires', () => {
    render(<LotteryDayBanner fires={[]} />);
    expect(screen.queryByText('Regime today')).not.toBeInTheDocument();
  });
});

// ============================================================
// POPULATED STATE — basic structure
// ============================================================

describe('LotteryDayBanner: populated state', () => {
  it('renders the "Regime today" headline when at least one fire exists', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({
              mktTideDiff: 1500,
              zeroDteDiff: -250,
              spxSpotGammaOi: 1,
            }),
          }),
        ]}
      />,
    );
    expect(screen.getByText('Regime today')).toBeInTheDocument();
  });

  it('renders the display-only methodology footer', () => {
    render(<LotteryDayBanner fires={[makeFire()]} />);
    expect(
      screen.getByText('display-only — see methodology'),
    ).toBeInTheDocument();
  });

  it('uses the latest fire by triggerTimeCt for macro context', () => {
    // Earlier fire has positive tide; later fire has negative tide.
    // The label should reflect the LATER fire's value.
    const earlier = makeFire({
      id: 1,
      triggerTimeCt: '2026-05-08T13:00:00Z',
      macro: makeMacro({ mktTideDiff: 999_999 }),
    });
    const later = makeFire({
      id: 2,
      triggerTimeCt: '2026-05-08T15:00:00Z',
      macro: makeMacro({ mktTideDiff: -2500 }),
    });
    render(<LotteryDayBanner fires={[earlier, later]} />);
    // "-2.5k" is from the LATER fire; if we used the earlier fire we'd
    // have rendered "+1.0M".
    expect(screen.getByText(/Market Tide ⬇ -2\.5k/)).toBeInTheDocument();
    expect(screen.queryByText(/\+1\.0M/)).not.toBeInTheDocument();
  });
});

// ============================================================
// DayMetric: signed format — positive / negative / zero
// ============================================================

describe('LotteryDayBanner: signed format branches', () => {
  it('renders positive signed value with up arrow and green class', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: 1500 }),
          }),
        ]}
      />,
    );
    // 1500 → +1.5k with up arrow
    const el = screen.getByText(/Market Tide ⬆ \+1\.5k/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-green-300');
  });

  it('renders negative signed value with down arrow and red class', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: -2_500_000 }),
          }),
        ]}
      />,
    );
    // -2_500_000 → -2.5M with down arrow
    const el = screen.getByText(/Market Tide ⬇ -2\.5M/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-red-300');
  });

  it('renders zero signed value with rightward arrow and neutral class', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: 0 }),
          }),
        ]}
      />,
    );
    // 0 → +0 with → arrow (neutral)
    const el = screen.getByText(/Market Tide → \+0/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-neutral-300');
  });
});

// ============================================================
// DayMetric: sign-only format — positive / negative / zero
// ============================================================

describe('LotteryDayBanner: sign-only format branches', () => {
  it('renders positive sign-only value with green dot', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ spxSpotGammaOi: 1 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/SPX Gamma 🟢/)).toBeInTheDocument();
  });

  it('renders negative sign-only value with red dot', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ spxSpotGammaOi: -1 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/SPX Gamma 🔴/)).toBeInTheDocument();
  });

  it('renders zero sign-only value with white dot', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ spxSpotGammaOi: 0 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/SPX Gamma ⚪/)).toBeInTheDocument();
  });
});

// ============================================================
// DayMetric: null value (no-data branch)
// ============================================================

describe('LotteryDayBanner: no-data branch', () => {
  it('renders an em-dash placeholder when value is null', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({
              mktTideDiff: null,
              zeroDteDiff: null,
              spxSpotGammaOi: null,
            }),
          }),
        ]}
      />,
    );
    // All three macro values null → all three "Label —" placeholders render.
    expect(screen.getByText('Market Tide —')).toBeInTheDocument();
    expect(screen.getByText('0DTE Flow —')).toBeInTheDocument();
    expect(screen.getByText('SPX Gamma —')).toBeInTheDocument();
  });

  it('null-value placeholder has the no-data tooltip suffix', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: null }),
          }),
        ]}
      />,
    );
    const el = screen.getByText('Market Tide —');
    expect(el.getAttribute('title')).toContain(
      'no data — early-session fire before macro tables populated',
    );
  });
});

// ============================================================
// formatLarge: 3 magnitude branches (>=1M, >=1k, <1k)
// ============================================================

describe('LotteryDayBanner: formatLarge magnitude branches', () => {
  it('formats values >= 1M with M suffix and 1 decimal', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: 1_500_000 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Market Tide ⬆ \+1\.5M/)).toBeInTheDocument();
  });

  it('formats values >= 1k (and < 1M) with k suffix and 1 decimal', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: 12_500 }),
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Market Tide ⬆ \+12\.5k/)).toBeInTheDocument();
  });

  it('formats small values (< 1k) without a magnitude suffix', () => {
    render(
      <LotteryDayBanner
        fires={[
          makeFire({
            macro: makeMacro({ mktTideDiff: 42 }),
          }),
        ]}
      />,
    );
    // No suffix; rounded to integer
    expect(screen.getByText(/Market Tide ⬆ \+42/)).toBeInTheDocument();
  });
});
