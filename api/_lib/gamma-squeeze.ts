/**
 * Gamma Squeeze Velocity Detector — sibling of the IV anomaly detector.
 *
 * Detects 0DTE gamma-squeeze setups where dealer hedging reflexivity
 * (not informed flow) drives near-ATM call/put prices to the strike.
 * Keys off **velocity** (rate of change in vol/OI over a 15-min trailing
 * window), not side concentration — so it catches the balanced-tape
 * setups the IV anomaly detector correctly filters out.
 *
 * Six gates, AND-combined:
 *   1. Velocity:     vol/OI added in last 15 min ≥ VEL_THRESHOLD
 *   2. Acceleration: current 15-min velocity ≥ ACCEL_RATIO × prior 15-min
 *   3. Proximity:    spot within ±PROX_PCT of strike on the OTM side
 *   4. Trend:        5-min spot move ≥ TREND_PCT in correct direction
 *   5. Time-of-day:  9:00–14:00 CT (gamma window — pre-charm-decay)
 *   6. NDG sign:     dealers net SHORT gamma at strike (when known)
 *
 * Pure module — no DB, no logger. Caller hands in the trailing window
 * grouped by (strike, side, expiry), and the NDG map (optional). Caller
 * persists firing flags into `gamma_squeeze_events`.
 *
 * See spec: docs/superpowers/specs/gamma-squeeze-velocity-detector-2026-04-28.md.
 */

// ── Public types ─────────────────────────────────────────────

/**
 * One per-minute snapshot in the trailing window. Caller queries
 * `strike_iv_snapshots` for the last ~45 min, groups by
 * `(strike, side, expiry)`, and feeds the per-key array (DESC by ts is
 * fine; we sort defensively).
 */
export interface SqueezeWindowSample {
  strike: number;
  side: 'call' | 'put';
  /** ISO date (YYYY-MM-DD). */
  expiry: string;
  /** ISO timestamp (UTC). */
  ts: string;
  /** Cumulative intraday volume. */
  volume: number;
  /** Start-of-day open interest. */
  oi: number;
  /** Underlying spot at this sample. */
  spot: number;
}

/** `${strike}:${side}:${expiry}` — same shape as IV anomaly detector. */
export function squeezeKey(
  strike: number,
  side: 'call' | 'put',
  expiry: string,
): string {
  return `${strike}:${side}:${expiry}`;
}

export type NetGammaSign = 'short' | 'long' | 'unknown';

export type SqueezePhase = 'forming' | 'active' | 'exhausted';

export interface SqueezeFlag {
  ticker: string;
  strike: number;
  side: 'call' | 'put';
  expiry: string;
  /** ISO timestamp of the latest sample in the window. */
  ts: string;
  spot_at_detect: number;
  /**
   * (spot - strike) / strike. Signed. Negative = spot below strike.
   * Calls fire near pct_from_strike in [-PROX_PCT, +0.005].
   * Puts fire near pct_from_strike in [-0.005, +PROX_PCT].
   */
  pct_from_strike: number;
  /** (spot_t - spot_{t-5m}) / spot_{t-5m}. Signed. */
  spot_trend_5m: number;
  /** vol/OI added in last 15 min. */
  vol_oi_15m: number;
  /** vol/OI added in the prior 15 min (for acceleration comparison). */
  vol_oi_15m_prior: number;
  /** vol_oi_15m - vol_oi_15m_prior. Always > 0 when emitted (gate). */
  vol_oi_acceleration: number;
  /** Cumulative vol/OI at detection (context, not a gate). */
  vol_oi_total: number;
  net_gamma_sign: NetGammaSign;
  squeeze_phase: SqueezePhase;
}

// ── Tunable constants (kept here, not in api/_lib/constants.ts, since
//    they're squeeze-specific and tunable from outcome data) ──────────

/** Minimum vol/OI added in last 15 min for the velocity gate. */
export const VEL_THRESHOLD = 5;
/**
 * Current 15-min velocity must be at least this multiple of the prior
 * 15-min velocity. > 1.0 means velocity is rising, not decaying.
 */
export const ACCEL_RATIO = 1.5;
/** Spot must be within ±PROX_PCT of strike on the OTM side. */
export const PROX_PCT = 0.015;
/**
 * Spot must have moved at least TREND_PCT in the correct direction over
 * the last 5 min (calls: positive, puts: negative).
 */
