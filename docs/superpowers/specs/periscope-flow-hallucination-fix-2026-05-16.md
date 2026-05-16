# Periscope Flow-Hallucination Fix

**Date:** 2026-05-16
**Status:** Draft — awaiting implementation
**Root finding:** Periscope HIGH-confidence reads have been issued on empty flow-context windows with fabricated alert citations. The `confidence` label is partially decoupled from the flow evidence the model claims to be reading.

---

## Goal

Make Periscope's `confidence='high'` calibration faithful to the flow context that's actually present in the prompt. Remove the path by which the model invents flow alerts when the context block is null, and add a structural guard so HIGH cannot be awarded without genuine flow agreement.

## Evidence (from 8-day audit, 2026-05-06 → 2026-05-15)

19 HIGH-confidence intraday reads were audited against the same flow-context window the model receives (`fetchRecentFlowAlerts({ ticker: 'SPXW', windowMinutes: 15, spotProximityPts: 10, topN: 8 })`).

- **3 of 19 (16%) HIGH reads had ZERO alerts in the actual context window:**
  - id 393 — 2026-05-11 13:40 short-only (spot 7419.50)
  - id 438 — 2026-05-12 14:40 fade-only (spot 7398.42)
  - id 556 — 2026-05-15 14:40 short-only (spot 7424.89)
- **id 556 cited three specific put alerts in its FLOW-STRUCTURE check section** that do **not exist** in `flow_alerts` and do **not exist** in `ws_option_trades`:
  - `14:39 PUT 7,420 RepeatedHits ($119K, ask 42%)` — fabricated
  - `14:31 PUT 7,425 RepeatedHitsDescendingFill ($256K)` — fabricated
  - `14:29 PUT 7,425 RepeatedHitsAscending...` — fabricated
- **id 507 — 2026-05-14 13:10 short-only — the only WRONG directional HIGH-conf read** (realized +7.51 against the call) had 4 alerts in window: 2 calls + 2 puts (mixed). Should have stayed MEDIUM.
- **Directional HIGH hit rate:** 7/8 = 87.5%. Real signal, but partly calibrated on fabricated evidence.
- **Avg move in predicted direction:** HIGH long-only +18.3 pts vs MEDIUM long-only +3.6 (5× lift).
- **MEDIUM short-only is a coin flip:** 22 reads, 50% hit, avg move +2.9 (wrong direction). Symptomatic of over-eager bearish calls without flow grounding.

## Phases

Each phase is independently shippable. Phase 4 depends on Phase 1–3 being live.

### Phase 1 — Audit the flow-context → prompt pipeline ✓ COMPLETE (2026-05-16)

**Goal:** confirm whether `buildFlowContextBlock()` returning `null` is communicated to the model, or silently omitted so the model fills the void.

**Files audited:**

- `api/_lib/periscope-flow-context.ts` — the source
- `api/_lib/periscope-chat-runner.ts` — where the block is consumed
- `api/_lib/periscope-prompts.ts` — the prompt assembly

**Phase 1 findings — root cause confirmed:**

The hallucination is a 3-step pipeline failure where each layer is individually defensible but the combination guarantees fabricated citations on empty windows:

1. **`periscope-flow-context.ts` returns `null` silently on empty windows.** For intraday mode (line 93), pre_trade (line 75), and debrief (line 107), the function returns `null` when `fetchRecentFlowAlerts()` / `aggregateFlowAlertsForDay()` come back empty. No sentinel, no "no alerts" marker — just `null`.

2. **`periscope-prompts.ts` `buildUserContent()` (line 155) conditionally appends the block:** `if (flowBlock != null && flowBlock.length > 0) { blocks.push(...) }`. When null, **no flow context is injected into the user content at all.** The model sees the spot directive and heat-map block, then nothing where the flow context would have been.

