/**
 * LotteryFinderSection unit tests — pragmatic smoke + key-interaction
 * coverage. The main hook (useLotteryFinder) is mocked so tests don't
 * trigger network calls; the heavy LotteryRow child is stubbed so tests
 * don't need to set up its hook trio. The Day/Tier banner children are
 * left intact (small, pure components).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { LotteryFire } from '../components/LotteryFinder/types';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseLotteryFinder, mockUseLotteryFinderTickerCounts } = vi.hoisted(
  () => ({
    mockUseLotteryFinder: vi.fn(),
    mockUseLotteryFinderTickerCounts: vi.fn(),
  }),
);

vi.mock('../hooks/useLotteryFinder', () => ({
  useLotteryFinder: mockUseLotteryFinder,
}));

vi.mock('../hooks/useLotteryFinderTickerCounts', () => ({
  useLotteryFinderTickerCounts: mockUseLotteryFinderTickerCounts,
}));

// Stub LotteryFinderTickerGroup to skip the expand/collapse gate —
// section tests cover grouping orchestration, not TickerGroup's own
// expand logic (covered separately). The stub renders the fires
// directly so existing row-visibility assertions remain meaningful.
vi.mock('../components/LotteryFinder/LotteryFinderTickerGroup', () => ({
  LotteryFinderTickerGroup: ({ fires }: { fires: LotteryFire[] }) => (
    <>
      {fires.map((fire) => (
        <div
          key={fire.optionChainId}
          data-testid={`lottery-row-${fire.optionChainId}`}
          data-ticker={fire.underlyingSymbol}
        >
          {fire.underlyingSymbol} {fire.strike}
        </div>
      ))}
    </>
  ),
}));

import { LotteryFinderSection } from '../components/LotteryFinder/LotteryFinderSection';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeFire(overrides: Partial<LotteryFire> = {}): LotteryFire {
  return {
    id: 1,
    date: '2026-05-08',
    triggerTimeCt: '2026-05-08T19:30:00Z',
    entryTimeCt: '2026-05-08T19:31:00Z',
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
    firstFireTimeCt: '2026-05-08T19:30:00Z',
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
    macro: {
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
    insertedAt: '2026-05-08T19:31:00Z',
    ...overrides,
  };
}

const defaultHookResult = {
  fires: [] as LotteryFire[],
  loading: false,
  error: null as string | null,
  fetchedAt: null as number | null,
  total: 0,
  limit: 50,
  offset: 0,
  hasMore: false,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clear localStorage between tests so persisted prefs don't leak
  // between test cases (sortMode, convictionFloor, hideLatePm,
  // lottery-ticker-expanded).
  window.localStorage.clear();
  mockUseLotteryFinder.mockReturnValue(defaultHookResult);
  mockUseLotteryFinderTickerCounts.mockReturnValue({
    tickers: [],
    loading: false,
    error: null,
    fetchedAt: null,
    refetch: vi.fn(),
  });
});

// ============================================================
// SMOKE
// ============================================================

describe('LotteryFinderSection: smoke', () => {
  it('renders the Lottery Finder section heading', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    // SectionBox renders the label uppercased — query case-insensitively.
    expect(
      screen.getByRole('heading', { name: /lottery finder/i }),
    ).toBeInTheDocument();
  });

  it('renders the methodology link to the spec doc', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const link = screen.getByRole('link', { name: /methodology/i });
    expect(link).toHaveAttribute(
      'href',
      '/docs/superpowers/specs/lottery-finder-2026-05-02.md',
    );
  });

  it('renders the export anchors (filtered + all)', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    expect(screen.getByText(/⤓ filtered/)).toBeInTheDocument();
    expect(screen.getByText(/⤓ all/)).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY / LOADING / ERROR STATES
// ============================================================

describe('LotteryFinderSection: states', () => {
  it('renders the empty-state copy when no fires are returned and no filters are active', () => {
    mockUseLotteryFinder.mockReturnValue(defaultHookResult);
    render(<LotteryFinderSection marketOpen={false} />);
    expect(
      screen.getByText(/Either the detector hasn't fired yet today/i),
    ).toBeInTheDocument();
  });

  it('renders the loading line when the hook is loading and fires are empty', () => {
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      loading: true,
    });
    render(<LotteryFinderSection marketOpen={false} />);
    expect(screen.getByText(/Loading lottery feed…/i)).toBeInTheDocument();
  });

  it('renders the error alert when the hook surfaces an error', () => {
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      error: 'HTTP 503',
    });
    render(<LotteryFinderSection marketOpen={false} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Error: HTTP 503/);
  });
});

// ============================================================
// POPULATED — RENDER ROWS
// ============================================================

describe('LotteryFinderSection: populated rendering', () => {
  it('renders one LotteryRow stub per fire and the count summary', () => {
    const fires = [
      makeFire({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        underlyingSymbol: 'AAPL',
        strike: 200,
      }),
      makeFire({
        id: 2,
        optionChainId: 'TSLA260508C00250000',
        underlyingSymbol: 'TSLA',
        strike: 250,
      }),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: 2,
    });

    render(<LotteryFinderSection marketOpen={true} />);

    expect(
      screen.getByTestId('lottery-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — filter toggles
// ============================================================

describe('LotteryFinderSection: filter interactions', () => {
  it('flips the cheap-call-PM aria-pressed state when the filter chip is toggled', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const chip = screen.getByRole('button', {
      name: /Cheap-call-PM only/i,
    });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the RE-LOAD only aria-pressed state when toggled', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const chip = screen.getByRole('button', { name: /RE-LOAD only/i });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists the conviction-floor selection to localStorage when changed', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const tier1Chip = screen.getByRole('button', { name: /Tier 1/ });
    fireEvent.click(tier1Chip);
    expect(window.localStorage.getItem('lottery.convictionFloor')).toBe(
      'tier1',
    );
  });

  it('persists the sort mode to localStorage when changed', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    // Sort mode "score" — exact-match on the chip label.
    const sortChip = screen.getByRole('button', { name: /^score$/ });
    fireEvent.click(sortChip);
    expect(window.localStorage.getItem('lottery.sortMode')).toBe('score');
  });

  it('flips the hide-counter-trend aria-pressed state and persists to localStorage', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const chip = screen.getByTestId('lottery-hide-gated-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('lottery.hideGated')).toBe('1');
  });

  it('drops gated rows from the displayed list when hide-counter-trend is on', () => {
    const fires = [
      makeFire({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        directionGated: false,
      }),
      makeFire({
        id: 2,
        optionChainId: 'SPY260508P00500000',
        underlyingSymbol: 'SPY',
        optionType: 'P',
        strike: 500,
        directionGated: true,
      }),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: 2,
    });

    render(<LotteryFinderSection marketOpen={false} />);

    // Both tickers rendered before toggling.
    expect(
      screen.getByTestId('lottery-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-SPY260508P00500000'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lottery-hide-gated-chip'));

    // Only AAPL (non-gated) remains.
    expect(
      screen.getByTestId('lottery-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-SPY260508P00500000'),
    ).not.toBeInTheDocument();
  });

  it('default ON: chip starts aria-pressed=true; flipping OFF persists "0"', () => {
    // Phase 3 default-on (post-2E soak result: deducted alerts had
    // +11.4pp trail-loss vs baseline → safer to hide by default).
    render(<LotteryFinderSection marketOpen={false} />);
    const chip = screen.getByTestId('lottery-hide-round-tripped-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('lottery.hideRoundTripped')).toBe('0');
  });

  it('drops fires with roundTripScoreDeduct < 0 by default; toggle OFF reveals them', () => {
    const fires = [
      makeFire({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        roundTripScoreDeduct: 0,
      }),
      makeFire({
        id: 2,
        optionChainId: 'SPY260508P00500000',
        underlyingSymbol: 'SPY',
        optionType: 'P',
        strike: 500,
        roundTripScoreDeduct: -3,
      }),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: 2,
    });

    render(<LotteryFinderSection marketOpen={false} />);

    // Default ON — deducted alert is hidden on initial render.
    expect(
      screen.getByTestId('lottery-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-SPY260508P00500000'),
    ).not.toBeInTheDocument();

    // Flip the chip OFF — both alerts now visible.
    fireEvent.click(screen.getByTestId('lottery-hide-round-tripped-chip'));

    expect(
      screen.getByTestId('lottery-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('lottery-row-SPY260508P00500000'),
    ).toBeInTheDocument();
  });

  it('flips the aggressive-premium aria-pressed state and persists to localStorage', () => {
    render(<LotteryFinderSection marketOpen={false} />);
    const chip = screen.getByTestId('lottery-aggressive-premium-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('lottery.aggressivePremium')).toBe('1');
  });

  it('keeps only fires matching the aggressive-premium predicate', () => {
    // Default makeFire matches the predicate: estPremium = 0.85 * 1.5 *
    // 5000 * 100 = $637,500 ≥ $50K, DTE=0 ≤ 3, tier2, OTM (200 > 198.5).
    const matching = makeFire({
      id: 1,
      optionChainId: 'AAPL-match',
    });
    // Too cheap: drop estimated premium below $50K by halving openInterest
    // (and dropping volToOiWindow). 0.85 × 0.5 × 1000 × 100 = $42.5.
    const tooCheap = makeFire({
      id: 2,
      optionChainId: 'AAPL-cheap',
      trigger: { ...matching.trigger, volToOiWindow: 0.5 },
      entry: { ...matching.entry, openInterest: 1000 },
    });
    // Tier 3 — excluded regardless of premium size.
    const tier3 = makeFire({
      id: 3,
      optionChainId: 'AAPL-tier3',
      score: 5,
      scoreTier: 'tier3',
    });
    // ITM call (strike below spot) — excluded by OTM gate.
    const itm = makeFire({
      id: 4,
      optionChainId: 'AAPL-itm',
      strike: 195,
    });
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires: [matching, tooCheap, tier3, itm],
      total: 4,
    });

    render(<LotteryFinderSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('lottery-aggressive-premium-chip'));

    expect(screen.getByTestId('lottery-row-AAPL-match')).toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-AAPL-cheap'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-AAPL-tier3'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-AAPL-itm'),
    ).not.toBeInTheDocument();
  });

  it('filters to OTM-only fires when the OTM moneyness chip is selected', () => {
    const fires = [
      makeFire({
        id: 1,
        optionChainId: 'AAPL-otm',
        optionType: 'C',
        strike: 205,
        entry: {
          price: 0.85,
          openInterest: 5000,
          spotAtFirst: 200,
          alertSeq: 7,
          minutesSincePrevFire: 30,
        },
      }),
      makeFire({
        id: 2,
        optionChainId: 'AAPL-itm',
        optionType: 'C',
        strike: 195,
        entry: {
          price: 0.85,
          openInterest: 5000,
          spotAtFirst: 200,
          alertSeq: 7,
          minutesSincePrevFire: 30,
        },
      }),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: 2,
    });

    render(<LotteryFinderSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('lottery-moneyness-otm-chip'));

    expect(screen.getByTestId('lottery-row-AAPL-otm')).toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-AAPL-itm'),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem('lottery.moneynessMode')).toBe('otm');
  });

  it('hydrates the moneyness chip from a previously-stored localStorage value', () => {
    window.localStorage.setItem('lottery.moneynessMode', 'itm');
    render(<LotteryFinderSection marketOpen={false} />);
    expect(screen.getByTestId('lottery-moneyness-itm-chip')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('lottery-moneyness-all-chip')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('no longer renders the hide-range-bottom chip (retired 2026-05-16)', () => {
    // The hide-range-bottom chip + its -3 score penalty were retired
    // after the EDA rerun showed no edge at the bottom-10% cohort
    // (the original finding was a dimensional-bug artifact).
    // See ml/findings/eda-rerun-2026-05-16/.
    render(<LotteryFinderSection marketOpen={false} />);
    expect(
      screen.queryByTestId('lottery-hide-range-bottom-chip'),
    ).not.toBeInTheDocument();
  });

  it('filters to ITM-only fires when the ITM moneyness chip is selected', () => {
    const fires = [
      makeFire({
        id: 1,
        optionChainId: 'SPY-otm-put',
        optionType: 'P',
        strike: 490,
        entry: {
          price: 0.85,
          openInterest: 5000,
          spotAtFirst: 500,
          alertSeq: 7,
          minutesSincePrevFire: 30,
        },
      }),
      makeFire({
        id: 2,
        optionChainId: 'SPY-itm-put',
        optionType: 'P',
        strike: 510,
        entry: {
          price: 0.85,
          openInterest: 5000,
          spotAtFirst: 500,
          alertSeq: 7,
          minutesSincePrevFire: 30,
        },
      }),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: 2,
    });

    render(<LotteryFinderSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('lottery-moneyness-itm-chip'));

    expect(screen.getByTestId('lottery-row-SPY-itm-put')).toBeInTheDocument();
    expect(
      screen.queryByTestId('lottery-row-SPY-otm-put'),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// SORT MODE === 'peak' — two-tier sort (panel order + within-panel)
// ============================================================

/**
 * Helper to build a fire with a peakCeilingPct override and a unique
 * chain id, so a multi-ticker fixture renders distinct rows we can
 * assert DOM order on.
 */
