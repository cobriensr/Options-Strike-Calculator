/**
 * E2E fetch mock helper.
 *
 * Vite's dev-server replaces `window.fetch` with its own wrapper
 * (VitePWA / @vite/client), so Playwright's `page.route()` and
 * simple `window.fetch` overrides are both ineffective.
 *
 * This helper uses `Object.defineProperty` with `configurable: false`
 * to install a non-replaceable fetch mock before any other scripts
 * run, preventing Vite from overwriting it.
 *
 * Usage:
 *   await page.addInitScript(buildApiFetchMock({ quotes: MOCK_QUOTES }));
 */

/** Empty per-symbol day payload matching `SymbolDayData` (src/types/api.ts). */
const EMPTY_SYMBOL_DAY = {
  candles: [],
  previousClose: 0,
  previousDay: null,
};

/**
 * Default `/api/history` response shaped like `HistoryResponse`
 * (src/types/api.ts). The generic `{}` fallback breaks the app:
 * `useHistoryData` reads `history.spx.candles` and throws inside a
 * render effect, tripping the app-level ErrorBoundary so nothing
 * renders.
 */
export const DEFAULT_HISTORY_RESPONSE = {
  date: '2026-01-02',
  spx: EMPTY_SYMBOL_DAY,
  vix: EMPTY_SYMBOL_DAY,
  vix1d: EMPTY_SYMBOL_DAY,
  vix9d: EMPTY_SYMBOL_DAY,
  vvix: EMPTY_SYMBOL_DAY,
  candleCount: 0,
  asOf: new Date().toISOString(),
};

/**
 * Typed empty defaults for always-fetched /api/ routes whose consumers
 * cannot survive the generic `{}` fallback (each one either trips an
 * ErrorBoundary or spins a poll/crash/remount loop that floods the
 * console with "Maximum update depth exceeded"). Shapes mirror the
 * consumer hook's response interface exactly; see the per-route notes.
 *
 * A spec's explicit mock for any of these fragments always wins —
 * defaults are appended after the spec's entries and matched last.
 */
export const DEFAULT_API_RESPONSES: Record<string, unknown> = {
  // useHistoryData reads history.spx.candles (app-level crash).
  '/api/history': DEFAULT_HISTORY_RESPONSE,
  // OpeningFlowSignal maps over displayData.tickers[ticker]
  // (src/hooks/useOpeningFlowSignal.ts OpeningFlowResponse).
  '/api/opening-flow-signal': {
    date: '2026-01-02',
    windowStatus: 'closed',
    openUtc: '2026-01-02T14:30:00.000Z',
    slice1EndUtc: '2026-01-02T14:35:00.000Z',
    slice2EndUtc: '2026-01-02T14:40:00.000Z',
    asOfUtc: new Date().toISOString(),
    stopPct: 0.5,
    exitMinutesFromEntry: 60,
    tickers: {},
  },
  // PinSetupTile renders data.state.replace(...) whenever data is truthy
  // (src/hooks/usePinSetupStatus.ts PinSetupStatus).
  '/api/pin-setup-status': {
    evaluatedAt: new Date().toISOString(),
    date: null,
    mode: 'live',
    snapshotTs: null,
    staleMinutes: null,
    state: 'NOT_TRIGGERED',
    conditions: {
      netGammaAtMagnetM: 0,
      netGammaThresholdM: 0,
      netGammaMet: false,
      magnetStrike: null,
      isRound50: false,
      distanceToMagnet: null,
      distanceThreshold: 0,
      distanceMet: false,
    },
    spot: null,
    bias: 'no-signal',
    recommendedTradeTypes: [],
    avoidedTradeTypes: [],
    trajectory: [],
    outcome: null,
    asOf: new Date().toISOString(),
  },
  // DarkPoolLevels maps over the levels prop; useDarkPoolLevels also
  // reads data.levels[0] while parsing.
  '/api/darkpool-levels': {
    levels: [],
    date: '2026-01-02',
    meta: { lastUpdated: null },
  },
  // GexLandscape loops (setState churn) on a shapeless response
  // (src/hooks/useGexLandscapeData.ts GexLandscapeResponse).
  '/api/gex-landscape': {
    marketOpen: false,
    asOf: new Date().toISOString(),
    data: null,
    reason: 'no_slot',
    availableMinutes: [],
  },
  // StrikeBattleMap reads data[ticker].rows.length
  // (src/hooks/useGexStrikeExpiry.ts GexStrikeExpiryResponse).
  '/api/gex-strike-expiry': {
    ticker: 'SPX',
    expiry: '2026-01-02',
    at: null,
    rows: [],
    timestamps: [],
    asOf: new Date().toISOString(),
  },
  // GexTarget PriceChart calls createPriceLine({ price: previousClose })
  // behind a `!== null` guard, so previousClose must be null, not
  // undefined (src/hooks/useGexTarget.ts GexTargetHistoryResponse).
  '/api/gex-target-history': {
    availableDates: [],
    date: null,
    timestamps: [],
    timestamp: null,
    spot: null,
    oi: null,
    vol: null,
    dir: null,
    candles: [],
    previousClose: null,
  },
  // GammaNodeDetectorPanel reads data.fires.length
  // (src/hooks/useGammaSetups.ts GammaSetupsResponse; URL is
  // /api/gamma-setups/active — fragment match covers it).
  '/api/gamma-setups': {
    today: '2026-01-02',
    dow_label: null,
    confidence_tier: null,
    pre_day_filter_fires: false,
    prior_5d_ret: null,
    prior_iv_rank: null,
    open_gap_pct: 0,
    anti_filters: {
      is_fomc_day: false,
      is_dom_1_5: false,
      is_dom_16_20: false,
    },
    nearest_floor: null,
    nearest_ceiling: null,
    fires: [],
  },
  // PeriscopeChatHistory reads dates.length / items — the same route
  // serves ?dates=true ({dates}) and ?date=... ({items}).
  '/api/periscope-chat-list': { dates: [], items: [] },
  // LessonLibrary filters over data.lessons.
  '/api/periscope-lessons-list': { lessons: [] },
  // PeriscopeLotteryPanel filters over fires
  // (src/components/PeriscopeLottery/types.ts PeriscopeLotteryFeedResponse).
  '/api/periscope-lottery-feed': {
    date: '2026-01-02',
    fireType: 'all',
    count: 0,
    fires: [],
  },
};

