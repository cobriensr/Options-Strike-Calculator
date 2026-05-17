# Docs Index

This folder collects design specs, runbooks, and operational guides. Conventions:

- **Runbooks** (`docs/*.md`) — operational guides for specific subsystems. Stable, long-lived.
- **`superpowers/specs/`** — design specs, one per feature/phase. Named `{topic}-YYYY-MM-DD.md`.
- **`superpowers/plans/`** — multi-phase implementation plans that produce multiple specs over time.
- **`tmp/`** — scratch analyses and EDA outputs. Ephemeral; do **not** rely on as reference.

New to the repo? Follow [README.md](../README.md) → [CLAUDE.md](../CLAUDE.md) → [LOCAL_DEV.md](LOCAL_DEV.md). Come back here once you need to understand a specific subsystem.

## Runbooks

| Doc                                                                        | Subsystem                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| [lottery-pipeline-runbook.md](lottery-pipeline-runbook.md)                 | Lottery Finder ML pipeline (scoring, retraining, alerts) |
| [websocket-alert-system.md](websocket-alert-system.md)                     | `uw-stream` daemon, flow-alerts + option_trades channels |
| [whale-detection-checklist.md](whale-detection-checklist.md)               | $1M+ trade attribution (multileg leg classification)     |
| [institutional-program-tracker.md](institutional-program-tracker.md)       | Long-term institutional position tracking                |
| [flow-archive-recipes.md](flow-archive-recipes.md)                         | Querying historical UW flow archive                      |
| [0dte-findings.md](0dte-findings.md)                                       | Empirical 0DTE SPX behavior — durable findings           |
| [market-mechanics-research-topics.md](market-mechanics-research-topics.md) | Research backlog: dealer hedging, gamma flips, etc.      |

## Active plans

Multi-phase initiatives in flight. Each plan spawns several specs in `superpowers/specs/`.

- [`2026-05-14-periscope-gamma-wall-edge.md`](superpowers/plans/2026-05-14-periscope-gamma-wall-edge.md) — Periscope gamma-wall edge research
- [`bwb-integration-roadmap.md`](superpowers/plans/bwb-integration-roadmap.md) — Broken-Wing Butterfly section build-out
- [`gex-target-rebuild.md`](superpowers/plans/gex-target-rebuild.md) — GEX strike target re-engineering
- [`lottery-tiered-scoring-ui.md`](superpowers/plans/lottery-tiered-scoring-ui.md) — Lottery UI scoring tiers
- [`options-flow-ranking.md`](superpowers/plans/options-flow-ranking.md) — Multi-signal flow ranking

## Specs (`superpowers/specs/`)

156 specs. They share a naming convention but **not** a status convention — to tell what's shipped, cross-reference `git log --oneline | grep <spec-keyword>` or grep the codebase for the feature.

By rough domain (look for filenames matching the prefix):

| Prefix                                | Domain                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| `lottery-*`, `takeit-*`               | Lottery Finder (ML scoring, signal expansion, UI badges) |
| `periscope-*`                         | UW Periscope scraper, OCR, auto-playbook                 |
| `flow-*`, `ws-*`                      | Flow alerts + websocket ingestion                        |
| `sidecar-*`, `theta-*`, `databento-*` | Railway sidecar                                          |
| `multileg-*`, `spread-*`              | Multi-leg classifier                                     |
| `gex-*`, `greek-*`                    | Greek exposure data + UI                                 |
| `darkpool-*`, `dp-*`                  | Dark pool integration                                    |
| `analyze-*`, `prompt-*`               | Anthropic analyze endpoint                               |
| `react-ts-audit-*`, `db-audit-*`      | Hardening / audit specs                                  |
| `contract-tracker-*`, `panel-prefs-*` | Recent feature work                                      |

### Latest 10 (newest first)

```bash
ls -t docs/superpowers/specs/ | head -10
```

The convention is to update a spec in-place if scope evolves during implementation. Once shipped, the spec becomes the historical record.

## `docs/tmp/`

Ephemeral analysis outputs from EDA scripts in `scripts/` and `ml/`. **Read at your own risk** — findings here may have been refuted or superseded. Durable conclusions migrate into either:

- A spec under `superpowers/specs/`, or
- A runbook at the docs/ root.

If a `tmp/` finding is still load-bearing for trade decisions, that's a sign it should be promoted out.

## Conventions to know

- **Date in filename** = when the spec was authored, not when it shipped.
- **No status header** = inferred from `git log`. If a spec has no commit referencing its key feature work, it's likely abandoned or pending.
- **Specs vs. plans** = a plan is multi-phase / multi-spec; a spec is a single feature/PR slice.
- **CLAUDE.md is the convention guide** for code patterns; this folder is for design context.

---

When in doubt, grep the codebase for the feature name before reading old specs — the code is the source of truth, the spec is the historical context.
