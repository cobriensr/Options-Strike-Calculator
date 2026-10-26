# Review remediation (2026-10-26)

## Goal

Check every finding in the 2026-10-25 end-to-end review against the code, fix the ones that hold up, and record why the rest were not fixed, so the repo is accurate and defensible when it's shown to reviewers.

## Source and method

- **The review** is the owner's local copy. It isn't committed because it includes personal notes. It has 20 action items and about 40 findings in its body.
- **Verification (2026-10-26).** Nine read-only agents checked each claim against HEAD `1a73e2c0`. For math claims they ran the real modules, not just read them. Seven later commits (coverage floors, Take-It scorer hardening, the E2E repair start) touched none of these items.
  - The review's line numbers were mostly right. Where they drifted, the ledger gives the current ones.
- **Security findings live in a local, untracked note** (`docs/tmp/review-remediation-security-2026-10-26.md`), because the repo is public. They appear below only as Track S, by ID, and move into this doc once fixed.

## What the review got wrong or overstated

| Review claim | What's actually true |
|---|---|
| BWB max loss is *under*-reported by $250 | Put side **over**states by $250/ct and call side understates by $250/ct, on the 4 off-grid combos. `snapToIncrement` rounds .5 up. Breakevens are correct. |
| Fix hedge stress by multiplying by 100 | ×100 hits the 3× cap from a 0.5% move. The documented numbers come out of an *additive* shift, σ + 4·\|move\|. |
| CSP hash drift silently breaks PWA registration | The build emits **zero** inline scripts, so the two hashes protect nothing. Registration ships in the bundle. |
| `enable_external_access=false` is a one-line DuckDB fix | As written it blocks reading the archive's own Parquet files. The working form uses `allowed_directories`. |
| `fetch-spot-gex` shows the fix; `bulkUpsert` has 11 callers | `fetch-spot-gex` still writes one row per await. `bulkUpsert` has 2 callers. |
| 10k uw-stream queue drops after ~92 s | The router never blocks, so the 10k queue doesn't fill. Each handler's own 50k drop-oldest queue does. 92 s is how long one flush blocks, not when drops start. |
| Two front-month rules feed `futures_bars` | Both live writers share the UTC-day rule. The sidecar rule only reads the frozen archive. The real defect: the UTC tally resets 1–2 h into the CME session. |
| Anthropic 720 s × 3 retries can exceed the budget | The SDK timeout covers only the time to response headers. The real gap is that the streamed body and the Opus→Sonnet fallback are unbounded against 780 s. |
| ~215 MB of nightly PNGs, ~GB/year growth | The ML Pipeline workflow has been `disabled_manually` since 2026-04-16 and its plot-commit step has never run. 87% of `ml/plots` is one hand-made research dump (`eod-flow-bursts/`). Blob keys overwrite, so git is the *only* plot history. |
| `ml/requirements.txt` is unpinned | 32 of 45 lines are `==`. The real problems are a duplicate `joblib`, 5 orphan packages, dev deps mixed in, and secrets in scope during `pip install`. |
| `phase2_early` predicts the recommender from the same snapshot | It predicts the *after-close* review, which is written with settlement in hindsight, and it keeps the days Claude got wrong. |
| GitHub description names Databento | It names "Unusual Whales, GexBot and ThetaData". GexBot is live; ThetaData is stale. |
| 18 hand-rolled readers should use `withDbReader` | 9 fit CLAUDE.md's criteria. The rest are mixed GET+write, CSV, binary, ungated, or deliberately different. |

## Ledger (non-security)

V = verdict: **C** confirmed · **P** partly true · **F** false · **N** new (found during verification).

