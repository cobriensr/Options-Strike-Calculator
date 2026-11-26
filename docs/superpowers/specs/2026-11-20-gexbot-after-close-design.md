# GEXBot panels after the close — design

Status: design; adversarial review rounds 1 and 2 settled (the rule's
limit); owner questions answered 2026-11-21; awaiting owner approval

## Goal

After the cash close, and until the next session's first capture, every
GEXBot-fed panel shows the last session's final values with a "closed, as
of <time>" label, instead of an empty state that looks broken.

## Why

On 2026-11-20 the owner saw every GEXBot panel empty after the close and
read it as a broken feed. The feed was fine: 6,272 snapshot rows that day
(16 tickers × 392 one-minute runs, 08:30–15:01 CT), no NULL `zero_gamma`.
The panels were empty because every reader measures "fresh" against the
current clock (5, 15 or 60 minutes), so after ~15:06 CT each returns
nothing and the panel says "awaiting first GEXBot tick" or "No strike data
available". A tab left open through the close keeps its last data in
memory; any load after the close (a refresh, the PWA's automatic update
after a deploy, a new device) gets the empty state.

The owner does not want the panels to look broken after the close.

## Decisions already made (owner, 2026-11-20)

- After the close, show the **last session's final values**, labeled,
  not a "market closed" message over an empty panel.
- **During the session nothing changes.** The 5/15/60-minute windows stay
  anchored on the clock, so a stalled cron still shows as empty/stale.
- **The server picks the data** (approach 1 below), not the browser.
- **Cleanup keeps the newest session**, so Monday 06:15–08:30 CT is not
  empty after the Monday sweep deletes Friday.
- **Charm Clock** shows a one-line closed note (see Panels).
- **Analyze prompt (2026-11-21):** when the landscape is closed, the
  prompt still gets its structural bias, labeled as the last session's
  close with its capture time, not "real-time".
- **Ship in one push (2026-11-21):** each phase is reviewed and committed
  on the branch; the branch goes to main once, after the last phase.
- **Old-session label (2026-11-21):** add the date when the session is
  more than 6 days old.

## Scope: the panels

| Panel (App section) | Endpoint | Today's freshness rule |
|---|---|---|
| GEXBot Taker Flow (`sec-gexbot`): Dealer State strip, Gamma Compass, Charm Clock | `/api/gexbot?view=snapshots-latest` | 15 min before now |
| GEXBot Taker Flow: Dexoflow velocity tape (and the strip's velocity read) | `?view=velocity` | ET day of now, newest ≤ 15 min old |
| GEXBot Taker Flow: Convexity Matrix | `?view=convexity-trend` | 60 min before now |
| GEXBot Taker Flow: Strike Mover Ladder | `?view=maxchange-winners` | 5 min before now |
| GEX Landscape (`sec-gex-landscape`) | `/api/gex-landscape` (live, and `?at=` scrub) | 5 min (`STALENESS_CUTOFF_MS`); date = ET today |
| Periscope Exposure (`sec-periscope-exposure`) live view | `/api/periscope-map` | 5 min (`STALENESS_CUTOFF_MS`); date = ET today |

`sibling-confirm` is anchored on an alert's fire time and is out of scope.
The four `gexbot-queries.ts` view readers have one caller, `api/gexbot.ts`;
the detectors use other functions in that file, so nothing else changes.
`/api/periscope-exposure` (a picked Periscope slot) is always called with
an explicit `date` and `time`, and the slot picker sends the slot's own CT
date (checked in review), so it needs no change.

## Goals

- After the close, before the open, on weekends and on holidays, each
  panel above shows the newest stored session's final state.
- Each such panel says it is closed and shows the capture time of what it
  shows, e.g. `CLOSED · as of Fri 3:00 PM CT`.
- A session's data is never mixed with another session's: not across
  tickers, not across landscape or Periscope panels, not in velocity's
  session-cumulative `agg_dex`, not in landscape spot or Periscope slots.
- A tab left open through the close, or across ET midnight, ends up
  showing the final minute with the closed label, without a reload. So
  does a page loaded in the minutes right after the close, and a tab left
  open for several sessions.
- At the open, no panel shows the last session's values without the
  closed label, not even for one poll.

## Non-goals

- Changing any in-session window, cron or freshness rule. (Deliberate
  in-session effects are listed under Response contract and the scrub
  bullet: `asOf` becomes a capture time, and a scrub to a session's first
  minute reads `no_slot` instead of `no_spot`.)
- Non-GEXBot panels that may blank after hours the same way (UW-fed Zero
  Gamma, Greek Flow, Strike Battle Map, etc.). Not checked; separate work.
- GexTarget's Strike Board overlay (`usePeriscopeStrikes` →
  `/api/periscope-strikes`). It is GEXBot-derived since 2026-05-26 and its
  live read defaults to today's date, so it blanks after hours too. It sits
  inside a UW-fed panel, so it goes with the UW panels above.
