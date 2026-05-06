# Periscope Chat Overhaul — 3-Mode Lifecycle, Heat-Map OCR, VolSignals Heuristics

**Status:** Spec — ready to build
**Author / owner:** Charles
**Date:** 2026-05-05
**Parent specs:**

- `docs/superpowers/specs/periscope-chat-2026-04-30.md` (original component design)
- `docs/superpowers/specs/strike-battle-map-2026-05-03.md` (sibling — defines `ws_gex_strike_expiry`)
- `docs/superpowers/specs/uw-websocket-daemon-2026-05-02.md` (sibling — defines `ws_flow_alerts`)

**Code-review prerequisite:** ✅ DONE (2026-05-05). 3 read-only review subagents on the 7 periscope files + cross-cutting integration audits. ~30 quality findings, no Critical security issues. Findings folded into the relevant phases below.

## Goal

Upgrade `/api/periscope-chat` from a 2-mode (`read | debrief`) image-OCR-only analyzer into a 3-mode lifecycle (**pre-trade / intraday / debrief**) that mirrors the chart-analysis component's daily cadence: one pre-trade read at/before the open, as many intraday checkpoints as the trader runs (matching Periscope's 10-min slice cadence), and one end-of-day debrief. The output goes from a free-form prose read with thin structured fields to a **structured trading playbook** (regime, bias, key levels, trade types to take vs. avoid, confidence) the model can actually act on. Authoritative SPX spot at read time comes from the `index_candles_1m` table (no more "latest-bar = current price" assumption); per-strike MM-attributed GEX/charm comes from a new Pass 1B vision OCR of the heat maps; informed-flow context comes from `ws_flow_alerts`. The `periscope` skill itself gets distilled VolSignals MM-mechanics heuristics layered in as a separate cached references file.

End state: user picks `(date, time)` in the UI and uploads 1–3 Periscope screenshots; the backend looks up SPX at that timestamp, OCRs spot/cone/heat-maps via Pass 1, queries `ws_flow_alerts` and (pre-trade only) `greek_exposure_strike` for context, runs Pass 2 with the upgraded skill + references + calibration + retrieval, and returns a structured playbook persisted with embedding for ML similarity over chained-read trajectories.

## Non-goals

- **No new live data ingestion.** The websocket daemon already populates `ws_*` tables; we only consume.
- **No frontend rebuild.** UI changes are minimal — date/time picker, mode selector update from 2→3 values, structured playbook rendering. Otherwise unchanged.
- **No Path 1 (UW MM-attributed WebSocket channel).** Confirmed not available; we OCR the heat maps.
- **No Path 3 (locally-computed MM attribution from ask/bid_vol columns).** Will diverge from UW's heat-map values; explicitly rejected.
- **No naive GEX in the read prompt.** `ws_gex_strike_expiry` is naive — useful for other features but not in this read. Reserved for future enhancement.
- **No retroactive migration of existing `periscope_analyses` rows.** User-approved drop-and-rebuild.
- **No automated VolSignals re-distillation pipeline.** One-shot manual transcript ingestion in Phase 4. Future videos get added one-off as the user supplies them.

## Locked decisions (from scoping conversation 2026-05-05)