### Domain math

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| M1 | BWB max loss / RoR use unsnapped wide width | C | 15×1.5, 15×2.5, 25×1.5, 25×2.5 only. Wrong in `BWBPnLProfileTable`, the `BWBSection` header and `exportBWBComparison`. There is no per-price P&L table in prod. | 2, 3.5 |
| M1b | Debit BWB PoP ignores the second breakeven | N | The default 20/40 at σ 0.18 is a debit at every delta. 10Δ put: shows 94.5%, true 12.1%. | 2 |
| M2 | Hedge stress weaker than its docs | P | Code ×1.08 vs doc +8 vol pts on a 2% crash. The call leg gets crash sensitivity on rallies. `sizing.ts` uses unstressed σ. Tests encode the code. | 3.7 |
| M3 | "Peak θ/hr" is per 30 min | C | Exactly 2× too small, half-days included. Entry window unaffected. | 1 |
| M4 | IC breakeven uses per-side credit | C | Introduced in `ee1175a6` (2026-03-16). Payoff at the per-side BE is +$165/ct. Disagrees with `spread-builder` and `hedge/scenarios`. `portfolio-risk` has a third variant. | 3.6 |
| H1 | Fat-tail PoP is a clamped constant multiplier | C | 20Δ IC = 0% from VIX 25. Breach sum >100%. Biased the wrong way against the repo's own empirical table. The "9,102-day calibration" can't be reproduced, and the docs show the old factors. | 3.10 |
| H2 | Strike rows placed with base σ, reported with accelerated σ | C | The 10Δ row is 23Δ at 30 min. Docstring multipliers are wrong (actual 1.208/1.508/1.80). PoP and credit use different σ. | 15, 3.8 |
| H3 | "2Δ hedge" is ~17Δ at 7 DTE | C | Placed with intraday T, priced at DTE/365 with the 0DTE σ. | 3.8 |
| H4 | Delta ceiling collapses intraday | C | 15Δ at the open, 0.4Δ with 1 h left. √t scaling holds it flat. `SURVIVAL_DATA.intraday` is P(H−L<2w), mislabelled as touch. | 3.9 |
| H5 | Overnight gap compares raw ES to SPX | C | Also: `cashOpen` is spot at analysis time, `coneWidth` 0 divides by zero, and the futures panel labels raw basis >5 pts as "STRESS". | 12, 3.15 |
| H6 | Cone is K−P / K+C (1× straddle width) | P | The `:13` comment ("≈2× straddle") is wrong, and `asymmetry_pts` is K−S, not skew. Which convention is canonical needs the UW comparison query (O4). | 15, 3.11 |

### Backend data paths

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| D1 | `fetch-etf-candles-1m` per-row inserts, no HWM, `success` on total failure | C | ~780 round-trips/min, and up to ~780 Sentry events/min in an outage. The test never asserts status (the wrapper always sends 200). | 3 |
| D1b | Same pattern elsewhere | N | `fetch-spx-candles-1m` (no HWM; failed batch still `ok`), `fetch-outcomes` backfill (all-fail → 200, warn only), `build-features` (never `error`). | 4 |
| D2 | `timestampsCache` read-time TTL only, query-string keys | C | R1. The siblings sweep on write. | 9 |
| D3 | Legacy `run:` migrations | P | 13, not 15. #3 is atomic. Only #6's `ADD CONSTRAINT` can't re-run on a fresh DB. CI branches copy prod and never re-run old migrations. | 14 |
| D4 | Readers hand-roll the `withDbReader` envelope | P | 9 strict candidates (below). 7 of them return 500 on a Neon blip today. | 11 |
| D5 | Analyze can outrun 780 s | P | See the table above. On a kill, no error line is written and no Sentry event is sent. | 10 |
| D6 | Oversized handlers | C | Split when next touched. `db-migrations.ts` is append-only. | — |

### Python services

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| P1 | uw-stream loses ticks under Neon stall or lag | P | Per-handler 50k queue. A slow but *successful* Neon evicts with no error at all. | 24 |
| P2 | README promises a 60 s Sentry drop report | C | Never implemented. | 22 |
| P3 | 5 s shutdown drain < one 30 s flush | C | Railway `drainingSeconds` isn't set (default 0). | 23 |
| P4 | Futures front-month tally resets at UTC midnight | P | It resets mid-session, so a back-month print can win in a roll window and get locked in by `DO NOTHING`. | 3.13 |
| P5 | Duplicated `sentry_setup.py` etc. | C | Not worth a shared package: each Docker context is per service. Skip. | — |
| P6 | Classifier OOM facts | P | The peak was under older settings. PR #202 (butterfly cap) was **closed unmerged** on 2026-10-26 01:09Z. | O5 |
| P7 | Railway config-as-code deprecated for existing services after 2026-12-01 | N | Affects all three `railway.toml` files. Verify against Railway docs. | 3.14 |