3. **The system prompt REQUIRES a FLOW-STRUCTURE check regardless.** Line 517 instructs the model: _"REQUIRED prose field. MUST contain the explicit FLOW-STRUCTURE CHECK from your prose narrative verbatim. State whether informed UW flow (from the flow context block) AGREES or CONFLICTS with the structural map, name the strike(s) where the check applies..."_ And line 523 makes "flow agreement" a criterion for HIGH confidence: _"Use high ONLY when you can name a concrete structural fact in confidence_basis (twin-strike +γ + matching charm + flow agreement)."_

The model is given:

- An explicit instruction to write a FLOW-STRUCTURE check section
- An explicit instruction that HIGH confidence requires "flow agreement"
- ZERO flow context to reason from

The model resolves the conflict by **fabricating timestamps, strikes, and rule names** to fill the required section and justify the confidence label. This isn't malicious — it's the LLM following its strongest instruction (produce the required section / use HIGH only with stated agreement) with the resources at hand (its imagination, since no real data was injected).

**Check #3 — other flow sources:** Confirmed none. The `periscope-chat-runner.ts` only calls `buildFlowContextBlock()` for flow data. Other prompt components (synthesis from `periscope_snapshots`, retrieval block, calibration, parent chain, lessons) are non-flow and contain only structural / historical context. There is no second injection path the audit missed.

**Implication for Phase 2:** the fix is exactly the sentinel-injection design originally drafted — inject a literal `NO_ALERTS_IN_WINDOW` block when `flowBlock == null`, so the model has explicit ground to anchor "INSUFFICIENT_DATA" to instead of the void.

**Implication for Phase 3:** the prompt's "REQUIRED FLOW-STRUCTURE CHECK" wording at line 517 is fine; it just needs to add the third state (AGREEMENT / CONFLICTS / **INSUFFICIENT_DATA**) and the literal anti-fabrication rule: _"NEVER cite an alert (timestamp, strike, alert rule, premium) that does not appear verbatim in the supplied [Flow context] block."_

**Implication for Phase 4:** the line 523 HIGH-confidence rubric needs an explicit gate: HIGH is forbidden when FLOW-STRUCTURE == INSUFFICIENT_DATA. Otherwise the model can claim "flow agreement" without a flow block, which is what's been happening.

### Phase 2 — Inject an explicit "no flow context" sentinel

**Goal:** never let the prompt be silent about the absence of flow data.

**Change in `periscope-chat-runner.ts`:**

When `buildFlowContextBlock()` returns `null`, inject this literal block instead:

```text
[Flow context — last 15 min, ±10 pts of spot]
NO_ALERTS_IN_WINDOW

No SPXW informed-flow alerts in the lookback window. Do not cite
specific timestamps, strikes, or alert rules. State explicitly:
"Flow context: insufficient data."
```

**Acceptance test:** add a unit test under `api/__tests__/periscope-flow-context.test.ts` that asserts the sentinel is present when `fetchRecentFlowAlerts()` returns `[]`. Existing tests probably mock `null` returns — update them to expect the sentinel.

### Phase 3 — Tighten the prompt: structured FLOW-STRUCTURE output

**Goal:** forbid free-form alert citations; force a single labelled state.

**Change in `api/_lib/periscope-prompts.ts`:**

Replace the current `FLOW-STRUCTURE check` instruction with a 3-state enum requirement:

- `AGREEMENT` — model must list ≥1 alert from the supplied context block by timestamp + strike + rule (exact match against injected text)
- `DISAGREEMENT` — model must list ≥1 alert from the context that contradicts the structural bias
- `INSUFFICIENT_DATA` — model must declare when (a) the sentinel is present, or (b) supplied alerts are mixed/wash

Add a hard rule: **"NEVER cite an alert (timestamp, strike, alert rule, premium) that does not appear verbatim in the supplied [Flow context] block. If the block contains NO_ALERTS_IN_WINDOW, the only valid FLOW-STRUCTURE state is INSUFFICIENT_DATA."**

