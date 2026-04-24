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
 *   - **Tickers** (post 2026-04-24 single-name expansion): SPY (target),
 *     QQQ (target), plus SPXW / NDXP / IWM / NVDA / SNDK as quiet
 *     baselines. SPY/QQQ put-side targets produce the anomalies; the
 *     other five stay flat so any flag from them indicates a noise-
 *     generator regression or a stddev-floor bug.
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
 *   - **Volume / OI** (new 2026-04-24 field): the detector now gates on
 *     vol/OI ≥ 5.0×. Target strikes ramp from ~1× early to ~50× by noon
 *     (anchored to the real-session tape table: SPY 705P closed ~454K
 *     volume on 9.1K OI, ≈ 50×). Non-target strikes stay at a flat 1.5×
 *     baseline — well under the gate — so they never leak into anomaly
 *     output regardless of IV trajectory.
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
// for target strikes). Derived from typical 0DTE OTM put IV range. Quiet
// tickers (SPXW / NDXP / IWM / NVDA / SNDK) ship purely flat — exact
// values are not load-bearing for the regression, only that no flags emit
// when every strike sits at a constant IV. Single-name tech baselines
// reflect their higher realized vol vs indices (NVDA ~0.45, SNDK ~0.55).
const BASELINE_IV = {
  SPY: 0.24,
  QQQ: 0.28,
  SPXW: 0.22,
  NDXP: 0.25,
  IWM: 0.26,
  NVDA: 0.45,
  SNDK: 0.55,
} as const;

// Ticker spot at key times. Linear-interpolated minute-by-minute. These
// match the spec's "Observed tape" table (SPY/QQQ spots; SPXW derived
// from the 77pt SPX flush: 7147 → 7070 between 11:50 and 13:00).
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
  SPXW: [
    { min: 0, value: 7140 },
    { min: 60, value: 7142 }, // 10:00
    { min: 120, value: 7138 }, // 11:00
    { min: 170, value: 7147 }, // 11:50 (pre-flush peak)
    { min: 180, value: 7135 }, // 12:00 (flush begins)
  ],
  // Quiet-ticker baselines — single anchor = constant across the
  // window; `interpolate()` falls through to the last anchor for any
  // minute ≥ 0 so one entry is enough.
  NDXP: [{ min: 0, value: 22500 }],
  IWM: [{ min: 0, value: 235 }],
  // NVDA and SNDK pinned at plausible 2026-04-24 spots — exact values
  // aren't load-bearing since these strikes stay flat at baseline IV and
  // never approach the vol/OI gate.
  NVDA: [{ min: 0, value: 210 }],
  SNDK: [{ min: 0, value: 140 }],
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

// Strike grids. SPY/QQQ are 1-wide; SPXW / NDXP are 5-wide (cash-index
// weeklies). The target strikes (SPY 704/705, QQQ 649) live INSIDE these
// grids — ivForStrike() handles them specially via anchor lookups;
// everything else gets the flat baseline so the skew-delta math has a
// stable comparison set.
const SPY_PUT_STRIKES = [700, 701, 702, 703, 704, 705, 706, 707, 708];
const SPY_CALL_STRIKES = [715, 716, 717, 718];
const QQQ_PUT_STRIKES = [646, 647, 648, 649, 650, 651, 652];
const QQQ_CALL_STRIKES = [660, 661, 662];
// Quiet-ticker grids: wide enough to exercise the skew_delta neighbor
// math (≥4-strike window on each side), narrow enough to stay inside
// ±3% OTM.
const SPXW_PUT_STRIKES = [7100, 7105, 7110, 7115, 7120];
const SPXW_CALL_STRIKES = [7150, 7155, 7160];
const NDXP_PUT_STRIKES = [22300, 22350, 22400, 22450];
const NDXP_CALL_STRIKES = [22600, 22650, 22700, 22750];
const IWM_PUT_STRIKES = [231, 232, 233, 234];
const IWM_CALL_STRIKES = [236, 237, 238, 239];
// NVDA is $2.5-wide near ATM (210 spot → 205/207.5/etc.). Fixture uses a
// handful of OTM strikes on each side, all quiet.
const NVDA_PUT_STRIKES = [205, 206, 207, 208];
const NVDA_CALL_STRIKES = [212, 213, 214, 215];
// SNDK is $5-wide (140 spot). Quiet baseline, well below vol/OI gate.
const SNDK_PUT_STRIKES = [130, 132, 135, 137];
const SNDK_CALL_STRIKES = [142, 145, 147, 150];