### Frontend

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| F1 | Whole panel tree re-renders every 5 s | C | Only `AppHeader` reads the staleness fields. For the owner, ~12 renders/min instead of ~1. | 5 |
| F2 | `lightweight-charts` preloaded on first paint | C | One static chain via `IntervalBARow`. **New:** `react-markdown` is eager because the vendor regex is too loose, and `@dnd-kit` is eager via `PanelPrefsModal`. All 22 `lazy()` sites have `.catch`. | 6 |
| F3 | Stale-chunk regex misses Safari, catches offline | C | Also misses Vite's CSS-preload error. The BWB/IC export buttons have the same gap. | 7 |
| F4a | Refresh can race a poll tick | P | Latent only: `refresh` has no callers. | 13 |
| F4b | `useVixData` clobbers a manual VIX | C | Two effects plus a third writer in `useAutoFill`. The final value depends on effect order. | 3.12 |
| F4c | `ensureLoaded()` called during render | C | Low impact. | 13 |
| F4d | Derived-state effects | P | The App one goes away with F4b. GexLandscape needs memory, so keep it. | — |
| F5 | LotteryFinder / SilentBoom near-clones | C | 553 lines in identical runs of 8+. The never-vanish core is already shared. | 3.16 |

### ML

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| L1 | Plots committed nightly | P | See the table above. No action while the workflow is disabled. | O7 |
| L2 | Requirements pinning; secrets in the privileged job | P | `takeit-retrain` puts `DATABASE_URL` and the Blob token in job-level env during `pip install`. Checkout leaves the write token in `.git/config`. Dormant. | 17 |
| L3 | Take-It `TimeSeriesSplit` without a gap | C | All 5 boundaries straddle a day for both models. The calibration cut does too. Fix: a date-grouped split. | 16 |
| L4 | `phase2_early` target | P | Filter to `structure_correct == True` and add a note. Last run scored 0.533, equal to the majority baseline. | 18 |
| L5 | `docs/tmp/` force-added past gitignore | C | Intentional. The gitignore comment's count is stale (147 vs 170). | 21c |

### Docs, tests, a11y

| ID | Finding | V | Notes | Phase |
|---|---|---|---|---|
| T1 | Stale counts and references | C | About 12 files: 191 migrations (CLAUDE.md says 69); ~85 live tables; 39 e2e specs; 83 cron schedules; analyze 780 s, not 800; `useAppState` deleted 2026-05-19; ws_option_trades is migration #109; ml/README paths; dead env vars. | 21 |
| T2 | No "How this was built" section | C | `.claude/agents/code-reviewer.md` isn't tracked, but CLAUDE.md points at it. | 3.17 |
| T3 | Test smells | C | ~15 titles tied to line numbers or retirement dates. `makeFire` copied into 7 files (~610 lines). The parity test still throws in any clone without the gitignored bundle. | 19 |
| T4 | Coverage headroom | — | Done by `coverage-floors-2026-10-26.md` (shipped 2026-10-26). | — |
| T5 | a11y gate softer than the docs say | C | The axe helper, with contrast disabled, is copy-pasted into 7 specs. `useFocusTrap` exists but is used once. Three modals have no trap, including the `PlotCarousel` lightbox the review missed. | 20 |
| T6 | GPL-3.0 with no stated reason | C | | 3.18 |

### Header and telemetry hardening (public, low risk)

| ID | Finding | V | Phase |
|---|---|---|---|
| X1 | Sentry `tracePropagationTargets` hard-codes `0dte.vercel.app`, so theta-options.com gets no trace headers | C | 8 |
| X2 | CSP lacks `object-src 'none'` | C | 8 |
| X3 | `Permissions-Policy` names the retired `interest-cohort` | C | 8 |
| X4 | Two dead CSP script hashes plus `CSP-HASHES.md` | P | 8 (replace them with a build-output check) |
| X5 | `style-src 'unsafe-inline'` | F | Needed: lightweight-charts injects a `<style>`. Keep it. |