- GEXBot-derived event lists: the Gamma-Node Composite Detector's "today's
  fires" and the Periscope lottery panel. They list today's events, so an
  empty list on a weekend is accurate, not broken.
- The `no_spot` empty state on SPX candle-gap days (GEX Landscape,
  Periscope map). It happens in the session too; separate work.
- Historical browsing beyond what the panels already offer.

## Anti-goals (would be a failure even if it "works")

- During the session, showing old data as if it were live, or labeling a
  stalled in-session panel "closed".
- Any label that shows the response time instead of a capture time
  (today `/api/periscope-map`, and `/api/gex-landscape`'s `no_slot` and
  `no_spot` paths, set `asOf` to `new Date()`).
- A closed-session response served from the edge cache after the next
  open, so the first live minutes show yesterday.

## Approaches considered

1. **Server falls back to the last session (picked).** When the market is
   closed, each endpoint anchors its windows on the newest stored row
   instead of now, and takes the session date from that row. Pre-open,
   weekends and holidays fall out with no holiday math: the newest row is
   always the last session. One shared rule, three endpoints, panel text.
2. **Browser asks for the last close.** Each hook works out the last
   session's close from the trading calendar and requests that time.
   Needs most of the same server work (`periscope-map` takes no time
   parameter; `gex-landscape` hardcodes today's date for spot and minutes)
   plus calendar logic in three hooks. Rejected: more moving parts, same
   result.
3. **Browser remembers the last good data** (localStorage). Rejected: blank
   on a new device or after a cache clear, and stores GEXBot data in the
   browser.

## Design

### The closed rule (server)

- **Live vs closed:** `isMarketOpen()` (`api/_lib/cron-helpers.ts`):
  09:30 ET through the close minute (16:00:59, or 13:00:59 on a half day),
  holiday- and half-day-aware. Live → today's behavior exactly. Closed
  starts at 16:01:00, before the vendor's 16:01:49 replay capture lands,
  so a load at 16:01:55 does not see the replay.
- **Anchors, per table, in two steps:**
  1. The table's newest row (`max(captured_at)`, on the existing
     `captured_at DESC` index). Its ET date is the **session date**.
  2. Each ticker's **anchor**: its newest row in the 15 minutes up to the
     table's newest row whose `source_timestamp` is not NULL and differs
     from that ticker's previous row. A ticker with no such row in those
     15 minutes is dropped, exactly as the in-session 15-minute rule would
     have dropped it at the end of the session. So a ticker that failed
     all Friday never shows Thursday's row under Friday's label.
  - Why per ticker: one table-wide instant would let a ticker that updates
    late (the `ES_SPX`/`NQ_NDX` futures views could) pull every other
    ticker's replay row into the window.
  - Why skip the replay: GEXBot freezes at the close and the 16:01:49 ET
    capture repeats the 16:00:49 row (same `source_timestamp`, same
    values); anchoring on it would null every velocity delta (the
    stale-source rule) and label the panels a minute late.
  - On 2026-11-20 all 16 tickers, futures views included, froze at 16:00
    ET, and each one's anchor is 21:00:49–21:00:50Z, so labels say
    3:00 PM CT.
- **Which table needs the replay check:** only `gexbot_snapshots`.
  `gexbot_api_capture` never stores the replay: migration #192's partial
  unique index on (ticker, endpoint, category, source_timestamp) plus
  `insertCaptureRows`' `ON CONFLICT DO NOTHING` drop it. There a ticker's
  anchor is its newest row with a non-NULL `source_timestamp` in the same
  15 minutes.
