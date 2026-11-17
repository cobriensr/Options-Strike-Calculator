/**
 * SilentBoomSection unit tests — pragmatic smoke + key-interaction
 * coverage. The main hook (useSilentBoomFeed) is mocked so tests don't
 * trigger network calls; the heavy SilentBoomRow child is stubbed so
 * tests don't need to set up its hook trio. The Day/Regime banner
 * children are left intact (small, pure components).
 */

import { Profiler } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getETToday } from '../utils/timezone';
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

// The never-vanish union is only ENGAGED on the live day, and its hard-floor
// / cross-day `retain` guard purges any pinned alert whose `a.date` is not the
// engaged day. Engaged-path fixtures must therefore be dated to TODAY (ET) or
// the guard correctly drops them. Computed like the panel's `today` (the
// shared ET clock): silent-boom alerts are stamped with the ET date, which
// differs from the CT date from 23:00 to 24:00 CT. `bucketCt` is only a
// union-key segment + TOD-display source, so it is left at a fixed value
// (retain keys off `date`, not `bucketCt`).
const TODAY_ET = getETToday();

function makeAlert(overrides: Partial<SilentBoomAlert> = {}): SilentBoomAlert {
  return {
    id: 1,
    date: TODAY_ET,
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
// ACTIVE-FILTER CHIP LABELS (header)
// ============================================================
//
// Silent Boom has NO server-side `suppressedCount` (it's immune to the
// chain-collapse the Lottery feed suffers — see the `clientHiddenCount`
// note in index.tsx). It DOES carry the same active-filter chip labels
// in its header as the Lottery section: a convictionFloor label and a
// TAKE-IT floor label. Mirrors the Lottery suite's chip-label coverage.

describe('SilentBoomSection: active-filter chip labels', () => {
  function makeBasicAlert(): SilentBoomAlert {
    return makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
  }

  it('chip label: "(Tier 1 only)" renders when convictionFloor = tier1', () => {
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [makeBasicAlert()], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Tier 1/ }));
    expect(screen.getByText('(Tier 1 only)')).toBeInTheDocument();
  });

  it('chip label: "(Tier 2+)" renders when convictionFloor = tier2', () => {
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [makeBasicAlert()], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Tier 2/ }));
    expect(screen.getByText('(Tier 2+)')).toBeInTheDocument();
  });

  it('chip label: no conviction label when floor is "all" (default)', () => {
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [makeBasicAlert()], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.queryByText('(Tier 1 only)')).not.toBeInTheDocument();
    expect(screen.queryByText('(Tier 2+)')).not.toBeInTheDocument();
  });

  it('chip label: "(TAKE-IT ≥ 0.70)" renders for the default floor when alerts present', () => {
    // Default takeitFloor is 0.70 (> 0) → the header carries the floor label.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [makeBasicAlert()], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={false} />);
    expect(screen.getByText('(TAKE-IT ≥ 0.70)')).toBeInTheDocument();
  });

  it('chip label: "(TAKE-IT ≥ ...)" omitted once the "all" preset (floor 0) is selected', () => {
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [makeBasicAlert()], total: 1 }),
    );
    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('takeit-floor-0'));
    expect(screen.queryByText(/TAKE-IT ≥/)).not.toBeInTheDocument();
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
// The default `date` is today, `bucketIso` is null, and `page` is 0 —
// exactly the live view where the union engages.

