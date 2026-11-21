# Public visitors must not fetch owner-or-guest endpoints (2026-11-19)

## Goal

A public visitor (no owner or guest session) should never call an owner-or-guest or owner endpoint, see a red "HTTP 401" tile, or see Unusual Whales / GEXBot data cached by an earlier session. Each access-mode check is read live, so signing in with a guest key without a reload, or dropping to public mid-session, takes effect at once.

## Why

- **Data-licensing rule (CLAUDE.md).** UW and GEXBot data, and values computed from it, require owner or guest auth. Today a browser that was ever a guest or owner paints the last opening-flow payload to a public visitor (`openingFlowSignal.lastGood` never expires).
- **Public visitors see errors.** On every load they get a red "HTTP 401" in Pre-Market Signals, and a red "NO INTRADAY / Not authenticated" badge when they pick a past date.
- **Wasted requests.** Each wasted request also spends a BotID check. There are about 8 per public page load.
- **Follows branch `fix/market-open-gate`,** which gated App's polling on `isAuthenticated && market.marketOpen` and fixed the same defect for the flow-regime badge and the 0DTE regime panel. A read-only audit on 2026-11-19 found the rest. The full report, with file:line citations, is reproduced in the appendix.

## Precedents to follow

- **Hook level:**
  - null url for `useFetchedData` when `getAccessMode() === 'public'` (`useFlowRegime`);
  - closed window for `usePolledWindowSignal` (`useRegime0dte`);
  - `checkIsOwner()` gates (`useDealerRegime`, `useGexTarget`, `useVixTrajectory`).
- **Panel level:** `if (isAuthenticated) list.push(...)` in `src/constants/panel-registry.ts` (as done for `sec-regime-0dte`). This removes the panel, its nav entry and its prefs entry.
- **Read the mode live.** Read it at render, or take it from `useAccessSession()`, never frozen in a `useRef`. App re-renders on every mode change.

## Phases (each ≤ 5 files, each its own implement → review → commit)

1. **Pre-Market Signals (audit A + B, part 1).**
   - Move `sec-premarket` behind `isAuthenticated` in the registry. Both of its cards (opening-flow signal, pin setup) are owner-or-guest, so nothing public remains in it.
   - `useOpeningFlowSignal`: no eager fetch, poll or date-pick fetch for public, and no cached `displayData` for public.
   - Files: `panel-registry.ts`, its test, `useOpeningFlowSignal.ts`, its test.
2. **Pin setup + history (audit B part 2, D).**
   - `usePinSetupStatus`: no fetch for public.
   - `useHistoryData`: public means "no history": no fetch, `history = null`, `error = null`. The live mode goes in the effect deps so a guest login refetches. A public past-date pick then shows BACKTEST only, no NO INTRADAY badge.
   - Files: the two hooks and their tests.
3. **Analysis History and charts (audit C, 6.2).**
   - `AnalysisHistory` is owner-only in practice: it returns null for guests too, after its fetch has run. Move the owner check above the effects so nothing fetches for a non-owner.
   - Add `isOwner` to `PanelRegistryContext` and list `sec-history` only for the owner.
   - Gate `sec-charts` on `isAuthenticated && hasMarketOrSnapshot` (it is gated on `hasMarketOrSnapshot` alone today), so stale `market.data` after a downgrade doesn't show it.
   - Files: `AnalysisHistory.tsx` and its test, `panel-registry.ts` and its test, `App.tsx`.
   - Landed as 4 commits: (1) `AnalysisHistory` and its tests; (2) `sec-charts` gate, with `isOwner` added to `PanelRegistryContext` as optional and passed by `App.tsx` and `PanelPrefsModal.tsx`, plus the `App.panel-render` test that gate changes; (3) `isOwner` made required and `sec-history` owner-only, with the registry, nav-anchors, `App.panel-render` and `PanelPrefsModal` tests (the modal test landed here rather than in (4), because its public case expected the panel); (4) the App gate test pinning the `isOwner` wiring. A required field up front would have changed 2 production callers and 3 test files in one commit, over the 5-file cap.
