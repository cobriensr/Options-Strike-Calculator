// @vitest-environment node

/**
 * Synthesizes the 2026-04-23 flush fixture in-memory.
 *
 * This is the canonical "gold-standard" IV-anomaly fixture derived from the
 * real session documented in
 * `docs/superpowers/specs/strike-iv-anomaly-detector-2026-04-23.md`. The
 * regression test at `api/__tests__/e2e-2026-04-23-flush.test.ts` imports
 * `buildFixture()` and runs it once in `beforeAll` — no JSON is committed
 * to disk (the serialized payload would be ~1.7MB, and the synthesis is
 * cheap enough to regenerate per test run).
 *
 * Design choices (encoded in constants below):
 *
 *   - **Window**: 09:00 CT (14:00 UTC) → 12:00 CT (17:00 UTC). The first
 *     60 minutes are a Z-score warm-up (required because `computeRollingZ`
 *     needs 60 prior samples). Detection replay starts at 10:00 CT.
 *
 *   - **Tickers**: SPY (target), QQQ (target), SPX (flat — confirms
 *     informed flow hides in ETF channels), plus IWM / TLT / XLF / XLE /
 *     XLK flat (added in the 2026-04-24 ticker-scope expansion to prove
 *     the new tickers don't produce false positives on a quiet baseline).
 *     Calls + puts both populated but only SPY/QQQ put-side targets
 *     produce anomalies.
 *
 *   - **Target strikes**: SPY 704P + 705P, QQQ 649P. Anchor IVs are
 *     derived from the real-session ASK-side concentration — we don't
 *     have tick-by-tick IVs, only volume/spot/side%, so we synthesize
 *     a plausible IV trajectory that produces the detector flags
 *     listed in the spec's "Detector replay" table.
 *
 *   - **Neighbor strikes**: ±3 strikes flat at the ticker's baseline IV
 *     with ZERO noise. See NEIGHBOR_NOISE comment below for the rationale
 *     (noise above the stddev floor produces spurious Z-score flags).
 *
 *   - **Context snapshots**: only pre-populated at the 6 expected-alert
 *     timestamps. `classifyFlowPhase` only reads `vix_delta_15m` and
 *     the flag's `ask_mid_div` — the other ~33 fields stay null.
 *
 *   - **Determinism**: no RNG anywhere. Output is byte-identical across
 *     machines, so the regression test is a pure threshold check.
 */

// ── Constants ────────────────────────────────────────────────

const WINDOW_START_UTC = '2026-04-23T14:00:00Z'; // 09:00 CT
const WINDOW_END_UTC = '2026-04-23T17:00:00Z'; // 12:00 CT
const CADENCE_MINUTES = 1;
const EXPIRY = '2026-04-23';

// Baseline IVs per ticker (flat for non-target strikes; starting point
// for target strikes). Derived from typical 0DTE OTM put IV range.
// New tickers (IWM / TLT / XLF / XLE / XLK) ship purely flat here —
// their exact values are not load-bearing for the regression, only that
// no flags emit when every strike sits at a constant IV.
const BASELINE_IV = {
  SPY: 0.24,
  QQQ: 0.28,
  SPX: 0.22,
  IWM: 0.26,
  TLT: 0.17,
  XLF: 0.2,
  XLE: 0.23,
  XLK: 0.25,
} as const;