## Phases

Every code phase runs the Get It Right loop: TDD → full `npm run review` → `code-reviewer` → commit → push. Each phase touches at most 5 files and runs in its own worktree off `origin/main`.

### Wave 1: no owner decision, Vercel side (ship any time)

Math-display changes (phases 1–2) change numbers on screen. Push them outside 08:30–15:00 CT or flag the change.

1. **θ/hr per hour (M3).** `src/utils/iron-condor.ts`, its test, `ThetaDecayChart.test.tsx`. Test: `thetaPerHour[i] ≈ (pct[i−1] − pct[i]) / 0.5`. S.
2. **BWB widths from snapped strikes, plus debit PoP (M1, M1b).** `src/utils/bwb.ts`, `bwb.test.ts`, plus consumers if the return shape changes. Keep today's snap direction until Q2 is decided. Tests sweep `BWB_NARROW_OPTIONS × BWB_WIDE_MULTIPLIERS × deltas × sides` and assert:
   - `maxLoss ≈ −min_S pnl`;
   - `pnl(BE) ≈ 0`;
   - PoP = P(pnl ≥ 0), i.e. P(BE_lo < S < BE_hi) for debits.
   S–M.
3. **ETF candles cron (D1).** `api/cron/fetch-etf-candles-1m.ts` and its test. Steps:
   - one HWM `SELECT` per run;
   - `bulkUpsert` per ticker (`conflictUpdateColumns: []` makes it DO NOTHING);
   - no per-row catch, so a write rejection becomes `partial`/`error`.
   Tests: HWM filter, null HWM, transaction path over 500 rows, SELECT reject → `error`, one ticker rejects → `partial`, both reject → `error`, all asserted by name. Also probe whether UW returns the still-open minute; if it does, keep only `start_time < floor(now)`. M.
4. **Cron status honesty (D1b).**
   - 4a `fetch-spx-candles-1m`: a failed store → `error`/`partial`, plus an HWM.
   - 4b `fetch-outcomes` (backfill all-fail → error + Sentry) and `build-features` (all dates fail → `error`).
   Each with failure-mode tests. S–M.
5. **Quote staleness split (F1).** New `src/hooks/useQuoteStaleness.ts` (holds the interval plus `isStale`/`isVeryStale`/`staleAgeSec`), used by `AppHeader`. Remove the tick and those fields from `useMarketData`. Tests:
   - `useMarketData` returns the same object identity across 15 s of fake time;
   - a hook table test.
   Fixture updates go in 5b if they push the phase over 5 files. S.
6. **Bundle (F2).**
   - Tighten the vendor regex to `/node_modules[\\/](react|react-dom|scheduler)[\\/]/`.
   - Lazy-load the chart inside `IntervalBARow` (or lazy-load `IntervalBAFeed`).
   - Mount `PanelPrefsModal` only when it's open.
   - Add `scripts/check-build-output.mjs` plus a test. It fails if `index.html` preloads a `charts-` chunk or contains an inline `<script>`, or if the vendor chunk contains `remarkPlugins`. Wire it into `npm run review` after `vite build`.
   S.
7. **Stale-chunk detection (F3).** A shared `isChunkLoadError` matching `/dynamically imported module|Importing a module script failed|Unable to preload CSS/i`, prompting only when `navigator.onLine !== false`. Used by `handle-stale-chunk.ts` and the BWB/IC export buttons. Keep `confirm()` until Q15 is decided. Table test over the browser strings. S.
8. **Header hardening (X1–X4).**
   - Set `tracePropagationTargets` to `['localhost', /^\/api\//]`.
   - Add `object-src 'none'`.
   - Drop `interest-cohort`.
   - Delete both script hashes and `CSP-HASHES.md`; phase 6's check covers inline scripts from then on.
   - After deploy, check a preview's console for CSP violations.
   S.