describe('SilentBoomSection: never-vanish accumulator', () => {
  it('hard-floor retain: a sub-floor alert is never pinned even though the server reports it', () => {
    // Pre-set the premium floor to $1K so the union engages with the floor
    // active. Sub-floor alert premium = entryPrice(0.05) × spikeVolume(100) ×
    // 100 = $500 — below the $1000 floor; a qualifying alert clears it.
    window.localStorage.setItem('silentBoom.minPremiumK', '1');

    const subFloor = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
      entryPrice: 0.05,
      spikeVolume: 100,
    });
    const qualifying = makeAlert({
      id: 2,
      optionChainId: 'TSLA260508C00250000',
      underlyingSymbol: 'TSLA',
      strike: 250,
      entryPrice: 1.5,
      spikeVolume: 1500, // premium $225K ≥ floor
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [subFloor, qualifying], total: 2 }),
    );

    render(<SilentBoomSection marketOpen={true} />);

    // The hard-floor retain guard drops the sub-floor alert from the union ...
    expect(
      screen.queryByTestId('silent-boom-row-AAPL260508C00200000'),
    ).not.toBeInTheDocument();
    // ... while the qualifying alert renders normally.
    expect(
      screen.getByTestId('silent-boom-row-TSLA260508C00250000'),
    ).toBeInTheDocument();
  });

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

  it('live mode renders the whole union on a single page with no pager (server total > PAGE_SIZE)', () => {
    // The live (engaged) feed is a single never-vanish union that already
    // renders everything on one page. Literal server pages never made sense
    // there: page 0 rendered the whole union while pages ≥ 1 rendered a
    // server slice the page-0 union deduped away → phantom empty pages. The
    // fix removes the pager entirely in engaged mode, so a server total above
    // PAGE_SIZE no longer surfaces a pager (and no phantom pages).
    const pinned = makeAlert({
      id: 1,
      optionChainId: 'AAPL260508C00200000',
      underlyingSymbol: 'AAPL',
      strike: 200,
    });
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts: [pinned], total: 100, hasMore: true }),
    );

    render(<SilentBoomSection marketOpen={true} />);
    // The union row renders ...
    expect(
      screen.getByTestId('silent-boom-row-AAPL260508C00200000'),
    ).toBeInTheDocument();
    // ... but no pager: no Next/Prev buttons, no "page X / Y" label, and no
    // phantom empty / past-last-page states.
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /previous page/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/page \d+ \/ \d+/)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-past-last-page'),
    ).not.toBeInTheDocument();
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

  it('#3: union larger than serverTotal in live mode renders no pager', () => {
    // Live page pins 2 alerts via the union but the server later degrades to
    // total=1. The live view is a single never-vanish page, so the pager is
    // suppressed entirely regardless of the server total — there is no Next
    // button to offer a page the server cannot serve.
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
    // union still pins both.
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
    // ... but no pager in the engaged (live) view.
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
  });

  it('#3: a large server total in live mode still renders no pager', () => {
    // serverTotal = 60 (> PAGE_SIZE 50). Pre-fix this surfaced a "page 1 / 2"
    // pager in the live view and a phantom near-empty page 2. The engaged
    // view is now a single never-vanish page, so no pager renders.
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

    expect(screen.queryByText(/page \d+ \/ \d+/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
  });

  it('historical full-day view still paginates over the raw server slice', () => {
    // On a past trading day the feed leaves the never-vanish union and
    // renders the raw, server-paginated slice. There the pager is
    // server-anchored and never buggy, so it must still appear when the
    // server reports more than one page.
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

    // Switch to a historical day (disengages the union). bucketIso stays null
    // so this is the full-day historical view.
    fireEvent.change(screen.getByLabelText(/select trading day/i), {
      target: { value: '2026-05-08' },
    });

    // serverTotal(60) > PAGE_SIZE(50) → 2 reachable server pages.
    expect(screen.getByText(/page 1 \/ 2/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next page/i }),
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

  it('hides AND counts alerts with an unusable spot (≤ 0 or NaN) under an OTM/ITM filter', () => {
    // Filter drop condition and the "−N hidden (no spot)" count now both
    // route through usableSpot(), so a non-finite/≤0 spot must be dropped
    // by the filter AND tallied in the chip's hidden count — they agree.
    const alerts = [
      makeAlert({
        id: 1,
        optionChainId: 'AAPL-zero-spot',
        optionType: 'C',
        strike: 210,
        underlyingPriceAtSpike: 0,
      }),
      makeAlert({
        id: 2,
        optionChainId: 'AAPL-nan-spot',
        optionType: 'C',
        strike: 210,
        underlyingPriceAtSpike: Number.NaN,
      }),
      makeAlert({
        id: 3,
        optionChainId: 'AAPL-otm-with-spot',
        optionType: 'C',
        strike: 210,
        underlyingPriceAtSpike: 200,
      }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(feedResult({ alerts, total: 3 }));

    render(<SilentBoomSection marketOpen={false} />);
    fireEvent.click(screen.getByTestId('silent-boom-moneyness-otm-chip'));

    // Both unusable-spot rows are dropped by the filter.
    expect(
      screen.queryByTestId('silent-boom-row-AAPL-zero-spot'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('silent-boom-row-AAPL-nan-spot'),
    ).not.toBeInTheDocument();
    // The genuinely-usable OTM row remains.
    expect(
      screen.getByTestId('silent-boom-row-AAPL-otm-with-spot'),
    ).toBeInTheDocument();
    // And the active OTM chip's hidden-no-spot badge counts exactly the
    // two rows the filter dropped for an unusable spot.
    expect(
      screen.getByTestId('silent-boom-moneyness-otm-chip'),
    ).toHaveTextContent('−2');
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
    // Seed the hook with hasMore=true so the "next page" button renders. The
    // pager only exists in the non-engaged (historical full-day) view now, so
    // switch to a past day before advancing the page.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({
        alerts: [makeAlert({ id: 1, optionChainId: 'AAPL260508C00200000' })],
        total: 100,
        hasMore: true,
      }),
    );

    render(<SilentBoomSection marketOpen={false} />);

    // Leave the live union by switching to a historical day.
    fireEvent.change(screen.getByLabelText(/select trading day/i), {
      target: { value: '2026-05-08' },
    });

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

  it('does NOT suggest "Try Next" in the live (engaged) view even when hasMore is true (no pager there)', () => {
    // Live view: today's date, page 0 → the pager is suppressed (it only
    // renders in the historical full-day view). hasMore=true must NOT
    // produce "Try Next" copy pointing at a non-existent Next button.
    const alerts = Array.from({ length: 4 }, (_, i) =>
      makeAlert({
        id: i + 1,
        optionChainId: `LIVE-HIDDEN-${i}`,
        baselineVolume: 10,
        spikeRatio: 200,
      }),
    );
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: 4, hasMore: true }),
    );

    render(<SilentBoomSection marketOpen />);
    fireEvent.click(screen.getByText(/hide ghosts/i));

    const empty = screen.getByTestId('silent-boom-all-filtered-empty');
    expect(empty).toBeInTheDocument();
    expect(empty).not.toHaveTextContent(/Try Next/);
    expect(empty).toHaveTextContent(/relaxing a filter/);
  });

  it('DOES suggest "Try Next" in the historical view when hasMore is true (pager exists)', () => {
    const alerts = Array.from({ length: 4 }, (_, i) =>
      makeAlert({
        id: i + 1,
        optionChainId: `HIST-HIDDEN-${i}`,
        baselineVolume: 10,
        spikeRatio: 200,
      }),
    );
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: 100, hasMore: true }),
    );

    render(<SilentBoomSection marketOpen={false} />);
    // Switch to a past day so the historical pager path is active.
    fireEvent.change(screen.getByLabelText(/select trading day/i), {
      target: { value: '2026-05-08' },
    });
    fireEvent.click(screen.getByText(/hide ghosts/i));

    const empty = screen.getByTestId('silent-boom-all-filtered-empty');
    expect(empty).toHaveTextContent(/Try Next/);
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

    // Numerator = post-client-filter visible (1). Denominator stays the
    // honest day total (3) and is now labeled "for the day".
    expect(screen.getByText(/showing 1 of 3 for the day/)).toBeInTheDocument();
    // The 2 rows the client filter hid are reconciled in a separate note
    // so the denominator no longer silently over-counts.
    expect(screen.getByText(/\(2 hidden by filters\)/)).toBeInTheDocument();
  });

  it('omits the "hidden by filters" note when no client filter is hiding rows (denominator is coherent)', () => {
    // 3 healthy alerts, no client filter active → visible == server slice
    // == 3, and no reconciliation note is shown.
    const alerts = [
      makeAlert({ id: 1, optionChainId: 'H1', baselineVolume: 500 }),
      makeAlert({ id: 2, optionChainId: 'H2', baselineVolume: 500 }),
      makeAlert({ id: 3, optionChainId: 'H3', baselineVolume: 500 }),
    ];
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({ alerts, total: 3, hasMore: false }),
    );

    render(<SilentBoomSection marketOpen={false} />);

    expect(screen.getByText(/showing 3 of 3 for the day/)).toBeInTheDocument();
    expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();
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

    // The pager only exists in the non-engaged (historical full-day) view —
    // switch to a past day so the pager renders.
    fireEvent.change(screen.getByLabelText(/select trading day/i), {
      target: { value: '2026-05-08' },
    });

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

// ============================================================
// Midnight rollover (docs/superpowers/specs/panel-date-rollover-2026-11-14.md,
// Phase 7b, design items 2 and 3)
//
// Silent Boom kept its date in `useState(todayCt())` and rolled it with a 60 s
// interval that left a user-picked date alone, so an open tab sat on
// yesterday for up to a minute after midnight and called it "historical" in
// the gap. It follows the shared ET clock now (`useFollowedDate`), as Lottery
// Finder does: the date is the owner's pick, else today; a pick of today, or
// an emptied field, follows again; any other date stays put, a future one
// included. The scrubbed bucket and the page number belong to the view they
// were set on (the date, and for the page every filter) and are dropped
// during render when it changes, so no commit shows the new date at the old
// bucket and no render asks for it at the old page. Every case starts 30 s
// before an ET midnight; the clock's timer is armed for 1 s past it, so 31 s
// lands just after. The real getETToday() reads the faked Date. Assertions on
// what the feed hooks were asked read every render pass, and assertions on
// the bucket read every commit (the bucket is a client-side filter: the feed
// hook never receives it). Owner decision 2026-11-14.
// ============================================================

interface FeedArgs {
  date: string;
  page: number;
  historical: boolean;
}

/** What the panel handed useSilentBoomFeed, one entry per render pass. */
const feedArgs = (): FeedArgs[] =>
  mockUseSilentBoomFeed.mock.calls.map((c) => c[0] as FeedArgs);
/** What the panel handed the ticker-counts hook, one entry per render pass. */
const countsArgs = (): FeedArgs[] =>
  mockUseSilentBoomTickerCounts.mock.calls.map((c) => c[0] as FeedArgs);

const dateInput = () =>
  screen.getByLabelText<HTMLInputElement>(/select trading day/i);

function pick(date: string) {
  fireEvent.change(dateInput(), { target: { value: date } });
}

/** The mode chip reads "Live" on today and "All day" on any other date. */
const liveChip = () => screen.queryByRole('button', { name: /^Live$/ });
const allDayChip = () => screen.queryByRole('button', { name: /^All day$/ });

function stepBackOneBucket() {
  fireEvent.click(
    screen.getByRole('button', { name: /step back one 5-min bucket/i }),
  );
}

/** Any render of the panel: a client-side filter chip flips local state. */
function rerenderPanel() {
  fireEvent.click(screen.getByRole('button', { name: /hide ghosts/i }));
}

interface Commit {
  date: string;
  scrubbed: boolean;
}

/**
 * Render the panel and record what each commit put on screen: the date in the
 * field and whether the "(5-min)" bucket marker is showing. The profiler
 * reports after the DOM is updated, so this is what the owner sees.
 */
function renderWithCommits(ui: React.ReactElement): Commit[] {
  const commits: Commit[] = [];
  render(
    <Profiler
      id="silent-boom"
      onRender={() => {
        commits.push({
          date: dateInput().value,
          scrubbed: screen.queryByText('(5-min)') !== null,
        });
      }}
    >
      {ui}
    </Profiler>,
  );
  return commits;
}

describe.each([
  {
    zone: 'EST (winter)',
    start: '2026-11-10T04:59:30Z',
    night: '2026-11-09',
    morning: '2026-11-10',
    next: '2026-11-11',
  },
  {
    zone: 'EDT (summer)',
    start: '2026-07-15T03:59:30Z',
    night: '2026-07-14',
    morning: '2026-07-15',
    next: '2026-07-16',
  },
])('SilentBoomSection: across the $zone midnight', (m) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(m.start));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The shared clock's timer fires, just past midnight. */
  function crossMidnight() {
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
  }

  /** The wall clock passes midnight; the shared clock has not ticked yet. */
  function wallClockPastMidnight() {
    act(() => {
      vi.setSystemTime(new Date(Date.parse(m.start) + 30_500));
    });
  }

  it('follows the new day with no parent re-render: date, max, live label and both hooks', () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <SilentBoomSection marketOpen={true} />;
    }
    render(<Parent />);
    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.night);

    crossMidnight();

    expect(parentRenders).toBe(1);
    expect(dateInput().value).toBe(m.morning);
    expect(dateInput().max).toBe(m.morning);
    expect(liveChip()).toBeInTheDocument();
    // Every render asked for the night or the morning, never a half state,
    // and the new day was never called historical.
    expect(new Set(feedArgs().map((a) => a.date))).toEqual(
      new Set([m.night, m.morning]),
    );
    expect(feedArgs().at(-1)).toMatchObject({ date: m.morning, page: 0 });
    expect(feedArgs().every((a) => !a.historical)).toBe(true);
    expect(countsArgs().every((a) => !a.historical)).toBe(true);
    expect(countsArgs().at(-1)?.date).toBe(m.morning);
  });

  it('keeps the night live in a render just past midnight, before the clock ticks', () => {
    render(<SilentBoomSection marketOpen={true} />);

    // The wall clock is past midnight; the shared clock has not ticked. A
    // render now reads the same clock the rest of the app does, so the night
    // is still today, not the wall clock's yesterday.
    wallClockPastMidnight();
    rerenderPanel();

    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.night);
    expect(liveChip()).toBeInTheDocument();
    expect(feedArgs().every((a) => !a.historical)).toBe(true);
    expect(countsArgs().every((a) => !a.historical)).toBe(true);
    expect(feedArgs().every((a) => a.date === m.night)).toBe(true);
  });

  it('keeps a picked past date across the roll, and moves max', () => {
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');
    const picked = feedArgs().length;

    crossMidnight();

    expect(dateInput().value).toBe('2026-04-20');
    expect(dateInput().max).toBe(m.morning);
    expect(allDayChip()).toBeInTheDocument();
    // Every render from the pick on asked for the picked day and called it
    // historical, across the roll as before it.
    const since = feedArgs().slice(picked - 1);
    expect(since.every((a) => a.date === '2026-04-20' && a.historical)).toBe(
      true,
    );
    expect(
      countsArgs()
        .slice(-2)
        .every((a) => a.date === '2026-04-20' && a.historical),
    ).toBe(true);
  });

  it('follows again when today is picked back, across the roll', () => {
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');
    pick(m.night);
    expect(dateInput().value).toBe(m.night);

    crossMidnight();

    // A stored date would stay on the night. A pick of today is following.
    expect(dateInput().value).toBe(m.morning);
    expect(feedArgs().at(-1)?.date).toBe(m.morning);
    expect(liveChip()).toBeInTheDocument();
  });

  it('keeps the night a past pick when it is picked just past midnight, before the clock ticks', () => {
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');

    // By the wall clock the night is yesterday. Judged against the render's
    // stale `today` it would pass for following, and the pick would be lost
    // at the roll.
    wallClockPastMidnight();
    pick(m.night);
    crossMidnight();

    expect(dateInput().value).toBe(m.night);
    expect(dateInput().max).toBe(m.morning);
    expect(allDayChip()).toBeInTheDocument();
  });

  it('follows when the new today is picked just past midnight, before the clock ticks', () => {
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');

    // The wall clock is past midnight; the shared clock's `today` is still
    // the night's. The pick is compared with the clock at the moment of the
    // pick, so it follows: it moves again at the next midnight. A stored
    // date would stay on the morning.
    wallClockPastMidnight();
    pick(m.morning);
    crossMidnight();
    expect(dateInput().value).toBe(m.morning);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });

    expect(dateInput().value).toBe(m.next);
  });

  it('passes a future date on and keeps it in the field', () => {
    render(<SilentBoomSection marketOpen={true} />);

    pick(m.morning);

    // `max` is a hint the browser does not enforce on typing. A typed future
    // date is the owner's pick, and a partial date on the way to a past one
    // (below) is often a future one.
    expect(feedArgs().at(-1)?.date).toBe(m.morning);
    expect(dateInput().value).toBe(m.morning);
  });

  it('keeps every step of a month-later past date typed over the field', () => {
    // Chrome forwards a complete date after each segment and keeps the old
    // year: 12152025 over today goes 2026-01-.., 2026-12-.. (a future date),
    // 2026-12-01, 2026-12-15, then the year lands. Refusing the future step
    // snapped the field back and lost the month.
    render(<SilentBoomSection marketOpen={true} />);

    for (const step of [
      '2026-01-16',
      '2026-12-16',
      '2026-12-01',
      '2026-12-15',
      '2025-12-15',
    ]) {
      pick(step);
      expect(feedArgs().at(-1)?.date).toBe(step);
      expect(dateInput().value).toBe(step);
    }
  });

  it('follows today when the field is left empty, not when it empties, and never asks for an empty date', () => {
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');

    // Emptying the field (the first "0" of a zero-padded month does it) is
    // mid-edit.
    pick('');
    expect(feedArgs().at(-1)?.date).toBe('2026-04-20');
    expect(dateInput().value).toBe('');

    fireEvent.blur(dateInput());

    expect(feedArgs().at(-1)?.date).toBe(m.night);
    expect(dateInput().value).toBe(m.night);
    // `ctSessionBounds('')` formats an Invalid Date.
    expect(feedArgs().some((a) => a.date === '')).toBe(false);
    expect(countsArgs().some((a) => a.date === '')).toBe(false);
  });

  it('drops a scrubbed bucket at the roll: no commit shows the new day at the old bucket', () => {
    const commits = renderWithCommits(<SilentBoomSection marketOpen={true} />);
    stepBackOneBucket();
    expect(commits.at(-1)).toEqual({ date: m.night, scrubbed: true });
    // Any other render keeps the bucket while its date is selected.
    rerenderPanel();
    expect(commits.at(-1)).toEqual({ date: m.night, scrubbed: true });
    const beforeRoll = commits.length;
    const feedBeforeRoll = feedArgs().length;

    crossMidnight();

    const afterRoll = commits.slice(beforeRoll);
    expect(afterRoll.length).toBeGreaterThan(0);
    expect(afterRoll.every((c) => c.date === m.morning && !c.scrubbed)).toBe(
      true,
    );
    const feedAfterRoll = feedArgs().slice(feedBeforeRoll);
    expect(feedAfterRoll.length).toBeGreaterThan(0);
    expect(
      feedAfterRoll.every(
        (a) => a.date === m.morning && a.page === 0 && !a.historical,
      ),
    ).toBe(true);
  });

  it('drops a scrubbed bucket on a pick, and it does not come back when the date does', () => {
    const commits = renderWithCommits(<SilentBoomSection marketOpen={true} />);
    stepBackOneBucket();
    expect(commits.at(-1)?.scrubbed).toBe(true);
    const beforePick = commits.length;

    pick('2026-04-20');
    pick(m.night);

    // Every commit since the first pick: no bucket, whichever date it shows,
    // including the night the bucket was set on.
    const afterPick = commits.slice(beforePick);
    expect(afterPick.map((c) => c.date)).toContain('2026-04-20');
    expect(afterPick.map((c) => c.date)).toContain(m.night);
    expect(afterPick.every((c) => !c.scrubbed)).toBe(true);
  });

  it('keeps a past day on its page across the roll (a live day is never paged, so the roll has none to drop)', () => {
    // The pager exists only on a past day with no bucket, and a bucket resets
    // the page, so a roll from the live day never carries a page. What the
    // roll must not do is touch a past day's page.
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({
        alerts: [makeAlert({ id: 1, optionChainId: 'PAGED' })],
        total: 300,
        hasMore: true,
      }),
    );
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(feedArgs().at(-1)).toMatchObject({
      date: '2026-04-20',
      page: 2,
    });

    crossMidnight();

    expect(feedArgs().at(-1)).toMatchObject({
      date: '2026-04-20',
      page: 2,
    });
  });
});