// Ticker spot at key times. Linear-interpolated minute-by-minute. These
// match the spec's "Observed tape" table (SPY/QQQ spots; SPX derived
// from the 77pt flush description: 7147 → 7070 between 11:50 and 13:00).
const SPOT_ANCHORS = {
  SPY: [
    { min: 0, value: 711.6 }, // 09:00
    { min: 60, value: 711.63 }, // 10:00
    { min: 90, value: 712.13 }, // 10:30
    { min: 95, value: 711.18 }, // 10:35
    { min: 120, value: 710.87 }, // 11:00
    { min: 155, value: 711.07 }, // 11:35
    { min: 180, value: 709.66 }, // 12:00
  ],
  QQQ: [
    { min: 0, value: 656.1 },
    { min: 60, value: 656.14 }, // 10:00
    { min: 90, value: 656.25 }, // 10:30
    { min: 95, value: 656.3 }, // 10:35
    { min: 120, value: 655.24 }, // 11:00
    { min: 180, value: 654.1 }, // 12:00
  ],
  SPX: [
    { min: 0, value: 7140 },
    { min: 60, value: 7142 }, // 10:00
    { min: 120, value: 7138 }, // 11:00
    { min: 170, value: 7147 }, // 11:50 (pre-flush peak)
    { min: 180, value: 7135 }, // 12:00 (flush begins)
  ],
  // Expansion tickers — flat spot, flat IV. Single anchor = constant
  // across the window; `interpolate()` falls through to the last anchor
  // for any minute >= 0 so one entry per ticker is enough.
  IWM: [{ min: 0, value: 235 }],
  TLT: [{ min: 0, value: 92 }],
  XLF: [{ min: 0, value: 52 }],
  XLE: [{ min: 0, value: 95 }],
  XLK: [{ min: 0, value: 242 }],
} as const;

// Target-strike IV anchors (minute-offset from window start, IV in decimal).
// Hand-tuned against SKEW_DELTA_THRESHOLD=1.5 vol pts and
// Z_SCORE_THRESHOLD=2.0σ with Z_WINDOW_SIZE=60 so the detector fires at
// the spec-listed timestamps with the spec-listed flag_reasons.
//
// Flat during 09:00–09:59 warmup (60 samples at exactly BASELINE_IV so
// computeRollingZ hits the stddev<1e-6 null guard and emits no Z-score
// flags pre-10:00). Anchor-driven rises kick in at 10:00 CT to stage
// the spec-listed detector flags.
const SPY_705P_IV_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0.24 }, // 09:00 flat
  { min: 59, value: 0.24 }, // 09:59 last flat minute
  { min: 60, value: 0.243 }, // 10:00 tiny drift begins
  { min: 85, value: 0.258 }, // 10:25 ramp ramps (ASK concentration)
  { min: 90, value: 0.264 }, // 10:30 — skew_delta fires (1.8 pts above neighbors)
  { min: 94, value: 0.265 }, // 10:34 gentle plateau
  { min: 120, value: 0.29 }, // 11:00 small bump
  { min: 152, value: 0.305 }, // 11:32
  { min: 155, value: 0.335 }, // 11:35 — biggest spike, z_score fires
  { min: 180, value: 0.28 }, // 12:00 flow flips
];

const SPY_704P_IV_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0.245 },
  { min: 59, value: 0.245 }, // 09:59 last flat minute
  { min: 60, value: 0.247 },
  { min: 95, value: 0.258 }, // 10:35 drifting up but below threshold
  { min: 100, value: 0.272 }, // 10:40 — skew_delta fires (~2.7 vp headroom)
  { min: 119, value: 0.282 }, // 10:59
  { min: 120, value: 0.315 }, // 11:00 — big spike (z_score + skew)
  { min: 180, value: 0.28 },
];

const QQQ_649P_IV_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0.28 },
  { min: 59, value: 0.28 }, // 09:59 last flat minute
  { min: 60, value: 0.283 },
  { min: 90, value: 0.292 },
  { min: 95, value: 0.305 }, // 10:35 — skew_delta fires
  { min: 119, value: 0.315 },
  { min: 120, value: 0.345 }, // 11:00 — z_score + skew
  { min: 180, value: 0.3 },
];