export const TREND_PCT = 0.0005;
/** Trading hours window (Central Time). */
export const TOD_START_HOUR_CT = 9;
export const TOD_END_HOUR_CT = 14;
/**
 * "Active" phase requires spot within this fraction of strike. Outside
 * this band but within PROX_PCT we're still "forming."
 */
export const ACTIVE_PROX_PCT = 0.005;

// ── Helpers ──────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Find the sample whose ts is at least `minutes` minutes BEFORE
 * `latestMs`. Samples are ascending by ts. Returns the most-recent
 * sample that satisfies the constraint, or null if none.
 */
function findSampleAtOrBefore(
  samples: readonly SqueezeWindowSample[],
  latestMs: number,
  minutes: number,
): SqueezeWindowSample | null {
  const cutoffMs = latestMs - minutes * 60_000;
  let best: SqueezeWindowSample | null = null;
  for (const s of samples) {
    const ms = Date.parse(s.ts);
    if (!Number.isFinite(ms)) continue;
    if (ms <= cutoffMs) {
      // Take the latest sample at-or-before the cutoff.
      if (best == null || ms > Date.parse(best.ts)) best = s;
    }
  }
  return best;
}

/**
 * Hour-of-day in CT (Central Time, accounting for DST). Returns a float
 * (e.g. 9.5 = 9:30 CT). Uses the JS Date with a fixed UTC offset of -5
 * for CST and -6 for CDT — but in practice we just use the UTC hour
 * minus 5 for CDT (March-November) and -6 for CST. For simplicity and
 * since this runs during US market hours, we use UTC-5 in DST and UTC-6
 * outside DST. The detector runs `* 13-21 UTC` which in CDT is 8-16 CT
 * and in CST is 7-15 CT — both span the gamma window, so the hour math
 * just needs to be DST-aware.
 */
export function ctHourOf(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return -1;
  // Use Intl to get the hour-of-day in Chicago, robust to DST.
  const chicagoHour = Number.parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      hour12: false,
    }).format(d),
    10,
  );
  const chicagoMin = Number.parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      minute: 'numeric',
    }).format(d),
    10,
  );
  if (Number.isNaN(chicagoHour) || Number.isNaN(chicagoMin)) return -1;
  // Intl's "hour: 'numeric'" with hour12=false returns 0-23 EXCEPT it
  // returns 24 for midnight in some locales — clamp.
  const hour = chicagoHour === 24 ? 0 : chicagoHour;
  return hour + chicagoMin / 60;
}

/**
 * Classify the squeeze phase from the firing-time signals.
 *
 *   - `active`    — velocity ≥ threshold AND spot within ACTIVE_PROX_PCT
 *                   of strike (the squeeze is fully engaged).
 *   - `forming`   — velocity ≥ threshold but spot still > ACTIVE_PROX_PCT
 *                   from strike (squeeze building, entry window).
 *   - `exhausted` — Reserved for downstream aggregator (caller decides
 *                   when a previously-firing key stops firing); never
 *                   emitted directly by the detector.
 */
function classifyPhase(absPctFromStrike: number): SqueezePhase {
  return absPctFromStrike <= ACTIVE_PROX_PCT ? 'active' : 'forming';
}

// ── detectGammaSqueezes ──────────────────────────────────────

/**
 * Run all six gates against a 45-min trailing window of per-strike
 * snapshots. Caller groups samples by `squeezeKey()` and provides:
 *
 *   - `windowByKey` — keyed by squeezeKey(strike, side, expiry), values
 *     are the full per-minute window (ascending or descending; we sort
 *     defensively). Caller is responsible for filtering to a single
 *     ticker.
 *   - `ticker` — stamped on every emitted flag.
 *   - `nowIso` — anchor for the time-of-day gate AND for finding
 *     samples at -5m / -15m / -30m offsets. Should match the cron's
 *     wall-clock start used in IV anomaly detection.
 *   - `ndgByStrike` — optional. When provided, populated for SPX/SPY/QQQ
 *     from `strike_exposures`. Single-name tickers pass an empty Map and
 *     all flags get `net_gamma_sign: 'unknown'`. Gate 6 only applies
 *     when sign is known: 'long' is filtered, 'short' or 'unknown' pass.
 *
 * Returns one `SqueezeFlag` per qualifying compound key. The caller is
 * responsible for de-duping repeat firings via the active-span pattern
 * used by the IV anomaly hook.
 */
