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

/**
 * Build a string for `page.addInitScript()` that installs a
 * non-overridable fetch mock for /api/ endpoints.
 *
 * Any key in `mocks` whose value is `{ body, status? }` will match
 * URLs containing that key (e.g. `'/api/quotes'`).
 *
 * All other /api/ requests receive an empty 200 JSON response.
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
      Object.defineProperty(globalThis, 'fetch', {
        get: function() { return _mockFetch; },
        set: function() {},
        configurable: false,
      });
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