4. **`useMarketData` (audit E, 6.1).**
   - Skip `/api/quotes`, `/api/intraday`, `/api/yesterday` and `/api/movers` for public. Keep `/api/events`, which is public.
   - Make the mount fetch and the poll gate follow the live access mode, not a once-set `isOwner` state:
     - a guest login without a reload fetches;
     - a downgrade stops polling and resets `isOwner`.
   - Keep the `needsAuth` / sign-in prompt behaviour a public visitor sees today, and test it.
   - Fix the stale header comment ("require an owner session cookie").
   - Files: `useMarketData.ts`, `useMarketData.fetchers.ts`, their tests.
   - Landed as 1 commit: the hook reads `isAuthenticated` at render; public sends the events request alone (`fetchForwardEvents`); the mount effect re-runs on a mode flip with an `AbortController` and writes nothing after an abort; the poll gate follows the mode and a late poll reply re-reads it; the AUD-M17 `isOwner` state and its 2xx probe are gone, and `needsAuth` is the owner's prompt only (false for a guest and while public).
   - Fix round 1: `hasData` masked for public (closes the `/api/chain` path after a downgrade, the stale quote badge and the notification prompt); the mount guard re-reads the mode.
   - Fix round 2: loading ends when the mode goes public mid-fetch; the header badge never reads LIVE on a regular-session quote at `closed` (pre-existing, found in review).
5. **Licensed-cache purge (audit section 4).**
   - Add one `clearLicensedClientCaches()` that removes `openingFlowSignal.lastGood*`, `regime0dte:lastgood` and every `feed-union:*` key.
   - Call it from one App effect: `if (!isAuthenticated) purge()`. That covers three cases: a session that starts public (expired or cleared cookie), the interceptor's downgrade, and guest logout.
   - Files: the new util, its test, `App.tsx`, and an App-level test.
6. **Panel prefs, guest owner-only call, comments (audit section 5, 6.3, 6.4).**
   - `usePanelPrefs`: read the mode per render instead of `useRef(getAccessMode()).current`. Then a guest login without a reload loads and saves the guest's server layout, and a downgrade stops PUTs.
   - `PreMarketInput`: skip its owner-only `/api/pre-market` GET for guests.
   - Fix the stale "guest 401s" comment in `useVixData.ts`.
   - Files: `usePanelPrefs.ts` and its test, `PreMarketInput.tsx` and its test, `useVixData.ts`.

## Data dependencies

None. There are no migrations, env vars or endpoint changes; every change is in `src/`.

## Calls made (the owner can overrule)

- **Pre-Market Signals is hidden from public visitors entirely.** Both of its cards are UW-derived, so nothing public is left to show.
- **Analysis History is listed for the owner only, not for guests.** The component already renders nothing for guests, so a guest has only been getting an empty nav entry.
- **The access check lives at both levels.** The registry gate handles visibility. The hook gate stops the fetch and covers memoised children (`PinSetupTile` is `memo`).

## Open questions

None blocking.

## Constants

None new.

## Appendix: audit (2026-11-19)

Read-only audit of branch `fix/market-open-gate` (now on main as 33ce943c), copied verbatim. Line numbers are as of that commit.

Confidence legend used below:
- CONFIRMED = I read the endpoint's guard line AND the client gating / render branch. UI outcomes are read from the render
  code, not observed in a browser.
- INFERRED = follows from code reading but depends on a runtime sequence I did not exercise.

All paths are repo-relative.

---

### 1. What a public visitor actually renders

#### 1.1 What a public visitor satisfies in `getPanelRegistry` (`src/constants/panel-registry.ts`)

