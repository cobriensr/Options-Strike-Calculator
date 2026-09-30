# Databento removal + UW futures substitution — 2026-09-29

## Goal

Databento is cancelled (its API 422s `dataset_unavailable_range` for
anything after early Sept 2026). Remove every Databento dependency and
substitute the Unusual Whales futures feed wherever UW has an equivalent,
so no consumer silently serves frozen data.

Builds on `futures-uw-migration-2026-09-08.md` (commit c04d4c15), whose
Phase 1 code landed locally in d1ecc3c5 but was never pushed or enabled.

## Why now — live data-quality damage (verified 2026-09-29)

- `futures_bars` has no rows since 2026-09-03 23:59 UTC.
- `computeSnapshot` (`api/_lib/futures-derive.ts:74-78`) has no max bar age,
  so `fetch-futures-snapshot` has written ES = 7752.75 (the 09-03 close) into
  every `futures_snapshots` row through 09-29 (251–276 rows/day, 1 distinct
  price). DX is frozen at its 2026-03-05 bar. `futures-context.ts:319` feeds
  these to the analyze prompt and the UI shows them: ~4 weeks of wrong ES
  price and ES–SPX basis.
- PCS Monday gate's ES-basis filter passes when its input is null
  (`gamma-detector.ts:649`) → silently disabled since 09-04.
- `current_day_snapshot` has never been written.

## Owner decisions (2026-09-29)

- Remove all Databento code; substitute UW where possible.
- Enable the UW `futures_trades` channel on Railway tonight (Claude does it
  after the after-hours push).
- **OFI / microstructure**: drop now; research a trade-side proxy from UW
  `futures_trades` (side + nbbo per print) later.
- **DX**: no UW substitute (ICE) → drop.
- **ES options** (trades + daily stats): no UW substitute → drop consumers,
  keep the tables.
- **VX1/VX2 → VIX/VIX3M + UW regime label** (decided after probe). VX was
  never a live Databento feed: bc88cc68 (2026-04-11) dropped the XCBF
  subscription because Databento lacked CFE, so VX UI/context has been
  empty since April. UW's futures feed is CME-only (no VX contracts in
  172K instruments; `futures:VXV6` WS joins ack but send 0 frames) and
  `/api/volatility/vix-term-structure` is 403 `volatility_scope_required`
  (separate "volatility" add-on; not documented as part of Whale;
  request_id GNn2tUpW7QL-qBwEyBAC). Substitute: spot VIX / VIX3M ratio
  plus UW `GET /api/stock/SPX/volatility/context` →
  `market.vix_futures_regime` (daily contango/backwardation label from the
  front two VIX futures; also returns `vix`, `vix3m`). Revisit real VX
  prices if UW confirms the add-on.
- Keep in `sidecar/`: SHAP (`/takeit/explain`, `/takeit/health`, used by
  `takeit-fill-shap.ts:152`) and the read-only DuckDB archive (`/archive/*`,
  frozen ~2026-04-17; Postgres fallback covers new days).
- Drop from `sidecar/`: Databento ingestion, Theta (never running), the
  `/takeit/multileg-classify` fallback (`CLASSIFIER_URL` set in prod),
  `fetchTbboDayMicrostructure` (no callers).
- Tables stay in Neon (historical research reads them).

## UW substitution map

| Databento product | UW substitute |
| --- | --- |
| ES/NQ/RTY/CL/GC/ZN 1m bars | `futures_trades` WS handler (d1ecc3c5) + REST `/api/futures/{contract}/candles` for gap repair (1m depth ≈ 5,000 rows ≈ 3.5 days) |
| Front-month selection | REST `/api/futures/contracts` (most-active) |
| DX | none |
| VX1/VX2 | VIX/VIX3M ratio + UW `volatility/context` `vix_futures_regime` label (proxy, not prices) |
| Top-of-book / TBBO | none (per-print nbbo only — research) |
| ES options trades + daily stats | none |

## Phases

### F0 — Git (tonight, after hours)

- Cherry-pick c04d4c15 + d1ecc3c5 onto the integration branch (based on
  origin/main) and push with the B–E Sentry fixes. Only uw-stream redeploys
  (Vercel `ignoreCommand` skips these paths); the handler is inert until
  `WS_CHANNELS` includes it. Restart pauses flow-alerts/option_trades during
  the lease handoff → after hours only.
