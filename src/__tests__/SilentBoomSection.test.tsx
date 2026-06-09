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
// NEVER-VANISH — useStickyUnion accumulator (live view)
// ============================================================
//
// Once a Silent Boom alert appears in the live polling view it must stay
// rendered for the rest of the day even if a later poll omits it (server
// degrade `[]`, a takeit-gate / ask-100-demote wobble, or a transient
// empty response). The section pins alerts via useStickyUnion keyed by
// the immutable spike-bucket identity `optionChainId|bucketCt`
// (the (option_chain_id, bucket_ct) unique key the detector inserts on
// with ON CONFLICT DO NOTHING — so the row, and its id, never change once
// seen), day-scoped by storageKey. These tests drive the guarantee by
// rerendering with the mocked feed dropping a row.
//
// The default `date` is today (todayCt()), `bucketIso` is null, and
// `page` is 0 — exactly the live view where the union engages.

describe('SilentBoomSection: never-vanish accumulator', () => {
  it('keeps an alert pinned after a later poll omits it (server degrade [])', () => {
    const alertX = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    const alertY = makeAlert({
      id: 2,
      optionChainId: 'TSLA260508C00250000',
      underlyingSymbol: 'TSLA',
      strike: 250,
    });

    // Poll 1: both X and Y present.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertX, alertY], total: 2 }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();

    // Poll 2: server degrades and returns ONLY Y (X dropped). Without the
    // union X would vanish; with it, X must remain rendered.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertY], total: 1 }),
    );
    rerender(<SilentBoomSection marketOpen={true} />);

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });

  it('keeps an alert pinned when the entire feed blanks to [] on a poll', () => {
    const alertX = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertX], total: 1 }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();

    // Full degrade: empty alerts + total 0.
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts: [], total: 0 }));
    rerender(<SilentBoomSection marketOpen={true} />);

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
  });

  it('keeps two distinct buckets of the SAME chain pinned independently', () => {
    // Silent Boom is one row per (chain, bucket): two spike buckets on the
    // same option chain are DISTINCT alerts. The union key must include
    // bucketCt or the second bucket would clobber the first.
    const bucketA = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
      bucketCt: '2026-05-08T14:30:00Z',
    });
    const bucketB = makeAlert({
      id: 2,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
      bucketCt: '2026-05-08T15:05:00Z',
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [bucketA, bucketB], total: 2 }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getAllByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toHaveLength(2);

    // Poll 2 drops bucketA; both buckets must still render.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [bucketB], total: 1 }),
    );
    rerender(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getAllByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toHaveLength(2);
  });

  it('updates a pinned alert in place when it reappears with changed fields', () => {
    const alertX = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertX], total: 1 }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);
    expect(screen.getByText('AAPL 200')).toBeInTheDocument();

    // Poll 2: same chain id + bucket, changed strike-derived label. The
    // stub renders "{ticker} {strike}", so a strike bump proves the
    // in-place UPSERT (same key, refreshed value — not a second row).
    const alertXUpdated = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 205,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertXUpdated], total: 1 }),
    );
    rerender(<SilentBoomSection marketOpen={true} />);

    // Exactly one row for the chain/bucket, now showing the updated value.
    expect(
      screen.getAllByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toHaveLength(1);
    expect(screen.getByText('AAPL 205')).toBeInTheDocument();
    expect(screen.queryByText('AAPL 200')).not.toBeInTheDocument();
  });

  it('resets the union on date change so a prior day’s pinned alert is not shown', () => {
    const alertX = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertX], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();

    // Change the date input → storageKey flips → union resets to the new
    // day. The new day's feed returns nothing, so the prior day's pinned
    // alert must NOT carry over. Picking a past date also flips the view
    // to historical (union disengaged), which independently shows the raw
    // (empty) response — both paths must hide the stale row.
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts: [], total: 0 }));
    const dateInput = screen.getByLabelText(/select trading day/i);
    fireEvent.change(dateInput, { target: { value: '2026-05-07' } });

    expect(
      screen.queryByTestId('silent-boom-row-AAPL260508C00200000'),
    ).not.toBeInTheDocument();
  });

  it('counts the union: per-ticker chip count never under-counts a pinned-but-dropped alert', () => {
    const alertX = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    // Server ticker-counts endpoint reports AAPL=1 on poll 1.
    mockUseSilentBoomTickerCounts.mockReturnValue({
      data: { tickers: [{ ticker: 'AAPL', count: 1 }] },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [alertX], total: 1 }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);
    // AAPL chip shows count 1.
    expect(screen.getByTitle(/Filter to AAPL only/i)).toHaveTextContent('1');

    // Poll 2: BOTH the feed and the counts endpoint degrade to empty. The
    // union still holds AAPL, so the chip must keep AAPL with count ≥ 1.
    mockUseSilentBoomTickerCounts.mockReturnValue({
      data: { tickers: [] },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts: [], total: 0 }));
    rerender(<SilentBoomSection marketOpen={true} />);

    expect(screen.getByTitle(/Filter to AAPL only/i)).toHaveTextContent('1');
  });

  it('does not duplicate a page-0-pinned alert on page > 0 when it demotes past PAGE_SIZE', () => {
    // Pagination hole: page 0 renders the WHOLE union, so an alert pinned
    // on page 0 that later demotes past the 50-row cut is also returned by
    // the server on page 1. Without the dedup guard it shows on BOTH pages.
    const pinned = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    const tail = makeAlert({
      id: 2,
      optionChainId: 'TSLA260508C00250000',
      underlyingSymbol: 'TSLA',
      strike: 250,
    });
    // total > PAGE_SIZE so the Next button renders. Page 0 returns the
    // pinned alert (→ union); page 1 returns the SAME pinned alert
    // (demoted) plus a genuine tail alert the server only serves on p1.
    mockUseSilentBoomFeed.mockImplementation(({ page }: { page: number }) =>
      page > 0
        ? feedResult({
            alerts: [pinned, tail],
            total: 100,
            offset: 50,
            hasMore: false,
          })
        : feedResult({ alerts: [pinned], total: 100, hasMore: true }),
    );

    render(<SilentBoomSection marketOpen={true} />);
    // Page 0: pinned alert visible.
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();

    // Navigate to page 1.
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

    // The demoted pinned alert must NOT re-render on page 1 (already shown
    // via the page-0 union), but the genuine tail alert must be reachable.
    expect(
      screen.queryByTestId('silent-boom-row-AAPL260508C00200000'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });
});