function peakFire(
  ticker: string,
  strike: number,
  peakCeilingPct: number | null,
  triggerTimeCt = '2026-05-08T19:30:00Z',
) {
  const optionChainId = `${ticker}260508C${String(strike * 1000).padStart(8, '0')}`;
  return makeFire({
    id: strike,
    optionChainId,
    underlyingSymbol: ticker,
    strike,
    triggerTimeCt,
    outcomes: {
      realizedTrail30_10Pct: null,
      realizedHard30mPct: null,
      realizedTier50HoldEodPct: null,
      realizedFlowInversionPct: null,
      realizedEodPct: null,
      peakCeilingPct,
      minutesToPeak: null,
      enrichedAt: '2026-05-08T20:00:00Z',
    },
  });
}

describe("LotteryFinderSection: sortMode === 'peak' two-tier ordering", () => {
  it('orders panels by max peak desc and fires within each panel by peak desc', () => {
    // 4 tickers with varying peakBest:
    //   AAPL: max 80 (single fire)
    //   TSLA: max 150 (two fires: 150 + 50; tests within-panel sort)
    //   SNDK: max 30 (single fire)
    //   RKLB: all-null peaks (single fire) — must sort last
    const fires = [
      peakFire('AAPL', 200, 80),
      peakFire('TSLA', 250, 50),
      peakFire('TSLA', 260, 150),
      peakFire('SNDK', 1175, 30),
      peakFire('RKLB', 123, null),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: fires.length,
    });

    // Pre-set sortMode=peak via localStorage so the section boots into
    // that mode without a UI click.
    window.localStorage.setItem('lottery.sortMode', 'peak');

    const { container } = render(<LotteryFinderSection marketOpen={false} />);

    // Pull the rendered ticker rows in DOM order.
    const renderedRows = Array.from(
      container.querySelectorAll('[data-testid^="lottery-row-"]'),
    ) as HTMLElement[];

    // Expected order:
    //   TSLA 260 (peak 150)  ← TSLA panel, within: 150 first
    //   TSLA 250 (peak 50)
    //   AAPL 200 (peak 80)   ← AAPL panel
    //   SNDK 1175 (peak 30)  ← SNDK panel
    //   RKLB 123 (null)      ← all-null panel last
    expect(renderedRows.map((el) => el.dataset.ticker)).toEqual([
      'TSLA',
      'TSLA',
      'AAPL',
      'SNDK',
      'RKLB',
    ]);
    // Within the TSLA panel, the 150-peak fire must come before 50.
    const tslaChainIds = renderedRows
      .filter((el) => el.dataset.ticker === 'TSLA')
      .map((el) => el.getAttribute('data-testid'));
    expect(tslaChainIds[0]).toContain('TSLA260508C00260000');
    expect(tslaChainIds[1]).toContain('TSLA260508C00250000');
  });

  it("restores conviction → count ordering when sortMode flips back to 'score'", () => {
    // Same fire set as above. Under 'score' (or any non-peak sort),
    // the previous conviction/storm/count/recency rule applies. With
    // no conviction or storm flags and equal fire counts, the
    // tiebreak falls through to latestTriggerMs desc — so we vary
    // triggerTimeCt to make the order deterministic.
    const fires = [
      peakFire('AAPL', 200, 80, '2026-05-08T19:00:00Z'),
      peakFire('TSLA', 260, 150, '2026-05-08T19:30:00Z'),
      peakFire('SNDK', 1175, 30, '2026-05-08T20:00:00Z'),
    ];
    mockUseLotteryFinder.mockReturnValue({
      ...defaultHookResult,
      fires,
      total: fires.length,
    });

    // Default sortMode is 'chronological' which uses the same fall-
    // through ordering — newest trigger wins on the count tiebreak.
    const { container } = render(<LotteryFinderSection marketOpen={false} />);
    const renderedRows = Array.from(
      container.querySelectorAll('[data-testid^="lottery-row-"]'),
    ) as HTMLElement[];

    // Each ticker is a 1-fire group. Expected order (latest first):
    //   SNDK (20:00) → TSLA (19:30) → AAPL (19:00)
    expect(renderedRows.map((el) => el.dataset.ticker)).toEqual([
      'SNDK',
      'TSLA',
      'AAPL',
    ]);
  });
});
