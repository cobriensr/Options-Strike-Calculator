# PineTS and LuxAlgo Broker SDK: evaluation notes (parked)

**Status:** parked, 2026-11-12. Nothing is installed and no code exists. These notes are the starting point if we decide to build it.

**Goal, if we pursue it:** run our own Pine Script indicators on our data (Schwab SPX candles, `futures_bars`) inside the app or its backend, so one Pine source drives both TradingView and our tools.

## What PineTS is

- Repo: <https://github.com/LuxAlgo/PineTS>. npm `pinets`, version 0.13.1. Main was at `100357e` (2026-10-27) when reviewed.
- It translates Pine Script v5/v6 into JavaScript and runs it. Coverage includes `ta.*`, `request.security`, `strategy.*`, drawings (line, label, box, table, polyline), arrays, maps, matrices, enums, and library `import`.
- Size and health: about 52k lines of TypeScript in `src/`, 289 test files, and 3 runtime dependencies (acorn, acorn-walk, astring). About 940 stars and about 35 open issues. Releases came out on 2026-10-22 and 2026-10-27.
- People: the original author wrote most of it. A LuxAlgo developer now merges the releases, and outside contributors send fixes.
- License: AGPL-3.0-only, with a paid commercial license as an option (`LICENSE-COMMERCIAL.md`).

## Findings

### License: compatible, no commercial license needed

This repo is public and already AGPL-3.0 (`LICENSE.md`, and `"license": "AGPL-3.0-only"` in `package.json`). Shipping PineTS in our bundle or our functions fits that license. This is our reading, not legal advice.

### Data in and out: easy

- Built-in data sources are Binance, FMP and Alpaca. None of them is useful for SPX.
- You can pass a plain array of OHLCV bars instead. You can also implement the small `IProvider` interface in `src/marketData/IProvider.ts`: `getMarketData`, `getSymbolInfo` and `configure`. `ISymbolInfo` carries `timezone`, `session` and `mintick`. The comments there say that for stocks, `closeTime` must be the session close time.
- Output is plot series. They map naturally onto `lightweight-charts`, which is already a dependency.
- Network: with an array source, PineTS makes no data calls. Library `import` resolvers can fetch from GitHub or a URL (`src/imports/GitHub`, `src/imports/Url`), so vendor any libraries or turn imports off.

### Blockers and costs

1. **Our CSP blocks it in the browser.** PineTS compiles the generated code with `new Function(...)` at `src/transpiler/index.ts:290` and `src/transpiler/slicing/buildLtfSlices.ts:327`. The CSP in `vercel.json` sets `script-src 'self' https://va.vercel-scripts.com https://browser.sentry-cdn.com https://vercel.live`, with no `'unsafe-eval'`, so the browser refuses. There are three ways around it:
   - **Server-side**, in a Vercel function or script. No CSP applies there. This is the cleanest option.
   - **A dedicated Web Worker** with its own CSP header rule that allows `'unsafe-eval'` for that one file only. The worker can still `fetch` same-origin endpoints with the owner cookie, so it is only safe with owner-written scripts.
   - **Adding `'unsafe-eval'` to the whole app.** Don't.
2. **Session markets are the weak spot, and SPX and ES are session markets.** These open issues bear on us:
   - #401: `time_tradingday`, `timeframe.change` and weekly/monthly bars use the UTC calendar instead of the trading day.
   - #406: higher-timeframe `request.security` values come out NaN outside the higher-timeframe bar's session window, and the lookahead-off mapping differs from TradingView across session gaps.
   - #356: the higher-timeframe context gets too little warm-up history, so `ta.atr`, `ta.rma` and `ta.ema` differ from TradingView.
   - #439, #440 and #263: live streaming problems. `request.security` returns na on the forming bar, the update interval is at least about 1 s, and plot values get appended on every live update.

   Single-timeframe indicators on 1- or 5-minute bars look fine. Multi-timeframe scripts and live streaming need checking against TradingView first.
3. **Bundle size.** `pinets.min.browser.es.js` is 815,571 bytes minified, before gzip. A browser build would have to lazy-load it, with `.catch()` and a reload prompt, and keep it out of the PWA precache.
4. **History cap.** Providers and `max_bars_back` are capped at 5,000 bars. An RTH session has 390 one-minute bars, so that is about 12.8 sessions of 1-minute history. Whether a custom array is capped too is **unverified**; check it in the spike.
5. **Code execution.** `src/transpiler/analysis/ClosedWorldVerifier.ts` checks the generated code before it is compiled. It rejects free identifiers (`fetch`, `process`, `globalThis`), prototype tricks (`constructor`, `__proto__`) and dynamic member access. That is good, but the code still runs in our process. Only run scripts the owner wrote, and never accept a script from a guest.
6. **Data licensing.** An indicator's output inherits the auth of its inputs. Schwab prices only: public is fine. Anything that reads UW or GEXBot data needs `guardOwnerOrGuestEndpoint` or `withDbReader(..., 'owner-or-guest')`.
7. **Pre-1.0 API.** Pin the exact version (no `^`) and re-run the parity check on every upgrade.