// ── Target-strike volume ramps ───────────────────────────────
//
// Real-session anchors from the 2026-04-23 SPY 705P tape: opened at ≈ 9.1K
// OI, cumulative volume ramped from effectively 0 at 09:00 to ~454K by
// 15:00 close (≈ 50× by EOD). The detector gate fires at 5×, which is
// crossed around 10:30 CT when the informed ASK concentration shows up.
// We anchor the volume curve so:
//   * First spec alert (10:30) fires right at ~5.2× (barely clears gate)
//   * Mid alerts (10:35–11:00) run 10-25×
//   * Late alert (11:35) peaks near ~40× (closer to EOD)
// OI stays constant at start-of-session value (strike_iv_snapshots stores
// start-of-day OI).
const SPY_705P_OI = 9100;
const SPY_705P_VOLUME_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0 },
  { min: 59, value: 9000 }, // 09:59 ≈ 1.0× (below gate)
  { min: 60, value: 9500 }, // 10:00 ≈ 1.05× (still below gate)
  { min: 85, value: 35000 }, // 10:25 ≈ 3.85× (pre-gate)
  { min: 90, value: 48000 }, // 10:30 ≈ 5.27× (gate clears)
  { min: 120, value: 150000 }, // 11:00 ≈ 16.5×
  { min: 155, value: 330000 }, // 11:35 ≈ 36.3× (peak firing window)
  { min: 180, value: 400000 }, // 12:00 ≈ 44×
];

const SPY_704P_OI = 7800;
const SPY_704P_VOLUME_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0 },
  { min: 59, value: 7500 }, // 09:59 ≈ 0.96×
  { min: 60, value: 8000 }, // 10:00 ≈ 1.03×
  { min: 95, value: 35000 }, // 10:35 ≈ 4.5× (still below gate)
  { min: 100, value: 50000 }, // 10:40 ≈ 6.4× (gate clears)
  { min: 119, value: 95000 }, // 10:59 ≈ 12.2×
  { min: 120, value: 120000 }, // 11:00 ≈ 15.4×
  { min: 180, value: 300000 }, // 12:00 ≈ 38.5×
];

const QQQ_649P_OI = 4200;
const QQQ_649P_VOLUME_ANCHORS: readonly { min: number; value: number }[] = [
  { min: 0, value: 0 },
  { min: 59, value: 4100 }, // 09:59 ≈ 0.98×
  { min: 60, value: 4500 }, // 10:00 ≈ 1.07×
  { min: 90, value: 12000 }, // 10:30 ≈ 2.86×
  { min: 95, value: 24000 }, // 10:35 ≈ 5.71× (gate clears)
  { min: 119, value: 45000 }, // 10:59 ≈ 10.7×
  { min: 120, value: 55000 }, // 11:00 ≈ 13.1×
  { min: 180, value: 140000 }, // 12:00 ≈ 33×
];

// Quiet-strike volume anchor. All non-target strikes share this constant
// ratio (~1.5× — well under the 5× gate) so they never clear the primary
// filter regardless of any IV noise. Uses `OI = 1000` / `volume = 1500`
// so the ratio math is trivially ~1.5 and obviously below threshold.
const QUIET_OI = 1000;
const QUIET_VOLUME = 1500;

// ── Neighbor-strike noise (currently zero by design) ─────────
//
// We keep neighbor strikes perfectly flat. Any noise above the detector's
// stddev floor (1e-6) produces spurious Z-score flags on the flat strikes
// and muddies the regression signal. With zero noise, `computeRollingZ`
// returns null for non-target strikes (via the `stddev < 1e-6` guard),
// and `computeSkewDelta` returns ~0 — so neighbors never trip either
// gate. The only Z/skew flags in the replay come from the target strikes'
// anchor-driven trajectories. The vol/OI gate adds a second belt-and-
// suspenders: quiet strikes also sit at ~1.5× vol/OI, below the 5× cut.
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
  /** Cumulative intraday volume — primary-gate input. */
  volume: number | null;
  /** Start-of-day OI — primary-gate input (stable across the session). */
  oi: number | null;
  ts: string;
}

