/**
 * SilentBoomSection unit tests — pragmatic smoke + key-interaction
 * coverage. The main hook (useSilentBoomFeed) is mocked so tests don't
 * trigger network calls; the heavy SilentBoomRow child is stubbed so
 * tests don't need to set up its hook trio. The Day/Regime banner
 * children are left intact (small, pure components).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SilentBoomAlert } from '../components/SilentBoom/types';

// ── Mocks ─────────────────────────────────────────────────────────────

const { mockUseSilentBoomFeed, mockUseSilentBoomTickerCounts } = vi.hoisted(
  () => ({
    mockUseSilentBoomFeed: vi.fn(),
    mockUseSilentBoomTickerCounts: vi.fn(),
  }),
);

vi.mock('../hooks/useSilentBoomFeed', () => ({
  useSilentBoomFeed: mockUseSilentBoomFeed,
}));

vi.mock('../hooks/useSilentBoomTickerCounts', () => ({
  useSilentBoomTickerCounts: mockUseSilentBoomTickerCounts,
}));

// Stub SilentBoomTickerGroup to skip the expand/collapse gate — Section
// tests cover grouping orchestration but not TickerGroup's own expand
// logic (covered separately). The stub renders the alerts directly so
// the existing row-visibility assertions remain meaningful.
vi.mock('../components/SilentBoom/SilentBoomTickerGroup', () => ({
  SilentBoomTickerGroup: ({ alerts }: { alerts: SilentBoomAlert[] }) => (
    <>
      {alerts.map((alert) => (
        <div
          key={alert.optionChainId}
          data-testid={`silent-boom-row-${alert.optionChainId}`}
          data-ticker={alert.underlyingSymbol}
        >
          {alert.underlyingSymbol} {alert.strike}
        </div>
      ))}
    </>
  ),
}));

import { SilentBoomSection } from '../components/SilentBoom';

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
    mktTideDiff: null,
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
    takeitProb: 0.75,
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
    insertedAt: '2026-05-08T14:31:00Z',
    ...overrides,
  };
}

interface DefaultHookResult {
  data: {
    alerts: SilentBoomAlert[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  refresh: ReturnType<typeof vi.fn>;
}

const defaultHookResult: DefaultHookResult = {
  data: {
    alerts: [],
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
  },
  loading: false,
  error: null,
  fetchedAt: null,
  refresh: vi.fn(),
};

/**
 * Helper for overriding the mock with a custom alerts array + total.
 * The hook now returns a nested `data` object, so test cases that
 * spread `defaultHookResult` and override the (formerly top-level)
 * `alerts` / `total` fields would silently fall through to the empty
 * default. Funneling through this builder keeps the test bodies legible.
 */
function feedResult(
  overrides: Partial<DefaultHookResult['data']> &
    Partial<Omit<DefaultHookResult, 'data'>> = {},
): DefaultHookResult {
  const { alerts, total, limit, offset, hasMore, ...rest } = overrides;
  return {
    ...defaultHookResult,
    ...rest,
    data: {
      ...defaultHookResult.data,
      ...(alerts !== undefined && { alerts }),
      ...(total !== undefined && { total }),
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset }),
      ...(hasMore !== undefined && { hasMore }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear localStorage between tests so persisted prefs don't leak
  // across cases (sortMode, convictionFloor, hideLatePm, hideGhosts,
  // minVolOi, silent-boom-ticker-expanded).
  window.localStorage.clear();
  mockUseSilentBoomFeed.mockReturnValue(defaultHookResult);
  mockUseSilentBoomTickerCounts.mockReturnValue({
    data: { tickers: [] },
    loading: false,
    error: null,
    fetchedAt: null,
    refresh: vi.fn(),
  });
});

// ============================================================
// SMOKE
// ============================================================

describe('SilentBoomSection: smoke', () => {
  it('renders the Silent Boom section heading', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /silent boom/i }),
    ).toBeInTheDocument();
  });

  it('renders the methodology link to the spec doc', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const link = screen.getByRole('link', { name: /methodology/i });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/cobriensr/Options-Strike-Calculator/blob/main/docs/superpowers/specs/silent-boom-detector-2026-05-08.md',
    );
  });

  it('renders the export anchors (filtered + all)', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/⤓ filtered/)).toBeInTheDocument();
    expect(screen.getByText(/⤓ all/)).toBeInTheDocument();
  });
});

