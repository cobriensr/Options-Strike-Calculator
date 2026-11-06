# GEXBot refresh — 2026-10-28

## Goal

Bring the whole GEXBot integration (capture, storage, every reader, every
label, the research loop) in line with the vendor's current contract (spec
2.13.0, docs.gexbot.com as of 2026-10-28) and fix what is broken, so every
number the owner sees means what the label says.

## Sources

Five read-only audits ran 2026-10-28 (reports in the main checkout's
gitignored `docs/tmp/gexbot-refresh-2026-10-28/`: `ingestion.md`,
`consumers.md`, `vendor.md`, `research.md`; probe scripts beside them). They
re-verified the 2026-10-02 audit (`docs/tmp/gexbot-leverage-audit-2026-10-02.md`)
at HEAD. Finding IDs below (I = ingestion, C = consumers, R = research,
V = vendor) refer to those reports.

## Facts established (load-bearing, verified)

- Key is Orderflow tier (`/whoami`). All 58 REST tickers in the spec enums
  return 200 for our key (44 more than the 16 we poll). WebSocket is Quant only.
- Spec 2.5.5 → 2.13.0 changed nothing we call. 2.2.0 → 2.5.5 removed fields
  from `orderflow_response` that the live payload never had, typed
  `mini_contracts`, `strikes`, `max_priors`, made `spot` nullable.
- **`mini_contracts[i][4]` priors are t−5, t−15, t−30 min**, not t−1/5/10.
  Verified three ways: vendor EOD history (exact match), consumers probe
  (330 captures), and an independent check in this session (SPX gamma_zero and
  charm_zero at 10:47, 12:13, 13:59 ET: error ≈ 0 at 5/15/30, 30–100× larger
  at 1/5/10). Classic `strikes[i][3]` priors are t−1/5/10/15/30.
- `mini_contracts[1..2]` = call/put IV. `[5..6]` always 0/null on the API.
- State Greeks and every orderflow field are **taker**-signed. Probe-4 found
  GEXBot gamma correlates positively with a UW taker-bought-minus-sold proxy
  (Spearman 0.35–0.57, 18/18 snapshots). The 2026-10-02 cutover test found no
  sign flip vs the scraper era. These two results disagree; see D1.
- `*oflow` = the step difference between consecutive vendor snapshots (1–2 s)
  of `agg_dex`, `zgr`, `zcvr` (13,359/13,359 steps). We sample 1/min.
- `zcvr` = net convexity (taker long − short GEX, signed $, centred on 0),
  not a ratio. `zgr` = call − put GEX imbalance. Charm = $MM/hr. Vanna =
  −vanna ex, $MM to expiry.
- `ES_SPX` = SPX chain shifted ~+35 pts (92.8% identical maxchange values);
  `NQ_NDX` likewise duplicates NDX.
- `delta_risk_reversal` = "Vestigial metric, discontinued" (docs), still
  emitted with changing values.
- `max_priors[0]` / maxchange `current` can carry an INT32 sentinel
  `-2147483.648` (seen 15:59:46–16:00:00 ET on 10-28).
- `/hist/eod/{t}` (in tier): ZIP with the full day at ~2 s resolution for all
  15 categories, byte-identical to REST. Latest day only, eligible 17:00 ET.
  SPX ≈ 85 MB zipped. Quota pool undocumented.
- Live Take-It bundle is `v2026-05-16`, has no GEXBot features; the ML
  Pipeline workflow (nightly retrain) has been disabled since 2026-04-17.
- Market calendar `src/data/marketHours.ts` ends 2026-12-31 (all gates).

## Phases

Done: **P0** comment pass, `23035182` (pushed). Its priors note says "read as
t−1/5/10, our assumption" — P4 corrects it to the verified 5/15/30.

No owner decision needed (run in order, one implementer at a time):

