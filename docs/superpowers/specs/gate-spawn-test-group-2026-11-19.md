# Run the process-starting tests in their own small group

**Goal:** stop `npm run review` from failing whenever its own workers saturate the CPU. The fix runs every test file that starts child processes first, a few files at a time, and then everything else at full width.

**Owner decision (2026-11-19):** "Git tests first, few at once". No machine-wide lock, and no blanket raising of time limits.

## Why the gate fails

The measurements were taken on 2026-11-19 on the 16-core Windows workstation, with vitest 4.1.12, the forks pool and 15 workers. The probe scratch is in session 6a589ba9's scratchpad, `gate-probe/`.

- **Process start collapses once runnable threads exceed cores.** A `git rev-parse` spawn takes:
  - 60 ms with 8 CPU burners;
  - 107 ms with 12;
  - 674 ms with 16 (max 5.5 s);
  - 22.9 s with 48.

  The burners do no file I/O, and Defender ran at 0–10%, so disk and antivirus are ruled out. Turning off `GIT_CONFIG_NOSYSTEM` made no difference.
- **The gate saturates the CPU by itself.** During a full `vitest run --coverage`, git spawns averaged 855 ms (p99 4.5 s), against 50 ms when the file runs alone. That is a 17x slowdown, and the run queue averaged 44 on 16 cores.
- **The git fixture suites are spawn-bound.**
  - `prune-worktrees.test.mjs` makes 408 sync spawns. Alone it takes 22 s. Under the gate it takes 249 s on a normal run and over 1,300 s on a bad one.
  - The ledger file makes 647 spawns.
  - Their `beforeAll`s fail the 600 s `FIXTURE_TIMEOUT`, which is a check made after the hook returns (`@vitest/runner` `withTimeout`: a sync hook that ran at least the limit is rejected when it returns). So "timed out" means the hook was slow, not hung.
- **Gate runs on 2026-11-19 (worktree `drop-picomatch-allowlist`):**
  - Run 1 was a V8 crash.
  - Runs 2 and 3 failed `prune-worktrees` ×2, `prune-worktrees.ledger` and `session-status.cli` on the 600 s hook limit.
  - `spawn-timeout.test.mjs:126` failed in both: `node -e` wrote no stderr inside its 10 s limit. With 16 burners `node -e ""` alone took 8.6 s.
  - Run 3 also had a `no-database-guard` EPERM.
- Nothing landed on main between 2026-11-18 23:52 CT and this plan.

## Phase 1: one stream, worktree `.worktrees/drop-picomatch-allowlist`

This is one gate run, then one commit per item. The seal binds per file, so a commit of a sealed subset passes the hook.

1. **`scripts/_lib/spawn-timeout.test.mjs`:** the stderr-tail assertion must not depend on how fast the machine starts a child.
   - Check the tail formatting (`stderr so far:` plus the last 500 characters) against a mocked `spawnSync` that returns an ETIMEDOUT result. The file already uses `vi.mock`.
   - Keep the real-spawn timeout test, but assert only what holds under load: the message names the command and the limit, and keeps `cause`.
2. **`api/__tests__/no-database-guard.test.ts` (about :180):** the cleanup of the nested-vitest probe dir hits EPERM when a descendant process still has the dir as its cwd. In the probe, the holder let go after about 41 s.
   - Give `rmSync` `maxRetries: 10, retryDelay: 1000`. Node backs off linearly, so that is about 55 s in all.
   - Try running the nested vitest with its cwd at the repo root, passing `--root` or `--config` as absolute paths, so that no child holds the dir at all. Keep it only if the probe tests still pass and still prove what they prove.
3. **`vite.config.ts`:** split the tests into two vitest projects. Both use `extends: true`, so they keep the root `environment`, `setupFiles`, timeouts and coverage.
   - **`spawn`:** every test file that starts a child process. That means each test or fixture that imports `node:child_process`, or the `scratch-git`, `spawn-timeout`, `review-gate` or `prune-worktrees` fixtures. 2026-11-19 count: 23 test files, listed below. Give it `sequence.groupOrder: 0` and a low `maxWorkers`.
   - **`main`:** everything else, with `sequence.groupOrder: 1` and the default worker count.
   - Write the list of `spawn` files once, as an exported constant that both projects read (`include` for one, `exclude` for the other), so a file can't end up in both or neither.
   - Confirm at runtime that vitest 4.1.12 honours per-project `maxWorkers`. `ProjectConfig` allows it in the types; count the live worker processes during the `spawn` group.
   - If it isn't honoured, say so and stop.
4. **Guard test**, next to `scripts/_lib/coverage-thresholds.test.mjs` or in it. It fails when any test file under the three include roots that imports `node:child_process`, or one of the fixtures above, is missing from the `spawn` list. It also fails when a listed file doesn't exist. This is the same idea as the guard that fails a coverage glob matching no files.
5. **`audit-ci.jsonc`:** the picomatch entry removal, already made (GHSA-fc5q-39xc-vjpf, withdrawn 2026-11-18 15:38 UTC).