- `isAuthenticated` = `accessMode !== 'public'` (`src/App.tsx:212`) = **false**.
- `hasMarketOrSnapshot` = `market.hasData || !!historySnapshot` (`src/App.tsx:769`) = **false** for a visitor who was public
  from page load. `market.hasData` needs a 200 from `/api/quotes`, `/api/intraday` or `/api/yesterday`
  (`src/hooks/useMarketData.ts` `hasData`). All three are owner-or-guest (guards cited in section 2), so they 401.
  `historySnapshot` needs a 200 from `/api/history`, also owner-or-guest.
- `liveMarketOpen` = `isAuthenticated && market.marketOpen` (`src/App.tsx:292`) = **false**. This closes polls only. It does
  NOT stop mount fetches in hooks built on `useFetchedData` or hand-rolled eager effects (see `useFetchedData.ts`: `marketOpen`
  gates only the recurring tick; the eager effect fires whenever `url != null`).

Registry entries a public visitor gets (not behind `isAuthenticated`):

| Panel id | Renders for public? | Notes |
|---|---|---|
| sec-datetime, sec-spot-price, sec-advanced, sec-risk, results | yes | no fetches |
| sec-iv | yes (collapsed by default, `App.tsx:1005`) | child `VIXTermStructure` -> `useVixTrajectory`, which is gated by `checkIsOwner()` (`useVixTrajectory.ts:114,144,148`). OK |
| sec-regime | yes (collapsed by default, `App.tsx:1045`) | `SectionBox` mounts children only when open (`ui/SectionBox.tsx:166`). `FlowRegimeBadge` hidden by `showFlowRegime` (fixed on this branch). The other children (VIXRangeAnalysis, VolatilityCluster, DeltaRegimeGuide, OpeningRangeCheck, PreTradeSignals, RvIvCard, PinRiskAnalysis, SettlementCheck) have no fetches (grepped) |
| **sec-premarket** | **yes, expanded by default** | **OFFENDER A + B** |
| sec-premarket-futures | anchor `<span>` only | `PreMarketInput` renders only when `market.hasData` (`App.tsx:935`). It does fetch `/api/pre-market` (owner-only) when shown, see 6.3 |
| **sec-history** | listed in nav and prefs modal; **renders `null`** for non-owners | **OFFENDER C** (fetch runs, UI is empty) |
| sec-positions | yes | `PositionMonitor` has no fetches (grepped) |
| sec-charts | **no** (needs `hasMarketOrSnapshot`, which is false) | registry gates it on `hasMarketOrSnapshot` only (`panel-registry.ts:139`), not on auth, so it can appear after a downgrade, see 6.2 |
| sec-regime-0dte | no (behind `isAuthenticated`, `panel-registry.ts:62`) | the earlier fix |
| every other `isAuthenticated` entry (`:69`, `:132`, `:151`, `:158`, `:177`) | no | |

#### 1.2 App.tsx outside the registry

- `topBars`: `AlertBanner` / `IntervalBAAlertBanner`, fed by `useAlertPolling` (gated `checkIsOwner()`, `useAlertPolling.ts:140,230,240`) and
  `useIntervalBAAlerts` (gated `getAccessMode() !== 'public'`, `useIntervalBAAlerts.ts:225,327,337`). OK.
- `AppHeader`: `SchwabExpiryBadge` -> `useSchwabAuthStatus(isOwner)` (owner only, `SchwabExpiryBadge.tsx:121`). Sign-in link is a plain `href`. The
  BACKTEST / NO INTRADAY badges read `historyData` (**OFFENDER D**).
- `prefsModal` (lazy), `notificationPrompt` (needs `market.hasData`), `EventDayWarning` (`/api/events`, public), `SectionNav` + `AccessKeyButton`
  (fetch only on submit to `/api/auth/guest-key`), `BackToTop`, `UpdateAvailableBanner` (`/sw.js` only), `BacktestDiag` (needs `historySnapshot`),
  `OptionsAlertsView` (alerts view, reachable by a public visitor via the header toggle or `#alerts`): gated by `hasMarketContext` and shows a static
  prompt instead (`OptionsAlerts/index.tsx:50-62`). OK, no fetch.
