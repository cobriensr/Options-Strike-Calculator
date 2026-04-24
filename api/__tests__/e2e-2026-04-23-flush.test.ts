// @vitest-environment node

/**
 * Strike IV Anomaly Detector — gold-standard regression replay.
 *
 * What this test does
 * -------------------
 * Replays the 2026-04-23 SPY/QQQ informed-flow flush minute-by-minute
 * against the real detector (`api/_lib/iv-anomaly.ts`) and asserts that
 * the six spec-listed alerts still fire. The session was the motivating
 * event for the detector — see
 * `docs/superpowers/specs/strike-iv-anomaly-detector-2026-04-23.md`
 * "Live validation (2026-04-23)" for the ground-truth tape table and
 * the expected detector replay.
 *
 * How to regenerate the fixture
 * -----------------------------
 * The fixture is NOT committed as JSON — it's too large (~1.7MB). Instead
 * we build it in `beforeAll` via `buildFixture()` from
 * `fixtures/build-2026-04-23-flush.ts`. To update the anchors or expected
 * alerts, edit the builder module; the test re-executes it on next run.
 *
 * Why fuzzy tolerance
 * -------------------
 * The detector thresholds (SKEW_DELTA_THRESHOLD, Z_SCORE_THRESHOLD,
 * Z_WINDOW_SIZE) are expected to be tuned as we accumulate labeled data.
 * A strict exact-count regression would break on every nudge. Instead:
 *
 *   - Each expected alert must fire within ±2 minutes of the spec time
 *   - required_flag_reasons must be a SUBSET of the emitted reasons
 *     (extras are fine; missing any is a failure)
 *   - flow_phase must NOT be in expected_flow_phase_not
 *   - At least 5 of 6 expected alerts must match (4 or fewer = regression)
 *
 * This tolerates reasonable threshold tuning while catching cases where
 * the detector fundamentally stops seeing today's textbook flow.
 *
 * Ground truth
 * ------------
 * `docs/superpowers/specs/strike-iv-anomaly-detector-2026-04-23.md` —
 * "Live validation (2026-04-23)" section, specifically the "Detector
 * replay" table.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  detectAnomalies,
  classifyFlowPhase,
  strikeKey,
  type StrikeSample,
  type AnomalyFlag,
} from '../_lib/iv-anomaly.js';
import { Z_WINDOW_SIZE } from '../_lib/constants.js';
import type { ContextSnapshot } from '../_lib/anomaly-context.js';
import {
  buildFixture,
  type Fixture,
  type ContextStub,
} from './fixtures/build-2026-04-23-flush.js';

// ── Helpers ──────────────────────────────────────────────────

/** Produce a fully-typed ContextSnapshot from the sparse fixture stub. */
function makeContext(stub: Partial<ContextStub> | undefined): ContextSnapshot {
  return {
    spot_delta_5m: null,
    spot_delta_15m: stub?.spot_delta_15m ?? null,
    spot_delta_60m: null,
    vwap_distance: null,
    volume_percentile: null,
    spx_delta_15m: null,
    spy_delta_15m: stub?.spy_delta_15m ?? null,
    qqq_delta_15m: stub?.qqq_delta_15m ?? null,
    iwm_delta_15m: null,
    es_delta_15m: null,
    nq_delta_15m: null,
    ym_delta_15m: null,
    rty_delta_15m: null,
    nq_ofi_1h: null,
    vix_level: stub?.vix_level ?? null,
    vix_delta_5m: null,
    vix_delta_15m: stub?.vix_delta_15m ?? null,
    vix_term_1d: null,
    vix_term_9d: null,
    vix_30d_spot: null,
    dxy_delta_15m: null,
    tlt_delta_15m: null,
    gld_delta_15m: null,
    uso_delta_15m: null,
    recent_flow_alerts: [],
    spx_recent_dark_prints: [],
    econ_release_t_minus: null,
    econ_release_t_plus: null,
    econ_release_name: null,
    institutional_program_latest: null,
    net_flow_5m: null,
    nope_current: null,
    put_premium_0dte_pctile: null,
    zero_gamma_level: null,
    zero_gamma_distance_pct: null,
  };
}

