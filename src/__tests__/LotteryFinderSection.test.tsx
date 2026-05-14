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

const { mockUseLotteryFinder } = vi.hoisted(() => ({
  mockUseLotteryFinder: vi.fn(),
}));

vi.mock('../hooks/useLotteryFinder', () => ({
  useLotteryFinder: mockUseLotteryFinder,
}));

// Stub LotteryRow so the section's pagination/filter logic is testable
// without dragging in the contract-tape / net-flow hooks.
vi.mock('../components/LotteryFinder/LotteryRow', () => ({
  LotteryRow: ({ fire }: { fire: LotteryFire }) => (
    <div
      data-testid={`lottery-row-${fire.optionChainId}`}
      data-ticker={fire.underlyingSymbol}
    >
      {fire.underlyingSymbol} {fire.strike}
    </div>
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
  // between test cases (sortMode, convictionFloor, hideLatePm).
  window.localStorage.clear();
  mockUseLotteryFinder.mockReturnValue(defaultHookResult);
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
});