| Setting                                           | Value                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modes                                             | `pre_trade` / `intraday` / `debrief` (replaces `read` / `debrief`)                                                                                                         |
| Existing-rows policy                              | DROP TABLE periscope_analyses CASCADE; rebuild from clean                                                                                                                  |
| Parent linkage                                    | Chain — first intraday → pre_trade; each subsequent intraday → previous intraday; debrief → last intraday                                                                  |
| SPX spot at read time                             | DB lookup against `index_candles_1m` (1-min granularity, market hours, Schwab-anchored)                                                                                    |
| Time-matching tolerance                           | ±2 min                                                                                                                                                                     |
| Live read with no candle in tolerance             | Hard-fail with explicit error                                                                                                                                              |
| Back-read with no candle in tolerance             | Snap to nearest within ±2 min, log warning                                                                                                                                 |
| Back-read with no data for date at all            | Hard-fail                                                                                                                                                                  |
| Cone (lower/upper bounds)                         | OCR — uses both visual cues (diverging triangle on price-action panel + horizontal labeled lines on heat-map panels)                                                       |
| Per-strike MM-attributed GEX/charm                | OCR via Pass 1B vision call (~$0.05–0.10 per submission, ~$2.50–5.00/day at 50 reads)                                                                                      |
| Naive GEX (`ws_gex_strike_expiry`) in read prompt | NO — explicitly excluded                                                                                                                                                   |
| `ws_flow_alerts` integration                      | YES — Phase 1.5, mode-specific queries (proximity to spot + recency window varies by mode)                                                                                 |
| `greek_exposure_strike` morning snapshot          | YES — pre_trade mode only (read prompt; not intraday/debrief)                                                                                                              |
| Skill restructure                                 | Move non-load-bearing content (capture conventions, "How to apply this skill", second worked example) to `references/`; tighten SKILL.md to load-bearing read-time content |
| TRACE residue cleanup                             | All references deleted (TRACE was removed in commit `d8371347`)                                                                                                            |
| VolSignals distillation source                    | 21 transcripts already in `docs/tmp/transcripts/` (1.md – 21.md)                                                                                                           |
| VolSignals output target                          | `.claude/skills/periscope/references/vol-signals-mm-heuristics.md` (placeholder already created 2026-05-05)                                                                |
| Skill references shipping                         | `.claude/skills/**/*.md` glob in `vercel.json` includeFiles (already updated 2026-05-05)                                                                                   |
| Code-review fixes                                 | Folded into the relevant phases — no separate cleanup phase                                                                                                                |
| Output schema expansion                           | `bias`, `trade_types_recommended`, `trade_types_avoided`, `key_levels`, `expected_dealer_behavior`, `confidence`, `parse_ok` (in addition to existing fields)              |

## Architecture overview

### 3-mode lifecycle

```text
8:30 CT — pre_trade read (1/day)
  ┌─────────────────────────────────────────────────┐
  │ Inputs:                                          │
  │   chart screenshot (required)                    │
  │   gex/charm heat-map screenshots (optional —     │
  │     can be deferred to first intraday read)      │
  │   read_date, read_time (defaults to "now,        │
  │     rounded down to 10-min")                     │
  │ Context fetched:                                 │
  │   index_candles_1m → SPX spot                    │
  │   greek_exposure_strike (8:30 morning snapshot)  │
  │   ws_flow_alerts (last 30 min, ±20 pts of spot)  │
  │ Output: full day playbook                        │
  │ Parent linkage: NONE                             │
  └─────────────────────────────────────────────────┘
                       │
                       ↓
~10:00 CT — intraday read 1
  ┌─────────────────────────────────────────────────┐
  │ Inputs: all 3 screenshots required               │
  │ Context fetched:                                 │
  │   index_candles_1m → SPX spot                    │
  │   ws_flow_alerts (last 15 min, ±10 pts)          │
  │ Output: thesis-maintenance read                  │
  │ Parent: today's pre_trade                        │
  └─────────────────────────────────────────────────┘
                       │
                       ↓
~12:30 CT — intraday read 2  (parent: intraday 1)
~14:00 CT — intraday read 3  (parent: intraday 2)
                       │
                       ↓
After close — debrief (1/day)
  ┌─────────────────────────────────────────────────┐
  │ Inputs: end-of-day chart, no heat maps needed    │
  │ Context fetched:                                 │
  │   index_candles_1m → final SPX close             │
  │   ws_flow_alerts (full day, hourly buckets)      │
  │ Output: scoring + lessons                        │
  │ Parent: last intraday (or pre_trade if none)     │
  └─────────────────────────────────────────────────┘
```

### Two-pass Anthropic call (extended)

Pass 1A (existing — refactored): vision-only Opus 4.7 → spot, cone_lower, cone_upper, chart_date.

**Pass 1B (new):** vision-only Opus 4.7 → top-N positive/negative strikes per metric (gamma, charm) from the GEX and Charm heat maps. Skipped for `pre_trade` mode if heat maps not provided (use `greek_exposure_strike` morning snapshot instead).

Pass 2 (existing — extended): full Opus 4.7 with high-effort thinking, system prompt = `[skill, references (NEW), calibration, retrieval]` (4 cache breakpoints), user content = `[mode preamble, structured context block (NEW: spot from DB, ws_flow_alerts, heat-map values), 3 image blocks]`, output = prose + expanded JSON block.