**Acceptance test:** existing prompt-snapshot tests (`api/__tests__/periscope-prompts.test.ts`) get updated. Add an LLM-eval-style test: run the prompt with a known empty context and assert the prose contains `INSUFFICIENT_DATA` and does not contain any timestamps in the 09:30–15:00 CT range.

### Phase 4 — Tighten the confidence rubric

**Goal:** make HIGH structurally impossible without genuine flow grounding.

**Change in `periscope-prompts.ts` (the confidence rubric block):**

Replace the current rubric with:

- **High** — `INSUFFICIENT_DATA` is NOT permitted. Requires (a) AGREEMENT with side-dominant flow (≥2:1 by premium), AND (b) twin-strike +γ floor + matching charm sign + intraday chain agreement.
- **Medium** — Default. Mixed flow context allowed. `INSUFFICIENT_DATA` permitted only if structural read is twin-confirmed.
- **Low** — `INSUFFICIENT_DATA` + fragile structure (no nearby +γ floor) OR contradicting orange bars OR cone-breach early in session.

**Acceptance test:** add a backfill SQL check that re-grades the 3 empty-window HIGH reads as MEDIUM under the new rule. They should not pass the confidence='high' filter going forward.

### Phase 5 — Alignment metric as post-hoc validator (deferred)

**Goal:** once Phases 1–4 are live, build the flow-vs-Periscope alignment score from the prior spec idea, but reframed: it audits the model's `FLOW-STRUCTURE` claim against the literal flow data.

**Scope:** separate spec, written after Phase 1–4 ship and we have ≥2 weeks of clean data. Don't pre-emptively design it here — the Phase 1 audit may surface other plumbing issues that change the design.

## Files to create / modify

**Phase 1:** read-only audit; results captured in this spec.

**Phase 2:**

- `api/_lib/periscope-chat-runner.ts` — sentinel injection
- `api/__tests__/periscope-flow-context.test.ts` — assert sentinel present on null

**Phase 3:**

- `api/_lib/periscope-prompts.ts` — FLOW-STRUCTURE enum + citation rule
- `api/__tests__/periscope-prompts.test.ts` — snapshot updates

**Phase 4:**

- `api/_lib/periscope-prompts.ts` — confidence rubric tightening
- One-off SQL check: backfill audit confirming the 3 empty-window HIGH reads would be downgraded

## Data dependencies

None new. All data already in `periscope_analyses`, `flow_alerts`, `ws_option_trades`, `index_candles_1m`.

## Open questions

1. **Does the chat-runner already inject some default text** when `buildFlowContextBlock()` returns `null`? (Answer in Phase 1.) If yes, the fix may be a one-line text change rather than new sentinel logic.
2. **Should we re-grade historical periscope reads** with the new confidence rubric to backfill cleaner training data for the lessons curation cron? Probably yes, but as a separate one-off backfill — not in this spec's scope.
3. **Is `analyze-context.ts` injecting any periscope-adjacent flow data** that this spec misses? Phase 1 audit should clarify.

## Thresholds / constants

- Flow context window: 15 min (already configured)
- Flow context proximity: ±10 pts (already configured)
- Side-dominance threshold for HIGH confidence: **≥2:1 by premium** within the context block
- Sentinel text: `NO_ALERTS_IN_WINDOW` (literal — to make it greppable in logs)

## Acceptance criteria (overall)

- A periscope read with an empty flow window cannot be issued at HIGH confidence.
- A periscope read's prose cannot contain timestamp citations for alerts that don't appear in the injected context block. Verify by sampling 5 fresh reads post-deploy: every cited timestamp must match a row in `flow_alerts` for that day, in the read's flow-context window.
- Re-audit of the 19 historical HIGH reads under the new rubric: 3 (and probably the mixed-flow id 507) should downgrade to MEDIUM. Hit-rate on remaining HIGH set should hold or improve vs. the 75% baseline.
