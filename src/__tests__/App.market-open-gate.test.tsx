import { Fragment, createElement, type ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
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
   * True: the PanelRouter stand-in renders only the ids the registry lists, as
   * the real router does. False: it renders every id in `renderedPanels`, so a
   * test can reach App's own per-panel gates (GatedSection's `gate`) that the
   * registry would otherwise cover.
   */
  routeByRegistry: { on: true },
  /**
   * Panel ids the PanelRouter stand-in renders: plain ones, ones behind a
   * GatedSection, and the two sections that poll through a leaf of their own
   * (sec-iv's term structure, sec-regime's flow-regime badge).
   */
  renderedPanels: [
    'sec-premarket',
    'sec-iv',
    'sec-regime',
    'sec-gex-target',
    'sec-gex-landscape',
  ],
  nullComponent: () => null,
  panelPrefs: {
    order: [] as string[],
    groupOrder: [] as string[],
    hidden: new Set<string>(),
    isHidden: () => false,
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
  useMarketData: () => h.market.current,
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
  useHistoryData: () => ({ hasHistory: false, history: null }),
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
  useAnalysisContext: () => h.analysisContext,
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

// The real router walks the whole registry, which would pull in every lazy
// panel. This one renders only the panels this test reads, through the same
// panelMap closures App builds, and keeps the real router's skips: an id the
// registry does not list for the current access mode (the real router walks
// `resolvedGroups` and reads each group's ids from `resolvedPanelsByGroup`),
// so a panel the registry hides from a public visitor is not rendered here
// either, and an id `isHidden` says the visitor hid.
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
});