## Phases

### Phase 1 — Refactor + Pass 1B vision call

**Scope:** Pre-Pass-1B refactor (shared parser, single client), then add Pass 1B for heat-map per-strike OCR.

#### Phase 1A: Refactor prerequisites (from code-review findings)

Files:

- `api/_lib/json-fence.ts` (NEW) — extract `parseTrailingJsonBlock(text: string): { body: string; before: string; after: string } | null` from the duplicated `lastIndexOf` walks in `periscope-prompts.ts:153-228` and `periscope-extract.ts:170-200`. ReDoS-safe O(n).
- `api/_lib/periscope-prompts.ts` (modify) — replace `parseStructuredFields` body with the shared helper + typed coercion.
- `api/_lib/periscope-extract.ts` (modify) — same; remove module-level `new Anthropic(...)`; accept client as parameter.
- `api/periscope-chat.ts` (modify) — pass single `anthropic` client into `extractChartStructure`.
- `api/__tests__/json-fence.test.ts` (NEW) — unit tests for the shared parser. Round-trip cases: well-formed, missing close fence, missing open fence, two blocks (last wins), JSON snippet earlier in prose.
- `api/__tests__/periscope-prompts.test.ts` (modify) — replace duplicate parse-tests with delegating tests.

#### Phase 1B: Heat-map vision OCR

Files:

- `api/_lib/periscope-extract.ts` (modify) — add `extractHeatMapStrikes(args)` function. Accepts `gex` and/or `charm` images; returns `{ gex: HeatMapStrike[]; charm: HeatMapStrike[] }`. Each `HeatMapStrike = { strike: number; value: number; color: 'green' | 'red' }`. Top 5 positive + top 5 negative per metric. Skipped for `pre_trade` mode when heat maps not uploaded.
- `api/_lib/periscope-extract.ts` (modify) — extraction prompt for heat maps. New `EXTRACTION_HEATMAP_SYSTEM_PROMPT` instructs the model to read each heat-map's strike-and-value pairs from the labeled cells; explicitly notes that the values shown are UW's MM-attributed Net GEX / Net Charm (not naive).
- `api/periscope-chat.ts` (modify) — orchestrate Pass 1A + Pass 1B as one `Promise.all` (both vision-only, independent). Inject results as a `Heat-map structured values` text block in user content of Pass 2.

**Cone OCR enhancement (folded in):** update `EXTRACTION_SYSTEM_PROMPT` (`periscope-extract.ts:45-69`) to instruct the model that cone bounds are visible in TWO places — the diverging triangular dashed lines over the price-action panel AND the horizontal labeled dashed lines on the heat-map panels (e.g. `7,266.66` upper / `7,218.46` lower). Use the labeled horizontal lines when available; fall back to the price-action triangle. Cross-check should match.

**Verification:** `npm run review` passes. Manual test: upload sample chart + heat maps from `docs/tmp/transcripts/` era, confirm Pass 1B extracts top strikes per panel that match the visible labels. Cost test: log token counts on both extraction calls; confirm ~$0.05–0.10 per Pass 1B call.

### Phase 1.5 — `ws_flow_alerts` integration

**Scope:** Per-mode flow-alert context block injected into Pass 2 user content.

Files:

- `api/_lib/periscope-flow-context.ts` (NEW) — `buildFlowContextBlock(args: { mode, readTime, spot, ticker })`. Returns formatted text block summarizing recent SPXW flow alerts. Mode-specific:
  - `pre_trade`: last 30 min of alerts, strikes within ±20 pts of spot, top 8 by created_at DESC. Frame as "informed flow placed near spot pre-open."
  - `intraday`: last 15 min, ±10 pts, top 8. Frame as "fresh flow being placed near current spot."
  - `debrief`: full-day aggregation — count of bullish vs bearish (via `ws_flow_alerts_enriched.option_type` + side), bucketed by trading hour.
- `api/_lib/db-flow-alerts.ts` (NEW or extend) — `fetchRecentFlowAlerts(args)` query helper. Uses existing `ws_flow_alerts_chain_created_idx` index.
- `api/periscope-chat.ts` (modify) — invoke `buildFlowContextBlock` on every read; append to user content text block.
- `api/__tests__/periscope-flow-context.test.ts` (NEW) — unit tests for each mode's window/proximity logic + format.

