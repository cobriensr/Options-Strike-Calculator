# Periscope Scraper — Direct XHR Feasibility Spec

**Date:** 2026-05-10
**Status:** Feasibility gate — not greenlit. Phase 0 must pass before any code is written for Phases 1+.

## Goal

Evaluate whether the `periscope-scraper` Railway service can replace its
Playwright-based DOM scrape with direct HTTP calls to UW's underlying
endpoints, using only auth we already possess. Decide go / no-go after
Phase 0 produces evidence.

## Motivation

Today's scraper:

- Spins up a fresh Chromium per cron tick (~10s cold start).
- Cycles three Greeks via dropdown clicks (~5–10s each, with anti-bot
  retries baked into [scrape.ts:417-506](../../../periscope-scraper/src/scrape.ts#L417-L506)).
- Walks date / Expiry / timeframe widgets via DOM heuristics that break
  whenever UW ships a Tailwind class hash change (recurring incident,
  per `scrape.ts:299-313`).
- Costs Railway memory + Chromium overhead; subject to UW anti-bot
  guards (validated 2026-05-08: stripped Single-mode dropdown when
  `navigator.webdriver` is true).

A direct-XHR replacement would: (a) eliminate Chromium entirely on
Railway, (b) shrink per-tick latency from ~30s to ~1s, (c) make the
backfill range loop `tradingDaysBetween()` × 40 slots/day complete in
seconds instead of hours, (d) remove the entire stealth-plugin
dependency and DOM-class fragility surface.

## What we know vs. don't know (auth surface)

Verified by parallel investigation 2026-05-10:

| Surface                                                          | Auth                                       | Host                                   | Confirmed reachable?                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Periscope web app                                                | Session cookie (Playwright `storageState`) | `unusualwhales.com`                    | Yes (current scraper)                                                                                                            |
| UW REST API (we already use)                                     | Bearer `UW_API_KEY` (Advanced tier)        | `api.unusualwhales.com`                | Yes                                                                                                                              |
| Periscope **internal XHR** (what React SPA fires under the hood) | **Unknown — assumed session-cookie**       | **Likely `unusualwhales.com/api/...`** | **No probe has captured bodies yet**                                                                                             |
| Periscope-shaped data via REST                                   | Bearer                                     | `api.unusualwhales.com`                | **Unknown — never tested whether `/gex/...` or similar endpoints expose per-strike-per-slot rollups matching Periscope's table** |

The two unknowns above are the only things blocking a feasibility
verdict. Both are answerable with a 1-hour probe.

## Phase 0 — Feasibility probe (mandatory gate)

Goal: produce evidence that Path A (replay session-cookie XHR) is
viable. If it isn't, this spec is shelved and the Playwright scraper
stays.

### Path B — KILLED (2026-05-10)

User confirmed: there is no UW REST API endpoint exposing Periscope's
MM-attributed per-strike-per-slot Greek data. The heat maps are
website-side computation only; UW does not publish that data on
WebSocket or REST. (Memory:
`project_periscope_naive_vs_mm_gex.md`.) Path B is removed from this
spec — Phase 2 below is no longer reachable.

### Path A — session-cookie XHR replay

Extend `scripts/periscope-historical-probe.mjs` to capture full
request/response bodies during a date+Greek+timeframe walk:

- [ ] **Task A1**: Add `context.on('request', ...)` and `response.body()`
      capture to the existing `context.on('response', ...)` block at
      [periscope-historical-probe.mjs:110-119](../../../scripts/periscope-historical-probe.mjs).
      Filter to `unusualwhales.com` non-asset URLs only (skip `.js`,
      `.css`, `.woff2`).
      → Verify: probe writes `network-bodies.json` to
      `docs/tmp/periscope-historical-probe/<ts>/`.
- [ ] **Task A2**: Run the probe through one full scrape cycle (load
      page → set Expiry single → walk timeframe → cycle 3 Greeks).
      Catalog every distinct endpoint hit during that cycle. Group
      by URL path; note which fire on Greek-change vs. timeframe-change
      vs. date-change.
      → Verify: a table in this doc listing endpoints + triggers + sample
      response shape (≤300 chars per shape).
- [ ] **Task A3**: Pick the endpoint that returns per-strike Greek data
      and replay it from Node with `node --eval "fetch(URL, {headers:
{Cookie: '...'}})"`, using cookies extracted from
      `UW_AUTH_STATE_PATH`. Test rapid sequential calls (5 calls in
      500ms) to detect rate-limit or anti-bot gating.
      → Verify: identical JSON response from Node fetch and from
      browser; no 403/429 across 5 rapid calls.

If A3 returns identical JSON: Path A is feasible. Proceed to Phase 1.
If A3 returns 403/CSRF-required/different JSON: Path A is **NOT**
feasible — UW is gating XHR by browser-context. Shelve spec.

## Phase 1 — Replace Playwright with XHR client (only if Path A passes)

### Deployment topology — Railway daemon → Vercel cron

The XHR migration is also a deploy-target migration. The
`periscope-scraper/` Railway service is retired entirely. Its
responsibilities split as follows:

| Daemon role today                                         | After migration                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Live 10-min RTH tick                                      | Vercel cron `api/cron/scrape-periscope.ts` (CRON_SECRET-guarded, same pattern as the existing 35 crons)             |
| Boot-time `UW_AUTH_STATE_B64` decode → `/data/...`        | Decode in-memory per invocation; serverless is stateless                                                            |
| `FORCE_TICK` one-shot                                     | `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/scrape-periscope`                                        |
| `BACKFILL_DATE` / `BACKFILL_DATE_START+END` env-var modes | Local script `scripts/backfill-periscope-xhr.mjs`; XHR is fast enough that backfill runs comfortably on the dev box |
| Cookie refresh (`--login` headed Playwright)              | Stays as local script (existing pattern)                                                                            |
| Sentry, Pino, market-hours gate                           | Native to Vercel cron infra                                                                                         |
| `tickInFlight` mutex                                      | Drops — XHR ticks are ~1s, Vercel cadence guarantees no overlap                                                     |

Net infra change: **`periscope-scraper/` directory deleted from the
repo, Railway service deprovisioned.** `sidecar/` and `uw-stream/` stay
on Railway (separate services, unrelated).

Bundle-size note: today's `periscope-scraper/` includes Playwright +
Chromium + stealth plugin (~300MB). XHR replacement is `fetch` + Zod +
Sentry — smaller than most existing `api/cron/` handlers.

### File layout (post-migration)

```text
api/cron/
  scrape-periscope.ts        ← Vercel cron entry, CRON_SECRET guard,
                                market-hours gate, calls scrapeOnce()
api/_lib/
  periscope-xhr.ts           ← cookie-bearing fetch wrapper, retry/backoff,
                                CSRF handling if probe shows it's needed
  periscope-endpoints.ts     ← typed wrappers: getGreekRows(date, expiry,
                                hhmm, greek)
  periscope-schema.ts        ← Zod schemas for request → response shapes
  periscope-cookie.ts        ← decodes UW_AUTH_STATE_B64 → Cookie header
scripts/
  backfill-periscope-xhr.mjs ← local-only ad-hoc backfill (replaces
                                BACKFILL_DATE_START daemon mode)
```

### Sentry instrumentation (mandatory)

The XHR client must explicitly detect every failure mode below — no
silent `.catch(() => [])` fallbacks. Runtime alerting is the resilience
strategy in lieu of a parallel canary scraper.

**Loud failures** — auto-detected from HTTP status / parse errors:

| Failure                   | Detection         | Sentry severity                         |
| ------------------------- | ----------------- | --------------------------------------- |
| Endpoint 404 / 5xx        | non-2xx response  | error                                   |
| Anti-bot 403 / 429        | status code       | error (account-risk signal)             |
| Auth 401 (cookie expired) | status code       | error — triggers cookie-refresh runbook |
| Network / DNS / TLS error | fetch throws      | error                                   |
| Response not valid JSON   | JSON.parse throws | error                                   |

**Silent failures** — require explicit guards in code:

1. **Schema validation (Zod)** — every response parsed through a Zod
   schema; validation failure → `captureException(new SchemaError(...))`
   with unexpected shape attached, truncated to 1KB. Hard-fail: do NOT
   insert rows when schema doesn't match. Catches field renames, type
   changes, structural restructures.
2. **Empty response during RTH** — 0 rows on a trading day with the
   target DTE-0 expiry → warning. Outside RTH, 0 rows is legit (skip
   alert).
3. **All-zero or all-null Greek values** — every row in the slot has
   `gamma === 0 && charm === 0 && vanna === 0` → warning. Could be a
   quiet open, but flag.
4. **Row-count regression** — slot returns < 50% of the same slot's
   row count from the prior trading day → warning.
5. **Spot-price sanity** — `response.spot` deviates from live SPX
   (existing `/api/spot` or YF reference) by > 1% → error. This is the
   most important check; if the chart's spot is wrong, every level is
   wrong.
6. **Timeframe drift** — `response.timeframe` does not match the
   requested slot → error. Catches the case where UW silently
   served a different slot than asked.

All Sentry events tagged `service:periscope-scraper-xhr` and include
endpoint URL + request params + truncated response.

### Key design decisions to defer until probe data is in hand

- **Cookie refresh**: storageState still expires every few weeks
  (SETUP.md). The XHR transport doesn't help that. May want a
  `--login` mode that runs Playwright once-monthly to refresh cookies,
  decoupled from the scrape itself.
- **Concurrency**: with XHR replacing 30s/tick → 1s/tick, the cron
  could move from 10-min cadence to whatever UW publishes natively
  (still 10-min slots — confirmed by `scrape.ts:18`).
- **Backfill speed**: `scrapeBackfillRange` becomes
  `Promise.all(dates.map(d => fetchDay(d)))` instead of a
  per-day Chromium walk. Concurrency cap at e.g. 5 to avoid tripping
  rate limits.

## Risks

- **TOS / account ban**: If UW considers session-cookie XHR replay a
  TOS violation (UW_API_KEY is the supported automation surface), Path A
  risks the user's account. Path B is fully supported. Confirm UW's
  stance before shipping Path A — at minimum, gate it behind a manual
  trigger initially, not the cron.
- **Endpoint drift**: Internal XHR endpoints aren't versioned or
  documented; UW can rename them without notice. Public REST endpoints
  also drift (per `feedback_uw_spec_vs_live.md`) but more slowly.
  Mitigation: the mandatory Sentry instrumentation in Phase 1 (schema
  validation, value sanity checks, spot-price anchor) is designed to
  detect drift within the first failed slot rather than letting bad
  data accumulate silently.
- **Wasted effort**: If Phase 0 fails on both paths, ~2h of probe
  work is sunk cost. Acceptable budget.

## Kill criteria

Abandon spec and keep Playwright if any of:

- Path A probe shows the endpoint requires a CSRF token derived from a
  per-page-load nonce (effectively re-binds to browser context).
- Path A probe returns 403 / 429 on 5 sequential Node-fetch calls.
- UW publicly documents that web-app cookies are not for automation.

## Open questions

- Does UW's web app fire a single XHR per Greek-change, or does it
  fetch all three Greeks on the timeframe change and the dropdown is
  pure UI? **Unknown — answer in Task A2.** This determines whether the
  XHR client cycles Greeks at all.
- What's the cookie TTL? If shorter than a week, refresh becomes a
  separate engineering problem.

## Verification (gate to leave Phase 0)

- [ ] Path A endpoint catalog written into this doc with body samples,
      OR Path A formally ruled out
- [ ] Decision recorded: GO Path A / SHELVED, with one-paragraph
      rationale appended to this spec
