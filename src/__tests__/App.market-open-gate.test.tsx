import { Fragment, createElement, type ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContext } from '../hooks/useToast';
import App from '../App';

/**
 * The gate App.tsx hands every polling hook and every `marketOpen` panel prop.
 *
 * It used to be `market.data.quotes?.marketOpen ?? false`, the server's flag
 * from the last SUCCESSFUL /api/quotes call. useMarketData keeps the old
 * `data.quotes` when quotes starts failing (a 401 once the Schwab login
 * lapses), so a tab loaded in the session kept `true` after the close, and a
 * tab loaded while Schwab was logged out had `quotes === null` and never
 * polled, although GEX landscape, dark pool, alerts and Interval B/A read UW
 * and GEXBot, not Schwab (seen 2026-11-18). The gate is now the clock
 * (`market.marketOpen`, `session === 'regular'`) AND an owner or guest viewer.
 *
 * <App /> mounts here with the data hooks and the panels mocked at their module
 * boundary, so the assertions read what each hook receives. The quote's own
 * flag still reaches useComputedSignals as `quotesMarketOpen`: it describes
 * whether the quote is a live RTH print, a different question (see
 * App.live-spx-wiring.test.ts).
 */

type Mode = 'owner' | 'guest' | 'public';

const h = vi.hoisted(() => ({
  access: { mode: 'owner' as 'owner' | 'guest' | 'public' },
  market: { current: {} as Record<string, unknown> },
  /**
   * What `useMarketData` returns. The default hands back `market.current`; the
   * one test that needs the real hook swaps in its implementation.
   */
  useMarketData: vi.fn(),
  /** What the history hook reports: true while a past date's history shows. */
  history: { hasHistory: false },
  /**
   * True: the PanelRouter stand-in renders only the ids the registry lists, as
   * the real router does. False: it renders every id in `renderedPanels`, so a
   * test can reach App's own per-panel gates (GatedSection's `gate`) that the
   * registry would otherwise cover.
   */
  routeByRegistry: { on: true },
  /**
   * Panel ids the PanelRouter stand-in renders: plain ones, ones behind a
   * GatedSection, the two sections that poll through a leaf of their own
   * (sec-iv's term structure, sec-regime's flow-regime badge), and the two
   * Charts & History panels the registry lists by access mode.
   */
  renderedPanels: [
    'sec-premarket',
    'sec-iv',
    'sec-regime',
    'sec-gex-target',
    'sec-gex-landscape',
    'sec-charts',
    'sec-history',
  ],
  nullComponent: () => null,
  panelPrefs: {
    order: [] as string[],
    groupOrder: [] as string[],
    hidden: new Set<string>(),
    // Hides nothing, as default prefs do; a test swaps in its own and the
    // afterEach below puts this one back.
    isHidden: (() => false) as (id: string) => boolean,
  },
  vix: {
    fileInputRef: { current: null },
    handleFileUpload: vi.fn(),
    selectedDate: '2026-11-18',
    etToday: '2026-11-18',
    setSelectedDate: vi.fn(),
    vixDataLoaded: true,
    vixData: {},
    vixOHLC: null,
    vixOHLCField: 'smart',
    setVixOHLC: vi.fn(),
    setVixOHLCField: vi.fn(),
  },
  alertState: {
    alerts: [] as unknown[],
    acknowledge: vi.fn(),
    notificationPermission: 'default',
    requestPermission: vi.fn(),
  },
  intervalBAAlertState: { alerts: [] as unknown[], acknowledge: vi.fn() },
  intervalBAMute: { muted: false, toggle: vi.fn() },
  analysisContext: {},
  /** The params App hands useAnalysisContext, one call per render. */
  useAnalysisContext: vi.fn(),
  useChainData: vi.fn(),
  useAlertPolling: vi.fn(),
  useIntervalBAAlerts: vi.fn(),
  useDarkPoolLevels: vi.fn(),
  usePeriscopeExposure: vi.fn(),
  useGexTarget: vi.fn(),
  useComputedSignals: vi.fn(),
  preMarketSignals: vi.fn(),
  ivInputSection: vi.fn(),
  marketRegimeSection: vi.fn(),
  gexTarget: vi.fn(),
  gexLandscape: vi.fn(),
  optionsAlertsView: vi.fn(),
}));