9. **`timestampsCache` bound (D2).** Sweep on write plus a hard cap of 256 entries, evicting the oldest. Behavioural test: cap+1 distinct `at` keys, then the first key costs a fresh SQL call. S.
10. **Analyze deadline (D5).**
    - Pass a `signal` into `runCachedAnthropicCall` with one deadline at 740 s.
    - Skip the Sonnet fallback when less than 120 s remains.
    - On abort, write an NDJSON error line and call `captureException`.
    - Lower the client `timeout` to 120 s.
    Run the `analyze-prompt-reviewer` agent. Fake-timer tests. S–M.
11. **`withDbReader` adoption (D4).** One reader per commit: `analyses`, `darkpool-levels`, `dealer-regime`, `gexbot`, `greek-flow`, `periscope-chat-list`, `pin-setup-status`, `vix-ohlc` (public, keeps `checkBot`), `vix-snapshots-recent`. Each asserts the 503 (transient) and 500 (genuine) paths. M.
12. **Overnight gap (H5, minus STRESS).**
    - basis = ES in the 08:30 CT minute − SPX open, subtracted before `pctRank` and the VWAP comparisons;
    - pass the real cash open, not current spot;
    - reuse the `coneWidth > 0` guard.
    This changes what the analyze prompt sees, so it's flagged to the owner before push. Tests: `pctRank` doesn't change with basis; width 0 produces no line. S.
13. **Hook cleanups (F4a, F4c).** Delete the unused `refresh` exports. Make the `useVix1dData` getters pure, with loading moved to an effect. S.
14. **Migration #6 re-run safety (D3).** Add `DROP CONSTRAINT IF EXISTS` before its `ADD`, plus a comment in `migrateDb` explaining why there's no advisory lock: the Neon HTTP driver can't hold a session lock, and the `schema_migrations` PK insert in each transaction serializes concurrent runs. Update `db.test.ts` if call counts change. S.
15. **Comment and docstring corrections, no behaviour change (H2, H6).**
    - IV-acceleration multipliers and the claim that they apply to PoP;
    - the `compute-cone.ts:13` comment and the `asymmetry_pts` meaning (also in the periscope `SKILL.md`);
    - the fat-tail factor values in `ARCHITECTURE.md` / `FEATURES.md` and the "matching empirical breach rates" claim.
    S.
16. **Take-It date-grouped CV (L3).** Use `TimeSeriesSplit` over sorted unique dates, mapped back to rows. Snap the calibration cut to a date boundary. Pytest: no date appears in both train and test. **Do not retrain** until Q23 is decided. S.
17. **ML supply chain (L2).**
    - Pin the 13 `>=` lines from the venv freeze, drop the duplicate `joblib`, the 5 orphans and the transitive dev deps.
    - Add `ml/requirements-dev.txt` in the classifier/sidecar shape.
    - The CI ML gate installs the dev file.
    - `ml-pipeline.yml`: move `takeit-retrain` secrets to step level, set `persist-credentials: false` where nothing pushes, and drop `make lint` from the privileged job.
    Use the `gha-security-review` skill. Validate on CI's Python 3.13. S.
18. **`phase2_early` label (L4).** Keep rows with `structure_correct == True` and add a docstring/README note on what the target is. S.
19. **Test hygiene (T3).**
    - 19a: rename the ~15 titles.
    - 19b: `src/__tests__/helpers/makeLotteryFire.ts`, adopted in the 7 files (two commits to stay ≤5 files).
    - 19c: the parity test skips everywhere the bundle is absent, with the regen hint (fix `.venv/bin` → platform-neutral).
    S–M.
20. **a11y (T5).**
    - 20a: `useFocusTrap` in `AccessKeyModal`, `AddContractForm` and the `PlotCarousel` lightbox (+ `role="dialog"`, `aria-modal`), with Tab-wrap tests.
    - 20b: a shared `e2e/_lib/axe.ts` and contrast in warn-only mode for one pass. Coordinate with `e2e-ci-repair-2026-10-26.md` Phase 2, which owns e2e suite health.
    M.