| Phase | Scope | Findings | Est. |
|---|---|---|---|
| P1 | 2027 NYSE holidays + early closes in `src/data/marketHours.ts`; a test that fails when the calendar covers < 60 future days | I1 | S |
| P2 | Fetch-cron hardening: GEXBot HTTP errors carry the status; 429 not retried; Sentry fingerprint + tag by status class; status via `deriveCronStatus` (total outage = `error`); `withDbRetry` on capture INSERT; fast cron writes snapshot and capture as separate legs, failed leg counted; `maxDuration: 60` for fast (config + vercel.json) | I3, I4, I5, I8 | M |
| P3 | Monitoring: Sentry cron monitors for fast, strikes, populate (ET-anchored, `failureIssueThreshold: 3`); drift test unions multi-window vercel.json entries; populate status via `deriveCronStatus`; fingerprints on the two variable-text `captureMessage`s; `GEXBOT_API_KEY` in `env.ts` + CLAUDE.md table; remaining header drift (archive "21:00 UTC", health "17:30 CT") | I2, I3, I13, I15, I16 | M |
| P4 | Priors windows: rename `prev1m/5m/10m` → `prev5m/15m/30m` end to end (decoder, `/api/gex-landscape` payload, hook, GexLandscape classify/formatters/types/UI, GexTarget, the text sent to Claude); fix P0's priors comments. Atomic across the API boundary, so this phase may exceed 5 files | C11 | M |
| P5 | Gexbot dashboard fixes that are wrong under any sign reading: CharmClock units ($MM/hr) + live clock; ConvexityMatrix split at 0 and relabel "net option buying/selling"; "dealer +flow" → taker on the LOUDEST tile; breadth and grids exclude ES_SPX/NQ_NDX; show `min_dte` instead of hard-coded "0DTE"; `zero_gamma = 0` = unknown | C5, C7, C13, C17, C18, C19, C33 | M |
| P6 | Strike Mover Ladder + badge: remove the 4 always-empty Greek tabs; drop ES_SPX from the ladder; filter the INT32 sentinel in `getMaxchangeWinners`; badge prints raw net put DEX, splits arrows at 0, renames the `zcvr` line, "next expiry" wording | C1, C3, C20, C21, C22 (mechanical part), V-sentinel | S |
| P7 | Dead code: delete `periscope-analyzer-rules.ts`, `periscope-synthesize.ts` (+ its test), stale refs | C28, C29 | S |
| P8 | ML guard: add the 5 unserved `gex_*` names to `NON_FEATURE_COLS` and a test that every bundle feature is producible by the live featurizer | R3 | S |

Owner decisions (each becomes a phase once decided; default pick in brackets):