interface CollectedFlag extends AnomalyFlag {
  // flow_phase is required on the emitted record (detector leaves it
  // undefined; replayer fills it via classifyFlowPhase).
  flow_phase: 'early' | 'mid' | 'reactive';
}

const TICKERS = ['SPY', 'QQQ', 'SPX'] as const;

/**
 * Replay the fixture minute-by-minute and collect every flag produced
 * by `detectAnomalies` + `classifyFlowPhase`.
 */
function replay(fixture: Fixture): CollectedFlag[] {
  const timestamps = Object.keys(fixture.strikeSnapshots).sort();
  const collected: CollectedFlag[] = [];

  // Pre-index spots by (ticker, ts) for O(1) lookup.
  const spotByTickerTs = new Map<string, number>();
  for (const ticker of TICKERS) {
    for (const row of fixture.spots[ticker] ?? []) {
      spotByTickerTs.set(`${ticker}:${row.ts}`, row.value);
    }
  }

  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = timestamps[i]!;
    const minuteBucket = fixture.strikeSnapshots[ts];
    if (!minuteBucket) continue;

    for (const ticker of TICKERS) {
      const rows = minuteBucket[ticker];
      if (!rows || rows.length === 0) continue;

      // Shape-compat coercion: fixture samples match StrikeSample exactly
      // since the builder defines them that way, but TS can't see through
      // the JSON-ish interface inference.
      const latestSnapshot: StrikeSample[] = rows.map((r) => ({
        ticker: r.ticker,
        strike: r.strike,
        side: r.side,
        expiry: r.expiry,
        iv_mid: r.iv_mid,
        iv_bid: r.iv_bid,
        iv_ask: r.iv_ask,
        ts: r.ts,
      }));

      // History = prior Z_WINDOW_SIZE minutes of same-ticker samples,
      // keyed by strikeKey(). detectAnomalies expects DESC-by-ts order.
      const historyByStrike = new Map<string, StrikeSample[]>();
      const startIdx = Math.max(0, i - Z_WINDOW_SIZE);
      for (let j = i - 1; j >= startIdx; j -= 1) {
        const pastTs = timestamps[j]!;
        const pastBucket = fixture.strikeSnapshots[pastTs];
        const pastRows = pastBucket?.[ticker];
        if (!pastRows) continue;
        for (const r of pastRows) {
          const key = strikeKey(r.ticker, r.strike, r.side, r.expiry);
          const bucket = historyByStrike.get(key);
          const sample: StrikeSample = {
            ticker: r.ticker,
            strike: r.strike,
            side: r.side,
            expiry: r.expiry,
            iv_mid: r.iv_mid,
            iv_bid: r.iv_bid,
            iv_ask: r.iv_ask,
            ts: r.ts,
          };
          if (bucket) bucket.push(sample);
          else historyByStrike.set(key, [sample]);
        }
      }

      const spot = spotByTickerTs.get(`${ticker}:${ts}`);
      if (spot == null) continue;

      const flags = detectAnomalies(latestSnapshot, historyByStrike, spot);
      if (flags.length === 0) continue;

      const ctxStub = fixture.contextAtAnomalyPoints[ts];
      const context = makeContext(ctxStub);

      for (const flag of flags) {
        const flowPhase = classifyFlowPhase(flag, context);
        collected.push({ ...flag, flow_phase: flowPhase });
      }
    }
  }

  return collected;
}

/**
 * Find the best-matching collected flag for an expected alert within
 * ±2 min. "Best" = the one that covers the most required reasons,
 * tiebroken by temporal proximity. This matters because the detector
 * can emit multiple flags on the same strike in adjacent minutes (e.g.
 * skew_delta at 10:59, then skew_delta + z_score at 11:00) — we want
 * the richer flag, not just the first one.
 */
