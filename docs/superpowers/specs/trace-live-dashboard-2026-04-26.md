# TRACE Live Dashboard — Plan

**Date**: 2026-04-26
**Status**: Approved (decisions converged 2026-04-26)
**Owner**: charlesobrien

## Goal

Build a live SpotGamma TRACE analysis dashboard that captures gamma + charm + delta heatmaps every 5 minutes during market hours, runs them through `/api/trace-live-analyze` (Sonnet 4.6 + adaptive thinking), persists every reading with images + analysis + embedding, and surfaces the result in a tabbed React component with live polling and historical browsing.

## Why this exists

- The API + DB layer is already shipped (commit `722a444`) but has no caller.
- The existing `/api/analyze` flow takes 5+ min and is for end-of-day setup analysis. This is a separate, fast (~30–90s) tick-cadence read for in-session decision support.
- The trading framework was calibrated against same-instant captures of all 3 charts; the daemon must enforce that constraint.

## Phases

Each phase is independently shippable through the Get It Right loop (verify → reviewer subagent → commit + push direct to main). Phases 1–2 are usable with `scripts/smoke-trace-live.ts` as the only data source; the daemon (Phase 3) turns on real-time data; Phase 4 fills history.

### Phase 1 — Read endpoints + image storage _(~5 files)_

Adds the read-side of the API and persists chart images to Vercel Blob.

- `api/trace-live-list.ts` — `GET ?date=YYYY-MM-DD` returns `[{ id, capturedAt, spot, regime, confidence, overrideApplied, headline }]` for a calendar date in ET. Cookie-gated. Used by the timestamp dropdown.
- `api/trace-live-get.ts` — `GET ?id=N` returns the full `TraceAnalysis` row including `image_urls`. Cookie-gated.
- `api/_lib/db-migrations.ts` — migration #89: `ALTER TABLE trace_live_analyses ADD COLUMN image_urls jsonb` (shape: `{ gamma: string, charm: string, delta: string }`).
- `api/trace-live-analyze.ts` — extend handler: after Anthropic call succeeds, upload the 3 PNGs to Vercel Blob (`trace-live/{date}/{HHmm}/{chart}.png`), include URLs in the row insert. Failure to upload Blob = log + Sentry, but do NOT fail the request (analysis is the load-bearing artifact).
- `api/__tests__/{trace-live-list,trace-live-get,trace-live-blob-upload}.test.ts` — coverage for the new endpoints + the upload path including the "blob upload fails, analysis still saves" branch.

**Verify**: `npm run review` green; `curl -H "Cookie: sc-owner=…" /api/trace-live-list?date=2026-04-23` returns the smoke-test row from yesterday's run.

### Phase 2 — Frontend dashboard _(~10 files)_

`<TRACELiveDashboard />` collapsible section using the existing `SectionBox`, `Collapsible`, `SummaryCard`, `BulletList` primitives — no new design vocabulary.

```
src/components/TRACELive/
  index.tsx                  ← top-level collapsible (mirrors ChartAnalysis/index.tsx)
  TRACELiveControls.tsx      ← live/historical toggle + DatePicker + TimePicker
  TRACELiveHeader.tsx        ← always-visible headline bar (synthesis.headline + chips)
  TRACELiveTabs.tsx          ← gamma/charm/delta tab nav
  TRACELiveTabPanel.tsx      ← image + per-chart Collapsible sections
  TRACELiveSynthesisPanel.tsx ← below-tabs: trade, agreement, warnings, reasoning
  TRACELiveCountdown.tsx     ← timer + "next capture in 4:23"
  hooks/
    useTraceLiveData.ts      ← 60s polling in live mode, single fetch in historical
    useTraceLiveCountdown.ts ← timer derived from latest capturedAt + 5 min
    useTraceLiveChime.ts     ← 0.5s chime on every new capturedAt (debounced 1s)
  types.ts                   ← re-exports from api/_lib/trace-live-types.ts
  __tests__/                 ← per-component tests
```

**Styling rules** (from existing `ChartAnalysis`):