| ID | Question | Gates | Default |
|---|---|---|---|
| D1 | Sign convention for `periscope_snapshots` and its readers: (a) negate GEXBot on ingest to MM sign, (b) keep taker sign and rewrite readers/rules, (c) run a study on GEXBot-era history first | C8, C9, C10, C12, C25, C26, C30, C31, C32 | [c — study first; add a `source` column either way] |
| D2 | Analyze prompt: charm thresholds re-derived in $MM/hr; the structured Periscope block counts as "available" (no MODERATE cap) | C23, C24 | [yes, re-derive on GEXBot-era history] |
| D3 | Strike Mover Ladder: Classic or State winners (or two labelled ladders), and the colour matrix per model | C2, C4 | [Classic only, vendor colour semantics] → decided, see Decisions recorded (two tabs; the default was superseded) |
| D4 | Keep / redesign / remove: sibling pills, skew dashboard (discontinued DRR), velocity tape (1-s samples), fire badge | C14, C15, C16, C22, I9 | [redesign sibling on `zgr`/`net_dex` at fire time; remove skew dashboard; velocity tape → minute-over-minute Δ of `agg_dex`/`zgr`/`zcvr`; keep badge] → decided, see Decisions recorded |
| D5 | Capture expansion (owner prefers more/faster data): persist Classic `strikes[]` + `max_priors` (already fetched); daily `/hist/eod` pull to Blob (2-s full day, ~85 MB/ticker); more tickers (44 available); true 1-min Δ next to 5/15/30 | 10-02 §3, V | [persist strikes[]; EOD pull for SPX/SPY/QQQ first; tickers later] |
| D6 | Data hygiene: unique keys on both capture tables + dedupe the ~240 dup rows/day (destructive on live rows); stale-row policy (skip vs flag); `periscope_snapshots` retention; `REINDEX CONCURRENTLY` (~200 MB) | I6, I7, I11, I12 | [unique keys + ON CONFLICT DO NOTHING; flag stale, don't skip; keep periscope rows; reindex] |
| D7 | Research: recover outcomes for fires 06-12 → 10-22 (DB write), then the GEXBot re-probe; re-validate Periscope lottery filters, gamma setups, PCS threshold on GEXBot-era data | R5, C27, C31, C32 | [recover, then re-probe] |

## Files by phase

- P1: `src/data/marketHours.ts`, its test.
- P2: `api/_lib/gexbot-client.ts`, `api/_lib/gexbot-store.ts`,
  `api/cron/fetch-gexbot-fast.ts`, `api/cron/fetch-gexbot-strikes.ts`,
  `vercel.json`, tests (`gexbot-client`, `gexbot-store`, `fetch-gexbot-fast`,
  `fetch-gexbot-strikes`). Read `api/_lib/uw-fetch.ts` `withRetry` first: the
  ingestion and vendor reports disagree on whether plain 500 retries.
- P3: `api/_lib/cron-schedules.ts` (+ test), `api/cron/populate-periscope-from-gexbot.ts`,
  `api/cron/audit-gexbot-health.ts`, `api/cron/archive-gexbot.ts` (comment),
  `api/_lib/env.ts`, `CLAUDE.md`.
- P4: `api/_lib/periscope-gexbot.ts`, `api/gex-landscape.ts`,
  `src/hooks/useGexLandscapeData.ts`, `src/components/GexLandscape/*`,
  `src/components/GexTarget/*`, `api/_lib/gexbot-client.ts` (comment), tests.
- P5: `src/components/Gexbot/{CharmClock,ConvexityMatrix,DealerStateSummaryStrip,GammaCompass,DexoflowVelocityTape,types,ticker-order}`,
  `src/hooks/useGexbotData.ts`, `api/gexbot.ts` / `api/_lib/gexbot-queries.ts`
  (select `min_dte`), tests. Split into two sub-phases if > 5 source files.
- P6: `src/components/Gexbot/strike-mover-ladder/*`, `StrikeMoverLadder.tsx`,
  `api/_lib/gexbot-queries.ts`, `src/utils/gexbot-badge.ts`, tests.
- P7: the two dead modules, their test, `MMExposureMap.tsx` comments.
- P8: `ml/src/takeit/train.py`, an ml test.

## Data dependencies

- P1–P8: none (no migrations, no env vars beyond registering the existing
  `GEXBOT_API_KEY`).
- D1: possibly a migration (`source` column on `periscope_snapshots`).
- D5: Blob storage for EOD ZIPs; possibly a table for Classic `strikes[]`.
- D6: migration for unique keys, a one-off dedupe of live rows, prod REINDEX.

## Thresholds / constants

- Calendar horizon test: fail when < 60 future days covered.
- Sentry monitors: `* 10-15 * * 1-5` (fast, strikes) and `*/10 10-15 * * 1-5`
  (populate), `timezone: 'America/New_York'`, `failureIssueThreshold: 3`.
- `maxDuration` for fetch-gexbot-fast: 60 s.
- INT32 sentinel: drop any maxchange/max_priors value `<= -2147483`.
- Fire-time lookups (`FIRE_TIME_MAX_AGE_SECONDS`, `api/_lib/gexbot-queries.ts`):
  a snapshot counts when it is at or before the fire time and at most 180 s
  older (two consecutive missed 1-min cron runs). Used by both
  `getLatestGexbotSnapshotAt` and the sibling read.
- Velocity tape gap rule: a prior snapshot more than 3 minutes older gives null
  deltas (two missed 1-min runs; exactly 3 minutes is kept).
- Velocity tape highlight (`src/components/Gexbot/velocity-tape.ts`): a row is
  "unusual" when |Δ`agg_dex`| + 1e-9 ≥ 3 × max(typical, 0.25), where typical is
  the ticker's session median |Δ`agg_dex`|. The 1e-9 absorbs floating-point
  error at exact multiples (3 × 0.4 = 1.2000000000000002). Tuned on the
  2026-10-28 and 2026-10-29 sessions only; re-tune on more history.
- LOUDEST tile quiet rule (2026-11-05): the tile keeps showing the top
  ratio, but when `isUnusual` is false it is neutral and reads "quiet · nothing
  ≥ 3× typical"; when the floor is the denominator (typical < 0.25 or none) the
  subline reads "N× the 0.25 floor", not "N× typical".
- Sibling-confirm retry (2026-11-05; `useGexbotData`): after a failed
  read the hook retries every 30 s at any hour, transient failures only
  (status 0, 408, 429, 5xx), at most 5 retries per URL (`SIBLING_MAX_RETRIES`,
  about 2.5 minutes), then stops; a good read or a permanent 4xx stops it
  sooner, and a URL change resets the count. Other views keep the
  market-open gate.

## Decisions recorded

- 2026-10-28: owner approved "check and update everything" after the
  comment pass. Mechanical phases P1–P8 proceed without further approval;
  D1–D7 wait for owner answers.
- 2026-10-28: D1 → (c). Run a read-only sign study on GEXBot-era history
  (05-26 → 10-28) against the scraper era before choosing negate-on-ingest
  vs taker-sign rewrite. Report: main checkout
  `docs/tmp/gexbot-refresh-2026-10-28/sign-study.md`.
- 2026-10-28: sign study result (`docs/tmp/gexbot-refresh-2026-10-28/sign-study-results.md`):
  price tests inconclusive (69 tests, min q 0.335); construction check vs UW
  taker flow shows GEXBot gamma = −(scraper MM convention), flipping exactly at
  05-26 (high confidence); no trading edge shown for either sign.
- 2026-10-28: D1 → **yes, negate GEXBot gamma** so per-strike gamma is
  MM-signed everywhere it is labelled MM: on ingest into `periscope_snapshots`
  and in the GEX Landscape read path; re-sign the stored GEXBot-era gamma rows;
  add `periscope_snapshots.source`. Charm and vanna unchanged. GEXBot scalar
  fields (`zcvr`, `z_mlgamma`, …) keep the vendor's taker sign and get taker
  labels (P5). Rule re-validation on GEXBot-era history follows (D7).
- 2026-10-28: D6 → **yes**: dedupe the live capture tables (~480 rows; Blob
  archive untouched), add unique keys, `ON CONFLICT DO NOTHING`.
- 2026-10-29 (times are CT): five owner decisions followed the revised D1
  (next section). They are listed here in the order they were made.
  - **I4, ~12:25** (the analyze prompt's confidence rule), final wording after
    review rounds CR1/CR2. The Missing Data Protocol list (Market Tide, QQQ Net
    Flow, Aggregate GEX) defines "primary" for both LOW triggers, whether or
    not UW Periscope is present. A missing SPX Net Flow never counts. A missing
    UW Periscope applies the MODERATE cap only. "Periscope" means UW Periscope
    only, and GEXBot is never Periscope or a primary signal.
  - **D4 → defaults, 13:01.** Sibling pills are judged by the sign of `net_dex`
    at fire time (P12a). The skew dashboard is removed and the
    `delta_risk_reversal` column is kept (P12b). The velocity tape becomes the
    minute-over-minute Δ of `agg_dex` / `zgr` / `zcvr` (P12b). The fire badge
    is kept and the 2026-05-26 probe r-values are dropped from it.
  - **D3 → two tabs, ~18:45.** The Strike Mover Ladder shows both models as
    two tabs, "Classic GEX" and "State (taker)", with sign-only sky/violet
    colours. This supersedes the bracketed default in the D3 row above
    (Classic only, vendor colour semantics).
  - **D-tape: fixed order, 20:09 (option A).** Tape rows stay in the fixed
    `GEXBOT_UNDERLYING_ORDER` (no sort by size), and a row is highlighted when
    its |Δ`agg_dex`| is unusually large for that ticker.
  - **Highlight threshold, 21:18.** 3 × max(typical, 0.25), replacing the first
    pick of 2 × max(typical, 0.05) (which lit the liquid names in about 20% of
    minutes; 3× / 0.25 does so in about 9%). It rests on the 2026-10-28 and
    2026-10-29 sessions only; re-tune on more history (see Thresholds /
    constants).
- 2026-11-05: **I2 → (a).** The strip's LOUDEST tile reads `view=velocity`
  (it shares the tape's in-flight fetch) and picks the underlying with the
  largest |Δ`agg_dex`| ÷ max(typical, 0.25), using the same typical-minute
  rule as the tape's highlight (`velocity-tape.ts`). It is labelled "most
  unusual taker Δ / min". Rows with no valid Δ are never picked; with none,
  the tile shows its empty state. This replaces ranking by the vendor
  `dexoflow` (a single 1–2 s step, which could show the opposite sign to the
  tape's row for the same ticker). `dexoflow` leaves the snapshots-latest
  read and type, being unread.
- 2026-11-05 (owner): **flow-vs-gamma split → LOW.** In the analyze prompt's
  CONFIDENCE CALIBRATION, when the Rule 8 flow consensus (Market Tide, QQQ Net
  Flow, ETF Tide) and the UW Periscope Gamma profile point opposite ways, the
  answer is LOW even if that is the only contradicting primary signal. SPX Net
  Flow alone disagreeing with gamma does not count (Rule 8 treats it as an
  anti-signal). This settles the old conflict between the MODERATE line ("at
  most 1 contradicting primary signal") and the LOW line ("flow says one
  direction, gamma says another"). One new list item after the LOW line in
  `api/_lib/analyze-prompts.ts`; the cached static block changes, so one cache
  write.

## Phases added by the D1 / D6 decisions

| Phase | Scope | Order notes |
|---|---|---|
| P9 (D6) | Migration #192 on `gexbot_api_capture` only: lock, delete byte-identical duplicates (key ticker, endpoint, category, source_timestamp; lowest `id` kept), partial unique index `WHERE source_timestamp IS NOT NULL`; capture INSERT `ON CONFLICT DO NOTHING RETURNING 1`, crons report rows written + `skipped`. `gexbot_snapshots` gets no key: its rows merge the orderflow and classic calls, so (ticker, source_timestamp) is not a natural key (VIX open rows differ in the classic half) | After P4. Deploy the code FIRST, then apply #192 through `migrateDb()` (`scripts/run-pending-migrations.mts`), never statement by statement; after hours, not 12:15–12:20 UTC |
| P10a (D1) | Migration only: `ALTER TABLE periscope_snapshots ADD COLUMN source TEXT` (nullable) | Deploy + apply before P10b |
| P10b (D1) | Code: populate negates gamma and writes `source = 'gexbot'`; GEX Landscape negates gamma at read; labels say MM for gamma. Migration: tag `source = 'scraper'` before the 2026-05-26 cutover; `UPDATE … SET value = -value, source = 'gexbot' WHERE panel = 'gamma' AND source IS NULL AND captured_at >= cutover`; charm/vanna rows get `source = 'gexbot'` unflipped. `source IS NULL` guard makes the flip order-safe and run-once | Apply right after the P10b deploy, after hours |

Run order: P3 → P4 → P9 → P10a → P10b → P5 → P6 → P7 → P8.

## D1 revised (owner, 2026-10-29 09:00 CT) — supersedes the negation above

The P10b review measured the two feeds side by side on 2026-05-26 (same
expiry and strikes, minutes apart): per-strike Spearman between UW scraper
gamma and GEXBot gamma ≈ +0.04 (208 slice pairs; within-feed 0.94 and 0.80).
GEXBot is a classified **taker flow** imbalance; UW Periscope was a
market-maker **position** estimate. They are different measurements, not one
measurement with opposite signs.

Owner decision: keep the sources separate, with separate rules per source.
- **No negation.** GEXBot gamma keeps its own (taker) sign everywhere and is
  labelled as such. Every `periscope_snapshots` row is tagged with `source`
  ('scraper' before the cutover instant 2026-05-26T17:20Z, 'gexbot' after).
- **UW-tuned rules run only on UW data.** Since the cutover all live data is
  GEXBot, so these pause on GEXBot data until GEXBot-specific versions exist:
  the Periscope lottery gamma filters, the gamma setups (E1, PCS Monday, …),
  and the analyze prompt's Periscope gamma floor/ceiling/asymmetry rules.
  Claude still receives GEXBot gamma, labelled with the vendor's meaning.
- **Build GEXBot-specific rules** from GEXBot-era history, starting from the
  vendor's own guidance (taker-long strikes as walls in falling vol, etc.).
- **Compare GEXBot vs UW live** to learn how each should inform trading. This
  needs UW Periscope captured again: the scraper stopped 2026-05-26 and the
  UW `periscope:SPX` websocket channel is not captured (no
  `ws_periscope_snapshots` table on prod). New capture via `uw-stream`,
  own spec.

Revised phases (replace P10b; P12a and P12b come from the D4 decision):

| Phase | Scope |
|---|---|
| P10b′ | Rework 97d7074f/295fa13b: drop every negation; populate writes `source = 'gexbot'`; labels say GEXBot taker-side sign (no MM claim) for gamma, charm, vanna; the script becomes a run-once, resumable **source-tagging** backfill (no value change), same discriminator + fingerprint check. Apply #194 before deploy; after hours |
| P11 | Pause UW-tuned gamma rules on `source = 'gexbot'` data (lottery Periscope detectors, gamma-setup detector, analyze prompt rules), each surfacing a clear "paused: tuned on UW data" note (UI, Axiom `meta`, prompt); no deletion. Review with `analyze-prompt-reviewer`. After hours |
| P11 known gap | `/api/gamma-setups/weekly-stats` and `/api/gamma-setups/export` still mix scraper-era and GEXBot-era fires without flagging them. |
| R1 (research) | GEXBot-specific rules from GEXBot-era history (pre-registered, vendor semantics) |
| S1 (spec) | UW Periscope websocket capture in `uw-stream` → separate table, so UW and GEXBot can be compared live (Railway deploy after the close; handler before `WS_CHANNELS`) |
| P12a (D4) | Sibling pills judged at the alert's fire time. `GET /api/gexbot?view=sibling-confirm&ticker=&side=&at=` (`at` is a zoned ISO datetime, required for this view). `getSiblingConfirmation` reads each sibling's newest `gexbot_snapshots` row at or before `at` and at most `FIRE_TIME_MAX_AGE_SECONDS` = 180 s older, and the verdict is the sign of `net_dex` against the alert's side (zero, null or no row = none; `zgr` is tooltip context only). A row whose vendor `source_timestamp` predates the window is dropped (a NULL one is kept), so VIX's 09:30 prior-close row cannot pose as the fire-time reading. The client fetches once per fire URL (no 30 s polling) and ignores a response for a superseded fire time. No migration |
| P12b (D4) | Velocity tape rebuilt, skew dashboard removed. `GET /api/gexbot?view=velocity` differences the latest snapshot per ticker against the one before it with `LAG`, current ET session only. Deltas are null when there is no prior in the session, when the prior is more than 3 minutes older, when the vendor repeated the prior `source_timestamp`, or when the prior's `source_timestamp` predates the ET session (VIX's 09:30 row carries the prior close). `typicalAbsDAggDex` is the ticker's session median \|Δ`agg_dex`\| over valid minutes. The tape keeps the fixed `GEXBOT_UNDERLYING_ORDER` and highlights per the Thresholds / constants rule. `CrossAssetSkewDashboard` and `deltaRiskReversal` leave the client path; the DB column, the capture cron and the Parquet schema are untouched. No migration |

D5 note (2026-10-28): the daily `/hist/eod` capture is owned by a separate
spec from another session, `2026-10-28-gexbot-eod-capture-design.md` (R2
bucket, all tickers). It is out of scope here; the rest of D5 (persist Classic
`strikes[]`, more live tickers, a true 1-min Δ) stays open for the owner. Prod
migrations are applied by direct SQL against `DATABASE_URL` with a
`schema_migrations` row (id + description), or by the owner via
`POST /api/journal/migrate`.