// ============================================================
// NEVER-VANISH FINDINGS #1 / #3 (useNeverVanishFeed rewire)
// ============================================================
//
//   #1 filter-signature storageKey — tightening a SERVER filter rescopes
//      the union so a previously-pinned now-excluded row drops; a CLIENT
//      filter does NOT rescope.
//   #1 ticker — selecting a ticker chip (server filter) drops other-ticker
//      pinned rows.
//   #3 server-anchored pagination — union > serverTotal on the live page
//      does not advertise an unreachable page.

describe('SilentBoomSection: never-vanish findings #1/#3', () => {
  it('#1: tightening the TAKE-IT floor (server filter) drops a previously-pinned now-excluded alert', () => {
    // Pin an alert under the default 0.70 floor.
    const pinned = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [pinned], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();

    // Raise the TAKE-IT floor to 0.80 — a SERVER-SIDE filter. The new feed
    // (post-tighten) no longer returns the alert (below the stricter floor
    // server-side). With the filter-signature storageKey the union RESCOPES
    // (new slot) so the stale pin does NOT carry over. Without the sig
    // (date-only key) the row would stay pinned in the same union.
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts: [], total: 0 }));
    fireEvent.click(screen.getByTestId('takeit-floor-0.8'));

    expect(
      screen.queryByTestId('silent-boom-row-AAPL260508C00200000'),
    ).not.toBeInTheDocument();
  });

  it('#1 control: a CLIENT-only filter change (hide-ghosts) does NOT rescope the union (pin survives)', () => {
    // hide-ghosts is a CLIENT-side filter — it must NOT be in the filterSig,
    // so toggling it leaves the union intact. The pinned alert survives a
    // subsequent empty poll because the storageKey is unchanged. Use a
    // healthy-baseline alert so the hide-ghosts predicate never strips it.
    const pinned = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
      baselineVolume: 500,
      spikeRatio: 10,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [pinned], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();

    // Toggle hide-ghosts (client filter) AND degrade the feed to []. The
    // union slot is unchanged, so the pin persists.
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts: [], total: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /hide ghosts/i }));

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
  });

  it('#1 ticker: selecting a ticker chip (server filter) drops a previously-pinned other-ticker alert', () => {
    // Pin two tickers in the union under the default (no ticker) filter.
    const aapl = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    const tsla = makeAlert({
      id: 2,
      optionChainId: 'TSLA260508C00250000',
      underlyingSymbol: 'TSLA',
      strike: 250,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [aapl, tsla], total: 2 }),
    );
    // Both ticker chips must render so AAPL is clickable.
    mockUseSilentBoomTickerCounts.mockReturnValue({
      data: {
        tickers: [
          { ticker: 'AAPL', count: 1 },
          { ticker: 'TSLA', count: 1 },
        ],
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<SilentBoomSection marketOpen={true} />);
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();

    // Select the AAPL ticker chip — a SERVER-SIDE filter (forwarded to
    // useSilentBoomFeed as `ticker`). The narrowed feed returns only AAPL.
    // With the ticker in the filter-signature storageKey the union RESCOPES
    // (new slot) so the stale TSLA pin does NOT carry over. Without the
    // ticker in the sig the TSLA row would stay pinned in the same union.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [aapl], total: 1 }),
    );
    fireEvent.click(screen.getByTitle(/Filter to AAPL only/i));

    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-TSLA260508C00250000'),
    ).not.toBeInTheDocument();
  });

  it('#3: union larger than serverTotal on the live page does not advertise an unreachable page', () => {
    // Live page pins 2 alerts via the union but the server reports total=1
    // (a degrade dropped one from the reachable set). totalPages is
    // server-anchored = ceil(1 / 50) = 1, so NO pager renders even though
    // the union floors the displayed `total` at 2. Without server-anchored
    // pagination the old `ceil(total / PAGE_SIZE)` would still be 1 here, so
    // to make this non-vacuous we drive serverTotal across the PAGE_SIZE
    // boundary in the companion assertion below.
    const a1 = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    const a2 = makeAlert({
      id: 2,
      optionChainId: 'TSLA260508C00250000',
      underlyingSymbol: 'TSLA',
      strike: 250,
    });
    // Poll 1: both present, server reports a small total.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [a1, a2], total: 2, hasMore: false }),
    );
    const { rerender } = render(<SilentBoomSection marketOpen={true} />);

    // Poll 2: server degrades to a SINGLE reachable alert (total=1) but the
    // union still pins both. serverTotal=1 → totalPages=1 → no pager, and
    // crucially Next stays gated on the server `hasMore` (false), so no
    // unreachable page can be navigated to.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [a2], total: 1, hasMore: false }),
    );
    rerender(<SilentBoomSection marketOpen={true} />);

    // Both pinned rows render (never-vanish) ...
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
    // ... but the pager is suppressed: server-anchored totalPages keeps the
    // Next button from offering a page the server cannot serve.
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
  });

  it('#3 non-vacuous: server-anchored totalPages uses serverTotal, not the union-floored total', () => {
    // serverTotal = 60 (> PAGE_SIZE 50) → server-anchored totalPages = 2.
    // The union pins exactly 1 visible alert on the live page, so the
    // union-floored `total` would be max(60, 1) = 60 either way here; the
    // load-bearing distinction is that the DENOMINATOR is serverTotal. We
    // assert the pager shows "/ 2" — the server's reachable page count.
    const pinned = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [pinned], total: 60, hasMore: true }),
    );
    render(<SilentBoomSection marketOpen={true} />);

    // page 1 / 2 — ceil(60 / 50) = 2 reachable server pages.
    expect(screen.getByText(/page 1 \/ 2/)).toBeInTheDocument();
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

  it('classifies an exactly-ATM call as OTM so the filter matches the badge', () => {
    // strike === underlyingPriceAtSpike: the row badge renders this as OTM
    // (otmPct === 0 → `otmPct >= 0`), so the inclusive filter boundary must
    // surface it under the OTM chip rather than hiding it under ITM.
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL-atm-call',
        optionType: 'C',
        strike: 200,
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

    // ATM call appears under OTM (consistent with its OTM badge).
    expect(
      screen.getByTestId('silent-boom-row-AAPL-atm-call'),
    ).toBeInTheDocument();
    // The genuinely ITM call is hidden.
    expect(
      screen.queryByTestId('silent-boom-row-AAPL-itm-call'),
    ).not.toBeInTheDocument();
  });

  it('classifies an exactly-ATM put as OTM so the filter matches the badge', () => {
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'SPY-atm-put',
        optionType: 'P',
        strike: 500,
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
    fireEvent.click(screen.getByTestId('silent-boom-moneyness-otm-chip'));

    // ATM put appears under OTM (consistent with its OTM badge).
    expect(
      screen.getByTestId('silent-boom-row-SPY-atm-put'),
    ).toBeInTheDocument();
    // The genuinely ITM put is hidden.
    expect(
      screen.queryByTestId('silent-boom-row-SPY-itm-put'),
    ).not.toBeInTheDocument();
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

  it('does NOT render the saved-floor marker when the active floor is the 0.70 default', () => {
    render(<SilentBoomSection marketOpen={false} />);
    expect(
      screen.queryByTestId('silentboom-takeit-floor-saved-marker'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('silentboom-takeit-floor-reset'),
    ).not.toBeInTheDocument();
  });

  it('renders the saved-floor marker + reset control when a non-default floor is persisted', () => {
    window.localStorage.setItem('silentBoom.takeitFloor', '0.6');
    render(<SilentBoomSection marketOpen={false} />);

    const marker = screen.getByTestId('silentboom-takeit-floor-saved-marker');
    expect(marker).toHaveTextContent('saved: 0.60');

    const reset = screen.getByTestId('silentboom-takeit-floor-reset');
    expect(reset).toBeInTheDocument();
    expect(reset).toHaveAccessibleName('Reset take-it floor to 0.70');
  });

  it('clicking reset restores the floor to 0.70 and hides the marker', () => {
    window.localStorage.setItem('silentBoom.takeitFloor', '0.6');
    render(<SilentBoomSection marketOpen={false} />);

    expect(
      screen.getByTestId('silentboom-takeit-floor-saved-marker'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('silentboom-takeit-floor-reset'));

    expect(
      screen.queryByTestId('silentboom-takeit-floor-saved-marker'),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem('silentBoom.takeitFloor')).toBe('0.7');
    expect(screen.getByTestId('takeit-floor-0.7')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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

  it('hides the methodology blurb, regime banner, and day-status placeholder in compact mode', () => {
    render(<SilentBoomSection marketOpen={false} compact />);
    // 1. Methodology/description blurb.
    expect(screen.queryByText(/trade quietly/i)).not.toBeInTheDocument();
    // 2. Regime-context banner (SilentBoomRegimeBanner empty state).
    expect(
      screen.queryByText(/regime context will appear/i),
    ).not.toBeInTheDocument();
    // 3. Day-status placeholder banner (SilentBoomDayBanner empty state).
    expect(
      screen.queryByText(/no silent-boom alerts yet today/i),
    ).not.toBeInTheDocument();
  });

  it('still renders the methodology blurb + day-status placeholder in non-compact mode', () => {
    render(<SilentBoomSection marketOpen={false} />);
    // Confirms the three blocks were gated by compact, not deleted.
    expect(screen.getByText(/trade quietly/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no silent-boom alerts yet today/i),
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