// ============================================================
// EMPTY / LOADING / ERROR STATES
// ============================================================

describe('SilentBoomSection: states', () => {
  it('renders the empty-state copy when no alerts are returned', () => {
    mockUseSilentBoomFeed.mockReturnValue(defaultHookResult);
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/No silent-boom alerts on/i)).toBeInTheDocument();
  });

  it('renders the loading line when the hook is loading and alerts are empty', () => {
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      loading: true,
    });
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText(/Loading silent-boom feed…/i)).toBeInTheDocument();
  });

  it('renders the error alert when the hook surfaces an error', () => {
    mockUseSilentBoomFeed.mockReturnValue({
      ...defaultHookResult,
      error: 'HTTP 503',
    });
    render(<SilentBoomSection marketOpen={false} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Error: HTTP 503/);
  });
});

// ============================================================
// POPULATED — RENDER ROWS
// ============================================================

describe('SilentBoomSection: populated rendering', () => {
  it('renders one SilentBoomRow stub per alert', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        underlyingSymbol: 'AAPL',
        strike: 200,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'TSLA260508C00250000',
        underlyingSymbol: 'TSLA',
        strike: 250,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={true} />);

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// KEY INTERACTION — filter toggles
// ============================================================

describe('SilentBoomSection: filter interactions', () => {
  it('flips the hide-post-14:30 aria-pressed state when toggled', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByRole('button', { name: /hide post-14:30/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the hide-ghosts aria-pressed state when toggled', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByRole('button', { name: /hide ghosts/i });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('flips the hide-counter-trend aria-pressed state and persists to localStorage', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByTestId('silent-boom-hide-gated-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('silentBoom.hideGated')).toBe('1');
  });

  it('drops gated rows from the displayed list when hide-counter-trend is on', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        directionGated: false,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'SPY260508P00500000',
        underlyingSymbol: 'SPY',
        optionType: 'P',
        strike: 500,
        directionGated: true,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={false} />);

    // Both visible before toggling the filter.
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-SPY260508P00500000'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('silent-boom-hide-gated-chip'));

    // Only AAPL (non-gated) remains.
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-SPY260508P00500000'),
    ).not.toBeInTheDocument();
  });

  it('keeps deducted alerts visible (no mid-session hiding) and drops both hide chips', () => {
    // Both round-tripped chips were removed: deducted alerts no longer
    // vanish from view post-fire. The dim styling + round-tripped pill
    // are rendered by SilentBoomRow (covered by SilentBoomRow.test);
    // this section-level test just verifies the section keeps both rows
    // visible and the toolbar no longer carries the hide chips.
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL260508C00200000',
        roundTripScoreDeduct: 0,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'SPY260508P00500000',
        underlyingSymbol: 'SPY',
        optionType: 'P',
        strike: 500,
        roundTripScoreDeduct: -3,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={false} />);

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-SPY260508P00500000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-hide-round-tripped-chip'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-hide-round-tripped-any-dte-chip'),
    ).not.toBeInTheDocument();
  });

  it('filters to OTM-only alerts when the OTM moneyness chip is selected', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL-otm-call',
        optionType: 'C',
        strike: 210,
        underlyingPriceAtSpike: 200,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'AAPL-itm-call',
        optionType: 'C',
        strike: 195,
        underlyingPriceAtSpike: 200,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-moneyness-otm-chip'));

    expect(
      screen.getByTestId('silent-boom-row-AAPL-otm-call'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-AAPL-itm-call'),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem('silentBoom.moneynessMode')).toBe('otm');
  });

  it('filters to ITM-only alerts when the ITM moneyness chip is selected', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'SPY-otm-put',
        optionType: 'P',
        strike: 490,
        underlyingPriceAtSpike: 500,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'SPY-itm-put',
        optionType: 'P',
        strike: 510,
        underlyingPriceAtSpike: 500,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-moneyness-itm-chip'));

    expect(
      screen.getByTestId('silent-boom-row-SPY-itm-put'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-SPY-otm-put'),
    ).not.toBeInTheDocument();
  });

  it('hydrates the moneyness chip from a previously-stored localStorage value', () => {
    window.localStorage.setItem('silentBoom.moneynessMode', 'otm');
    render(<SilentBoomSection marketOpen={false} />);
    expect(
      screen.getByTestId('silent-boom-moneyness-otm-chip'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByTestId('silent-boom-moneyness-all-chip'),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides alerts with null underlyingPriceAtSpike when an OTM/ITM filter is active', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL-no-spot',
        underlyingPriceAtSpike: null,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'AAPL-otm-with-spot',
        optionType: 'C',
        strike: 210,
        underlyingPriceAtSpike: 200,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));

    render(<SilentBoomSection marketOpen={false} />);

    // Both visible under default 'all'.
    expect(
      screen.getByTestId('silent-boom-row-AAPL-no-spot'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-AAPL-otm-with-spot'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('silent-boom-moneyness-otm-chip'));

    // Row without spot is hidden; the OTM row remains.
    expect(
      screen.queryByTestId('silent-boom-row-AAPL-no-spot'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-AAPL-otm-with-spot'),
    ).toBeInTheDocument();
  });

  it('persists the conviction-floor selection to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const tier1Chip = screen.getByRole('button', { name: /Tier 1/ });
    fireEvent.click(tier1Chip);
    expect(window.localStorage.getItem('silentBoom.convictionFloor')).toBe(
      'tier1',
    );
  });

  it('persists the sort mode to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Sort mode "spike ratio" — exact-match on the chip label.
    const sortChip = screen.getByRole('button', { name: /^spike ratio$/ });
    fireEvent.click(sortChip);
    expect(window.localStorage.getItem('silentBoom.sortMode')).toBe(
      'spike_ratio',
    );
  });

  it('persists the vol/OI floor to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Vol/OI floor "≥1.0" — match the chip label.
    const volOiChip = screen.getByRole('button', { name: /^≥1\.0$/ });
    fireEvent.click(volOiChip);
    expect(window.localStorage.getItem('silentBoom.minVolOi')).toBe('1');
  });
});