- No modal is open by default.
- App-level data hooks, evaluated for what they do when `mode === 'public'`:
  - `useMarketData` -> **OFFENDER E**
  - `useHistoryData` -> **OFFENDER D**
  - `useChainData(market.hasData && !hasHistory, liveMarketOpen)`: `enabled` is false for public (`hasData` false). OK. `fetchChain` even treats 401 as
    "public visitor" (`useChainData.ts:17`). This holds after a downgrade too, since Phase 4 fix round 1: `useMarketData` keeps `data` but masks `hasData` for public.
  - `useDarkPoolLevels`: `isOwner` gate before any fetch (`:249-252`). OK.
  - `usePeriscopeExposure`: `canFetch` gate before fetch and poll (`:93-94,106,156`). OK.
  - `useGexTarget`: `isOwner` gate on the bulk-load effect and poll (`:526,541`). OK.
  - `useSnapshotSave`: App passes `isOwner && ...` as `enabled` (`App.tsx:661`). OK.
  - `usePushSubscription`: mount effect only touches the local service worker, no fetch. OK.
  - `useVixData` -> `/api/vix-ohlc` (public: `api/vix-ohlc.ts:34` is `checkBot` only). OK.
  - `useVix1dData` -> `/api/vix1d-daily` (public by design: `api/vix1d-daily.ts:12-14,33`). OK.
  - `useEventsForDate` and the forward `/api/events` (public: `api/events.ts:61` is `checkBot` only). OK.
  - `startLiveSessionSignals` (`isActive()` = owner AND live-save device, `live-session-signal.ts:75`) and `startOwnerSessionRenewal`
    (owner only). OK.
  - `usePanelPrefs`: public skips the GET (by design), but see question (b).

---

### 2. Offending fetches (public visitor reaches an owner-or-guest endpoint)

Five call sites, eight endpoint hits per page load. A and B are the two the reviewer found. C, D and E are new.
Every owner-or-guest guard runs `checkBot` first (`api/_lib/guest-auth.ts:157-168`), so each wasted request also spends a BotID check.
The 401 body is `{ error: 'Not authenticated' }` (`guest-auth.ts:143`).

#### A. `OpeningFlowSignal` -> `useOpeningFlowSignal` -> `/api/opening-flow-signal`  (CONFIRMED)
- Guard: `api/opening-flow-signal.ts:45` (`guardOwnerOrGuestEndpoint`, runs for every request, first statement of the handler).
- Fires: **mount, always** (live mode fetches once even outside the window: `src/hooks/useOpeningFlowSignal.ts:353-359`), **on a poll** (a 30 s
  `usePolling` tick whose callback fetches only inside 08:25-08:50 CT, `:370-375`), and **on every date pick** (historical one-shot).
- Gate today: none on access. The only gates are the time window and `effectiveDate == null`. `PreMarketSignals` does not even pass an auth
  prop. `sec-premarket` is unconditional (`panel-registry.ts:49`).
- What the public visitor sees (`src/components/OpeningFlowSignal/OpeningFlowSignal.tsx`):
  - red `role="alert"` box reading "HTTP 401" (`:103-110`);
  - below it a **misleading empty state**: "Outside the signal window. The panel auto-updates between 08:25 and 08:50 CT on trading days." (`:112-117`);
  - header chip "Idle" or "Loading…" (`describeStatus`, `:149`), which inside the window never resolves.
- Extra problem: `displayData = state.data ?? cachedData` (`useOpeningFlowSignal.ts:379`) and the live cache slot never expires
  (`:203-210`, `safeReadCache` has no date guard). A browser that was ever a guest/owner still paints the last UW-derived payload to a now-public
  visitor, next to the red 401. That is licensed data on screen (question (a)).