21. **Docs drift (T1, L5).**
    - 21a: `CLAUDE.md`, `README.md`, `.env.example`, `sidecar/.env.example`.
    - 21b: `docs/ARCHITECTURE.md`, `DEPLOYMENT.md`, `ONBOARDING.md`, `FEATURES.md`, `e2e/README.md`.
    - 21c: `ml/README.md`, `scripts/README.md`, the `.gitignore` docs/tmp comment.
    Prefer rounded or no counts ("190+ migrations") over exact ones that drift. Docs only, so no reviewer pass. S.

### Wave 2: Railway services (push only after 15:00 CT)

22. **uw-stream drop reporter (P2).** A `drop_reporter` task (60 s) sends per-handler and receive-queue drop *deltas* as a Sentry warning tagged `component=backpressure`. Correct the README. Pytest: emits once per delta, silent with no drops, survives a capture failure, cancelled on shutdown. S.
23. **uw-stream drain (P3).** One no-retry flush under the drain deadline; deadline 30 s; `drainingSeconds = 40` in the repo config (or the dashboard, per P7); Sentry event with lost-row counts when the deadline is hit. S.
24. **uw-stream backlog handling (P1).** When the queue is deep, pull up to 5,000 rows per flush via `get_nowait`, and count the rows lost when a flush fails. M.
25. **Security items S5–S6.** See the local note.

### Wave 3: needs an owner decision or action first

| Phase | Item | Blocked on |
|---|---|---|
| 3.1–3.4 | Security S1–S4 | O1, O2, O3, Q9–Q11, Q14 (local note) |
| 3.5 | BWB snap direction for off-grid widths | Q2 |
| 3.6 | IC breakeven → total credit; per-side rows unchanged; cross-module agreement test | Q4 |
| 3.7 | Hedge stress additive, rally IV direction | Q3 |
| 3.8 | Strike-row and hedge delta labels (or retarget) | Q6 |
| 3.9 | Delta ceiling √t scaling | Q7 |
| 3.10 | Replace fat-tail PoP with empirical survival by VIX bucket × distance; commit data and script | Q5 (M–L) |
| 3.11 | Cone convention | O4, Q8 |
| 3.12 | `useVixData` single writer (`pickSmartVix`), drops the App injection effect | Q16 (M) |
| 3.13 | Futures session rule: CME session date, incumbent carried forward; uw-stream and `backfill-futures-gaps` in one commit | Q12 (M, after close, not in a roll week) |
| 3.14 | Railway config-as-code migration | P7 verification |
| 3.15 | Futures "STRESS": grade basis against fair carry | Q13 |
| 3.16 | LotteryFinder/SilentBoom: `feed-sig.ts` (byte-identical sigs, golden test), `useLiveDateRoll`, `useTickerExpanded`, `usePageReset`; toolbar optional | Q21 (M without toolbar, L with) |
| 3.17 | README "How this was built" (owner writes the narrative) + screenshots; un-ignore `.claude/agents/` | Q17, O8 |
| 3.18 | License rationale | Q20 |
| 3.19 | GitHub description + topics | O6 |
| 3.20 | HANDOFF.md: delete; gitignore it so the `handoff` skill can't re-commit it | Q18 |
| 3.21 | ML workflow re-enable / plot cadence; Take-It retrain; Phase 2 label source | Q19, Q22, Q23 |

## Owner actions (only the owner can do these)