- All section titles: `font-sans text-[10px] font-bold tracking-wider uppercase` — color from theme constants (`theme.accent`, `theme.green`, `theme.red`, `theme.caution`).
- Status pills: `rounded-full px-2 py-0.5 font-mono text-[10px]` with `tint(color, '18')` background.
- Badges/numbers: `font-mono`. Headlines: `font-sans`. Body copy: theme.textSecondary.
- Collapsible cards use `tint(color, '06')` background per existing `Collapsible.tsx`.

**Verify**: visit local dev, expand TRACE Live section, see yesterday's smoke-test data render correctly across all 3 tabs. Toggle to Historical mode, pick the date, confirm the dropdown is populated.

### Phase 3 — Capture daemon _(new top-level `daemon/` package)_

Long-running TypeScript service deployed to **Railway** (eventually) — local-first for the first week of debugging.

- Connects to **browserless.io** via Playwright `chromium.connect()` using the API token from `.vscode/mcp.json` (eventually moved to env).
- Three pre-warmed pages, each pinned to one chart type, in a persisted browser context (TRACE login cookies survive 7 days on the Prototyping tier).
- Market-hours scheduler: fires every 5 minutes from **8:35 AM CT to 2:55 PM CT** weekdays only, skipping market holidays via `src/data/market-hours.ts`.
- Per-cycle flow: `Promise.all([gammaPage.screenshot(), charmPage.screenshot(), deltaPage.screenshot()])` → fetch GEX landscape from `/api/gex-strike-0dte` (or query Neon directly via `gex_strike_0dte`) → POST to `/api/trace-live-analyze`.
- **Skip-if-running guard**: if previous cycle's API call hasn't returned, skip this cycle. Log skip count.
- **Heartbeat**: write a row every cycle (start + end) to a new `daemon_heartbeat` table OR Sentry breadcrumb. If 2 cycles missed during market hours → Sentry alert.
- **Hard 13-min session timeout** (2-min margin under browserless 15-min cap); reconnect if hit.

```
daemon/
  package.json              ← own deps (playwright, undici, etc.)
  src/
    index.ts                ← entry: schedule + main loop
    scheduler.ts            ← market-hours gate + cron-like dispatch
    capture.ts              ← parallel screenshot logic
    gex.ts                  ← fetch GEX landscape from Neon
    api-client.ts           ← POST to /api/trace-live-analyze with retry
    config.ts               ← env, browserless token, endpoint
    logger.ts               ← pino → Sentry
  Dockerfile                ← for Railway
  README.md                 ← run-locally + deploy-to-Railway runbooks
```

**Verify**: run `npm --prefix daemon start` during market hours (or simulate by overriding the time-gate), confirm 3 captures land in `trace_live_analyses` per 5-min cycle with non-null `image_urls`.

### Phase 4 — Backfill mode _(extends daemon)_

Adds `--date YYYY-MM-DD --backfill` flag to the daemon entry point.

- Iterates ET timestamps from 08:35 → 14:55 in 5-min steps (78 timestamps × 3 charts = 234 captures per day).
- For each timestamp: scrub TRACE's MUI Slider in all 3 pre-warmed pages to the target time, parallel screenshot, fetch GEX from Neon at that historical timestamp, POST to `/api/trace-live-analyze` with `capturedAt` set explicitly.
- Rate-limited to 6/min to match the endpoint rate-limit guard. Total runtime: ~40 min/day.
- Cost estimate: ~$4 per backfill day. **Initial backfill scope: last 10 trading days** (~$40).

**Verify**: run `npm --prefix daemon start -- --date 2026-04-22 --backfill`, confirm 78 rows land for that date with correct historical `capturedAt` values, all `image_urls` populated, browse via Phase 2 UI.

### Phase 5 — Polish _(nice-to-have; ship after 4 if time allows)_

- `/api/trace-live-similar` — pgvector cosine search: "what historical setup is most like the latest reading?" Powers a future "5 most-similar past tape" widget.
- Daemon heartbeat table + missed-capture alert via Sentry.
- Cache hit-rate dashboard widget (read from per-row `cache_read_tokens` we already store).
- Frontend keyboard shortcuts (G/C/D for tabs, ←/→ for prev/next timestamp in historical mode).