// ---- Hooks: access, data and polling ---------------------------------------
vi.mock('../hooks/useAccessSession', () => ({
  useAccessSession: () => ({
    mode: h.access.mode,
    refresh: vi.fn(),
    logout: vi.fn(),
  }),
}));
vi.mock('../hooks/useMarketData', () => ({
  useMarketData: () => h.useMarketData(),
}));
// The real useMarketData reads the access mode itself. Everything else in the
// module stays real, and the mode is the one the access-session mock reports.
// `checkIsOwner` is redirected too: the real one calls the module's own
// `getAccessMode`, which a mock of the export does not reach, so without this
// it would keep answering the DEV owner while `getAccessMode` said otherwise.
vi.mock('../utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/auth')>()),
  getAccessMode: () => h.access.mode,
  checkIsOwner: () => h.access.mode === 'owner',
}));
vi.mock('../hooks/useChainData', () => ({ useChainData: h.useChainData }));
vi.mock('../hooks/useAlertPolling', () => ({
  useAlertPolling: h.useAlertPolling,
}));
vi.mock('../hooks/useIntervalBAAlerts', () => ({
  useIntervalBAAlerts: h.useIntervalBAAlerts,
}));
vi.mock('../hooks/useIntervalBAMute', () => ({
  useIntervalBAMute: () => h.intervalBAMute,
}));
vi.mock('../hooks/useDarkPoolLevels', () => ({
  useDarkPoolLevels: h.useDarkPoolLevels,
}));
vi.mock('../hooks/usePeriscopeExposure', () => ({
  usePeriscopeExposure: h.usePeriscopeExposure,
}));
vi.mock('../hooks/useGexTarget', () => ({ useGexTarget: h.useGexTarget }));
vi.mock('../hooks/useComputedSignals', () => ({
  useComputedSignals: h.useComputedSignals,
}));

// ---- Hooks that fetch or persist, stubbed to inert values -------------------
vi.mock('../hooks/useVixData', () => ({ useVixData: () => h.vix }));
vi.mock('../hooks/useHistoryData', () => ({
  useHistoryData: () => ({ hasHistory: h.history.hasHistory, history: null }),
  useHistoryVixOHLCFallback: vi.fn(),
}));
vi.mock('../hooks/useVix1dData', () => ({ useVix1dData: () => ({}) }));
vi.mock('../hooks/useEventsForDate', () => ({
  useEventsForDate: () => ({
    events: undefined,
    failed: false,
    retry: vi.fn(),
  }),
}));
vi.mock('../hooks/useAutoFill', () => ({ useAutoFill: () => null }));
vi.mock('../hooks/useSnapshotSave', () => ({
  useSnapshotSave: vi.fn(),
  buildSnapshotMeta: () => ({}),
}));
// Stable, like the real hook's memoized return: App's panelMap memo depends on
// it, and a new object per render would rebuild the map every time.
vi.mock('../hooks/useAnalysisContext', () => ({
  useAnalysisContext: (params: unknown) => {
    h.useAnalysisContext(params);
    return h.analysisContext;
  },
}));
vi.mock('../hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../hooks/usePanelPrefs', () => ({
  usePanelPrefs: () => h.panelPrefs,
}));

// ---- Components: rendered by App itself, stubbed to nothing -----------------
vi.mock('../components/AppHeader', () => ({ default: h.nullComponent }));
vi.mock('../components/AlertBanner', () => ({ default: h.nullComponent }));
vi.mock('../components/IntervalBAAlertBanner', () => ({
  default: h.nullComponent,
}));
vi.mock('../components/PanelPrefsModal/LazyPanelPrefsModal', () => ({
  LazyPanelPrefsModal: h.nullComponent,
}));
vi.mock('../components/SectionNav', () => ({ default: h.nullComponent }));
vi.mock('../components/AccessKey/AccessKeyButton', () => ({
  default: h.nullComponent,
}));
vi.mock('../components/EventDayWarning', () => ({ default: h.nullComponent }));
vi.mock('../components/NotificationPermission', () => ({
  default: h.nullComponent,
}));
vi.mock('../components/BackToTop', () => ({ default: h.nullComponent }));
vi.mock('../components/UpdateAvailable/UpdateAvailableBanner', () => ({
  default: h.nullComponent,
}));
vi.mock('@vercel/analytics/react', () => ({ Analytics: h.nullComponent }));
vi.mock('@vercel/speed-insights/react', () => ({
  SpeedInsights: h.nullComponent,
}));

// ---- Components that capture the `marketOpen` prop they are given -----------
vi.mock('../components/PreMarketSignals', () => ({
  default: (props: unknown) => {
    h.preMarketSignals(props);
    return null;
  },
}));
vi.mock('../components/IVInputSection', () => ({
  default: (props: unknown) => {
    h.ivInputSection(props);
    return null;
  },
}));
vi.mock('../components/MarketRegimeSection', () => ({
  default: (props: unknown) => {
    h.marketRegimeSection(props);
    return null;
  },
}));
vi.mock('../components/GexTarget', () => ({
  GexTarget: (props: unknown) => {
    h.gexTarget(props);
    return null;
  },
}));
vi.mock('../components/GexLandscape', () => ({
  default: (props: unknown) => {
    h.gexLandscape(props);
    return null;
  },
}));
vi.mock('../components/OptionsAlerts', () => ({
  OptionsAlertsView: (props: unknown) => {
    h.optionsAlertsView(props);
    return null;
  },
}));
// The two Charts & History panels fetch /api/analyses on mount; only the
// anchor App renders around each is read here.
vi.mock('../components/ChartAnalysis', () => ({ default: h.nullComponent }));
vi.mock('../components/ChartAnalysis/AnalysisHistory', () => ({
  default: h.nullComponent,
}));

