# frontend-state audit — 2026-09-08

Theme: Rule R1 (client side) — unnecessary React state, effect cleanup leaks, ungated polling, unbounded ref/module caches.
Scope: `src/hooks/**`, `src/components/**`, `src/utils/**` (module-level mutable state only), `src/main.tsx`, `src/App.tsx`. Tests and `e2e/` ignored.
Worktree: clean checkout of `origin/main` (`3dd9dd60`). Read-only; no source modified.

## Method

**Grep → extract → read.** A paren-depth walker (scratchpad `extract_effects.py`) pulled every `useEffect` / `useLayoutEffect` body out of `src/` so each one was read as code, not as a grep line. Side-effect call sites were cross-referenced from separate greps for `setInterval`, `setTimeout`, `addEventListener`, `new (EventSource|WebSocket|ResizeObserver|IntersectionObserver|MutationObserver)`, `requestAnimationFrame`, `visibilitychange`, `fetch(`, `AbortSignal.timeout`, and `usePolling(`. Module-level state came from `^(export )?(let|var)` and `^(export )?const … = (new Map|new Set|[]|{})` across `src/`; ref-held collections from `useRef<…(Map|Set|Record|[])`. A second script (`unread_state.py`) checked every `const [x, setX] = useState` for a value never read or a setter never called.

Full-file reads (not just effect bodies): `usePolling`, `useStickyUnion`, `useNeverVanishFeed`, `useFetchedData`, `usePolledWindowSignal`, `useMarketData`, `useChainData`, `useLotteryFinder`, `useImageUpload`, `useIsMobile`, `useGexbotData` (dedupe map), `useAlertPolling`, `useIntervalBAAlerts`, `useTrackerAlerts`, `useHistoryData` (fetch + effect), `useVixData` (state + effects), `useOpeningFlowSignal` (window + poll), `useGreekHeatmap` (fetch + gates), `usePeriscopeExposure`, `useNopeIntraday`, `usePinSetupStatus`, `useFuturesData`, `useGammaSetups`, `useGexTarget` (bulk + scrub + state), `useScrubController`, `usePanelPrefs` (debounce + flush), `useChartAnalysis` (attempt timeout), `Toast`, `ScrollHint`, `LazySection`, `PanelRouter`, `alert-chime.ts`, `anomaly-sound.ts` (relevant ranges), `sw-update.ts`, `authInterceptor.ts` (head), `App.tsx` (effects, `isBacktestMode`, `vixOHLC` wiring, panel gating). Server-side facts that size a client finding were checked at source: `api/vix-ohlc.ts` (public, no auth), `api/history.ts` (owner-or-guest), `api/_lib/db.ts` per-attempt timeout, `vercel.json` `functions` block (no `maxDuration` for `periscope-map` / `pin-setup-status`).

**Counts**
- Files in scope: 476 non-test `.ts/.tsx` under `src/`; 83 hooks; ~95 component files carrying effects.
- Effects read: **182** (102 in `src/hooks`, 78 in `src/components`, 2 in `App.tsx`).
- Side-effecting effects (timer / listener / observer / chart subscription / rAF / fetch or fetch-callback): **≈95**.
  - Timers in effects: 10 (`usePolling`, `useMarketData`×2, `LotteryFinder`×2, `SilentBoom`×2, `CohortCountdown`, `useDebounced`, `AddContractForm`) — 10/10 return `clearInterval`/`clearTimeout`.
  - Listener registrations in effects: 18 across 15 effects — 18/18 removed in cleanup.
  - Observers: 6 (`SectionNav`, `PriceChart`, `ScrollHint`, `ContractTapeChart`, `TickerNetFlowChart`×2) — 6/6 `disconnect()`.
  - lightweight-charts subscriptions: 3 effects — 3/3 unsubscribed; 2 rAF effects — both cancelled.
  - Missing teardown on any of the above: **0**. Cleanup that exists but is a no-op: **1** (FS-03). Early `return` that skips a registered cleanup: **0** (every guard-return precedes resource acquisition).