**Verification:** `npm run review` passes. Manual test: run a pre_trade read at 8:35 CT, confirm flow alerts in user content. Inspect cache breakpoint placement — flow context is dynamic, must be in user content (NOT inside cached system blocks).

### Phase 2 — Expanded structured output schema

**Scope:** Schema expansion for "today's playbook" output. Drives both DB columns and frontend rendering.

New JSON-block fields (in addition to existing):

```jsonc
{
  "spot": 7259.23,                  // existing
  "cone_lower": 7218.46,            // existing
  "cone_upper": 7266.66,            // existing
  "long_trigger": 7270,             // existing
  "short_trigger": 7245,            // existing
  "regime_tag": "long-gamma-pin",   // existing
  "bias": "fade-only" | "long-only" | "short-only" | "two-sided" | "no-trade",  // NEW
  "trade_types_recommended": ["debit_call_spread", "iron_condor"],               // NEW (enum array)
  "trade_types_avoided": ["naked_directional_long"],                             // NEW
  "key_levels": {                                                                // NEW
    "gamma_floor": 7250,
    "gamma_ceiling": 7275,
    "magnet": 7260,
    "charm_zero": 7265
  },
  "expected_dealer_behavior": "passive bid below 7250, passive offer above 7275 — range-bound until either side breaks", // NEW
  "confidence": "low" | "medium" | "high",                                       // NEW
  "confidence_basis": "twin-strike +γ floor at 7250+7255 confirmed by morning ws_flow_alerts buys",  // NEW (required when confidence != null)
  "parse_ok": true                                                               // NEW (set by parser, not the model)
}
```

Files:

- `.claude/skills/periscope/SKILL.md` (modify — folded into Phase 3) — update "Required: structured fields JSON block" section with the new schema.
- `api/_lib/periscope-prompts.ts` (modify) — extend `parseStructuredFields` to coerce new fields; null on parse failure; surface `parse_ok` boolean to caller.
- `api/_lib/periscope-db.ts` (modify) — extend `PeriscopeStructuredFields` type + `savePeriscopeAnalysis` to persist new columns.
- `api/_lib/db-migrations.ts` (modify) — folded into Phase 6's drop-rebuild migration; new schema includes the new columns.
- `api/_lib/validation.ts` (modify) — add Zod schemas for the new enum fields.
- `src/components/PeriscopeChat/types.ts` (modify) — extend frontend types to render new fields.
- `src/components/PeriscopeChat/...` (modify) — playbook rendering. UI scope: minimal — table-or-card display of the new fields, badge for `bias`, list of recommended/avoided trade types, key-levels subgrid.
- `api/__tests__/periscope-prompts.test.ts` (modify) — round-trip test cases covering all new fields + missing-field defaults + malformed JSON.

**Verification:** `npm run review` passes. Frontend: run a sample read, confirm playbook renders. Backend: insert + select round-trip persists all new columns.

### Phase 3 — SKILL.md restructure

**Scope:** Tighten the periscope skill to be load-bearing for every read; move meta-content to references; remove TRACE residue; adapt for 3-mode workflow.

Files:

- `.claude/skills/periscope/SKILL.md` (modify) — restructure:
  - DELETE: "Periscope vs. SpotGamma TRACE — the hierarchy" section (TRACE removed)
  - DELETE: scattered TRACE mentions in framing prose
  - MOVE to `references/capture-conventions.md`: the "Capture conventions (if user is studying / building features)" section (line 382+)
  - MOVE to `references/applying-skill.md`: "How to apply this skill" section (line 419+)
  - MOVE to `references/worked-example-2026-04-29-trap-day.md`: second worked example (line 331+). KEEP the 2026-04-30 morning open as the in-skill exemplar — one is enough to show the format.
  - REPLACE: "No-cheat read protocol" — adapt to 3-mode framing (pre_trade has no prior intraday context to no-cheat against; intraday must respect prior intraday reads in the chain; debrief is hindsight-allowed).
  - REPLACE: "How to read the panels together" — assume Pass 1B has injected exact heat-map values; lean into structured numbers, not visual estimation as the primary path.
  - REPLACE: "Time-of-day weighting" — fold into mode-specific guidance per the lifecycle diagram.
  - ADD: "Structured trading playbook output" — new section pinning the expanded JSON schema with field-by-field semantics.
  - UPDATE: "Required: structured fields JSON block at end of response" — full new schema (matches Phase 2).