function makeSample(
  ticker: string,
  strike: number,
  side: 'call' | 'put',
  ivMid: number,
  ts: string,
  isTarget: boolean,
  volume: number,
  oi: number,
): FixtureStrikeSample {
  // Target strikes get an asymmetric, ASK-dominant bid-ask spread to
  // simulate the real-session 705P tape (97% ask during accumulation).
  // ask_skew = (iv_ask - iv_mid) / (iv_ask - iv_bid)
  //          = 0.020 / (0.020 + 0.005) = 0.80 → clears the 0.65 side-skew
  // gate. Non-targets get a balanced narrow spread (ask_skew ≈ 0.5) which
  // would FAIL the gate on its own — but they also fail the vol/OI gate
  // upstream, so the side-skew gate never evaluates them.
  const askMidGap = isTarget ? 0.02 : 0.004;
  const midBidGap = isTarget ? 0.005 : 0.004;
  return {
    ticker,
    strike,
    side,
    expiry: EXPIRY,
    iv_mid: ivMid,
    iv_bid: Math.max(0.05, ivMid - midBidGap),
    iv_ask: ivMid + askMidGap,
    volume,
    oi,
    ts,
  };
}

type FixtureTicker = keyof typeof BASELINE_IV;

interface TargetPayload {
  iv: number;
  volume: number;
  oi: number;
  isTarget: true;
}

interface QuietPayload {
  iv: number;
  volume: number;
  oi: number;
  isTarget: false;
}

type StrikePayload = TargetPayload | QuietPayload;

function payloadForStrike(
  ticker: FixtureTicker,
  strike: number,
  side: 'call' | 'put',
  minute: number,
): StrikePayload {
  const baseline = BASELINE_IV[ticker];

  // Target anchor lookup — only put side matters for this fixture.
  if (side === 'put') {
    if (ticker === 'SPY' && strike === 705) {
      return {
        iv: interpolate(SPY_705P_IV_ANCHORS, minute),
        volume: interpolate(SPY_705P_VOLUME_ANCHORS, minute),
        oi: SPY_705P_OI,
        isTarget: true,
      };
    }
    if (ticker === 'SPY' && strike === 704) {
      return {
        iv: interpolate(SPY_704P_IV_ANCHORS, minute),
        volume: interpolate(SPY_704P_VOLUME_ANCHORS, minute),
        oi: SPY_704P_OI,
        isTarget: true,
      };
    }
    if (ticker === 'QQQ' && strike === 649) {
      return {
        iv: interpolate(QQQ_649P_IV_ANCHORS, minute),
        volume: interpolate(QQQ_649P_VOLUME_ANCHORS, minute),
        oi: QQQ_649P_OI,
        isTarget: true,
      };
    }
  }

  return {
    iv: baseline + NEIGHBOR_NOISE,
    volume: QUIET_VOLUME,
    oi: QUIET_OI,
    isTarget: false,
  };
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
// STRIKE_IV_TICKERS (weekly-index roots first, ETFs after). Non-target
// tickers are purely flat; their rows exist so the replayer exercises
// the same per-ticker iteration the live cron does.
const TICKER_STRIKE_GRIDS: ReadonlyArray<
  readonly [FixtureTicker, readonly number[], readonly number[]]
> = [
  ['SPXW', SPXW_PUT_STRIKES, SPXW_CALL_STRIKES],
  ['NDXP', NDXP_PUT_STRIKES, NDXP_CALL_STRIKES],
  ['SPY', SPY_PUT_STRIKES, SPY_CALL_STRIKES],
  ['QQQ', QQQ_PUT_STRIKES, QQQ_CALL_STRIKES],
  ['IWM', IWM_PUT_STRIKES, IWM_CALL_STRIKES],
  ['NVDA', NVDA_PUT_STRIKES, NVDA_CALL_STRIKES],
  ['SNDK', SNDK_PUT_STRIKES, SNDK_CALL_STRIKES],
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
        const payload = payloadForStrike(ticker, strike, 'put', minute);
        rows.push(
          makeSample(
            ticker,
            strike,
            'put',
            payload.iv,
            ts,
            payload.isTarget,
            payload.volume,
            payload.oi,
          ),
        );
      }
      for (const strike of callStrikes) {
        const payload = payloadForStrike(ticker, strike, 'call', minute);
        rows.push(
          makeSample(
            ticker,
            strike,
            'call',
            payload.iv,
            ts,
            payload.isTarget,
            payload.volume,
            payload.oi,
          ),
        );
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
        'regression fixture — IV anchors + vol/OI ramps synthesized from ' +
        'the real-session tape table to produce the detector flags ' +
        'listed in the spec. Quiet tickers (SPXW / NDXP / IWM / NVDA / ' +
        'SNDK) ship flat so any flag from them indicates a regression.',
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