export function detectGammaSqueezes(
  windowByKey: Map<string, SqueezeWindowSample[]>,
  ticker: string,
  nowIso: string,
  ndgByStrike: Map<number, number>,
): SqueezeFlag[] {
  const flags: SqueezeFlag[] = [];
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return flags;

  // Gate 5: time-of-day. Cheap reject for the whole batch.
  const ctHour = ctHourOf(nowIso);
  if (ctHour < TOD_START_HOUR_CT || ctHour >= TOD_END_HOUR_CT) return flags;

  for (const [, rawSamples] of windowByKey) {
    if (rawSamples.length < 4) continue; // Need at least 4 samples for 30-min lookback.

    // Sort ascending by ts so lookback functions get a stable order.
    const samples = [...rawSamples].sort(
      (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
    );
    const latest = samples.at(-1)!;
    const latestMs = Date.parse(latest.ts);
    if (!Number.isFinite(latestMs)) continue;
    if (!isFiniteNumber(latest.spot) || latest.spot <= 0) continue;
    if (!isFiniteNumber(latest.oi) || latest.oi <= 0) continue;
    if (!isFiniteNumber(latest.volume)) continue;

    // Lookback windows.
    const t5 = findSampleAtOrBefore(samples, latestMs, 5);
    const t15 = findSampleAtOrBefore(samples, latestMs, 15);
    const t30 = findSampleAtOrBefore(samples, latestMs, 30);
    if (!t5 || !t15 || !t30) continue;

    // Gate 1: velocity. vol/OI added in last 15 min.
    const velocity = (latest.volume - t15.volume) / latest.oi;
    if (!Number.isFinite(velocity) || velocity < VEL_THRESHOLD) continue;

    // Gate 2: acceleration. Current 15-min velocity must be ≥ ACCEL_RATIO
    // × prior 15-min. Special case: prior velocity ≤ 0 (no prints in
    // that window) → ratio is infinite → pass automatically (means
    // velocity just turned on).
    const priorVelocity = (t15.volume - t30.volume) / latest.oi;
    if (priorVelocity > 0 && velocity < priorVelocity * ACCEL_RATIO) continue;

    // Gate 3: proximity. Spot within ±PROX_PCT of strike, on the OTM
    // side appropriate for the option side. We allow a small "just past"
    // band (0.5%) so contracts that just pierced the strike still fire.
    const pctFromStrike = (latest.spot - latest.strike) / latest.strike;
    if (latest.side === 'call') {
      // Calls: spot below strike (negative pct), allowed up to PROX_PCT
      // below and a sliver above (just-pierced).
      if (pctFromStrike < -PROX_PCT) continue;
      if (pctFromStrike > 0.005) continue;
    } else {
      // Puts: mirror — spot above strike, allowed up to PROX_PCT above
      // and a sliver below (just-pierced).
      if (pctFromStrike > PROX_PCT) continue;
      if (pctFromStrike < -0.005) continue;
    }

    // Gate 4: trend. Spot moving toward strike over last 5 min.
    if (!isFiniteNumber(t5.spot) || t5.spot <= 0) continue;
    const trend = (latest.spot - t5.spot) / t5.spot;
    if (latest.side === 'call' && trend < TREND_PCT) continue;
    if (latest.side === 'put' && trend > -TREND_PCT) continue;

    // Gate 6: NDG sign. Skip when dealers are net-LONG gamma at the
    // strike (their hedging dampens moves). Unknown passes.
    const ndg = ndgByStrike.get(latest.strike);
    let ndgSign: NetGammaSign;
    if (ndg == null || !Number.isFinite(ndg)) {
      ndgSign = 'unknown';
    } else if (ndg < 0) {
      ndgSign = 'short';
    } else {
      ndgSign = 'long';
    }
    if (ndgSign === 'long') continue;

    const acceleration = velocity - priorVelocity;
    const volOiTotal = latest.volume / latest.oi;
    const phase = classifyPhase(Math.abs(pctFromStrike));

    flags.push({
      ticker,
      strike: latest.strike,
      side: latest.side,
      expiry: latest.expiry,
      ts: latest.ts,
      spot_at_detect: latest.spot,
      pct_from_strike: pctFromStrike,
      spot_trend_5m: trend,
      vol_oi_15m: velocity,
      vol_oi_15m_prior: priorVelocity,
      vol_oi_acceleration: acceleration,
      vol_oi_total: volOiTotal,
      net_gamma_sign: ndgSign,
      squeeze_phase: phase,
    });
  }

  return flags;
}