- Do NOT push 089c7ab1 (51-line classifier-spec fragment duplicating
  aa843b5a on draft PR #202 → add/add conflict). Local `main` keeps it;
  owner drops it when reconciling.

### F1 — Enable UW futures ingestion (tonight, Railway)

- Append `futures_trades` to uw-stream `WS_CHANNELS`; verify rows land in
  `futures_bars`; tomorrow's session is the soak.
- Watch: `receive_queue_drops` on uw-stream `/metrics` (futures_trades
  lands on shard 2 with flow-alerts, off_lit_trades, 42 option_trades
  tickers; all shards share one receive queue, `uw-stream/src/main.py:195`).
- Roll risk: front-month tally resets at midnight UTC (`_roll_session`),
  mid-Globex — check around contract rolls.

### F1b — Stop serving frozen futures (code, urgent)

- Max bar age in `computeSnapshot` (`api/_lib/futures-derive.ts`) → return
  null when the latest bar is stale; drop DX (and VX1/VX2 if the probe says
  no substitute) from `FUTURES_SYMBOLS`; update snapshot tests.
- Files: `api/_lib/futures-derive.ts`, `api/cron/fetch-futures-snapshot.ts`
  (if symbols live there), tests.

### F2 — Crons (code; after Sentry fix D merges — shared vercel.json)

- Rewrite `api/cron/backfill-futures-gaps.ts` to repair gaps from UW REST
  candles (also fixes its silent-failure bug: `fetchBars` swallowed non-OK
  and reported `ok`).
- Delete `fetch-es-options-eod.ts`, `refresh-current-snapshot`,
  `warm-tbbo-percentile` + tests; remove their `vercel.json` entries,
  `api/_lib/cron-schedules.ts` entries, and any `src/main.tsx`
  `initBotId` protect-list entries.
- Owner/ops after deploy: delete Sentry cron monitors for removed crons,
  remove `DATABENTO_API_KEY` from Vercel.

### F3 — Analyze context + prompt (code)

- Remove ES-options (`futures-context.ts:351-380`), DX, and microstructure
  (`microstructure-signals.ts` → `analyze-context.ts:423`) sections and the
  matching prompt text (`analyze-prompts.ts:793-883`, `:985-1078`).
- Changes the cached prompt prefix → run the `analyze-prompt-reviewer`
  agent.

### F3b — UI (code)

- Remove DX from `FuturesGrid`; update `useFuturesData.ts`,
  `api/futures/snapshot.ts`.
- Rewire `VixTermStructure.tsx` (and `deriveVxTermStructure` in
  `api/futures/snapshot.ts`) from VX1/VX2 to the VIX/VIX3M ratio + UW
  `vix_futures_regime` label; F3 swaps the `vxTermSignal` context block the
  same way (keep a comparable threshold, documented). Drop VX1/VX2 from the
  futures symbol list.

### F4 — Sidecar strip (code, then Railway)

- `sidecar/src/main.py`: drop Databento/Theta startup (it currently
  `sys.exit(1)` without `DATABENTO_API_KEY`, `:106-113` — the code change
  must deploy BEFORE the key is removed or SHAP goes down).
- `health.py`: remove databento + data_fresh checks (currently 503).
- Delete Databento + Theta modules and tests; drop `databento` from
  `requirements.txt`; remove Java runtime + Theta jar from the Dockerfile;
  delete sidecar `package*.json` + its Dependabot npm entry.
- Owner/ops after deploy and `/health` + `/takeit/health` green: remove
  `DATABENTO_API_KEY`, `THETA_*` from Railway.

### F5 — Docs

- `CLAUDE.md` (architecture sidecar section, env table), `README.md`,
  `.env.example`, `docker-compose.dev.yml`, sidecar + uw-stream READMEs.

## Files (by phase)

- F1b: `api/_lib/futures-derive.ts`, `api/cron/fetch-futures-snapshot.ts`,
  tests
- F2: `api/cron/backfill-futures-gaps.ts`, deletions above, `vercel.json`,
  `api/_lib/cron-schedules.ts`, `src/main.tsx`, tests
- F3: `api/_lib/futures-context.ts`, `api/_lib/analyze-context.ts`,
  `api/_lib/analyze-prompts.ts`, `api/_lib/microstructure-signals.ts`,
  tests
- F3b: `src/components/**/FuturesGrid*`, `src/hooks/useFuturesData.ts`,
  `api/futures/snapshot.ts`, tests
- F4: `sidecar/src/*`, `sidecar/Dockerfile`, `sidecar/requirements.txt`,
  `.github/dependabot.yml`, sidecar tests
- F5: docs listed above

## Data dependencies

- Railway uw-stream env: `WS_CHANNELS` += `futures_trades`.
- Remove env: `DATABENTO_API_KEY` (Vercel + Railway sidecar), `THETA_*`
  (Railway sidecar) — only after code no longer requires them.
- No migrations; tables retained.

## Open questions

- Does the Whale plan include UW's `volatility` add-on? (owner to ask UW;
  would enable real VX1/VX2 via `/api/volatility/vix-term-structure`)
- Does `futures_trades` volume saturate the shared receive queue? (soak)
- Deeper 1m history via undocumented candle params? (defaults to REST
  depth limit; archive/Postgres cover history)
- `day_embeddings` stops at 09-21 — possibly unrelated; check separately.

## Thresholds / constants

- Futures snapshot max bar age: to be set in F1b (default: 15 minutes
  during RTH for 1m bars; implementer justifies the value against the cron
  cadence).