// The real router walks the whole registry, which would pull in every lazy
// panel. This one renders only the panels this test reads, through the same
// panelMap closures App builds, and keeps the real router's skips: an id the
// registry does not list for the current access mode (the real router walks
// `resolvedGroups` and reads each group's ids from `resolvedPanelsByGroup`),
// so a panel the registry hides from a public visitor is not rendered here
// either, and an id `isHidden` says the visitor hid. It emits panels in
// `renderedPanels` order, not in group order as the real router does, so no
// test may rely on render order.
vi.mock('../components/PanelRouter', () => ({
  PanelRouter: ({
    panelMap,
    resolvedGroups,
    resolvedPanelsByGroup,
    isHidden,
  }: {
    panelMap: ReadonlyMap<string, () => ReactNode>;
    resolvedGroups: readonly string[];
    resolvedPanelsByGroup: ReadonlyMap<string, readonly string[]>;
    isHidden: (id: string) => boolean;
  }) => {
    const registered = new Set(
      resolvedGroups.flatMap((group) => resolvedPanelsByGroup.get(group) ?? []),
    );
    return createElement(
      Fragment,
      null,
      ...h.renderedPanels
        .filter((id) => !h.routeByRegistry.on || registered.has(id))
        .filter((id) => !isHidden(id))
        .map((id) =>
          createElement(Fragment, { key: id }, panelMap.get(id)?.()),
        ),
    );
  },
}));

interface Scenario {
  name: string;
  mode: Mode;
  /** The client clock's `session === 'regular'`. */
  clockOpen: boolean;
  /** The server's flag in the last good /api/quotes payload; null = no payload. */
  quotesFlag: boolean | null;
  /** What every polling hook and `marketOpen` prop must receive. */
  gate: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'owner, clock open, Schwab logged out (quotes never loaded)',
    mode: 'owner',
    clockOpen: true,
    quotesFlag: null,
    gate: true,
  },
  {
    name: 'owner, clock closed, a stale quotes payload still says open',
    mode: 'owner',
    clockOpen: false,
    quotesFlag: true,
    gate: false,
  },
  {
    name: 'public, clock open, quotes present and open',
    mode: 'public',
    clockOpen: true,
    quotesFlag: true,
    gate: false,
  },
  {
    name: 'guest, clock open, no quotes (a guest has no Schwab session)',
    mode: 'guest',
    clockOpen: true,
    quotesFlag: null,
    gate: true,
  },
  {
    name: 'owner, clock open, quotes present and open',
    mode: 'owner',
    clockOpen: true,
    quotesFlag: true,
    gate: true,
  },
];

function marketFor(s: Scenario, hasData = true): Record<string, unknown> {
  return {
    data: {
      quotes:
        s.quotesFlag === null
          ? null
          : { marketOpen: s.quotesFlag, spx: { price: 6000 } },
      intraday: null,
      yesterday: null,
      events: null,
    },
    loading: false,
    // Other panels need market context to render; keep it on unless a test
    // turns it off, so a missing panel can only come from the access gate.
    hasData,
    needsAuth: false,
    fetchedAt: null,
    quotesFetchedAt: null,
    session: s.clockOpen ? 'regular' : 'after-hours',
    marketOpen: s.clockOpen,
  };
}

/** A viewer with this access mode, in a live session with a quote. */
const viewer = (mode: Mode): Scenario => ({
  name: mode,
  mode,
  clockOpen: true,
  quotesFlag: true,
  gate: mode !== 'public',
});

// One value for every render: App's `toast` is a dependency of a callback the
// panelMap memo depends on, so a new object per render would rebuild the map.
const TOAST = { show: vi.fn() };

function appElement() {
  return createElement(
    ToastContext.Provider,
    { value: TOAST },
    createElement(App),
  );
}

function mountApp() {
  return render(appElement());
}

/** Every call a mock took, which must be non-empty, as its nth argument. */
function argsAt(mock: ReturnType<typeof vi.fn>, index: number): unknown[] {
  expect(mock.mock.calls.length).toBeGreaterThan(0);
  return mock.mock.calls.map((call) => call[index]);
}

/** A mock's most recent call, as its nth argument. */
function lastArgAt(mock: ReturnType<typeof vi.fn>, index: number): unknown {
  expect(mock.mock.calls.length).toBeGreaterThan(0);
  return mock.mock.calls.at(-1)?.[index];
}

/** What the most recent render handed every polling hook, as one object. */
function lastPollingGates() {
  return {
    useChainData: lastArgAt(h.useChainData, 1),
    useAlertPolling: lastArgAt(h.useAlertPolling, 0),
    useIntervalBAAlerts: lastArgAt(h.useIntervalBAAlerts, 0),
    useDarkPoolLevels: lastArgAt(h.useDarkPoolLevels, 0),
    useGexTarget: lastArgAt(h.useGexTarget, 0),
    usePeriscopeExposure: (
      lastArgAt(h.usePeriscopeExposure, 0) as { marketOpen: boolean }
    ).marketOpen,
  };
}

