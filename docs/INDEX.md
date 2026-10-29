# Docs Index

This folder collects guides, runbooks, design specs and plans. Conventions:

- **Guides** (`docs/*.md` in caps): onboarding, architecture, features, deployment. **Runbooks** (`docs/*.md`, `docs/runbooks/`): how to operate a subsystem. **Findings and designs** (`docs/*.md`): research notes and older design docs, each labeled below.
- **`superpowers/specs/`**: design specs, one per feature/phase. Named `{topic}-YYYY-MM-DD.md` (most) or `YYYY-MM-DD-{topic}.md` (newer design specs paired with a plan of the same name).
- **`superpowers/plans/`**: multi-phase implementation plans that produce multiple specs over time.
- **`tmp/`**: scratch analyses and EDA outputs. Ephemeral; do **not** rely on as reference.

New to the repo? Read [README.md](../README.md) → [ONBOARDING.md](ONBOARDING.md) → [LOCAL_DEV.md](LOCAL_DEV.md), then [ARCHITECTURE.md](ARCHITECTURE.md) and [FEATURES.md](FEATURES.md). [CLAUDE.md](../CLAUDE.md) holds the code conventions. Come back here once you need to understand a specific subsystem.

## Guides

| Doc                                        | What it covers                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [ONBOARDING.md](ONBOARDING.md)             | What the app is, what's in it, where the data comes from                                             |
| [LOCAL_DEV.md](LOCAL_DEV.md)               | Running it from a clean clone                                                                        |
| [ARCHITECTURE.md](ARCHITECTURE.md)         | System design, project structure, data flow, security, math, data pipeline                           |
| [FEATURES.md](FEATURES.md)                 | Full feature surface                                                                                 |
| [DEPLOYMENT.md](DEPLOYMENT.md)             | Vercel + Railway deploy, test suites, CI                                                             |
| [TRADING_WORKFLOW.md](TRADING_WORKFLOW.md) | The 5-phase intraday workflow and the structure-selection and management rules in the analyze prompt |

## Runbooks

| Doc                                                          | Subsystem                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [lottery-pipeline-runbook.md](lottery-pipeline-runbook.md)   | Lottery Finder ML pipeline (scoring, retraining, alerts)                              |
| [runbooks/takeit-rollback.md](runbooks/takeit-rollback.md)   | Roll back a bad Take-It model bundle by repointing the manifest                       |
| [flow-archive-recipes.md](flow-archive-recipes.md)           | Querying historical UW flow archive                                                   |
| [whale-detection-checklist.md](whale-detection-checklist.md) | Live checklist for spotting and trading whale prints (built from April 2026 EOD flow) |

## Findings and designs

| Doc                                                                        | What it is                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [0dte-findings.md](0dte-findings.md)                                       | Raw SPXW flow observations from 8 days of EOD data (2026-04-13 → 04-22)                 |
| [market-mechanics-research-topics.md](market-mechanics-research-topics.md) | Backlog of market-mechanics gaps in the analyze prompt (`api/_lib/market-mechanics.ts`) |
| [websocket-alert-system.md](websocket-alert-system.md)                     | Design (2026-04-23, never built): real-time premium-burst alerts on `option_trades`     |
| [institutional-program-tracker.md](institutional-program-tracker.md)       | Retired (removed 2026-05-03): build spec for the SPXW institutional block tracker       |

## Subproject READMEs

- [sidecar/README.md](../sidecar/README.md): Railway service for Take-It SHAP and read-only DuckDB queries over the frozen archive
- [uw-stream/README.md](../uw-stream/README.md): Railway service consuming the UW websocket into Neon (including `futures_bars`)
- [scripts/ws-canary/README.md](../scripts/ws-canary/README.md): temporary Railway canary for uw-stream's websocket resets
- [ml/README.md](../ml/README.md): ML pipeline (structure classification, day-type analysis)
- [ml/experiments/README.md](../ml/experiments/README.md): experiment JSON naming
- [e2e/README.md](../e2e/README.md): Playwright suites, conventions, CI
- [scripts/README.md](../scripts/README.md): backfills, analyses, ops scripts
- [scripts/eod-flow-analysis/README.md](../scripts/eod-flow-analysis/README.md): multi-day EOD option-flow analyzer used by `make nightly`
- [tmp/README.md](tmp/README.md): scratch-space rules

## Plans (newest first)

Multi-phase initiatives. Each plan spawns several specs in `superpowers/specs/`. 27 plans as of 2026-10-29; the newest:

- [`2026-10-28-classifier-replacement.md`](superpowers/plans/2026-10-28-classifier-replacement.md): fix the Take-It one-hot bug, then replace the Railway classifier with the exchange's multi-leg trade code and remove it
- [`2026-10-28-gexbot-eod-capture.md`](superpowers/plans/2026-10-28-gexbot-eod-capture.md): copy GEXBot's end-of-day ZIP for every ticker into R2 daily, with an index row per file
- [`2026-10-28-uw-futures-orderflow-phase0-2.md`](superpowers/plans/2026-10-28-uw-futures-orderflow-phase0-2.md): probe UW's futures feed, then add per-minute aggressor volume to `futures_bars`
- [`2026-10-23-uw-ws-capture.md`](superpowers/plans/2026-10-23-uw-ws-capture.md): schema for new UW data, uw-stream fixes, and capture of `periscope:SPX` and other new channels
- [`2026-10-23-uw-rest-fixes.md`](superpowers/plans/2026-10-23-uw-rest-fixes.md): fix the live UW REST data defects found in the 2026-10-23 alignment spec
- [`2026-06-12-guest-feedback-ui-fixes.md`](superpowers/plans/2026-06-12-guest-feedback-ui-fixes.md): three guest-feedback UI fixes
- `2026-06-11-frontend-recomposition-phase{0,1,2,3,5}.md`: page recomposition phases (foundation, card tiers, setup strip, command band, nav grouping)
- [`2026-06-10-alerts-side-by-side-and-test-hardening.md`](superpowers/plans/2026-06-10-alerts-side-by-side-and-test-hardening.md): Lottery Finder + Silent Boom side by side on wide screens, plus test gaps
- [`2026-06-07-regime-0dte-panel.md`](superpowers/plans/2026-06-07-regime-0dte-panel.md): live 0DTE gamma-regime panel that scores itself nightly

Older plans (2026-05 and the undated `bwb-integration-roadmap`, `gex-target-rebuild`, `lottery-tiered-scoring-ui` and `options-flow-ranking`) are in the folder.

## Specs (`superpowers/specs/`)

270 specs as of 2026-10-29. Most (163) carry YAML front-matter `status:` and `date:`; for the older ones `scripts/add-spec-status-headers.mjs` set the status from commit messages, so treat `Likely Shipped` and `TBD` as hints. 33 more have a `**Status:**` line near the top. For the other 74, cross-reference `git log --oneline | grep <spec-keyword>` or grep the codebase for the feature.

By rough domain (look for filenames matching the prefix, ignoring a leading date; rows overlap):

| Prefix                                                                                                   | Domain                                                                                           | ≈ files |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| `lottery-*`, `takeit-*`, `silent-boom-*`, `conviction-*`, `hot-right-now-*`, `suspicious-*`, `payoff-*`  | Lottery Finder + Silent Boom: scoring, Take-It model, feeds, UI                                  | 47      |
| `periscope-*`                                                                                            | Periscope reads, analyzer, playbook, Periscope lottery                                           | 17      |
| `gex-*`, `greek-*`, `gexbot-*`, `zero-gamma-*`, `gamma-*`                                                | Greek exposure, GEXBot, zero-gamma, gamma setups                                                 | 19      |
| `flow-*`, `ws-*`, `net-flow-*`, `interval-ba-*`, `opening-flow-*`                                        | Flow alerts, net flow, interval B/A, websocket tables                                            | 14      |
| `uw-*` (incl. `uw-stream-*`)                                                                             | Unusual Whales REST limits and the websocket daemon                                              | 13      |
| `futures-*`                                                                                              | Futures data and playbook (UW-sourced since 2026-09-29)                                          | 12      |
| `multileg-*`, `classifier-*`                                                                             | Multi-leg classifier (retirement approved 2026-10-28)                                            | 5       |
| `sidecar-*`, `theta-*`, `databento-*`, `archive-*`                                                       | Railway sidecar; Theta and Databento specs are history (removed 2026-10-02 and 2026-09-29)       | 5       |
| `analyze-*`, `es-options-*`, `phase5a-*`                                                                 | Anthropic analyze endpoint and its context                                                       | 4       |
| `frontend-*`, `panel-*`, `ui-*`, `filter-toolbar-*`, `loose-tsx-*`, `*never-vanish*`, `options-alerts-*` | Frontend structure, panels, feed UX                                                              | 18      |
| `sentry-*`, `axiom-*`, `migration-drift-*`, `transient-db-*`, `withdbreader-*`, `neon-*`                 | Observability and DB resilience                                                                  | 11      |
| `*audit*`, `*remediation*`, `*hardening*`, `coverage-floors-*`                                           | Audits and hardening                                                                             | 17      |
| `pac-*`, `ichimoku-*`, `iv-anomaly-*`                                                                    | Research: PAC backtester, Ichimoku strategies, IV-anomaly detector (detector retired 2026-04-30) | 23      |