#### B. `PinSetupTile` -> `usePinSetupStatus` -> `/api/pin-setup-status`  (CONFIRMED)
- Guard: `api/pin-setup-status.ts:200` (after the 405 check at `:195`).
- Fires: **mount, always** (`src/hooks/usePinSetupStatus.ts:190-193`) and on every date pick. The poll
  (`usePolling(pollLive, ..., [date == null, marketOpen])`, `:200`) is already shut for public because App passes `liveMarketOpen`
  (false). So public gets one 401 per page load plus one per date pick, no polling.
- Gate today: none on access (the hook's own header says "this hook does not gate on ownership").
- What the visitor sees (`src/components/PinSetupTile/index.tsx`): card title "0DTE Pin Setup - live" (`:99-108`), "Loading…" (`:124-128`)
  replaced by a red `role="alert"` line "HTTP 401" (`:129-137`).

#### C. `AnalysisHistory` -> `/api/analyses?dates=true` (and `?date=` on a pick)  (CONFIRMED)
- Guard: `api/analyses.ts:56` (`guardOwnerOrGuestEndpoint`, GET only).
- Fires: **mount and on `refreshKey` change** (`src/components/ChartAnalysis/AnalysisHistory.tsx:44-75`). The `selectedDate` fetch
  (`:100-129`) cannot run for public because no dates load.
- Gate today: the owner check is AFTER the hooks (`:206-209`, "Placed after hooks to satisfy Rules of Hooks"), so the effect fires before the
  component returns `null`. Guests also fetch successfully and then get `null` (the check is `checkIsOwner()`, not owner-or-guest).
- What the visitor sees: **nothing** (`return null`, `:209`). A silent 401, plus a nav entry and a prefs-modal entry for "Analysis History"
  that leads to an empty anchor (`panel-registry.ts:146-150`, nav built from the registry at `App.tsx:818`).

#### D. `useHistoryData` -> `/api/history?date=<selectedDate>`  (CONFIRMED)
- Guard: `api/history.ts:498`.
- Fires: **mount** for any trading-day `selectedDate`, **including today** (the skips are only: empty date, future date, weekend,
  holiday: `src/hooks/useHistoryData.ts:347-366`), and again on every date change. No poll.
- Gate today: none on access.
- What the visitor sees:
  - today / live: nothing (the error is stored but the header only shows it in backtest mode);
  - **a public visitor who picks a past date** (a normal calculator use) gets a red "NO INTRADAY" badge whose tooltip reads "Not authenticated"
    (`src/components/AppHeader/index.tsx:216-224`, error set at `useHistoryData.ts:375-377`). That wording suggests missing data, not a login gap.

#### E. `useMarketData` -> `/api/quotes`, `/api/intraday`, `/api/yesterday`, `/api/movers`  (CONFIRMED; documented as intentional)
- Guards: `api/quotes.ts:109`, `api/intraday.ts:125`, `api/yesterday.ts:107`, `api/movers.ts:58`. All `guardOwnerOrGuestEndpoint`.
  (`/api/events` in the same batch is public, `api/events.ts:61`.)
- Fires: **mount** (`src/hooks/useMarketData.ts:309-312`, `fetchAllEndpoints` fans out to all five, `useMarketData.fetchers.ts:141-150`). The 60 s poll
  gate is `[isOwner, session !== 'closed']` where `isOwner` is state that starts as `checkIsOwner()` and flips true only on a successful fetch
  (`:262-290,342-346`), so public never polls.
- UI: none. The hook header (`useMarketData.ts:13-16`) and `processEndpointResults` (`fetchers.ts:211`) deliberately drop 401s.
- Severity: lowest of the five (no UI), but it is four 401s plus four BotID checks per page load and contradicts the "public never reaches
  owner-or-guest" rule. The header comment ("require an owner session cookie") is also stale: guests pass these guards.

#### What gates look like after the recommended fixes (summary of 7 below)
A and B go away by registry-gating `sec-premarket`. C by gating the effect on owner. D and E by a mode check in the hook. See section 7 for the order.

---

### 3. Checked and fine (public cannot reach an owner-or-guest endpoint)

| Component / hook | Endpoint | Why fine |
|---|---|---|
| `FlowRegimeBadge` / `useFlowRegime` | `/api/flow-regime` | null url for public (`useFlowRegime.ts:128-131`) and hidden by `showFlowRegime` (this branch) |
| `Regime0dte` / `useRegime0dte` | `/api/regime-0dte` | `inLiveWindow` closes for public (`useRegime0dte.ts:96-98`) and the panel is behind `isAuthenticated` |
| `useAlertPolling` | `/api/alerts` | `checkIsOwner()` gates the eager fetch and the poll |
| `useIntervalBAAlerts` | `/api/interval-ba-alerts` | `hasSession` gate |
| `useDarkPoolLevels`, `usePeriscopeExposure`, `useGexTarget`, `useVixTrajectory`, `useSchwabAuthStatus` | various | own gates, see 1.2 |
| `useChainData` | `/api/chain` | `enabled` false for public (`hasData` is false for public, after a downgrade too: the hook masks it) |
| All `GatedSection` panels (`App.tsx:1062-1294`) | UW / GEXBot | `hasMarketContext` = `isAuthenticated && hasMarketOrSnapshot`, and registry omits the entry |
| `OptionsAlertsView` | LotteryFinder / SilentBoom feeds | static prompt when `!hasMarketContext` |
| `useVixData`, `useVix1dData`, `useEventsForDate`, forward `/api/events` | public endpoints | guards read, no auth |

---

### 4. Question (a): clearing localStorage "last good" caches when access drops to public

**There is no such mechanism.** CONFIRMED by grep of all non-test `src/`.

- `AUTH_CLEARED_EVENT` (`src/utils/authInterceptor.ts:37`) is dispatched in exactly one place, `:117`, after `clearHintCookies()` (`:116`).
  That path needs a hint cookie, at least two 401s inside 5 s, and a whoami reply of `public`. Its only listener is `useAccessSession.ts:41`,
  which just re-reads the mode. Nothing removes storage.
- `clearHintCookies` has one non-test caller: `authInterceptor.ts:116`.
- Guest logout (`useAccessSession.ts:52-58`) POSTs `/api/auth/guest-logout` and calls `notifyAll()`. It clears no storage.
- A third drop path nobody handles: the hint cookie simply expires (guest cookie `Max-Age` is 30 days, `api/_lib/guest-auth.ts:30`) or is cleared by hand,
  so the next page load is public from the start and nothing purges what the previous session wrote.
- The only `removeItem` calls are date-based (`usePolledWindowSignal.ts:116` prior-day cache, `useStickyUnion.ts:232` prior-day feed slots) or
  unrelated (`vixStorage.ts`, prefs).
- In-memory hook state is not reset either (see 6.1).

localStorage keys that hold UW / GEXBot-derived data:

| Key | Written by | Notes |
|---|---|---|
| `openingFlowSignal.lastGood` and `openingFlowSignal.lastGood:YYYY-MM-DD` | `useOpeningFlowSignal.ts:141,148-150,194` | ws_option_trades-derived. **Live slot never expires** (survives CT rollover, `:203-210`). **Rendered to public today** (A) |
| `regime0dte:lastgood` | `useRegime0dte.ts:71` via `usePolledWindowSignal` | UW GEX / put IV. Today-only on read, prior-day evicted. Panel hidden for public, so at rest only |
| `feed-union:lottery:<date>:<filterSig>` and `feed-union:silent-boom:<date>:<filterSig>` | `useStickyUnion.ts:109`, slots built at `LotteryFinder/index.tsx:~723-795` and `SilentBoom/index.tsx:~777-831` | UW option-trade fires, up to 8000 entries per slot. Prior-day sweep runs only when a feed mounts. Alerts view is gated, so at rest only |

Not licensed data: `sc-panel-prefs-v1`, `lottery.*`, `silentBoom.*`, `*-ticker-expanded`, `sc-interval-ba-muted-v1`, `strike-calc:vix-data` (VIX table),
sessionStorage `intervalBA:guestDismissed` (alert ids only).

Suggested fix: one `clearLicensedClientCaches()` that removes the three key families (`openingFlowSignal.lastGood*`, `regime0dte:lastgood`, every key
starting `feed-union:`), called from a single App effect `useEffect(() => { if (!isAuthenticated) purge(); }, [isAuthenticated])`. That one call site covers
boot-as-public (expired or cleared cookie), the interceptor path, and guest logout, because all three change `accessMode` in App.

---

### 5. Question (b): `usePanelPrefs` freezes the mode at mount

`const initialMode = useRef(getAccessMode()).current` (`src/hooks/usePanelPrefs.ts:179`) is used in four places: the `isLoaded` initial value (`:195`), the
server-GET effect (`:220`, deps `[initialMode, cached]` at `:271`), the `persist` guard (`:288`, deps `:306`) and the
pagehide / visibilitychange flush effect (`:326`, deps `:342`). CONFIRMED by reading.

Public visitor enters a guest key (`AccessKeyModal.tsx:82-100` -> `onLoginSuccess` -> `refresh()` at `AccessKeyButton.tsx:87`, no reload):
1. `useAccessSession` flips `mode` to `guest` and App re-renders, but `initialMode` stays `'public'` for the life of the mount.
2. **The GET effect never runs**, so the guest's saved server layout (per guest key, `api/panel-prefs.ts`) is never applied. They keep the
   anonymous localStorage layout.
3. **`persist()` returns immediately**, so no toggle, reorder or group reorder is PUT to the server. They only reach localStorage.
   The pagehide / visibility flush listeners are never registered either.
4. Nothing tells the user. On the next reload as a guest the GET returns the old server state. `shouldApplyServerAxis` keeps local only when the server
   value is empty, so any non-empty server axis overwrites what they changed after login. Cross-device sync is also lost.

Reverse direction (guest/owner drops to public without reload): `initialMode` stays `guest`/`owner`, so PUTs keep firing after the cookie is gone; they 401
and `sendPut` swallows the result (`.catch(() => undefined)`, no `res.ok` check). Harmless but the user's edits are silently lost.

`isLoaded` has no consumer outside this hook (grepped), so that part is inert.

Smallest correct fix: drop the `useRef` and read the mode on each render, `const mode = getAccessMode();`, then use `mode` in the three guards and in the
two dependency arrays (`[mode, cached]` for the GET effect, `[mode, flushPending]` for the flush effect, `[mode, sendPut]` for `persist`).
App already re-renders on a mode change (it consumes `useAccessSession`), so no new subscription is needed. The GET effect already skips axes the user
touched since mount (`pendingBodyRef`), and its abort cleanup handles the re-run, so re-running it on public -> guest is safe. (Equivalent alternative:
`const { mode } = useAccessSession()`.)

---

### 6. Adjacent findings (outside the literal question; INFERRED unless noted)

#### 6.1 Login without reload leaves `market.hasData` false (INFERRED, high confidence)
`useMarketData` fetches once on mount (`:309-312`) and its poll gate is `isOwner` state, which is false for a guest and only flips on a successful fetch.
Nothing re-triggers `fetchAll` when the mode changes. A public visitor who enters a guest key therefore never loads quotes/intraday/yesterday, so
`hasMarketOrSnapshot` stays false and the market-context panels (dark pool, GEX, etc.) stay hidden and the alerts view keeps its "needs live market
context" prompt, until a reload. The same hook never resets `isOwner` to false on a downgrade, so after guest logout it keeps polling `/api/quotes` (and
`/api/intraday` in RTH) every 60 s into 401s. This is the same root cause as (b) and should be fixed together with E (make the mount fetch and the poll
gate depend on the live access mode).