- Polling: 35 `usePolling` call sites. 11 are pure wall-clock ticks (no I/O). **30 network pollers: 27 gate on `marketOpen`** (directly, via `useFetchedData`, or via the caller's `enabled` — verified for `useGreekHeatmap` at `src/components/GreekHeatmap/index.tsx:138`), 2 gate on an explicit pre-market time window (`useOpeningFlowSignal`, `usePolledWindowSignal`), 1 (`useMarketData`) gates on `session !== 'closed'` by design (extended hours). **Ungated network pollers: 0.**
- Module-level mutable state in `src/`: 8 sites; all bounded or subscriber sets with symmetric add/delete. Ref-held Map/Set/array: 17 sites; all bounded, reset on date/gate change, or pruned.
- `useState` declarations: 575. Never-read values: 0. Never-set values: 0.
- Candidates examined in depth: 31. Verified findings: **4 P2, 8 P3** (P3 capped at the most valuable). P1: 0.

## Findings

### FS-01: `App.tsx` mirrors history-derived VIX OHLC into `vixOHLC` state via an effect; pins the *previous* date's OHLC after a date change  [P2] [confidence: high] [effort: S]
- Where: `src/App.tsx:358-375`; writer it collides with `src/hooks/useVixData.ts:85-150` (`setVixOHLC(null)` at :110); `history` retention `src/hooks/useHistoryData.ts:200-248`; render `src/components/AdvancedSection.tsx:213-218`.
- What: `vixOHLCFromHistory` is a `useMemo` over `historyData.history?.vix.candles` (pure derivation — good), but it is then pushed into `useVixData`'s `vixOHLC` state by `useEffect(() => { if (vixOHLC || !vixOHLCFromHistory) return; setVixOHLC(vixOHLCFromHistory); })`. `useHistoryData` does not null `history` when `selectedDate` changes (it only sets it in the `.then`), so during the in-flight window `vixOHLCFromHistory` still describes the *old* date exactly when `useVixData` has just set `vixOHLC = null` for the *new* date.
- Failure scenario: backtest date D1 → D2, both past the static VIX CSV cutoff. Render 1: `useVixData` sets `vixOHLC=null` and starts `/api/vix-ohlc?date=D2`; `useHistoryData` starts `/api/history?date=D2`, `history` still = H(D1). Render 2: the App effect sees `vixOHLC == null` and `vixOHLCFromHistory == OHLC(D1)` → `setVixOHLC(OHLC(D1))`. If `/api/vix-ohlc` for D2 returns `count: 0` / non-OK (public endpoint, no rows for that date — cron gap, holiday-adjacent), nothing overwrites it. When H(D2) lands, `vixOHLCFromHistory` becomes OHLC(D2) but the effect early-returns because `vixOHLC` is non-null → **AdvancedSection renders D1's VIX open/high/low/close under D2's date** (and it is what `vix.vixOHLC` feeds into the analysis context at `App.tsx:1424`). The "No VIX data found" message at `:213` is suppressed because `vixOHLC` is truthy.
- Fix: delete the effect at `App.tsx:372-375`; compute `const effectiveVixOHLC = vixOHLC ?? vixOHLCFromHistory` and pass that at `App.tsx:863` and `:1424`. Optionally also `setHistory(null)` at the top of the `useHistoryData` effect so stale-while-revalidate can't leak across dates for other consumers.

### FS-02: `useHistoryData` strands `loading = true` on every early-return branch after an in-flight fetch is aborted  [P2] [confidence: high] [effort: S]
- Where: `src/hooks/useHistoryData.ts:200-248` (early returns at :204, :214, :223; `setLoading(true)` at :227; abort at :247). Consumers: `src/components/AppHeader/index.tsx:130,133`.
- What: three separate `useState`s (`history`, `loading`, `error`) that must move together. The fetch path sets `loading=true` and only clears it inside the `.then`, which is skipped when the controller is aborted (`:231`). The three guard branches (`!selectedDate`, future date, weekend/holiday) reset `history` and `error` but never `loading`.
- Failure scenario: `isBacktestMode` is true for any past date (`App.tsx:508-513`). User picks past date A (Schwab history fetch in flight ~1-2 s), then picks a past Saturday / market holiday B before A resolves. Cleanup aborts A; the run for B hits `:220-224` → `history=null`, `error=null`, `loading` stays `true`. `AppHeader:130` shows the history-loading indicator indefinitely and `:133` hides any error until the user picks a date that completes a fetch. Same drift via the `!selectedDate` and future-date branches (indicator hidden by `isBacktestMode`, but `loading` is still wrong for anyone else reading it).
- Fix: add `setLoading(false)` before each early `return` (:204, :214, :223) — or collapse the trio into one `{ status: 'idle'|'loading'|'loaded'|'error', … }` object so the branches can't drift.

### FS-03: `useImageUpload` unmount cleanup closes over the initial `images` (`[]`) — revokes nothing; blob URLs leak on every unmount  [P2] [confidence: high] [effort: S]
- Where: `src/hooks/useImageUpload.ts:29-34` (state at :21; object URLs created at :40, :87). Consumer `src/components/ChartAnalysis/index.tsx:66`. Unmount path: `ChartAnalysis` is a `panelMap` entry (`src/App.tsx:1218-1233`) and `PanelRouter` skips hidden panels entirely (`src/components/PanelRouter.tsx:37` `continue`) — hiding the panel unmounts it; the `isAlerts` view switch (`App.tsx:1609`) is a second path.
- What: `useEffect(() => () => { for (const img of images) URL.revokeObjectURL(img.preview) }, [])` with an `eslint-disable exhaustive-deps` comment. With `[]` deps the closure captured on mount holds `images === []`, so the loop body never executes for images added later. `removeImage`/`clearAllImages`/`handleReplaceFile` revoke correctly, but nothing revokes URLs still in state at unmount.
- Failure scenario: trader pastes 2-3 chart screenshots (1-5 MB each) into Chart Analysis, then hides the panel via Panel Prefs, or switches to the alerts view, or React remounts the lazy chunk after a stale-chunk reload prompt. Each such unmount orphans the pasted blobs until full page unload; across a session with several hide/show cycles that is tens of MB of retained image memory with no path to release.
- Fix: mirror state into a ref (`const imagesRef = useRef(images); imagesRef.current = images;`) and revoke `imagesRef.current` in the mount-only cleanup; drop the eslint-disable.

### FS-04: `usePeriscopeExposure` and `usePinSetupStatus` poll with no client timeout and no supersede-abort; a hung request can overwrite a fresher one  [P2] [confidence: medium] [effort: S]
- Where: `src/hooks/usePeriscopeExposure.ts:113-149` (`fetch(url, { method: 'GET' })`, poll at :160-166 every 60 s); `src/hooks/usePinSetupStatus.ts:84-102` (`fetch(url, { credentials: 'include' })`, poll at :125 every 60 s). Server side: `api/periscope-map.ts` and `api/pin-setup-status.ts` use neither `withDbReader` nor a `maxDuration` entry in `vercel.json:341-353`, so a hung Neon call is bounded only by the function budget (the `api/_lib/db.ts:191-197` comment cites 300 s).
- What: both hooks guard `mountedRef` (unmount is safe) but have no `AbortController` per call and no timeout. `usePolling` fires `fnRef.current()` on every tick regardless of an in-flight request, so two responses can be outstanding and land out of order.
- Failure scenario: 10:00:00 tick A stalls on a Neon HTTP blip (documented in this repo as recurring). 10:01:00 tick B returns in <1 s → `setView(B)` / `setData(B)` with fresh MM gamma levels / pin state. 10:01:30 A resolves → `setView(A)`: the Periscope panel's `asOf` and per-strike exposure regress 90 s, the Pin-Setup tile's `state`/`bias` regress, until the 10:02 tick. Exactly the window in which a trader is acting on the levels.
- Fix: per-hook `abortRef` supersede (`abortRef.current?.abort(); const ctrl = new AbortController(); abortRef.current = ctrl;`) plus `signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(8_000)])`, mirroring `src/hooks/useGreekFlow.ts:144` / `useDealerRegime.ts:59`; add the unmount `abortRef.current?.abort()` effect.

### FS-05: `useNopeIntraday` fetch has no client timeout / supersede  [P3] [confidence: high] [effort: S]
- Where: `src/hooks/useNopeIntraday.ts:72-89`, poll `:100-106` (60 s).
- What: same shape as FS-04, but `api/nope-intraday.ts:49` is wrapped in `withDbReader`, whose per-attempt timeout bounds the server, so the reorder window in practice stays under the 60 s cadence. Hygiene: make it consistent with the abort+timeout pattern so a future server change can't reopen FS-04 here.
- Failure scenario: none realistic today (server-bounded).
- Fix: same as FS-04.

### FS-06: Never-vanish localStorage slots are only swept on mount and only across *dates*; same-day filter-signature siblings accumulate  [P3] [confidence: high] [effort: S]
- Where: `src/hooks/useStickyUnion.ts:198-236` (`sweepStaleKeys`), mount-only at `:345-352`; slot keys `src/components/LotteryFinder/index.tsx:705-706`, `src/components/SilentBoom/index.tsx:779`.
- What: every distinct server-filter combination gets its own `feed-union:<feed>:<date>:<sig>` slot, each capped at 8 000 entries and re-serialized on every dirty ingest. Same-day siblings are never deleted (by design, so toggling a filter back restores its union); the prior-day sweep runs once per mount, so a tab left open across midnight keeps yesterday's slots until the next reload. `persistUnion` swallows `QuotaExceededError` (`:159-166`), so exhaustion degrades silently to memory-only — the union survives in RAM but not across a refresh, which is the case never-vanish exists to protect.
- Failure scenario: latent — needs many distinct filter combinations on a heavy day (or several days without reload) to approach the ~5 MB origin quota. No growth in RAM (old Maps are dropped on `storageKey` change).
- Fix: on `storageKey` change, also sweep same-feed slots for *other* dates (cheap, already parsed), and Sentry-breadcrumb the quota catch so silent degradation becomes visible.

### FS-07: Filter-change `setPage(0)` effects fire one request with the stale page offset before resetting  [P3] [confidence: high] [effort: S]
- Where: `src/components/LotteryFinder/index.tsx:568-591`, `src/components/SilentBoom/index.tsx:643-666`; URL built from `page` in `src/hooks/useLotteryFinder.ts:126-149`.
- What: the reset lives in an effect, so the render that carries the new filter and the old `page` reaches `useFetchedData` first (URL change → fetch), then the effect sets `page=0` (second URL change → the primitive aborts the first). Only reachable from page > 0 of the disengaged (minute-scrub/paged) view, since the pager is suppressed when engaged.
- Failure scenario: one wasted server-side query per filter change from a paged view; client aborts it so no wrong data shows (the `offset` echo guard in `useLotteryFinder.ts:225,250` also prevents mis-caching).
- Fix: reset `page` inside the filter setters (an updater helper), or key the pager state on the filter signature — no effect.

### FS-08: `useGexTarget` keeps one snapshot as five parallel `useState`s written together at four sites  [P3] [confidence: high] [effort: M]
- Where: `src/hooks/useGexTarget.ts:257-261` (`oi`, `vol`, `dir`, `spot`, `timestamp`); writers `:476-480`, `:556-564`, `:572-576`, and inside `fetchData` (`:321-395`).
- What: Rule (c) — fields that only ever change together as separate state. React batches the writes, so no observed tearing today; the risk is the next writer that forgets one field (e.g. `timestamp`), which is exactly the class of bug the `:552-555` comment describes having already been fixed once.
- Failure scenario: none live; maintenance hazard.
- Fix: `const [snap, setSnap] = useState<{oi,vol,dir,spot,timestamp} | null>(null)` and one setter per site.

### FS-09: `useScrubController` nulls an invalid `scrubTimestamp` via effect instead of deriving it  [P3] [confidence: high] [effort: S]
- Where: `src/hooks/useScrubController.ts:65-76`.
- What: an extra render with `isScrubbed === true` for a timestamp no longer in `timestamps` before the effect clears it; consumers (`useGexTarget.ts:550-581`) read `scrubTimestamp` in their own effects during that frame.
- Failure scenario: one frame of a stale `isScrubbed`; `useGexTarget` then does a cache miss `fetchData(scrubTimestamp)` for a timestamp the server may not have (`:578-579`) — wasted request, not wrong data.
- Fix: `const scrubTimestamp = raw != null && timestamps.includes(raw) ? raw : null` derived from the raw state in render; keep the setter for transitions.

### FS-10: `AnalysisHistory` default-selection effects (`selectedTime`, `selectedMode`) are derivable  [P3] [confidence: high] [effort: S]
- Where: `src/components/ChartAnalysis/AnalysisHistory.tsx:184-202`.
- What: `useState` + `useEffect` that fills a default when the user hasn't chosen — the "adjusting state on prop change" pattern; costs an extra render per list change and can flash the empty selection.
- Failure scenario: cosmetic one-frame flash; no wrong data.
- Fix: `const effectiveTime = selectedTime || availableTimes[0] ?? ''` (same for mode) at the read site; keep `selectedTime` as the user's explicit pick only.

### FS-11: Untracked one-shot `setTimeout`s in `MLInsights` and `Tracker`  [P3] [confidence: high] [effort: S]
- Where: `src/components/MLInsights/index.tsx:107` (`setTimeout(() => setAnalyzeState('idle'), 3000)`), `src/components/Tracker/index.tsx:79` (DOM class removal after 2 s).
- What: neither is cleared on unmount. React 19 silently ignores the post-unmount `setState`; the Tracker timer mutates a detached element. Both are harmless today.
- Failure scenario: none; hygiene only.
- Fix: hold the id in a ref and clear it in a mount-only cleanup (or drop the highlight class via CSS animation).

### FS-12: `useOpeningFlowSignal` runs an always-on 30 s tick in live mode and re-implements the window-watch that `usePolledWindowSignal` already provides  [P3] [confidence: high] [effort: M]
- Where: `src/hooks/useOpeningFlowSignal.ts:288-293` (gate `[effectiveDate == null]`); reference implementation `src/hooks/usePolledWindowSignal.ts:229-246`.
- What: the tick is cheap (a `Date` check + no-op `setState`) and the fetch is correctly confined to the 08:25-08:50 CT window (`:183-189`), so this is not an ungated poller. It is a second copy of the watcher+gated-poll shape with a coarser (30 s vs 60 s) always-on cadence.
- Failure scenario: none; consolidation.
- Fix: port to `usePolledWindowSignal({ inWindow: inPollingWindow, … })`.

## Already good — protect these

- `src/hooks/usePolling.ts:63-67` — the single interval primitive; guard-return precedes `setInterval`, so nothing leaks on a closed gate.
- `src/hooks/useStickyUnion.ts:105, 252-274, 407-474, 478-505` — hard cap (8 000), least-recently-seen eviction that never drops a server-reported key, debounced persist flushed on unmount + `pagehide` + `visibilitychange`; `unionRef` is replaced (not grown) on `storageKey` change. Retention is the feature — do not "fix".
- `src/hooks/useNeverVanishFeed.ts` — pure derivation over the union; no effects, no state.
- `src/hooks/useMarketData.ts:389-455, 463-498` — polling gate `[isOwner, session !== 'closed']` is intentionally broader than `marketOpen` (pre-market prep workflow); both wall-clock ticks are cleaned up; `setSession` bails on equality.
- `src/hooks/useFetchedData.ts:136-192` — supersede-abort per call, unmount abort, `requestKey/responseKey` cross-day gate.
- `src/hooks/useGexTarget.ts:321-395, 402-491, 493-501` — sequence-number + abort supersede, `mountedRef`, bulk cache replaced per date (bounded to one day's snapshots).
- `src/hooks/useLotteryFinder.ts:217-235` — FIFO page cache capped at 10.
- `src/hooks/useGexbotData.ts:148-160` — module-level in-flight dedupe map is released in `finally` with a race-safe identity check.
- `src/hooks/useTopStrikesTracker.ts:118-122` and `src/components/GexLandscape/index.tsx:341-345, 372-375` — ref caches pruned to the live set / time window and reset on date change.
- `src/utils/alert-chime.ts` + `src/hooks/useAlertPolling.ts:229-237` + `src/hooks/useIntervalBAAlerts.ts:198-206, 277-285` — module-scoped repeating chimes are stopped on gate flip, mute, ack, and unmount; the seen-set is cleared so a still-live alert re-arms on reopen.
- `src/hooks/useAccessSession.ts:20, 35-46`, `src/lib/sw-update.ts:18, 79-84` — module subscriber sets with symmetric add/delete; `src/hooks/useIsMobile.ts` via `useSyncExternalStore`.
- All 11 effects in `src/components/charts/TickerNetFlowChart.tsx` (325-472, 620-643, 656-688, 691-701) and `src/components/GexTarget/PriceChart.tsx:247-328` — chart instance, crosshair/time-scale subscriptions, rAF, and ResizeObserver all torn down; refs nulled.
- `src/hooks/usePanelPrefs.ts:286-342` — debounced PUT timer cleared and flushed on unmount/pagehide/hidden.
- `src/components/Toast.tsx:112-184` — timer map is app-root scoped and each entry is deleted on fire/dismiss.
- Editable drafts seeded from a prop and guarded by an "edited" ref or pristine check — `src/components/VIXTermStructure/index.tsx:49-54`, `VolatilityCluster/index.tsx:43-49`, `OpeningRangeCheck/index.tsx:50-55`, `Tracker/PositionSizeEntryEditor.tsx:64-81`, and `src/hooks/useAutoFill.ts:95-247`. This is the app's auto-fill contract (live quotes overwrite until the user types), not prop mirroring.
- Window-gated pollers `src/hooks/usePolledWindowSignal.ts:229-246` and `src/hooks/useOpeningFlowSignal.ts:183-189, 288-293` — gating on `marketOpen` would break them (the window is pre-RTH).
- Wall-clock ticks with no I/O — `useNowMinute.ts:20`, `useWallClockFreshness.ts:85`, `LotteryFinder/index.tsx:800-824`, `SilentBoom/index.tsx:839-865`, `ui/CohortCountdown.tsx:61-65`, `useChartAnalysis.ts:142` — all cleaned up, all ≥1 s.
- `src/components/GexLandscape/index.tsx:158-161` — `liveTimestamps` deliberately freezes the timestamp list while scrubbing so nav indices don't shift; a mirror by intent.
- `src/hooks/useHistoryData.ts:226-247`, `src/hooks/useVixData.ts:113-150`, `PreMarketInput.tsx:54-91`, `PeriscopeChat/*.tsx`, `AnalysisHistory.tsx:43-74` — `AbortController` in effect with `signal.aborted` checks before every `setState`.

## Rule tweaks

1. **"Polling hooks must gate on `marketOpen`"** → "Network polling must gate on `marketOpen` *or* an explicit session/time-window predicate (`session !== 'closed'`, `inPollingWindow`, `isWindowOpen`). Pure wall-clock ticks (a `setInterval` whose body only reads `Date.now()` / bumps a counter and performs no I/O) are exempt, provided they are ≥1 s and return `clearInterval`." As written, the rule flags `useMarketData`, both window-gated signals, and six clock tickers that are all correct.
2. **"Don't store prop-mirrored values in `useState`"** → add: "An editable draft *seeded* from a prop is fine when a user-edited ref / pristine check decides whether later prop changes overwrite it (the auto-fill pattern). The anti-pattern is unconditional `useEffect(() => setX(prop), [prop])` with no user-edit path, or a derived value pushed into state via effect (FS-01)."
3. **"Async effects must guard `setState` after unmount"** → accept "hook is mounted at the App root for the page's lifetime" (`useMarketData`, `useAlertPolling`, `useVixData`, `ToastProvider`) as satisfying it; require the guard for anything rendered through `PanelRouter`, since hidden panels unmount (`PanelRouter.tsx:37`). Also add the ordering half of the rule: "a poller that can have two requests outstanding must supersede-abort or time out the older one" (FS-04) — the unmount guard alone does not prevent stale-overwrites.
4. **"Refs used as caches must not grow without bound"** → define bounded as "capped, pruned to the live set, or reset on date / gate change"; `allSnapshotsRef`, `firstSeenRef`, `priceBufferRef`, `seenIdsRef` all qualify and should not be reported.
5. **Reset-on-prop-change effects** (`setX(null)` on `[selectedDate]`, of which there are ~8) are tolerated hygiene; flag only when the stale intermediate render triggers I/O (FS-07) or when the reset is the *only* thing keeping two states coherent (FS-02).