// ============================================================
// EXIT-POLICY CHIP TOGGLE
// ============================================================

describe('SilentBoomSection: exit-policy chip', () => {
  it('renders all five exit-policy chip labels', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByRole('button', { name: '30m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '60m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '120m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'eod' })).toBeInTheDocument();
    // 'peak' label exists on both this chip row AND the sort chip row.
    expect(screen.getAllByRole('button', { name: 'peak' })).toHaveLength(2);
  });

  it('flips aria-pressed when an exit-policy chip is clicked', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Default is realized60mPct → 60m chip starts pressed.
    const sixtyM = screen.getByRole('button', { name: '60m' });
    expect(sixtyM).toHaveAttribute('aria-pressed', 'true');

    const thirtyM = screen.getByRole('button', { name: '30m' });
    expect(thirtyM).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(thirtyM);
    expect(thirtyM).toHaveAttribute('aria-pressed', 'true');
    expect(sixtyM).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists the exit-policy selection to localStorage when changed', () => {
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: '120m' }));
    expect(window.localStorage.getItem('silentBoom.exitPolicy')).toBe(
      'realized120mPct',
    );
  });

  it('hydrates the active chip from a previously-stored localStorage value', () => {
    window.localStorage.setItem('silentBoom.exitPolicy', 'realized120mPct');
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByRole('button', { name: '120m' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '60m' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('falls back to the realized60mPct default when localStorage holds a garbage value', () => {
    window.localStorage.setItem('silentBoom.exitPolicy', 'not-a-real-policy');
    render(<SilentBoomSection marketOpen={false} />);
    // Type guard rejects the garbage and the initializer keeps 60m active.
    expect(screen.getByRole('button', { name: '60m' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// ============================================================
// SORT MODE === 'peak' — two-tier sort (panel order + within-panel)
// ============================================================

function peakAlert(
  ticker: string,
  strike: number,
  peakCeilingPct: number | null,
  bucketCt = '2026-05-08T14:30:00Z',
): SilentBoomAlert {
  const optionChainId = `${ticker}260508C${String(strike * 1000).padStart(8, '0')}`;
  return makeAlert({
    id: strike,
    optionChainId,
    underlyingSymbol: ticker,
    strike,
    bucketCt,
    outcomes: {
      peakCeilingPct,
      minutesToPeak: null,
      realized30mPct: null,
      realized60mPct: null,
      realized120mPct: null,
      realizedEodPct: null,
      realizedTrail3010Pct: null,
      enrichedAt: null,
    },
  });
}

describe("SilentBoomSection: sortMode === 'peak' two-tier ordering", () => {
  it('orders panels by max peak desc and alerts within each panel by peak desc', () => {
    const alerts = [
      peakAlert('AAPL', 200, 80),
      peakAlert('TSLA', 250, 50),
      peakAlert('TSLA', 260, 150),
      peakAlert('SNDK', 1175, 30),
      peakAlert('RKLB', 123, null),
    ];
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: alerts.length }),
    );
    window.localStorage.setItem('silentBoom.sortMode', 'peak');

    const { container } = render(<SilentBoomSection marketOpen={false} />);
    const renderedRows = Array.from(
      container.querySelectorAll('[data-testid^="silent-boom-row-"]'),
    ) as HTMLElement[];

    // Expected: TSLA (150) → TSLA (50) → AAPL (80) → SNDK (30) → RKLB (null)
    expect(renderedRows.map((el) => el.dataset.ticker)).toEqual([
      'TSLA',
      'TSLA',
      'AAPL',
      'SNDK',
      'RKLB',
    ]);
    const tslaChainIds = renderedRows
      .filter((el) => el.dataset.ticker === 'TSLA')
      .map((el) => el.getAttribute('data-testid'));
    expect(tslaChainIds[0]).toContain('TSLA260508C00260000');
    expect(tslaChainIds[1]).toContain('TSLA260508C00250000');
  });

  it("restores conviction → recency ordering when sortMode is 'newest'", () => {
    const alerts = [
      peakAlert('AAPL', 200, 80, '2026-05-08T14:00:00Z'),
      peakAlert('TSLA', 260, 150, '2026-05-08T14:30:00Z'),
      peakAlert('SNDK', 1175, 30, '2026-05-08T15:00:00Z'),
    ];
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: alerts.length }),
    );
    // Default sortMode is 'newest'; with no conviction/storm and equal
    // alert counts, the fall-through tiebreak is latestBucketMs desc.

    const { container } = render(<SilentBoomSection marketOpen={false} />);
    const renderedRows = Array.from(
      container.querySelectorAll('[data-testid^="silent-boom-row-"]'),
    ) as HTMLElement[];

    // Expected: SNDK (15:00) → TSLA (14:30) → AAPL (14:00)
    expect(renderedRows.map((el) => el.dataset.ticker)).toEqual([
      'SNDK',
      'TSLA',
      'AAPL',
    ]);
  });
});

// ============================================================
// HIDE-COUNTER-FLOW FILTER
// ============================================================

describe('hide-counter-flow filter', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('flips aria-pressed and persists to localStorage', () => {
    mockUseSilentBoomFeed.mockReturnValue(defaultHookResult);
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByTestId('silent-boom-hide-counter-flow-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('silentBoom.hideCounterFlow')).toBe('1');
  });

  it('drops call rows when ticker NCP < NPP at fire', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'MSFT',
        optionType: 'C',
        strike: 100,
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 5_000_000,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'MSFT|2026-05-15|100|C',
      }),
      makeAlert({
        underlyingSymbol: 'MSFT',
        optionType: 'C',
        strike: 105,
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
        bucketCt: '2026-05-15T14:30:00.000Z',
        optionChainId: 'MSFT|2026-05-15|105|C',
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    // Counter-flow call (NCP < NPP) is dropped; aligned call survives.
    expect(
      screen.queryByTestId('silent-boom-row-MSFT|2026-05-15|100|C'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-MSFT|2026-05-15|105|C'),
    ).toBeInTheDocument();
  });

  it('drops put rows when ticker NCP > NPP at fire', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'AAPL',
        optionType: 'P',
        strike: 150,
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'AAPL|2026-05-15|150|P',
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 1 }));
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    // Counter-flow put (NCP > NPP) is dropped.
    expect(
      screen.queryByTestId('silent-boom-row-AAPL|2026-05-15|150|P'),
    ).not.toBeInTheDocument();
  });

  it('NEVER drops rows with null fire-time snapshot', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'TLT',
        optionType: 'C',
        strike: 95,
        tickerCumNcpAtFire: null,
        tickerCumNppAtFire: null,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'TLT|2026-05-15|95|C',
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 1 }));
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    // Null snapshot → always kept.
    expect(
      screen.getByTestId('silent-boom-row-TLT|2026-05-15|95|C'),
    ).toBeInTheDocument();
  });

  it('shows hidden-count suffix when filter active and rows hidden', () => {
    const alerts = [
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 5_000_000,
        optionChainId: 'AAPL260508C00200000',
      }),
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 2_000_000,
        tickerCumNppAtFire: 5_000_000,
        optionChainId: 'AAPL260508C00210000',
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 2 }));
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByTestId('silent-boom-hide-counter-flow-chip');
    fireEvent.click(chip);
    expect(chip).toHaveTextContent('−2');
  });
});