function allPollingGates(value: boolean) {
  return {
    useChainData: value,
    useAlertPolling: value,
    useIntervalBAAlerts: value,
    useDarkPoolLevels: value,
    useGexTarget: value,
    usePeriscopeExposure: value,
  };
}

describe('App polling gate (market clock AND owner-or-guest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.access.mode = 'owner';
    h.useMarketData.mockImplementation(() => h.market.current);
    h.history.hasHistory = false;
    h.useChainData.mockReturnValue({ chain: null });
    h.useAlertPolling.mockReturnValue(h.alertState);
    h.useIntervalBAAlerts.mockReturnValue(h.intervalBAAlertState);
    h.useDarkPoolLevels.mockReturnValue({});
    h.usePeriscopeExposure.mockReturnValue({});
    h.useGexTarget.mockReturnValue({});
    h.useComputedSignals.mockReturnValue({});
  });

  afterEach(() => {
    globalThis.location.hash = '';
    h.routeByRegistry.on = true;
    h.panelPrefs.isHidden = () => false;
    h.vix.selectedDate = h.vix.etToday;
  });

  describe.each(SCENARIOS)('$name', (s) => {
    beforeEach(() => {
      h.access.mode = s.mode;
      h.market.current = marketFor(s);
    });

    it('hands every polling hook the gate', () => {
      mountApp();

      // useChainData(enabled, marketOpen): only the 2nd argument is the gate.
      expect(new Set(argsAt(h.useChainData, 1))).toEqual(new Set([s.gate]));
      expect(new Set(argsAt(h.useAlertPolling, 0))).toEqual(new Set([s.gate]));
      expect(new Set(argsAt(h.useIntervalBAAlerts, 0))).toEqual(
        new Set([s.gate]),
      );
      expect(new Set(argsAt(h.useDarkPoolLevels, 0))).toEqual(
        new Set([s.gate]),
      );
      expect(new Set(argsAt(h.useGexTarget, 0))).toEqual(new Set([s.gate]));
      expect(
        new Set(
          argsAt(h.usePeriscopeExposure, 0).map(
            (arg) => (arg as { marketOpen: boolean }).marketOpen,
          ),
        ),
      ).toEqual(new Set([s.gate]));
    });

    it('keeps handing useComputedSignals the quote payload flag, not the gate', () => {
      mountApp();

      const quotesMarketOpen = argsAt(h.useComputedSignals, 0).map(
        (arg) => (arg as { quotesMarketOpen: boolean }).quotesMarketOpen,
      );
      expect(new Set(quotesMarketOpen)).toEqual(
        new Set([s.quotesFlag ?? false]),
      );
    });

    it('hands the panels the gate as `marketOpen`', async () => {
      const { container } = mountApp();

      // Pre-Market Signals reads two owner-or-guest endpoints, so the registry
      // lists it for an owner or guest only: a public visitor never mounts it.
      if (s.mode === 'public') {
        expect(h.preMarketSignals).not.toHaveBeenCalled();
      } else {
        expect(new Set(argsAt(h.preMarketSignals, 0))).toEqual(
          new Set([{ marketOpen: s.gate }]),
        );
      }
      // Both sections render for a public visitor too, and each polls through
      // a leaf of its own (an owner-or-guest endpoint), so each is handed the
      // gate rather than reading the clock off `market`.
      for (const section of [h.ivInputSection, h.marketRegimeSection]) {
        expect(
          new Set(
            argsAt(section, 0).map(
              (arg) => (arg as { marketOpen: boolean }).marketOpen,
            ),
          ),
        ).toEqual(new Set([s.gate]));
      }
      // /api/flow-regime is owner-or-guest, so App tells a public visitor's
      // section to leave the flow-regime badge out.
      expect(
        new Set(
          argsAt(h.marketRegimeSection, 0).map(
            (arg) => (arg as { showFlowRegime: boolean }).showFlowRegime,
          ),
        ),
      ).toEqual(new Set([s.mode !== 'public']));

      // Neither panel is in a public visitor's registry (they need owner or
      // guest access plus market context), so the router never renders them,
      // and GatedSection's own gate (pinned in GatedSection.test.tsx) is a
      // second line behind that. Otherwise GatedSection renders its nav anchor
      // on the first render, before any lazy chunk resolves, so this is a
      // synchronous check. A public visitor's page has neither panel at all; an
      // owner's or guest's has both.
      const isPublic = s.mode === 'public';
      expect(container.querySelector('#sec-gex-target') === null).toBe(
        isPublic,
      );
      expect(container.querySelector('#sec-gex-landscape') === null).toBe(
        isPublic,
      );
      if (isPublic) return;

      // GexTarget and GexLandscape are lazy chunks behind a Suspense boundary.
      await waitFor(() => {
        expect(h.gexTarget).toHaveBeenCalled();
        expect(h.gexLandscape).toHaveBeenCalled();
      });
      expect(
        new Set(
          argsAt(h.gexTarget, 0).map(
            (arg) => (arg as { marketOpen: boolean }).marketOpen,
          ),
        ),
      ).toEqual(new Set([s.gate]));
      expect(
        new Set(
          argsAt(h.gexLandscape, 0).map(
            (arg) => (arg as { marketOpen: boolean }).marketOpen,
          ),
        ),
      ).toEqual(new Set([s.gate]));
    });

    it('hands the alerts view the gate as `marketOpen`', () => {
      globalThis.location.hash = '#alerts';

      mountApp();

      expect(
        new Set(
          argsAt(h.optionsAlertsView, 0).map(
            (arg) => (arg as { marketOpen: boolean }).marketOpen,
          ),
        ),
      ).toEqual(new Set([s.gate]));
    });
  });

  // The registry already leaves the market-context panels out of a public
  // visitor's list, so the scenarios above never reach App's own gate on them
  // (`hasMarketContext = isAuthenticated && hasMarketOrSnapshot`, handed to each
  // GatedSection). Render them regardless of the registry to pin that gate: it
  // is the second line if the registry ever lists one.
  describe('GatedSection gate, with the registry out of the way', () => {
    beforeEach(() => {
      h.routeByRegistry.on = false;
    });

    it.each([
      ['public', 'does not see', false],
      ['owner', 'sees', true],
      ['guest', 'sees', true],
    ] as const)(
      'a visitor with %s access and market data %s GexTarget and GexLandscape',
      (mode, _verb, shown) => {
        h.access.mode = mode;
        h.market.current = marketFor({
          name: mode,
          mode,
          clockOpen: true,
          quotesFlag: true,
          gate: mode !== 'public',
        });

        const { container } = mountApp();

        expect(container.querySelector('#sec-gex-target') !== null).toBe(shown);
        expect(container.querySelector('#sec-gex-landscape') !== null).toBe(
          shown,
        );
      },
    );
  });

  // The router skips a panel `panelPrefs.isHidden` reports, and App hands it
  // that function (`isHidden={panelPrefs.isHidden}`). A visitor who hid
  // GexTarget loses only that panel: the registry still lists both for an
  // owner with market data, so the missing one can only come from `isHidden`.
  describe('a panel the visitor hid', () => {
    it('is left out while the others still render', () => {
      h.access.mode = 'owner';
      h.market.current = marketFor({
        name: 'owner',
        mode: 'owner',
        clockOpen: true,
        quotesFlag: true,
        gate: true,
      });
      h.panelPrefs.isHidden = (id) => id === 'sec-gex-target';

      const { container } = mountApp();

      expect(container.querySelector('#sec-gex-target')).toBeNull();
      expect(container.querySelector('#sec-gex-landscape')).not.toBeNull();
    });
  });

  // Chart Analysis asks /api/analyses on mount and is listed for an owner or
  // guest with market data. Analysis History is the owner's alone: it renders
  // nothing for a guest. App hands the registry `isAuthenticated` and
  // `isOwner` from the one access mode, so the anchors it renders are the
  // registry's answer to each viewer.
  describe('Charts & History panels, by access mode', () => {
    it.each([
      { mode: 'owner', charts: true, history: true },
      { mode: 'guest', charts: true, history: false },
      { mode: 'public', charts: false, history: false },
    ] as const)(
      'a $mode with market data gets Chart Analysis: $charts, Analysis History: $history',
      ({ mode, charts, history }) => {
        h.access.mode = mode;
        h.market.current = marketFor(viewer(mode));

        const { container } = mountApp();

        expect(container.querySelector('#sec-charts') !== null).toBe(charts);
        expect(container.querySelector('#sec-history') !== null).toBe(history);
      },
    );

    // `market.data` is never cleared, so after a drop the market context is
    // still there and only the access mode moved. The same market object is
    // reused to keep it out of the dependencies that change.
    it('an owner who drops to public with the market data still held loses both panels', () => {
      h.access.mode = 'owner';
      const market = marketFor(viewer('owner'));
      h.market.current = market;
      const { container, rerender } = mountApp();
      expect(container.querySelector('#sec-charts')).not.toBeNull();
      expect(container.querySelector('#sec-history')).not.toBeNull();

      h.access.mode = 'public';
      rerender(appElement());

      expect(h.market.current).toBe(market);
      expect(container.querySelector('#sec-charts')).toBeNull();
      expect(container.querySelector('#sec-history')).toBeNull();
    });

    // isAuthenticated stays true across this flip, so only `isOwner` moves
    // the registry: it has to sit in the dependencies of the memo that builds
    // it.
    it('an owner who becomes a guest keeps Chart Analysis and loses Analysis History', () => {
      h.access.mode = 'owner';
      const market = marketFor(viewer('owner'));
      h.market.current = market;
      const { container, rerender } = mountApp();
      expect(container.querySelector('#sec-history')).not.toBeNull();

      h.access.mode = 'guest';
      rerender(appElement());

      expect(h.market.current).toBe(market);
      expect(container.querySelector('#sec-charts')).not.toBeNull();
      expect(container.querySelector('#sec-history')).toBeNull();
    });
  });

  describe('changes inside one mount', () => {
    const OWNER_LIVE: Scenario = {
      name: 'owner, clock open, quotes present and open',
      mode: 'owner',
      clockOpen: true,
      quotesFlag: true,
      gate: true,
    };

    it.each([
      ['calculator view', '', () => h.preMarketSignals],
      ['alerts view', '#alerts', () => h.optionsAlertsView],
    ] as const)(
      'the clock closing turns every poll and panel gate off (%s)',
      (_view, hash, panel) => {
        globalThis.location.hash = hash;
        h.access.mode = 'owner';
        h.market.current = marketFor(OWNER_LIVE);
        const { rerender } = mountApp();
        expect(lastPollingGates()).toEqual(allPollingGates(true));
        expect(lastArgAt(panel(), 0)).toEqual(
          expect.objectContaining({ marketOpen: true }),
        );

        // The session ends and quotes stops answering: data.quotes keeps its
        // last payload, which still says the market is open.
        h.market.current = marketFor({ ...OWNER_LIVE, clockOpen: false });
        rerender(appElement());

        expect(lastPollingGates()).toEqual(allPollingGates(false));
        expect(lastArgAt(panel(), 0)).toEqual(
          expect.objectContaining({ marketOpen: false }),
        );
      },
    );

    it('losing owner or guest access turns the panel gate off, though nothing else about the market changed', () => {
      // No market data, so hasMarketContext is false before and after and the
      // access flip cannot move the panels through it. The same market object
      // is reused, which keeps `market` out of the dependencies that move. What
      // does move is isAuthenticated and the liveMarketOpen derived from it, so
      // this fails if both leave the panelMap memo's dependencies. Dropping
      // liveMarketOpen alone is not caught, and cannot be: it is a function of
      // isAuthenticated and `market`, which stay listed.
      const market = marketFor(
        { ...OWNER_LIVE, quotesFlag: null, gate: true },
        false,
      );
      h.access.mode = 'owner';
      h.market.current = market;
      const { rerender } = mountApp();
      expect(lastArgAt(h.preMarketSignals, 0)).toEqual({ marketOpen: true });
      expect(lastArgAt(h.ivInputSection, 0)).toEqual(
        expect.objectContaining({ marketOpen: true }),
      );
      expect(lastArgAt(h.marketRegimeSection, 0)).toEqual(
        expect.objectContaining({ marketOpen: true, showFlowRegime: true }),
      );

      // Pre-Market Signals leaves the registry with the owner's access, so the
      // flip unmounts it rather than handing it a closed gate.
      h.preMarketSignals.mockClear();
      h.access.mode = 'public';
      rerender(appElement());

      expect(h.market.current).toBe(market);
      expect(lastPollingGates()).toEqual(allPollingGates(false));
      expect(h.preMarketSignals).not.toHaveBeenCalled();
      expect(lastArgAt(h.ivInputSection, 0)).toEqual(
        expect.objectContaining({ marketOpen: false }),
      );
      expect(lastArgAt(h.marketRegimeSection, 0)).toEqual(
        expect.objectContaining({ marketOpen: false, showFlowRegime: false }),
      );
    });
  });

  // The GEX Landscape reports its bias summary and, after the close, the ISO
  // time its strikes were captured. App keeps both and hands them to
  // useAnalysisContext, which sends them to analyze.
  describe('the GEX Landscape bias reaching the analysis context', () => {
    const CAPTURED_AT = '2026-11-20T21:00:49.000Z';
    type OnBiasChange = (
      summary: string | null,
      closedAsOf: string | null,
    ) => void;

    async function mountWithLandscape(): Promise<OnBiasChange> {
      h.access.mode = 'owner';
      h.market.current = marketFor(viewer('owner'));
      mountApp();
      await waitFor(() => expect(h.gexLandscape).toHaveBeenCalled());
      const props = lastArgAt(h.gexLandscape, 0) as {
        onBiasChange: OnBiasChange;
      };
      return props.onBiasChange;
    }

    it('hands useAnalysisContext the summary and the closed capture time the panel reports', async () => {
      const onBiasChange = await mountWithLandscape();
      // Nothing reported yet.
      expect(lastArgAt(h.useAnalysisContext, 0)).toMatchObject({
        gexLandscapeBias: null,
        gexLandscapeBiasClosedAsOf: null,
      });

      act(() => onBiasChange('Verdict: pinned near 6,880', CAPTURED_AT));
      expect(lastArgAt(h.useAnalysisContext, 0)).toMatchObject({
        gexLandscapeBias: 'Verdict: pinned near 6,880',
        gexLandscapeBiasClosedAsOf: CAPTURED_AT,
      });

      // Back on a live or scrubbed view the marker goes, the summary stays.
      act(() => onBiasChange('Verdict: pinned near 6,880', null));
      expect(lastArgAt(h.useAnalysisContext, 0)).toMatchObject({
        gexLandscapeBias: 'Verdict: pinned near 6,880',
        gexLandscapeBiasClosedAsOf: null,
      });
    });

    it('hands the panel one callback for every render, so its report effect does not re-run', async () => {
      const onBiasChange = await mountWithLandscape();
      act(() => onBiasChange('Verdict: pinned near 6,880', CAPTURED_AT));

      const callbacks = new Set(
        argsAt(h.gexLandscape, 0).map(
          (arg) => (arg as { onBiasChange: OnBiasChange }).onBiasChange,
        ),
      );
      expect(callbacks.size).toBe(1);
    });
  });

  // A visitor with no owner or guest session keeps no UW or GEXBot data in this
  // browser, however they got to public: a page that loads public (the cookie
  // lapsed between visits), the auth interceptor dropping the session mid-visit,
  // or a guest signing out. App reads one access mode for all three, so one
  // effect on it purges. The key names belong to the writers; the util's own
  // test (licensed-client-caches.test.ts) pins them, and this block pins when
  // App calls it.
  describe('licensed client caches', () => {
    const LICENSED_KEYS = [
      'openingFlowSignal.lastGood',
      'openingFlowSignal.lastGood:2026-11-20',
      'regime0dte:lastgood',
      'feed-union:lottery:2026-11-20:sig',
      'feed-union:lottery-reignited:2026-11-20:sig',
      'feed-union:silent-boom:2026-11-20:sig',
    ] as const;
    // Preferences the purge must leave alone.
    const KEPT: Record<string, string> = {
      'lottery.sortMode': '"newest"',
      'sc-panel-prefs-v1': '{"hidden":["sec-gex-target"],"order":[]}',
    };

    function seedLicensed(): void {
      for (const key of LICENSED_KEYS) localStorage.setItem(key, 'cached');
    }

    function licensedPresent(): string[] {
      return LICENSED_KEYS.filter((key) => localStorage.getItem(key) !== null);
    }

    function keptNow(): Record<string, string | null> {
      return Object.fromEntries(
        Object.keys(KEPT).map((key) => [key, localStorage.getItem(key)]),
      );
    }

    beforeEach(() => {
      localStorage.clear();
      for (const [key, value] of Object.entries(KEPT)) {
        localStorage.setItem(key, value);
      }
      h.market.current = marketFor(viewer('owner'));
    });

    afterEach(() => {
      localStorage.clear();
    });

    it('removes them when the page loads public', () => {
      h.access.mode = 'public';
      seedLicensed();

      mountApp();

      expect(licensedPresent()).toEqual([]);
      expect(keptNow()).toEqual(KEPT);
    });

    it.each(['owner', 'guest'] as const)(
      'removes nothing when the page loads as %s',
      (mode) => {
        h.access.mode = mode;
        h.market.current = marketFor(viewer(mode));
        seedLicensed();

        mountApp();

        expect(licensedPresent()).toEqual(LICENSED_KEYS);
        expect(keptNow()).toEqual(KEPT);
      },
    );

    it.each(['owner', 'guest'] as const)(
      'removes them when %s access drops to public without a remount',
      (mode) => {
        h.access.mode = mode;
        h.market.current = marketFor(viewer(mode));
        seedLicensed();
        const { rerender } = mountApp();
        expect(licensedPresent()).toEqual(LICENSED_KEYS);

        h.access.mode = 'public';
        rerender(appElement());

        expect(licensedPresent()).toEqual([]);
        expect(keptNow()).toEqual(KEPT);
      },
    );

    it('removes nothing when the owner becomes a guest', () => {
      // isAuthenticated holds across this flip, so the effect does not re-run.
      h.access.mode = 'owner';
      seedLicensed();
      const { rerender } = mountApp();

      h.access.mode = 'guest';
      rerender(appElement());

      expect(licensedPresent()).toEqual(LICENSED_KEYS);
    });

    it('removes nothing on sign-in, and keeps what is written after it', () => {
      h.access.mode = 'public';
      seedLicensed();
      const { rerender } = mountApp();
      expect(licensedPresent()).toEqual([]);

      // Written while public, so before the sign-in lands.
      localStorage.setItem('regime0dte:lastgood', 'written before sign-in');
      h.access.mode = 'guest';
      h.market.current = marketFor(viewer('guest'));
      rerender(appElement());
      expect(localStorage.getItem('regime0dte:lastgood')).toBe(
        'written before sign-in',
      );

      // Written by the guest's panels, then more renders.
      localStorage.setItem('openingFlowSignal.lastGood', 'written as guest');
      rerender(appElement());
      rerender(appElement());

      expect(licensedPresent()).toEqual([
        'openingFlowSignal.lastGood',
        'regime0dte:lastgood',
      ]);
      expect(keptNow()).toEqual(KEPT);
    });

    it('removes them again on a second drop, not only the first', () => {
      h.access.mode = 'guest';
      h.market.current = marketFor(viewer('guest'));
      seedLicensed();
      const { rerender } = mountApp();

      h.access.mode = 'public';
      rerender(appElement());
      expect(licensedPresent()).toEqual([]);

      h.access.mode = 'guest';
      rerender(appElement());
      seedLicensed();
      h.access.mode = 'public';
      rerender(appElement());

      expect(licensedPresent()).toEqual([]);
    });
  });

  // The chain fetch (useChainData's first argument) is the live /api/chain, so
  // it follows the selected date, not whether history has loaded: since
  // useHistoryData also fetches today's candles, `hasHistory` is true on
  // today once the first candle exists, and gating on it would freeze the
  // chain for the rest of the session.
  describe('the chain fetch and the selected date', () => {
    beforeEach(() => {
      h.market.current = marketFor(viewer('owner'));
    });

    it('is on for today with no history', () => {
      // "Today" is the mock clock's 2026-11-18, a past date by the wall clock:
      // judging "past" against the wall clock would turn this off.
      mountApp();

      expect(new Set(argsAt(h.useChainData, 0))).toEqual(new Set([true]));
    });

    it("stays on for today once today's history has loaded", () => {
      h.history.hasHistory = true;
      mountApp();

      expect(new Set(argsAt(h.useChainData, 0))).toEqual(new Set([true]));
    });

    it.each([
      ['with history', true],
      ['without history (a weekend, a holiday, a failed fetch)', false],
    ])('is off for a past date %s', (_label, hasHistory) => {
      h.vix.selectedDate = '2026-11-17';
      h.history.hasHistory = hasHistory;
      mountApp();

      expect(new Set(argsAt(h.useChainData, 0))).toEqual(new Set([false]));
    });

    it('turns off when the date moves to a past one, and back on at today', () => {
      h.history.hasHistory = true;
      const { rerender } = mountApp();
      expect(lastArgAt(h.useChainData, 0)).toBe(true);

      h.vix.selectedDate = '2026-11-17';
      rerender(appElement());
      expect(lastArgAt(h.useChainData, 0)).toBe(false);

      h.vix.selectedDate = h.vix.etToday;
      rerender(appElement());
      expect(lastArgAt(h.useChainData, 0)).toBe(true);
    });

    it('is off without market data, whatever the date', () => {
      h.market.current = marketFor(viewer('owner'), false);
      mountApp();

      expect(new Set(argsAt(h.useChainData, 0))).toEqual(new Set([false]));
    });
  });

  // Here useMarketData is the real hook (everything else is still mocked), fed
  // a quote by a stubbed /api/quotes. It keeps `data` when a visitor drops to
  // public, so what App reads as "market data" has to come from the hook's own
  // `hasData`, which reads false for a public visitor.
  describe('a drop to public, with the real useMarketData', () => {
    const realFetch = globalThis.fetch;

    beforeEach(async () => {
      const actual = await vi.importActual<
        typeof import('../hooks/useMarketData')
      >('../hooks/useMarketData');
      h.useMarketData.mockImplementation(actual.useMarketData);
      // Only /api/quotes answers; every other request fails, as an unstubbed
      // fetch does in this suite.
      globalThis.fetch = vi.fn((url: string) =>
        url === '/api/quotes'
          ? Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({ marketOpen: true, spx: { price: 6000 } }),
            })
          : Promise.reject(new TypeError('fetch failed')),
      ) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('keeps the chain fetch off for a visitor who had a past date selected', async () => {
      h.access.mode = 'guest';
      const { rerender } = mountApp();
      // The quote lands: market data is there, and the live view enables the
      // chain.
      await waitFor(() => expect(lastArgAt(h.useChainData, 0)).toBe(true));

      // A past date is selected, so the chain is off.
      h.vix.selectedDate = '2026-11-17';
      h.history.hasHistory = true;
      rerender(appElement());
      expect(lastArgAt(h.useChainData, 0)).toBe(false);

      // The session drops to public, on today, and the history hook clears its
      // history. The quote the market hook keeps must not turn the chain back
      // on: /api/chain is owner-or-guest, so the request would be a 401. The
      // date is today so that only the access mode can keep it off.
      h.useChainData.mockClear();
      h.access.mode = 'public';
      h.vix.selectedDate = h.vix.etToday;
      h.history.hasHistory = false;
      rerender(appElement());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(h.useChainData).toHaveBeenCalled();
      expect(new Set(argsAt(h.useChainData, 0))).toEqual(new Set([false]));
    });
  });
});