// Strike grids. SPY/QQQ are 1-wide; SPX is 5-wide. The target strikes
// (SPY 704/705, QQQ 649) live INSIDE these grids — ivForStrike()
// handles them specially via anchor lookups; everything else gets the
// flat baseline so the skew-delta math has a stable comparison set.
const SPY_PUT_STRIKES = [700, 701, 702, 703, 704, 705, 706, 707, 708];
const SPY_CALL_STRIKES = [715, 716, 717, 718];
const QQQ_PUT_STRIKES = [646, 647, 648, 649, 650, 651, 652];
const QQQ_CALL_STRIKES = [660, 661, 662];
const SPX_PUT_STRIKES = [7100, 7105, 7110, 7115, 7120];
const SPX_CALL_STRIKES = [7150, 7155, 7160];
// Expansion tickers: narrow flat grids bracketing each spot. Wide enough
// to exercise the skew_delta neighbor math (4-strike window on each side),
// narrow enough to stay inside ±3% OTM.
const IWM_PUT_STRIKES = [231, 232, 233, 234];
const IWM_CALL_STRIKES = [236, 237, 238, 239];
const TLT_PUT_STRIKES = [89, 90, 91];
const TLT_CALL_STRIKES = [93, 94, 95];
const XLF_PUT_STRIKES = [49, 50, 51];
const XLF_CALL_STRIKES = [53, 54, 55];
const XLE_PUT_STRIKES = [92, 93, 94];
const XLE_CALL_STRIKES = [96, 97, 98];
const XLK_PUT_STRIKES = [238, 239, 240, 241];
const XLK_CALL_STRIKES = [243, 244, 245, 246];

// ── Neighbor-strike noise (currently zero by design) ─────────
//
// We keep neighbor strikes perfectly flat. Any noise above the detector's
// stddev floor (1e-6) produces spurious Z-score flags on the flat strikes
// and muddies the regression signal. With zero noise, `computeRollingZ`
// returns null for non-target strikes (via the `stddev < 1e-6` guard),
// and `computeSkewDelta` returns ~0 — so neighbors never trip either
// gate. The only Z/skew flags in the replay come from the target strikes'
// anchor-driven trajectories.
//
// If we ever want to stress-test threshold sensitivity, add a seeded
// LCG here (keyed by ticker:strike:side:minute) with amplitude ≥ 1e-5;
// the Monte Carlo over seeds should still yield ≥5/6 alerts.
const NEIGHBOR_NOISE = 0 as const;

// ── Interpolation ────────────────────────────────────────────