- `.claude/skills/periscope/references/capture-conventions.md` (NEW)
- `.claude/skills/periscope/references/applying-skill.md` (NEW)
- `.claude/skills/periscope/references/worked-example-2026-04-29-trap-day.md` (NEW)

Target SKILL.md size after restructure: ~280–320 lines (down from 463).

**Verification:** `npm run review` passes. Manual: re-run a sample read against the new SKILL.md; confirm output format matches the new schema and no TRACE references appear.

### Phase 4 — VolSignals distillation

**Scope:** Read all 21 transcripts in `docs/tmp/transcripts/`, distill durable MM-mechanics heuristics into the existing placeholder at `.claude/skills/periscope/references/vol-signals-mm-heuristics.md`.

Approach: parallel subagent batches (4 transcripts per agent, 5–6 agents in flight) → each returns extracted heuristics by section + verification tag. Main session merges + dedupes.

Per-heuristic contract (already defined in placeholder):

- Tag: `[verified]` / `[plausible]` / `[era-specific]` / `[contested]`
- Citation: source-video index entry
- Specific & falsifiable (e.g. _"after 2pm CT, charm flow accelerates ~2x"_) — reject vague generalities
- Mapped to one of the 7 sections in the placeholder

**Anti-pattern guard (per placeholder workflow):** if a heuristic conflicts with `SKILL.md`, flag as `[contested]` and surface to user — do NOT silently overwrite skill content.

Files:

- `.claude/skills/periscope/references/vol-signals-mm-heuristics.md` (modify — placeholder → populated)
- (If a heuristic earns `[contested]`) — surface to user; possibly fold into SKILL.md update separately

**Verification:** Final file is ~30–60 distilled heuristics with verification tags and source-video index complete. After population, audit: which heuristics actually made it into a periscope read in the next 7 days? Drop dead weight at first audit. (Audit is post-ship, not blocker.)

### Phase 5 — Wire references into `periscope-chat.ts`

**Scope:** Load the references file as a separate cached system block.

Files:

- `api/periscope-chat.ts` (modify) — read both `SKILL.md` and `references/vol-signals-mm-heuristics.md` at module init. Append references as a second cached system block (between skill and calibration). 4 breakpoints already supported.
- `api/__tests__/periscope-chat.test.ts` (NEW or extend) — assert both files load + cache hit on second call.

**Cache strategy:** references file is stable across days; invalidates only when distillation gets updated. Same `ttl: '1h'` ephemeral as skill. The order matters: `[skill, references, calibration, retrieval]` keeps the highest-stability content first.

**Verification:** `npm run review` passes. Inspect `cache_read_input_tokens` on second call: should reflect both files cached.

### Phase 6 — 3-mode architecture + DB rebuild + time-matching

**Scope:** The biggest phase. DB schema rebuild, mode prompts, parent-chain logic, time-matching DB lookup, frontend mode selector update.

#### Phase 6A: DB rebuild migration

Files:

- `api/_lib/db-migrations.ts` (modify) — append new migration (next id, ~129) that:
  - `DROP TABLE IF EXISTS periscope_analyses CASCADE` (no FK consumers per Phase 0 audit — only self-reference via `parent_id`)
  - `CREATE TABLE periscope_analyses` with new schema:
    - `mode` CHECK constraint expanded to `IN ('pre_trade', 'intraday', 'debrief')`
    - `parent_id` BIGINT REFERENCES periscope_analyses(id) ON DELETE SET NULL (was missing in v1)
    - All Phase 2 new columns (`bias`, `trade_types_recommended`, `trade_types_avoided`, `key_levels`, `expected_dealer_behavior`, `confidence`, `confidence_basis`, `parse_ok`)
    - `read_time` TIMESTAMPTZ NOT NULL — the user-selected time the read is _for_ (distinct from `created_at` = capture time)
    - `spot_at_read_time` NUMERIC NOT NULL — DB-looked-up SPX spot at read_time
    - `spot_source` TEXT CHECK IN ('db_exact', 'db_snapped') — audit which path produced the spot
  - Indexes:
    - `idx_periscope_analyses_mode_calibration` on `(mode, calibration_quality)` — pre-filter for retrieval HNSW (per Phase 0 finding)
    - `idx_periscope_analyses_parent_chain` on `(parent_id)` — chain traversal
    - `idx_periscope_analyses_calibration_quality` partial on `(calibration_quality DESC, created_at DESC) WHERE calibration_quality IS NOT NULL`
    - HNSW on `analysis_embedding` (carry forward from existing)