// ============================================================
// The page belongs to the view it was set on: the date, the scrubbed bucket
// and every filter. The page used to be reset by an effect on those, which
// runs one commit late: toggling a filter on page 2 asked the server for
// page 2 of the new filter (offset 100) before the clean request. The page is
// stored with a scope string built from all of them, read only while that
// scope is current, and dropped during render when it is not. So no render
// pairs a new view with the old page, and the old page cannot come back when
// the view does. Every assertion reads every render pass handed to the feed
// hook. Owner decision 2026-11-14.
// ============================================================

describe('SilentBoomSection: the page follows its date, bucket and filters', () => {
  const chip = (name: string | RegExp) => screen.getByRole('button', { name });
  const testId = (id: string) => screen.getByTestId(id);
  /** The row of controls a toolbar group sits in (its label's parent). */
  const rowOf = (label: string) =>
    screen.getByText(label, { selector: 'span' }).parentElement as HTMLElement;
  const nextPage = () =>
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));

  /**
   * Every control the reset effect listed (all but date and bucket; the DTE
   * bucket is a constant), as a flip away from the default and the click that
   * puts it back.
   */
  const FILTERS: Array<{
    name: string;
    flip: () => void;
    restore: () => void;
  }> = [
    {
      name: 'sortMode',
      flip: () => fireEvent.click(chip('spike ratio')),
      restore: () => fireEvent.click(chip('newest')),
    },
    {
      name: 'convictionFloor',
      flip: () => fireEvent.click(chip(/Tier 1/)),
      restore: () =>
        fireEvent.click(
          within(rowOf('conviction')).getByRole('button', { name: /^all$/ }),
        ),
    },
    {
      name: 'burstFilter',
      flip: () => fireEvent.click(chip(/≥50×/)),
      restore: () => fireEvent.click(chip('all bursts')),
    },
    {
      name: 'takeitFloor',
      flip: () => fireEvent.click(testId('takeit-floor-0')),
      restore: () => fireEvent.click(testId('takeit-floor-0.7')),
    },
    {
      name: 'minDte',
      flip: () =>
        fireEvent.change(screen.getByLabelText('Minimum DTE'), {
          target: { value: '1' },
        }),
      restore: () =>
        fireEvent.change(screen.getByLabelText('Minimum DTE'), {
          target: { value: '' },
        }),
    },
    {
      name: 'minPremiumK',
      flip: () =>
        fireEvent.change(
          screen.getByLabelText('Minimum premium in thousands of dollars'),
          { target: { value: '100' } },
        ),
      restore: () =>
        fireEvent.change(
          screen.getByLabelText('Minimum premium in thousands of dollars'),
          { target: { value: '' } },
        ),
    },
    {
      name: 'askPctBand',
      flip: () => fireEvent.click(chip('70-80%')),
      restore: () => fireEvent.click(chip('all ask%')),
    },
    {
      name: 'minVolOi',
      flip: () => fireEvent.click(chip('≥1.0')),
      restore: () => fireEvent.click(chip('≥0.5')),
    },
    {
      name: 'optionTypeFilter',
      flip: () => fireEvent.click(chip('calls')),
      restore: () =>
        fireEvent.click(
          within(rowOf('type')).getAllByRole('button', { name: /^all$/ })[0]!,
        ),
    },
    {
      name: 'moneynessMode',
      flip: () => fireEvent.click(testId('silent-boom-moneyness-otm-chip')),
      restore: () => fireEvent.click(testId('silent-boom-moneyness-all-chip')),
    },
    {
      name: 'todFilter',
      flip: () => fireEvent.click(chip('AM_open')),
      restore: () => fireEvent.click(chip('all TOD')),
    },
    {
      name: 'hideLatePm',
      flip: () => fireEvent.click(chip(/hide post-14:30/)),
      restore: () => fireEvent.click(chip(/hide post-14:30/)),
    },
    {
      name: 'hideGhosts',
      flip: () => fireEvent.click(chip(/hide ghosts/)),
      restore: () => fireEvent.click(chip(/hide ghosts/)),
    },
    {
      name: 'hideGated',
      flip: () => fireEvent.click(testId('silent-boom-hide-gated-chip')),
      restore: () => fireEvent.click(testId('silent-boom-hide-gated-chip')),
    },
    {
      name: 'hideCounterFlow',
      flip: () => fireEvent.click(testId('silent-boom-hide-counter-flow-chip')),
      restore: () =>
        fireEvent.click(testId('silent-boom-hide-counter-flow-chip')),
    },
    {
      name: 'aggressivePremium',
      flip: () =>
        fireEvent.click(testId('silent-boom-aggressive-premium-chip')),
      restore: () =>
        fireEvent.click(testId('silent-boom-aggressive-premium-chip')),
    },
    {
      name: 'tickerFilter',
      flip: () => fireEvent.click(chip(/^AAPL/)),
      restore: () => fireEvent.click(chip(/^AAPL/)),
    },
  ];

  /** A past day with a three-page result, on page 2 (0-based). */
  function renderOnPage2() {
    mockUseSilentBoomFeed.mockReturnValue(
      feedResult({
        alerts: [makeAlert({ id: 1, optionChainId: 'PAGED' })],
        total: 300,
        hasMore: true,
      }),
    );
    mockUseSilentBoomTickerCounts.mockReturnValue({
      data: {
        tickers: [
          { ticker: 'AAPL', count: 5 },
          { ticker: 'MSFT', count: 3 },
        ],
      },
      loading: false,
      error: null,
      fetchedAt: null,
      refresh: vi.fn(),
    });
    render(<SilentBoomSection marketOpen={false} />);
    pick('2026-04-20');
    nextPage();
    nextPage();
    expect(feedArgs().at(-1)).toMatchObject({
      date: '2026-04-20',
      page: 2,
    });
  }

  it.each(FILTERS.map((f) => [f.name, f] as const))(
    'drops page 2 when %s changes, with no request for the new filter at the old page, and does not bring it back',
    (_name, { flip, restore }) => {
      renderOnPage2();
      const beforeFlip = feedArgs().length;

      flip();

      const afterFlip = feedArgs().slice(beforeFlip);
      expect(afterFlip.length).toBeGreaterThan(0);
      expect(afterFlip.every((a) => a.page === 0)).toBe(true);

      restore();

      // The control is back where it was, and so is the scope the page was
      // set on: it must not come back with it.
      expect(feedArgs().length).toBeGreaterThan(beforeFlip + 1);
      expect(
        feedArgs()
          .slice(beforeFlip)
          .every((a) => a.page === 0),
      ).toBe(true);
    },
  );

  /**
   * A change from one non-default value to another, per control. The flip
   * table above always starts at the default, so a scope that kept only "is it
   * set" (`tickerFilter !== null`, `minPremiumK > 0`, `sortMode === 'newest'`)
   * would still pass it: default to set changes the flag. These pairs move
   * between two set values, which only the value itself can tell apart. The
   * first value is chosen to also stay on the same side of the common
   * collapses (`> 0`) as the default. The booleans have no pair: a boolean is
   * already a flag.
   */
  const PAIRS: Array<{
    name: string;
    first: () => void;
    second: () => void;
  }> = [
    {
      name: 'sortMode',
      first: () => fireEvent.click(chip('spike ratio')),
      second: () => fireEvent.click(chip('vol/OI')),
    },
    {
      name: 'convictionFloor',
      first: () => fireEvent.click(chip(/Tier 1/)),
      second: () => fireEvent.click(chip(/Tier 2\+/)),
    },
    {
      name: 'burstFilter',
      first: () => fireEvent.click(chip(/≥50×/)),
      second: () => fireEvent.click(chip(/20-50×/)),
    },
    {
      // The default is 0.70: 0.80 and 0.60 are both set and both non-default.
      name: 'takeitFloor',
      first: () => fireEvent.click(testId('takeit-floor-0.8')),
      second: () => fireEvent.click(testId('takeit-floor-0.6')),
    },
    {
      name: 'minDte',
      first: () =>
        fireEvent.change(screen.getByLabelText('Minimum DTE'), {
          target: { value: '1' },
        }),
      second: () =>
        fireEvent.change(screen.getByLabelText('Minimum DTE'), {
          target: { value: '2' },
        }),
    },
    {
      name: 'minPremiumK',
      first: () =>
        fireEvent.change(
          screen.getByLabelText('Minimum premium in thousands of dollars'),
          { target: { value: '100' } },
        ),
      second: () =>
        fireEvent.change(
          screen.getByLabelText('Minimum premium in thousands of dollars'),
          { target: { value: '200' } },
        ),
    },
    {
      name: 'askPctBand',
      first: () => fireEvent.click(chip('70-80%')),
      second: () => fireEvent.click(chip('80-90%')),
    },
    {
      // The default is 0.5: 1.0 stays above zero with it, and 0 is non-default.
      name: 'minVolOi',
      first: () => fireEvent.click(chip('≥1.0')),
      second: () =>
        fireEvent.click(
          within(rowOf('vol/OI')).getByRole('button', { name: /^all$/ }),
        ),
    },
    {
      name: 'optionTypeFilter',
      first: () => fireEvent.click(chip('calls')),
      second: () => fireEvent.click(chip('puts')),
    },
    {
      name: 'moneynessMode',
      first: () => fireEvent.click(testId('silent-boom-moneyness-otm-chip')),
      second: () => fireEvent.click(testId('silent-boom-moneyness-itm-chip')),
    },
    {
      name: 'todFilter',
      first: () => fireEvent.click(chip('AM_open')),
      second: () => fireEvent.click(chip('MID')),
    },
    {
      // A second ticker while one is already active.
      name: 'tickerFilter',
      first: () => fireEvent.click(chip(/^AAPL/)),
      second: () => fireEvent.click(chip(/^MSFT/)),
    },
  ];

  it.each(PAIRS.map((p) => [p.name, p] as const))(
    'drops page 2 when %s moves between two non-default values',
    (_name, { first, second }) => {
      renderOnPage2();
      first();
      nextPage();
      nextPage();
      expect(feedArgs().at(-1)?.page).toBe(2);
      const beforeSecond = feedArgs().length;

      second();

      const afterSecond = feedArgs().slice(beforeSecond);
      expect(afterSecond.length).toBeGreaterThan(0);
      expect(afterSecond.every((a) => a.page === 0)).toBe(true);
    },
  );

  it('keeps page 0 across a bucket-to-bucket scrub, and shows no pager to raise it under a bucket', () => {
    renderOnPage2();
    const beforeScrub = feedArgs().length;

    stepBackOneBucket();
    // The pager is hidden while a bucket is set, so a page above 0 cannot be
    // reached under one. A scope that kept only "is a bucket set" would be
    // indistinguishable from the real one, and this is why.
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
    stepBackOneBucket();

    const since = feedArgs().slice(beforeScrub);
    expect(since.length).toBeGreaterThan(1);
    expect(since.every((a) => a.page === 0)).toBe(true);
    expect(
      screen.queryByRole('button', { name: /next page/i }),
    ).not.toBeInTheDocument();
  });

  it('drops page 2 when the bucket changes, and does not bring it back', () => {
    renderOnPage2();
    const beforeScrub = feedArgs().length;

    stepBackOneBucket();
    expect(screen.getByText('(5-min)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^All day$/ }));
    expect(screen.queryByText('(5-min)')).not.toBeInTheDocument();

    const since = feedArgs().slice(beforeScrub);
    expect(since.length).toBeGreaterThan(1);
    expect(since.every((a) => a.page === 0)).toBe(true);
  });

  it('drops page 2 when another date is picked, and does not bring it back when the date does', () => {
    renderOnPage2();
    const beforePick = feedArgs().length;

    pick('2026-04-21');
    pick('2026-04-20');

    const since = feedArgs().slice(beforePick);
    expect(since.map((a) => a.date)).toContain('2026-04-21');
    expect(since.at(-1)?.date).toBe('2026-04-20');
    expect(since.every((a) => a.page === 0)).toBe(true);
  });

  it('keeps page 2 through a change that is not part of the view', () => {
    renderOnPage2();

    // The realized-exit policy changes the row badges, not the result set.
    fireEvent.click(chip('120m'));

    expect(feedArgs().at(-1)).toMatchObject({ page: 2 });
  });
});

describe('SilentBoomSection: typing a date', () => {
  it('takes a date typed key by key over the field, and asks for no half-typed date', async () => {
    const user = userEvent.setup();
    render(<SilentBoomSection marketOpen={true} />);
    pick('2026-04-20');
    const before = feedArgs().length;

    // Emptying the field first must not follow today and lose the typing:
    // the shared DateInput keeps an emptied field as a local draft.
    await user.clear(dateInput());
    await user.type(dateInput(), '2026-04-21');

    const since = feedArgs().slice(before);
    expect(since.length).toBeGreaterThan(0);
    expect(new Set(since.map((a) => a.date))).toEqual(new Set(['2026-04-21']));
    expect(dateInput().value).toBe('2026-04-21');
  });
});