// ============================================================
// TAKE-IT FLOOR CHIP
// ============================================================

describe('SilentBoomSection: TAKE-IT floor filter chip', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the TAKE-IT floor chip group with default 0.70 chip active', () => {
    render(<SilentBoomSection marketOpen={false} />);
    const chip = screen.getByTestId('takeit-floor-0.7');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  it('default 0.70 floor forwards minTakeitProb=0.7 to both feed + ticker-counts hooks', () => {
    // TAKE-IT is now pushed server-side so pagination + chip totals
    // reflect the post-filter count. The chip click changes the URL
    // (via the hook), which triggers a server fetch with the new
    // floor — there is no client-side filter to assert against
    // anymore. Verify the hook contract instead.
    render(<SilentBoomSection marketOpen={false} />);

    const feedCall = mockUseSilentBoomFeed.mock.calls.at(-1);
    expect(feedCall?.[0]).toMatchObject({ minTakeitProb: 0.7 });
    const countsCall = mockUseSilentBoomTickerCounts.mock.calls.at(-1);
    expect(countsCall?.[0]).toMatchObject({ minTakeitProb: 0.7 });
  });

  it('clicking takeit-floor-0 ("all") forwards minTakeitProb=0', () => {
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('takeit-floor-0'));

    const feedCall = mockUseSilentBoomFeed.mock.calls.at(-1);
    expect(feedCall?.[0]).toMatchObject({ minTakeitProb: 0 });
    const countsCall = mockUseSilentBoomTickerCounts.mock.calls.at(-1);
    expect(countsCall?.[0]).toMatchObject({ minTakeitProb: 0 });
  });

  it('toggling takeitFloor while on page 2 resets the page to 0', () => {
    // Seed the hook with hasMore=true so the "next page" button renders.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({
        alerts: [makeAlert({ id: 1, optionChainId: 'AAPL260508C00200000' })],
        total: 100,
        hasMore: true,
      }),
    );

    render(<SilentBoomSection marketOpen={false} />);

    // Advance to page 2 via the Next button.
    const nextBtn = screen.getByRole('button', { name: /next/i });
    fireEvent.click(nextBtn);

    // Confirm the hook was called with page > 0 (page 2).
    const callAfterNext = mockUseSilentBoomFeed.mock.calls.at(-1);
    expect(callAfterNext?.[0]).toMatchObject({ page: 1 });

    // Now toggle the takeitFloor chip (switch from 0.70 to "all").
    fireEvent.click(screen.getByTestId('takeit-floor-0'));

    // The page should have reset: the hook must be called with page 0.
    const callAfterFilter = mockUseSilentBoomFeed.mock.calls.at(-1);
    expect(callAfterFilter?.[0]).toMatchObject({ page: 0 });
  });
});

