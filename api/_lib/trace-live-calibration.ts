/**
 * Calibration scaffold for /api/trace-live-analyze.
 *
 * Mirrors the role of `analyze-calibration.ts` but is intentionally empty
 * for now — populate it once you have a few hand-graded TRACE-live ticks
 * that show the expected reasoning chain and output shape. The function
 * signature is committed up-front so the endpoint can inject the
 * calibration block today (currently a no-op) without later refactor.
 *
 * Why split this out instead of inlining in trace-live-prompts.ts:
 *   - Real-world calibration examples are bulky (multi-paragraph reasoning
 *     blocks per example) and rotate as we re-grade outputs. Keeping them
 *     in their own module avoids re-rendering the entire prompts module
 *     in code review every time we update a single example.
 *   - This block sits *inside* the cache boundary alongside the system
 *     prompt parts. Updating the calibration text invalidates the prompt
 *     cache for the next ~1h, so we want updates to be deliberate and
 *     reviewable.
 *
 * To populate later:
 *   1. Run /api/trace-live-analyze a handful of times (different regimes,
 *      different override outcomes, a no-trade flip-flop).
 *   2. Pick 1–3 ticks that exemplify correct rule application — gamma
 *      override fires correctly, charm flip-flop produces no_trade,
 *      cross-chart agreement on a clean +γ pin day.
 *   3. Inline the captured input (timestamp, spot, GEX summary, chart
 *      labels) and the model's verbatim TraceAnalysis output into a
 *      <calibration_example> XML block.
 *   4. Wrap the examples in TRACE_LIVE_CALIBRATION_BLOCK and they'll
 *      get baked into the cached system prompt automatically.
 */

/**
 * Block of calibration examples injected into the cached system prompt
 * between the override hierarchy (PART1) and the inlined skills (PART2).
 *
 * Empty for now — see module docstring for how to populate.
 *
 * Returns an empty string when there are no examples so concatenation is
 * always safe; callers don't need to null-check.
 */
export function getTraceLiveCalibrationBlock(): string {
  return '';
}