The `spawn` files on 2026-11-19 (fixtures not counted):
- `api/__tests__/`: `no-database-guard`, `vercel-ignore-command`.
- `scripts/_lib/`: `backfill-cli`, `backfill-sidecar-startup`, `build-output`, `candles-backfill`, `coverage-floor`, `flow-data-backfill`, `git-run`, `greek-nope-backfill.cli`, `net-prem-ticks-backfill`, `prune-worktrees`, `prune-worktrees.ledger`, `prune-worktrees.races`, `review-gate`, `review-gate.cli`, `review-summary`, `scratch-git`, `session-status`, `session-status.cli`, `spawn-timeout`, `vercel-build-file-set`, `watch-deploy`, `watch-deploy.cli`.

Re-derive the list from the code. Don't copy this one: a file that only mocks `node:child_process` doesn't belong in it.

## Phase 2: measure before adopting

- **`spawn` `maxWorkers`:** time the `spawn` group at 2, 3, 4 and 6 workers on a machine with no other vitest running. Pick the fastest width at which the mean git spawn stays under 150 ms (3x idle), and record the numbers in the config comment.
- **Overlapping gates (optional, only if cheap):** check whether lowering the `main` project's worker priority keeps a concurrent `spawn` group near its quiet-machine timing. That would be `os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL)` in a setup file the `main` project alone loads. Adopt it only on a measured gain, and report either way.

## Acceptance

- `npm run review` passes, on a machine where no other session is running vitest.
- Report:
  - each group's wall time;
  - the slowest `beforeAll` in `prune-worktrees.ledger`;
  - the mean git spawn time in the `spawn` group;
  - the gate's total time, against 1,327 s for the last green run (2026-11-19 run 1, which also crashed V8) and 1,413 s for run 3.
- CI goes green after the push. This touches `vite.config.ts` and `scripts/`, so watch the run to the end, not just the Vercel deploy.

## Thresholds and constants

- `FIXTURE_TIMEOUT` stays at 600 s, `GIT_TIMEOUT_MS` at 300 s and `SLOW_CHILD_TIMEOUT` at 450 s. The spawn-timeout limit stays at 10 s, and the root `hookTimeout` at 60 s.
- `rmSync` gets `maxRetries: 10, retryDelay: 1000` (about 55 s).
- The `spawn` group's `maxWorkers` is set from the Phase 2 measurement; 3 is the starting guess.

## Data dependencies

None: no migration, env var or external API.

## Open questions

- **Overlapping sessions:** two sessions running the gate at once still overload the machine. The owner declined a lock on 2026-11-19. Revisit if the gate keeps failing during overlaps after this lands.

## Measured (2026-11-19, implementation)

- **Per-project `maxWorkers` is honoured.** vitest 4.1.12 reads `project.config.maxWorkers` in `resolveMaxWorkers`, and runs one `sequence.groupOrder` group after another. Counted live (a sample every 1.5 s of the vitest main process's node children): the count equalled the width in most samples at 2, 3, 4 and 6, and never went above width + 1, which happens for a moment while a worker is replaced.
- **The `spawn` group alone** (21 files, 1,046 tests; nothing else running vitest; the machine itself was at 75-80% CPU from other programs):

  | workers | wall (vitest Duration) | mean git spawn | slowest `prune-worktrees.ledger` beforeAll |
  | ------- | ---------------------- | -------------- | ------------------------------------------ |
  | 2       | 103 s, 110 s           | 60, 64 ms      | 7.1 s                                      |
  | 3       | 73 s, 75 s, 76 s       | 64, 65, 66 ms  | 7.0 s                                      |
  | 4       | 59 s, 60 s             | 70, 72 ms      | 8.0 s                                      |
  | 6       | 50 s                   | 79 ms          | 9.5 s                                      |

  A fifth run at 4 workers (76 s, 85 ms) overlapped another session's vitest start and is left out. Each run made 2,321 git spawns; p99 was 300-400 ms and the slowest spawn 0.5-0.9 s at every width. Picked 6, the fastest width with a mean under 150 ms. The hook limits (600 s) are now 60 times the slowest hook.
- **Not done:** the optional worker-priority experiment. It needs a full `main` group running beside the `spawn` group, well over the 20 minutes it was allowed.
- **Three things the plan had wrong or loose:**
  - **The `spawn` list has 21 files, not 23-24.** `session-status.test.mjs` and `watch-deploy.test.mjs` replace `node:child_process` with a factory that takes no parameter, so they start nothing and stay in `main`. `backfill-sidecar-startup.test.mjs` does not exist on this base. `vercel-build-file-set.test.mjs` starts git through `git-run.mjs` rather than a fixture, which a check for the four fixtures alone would have missed; the guard follows relative imports to `node:child_process`.
  - **A root `test.include` cannot be narrowed by a project.** An inline project with `extends: true` goes through vite's `mergeConfig`, which joins arrays, so the `spawn` project got the root's three globs as well as its own list and collected all 872 files. `vite.config.ts` therefore has no root `include`; vitest's default then feeds `coverage.exclude`, and `coverage-thresholds.test.mjs` mirrors that default. The two projects together collect the same 872 files as before (21 + 851).
  - **`maxWorkers` of the `main` project is left unset,** so it takes the root default (cores minus one); the guard test pins that the `spawn` width is at most 6 and that the groups are ordered.
