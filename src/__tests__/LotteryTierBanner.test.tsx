import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LotteryTierBanner } from '../components/LotteryFinder/LotteryTierBanner';
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

describe('LotteryTierBanner: empty state', () => {
  it('renders empty-state line when fires array is empty', () => {
    render(<LotteryTierBanner fires={[]} total={0} />);
    expect(
      screen.getByText(
        'No lottery fires yet today — banner populates with the first fire.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the headline when no fires', () => {
    render(<LotteryTierBanner fires={[]} total={0} />);
    expect(screen.queryByText(/Day so far/)).not.toBeInTheDocument();
  });
});

// ============================================================
// SINGULAR vs PLURAL
// ============================================================

describe('LotteryTierBanner: singular vs plural', () => {
  it('renders "1 fire" (no s) when total === 1', () => {
    render(
      <LotteryTierBanner
        fires={[makeFire({ scoreTier: 'tier1', score: 20 })]}
        total={1}
      />,
    );
    expect(screen.getByText(/Day so far · 1 fire$/)).toBeInTheDocument();
  });

  it('renders "N fires" (with s) when total > 1', () => {
    render(
      <LotteryTierBanner
        fires={[
          makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
          makeFire({ id: 2, scoreTier: 'tier2', score: 14 }),
        ]}
        total={2}
      />,
    );
    expect(screen.getByText(/Day so far · 2 fires/)).toBeInTheDocument();
  });

  it('formats large totals with toLocaleString', () => {
    // 1234 → "1,234 fires" (locale-dependent — toLocaleString in jsdom
    // defaults to en-US which uses comma group separators).
    render(
      <LotteryTierBanner
        fires={[makeFire({ scoreTier: 'tier3', score: 8 })]}
        total={1234}
      />,
    );
    expect(screen.getByText(/Day so far · 1,234 fires/)).toBeInTheDocument();
  });
});

// ============================================================
// TIER COUNTS
// ============================================================

describe('LotteryTierBanner: tier counts', () => {
  it('counts tier1, tier2, tier3 correctly across mixed fires', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, scoreTier: 'tier1', score: 20 }),
      makeFire({ id: 2, scoreTier: 'tier1', score: 19 }),
      makeFire({ id: 3, scoreTier: 'tier2', score: 14 }),
      makeFire({ id: 4, scoreTier: 'tier3', score: 6 }),
      makeFire({ id: 5, scoreTier: 'tier3', score: 5 }),
      makeFire({ id: 6, scoreTier: 'tier3', score: 4 }),
    ];
    render(<LotteryTierBanner fires={fires} total={6} />);

    expect(screen.getByText('🔥🔥🔥 2')).toBeInTheDocument();
    expect(screen.getByText('🔥🔥 1')).toBeInTheDocument();
    expect(screen.getByText('🔥 3')).toBeInTheDocument();
  });
});

// ============================================================
// DOMINANT TICKER
// ============================================================

describe('LotteryTierBanner: dominant ticker', () => {
  it('picks the ticker with the highest count as dominant', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: 20 }),
      makeFire({ id: 2, underlyingSymbol: 'AAPL', score: 18 }),
      makeFire({ id: 3, underlyingSymbol: 'AAPL', score: 15 }),
      makeFire({ id: 4, underlyingSymbol: 'TSLA', score: 12 }),
      makeFire({ id: 5, underlyingSymbol: 'NVDA', score: 8 }),
    ];
    render(<LotteryTierBanner fires={fires} total={5} />);

    // AAPL appears 3x, dominant — verify the ×3 count is rendered.
    // Note: "AAPL" appears in both the dominant-ticker pill AND the
    // top-score pill (since the top-scoring fire is also AAPL), so we
    // assert via getAllByText rather than getByText.
    expect(screen.getAllByText('AAPL').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('×3')).toBeInTheDocument();
    // TSLA / NVDA should not appear in the dominant pill as ×1.
    expect(screen.queryByText('×1')).not.toBeInTheDocument();
  });
});

// ============================================================
// TOP FIRE BY SCORE
// ============================================================

describe('LotteryTierBanner: top fire', () => {
  it('selects the fire with the highest score as top', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: 12 }),
      makeFire({ id: 2, underlyingSymbol: 'TSLA', score: 22 }),
      makeFire({ id: 3, underlyingSymbol: 'NVDA', score: 18 }),
    ];
    render(<LotteryTierBanner fires={fires} total={3} />);

    // Top score should be 22 from TSLA.
    expect(screen.getByText('22')).toBeInTheDocument();
    // The "top score:" tooltip should reference the top-scoring fire.
    const tslaSpans = screen.getAllByText('TSLA');
    expect(tslaSpans.length).toBeGreaterThan(0);
  });

  it('treats null scores as -Infinity so a real-scored fire wins', () => {
    const fires: LotteryFire[] = [
      makeFire({ id: 1, underlyingSymbol: 'AAPL', score: null }),
      makeFire({ id: 2, underlyingSymbol: 'TSLA', score: 5 }),
    ];
    render(<LotteryTierBanner fires={fires} total={2} />);

    // TSLA (score 5) wins over AAPL (null).
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});

// ============================================================
// FOOTER
// ============================================================

describe('LotteryTierBanner: footer', () => {
  it('renders the "counts on current page" footer text', () => {
    render(
      <LotteryTierBanner
        fires={[makeFire({ scoreTier: 'tier2', score: 13 })]}
        total={1}
      />,
    );
    expect(screen.getByText('counts on current page')).toBeInTheDocument();
  });
});
