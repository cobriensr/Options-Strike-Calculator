# LLM Anti-Pattern Rules + Codebase Audit — 2026-09-08

## Goal

Turn a generic list of LLM-coding mistakes (unnecessary DI, hand-rolled crypto, unnecessary state, tracked-state leaks on failure, happy-path-only tests, load-everything I/O, complex locking, missed races, premature config) into repo-specific, checkable rules that the reviewer subagent applies on every diff, then audit the existing codebase once against those same rules and fix what has a concrete failure scenario.

## Why not just paste the list into CLAUDE.md

CLAUDE.md is already 285 lines. Generic prohibitions are not checkable and do not change behavior on a specific diff. The high-leverage placement is the `code-reviewer` agent checklist (fresh context, applied per change) plus a compact block in CLAUDE.md that points at the reviewer rules.

## The rules (R1–R7)

**R1 — Module-level state must be bounded and reset on the failure path.**
Vercel Fluid Compute reuses function instances, so anything at module scope in `api/` (`let`, `Map`, `Set`, array, cached promise) persists for the life of the warm instance. State that grows or caches must have a hard size cap or TTL; any in-flight-promise dedupe or "pending" marker must be cleared in `finally`. Warn-once booleans and lazy singletons (`getDb()`, SDK clients) are exempt. Same for long-lived Python processes (uw-stream, sidecar): dicts/queues/sets keyed by ticker/contract/timestamp need a cap or eviction. In React (`src/`), no derived or prop-mirrored values in `useState`; every effect that subscribes, polls, or sets a timer returns a cleanup.

**R2 — No hand-rolled crypto or secret handling.**
Secret comparison goes through the existing `timingSafeEqual` helpers (`cronGuard`, `guest-auth`, `auth-helpers`); never `===` / `.includes()` on a secret. Randomness from `node:crypto`; hashing/signing from `createHash`/`createHmac`. No custom encoding, hashing, signing, or token-generation routines.

**R3 — Mock at the module boundary; no test-only indirection.**
Tests use `vi.mock` / `vi.mocked` (Python: `monkeypatch`). No `deps` parameters, factory functions, single-implementation interfaces, or class wrappers whose only reason to exist is testability. Call functions directly.

**R4 — Failure-mode tests are part of "tests are mandatory".**
Every test file for a fetch wrapper, cron, endpoint, or DB writer covers: (a) upstream non-2xx / throw / timeout, (b) malformed or empty payload, (c) DB write rejecting. Each asserts the failure is surfaced (throw, 5xx, `logger.error({ err })` + `Sentry.captureException`), not swallowed into a default.

**R5 — Stream or batch all I/O; never load-everything-then-loop.**
Files/Blobs over ~10 MB are read as streams or by row group / page. DB writes are multi-row INSERTs in chunks of ~500; no single-row `await` inside a loop. Python loaders push `columns=` / `filters=` into parquet reads; long jobs log per-unit progress and are resumable.

**R6 — Prefer idempotent writes over locks; document any lease.**
Cross-instance and cron-overlap concurrency uses `INSERT … ON CONFLICT`, conditional `UPDATE … WHERE status = 'x' … RETURNING`, or a single lease row with expiry. Never in-process mutexes, flags, or sleeps (per-instance, false safety). Any lease/lock comment states who renews it, what happens on renewal failure, and how it expires. Read-modify-write on shared rows is a single statement or a transaction.

**R7 — No config until there are two callers.**
No env var, feature flag, or `constants.ts` entry for a single call site; hard-code next to the use with a comment. A new env var is read in code, declared in `api/_lib/env.ts`, and added to the CLAUDE.md env table in the same commit. Remove env vars and constants nothing reads.

## Phases

### Phase 1 — Install the rules (this commit)

- Add an "LLM anti-pattern invariants" section (R1–R7, checkable form) to `.claude/agents/code-reviewer.md` Step 2.
- Add a ~10-line "Anti-patterns the reviewer rejects" block to `CLAUDE.md` under Code Style, pointing at the reviewer for the full text.
- Commit this spec.

Files: `.claude/agents/code-reviewer.md` (gitignored via `.claude/*` — local to this machine, NOT in the commit), `CLAUDE.md`, this spec.

### Phase 2 — One-time audit (read-only)

Seven parallel audit agents, one per theme, each using its rule as the rubric. Reports land in `docs/tmp/llm-antipattern-audit-2026-09-08/<theme>.md` with: method, findings (P1/P2/P3, path:line, concrete failure scenario, fix, effort), already-good patterns, and rule-tweak suggestions.

| Theme              | Rule    | Scope                                                                  |
| ------------------ | ------- | ---------------------------------------------------------------------- |
| backend-state      | R1      | api/, uw-stream/src, sidecar/src                                       |
| frontend-state     | R1      | src/hooks, src/components, src/utils                                   |
| crypto-and-config  | R2 + R7 | api/, src/, Python services, env.ts, constants, CLAUDE.md env table    |
| di-complexity      | R3      | api/, src/hooks, src/utils, Python services                            |
| failure-mode-tests | R4      | api/cron, api/\_lib fetch wrappers, endpoints, Python sink tests       |
| io-efficiency      | R5      | csv/parquet/blob readers, cron write paths, scripts/, sidecar, ml/     |
| races-and-locks    | R6      | cron overlap, Schwab refresh, migration runner, uw-stream lease, hooks |

Files in flight in another session (`uw-rate-limit.ts`, `uw-fetch.ts`, `sentry.ts` + tests) are audited but tagged IN-FLIGHT and excluded from Phase 3 until they land.

Output: a triage summary appended to this spec (Phase 3 plan) after the reports are synthesized.

### Phase 3 — Fixes (triaged with the user, phased ≤5 files each)

Populated after Phase 2 triage. Each phase runs the Get It Right loop (implement + tests → `npm run review` → code-reviewer → commit + push).

## Data dependencies

None. No migrations, no new env vars. Phase 3 items may add tests only.

## Thresholds / constants agreed

| Constant                       | Value                   | Where used         |
| ------------------------------ | ----------------------- | ------------------ |
| Stream threshold for file/Blob | ~10 MB                  | R5                 |
| Multi-row INSERT chunk size    | ~500                    | R5 (existing rule) |
| Per-row await loop → P2 / P1   | >50 / >500 rows per run | audit severity     |
| Config rule: min call sites    | 2                       | R7                 |

## Open questions

- `.claude/agents/*.md` (all reviewer/auditor agent definitions) are gitignored, so the R1–R7 checklist in `code-reviewer.md` exists only on this machine. A fresh clone gets CLAUDE.md's short form but not the reviewer gate. Option: un-ignore `.claude/agents/` with a two-line `.gitignore` change. Not done here — user's call.
- Whether to force-add the audit reports under `docs/tmp/` (gitignored by default) or only keep the triage summary here. Default: force-add the reports so Phase 3 commits can cite them.
- R7 may need a carve-out for operational knobs that exist precisely so they can be changed without a deploy (e.g. rate-limit caps). Decide after the crypto-and-config report.