/**
 * Build a string for `page.addInitScript()` that installs a
 * non-overridable fetch mock for /api/ endpoints.
 *
 * Any key in `mocks` whose value is `{ body, status? }` will match
 * URLs containing that key (e.g. `'/api/quotes'`).
 *
 * Routes listed in `DEFAULT_API_RESPONSES` get typed empty defaults
 * unless the spec mocks them explicitly — explicit mocks are matched
 * first. All other /api/ requests receive an empty 200 JSON response.
 * Non-api requests pass through to the real network.
 */
export function buildApiFetchMock(
  mocks: Record<string, { body: unknown; status?: number; method?: string }>,
): string {
  const entries = Object.entries(mocks).map(([urlFragment, cfg]) => ({
    urlFragment,
    body: JSON.stringify(cfg.body),
    status: cfg.status ?? 200,
    method: cfg.method,
  }));

  // Defaults for always-fetched routes whose consumers cannot survive
  // the generic `{}` fallback. Appended AFTER the spec's own entries so
  // an explicit mock always wins (first match in the loop below).
  for (const [urlFragment, body] of Object.entries(DEFAULT_API_RESPONSES)) {
    if (!Object.keys(mocks).some((k) => k.includes(urlFragment))) {
      entries.push({
        urlFragment,
        body: JSON.stringify(body),
        status: 200,
        method: undefined,
      });
    }
  }

  return `
    (function() {
      var _nativeFetch = window.fetch.bind(window);
      var _mocks = ${JSON.stringify(entries)};

      function _mockFetch(input, init) {
        var url = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.href : input.url);
        var method = (init && init.method) || 'GET';

        for (var i = 0; i < _mocks.length; i++) {
          var m = _mocks[i];
          if (url.indexOf(m.urlFragment) !== -1) {
            if (m.method && m.method !== method) continue;
            return Promise.resolve(new Response(m.body, {
              status: m.status,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
        }

        // Fallback: any /api/ call not explicitly mocked returns empty 200
        if (url.indexOf('/api/') !== -1) {
          return Promise.resolve(new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }

        return _nativeFetch(input, init);
      }

      Object.defineProperty(window, 'fetch', {
        get: function() { return _mockFetch; },
        set: function() { /* prevent Vite from overriding */ },
        configurable: false,
      });
      try {
        Object.defineProperty(globalThis, 'fetch', {
          get: function() { return _mockFetch; },
          set: function() {},
          configurable: false,
        });
      } catch (e) {
        // window === globalThis in the main world, so the property is
        // already locked by the defineProperty above — expected.
      }
    })();
  `;
}

/** Standard mock quotes payload used across chart-analysis and positions tests. */
export const MOCK_QUOTES = {
  spy: {
    price: 679,
    open: 678,
    high: 680,
    low: 677,
    prevClose: 678,
    change: 1,
    changePct: 0.15,
  },
  spx: {
    price: 6790,
    open: 6780,
    high: 6800,
    low: 6770,
    prevClose: 6780,
    change: 10,
    changePct: 0.15,
  },
  vix: {
    price: 19,
    open: 19,
    high: 20,
    low: 18,
    prevClose: 19,
    change: 0,
    changePct: 0,
  },
  vix1d: {
    price: 16,
    open: 16,
    high: 17,
    low: 15,
    prevClose: 16,
    change: 0,
    changePct: 0,
  },
  vix9d: {
    price: 18,
    open: 18,
    high: 19,
    low: 17,
    prevClose: 18,
    change: 0,
    changePct: 0,
  },
  vvix: {
    price: 90,
    open: 90,
    high: 92,
    low: 88,
    prevClose: 90,
    change: 0,
    changePct: 0,
  },
  marketOpen: true,
  asOf: new Date().toISOString(),
};