## Files (cumulative)

| Phase | New files                    | Modified files                                                                  | Migrations                     |
| ----- | ---------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| 1     | 2 endpoints + 3 tests        | `db-migrations.ts`, `trace-live-analyze.ts`, `db.test.ts`                       | #89                            |
| 2     | 10 frontend files + tests    | `App.tsx` (mount the section), `src/main.tsx` (botid protect for new endpoints) | —                              |
| 3     | full `daemon/` package       | `.env.local` (BROWSERLESS_TOKEN)                                                | —                              |
| 4     | none (extends daemon)        | `daemon/src/index.ts`, `daemon/src/scheduler.ts`                                | —                              |
| 5     | 1 endpoint + frontend widget | —                                                                               | optional #90 (heartbeat table) |

## Data dependencies

- Existing `trace_live_analyses` table (migration #88, shipped).
- Existing `gex_strike_0dte` table (read by daemon for GEX landscape).
- Existing `BLOB_READ_WRITE_TOKEN` in env (already used by sidecar/ml-sweep).
- New `BROWSERLESS_TOKEN` in env (added in Phase 3).
- Browserless.io MCP servers in `.vscode/mcp.json` for docs lookup during daemon dev (already configured; gitignored).

## Open questions

None blocking. Possible deferred decisions:

- Move `BROWSERLESS_TOKEN` from `.vscode/mcp.json` to Vercel + Railway env when Phase 3 deploys.
- Decide whether sound chime is on every capture (current spec) or muted by default with a UI toggle (probably needed once you've heard it 50 times in one session).

## Thresholds / constants

| Constant                                                                 | Value                | Where it lives                                     |
| ------------------------------------------------------------------------ | -------------------- | -------------------------------------------------- |
| Cadence                                                                  | 5 min                | `daemon/src/config.ts`                             |
| Skip-if-running guard                                                    | enabled              | daemon scheduler                                   |
| Session timeout (browserless)                                            | 13 min               | daemon page lifecycle                              |
| Market-hours window                                                      | 08:35 – 14:55 CT     | daemon scheduler (uses `src/data/market-hours.ts`) |
| Frontend poll cadence (live mode)                                        | 60 s                 | `useTraceLiveData.ts`                              |
| Sound chime length                                                       | 0.5 s                | `useTraceLiveChime.ts`                             |
| Sound debounce                                                           | 1 s                  | `useTraceLiveChime.ts`                             |
| API rate limit                                                           | 6 / min              | already enforced in `trace-live-analyze.ts`        |
| Initial backfill scope                                                   | last 10 trading days | one-time                                           |
| predictedClose drift threshold (sound trigger if/when diff engine added) | 10 SPX pts           | deferred (current spec: chime every capture)       |

## Done when

- [ ] Phase 1: endpoints return data, blob storage works, tests pass, reviewer subagent passes
- [ ] Phase 2: dashboard renders correctly with smoke-test data; live + historical modes both functional; tests pass
- [ ] Phase 3: daemon runs locally during market hours, captures land in DB with image URLs; reviewer passes
- [ ] Phase 4: backfill of last 10 trading days complete; all rows browsable in UI
- [ ] Phase 5 (optional): similarity search + heartbeat alerts shipped

## Notes

- **Cache hot-path**: 5-min cadence keeps the Anthropic 1h prompt cache hot — every call after the first is a cache read (~80% cheaper). Don't lower cadence below 1h or we re-pay the cache write tax on every call.
- **Same-instant capture is load-bearing**: the override hierarchy depends on cross-chart correlation. Sequential captures with even 15s drift can flip `overrideFires` from true to false because the 1m delta% column moves continuously. `Promise.all` is the spec, not a nice-to-have.
- **Single source of truth for prompts**: backfill goes through the same `/api/trace-live-analyze` endpoint as live, so any future prompt or schema change re-renders all history consistently when backfill is re-run.
- **Image storage in Blob, not DB**: rows stay small (~5 KB), DB stays fast, image CDN is closer to the user than Neon.
- **No multi-user concerns**: single-owner app, owner cookie + rate limit on the read endpoints is sufficient. No tenant isolation needed.