#### 6.2 After a downgrade, `sec-charts` and `PreMarketInput` can render for a now-public visitor (INFERRED)
`market.data` is never cleared, so `hasMarketOrSnapshot` can stay true while `isAuthenticated` is false. The registry gates `sec-charts` on
`hasMarketOrSnapshot` alone (`panel-registry.ts:139`). `ChartAnalysis` fetches `/api/analyses?date=` (owner-or-guest, `ChartAnalysis/index.tsx:~100-130`)
on mount, silently.

#### 6.3 Guest reaches an owner-only endpoint (CONFIRMED, not a public case)
`PreMarketInput` (rendered when `market.hasData`) GETs `/api/pre-market` on mount (`PreMarketInput.tsx:57-85`). The guard is `guardOwnerEndpoint`
(`api/pre-market.ts:41`), so a guest draws a silent 401. Failure is swallowed (`if (!res.ok) return`).

#### 6.4 Stale comments
`useMarketData.ts:13-16` says the endpoints "require an owner session cookie"; they are owner-or-guest. `useVixData.ts` mentions "guest 401s" on `/api/vix-ohlc`,
which is public.

---

### 7. Recommended fixes, in order

1. **A + B (one change): gate `sec-premarket` in the registry.** Move the entry at `panel-registry.ts:49` into the `if (isAuthenticated)` block, as was
   done for `sec-regime-0dte`. Both cards in `PreMarketSignals` are owner-or-guest, so nothing public remains in it. This removes the fetch, the red
   tile, the nav and prefs entries, and the cached-UW render. Note `PinSetupTile` is `memo` (`PinSetupTile/index.tsx:62`), so a render-time
   `getAccessMode()` inside its hook would not re-run on a public -> guest flip; mounting on login via the registry is the reliable path.
   Defense in depth in the hooks (matching `useFlowRegime` / `useRegime0dte`): `usePinSetupStatus` and `useOpeningFlowSignal` skip the eager effect,
   the poll and the date-pick fetch when `getAccessMode() === 'public'` (`useOpeningFlowSignal.ts:353-375`, `usePinSetupStatus.ts:190-200`), and
   `useOpeningFlowSignal` returns no `displayData` for public.