- Every closed-mode window ends at the ticker's anchor
  (`captured_at <= anchor`), not at now:
  - `snapshots-latest`: `anchor − 15 min` to the anchor.
  - `velocity`: `now_ts = anchor`, `day_start` = ET midnight of the
    session date; the 3-minute gap, stale-source and 15-minute rules
    stay as they are, measured from the anchor.
  - `convexity-trend`: `anchor − 60 min` to the anchor.
  - `maxchange-winners`: `anchor − 5 min` to the anchor (2026-11-20's final
    rows carried no INT32 sentinel; the existing sentinel drop stays).
- **`gex-landscape` live:** per panel, the SPX state row at or before the
  anchor **and on the session date**; a panel with no such row is
  `no_slot`, never a row from an older session. `availableMinutes` and
  `fetchSpxSpot` use the session date, not ET today.
- **`gex-landscape` `?at=` scrub (live or closed):** the session date is
  the ET date of `at`, and the same per-panel bound applies: each panel's
  row is the newest at or before `at` on that date. Why from `at`, not
  from the row found: scrub options are whole minutes and captures land
  ~49 s into the minute, so the first option of every session finds the
  previous session's last row. Today that ends in `no_spot`; taking the
  date from the row would render the previous session's strikes under
  today's first minute. With the bound it reads `no_slot` (an in-session
  change from one empty state to another).
- **`periscope-map`:** the same per-panel rule as landscape live, and
  **every** use of today's date moves to the session date: `expiry` in
  `fetchLatestGexbotSlot` and `fetchPriorGexbotSlot`, `fetchConeLevels`,
  `fetchConeBreaches` and `availableSlots`. Otherwise a Saturday view
  reads "· 2026-11-21" with no cone.
- An empty table when closed returns today's empty shapes (`[]`,
  `no_slot`).

### Response contract