// ============================================================
// COMPACT MODE — filter toolbar collapses behind CompactDisclosure
// ============================================================

describe('SilentBoomSection: compact mode', () => {
  it('does NOT render the Filters disclosure trigger in the default (non-compact) layout', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(
      screen.queryByRole('button', { name: /^Filters$/ }),
    ).not.toBeInTheDocument();
    // The filter chips render inline (e.g. the conviction Tier 1 chip).
    expect(screen.getByRole('button', { name: /Tier 1/ })).toBeInTheDocument();
  });

  it('collapses the filter chips behind the Filters trigger when compact, revealing them on click', () => {
    render(<SilentBoomSection marketOpen={false} compact />);

    // The sticky Filters trigger is present and collapsed by default.
    const trigger = screen.getByRole('button', { name: /^Filters$/ });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // A representative toolbar chip (conviction Tier 1) is hidden until
    // the disclosure is opened.
    expect(
      screen.queryByRole('button', { name: /Tier 1/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Tier 1/ })).toBeInTheDocument();
  });

  it('keeps the DATE / Live / EXPORT row + heading visible in compact mode (not collapsed)', () => {
    render(<SilentBoomSection marketOpen={false} compact />);
    // Export anchors live in the always-visible date/export row.
    expect(screen.getByText(/⤓ filtered/)).toBeInTheDocument();
    expect(screen.getByText(/⤓ all/)).toBeInTheDocument();
    // The section heading is untouched (not wrapped in the disclosure).
    expect(
      screen.getByRole('heading', { name: /silent boom/i }),
    ).toBeInTheDocument();
  });
});