- **O1.** Open `/api/auth/whoami` on theta-options.com while logged in, and report `mode`. This settles whether `OWNER_SECRET` is set in prod. A memory note says it's empty, but the code says Schwab login can't succeed with it empty.
- **O2, O3.** Set two new env vars before their phases ship (names and steps in the local note).
- **O4.** Run the cone and basis queries (in the local note's appendix), or authorize read-only prod queries.
- **O5.** Say whether closing PR #202 was deliberate. If not, it gets relanded after S1.
- **O6.** Approve the new GitHub description text.
- **O7.** Decide whether the ML Pipeline workflow comes back on.
- **O8.** Screenshots or a short recording for the README.

## Open questions (defaults in brackets)

- **Q2.** Off-grid BWB width (e.g. 37.5): which way does the far wing snap? [Away from the short on both sides: conservative, and the sides match.]
- **Q3.** Hedge stress regime: shock (+8 vol pts on a 2% drop) or calm (+1.5)? Does IV fall on rallies? [Shock; yes.]
- **Q4.** Does the IC row assume a 4-leg hold to settlement, using total credit? [Yes; per-side rows cover legging.]
- **Q5.** Headline PoP: empirical survival or lognormal? [Empirical primary, lognormal as reference; retire the factor.]
- **Q6.** Should a "10Δ" row and a "2Δ hedge" mean a distance or the true delta? [True delta; relabel the hedge now, retarget later.]
- **Q7.** Delta ceiling: scale by √t, or label it "valid at open"? [√t.]
- **Q8.** Cone: textbook K ± (C+P) or the current 1× width? [Match UW once O4 confirms which it uses.]
- **Q12.** Adopt the CME-session futures rule? It adds a fifth rule boundary in `futures_bars` history. [Yes.]
- **Q13.** Futures STRESS: grade against fair carry, or drop the label? [Grade against carry.]
- **Q15.** Stale-chunk prompt: non-blocking banner or `confirm()`? [Banner.]
- **Q16.** On past dates, does a manual VIX survive time scrubbing? [Yes.]
- **Q17.** Un-ignore `.claude/agents/` after checking for private content? [Yes.]
- **Q18.** Gitignore `HANDOFF.md`? [Yes.]
- **Q19.** Plot history if the workflow returns: weekly snapshot commit plus versioned Blob keys? [Yes.]
- **Q20.** GPL-3.0 deliberate, or switch for a portfolio piece? [Owner's call; no default.]
- **Q21.** Unify the feed toolbars, or extract only the hooks? [Hooks only.]
- **Q22.** Phase 2 label: correct-only filter now, market-outcome label if revived? [Yes.]
- **Q23.** Retrain Take-It after the CV fix? [Not until a side-by-side shows the honest metrics.]
- **Q9–Q11, Q14.** Security; see the local note.

## Data dependencies

- **Env vars (Track S):** two new secrets. Names, R7 checklist and deploy order are in the local note.
- **Redis:** possibly `owner:session:*` (Track S, Q9).
- **Railway:** `drainingSeconds` for uw-stream (phase 23).
- **Migrations:** none planned. The cone convention (3.11) may need a backfill from the stored `call_premium`/`put_premium`.
- **No new upstream APIs.** Phase 3 needs one curl probe of UW's 1-minute candles to confirm whether the still-open minute is returned.

## Thresholds and constants

- `timestampsCache` cap: 256 entries.
- Analyze: deadline 740 s, skip the fallback when <120 s remains, client timeout 120 s.
- uw-stream: drop report every 60 s; drain deadline 30 s; `drainingSeconds` 40; backlog batch up to 5,000 rows.
- Vendor chunk regex: `/node_modules[\\/](react|react-dom|scheduler)[\\/]/`.
- Stale-chunk regex: `/dynamically imported module|Importing a module script failed|Unable to preload CSS/i`.
- BWB/IC tolerances: `pnl(BE)` within 1e-6 pts.

## Won't fix (with reasons)

- **Advisory lock around `migrateDb`:** not possible over the Neon HTTP driver, and concurrent runs already serialize on the `schema_migrations` PK. A comment goes in instead (phase 14).
- **Rewriting legacy `run:` migrations:** all applied, and only #6 is unsafe to re-run (phase 14).
- **`api-helpers.ts` shim:** 117 importers and 125 test mocks point at that path. Moving an import silently bypasses its `vi.mock`.
- **Shared Python package:** each Docker context is per service, so it would mean three vendored copies plus sync tests to save about 60 lines.
- **Git LFS or a history rewrite for `ml/plots`:** no growth today, and git is the only plot history.
- **Lazy-loading VegaSpikeFeed, DarkPoolLevels and PeriscopePanel:** they pull in no heavy dependencies.
- **`style-src 'unsafe-inline'`:** required by lightweight-charts' attribution `<style>`.
- **GexLandscape timestamp-holding effect:** needs memory across scrubs, and it's documented.
- **Splitting the oversized handlers now:** do it when each is next touched.