- `api/__tests__/db.test.ts` (modify) — add `{id: N}` to applied-migrations mock; update SQL call counts; add the migration to expected-output list.

#### Phase 6B: Time-matching DB lookup

Files:

- `api/_lib/spx-candles.ts` (modify) — add `fetchSPXSpotAtTimestamp(args: { date, time, tolerance }): Promise<{ price, source: 'db_exact' | 'db_snapped' } | null>`. Query `index_candles_1m` for exact `(date, timestamp)`; on miss, scan ±tolerance (default 2 min) for nearest. Reject pre/post-market candles (`market_time != 'r'`).
- `api/_lib/validation.ts` (modify) — extend `periscopeChatBodySchema` with `read_date` (ISO date) and `read_time` (HH:MM CT, 10-min boundary preferred).
- `api/periscope-chat.ts` (modify) — early in handler: look up SPX spot via `fetchSPXSpotAtTimestamp`. On miss in live mode (today's date), hard-fail with explicit error response. On miss in back-read mode (older date), snap with logged warning. On no-data-for-date, hard-fail.
- `src/components/PeriscopeChat/...` (modify) — add date + time pickers (10-min granularity); default to "now floor 10-min" for live, freely editable for back-reads.

#### Phase 6C: Mode-specific prompts + parent chain

Files:

- `api/_lib/periscope-prompts.ts` (modify) — replace `mode === 'read' ? buildReadModeBody() : buildDebriefModeBody()` with exhaustive `switch(mode)` + `never` check. Add `buildPreTradeModeBody()`, rename + adapt `buildReadModeBody()` → `buildIntradayModeBody()`, keep `buildDebriefModeBody()`.
- `api/_lib/periscope-prompts.ts` (modify) — `buildUserContent` switches on mode; user content includes the structured context block (spot from DB, ws_flow_alerts, heat-map values, plus parent-chain summary for intraday/debrief).
- `api/_lib/periscope-db.ts` (modify) — add `fetchParentChain(parentId): Promise<ParentChainRow[]>` using `WITH RECURSIVE` walk. Returns oldest-first chain from root pre_trade → ... → immediate parent.
- `api/periscope-chat.ts` (modify) — for `intraday` and `debrief`, fetch parent chain and inject summary into user content.

#### Phase 6D: Embedding + retrieval cleanup (folded from Phase 0 findings)

Files:

- `api/_lib/periscope-db.ts` (modify) — `buildPeriscopeSummary`: REMOVE `date=${tradingDate}` from embedded text (lets cosine reflect topology, not calendar). Add `mode` token (since we now have 3 distinct modes; embedding by mode helps cluster correctly).
- `api/_lib/periscope-retrieval.ts` (modify) — rewrite cosine query with `WITH q AS (SELECT ${vectorLiteral}::vector AS v)` to bind embedding once, not twice (per Phase 0 finding). Add `logger.info({ similarities })` to surface tuning data.
- `api/_lib/periscope-calibration.ts` (modify) — scope by 3-value mode; document `EXAMPLE_PROSE_CHARS × TOP_N` token cap.

#### Phase 6E: Code-review fixes (folded from Phase 0)

Files:

- `api/periscope-chat.ts` (modify) — fix keepalive `setInterval` ordering: `clearInterval` BEFORE writing final frame; only `res.end()` in finally.
- `api/periscope-chat.ts` (modify) — split the `Promise.all([buildEmbedding, uploadImages])` into independent best-effort try/catches. Blob failure must not lose the row.
- `api/periscope-chat-image.ts` (modify) — add `periscopeChatImageQuerySchema` to `validation.ts`; replace ad-hoc regex validation with `respondIfInvalid`.
- `api/_lib/periscope-blob.ts` (modify) — drop `addRandomSuffix: true` (defeats deterministic path lookup); use UUIDv7 in path instead so dashboard reads can find blobs by id.

**Verification (Phase 6 as a whole):** `npm run review` passes. Run sample reads in each mode; verify mode-specific prompt + parent chain injection + DB-spot lookup with both live and back-read time selections. Insert + select round-trip on the new schema. Cache stability test: assert `cacheRead > 0` on second call across all 4 system blocks.

## Data dependencies

### Existing tables consumed (no new)

| Table                   | Purpose                               | Cron / source                                                 |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `index_candles_1m`      | SPX spot at read time                 | `fetch-spx-candles-1m` cron, every minute during market hours |
| `ws_flow_alerts`        | Recent informed flow context          | uw-stream daemon (live websocket)                             |
| `greek_exposure_strike` | Pre-trade morning per-strike snapshot | `fetch-greek-exposure-strike` cron, 8:30 CT daily             |

### New tables / migrations

- One new migration (DROP CASCADE + CREATE periscope_analyses with new schema). Phase 6A.

### Env vars

- No new env vars. All existing infra (DATABASE_URL, KV_REST, ANTHROPIC_API_KEY, OPENAI_API_KEY, BLOB_READ_WRITE_TOKEN) suffices.

### External dependencies

- No new package installs.

## Open questions

| Question                                                                                                                            | Default if not decided                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Should pre_trade mode require chart+heat-maps OR allow chart-only with `greek_exposure_strike` as fallback?                         | Allow chart-only — frontend makes heat-map upload optional for pre_trade only. Heat maps still preferred when available. |
| If `greek_exposure_strike` cron hasn't run yet for today (8:30 CT scrape lag), does pre_trade fall back to OCR?                     | Hard-fail with clear error: "morning greek snapshot not yet available, retry after 8:32 CT"                              |
| Cone OCR cross-check — what tolerance defines a "match" between price-action triangle and heat-map horizontal lines?                | ±0.5 pts; outside that, prefer the heat-map labeled value (typed text > visual triangle)                                 |
| Should debrief mode's flow-alert summary use `ws_flow_alerts_enriched` view or raw table?                                           | View — already does the call/put + bullish/bearish enrichment                                                            |
| Phase 4 distillation: do we wait for all 21 to be done before Phase 5 wires the file in, or wire after first 5 batches and iterate? | Wire after Phase 4 fully done — partial heuristics file would create a partial picture and regress reads                 |
| Phase 6A migration: should `read_time` be the source of truth for "trading_date" derivation, or keep both columns?                  | Both — `trading_date` (date-only) for indexing/filtering, `read_time` (full TIMESTAMPTZ) for chain ordering              |

## Thresholds / constants

| Constant                                | Value                                                        | Where                                            |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| Time-matching tolerance                 | ±2 min                                                       | `fetchSPXSpotAtTimestamp`                        |
| Pre-trade flow window                   | last 30 min, ±20 pts of spot, top 8 alerts                   | `buildFlowContextBlock`                          |
| Intraday flow window                    | last 15 min, ±10 pts of spot, top 8 alerts                   | `buildFlowContextBlock`                          |
| Debrief flow aggregation                | full session, hourly buckets                                 | `buildFlowContextBlock`                          |
| Pass 1B heat-map top-N                  | 5 positive + 5 negative per metric                           | `extractHeatMapStrikes`                          |
| Calibration block soft cap              | `EXAMPLE_PROSE_CHARS=1500 × TOP_N=3` ≈ 1.1K tokens           | `periscope-calibration.ts`                       |
| Retrieval similarity floor              | 0.30 cosine                                                  | `periscope-retrieval.ts` (now logged for tuning) |
| Retrieval top-K                         | 3                                                            | `periscope-retrieval.ts`                         |
| Pass 1A timeout                         | 120 s                                                        | `periscope-extract.ts` (existing)                |
| Pass 1B timeout                         | 120 s                                                        | `periscope-extract.ts` (new)                     |
| Pass 2 timeout                          | 720 s (60 s slack under function 780 s)                      | `periscope-chat.ts` (existing)                   |
| Cache TTL                               | 1 h ephemeral, all system blocks                             | `periscope-chat.ts`                              |
| VolSignals heuristic cap (post-distill) | ~30–60 entries; audit + drop dead weight after 7 days of use | `references/vol-signals-mm-heuristics.md`        |

## Verification plan

### Per-phase verification

Each phase ends with `npm run review` (tsc + eslint + prettier + vitest --coverage). No phase merges if review is red.

### End-to-end smoke tests

1. **Pre-trade live read**: pick "today, 08:30 CT," upload chart only, confirm playbook produced with morning `greek_exposure_strike` numbers in user content.
2. **Pre-trade with heat maps**: same as #1 but with heat-map uploads; confirm Pass 1B values appear in user content alongside DB values; reads should not contradict.
3. **Intraday live read with parent chain**: after #1, run intraday at 10:00 CT; confirm parent_id auto-links to today's pre_trade; chain summary appears in user content.
4. **Intraday with explicit time**: pick 12:30 CT for a back-read on a recent date; confirm DB spot lookup, snapped if necessary.
5. **Debrief**: after 4 PM, run debrief; confirm chain walks pre_trade → intraday1 → intraday2 → ...; flow-alert hourly buckets in user content.
6. **Live read with no DB candle**: simulate by querying for a future timestamp; confirm hard-fail error response shape.
7. **Back-read with no data for date**: pick a date pre-cron-history; confirm hard-fail.
8. **Parse failure path**: force the model to omit JSON block (test prompt); confirm `parse_ok=false`, structured fields all null, row still saves.
9. **Cache hit**: run two reads back-to-back (same skill version, same gold-star library); confirm `cacheRead > 0` on call 2 across all blocks.

### Cost regression test

Run 10 simulated submissions; confirm Pass 1A + Pass 1B + Pass 2 token costs land in the budgeted range (target ≤ $0.60/submission).

### Rollback plan

- Phase 6A migration is additive (new id, no DROP of OTHER tables); previous component continued running on old schema until cutover. **Cutover = redeploy `periscope-chat.ts` referencing new schema.** Rollback = redeploy previous git SHA + `DROP TABLE periscope_analyses; CREATE TABLE periscope_analyses (old schema)`.
- All other phases are additive or modify-in-place; rollback = revert commit.

## Out of scope (future enhancements)

- Naive GEX from `ws_gex_strike_expiry` as a complementary signal layer (rejected for v1, reserved)
- Locally-computed MM attribution from ask/bid_vol columns (rejected — would diverge from heat maps)
- UW WebSocket channel for MM-attributed per-strike (doesn't exist today; revisit if added)
- Cone bounds from a structured source (today: OCR; future: parse from `ws_option_trades` ATM straddle quote if reliable)
- Multi-index support (NDX, RUT) — table already has `symbol` column; not specced in this round
- ML similarity over chained-read trajectories — schema supports it (parent_id + embedding); model layer is future work

## File-creation summary

**NEW files:**

- `api/_lib/json-fence.ts`
- `api/_lib/periscope-flow-context.ts`
- `api/_lib/db-flow-alerts.ts` (or extension to existing)
- `api/__tests__/json-fence.test.ts`
- `api/__tests__/periscope-flow-context.test.ts`
- `api/__tests__/periscope-chat.test.ts` (cache-stability)
- `.claude/skills/periscope/references/capture-conventions.md`
- `.claude/skills/periscope/references/applying-skill.md`
- `.claude/skills/periscope/references/worked-example-2026-04-29-trap-day.md`

**MODIFIED files:**

- `.claude/skills/periscope/SKILL.md`
- `.claude/skills/periscope/references/vol-signals-mm-heuristics.md` (placeholder → populated)
- `api/periscope-chat.ts`
- `api/periscope-chat-image.ts`
- `api/_lib/periscope-prompts.ts`
- `api/_lib/periscope-extract.ts`
- `api/_lib/periscope-db.ts`
- `api/_lib/periscope-blob.ts`
- `api/_lib/periscope-retrieval.ts`
- `api/_lib/periscope-calibration.ts`
- `api/_lib/spx-candles.ts`
- `api/_lib/validation.ts`
- `api/_lib/db-migrations.ts`
- `api/__tests__/db.test.ts`
- `api/__tests__/periscope-prompts.test.ts`
- `src/components/PeriscopeChat/types.ts`
- `src/components/PeriscopeChat/...` (UI components for date/time picker + playbook rendering)

**Total: ~9 new + ~17 modified = 26 files touched across 7 phases.**
