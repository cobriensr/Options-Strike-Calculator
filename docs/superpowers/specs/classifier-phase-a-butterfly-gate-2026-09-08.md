
## Task 4 results (2026-09-08 14:10 CT) and the resulting Task 5

Replay of the 100 most recent `butterfly` lottery fires through the GATED matcher
(`docs/tmp/classifier-butterfly-replay-2026-09-08.md`, gitignored):

- Only **26/100 windows were replayable** — `cleanup-ws-option-trades` purges rows older
  than ET-date − 2 days, so 74 windows are gone. Replayable: today's 19 plus 7 from
  2026-07-09 that survived an incomplete sweep. No window exceeded the caller's 10 K cap
  (max 1,805 rows; median 358).
- **Retention 21/26 (80.8 %)**; today-only 17/19 (89.5 %). Every retained anchor reproduced
  the identical triple (`pattern_group_id`) and confidence.
- **Gate-attributable loss: 2/26.** Both were META on 2026-07-09 with single-cell products
  of 372,100 and 350,464 pairs (~600-row cells); both lost the label (→ isolated_leg,
  vertical), stable 5/5 on rerun. So the Task 1 comment's "output-identical in every
  measured run" is false at ~600-row cell density: verticals do not fully saturate there.
- **The other 3 losses are not the gate.** (a) The matcher is run-to-run nondeterministic on
  identical input, even at `POLARS_MAX_THREADS=1` (INTC fire 889248 over 5 runs: isolated
  ×3, vertical ×1, butterfly ×1) — a ~12 % noise floor under any single-shot retention
  metric and a data-quality defect in its own right (Phase C, alongside review §3.3; likely
  cause is join/unique output order feeding `rank(method="ordinal")` tie-breaks in
  `_prune_top_k_per_trade`). (b) The two today-losses were the only fires classified
  < 30 s after trigger (19.9 s and 24.7 s); production labelled them from a
  forward-truncated window, and re-cutting the window at trigger + 0–10 s reproduces the
  stored label and group id. `multileg-classify-batch.ts` should not classify until
  `trigger + HALF_WINDOW_SEC` has elapsed (Phase B).
- Peak RSS for the whole replay: 178 MB; per-window wall median 0.12 s, max 0.27 s.

**Decision (spec rule: < 90 % → smallest cap restoring the gate-caused losses):**
`_BUTTERFLY_PAIR_CAP` **250_000 → 400_000** (covers the observed 372,100 with a margin;
single-bucket cells up to ~632 rows now enumerate). No cap value reaches 90 % on this
sample because of the nondeterminism floor, so 400 K is the value that removes every
gate-attributable loss observed. Memory check: the OOM regime is 5–10 K-row cells
(25 M–100 M pairs), 60–250× above either cap, so the fix is unaffected; the ungated cost
of a 632-row cell is a few hundred MB (probe: ~850 MB at a 1,000-row cell at 20 % mid).

### Task 5 — raise the cap to 400 K and correct the comment (after Task 2 lands)

**Files:** `ml/src/multileg_assembler.py` (+ re-vendor ×2). No test changes required: the
gate tests monkeypatch the cap explicitly (250 K / 10**12) and the fixtures sit at 810 K
and 640 K pairs (still above 400 K) and 129.6 K (still below).

1. `_BUTTERFLY_PAIR_CAP: Final = 400_000`.
2. Replace the "In dense windows the skip has been output-identical in every measured run …"
   sentence with the replay evidence: identical at 5 K / 10 K prints and in the 800-print
   fixture; in the 2026-09-08 production replay, 2 of 26 replayable butterfly fires sat in
   ~600-row cells (350–372 K pairs) and lost the label under a 250 K cap, hence 400 K.
   Keep "Measured, not guaranteed".
3. Re-run the ml multileg suite, ruff, re-vendor, `cmp`, classifier + sidecar sync tests, and
   the probe at 5 K then 10 K `full` (expect ≈ unchanged: the 10 K cells are far above
   either cap). Commit: `perf(matcher): Raise butterfly pair cap to 400K per production replay`.