2. **C: `AnalysisHistory`.** Hoist `checkIsOwner()` above the effects and return early inside both effects when false (`AnalysisHistory.tsx:44-75,100-129`).
   Move `sec-history` into an auth-gated block in the registry so public does not get a nav / prefs entry for an empty panel. The component is owner-only
   in practice (it returns null for guests too); gating on `isAuthenticated` is the minimal registry change, a strict owner gate would need `isOwner` in
   `PanelRegistryContext`.
3. **D: `useHistoryData`.** Treat public as "no history": early-return in the effect (`useHistoryData.ts:347`) with `history = null`, `error = null`, and
   include the render-time mode in the effect deps so a login without reload fetches. Public past-date picks then show BACKTEST only, no "NO INTRADAY".
4. **E + 6.1: `useMarketData`.** Skip the four owner-or-guest endpoints for public (keep `/api/events`), make the mount fetch and the poll gate depend on the
   live access mode (not a once-set `isOwner` state), and reset `isOwner` on downgrade. Larger change (touches `loading` / `needsAuth` semantics), so do it as its own
   step with its own tests.
5. **(a): licensed-cache purge** (section 4) in App.
6. **(b): `usePanelPrefs`** (section 5), one-line change plus dependency arrays.

Each new guard should be read at render (not frozen in a ref) so a login without reload picks it up, which is the exact bug (b) describes.