function interpolate(
  anchors: readonly { min: number; value: number }[],
  minute: number,
): number {
  if (anchors.length === 0) throw new Error('empty anchors');
  if (minute <= anchors[0]!.min) return anchors[0]!.value;
  const last = anchors[anchors.length - 1]!;
  if (minute >= last.min) return last.value;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (minute >= a.min && minute <= b.min) {
      const t = (minute - a.min) / (b.min - a.min);
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

// ── Sample generation ────────────────────────────────────────

interface FixtureStrikeSample {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  iv_mid: number | null;
  iv_bid: number | null;
  iv_ask: number | null;
  ts: string;
}

function makeSample(
  ticker: string,
  strike: number,
  side: 'call' | 'put',
  ivMid: number,
  ts: string,
  isTarget: boolean,
): FixtureStrikeSample {
  // Target strikes get a wider ask-mid divergence to simulate the
  // ASK-side concentration flagged in the tape. 1 vol pt = 0.01.
  const askMidGap = isTarget ? 0.015 : 0.004;
  return {
    ticker,
    strike,
    side,
    expiry: EXPIRY,
    iv_mid: ivMid,
    iv_bid: Math.max(0.05, ivMid - askMidGap),
    iv_ask: ivMid + askMidGap,
    ts,
  };
}

type FixtureTicker = keyof typeof BASELINE_IV;

function ivForStrike(
  ticker: FixtureTicker,
  strike: number,
  side: 'call' | 'put',
  minute: number,
): { iv: number; isTarget: boolean } {
  const baseline = BASELINE_IV[ticker];

  // Target anchor lookup — only put side matters for this fixture.
  if (side === 'put') {
    if (ticker === 'SPY' && strike === 705) {
      return { iv: interpolate(SPY_705P_IV_ANCHORS, minute), isTarget: true };
    }
    if (ticker === 'SPY' && strike === 704) {
      return { iv: interpolate(SPY_704P_IV_ANCHORS, minute), isTarget: true };
    }
    if (ticker === 'QQQ' && strike === 649) {
      return { iv: interpolate(QQQ_649P_IV_ANCHORS, minute), isTarget: true };
    }
  }

  return { iv: baseline + NEIGHBOR_NOISE, isTarget: false };
}

// ── Spot interpolation ───────────────────────────────────────

function spotFor(ticker: FixtureTicker, minute: number): number {
  return interpolate(SPOT_ANCHORS[ticker], minute);
}

// ── Fixture build ────────────────────────────────────────────

interface Fixture {
  metadata: {
    date: string;
    description: string;
    windowStart: string;
    windowEnd: string;
    cadenceMinutes: number;
    zWarmupMinutes: number;
    replayStartCT: string;
  };
  spots: Record<string, Array<{ ts: string; value: number }>>;
  strikeSnapshots: Record<string, Record<string, FixtureStrikeSample[]>>;
  contextAtAnomalyPoints: Record<string, Partial<ContextStub>>;
  expectedAlerts: Array<{
    ct_time: string;
    utc_ts: string;
    ticker: string;
    strike: number;
    side: 'call' | 'put';
    expiry: string;
    required_flag_reasons: string[];
    expected_flow_phase_not: string[];
  }>;
}

/**
 * Trimmed ContextSnapshot shape — the classifier only consults
 * `vix_delta_15m`, so the fixture only pre-populates the fields a
 * downstream assertion might want. The test synthesizes the rest as
 * nulls when calling `classifyFlowPhase`.
 */
interface ContextStub {
  vix_delta_15m: number | null;
  vix_level: number | null;
  spot_delta_15m: number | null;
  spy_delta_15m: number | null;
  qqq_delta_15m: number | null;
}

function minuteToIso(minute: number): string {
  const start = Date.parse(WINDOW_START_UTC);
  return new Date(start + minute * 60_000).toISOString();
}

// Per-ticker strike-grid registry. Order matches production-side
// STRIKE_IV_TICKERS (indices first, ETFs after). Non-anomaly tickers
// are purely flat; their rows exist so the replayer exercises the same
// per-ticker iteration the live cron does.
const TICKER_STRIKE_GRIDS: ReadonlyArray<
  readonly [FixtureTicker, readonly number[], readonly number[]]
> = [
  ['SPX', SPX_PUT_STRIKES, SPX_CALL_STRIKES],
  ['SPY', SPY_PUT_STRIKES, SPY_CALL_STRIKES],
  ['QQQ', QQQ_PUT_STRIKES, QQQ_CALL_STRIKES],
  ['IWM', IWM_PUT_STRIKES, IWM_CALL_STRIKES],
  ['TLT', TLT_PUT_STRIKES, TLT_CALL_STRIKES],
  ['XLF', XLF_PUT_STRIKES, XLF_CALL_STRIKES],
  ['XLE', XLE_PUT_STRIKES, XLE_CALL_STRIKES],
  ['XLK', XLK_PUT_STRIKES, XLK_CALL_STRIKES],
];

function buildFixture(): Fixture {
  const totalMinutes =
    (Date.parse(WINDOW_END_UTC) - Date.parse(WINDOW_START_UTC)) / 60_000;

  const spots: Fixture['spots'] = {};
  for (const [ticker] of TICKER_STRIKE_GRIDS) {
    spots[ticker] = [];
  }
  const strikeSnapshots: Fixture['strikeSnapshots'] = {};

  for (let minute = 0; minute <= totalMinutes; minute += CADENCE_MINUTES) {
    const ts = minuteToIso(minute);
    for (const [ticker] of TICKER_STRIKE_GRIDS) {
      spots[ticker]!.push({ ts, value: spotFor(ticker, minute) });
    }

    const bucket: Record<string, FixtureStrikeSample[]> = {};

    for (const [ticker, putStrikes, callStrikes] of TICKER_STRIKE_GRIDS) {
      const rows: FixtureStrikeSample[] = [];
      for (const strike of putStrikes) {
        const { iv, isTarget } = ivForStrike(ticker, strike, 'put', minute);
        rows.push(makeSample(ticker, strike, 'put', iv, ts, isTarget));
      }
      for (const strike of callStrikes) {
        const { iv, isTarget } = ivForStrike(ticker, strike, 'call', minute);
        rows.push(makeSample(ticker, strike, 'call', iv, ts, isTarget));
      }
      bucket[ticker] = rows;
    }

    strikeSnapshots[ts] = bucket;
  }

  // Context at the six expected-alert timestamps. Classifier wants
  // vix_delta_15m low (quiet) at the early-column alerts, larger at the
  // mid-column alerts. `ask_mid_div` on the target strike already pushes
  // early-score via the flag's own ask_mid_div, so vix_delta_15m just
  // needs to not put reactive_score ahead.
  const contextAtAnomalyPoints: Record<string, Partial<ContextStub>> = {
    [minuteToIso(90)]: { vix_delta_15m: 0.1, vix_level: 16.2 }, // 10:30
    [minuteToIso(95)]: { vix_delta_15m: 0.15, vix_level: 16.25 }, // 10:35
    [minuteToIso(100)]: { vix_delta_15m: 0.18, vix_level: 16.3 }, // 10:40
    [minuteToIso(120)]: { vix_delta_15m: 0.4, vix_level: 16.7 }, // 11:00
    [minuteToIso(155)]: { vix_delta_15m: 0.5, vix_level: 17.1 }, // 11:35
  };

  // Ground-truth alert list (from spec).
  const expectedAlerts = [
    {
      ct_time: '10:30',
      utc_ts: minuteToIso(90),
      ticker: 'SPY',
      strike: 705,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta'],
      expected_flow_phase_not: ['reactive'],
    },
    {
      ct_time: '10:35',
      utc_ts: minuteToIso(95),
      ticker: 'QQQ',
      strike: 649,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta'],
      expected_flow_phase_not: ['reactive'],
    },
    {
      ct_time: '10:40',
      utc_ts: minuteToIso(100),
      ticker: 'SPY',
      strike: 704,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta'],
      expected_flow_phase_not: ['reactive'],
    },
    {
      ct_time: '11:00',
      utc_ts: minuteToIso(120),
      ticker: 'SPY',
      strike: 704,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta', 'z_score'],
      expected_flow_phase_not: ['reactive'],
    },
    {
      ct_time: '11:00',
      utc_ts: minuteToIso(120),
      ticker: 'QQQ',
      strike: 649,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta', 'z_score'],
      expected_flow_phase_not: ['reactive'],
    },
    {
      ct_time: '11:35',
      utc_ts: minuteToIso(155),
      ticker: 'SPY',
      strike: 705,
      side: 'put' as const,
      expiry: EXPIRY,
      required_flag_reasons: ['skew_delta', 'z_score'],
      expected_flow_phase_not: ['reactive'],
    },
  ];

  return {
    metadata: {
      date: '2026-04-23',
      description:
        'SPX 77pt flush from informed SPY/QQQ 0DTE put flow. Gold-standard ' +
        'regression fixture — IV anchors synthesized from the real-session ' +
        'tape table to produce the detector flags listed in the spec.',
      windowStart: WINDOW_START_UTC,
      windowEnd: WINDOW_END_UTC,
      cadenceMinutes: CADENCE_MINUTES,
      zWarmupMinutes: 60,
      replayStartCT: '10:00',
    },
    spots,
    strikeSnapshots,
    contextAtAnomalyPoints,
    expectedAlerts,
  };
}

export {
  buildFixture,
  type Fixture,
  type FixtureStrikeSample,
  type ContextStub,
};