function findMatch(
  collected: CollectedFlag[],
  expected: Fixture['expectedAlerts'][number],
): CollectedFlag | null {
  const targetMs = Date.parse(expected.utc_ts);
  const toleranceMs = 2 * 60_000;
  const candidates: CollectedFlag[] = [];
  for (const flag of collected) {
    if (flag.ticker !== expected.ticker) continue;
    if (flag.strike !== expected.strike) continue;
    if (flag.side !== expected.side) continue;
    const flagMs = Date.parse(flag.ts);
    if (Math.abs(flagMs - targetMs) <= toleranceMs) candidates.push(flag);
  }
  if (candidates.length === 0) return null;

  let best: CollectedFlag | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const coverage = expected.required_flag_reasons.filter((r) =>
      c.flag_reasons.includes(r),
    ).length;
    const lag = Math.abs(Date.parse(c.ts) - targetMs);
    // Prioritize reason coverage; break ties by smaller lag.
    const score = coverage * 1e9 - lag;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ── Test ─────────────────────────────────────────────────────

describe('E2E: 2026-04-23 informed-flow flush regression', () => {
  let fixture: Fixture;
  let collected: CollectedFlag[];

  beforeAll(() => {
    fixture = buildFixture();
    collected = replay(fixture);
  });

  it('emits at least one anomaly during the replay window', () => {
    expect(collected.length).toBeGreaterThan(0);
  });

  it('fires ≥5 of the 6 spec-listed expected alerts with correct reasons and non-reactive phase', () => {
    const failures: string[] = [];
    let matched = 0;

    for (const expected of fixture.expectedAlerts) {
      const match = findMatch(collected, expected);
      const label = `${expected.ct_time} ${expected.ticker} ${expected.strike}${expected.side[0]?.toUpperCase()}`;

      if (!match) {
        failures.push(`${label}: no flag within ±2m of ${expected.utc_ts}`);
        continue;
      }

      const missing = expected.required_flag_reasons.filter(
        (r) => !match.flag_reasons.includes(r),
      );
      if (missing.length > 0) {
        failures.push(
          `${label}: missing required reasons ${JSON.stringify(missing)} ` +
            `(got ${JSON.stringify(match.flag_reasons)})`,
        );
        continue;
      }

      if (expected.expected_flow_phase_not.includes(match.flow_phase)) {
        failures.push(
          `${label}: flow_phase=${match.flow_phase} is in ` +
            `expected_flow_phase_not=${JSON.stringify(
              expected.expected_flow_phase_not,
            )}`,
        );
        continue;
      }

      matched += 1;
    }

    // 5/6 tolerance: early-window classifications are noisy at the
    // boundary, so one miss is acceptable. Four or fewer is a regression.
    if (matched < 5) {
      throw new Error(
        `Expected ≥5 matches, got ${matched}/6. Failures:\n` +
          failures.map((f) => `  - ${f}`).join('\n'),
      );
    }
    expect(matched).toBeGreaterThanOrEqual(5);
  });

  it('does not flag SPX strikes (flow hid in ETF channel per spec)', () => {
    // Structural lesson from the spec: informed flow that wanted to
    // stay hidden used SPY/QQQ, NOT SPXW. The fixture keeps SPX strikes
    // flat so any SPX flag here would indicate an accidental signal
    // leak in the neighbor-noise generator.
    const spxFlags = collected.filter((f) => f.ticker === 'SPX');
    expect(spxFlags).toEqual([]);
  });

  it('does not flag before 10:00 CT (Z-score warm-up period)', () => {
    const replayStartMs = Date.parse('2026-04-23T15:00:00Z'); // 10:00 CT
    const preWarmupFlags = collected.filter(
      (f) => Date.parse(f.ts) < replayStartMs,
    );
    // Allow up to a handful of "almost warmed up" flags — what we're
    // really catching is a regression where warmup math breaks entirely.
    expect(preWarmupFlags.length).toBeLessThan(5);
  });
});