- No new `closed` field. Every response's `asOf` is a capture time: the
  latest anchor among the rows it returns, or null when it returns
  nothing. `/api/gexbot` adds `asOf` next to `rows`. Landscape and map keep
  `marketOpen`. `GexLandscapeResponse.asOf` (and the map's) becomes
  `string | null`; the client handles null.
- `asOf` becomes a capture time on every path, in the session too. The
  Periscope live label (`SlotPicker`, which shows `asOf` while live) then
  shows the capture time, and disappears on an in-session `no_slot`.
  That is intended (anti-goal 2).
- **Cache, all three endpoints.** Today `/api/gexbot` sends
  `s-maxage=15, stale-while-revalidate=60` at every hour
  (`setCacheHeaders(res, 15)`), and landscape and map send 300 s + 60 s
  after hours. A closed-mode response's whole cache life, `s-maxage`
  **plus** `stale-while-revalidate`, must end:
  - before the next 09:30 ET (anti-goal 3), and
  - before close + 3 min on the day of a close, so the client's final
    fetch (below) is never answered from a closed response cached before
    the last capture landed. Simplest: no caching of closed responses
    until close + 3 min.
  The client rule below also refuses a stale closed response at the open,
  so the cache rule is the first line, not the only one.

### Panels (client)

- **These clock rules apply only to a panel's live route:** not to a
  picked Periscope slot (`selectedSlot`, served by
  `/api/periscope-exposure`) and not to a landscape `at` scrub. A picked
  or scrubbed view is a deliberate look at a past time; it is never
  dropped at the open and never labeled CLOSED.
- **When live-route data counts as live:** only when `marketOpen` is true
  **and** the data's `asOf` is at or after the current session's open
  (09:30 ET today). Otherwise:
  - `marketOpen` false → show it with the CLOSED label and its capture
    time.
  - `marketOpen` true but `asOf` older than the open → drop it and show
    "awaiting first GEXBot tick". This covers a tab carried over from the
    closed view, an edge-cached closed response, and a client clock a few
    seconds ahead of the server's.
  - Why the client decides: a tab open through the close holds a response
    from before the close, so a server-side flag would never reach it.
- **At the open:** when `marketOpen` turns true, each hook drops held data
  older than the open and fetches at once. Why: `usePolling` never fires
  on a gate flip; its first tick comes one interval later (30 s for
  `useGexbotData`), which today would show Friday's rows as live.
- **The final fetch:** each hook keeps one fetch armed for close + 3 min of
  the current trading day (16:03 ET, or 13:03 on a half day), an absolute
  time from the trading calendar, and re-arms it for each new trading day,
  so a tab left open for days still gets every session's final minute.
  It covers a tab open through the close and a page loaded just after it
  (the PWA applies a pending update right after the close).
  - If that fetch fails, the panel keeps the rows it holds with the closed
    label (not the error view, which every child renders first), and a
    transient failure (network, 408, 429, 5xx) is retried every 30 s up to
    5 times, like `SIBLING_MAX_RETRIES`. Why: polling is off after the
    close, so an error would otherwise stay up all evening.
- **GEXBot Taker Flow:** one label in the section header (`SectionBox`
  `headerRight`): `CLOSED · as of Fri 3:00 PM CT`. The Strike Mover
  Ladder's "No winners in last 5 min" says "in the session's last 5 min"
  when closed. Other sub-panels keep their empty text: with the cleanup
  bound below, "closed and nothing stored" only happens on an empty table.
- **Charm Clock (owner, 2026-11-20):** when closed, the body is one line,
  "Charm Clock: closed. By-close drift resumes at the open." Its "By
  close" figure is charm × hours left to the close, which is 0 after the
  close, and for 0DTE tickers the expiry is gone, so the rows would read
  "$0 / FLAT" and look broken.
- **GEX Landscape:**
  - `CLOSED` in place of the LIVE pill, with the capture time, and the
    strikes render. The pill lives in `src/components/ScrubControls.tsx`,
    which DarkPoolLevels and GexTarget also use; their pill must not
    change (an opt-in prop).
  - The header time reads the response's `asOf`. `asOf` is not one of the
    minute options in the scrub `<select>` (ScrubControls.tsx:107–118), so
    it is used for the label only, or truncated to the minute before it
    goes near the select.
  - The ET-midnight date rollover in an open tab (`useFollowedDate`,
    commit 39cc2dc54) must not blank the header or empty the scrub list:
    today it clears `liveTimestamps` (index.tsx:155) and nothing refills
    it. In closed mode, keep the list or refetch once on the roll.
  - **The structural bias sent to the analyze prompt** (`onBiasChange` →
    `gexLandscapeBias` → `api/_lib/analyze-context.ts`, whose header says
    "from live GEX panel" and "real-time"). Owner, 2026-11-21: when the
    panel is closed, still send it, marked as the last session's close.
    - The context carries a marker next to the bias: the capture time
      when the panel is closed, absent when live (an optional field in the
      analyze context's Zod schema).
    - With the marker, the prompt's heading and first sentence say the
      verdict is from the last session's close as of that time, not live;
      the rest of the block (taker sign, "context only") stays.
    - Without it, the block is exactly today's.
    - The block sits in the per-request context, outside the cached
      system prompt; the `analyze-prompt-reviewer` agent checks that phase.
    - A scrubbed landscape view sends what it sends today.
- **Periscope Exposure:** `Slot 3:00 PM CT · CLOSED` style header on the
  live route; the slot dropdown lists the closed session's slots.
  `PeriscopePanel` has no `marketOpen` prop today; it is threaded from
  `src/App.tsx` like its other props.
- **Label format:** weekday + time in CT, from the capture time, e.g.
  `Fri 3:00 PM CT`. When the session is more than 6 days old (capture
  stopped for over a week), add the date: `Fri Nov 20 3:00 PM CT` (owner,
  2026-11-21).
- At the open (08:30 CT), panels switch to the live rules at once. Until
  the day's first capture lands (~40–90 s), they show "awaiting first
  GEXBot tick", which is true at that moment. Holding the closed view until
  the first capture would mean labeling a panel closed in the session
  (anti-goal 1).

### Cleanup keeps the newest session

`api/cron/cleanup-gexbot.ts` (12:15 UTC Mon–Fri) deletes through
`LEAST(yesterday_et, first_unarchived − 1)` per table. On Tue–Fri the
archive gate already keeps the previous session, because `archive-gexbot`
archives it at 21:30 UTC that day, after the sweep (2026-11-20: 11-19 was
archived at 21:31 UTC, so that morning's sweep stopped at 11-18). Monday
is the exception: Friday was archived Saturday, so Monday's sweep deletes
it; the same happens after a holiday.

Add a third bound, per table: never delete that table's newest session
(`newest ET session date − 1`). In normal weeks this only changes Monday
and post-holiday sweeps, keeping about one extra day of rows (~6k
snapshot + ~88k capture rows) until Tuesday's sweep. Tests: Monday keeps
Friday; Tuesday removes it; a weekday with the previous session already
archived still keeps it; the archive gate still wins when it is lower.

## Tests: clock edges every phase covers where it applies

- 16:00:59 vs 16:01:00 ET (server live → closed); 13:00:59 vs 13:01:00 on
  a half day.
- A load at 16:01:55 ET (the replay is stored, and is skipped).
- 16:02:59 vs 16:03:00 ET (the client's final fetch), its failure and
  retries, and a tab mounted on an earlier day.
- 09:29:59 vs 09:30:00 ET on the client, with held closed data and with a
  closed response arriving after the open; a picked slot and a scrub at
  the same instants (left alone).
- A holiday; Monday pre-open after the sweep; the Monday after a DST
  change.
- One ticker whose newest row is newer than the others'; one ticker with
  no row in the session's last 15 minutes.
- A landscape/Periscope panel whose newest row is from an older session;
  a scrub to a session's first minute.
- Cache headers for a closed response just after the close, mid-evening
  and just before the open.

## Phases (at most 5 files each)

1. Charm Clock closed state. Goes first: it is right with or without the
   server change.
2. The closed-cache helper next to `setCacheHeaders`.
3. `/api/gexbot` closed rule for `snapshots-latest`, `convexity-trend`
   and `maxchange-winners`: the two-step anchor helper (session-bounded
   ticker scan, replay check), `asOf` in the body, the cache helper.
4. `/api/gexbot` velocity: per-ticker `now_ts`, session-date `day_start`.
5. `/api/gex-landscape`: closed rule and session date (live), the scrub
   date from `at` with the per-panel bound, capture-time `asOf` on every
   path, the cache helper.
6. `/api/periscope-map`: the same, with every date use moved.
7. `cleanup-gexbot` keeps the newest session.
8. Client clock helpers and `useGexbotData`: live-only-after-the-open,
   fetch at the open, the re-armed final fetch with its retry, keeping
   rows on a failed closed-time fetch.
9. Taker Flow labels: section header, Strike Mover Ladder text and its
   spot fallback.
10. `useGexLandscapeData`: the clock rules on the live route only, the
    ET-midnight scrub list.
11. Analyze context: the optional closed-bias marker in the context's Zod
    schema, and the closed-session heading in `analyze-context.ts`.
12. GEX Landscape panel: the CLOSED pill and the header time from `asOf`.
13. GEX Landscape bias marker: send the capture time with the bias when
    closed (`onBiasChange` → `App.tsx` → `useAnalysisContext`).
14. `usePeriscopeExposure`: the clock rules on the live route only; thread
    `marketOpen` to `PeriscopePanel`.
15. Periscope panel: the closed header and slot list.

Order: 1 → 15, one implementer at a time, each reviewed and committed on
the branch; the branch is pushed to main once, after Phase 15 (owner,
2026-11-21). Why: between the server and client phases an after-hours
load would show the last session with no label.

## Files

- Phase 1: `src/components/Gexbot/CharmClock.tsx` and its test.
- Phase 2: `api/_lib/auth-helpers.ts`, `api/__tests__/api-helpers.test.ts`.
- Phase 3: `api/_lib/gexbot-queries.ts`, `api/gexbot.ts`, a pglite test for
  the anchored SQL (with a replay final row and a dropped ticker),
  `api/__tests__/gexbot-endpoint.test.ts`, and
  `api/__tests__/gexbot-queries.test.ts` if its mocked queries change.
- Phase 4: `api/_lib/gexbot-queries.ts`,
  `api/__tests__/gexbot-velocity-pglite.test.ts`.
- Phase 5: `api/gex-landscape.ts`, its test, and
  `api/_lib/periscope-query.ts` if the slot query lives there.
- Phase 6: `api/periscope-map.ts`, its test, and
  `api/_lib/periscope-gexbot.ts` if the decoder needs the date.
- Phase 7: `api/cron/cleanup-gexbot.ts` and its test.
- Phase 8: `src/hooks/useGexbotData.ts`, its test, and the session-instant
  helpers (`src/data/marketHours.ts` or beside it) with their test.
- Phase 9: `src/components/Gexbot/index.tsx`,
  `src/components/Gexbot/StrikeMoverLadder.tsx`, their tests.
- Phase 10: `src/hooks/useGexLandscapeData.ts` and its test.
- Phase 11: `api/_lib/analyze-context.ts`, the analyze context schema in
  `api/_lib/validation/`, their tests.
- Phase 12: `src/components/GexLandscape/index.tsx`,
  `src/components/ScrubControls.tsx`, their tests.
- Phase 13: `src/components/GexLandscape/index.tsx`, `src/App.tsx`,
  `src/hooks/useAnalysisContext.ts`, tests.
- Phase 14: `src/hooks/usePeriscopeExposure.ts`, its test, `src/App.tsx`.
- Phase 15: `src/components/Periscope/PeriscopePanel.tsx`,
  `src/components/Periscope/SlotPicker.tsx`, their tests.

## Data dependencies

None new: no migration, env var, table or external API. Existing indexes
`gexbot_snapshots_captured_at_idx` and `gexbot_api_capture_captured_at_idx`
serve the anchor lookup.

## Constants

- Windows unchanged: 15 / 15 / 60 / 5 min; `STALENESS_CUTOFF_MS` 5 min.
- Server live/closed switch: `isMarketOpen()` (09:30 ET through the close
  minute).
- Anchor scan: the 15 minutes up to the table's newest row.
- Client "live" floor: the current session's open, 09:30 ET.
- Client final fetch: close + 3 min (16:03 ET; 13:03 on a half day);
  retry 5 × 30 s on a transient failure.
- Closed-response cache life ends before close + 3 min and before the next
  09:30 ET.
- Label adds the date when the session is more than 6 days old.

## Left to the builder

- Where the anchor helper lives inside `gexbot-queries.ts` and its shape
  (SQL subquery vs a separate probe).
- Whether the Taker Flow header label gets `asOf` from its own
  `snapshots-latest` read (deduped) or from the children.
- How the cache helper computes the closed TTL.
- Exact empty-state wording within the intent above.

## My calls (owner may override)

- Anchor = each ticker's newest non-replay row within the session's last
  15 minutes; label = its capture time (3:00 PM CT on 2026-11-20, not the
  3:01 replay).
- The client decides "closed" and "live" from its clock plus `asOf`; the
  server sends no `closed` flag. Picked and scrubbed views are exempt.
- The server switches at the close minute (`isMarketOpen()`); the client's
  last fetch is at close + 3 min, re-armed daily, retried on failure.
- A scrub's session date comes from `at`.
- GexTarget's Strike Board overlay stays with the UW-panel work; the
  GEXBot event lists are out of scope.
- When the Schwab SPX quote is missing after hours, the Strike Mover
  Ladder uses the SPX `spot` from the GEXBot snapshot instead of rendering
  nothing.

## Review rounds (CLAUDE.md, Plan First)

- **Round 1** settled: the open-time hole, the page loaded right after the
  close, `/api/gexbot`'s cache, the per-ticker anchor, Periscope's date
  uses, phase sizes and the missing `ScrubControls.tsx`, the capture
  table's replay, the in-session `asOf` effect, mixed-session panel rows,
  the clock-edge tests.
- **Round 2** settled: the scrub's session date, the session-bounded ticker
  scan, picked and scrubbed views exempt from the clock rules, the daily
  re-arm and retry of the final fetch, phase sizes (`api-helpers.test.ts`,
  `App.tsx`), the cache's SWR and pre-capture window, the landscape
  header's minute and midnight scrub list, `no_spot`'s `asOf`, the event
  lists' scope.

## Owner answers (2026-11-21)

1. **Label for an old session:** add the date when the session is more
   than 6 days old.
2. **Analyze prompt when the landscape is closed:** send the last
   session's bias, labeled as such (Phases 11 and 13).
3. **Push timing:** commit each phase, push once after Phase 15.