### LuxAlgo Broker SDK: not adopting

npm `@luxalgo/broker-sdk` 0.7.0, MIT license, first published 2026-08-25.

- **Trust checks passed:** no runtime dependencies, no install scripts, and React is an optional peer dependency. I listed every host the shipped `dist/` code calls: only broker APIs plus `api.frankfurter.dev` (public currency rates). There are no LuxAlgo endpoints, which matches its "no telemetry" claim.
- **Poor fit for us:**
  - We already have Schwab OAuth and positions.
  - Its common data shape drops option structure. A position is symbol, quantity and market value; a trade is symbol, side, quantity and price. An iron condor becomes four unrelated rows, which is the same problem we have with CSV spreads read as naked legs.
  - Its Schwab adapter wants its own client ID, secret and refresh token, alongside our token handling.
  - It has no Schwab bars and no Schwab order placement. Orders exist only for Alpaca, Tradier sandbox and Binance testnet.
- Possible reuse: its FIFO win-rate stats module. We already have `api/_lib/csv-parser.ts` for CSV imports.

## Phases, if we go ahead

Each phase can ship on its own.

### Phase 0: parity spike, no app code (about half a day)

- Write a Node script in a session scratchpad or `docs/tmp/`, not in `api/` or `src/`.
- Run one or two indicators the owner already uses on TradingView through PineTS on:
  - a few sessions of ES 1-minute bars from `futures_bars`;
  - Schwab SPX 5-minute candles.
- Compare bar by bar with TradingView's exported values.
- Measure the run time for 5,000 bars.
- Check whether an array source is capped at 5,000 bars.
- **Exit:** single-timeframe values match. Multi-timeframe gaps are written down here. Then we decide yes or no.

### Phase 1: server-side runner (about 1–2 days)

- Pin `pinets` at an exact version.
- Add a runner module that takes bars and a script and returns plot series, with tests that cover a bad script, empty bars and a script that throws.
- Add a GET reader endpoint wrapped in `withDbReader`, with auth set by its inputs (see Open questions).
- Scripts are owner-written files in the repo. Users never send them.

### Phase 2: chart overlay (about 1–2 days)

- The UI fetches the computed series from the Phase 1 endpoint and draws them on an existing `lightweight-charts` chart.
- With the server-side path, the browser never runs PineTS, so the CSP stays as it is.
- Consider the Web Worker path only if we need live per-tick recomputation in the browser.

## Files to create or modify (tentative)

- **Phase 0:** none in the repo. The script lives in a scratchpad or `docs/tmp/`.
- **Phase 1:**
  - `package.json`;
  - `api/_lib/pine-runner.ts` and its test;
  - an endpoint under `api/`, plus its test;
  - the Pine source files (see the `pine/` warning below);
  - `src/main.tsx` `initBotId()` `protect` list, if the endpoint calls `checkBot`.
- **Phase 2:** the chart component that gets the overlay, and a fetch hook in `src/hooks/` with a Zod schema at the boundary.

**Warning:** `vercel.json`'s `ignoreCommand` skips deploys when only `pine/` changes. Pine sources that a function bundles must not live in `pine/`, or a change to them alone will never deploy. Put them under `api/_lib/` or change `ignoreCommand`.

## Data dependencies

- Tables: none for Phase 0 or Phase 1. A cache table for computed series is only needed if running on every request is too slow (decide after Phase 0 timing).
- Env vars: none.
- External APIs: none. Our own bars only, and library imports vendored.

## Open questions (default picks in brackets)

1. Which indicator goes first? [One single-timeframe indicator already on the owner's TradingView chart.]
2. Draw it on a chart in the browser, or compute it on the server for alerts and backtests? [Server-side first. No CSP change.]
3. How close must PineTS match TradingView? [Equal to TradingView's displayed precision on every bar after warm-up.]
4. Where do Pine sources live? [A deployed path such as `api/_lib/pine/`, not `pine/`.]
5. Who can see the output? [The same auth as the inputs: public for Schwab-only inputs, owner-or-guest when UW or GEXBot data feeds in.]
6. Is PineTS a way to run the PAC strategy idea from `pac-backtester-2026-04-18.md` once and use it everywhere? [Only after Phase 0 shows parity. That spec also assumed Databento, which has been removed.]

## Thresholds and constants

- `pinets` 0.13.1, pinned exactly.
- History cap: 5,000 bars. At 390 RTH 1-minute bars per session, that is about 12.8 sessions.
- Browser bundle: 815,571 bytes minified (`pinets.min.browser.es.js`).
- `@luxalgo/broker-sdk` 0.7.0: evaluated and not adopted.