// ============================================================
// PAGINATION — POST-FILTER EMPTY + PAST-LAST-PAGE RECOVERY
// ============================================================

describe('SilentBoomSection: pagination edge states', () => {
  it('renders the post-filter empty state when every server row is hidden by client chips', () => {
    // TAKE-IT is now server-side, but smaller client-only chips
    // (bucket scrub, hideGhosts, hideGated, hideCounterFlow, moneyness)
    // still apply. Use hideGhosts: a ghost print is baselineVolume <= 50
    // AND spikeRatio >= 100. Build 5 alerts that all match, enable the
    // hideGhosts chip, and assert the empty-state branch fires.
    const alerts = Array.from({ length: 5 }, (_, i) =>
      makeAlert({
        id: i + 1,
        optionChainId: `HIDDEN-${i}`,
        underlyingSymbol: 'AAPL',
        baselineVolume: 10,
        spikeRatio: 200,
      }),
    );
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: 5, hasMore: false }),
    );

    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByText(/hide ghosts/i));

    expect(
      screen.getByTestId('silent-boom-all-filtered-empty'),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^silent-boom-row-/)).toHaveLength(0);
  });

  it('renders "showing N of M" with the post-client-filter visible count, not the server slice size', () => {
    // 3 server alerts; 2 are ghost prints (stripped by hideGhosts when
    // active), 1 has a healthy baseline. Visible count should be 1 of 3.
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'V1',
        baselineVolume: 10,
        spikeRatio: 200,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'V2',
        baselineVolume: 10,
        spikeRatio: 200,
      }),
      makeAlert({
        id: 3,
        optionChainId: 'V3',
        baselineVolume: 500,
        spikeRatio: 10,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: 3, hasMore: false }),
    );

    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByText(/hide ghosts/i));

    expect(screen.getByText(/showing 1 of 3/)).toBeInTheDocument();
  });

  it('shows the past-last-page recovery when server returns 0 alerts on page > 0 and clicking back returns to the previous page', () => {
    // Differentiated mock: page 0 has one alert + hasMore=true; any
    // page > 0 returns empty (simulates the user navigating past the
    // last page).
    mockUseSilentBoomFeed.mockImplementation(({ page }: { page: number }) =>
      page > 0
        ? feedResult({ alerts: [], total: 100, hasMore: false })
        : feedResult({
            alerts: [makeAlert({ id: 1, optionChainId: 'PAGE0-ALERT' })],
            total: 100,
            hasMore: true,
          }),
    );

    render(<SilentBoomSection marketOpen={false} />);

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    expect(
      screen.getByTestId('silent-boom-past-last-page'),
    ).toBeInTheDocument();
    const backBtn = screen.getByRole('button', { name: /back one page/i });
    const jumpBtn = screen.getByRole('button', { name: /jump to page 1/i });
    expect(backBtn).toBeInTheDocument();
    expect(jumpBtn).toBeInTheDocument();

    fireEvent.click(backBtn);
    const lastCall = mockUseSilentBoomFeed.mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({ page: 0 });
  });
});