### Key specs (newest first)

- `2026-10-28-classifier-replacement-design.md`: replace the retired multileg classifier with the exchange's multi-leg flag (approved 2026-10-28)
- `2026-10-28-nightly-pipeline-automation-design.md`: land every trading day's tape in R2 unattended
- `2026-10-28-uw-futures-orderflow-design.md`: keep the futures order flow, block trades and session stats UW already sends (design, not built)
- `2026-10-28-gexbot-eod-capture-design.md`: save GEXBot's end-of-day report for every ticker daily
- `ws-canary-2026-10-28.md`: find which network hop resets uw-stream's websockets (temporary canary)
- `lottery-cron-timeouts-2026-10-28.md`: stop `detect-lottery-fires` timing out and recover the fires it lost
- `panel-payload-guards-2026-10-28.md`: a malformed API payload degrades one panel, not the whole page
- `gexbot-refresh-2026-10-28.md`: end-to-end refresh of the GEXBot integration
- `db-data-repair-2026-10-27.md`: correct or refill DB rows from Schwab, UW and GEXBot where the source still serves them
- `past-date-replay-integrity-2026-10-27.md`: past-date mode uses only that date's data, never today's quotes
- `review-remediation-2026-10-26.md`: triage of the 2026-10-25 end-to-end review, and the fixes
- `coverage-floors-2026-10-26.md`: per-file and per-folder coverage floors in `npm run review`
- `e2e-ci-repair-2026-10-26.md`: get the E2E CI job to finish with a real verdict
- `endpoint-licensing-auth-fix-2026-10-25.md`: every endpoint follows the data-licensing rule (Schwab public; UW/GEXBot owner or guest)
- `uw-api-ws-alignment-2026-10-23.md`: fix UW REST data bugs and capture new websocket channels, including `periscope:SPX`
- `axiom-field-cap-2026-10-04.md`: cron events send allowlisted top-level fields plus one `meta` JSON string
- `databento-removal-2026-09-29.md`: Databento cancelled; futures come from UW
- `schwab-reauth-2026-09-29.md`: Schwab token-expiry fix and re-login reminders
- `futures-uw-migration-2026-09-08.md`: 1-minute futures bars from the UW `futures_trades` websocket
- `llm-antipattern-audit-2026-09-08.md`: the R1–R7 reviewer rules and the audit behind them
- `2026-06-11-frontend-recomposition-design.md`: page recomposition design (see the phase plans)
- `withdbreader-refactor-2026-06-09.md` + `transient-db-degrade-2026-06-09.md`: shared `withDbReader` wrapper for GET readers, and a 503 soft-degrade on transient Neon timeouts
- `2026-06-07-regime-0dte-panel-design.md`: live 0DTE gamma-regime panel that scores itself nightly
- `2026-06-06-feed-never-vanish-design.md`: a Lottery or Silent Boom row never disappears intraday
- `uw-stream-connection-sharding-2026-06-03.md` + `uw-stream-ws-connection-lease-2026-06-03.md`: websocket sharding under the per-connection channel cap, and a deploy-overlap lease

### Latest 10 (newest first)

```bash
git log --diff-filter=A --name-only --format= -- docs/superpowers/specs/ | grep . | head -10
```

This sorts by the commit that added each spec. `ls -t` sorts by file time, which on a fresh clone or worktree is checkout time.

The convention is to update a spec in-place if scope evolves during implementation. Once shipped, the spec becomes the historical record.

## `docs/tmp/`

Ephemeral analysis outputs from EDA scripts in `scripts/` and `ml/`. **Read at your own risk**: findings here may have been refuted or superseded. Rules are in [tmp/README.md](tmp/README.md); new files there are gitignored by default. Durable conclusions migrate into either:

- A spec under `superpowers/specs/`, or
- A runbook at the docs/ root.

If a `tmp/` finding is still load-bearing for trade decisions, that's a sign it should be promoted out.

## Conventions to know

- **Date in filename** = when the spec was authored, not when it shipped.
- **Status** = the front-matter `status:` or the `**Status:**` line when present (a heuristic for `Likely Shipped`/`TBD`); otherwise inferred from `git log`. If a spec has no commit referencing its key feature work, it's likely abandoned or pending.
- **Specs vs. plans** = a plan is multi-phase / multi-spec; a spec is a single feature/PR slice.
- **CLAUDE.md is the convention guide** for code patterns; this folder is for design context.

---

When in doubt, grep the codebase for the feature name before reading old specs: the code is the source of truth, the spec is the historical context.
