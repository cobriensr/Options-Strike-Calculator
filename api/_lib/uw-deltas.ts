/**
 * UW Deltas — compute-on-demand rate-of-change signals derived from
 * Unusual Whales data already ingested into Neon by existing crons.
 *
 * Phase 5b (2026-04-19) turns four raw UW data streams into delta /
 * velocity / cumulative-net summaries for Claude's analyze context.
 * Same architectural pattern as Phase 2b (`microstructure-signals.ts`)
 * — pure compute layer, no cron, no external API call, no snapshot
 * table.
 *
 * ── Source tables (verified against migrations + cron handlers) ──
 *
 *   1. `dark_pool_levels` (migration id 22, `fetch-darkpool.ts`)
 *      Columns: date, spx_approx, total_premium, trade_count,
 *               total_shares, buyer_initiated, seller_initiated,
 *               neutral, latest_time, updated_at
 *      Shape: aggregated per (date, spx_approx). ON CONFLICT UPDATE
 *      keeps running totals — there is NO per-print row history.
 *      `latest_time` is the newest print time for that strike cluster.
 *      Cron runs every minute during RTH.
 *
 *      Ingest-time filtering already strips: canceled, ext_hours,
 *      average_price_trade, derivative_priced, contingent_trade,
 *      and anything outside 08:30–15:00 CT. Query-time we do NOT
 *      re-apply those filters — the rows in the table are clean.
 *
 *      Because the table is aggregated, "velocity" here is measured
 *      as "distinct strike clusters that received prints in the last
 *      5 minutes" rather than "per-print count". The z-score compares
 *      the latest 5-min window to a rolling baseline of the same
 *      metric, so the proxy is internally consistent.
 *
 *   2. `spot_exposures` (migration id 7, `fetch-spot-gex.ts`)
 *      Columns: date, timestamp, ticker, price,
 *               gamma_oi, gamma_vol, gamma_dir,
 *               charm_oi, charm_vol, charm_dir,
 *               vanna_oi, vanna_vol, vanna_dir
 *      Shape: intraday time-series per (date, timestamp, ticker).
 *      `gamma_oi` is the OI-based aggregate gamma — the Rule-16
 *      regime variable — written every 5 minutes by the cron.
 *      UNIQUE(date, timestamp, ticker) so each snapshot persists.
 *
 *      This is the right source for GEX intraday delta (the
 *      `greek_exposure` table UPSERTs a single daily row and is
 *      therefore unsuitable).
 *
 *   3. `flow_alerts` (migration id 59, `fetch-flow-alerts.ts`)
 *      Columns include: created_at, type ('call'|'put'),
 *                       total_premium, ticker, expiry, strike
 *      Shape: one row per UW RepeatedHits alert. Already filtered to
 *      SPXW 0-1 DTE index alerts at ingest. No further filtering
 *      needed at query time — every row is a "whale print".
 *
 *   4. `flow_data` (migration id 6, `fetch-etf-tide.ts`)
 *      Columns: date, timestamp, source, ncp, npp, net_volume
 *      Sources include: 'spy_etf_tide', 'qqq_etf_tide'
 *      Shape: 5-minute candles. Each row is cumulative NCP/NPP for
 *      the ticker's underlying holdings. Use `ncp + npp` as the
 *      "net premium flow" proxy for tide divergence.
 *
 * ── Signal definitions ──
 *
 *   1. Dark pool velocity
 *      - count_5m = distinct strike clusters updated in last 5 min
 *      - baseline = 12 non-overlapping 5-min buckets over last 60 min
 *      - z = (count_5m - mean(baseline)) / stddev(baseline)
 *      - SURGE z > 2, DROUGHT z < -2, NORMAL otherwise.
 *      - null when baseline has fewer than MIN_BAR_COUNT_FOR_ZSCORE
 *        non-zero windows or stddev is zero.
 *
 *   2. GEX intraday delta
 *      - gex_open  = earliest gamma_oi with timestamp >= today 13:30 UTC
 *      - gex_now   = latest gamma_oi for today
 *      - delta_pct = (now - open) / |open|
 *      - STRENGTHENING abs(pct) > 20% AND same sign as open
 *      - WEAKENING    abs(pct) > 20% AND opposite sign or halved
 *      - STABLE otherwise
 *      - null when either bound missing or |open| == 0.
 *
 *   3. Whale flow net positioning
 *      - sum premium today where type='call' (calls)
 *      - sum premium today where type='put'  (puts)
 *      - net  = calls - puts
 *      - ratio = (calls - puts) / (calls + puts) ∈ [-1, +1]
 *      - AGGRESSIVE_CALL_BIAS ratio > 0.4 AND total > $5M
 *      - AGGRESSIVE_PUT_BIAS  ratio < -0.4 AND total > $5M
 *      - BALANCED otherwise
 *      - null when zero whale alerts today.
 *
 *   4. ETF tide divergence (SPY + QQQ)
 *      - spy_delta = latest(ncp+npp) - earliest(ncp+npp) today
 *      - qqq_delta = same for QQQ
 *      - SPY_LEADING_BULL   spy > +$X AND qqq < -$X
 *      - QQQ_LEADING_BEAR   qqq < -$Y AND spy >= 0
 *      - ALIGNED_RISK_ON    both > +threshold
 *      - ALIGNED_RISK_OFF   both < -threshold
 *      - MIXED otherwise
 *      - null when either tide is missing or empty today.
 *
 * All four compute helpers run in parallel via `Promise.allSettled` so
 * one stale source cannot suppress the others. Top-level null is
 * returned only when every individual signal is null — partial
 * coverage renders with "N/A" for the missing components.
 */

import { getDb } from './db.js';
import { getETDateStr } from '../../src/utils/timezone.js';

// ── Configuration ─────────────────────────────────────────────

/** Dark pool velocity window + baseline. */
const DP_VELOCITY_WINDOW_MS = 5 * 60 * 1000;
const DP_VELOCITY_LOOKBACK_BUCKETS = 12; // 12 × 5m = 60m
const DP_VELOCITY_SURGE_Z = 2.0;
const DP_VELOCITY_DROUGHT_Z = -2.0;

/**
 * Minimum absolute (count5m - baselineMean) magnitude before SURGE or
 * DROUGHT fires, in addition to the z-score threshold. Prevents
 * low-denominator false positives: a baseline of mean=2 std=0.5 yields
 * z=2.0 at count=3, but that's +1 cluster — noise, not a surge.
 *
 * Also compensates for an ingest-side bias in `dark_pool_levels`: each
 * strike cluster's `latest_time` is UPSERTed with GREATEST(), so a
 * cluster that reprints within the 60-min window appears only in the
 * MOST RECENT bucket it touched. The baseline is systematically
 * under-counted relative to bucket 0, which inflates z-scores in both
 * directions. The absolute-delta floor gates that noise.
 */
const DP_VELOCITY_SURGE_MIN_ABSOLUTE_DELTA = 3;

/**
 * Minimum non-zero baseline buckets before z-score is meaningful.
 * Below this, stddev is dominated by the single active bucket and the
 * z-score blows up or collapses to ±Infinity.
 */
const MIN_BAR_COUNT_FOR_ZSCORE = 10;

/** GEX intraday delta classification thresholds. */
const GEX_INTRADAY_STRENGTHEN_PCT = 0.2; // 20% move in same direction

/** Whale flow classification thresholds. */
const WHALE_NET_RATIO_AGGRESSIVE = 0.4;
const WHALE_PREMIUM_MIN_FLOOR = 5_000_000; // $5M total floor

/**
 * ETF tide divergence threshold ($). Placeholder per spec — revisit
 * after a week of live observation to calibrate against the 80th
 * percentile of historical absolute deltas.
 */
const ETF_TIDE_DELTA_THRESHOLD = 50_000_000;

/** RTH session anchor (13:30 UTC = 08:30 CT = 09:30 ET). */
const RTH_OPEN_HOUR_UTC = 13;
const RTH_OPEN_MINUTE_UTC = 30;

// ── Types ─────────────────────────────────────────────────────

export type DarkPoolVelocityClassification = 'SURGE' | 'DROUGHT' | 'NORMAL';
export type GexIntradayClassification =
  | 'STRENGTHENING'
  | 'WEAKENING'
  | 'STABLE';
export type WhaleFlowClassification =
  | 'AGGRESSIVE_CALL_BIAS'
  | 'AGGRESSIVE_PUT_BIAS'
  | 'BALANCED';
export type EtfTideClassification =
  | 'SPY_LEADING_BULL'
  | 'QQQ_LEADING_BEAR'
  | 'ALIGNED_RISK_ON'
  | 'ALIGNED_RISK_OFF'
  | 'MIXED';

export interface DarkPoolVelocity {
  count5m: number;
  baselineMean: number;
  baselineStd: number;
  zscore: number;
  classification: DarkPoolVelocityClassification;
}

export interface GexIntradayDelta {
  gexOpen: number;
  gexNow: number;
  deltaPct: number;
  classification: GexIntradayClassification;
}

export interface WhaleFlowPositioning {
  callPremium: number;
  putPremium: number;
  netPremium: number;
  netRatio: number;
  classification: WhaleFlowClassification;
}

export interface EtfTideDivergence {
  spyDelta: number;
  qqqDelta: number;
  classification: EtfTideClassification;
}

export interface UwDeltas {
  darkPool: DarkPoolVelocity | null;
  gex: GexIntradayDelta | null;
  whaleFlow: WhaleFlowPositioning | null;
  etfTide: EtfTideDivergence | null;
  computedAt: string;
}

// ── Internal helpers ──────────────────────────────────────────

type Numeric = string | number | null;

/**
 * Build the RTH-open timestamp for the ET date containing `now`, as
 * an ISO-UTC string. The analyze endpoint runs during the US cash
 * session; anchoring to 13:30 UTC on the current ET date gives the
 * canonical session-open cutoff for GEX intraday queries.
 */
function rthOpenIsoFor(now: Date): string {
  const etDateStr = getETDateStr(now);
  // etDateStr is YYYY-MM-DD (ET). 13:30 UTC that day = 08:30 CT ≈
  // 09:30 ET (standard) / 08:30 ET (DST). The cash session opens at
  // 09:30 ET which varies between 13:30 and 14:30 UTC depending on
  // DST. We use 13:30 UTC as the "earliest candidate" anchor: spot_
  // exposures rows stamped after this point are in-session. During
  // DST we pick up a harmless extra hour of possible pre-open data,
  // but spot_exposures is only written during market-hours crons so
  // those buckets are empty in practice.
  const hh = String(RTH_OPEN_HOUR_UTC).padStart(2, '0');
  const mm = String(RTH_OPEN_MINUTE_UTC).padStart(2, '0');
  return `${etDateStr}T${hh}:${mm}:00.000Z`;
}

/**
 * Population stddev. Matches the shape used in
 * microstructure-signals — each per-bucket observation is treated as
 * a population sample of "bucket count at time K", not a sample from
 * a meta-distribution.
 */
function populationStd(values: number[], mean: number): number {
  const n = values.length;
  if (n === 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

// ── 1. Dark pool velocity ─────────────────────────────────────

interface DpBucketRow {
  bucket_index: Numeric;
  strike_count: Numeric;
}

/**
 * Compute dark pool velocity via a single parameterized SQL query that
 * buckets `latest_time` into 5-minute windows over the last 60 minutes
 * and counts distinct `spx_approx` rows per bucket. Bucket 0 is the
 * current 5-min window; buckets 1..12 are the baseline.
 */
export async function computeDarkPoolVelocity(
  now: Date,
): Promise<DarkPoolVelocity | null> {
  const sql = getDb();
  const lookbackMs = DP_VELOCITY_WINDOW_MS * (DP_VELOCITY_LOOKBACK_BUCKETS + 1);
  const earliestIso = new Date(now.getTime() - lookbackMs).toISOString();
  const nowIso = now.toISOString();
  const windowMs = DP_VELOCITY_WINDOW_MS;

  const rows = (await sql`
    SELECT
      FLOOR(EXTRACT(EPOCH FROM (${nowIso}::timestamptz - latest_time)) * 1000 / ${windowMs})::int AS bucket_index,
      COUNT(DISTINCT spx_approx) AS strike_count
    FROM dark_pool_levels
    WHERE latest_time > ${earliestIso}
      AND latest_time <= ${nowIso}
    GROUP BY 1
  `) as DpBucketRow[];

  if (rows.length === 0) return null;

  // Initialize all buckets to 0 so empty buckets count as real zeros
  // in the baseline. Bucket 0 = current 5m; 1..DP_VELOCITY_LOOKBACK_BUCKETS
  // = baseline.
  const bucketCounts = new Array<number>(DP_VELOCITY_LOOKBACK_BUCKETS + 1).fill(
    0,
  );
  for (const r of rows) {
    const idx = Number.parseInt(String(r.bucket_index ?? -1), 10);
    const count = Number.parseInt(String(r.strike_count ?? 0), 10);
    if (
      Number.isFinite(idx) &&
      idx >= 0 &&
      idx <= DP_VELOCITY_LOOKBACK_BUCKETS &&
      Number.isFinite(count)
    ) {
      bucketCounts[idx] = count;
    }
  }

  const count5m = bucketCounts[0]!;
  const baseline = bucketCounts.slice(1); // buckets 1..N

  // Signal strength gate: need enough baseline coverage. "Non-zero"
  // is the interesting metric — a long run of dead buckets gives
  // stddev=0 and the z-score collapses regardless.
  const nonZeroBaselineCount = baseline.filter((c) => c > 0).length;
  if (nonZeroBaselineCount < MIN_BAR_COUNT_FOR_ZSCORE) return null;

  const baselineMean =
    baseline.reduce((acc, c) => acc + c, 0) / baseline.length;
  const baselineStd = populationStd(baseline, baselineMean);
  if (!Number.isFinite(baselineStd) || baselineStd === 0) return null;

  const zscore = (count5m - baselineMean) / baselineStd;
  if (!Number.isFinite(zscore)) return null;

  const classification = classifyDarkPoolVelocity({
    count5m,
    baselineMean,
    zscore,
  });

  return {
    count5m,
    baselineMean,
    baselineStd,
    zscore,
    classification,
  };
}

/**
 * Classify dark pool velocity. Requires BOTH the z-score threshold
 * AND an absolute-count-delta floor — a z=2.0 spike at +1 cluster
 * above a mean of 2 is noise, not institutional activity. The
 * absolute-delta floor also compensates for the known ingest-side
 * baseline under-count (see `DP_VELOCITY_SURGE_MIN_ABSOLUTE_DELTA`).
 *
 * Exported for direct unit-test coverage.
 */
export function classifyDarkPoolVelocity(input: {
  count5m: number;
  baselineMean: number;
  zscore: number;
}): DarkPoolVelocityClassification {
  const { count5m, baselineMean, zscore } = input;
  const absDelta = count5m - baselineMean;
  const floor = DP_VELOCITY_SURGE_MIN_ABSOLUTE_DELTA;

  if (zscore > DP_VELOCITY_SURGE_Z && absDelta >= floor) return 'SURGE';
  if (zscore < DP_VELOCITY_DROUGHT_Z && -absDelta >= floor) return 'DROUGHT';
  return 'NORMAL';
}

// ── 2. GEX intraday delta ─────────────────────────────────────

interface GexOpenNowRow {
  gex_open: Numeric;
  gex_now: Numeric;
}

/**
 * Compute GEX intraday delta from `spot_exposures.gamma_oi` — the
 * OI-based aggregate gamma used for Rule 16 regime classification.
 *
 * Single aggregate query using FILTER clauses: first in-session
 * value (earliest timestamp ≥ RTH open) and last in-session value
 * (latest timestamp today). Both read in one round trip.
 */
export async function computeGexIntradayDelta(
  now: Date,
): Promise<GexIntradayDelta | null> {
  const sql = getDb();
  const etDate = getETDateStr(now);
  const rthOpenIso = rthOpenIsoFor(now);

  // Use a CTE that orders rows by timestamp and picks first/last.
  // Postgres does not expose FIRST_VALUE/LAST_VALUE directly as
  // aggregates, so a min/max CTE is cleaner than two window calls.
  const rows = (await sql`
    WITH today_rows AS (
      SELECT timestamp, gamma_oi
      FROM spot_exposures
      WHERE date = ${etDate}
        AND ticker = 'SPX'
        AND timestamp >= ${rthOpenIso}
    )
    SELECT
      (SELECT gamma_oi FROM today_rows
         ORDER BY timestamp ASC LIMIT 1) AS gex_open,
      (SELECT gamma_oi FROM today_rows
         ORDER BY timestamp DESC LIMIT 1) AS gex_now
  `) as GexOpenNowRow[];

  if (rows.length === 0) return null;
  const row = rows[0]!;
  const gexOpenRaw = row.gex_open;
  const gexNowRaw = row.gex_now;
  if (gexOpenRaw == null || gexNowRaw == null) return null;

  const gexOpen = Number.parseFloat(String(gexOpenRaw));
  const gexNow = Number.parseFloat(String(gexNowRaw));
  if (!Number.isFinite(gexOpen) || !Number.isFinite(gexNow)) return null;
  const absOpen = Math.abs(gexOpen);
  if (absOpen === 0) return null;

  const deltaPct = (gexNow - gexOpen) / absOpen;
  if (!Number.isFinite(deltaPct)) return null;

  const classification = classifyGexIntradayDelta(gexOpen, gexNow, deltaPct);

  return { gexOpen, gexNow, deltaPct, classification };
}

/**
 * Classify the GEX intraday delta.
 *
 * The decision tree runs in this order so WEAKENING rules win over
 * STRENGTHENING on an ambiguous same-sign drift:
 *
 *   1. Sign flip → WEAKENING (regime crossed zero — biggest regime
 *      signal there is).
 *   2. Same-sign, magnitude halved or worse → WEAKENING (large
 *      magnitude loss in the existing regime is deterioration, not
 *      intensification — an open=+$1B / now=+$200M reads as gamma
 *      decay, not "the long-gamma regime is strengthening by 80%").
 *   3. Same-sign, |Δ%| > 20% AND magnitude grew → STRENGTHENING.
 *      The growth requirement prevents a 40% same-sign decay from
 *      fooling the |Δ%| gate.
 *   4. Everything else → STABLE.
 *
 * Exported for direct unit-test coverage of the classification
 * boundary logic.
 */
export function classifyGexIntradayDelta(
  gexOpen: number,
  gexNow: number,
  deltaPct: number,
): GexIntradayClassification {
  const sameSign = Math.sign(gexOpen) === Math.sign(gexNow);
  if (!sameSign) return 'WEAKENING';

  const absNow = Math.abs(gexNow);
  const absOpen = Math.abs(gexOpen);
  const halvedOrWorse = absNow <= absOpen * 0.5;
  if (halvedOrWorse) return 'WEAKENING';

  const absPct = Math.abs(deltaPct);
  const magnitudeGrew = absNow > absOpen;
  if (absPct > GEX_INTRADAY_STRENGTHEN_PCT && magnitudeGrew) {
    return 'STRENGTHENING';
  }
  return 'STABLE';
}

// ── 3. Whale flow net positioning ─────────────────────────────

interface WhaleAggRow {
  call_premium: Numeric;
  put_premium: Numeric;
}

/**
 * Sum call + put flow-alert premium for today. Ingest-time filtering
 * in fetch-flow-alerts already scopes to SPXW 0-1 DTE index alerts,
 * so any row present is a genuine whale print.
 *
 * RTH is enforced via a `created_at` upper bound tied to `now`
 * (so a backfill or replay doesn't accidentally peek into the future)
 * and via an explicit ET-date WHERE clause.
 */
export async function computeWhaleFlowPositioning(
  now: Date,
): Promise<WhaleFlowPositioning | null> {
  const sql = getDb();
  const etDate = getETDateStr(now);
  const rthOpenIso = rthOpenIsoFor(now);
  const nowIso = now.toISOString();

  const rows = (await sql`
    SELECT
      COALESCE(SUM(total_premium) FILTER (WHERE type = 'call'), 0) AS call_premium,
      COALESCE(SUM(total_premium) FILTER (WHERE type = 'put'), 0)  AS put_premium
    FROM flow_alerts
    WHERE created_at >= ${rthOpenIso}
      AND created_at <= ${nowIso}
      AND expiry >= ${etDate}
  `) as WhaleAggRow[];

  if (rows.length === 0) return null;
  const row = rows[0]!;
  const callPremium = Number.parseFloat(String(row.call_premium ?? 0));
  const putPremium = Number.parseFloat(String(row.put_premium ?? 0));
  if (!Number.isFinite(callPremium) || !Number.isFinite(putPremium)) {
    return null;
  }

  const total = callPremium + putPremium;
  if (total <= 0) return null;

  const netPremium = callPremium - putPremium;
  const netRatio = netPremium / total;
  const classification = classifyWhaleFlow(netRatio, total);

  return {
    callPremium,
    putPremium,
    netPremium,
    netRatio,
    classification,
  };
}

/**
 * Classify whale flow by ratio + total-premium floor. The floor guards
 * early-morning small samples where 3 whale prints at an extreme ratio
 * are not meaningfully directional.
 */
export function classifyWhaleFlow(
  netRatio: number,
  totalPremium: number,
): WhaleFlowClassification {
  if (totalPremium < WHALE_PREMIUM_MIN_FLOOR) return 'BALANCED';
  if (netRatio > WHALE_NET_RATIO_AGGRESSIVE) return 'AGGRESSIVE_CALL_BIAS';
  if (netRatio < -WHALE_NET_RATIO_AGGRESSIVE) return 'AGGRESSIVE_PUT_BIAS';
  return 'BALANCED';
}

// ── 4. ETF tide divergence ────────────────────────────────────

interface TideEndpointsRow {
  source: string;
  first_flow: Numeric;
  last_flow: Numeric;
}

/**
 * Compute SPY + QQQ ETF tide deltas in a single query. For each source,
 * "first_flow" is the earliest today's (ncp+npp) and "last_flow" is
 * the latest. The delta measures how institutional flow in the ETF's
 * underlying holdings has shifted across the session.
 */
export async function computeEtfTideDivergence(
  now: Date,
): Promise<EtfTideDivergence | null> {
  const sql = getDb();
  const etDate = getETDateStr(now);
  const nowIso = now.toISOString();
  // Defense-in-depth RTH floor: today's fetch-etf-tide cron only runs
  // during market hours, but a backfill or schedule widening could
  // insert pre-market rows. Without this floor, first_flow drifts
  // earlier and poisons every classification for the day.
  const rthOpenIso = rthOpenIsoFor(now);

  const rows = (await sql`
    WITH ranked AS (
      SELECT
        source,
        (COALESCE(ncp, 0) + COALESCE(npp, 0))::float8 AS net_flow,
        timestamp,
        ROW_NUMBER() OVER (PARTITION BY source ORDER BY timestamp ASC)  AS rn_asc,
        ROW_NUMBER() OVER (PARTITION BY source ORDER BY timestamp DESC) AS rn_desc
      FROM flow_data
      WHERE date = ${etDate}
        AND timestamp >= ${rthOpenIso}
        AND timestamp <= ${nowIso}
        AND source IN ('spy_etf_tide', 'qqq_etf_tide')
    )
    SELECT
      source,
      MAX(CASE WHEN rn_asc  = 1 THEN net_flow END) AS first_flow,
      MAX(CASE WHEN rn_desc = 1 THEN net_flow END) AS last_flow
    FROM ranked
    GROUP BY source
  `) as TideEndpointsRow[];

  if (rows.length === 0) return null;

  let spyDelta: number | null = null;
  let qqqDelta: number | null = null;
  for (const r of rows) {
    if (r.first_flow == null || r.last_flow == null) continue;
    const first = Number.parseFloat(String(r.first_flow));
    const last = Number.parseFloat(String(r.last_flow));
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    const delta = last - first;
    if (r.source === 'spy_etf_tide') spyDelta = delta;
    else if (r.source === 'qqq_etf_tide') qqqDelta = delta;
  }

  if (spyDelta == null || qqqDelta == null) return null;

  const classification = classifyEtfTide(spyDelta, qqqDelta);
  return { spyDelta, qqqDelta, classification };
}

/**
 * Classify SPY + QQQ tide deltas by divergence pattern. Leading-bull /
 * leading-bear rules require one side to clear the threshold on the
 * same sign AND the other side to sit on the opposite side (or flat in
 * the QQQ_LEADING_BEAR case — tech selling off while SPY holds is a
 * cleaner signal than requiring SPY to rip).
 *
 * Exported so tests can exercise the boundary logic without a DB mock.
 */
export function classifyEtfTide(
  spyDelta: number,
  qqqDelta: number,
): EtfTideClassification {
  const threshold = ETF_TIDE_DELTA_THRESHOLD;

  if (spyDelta > threshold && qqqDelta < -threshold) return 'SPY_LEADING_BULL';
  if (qqqDelta < -threshold && spyDelta >= 0) return 'QQQ_LEADING_BEAR';
  if (spyDelta > threshold && qqqDelta > threshold) return 'ALIGNED_RISK_ON';
  if (spyDelta < -threshold && qqqDelta < -threshold) return 'ALIGNED_RISK_OFF';
  return 'MIXED';
}

// ── Orchestrator ──────────────────────────────────────────────

/**
 * Compute all four UW deltas in parallel. Each helper is wrapped in
 * `Promise.allSettled` so one source being stale / empty / erroring
 * cannot suppress the others. Top-level null only when every signal
 * is null — partial coverage renders with "N/A" placeholders.
 */
export async function computeUwDeltas(now: Date): Promise<UwDeltas | null> {
  const [darkPoolRes, gexRes, whaleRes, etfRes] = await Promise.allSettled([
    computeDarkPoolVelocity(now),
    computeGexIntradayDelta(now),
    computeWhaleFlowPositioning(now),
    computeEtfTideDivergence(now),
  ]);

  const darkPool =
    darkPoolRes.status === 'fulfilled' ? darkPoolRes.value : null;
  const gex = gexRes.status === 'fulfilled' ? gexRes.value : null;
  const whaleFlow = whaleRes.status === 'fulfilled' ? whaleRes.value : null;
  const etfTide = etfRes.status === 'fulfilled' ? etfRes.value : null;

  if (darkPool == null && gex == null && whaleFlow == null && etfTide == null) {
    return null;
  }

  return {
    darkPool,
    gex,
    whaleFlow,
    etfTide,
    computedAt: now.toISOString(),
  };
}

// ── Formatter ─────────────────────────────────────────────────

function formatSigned(v: number | null, digits: number): string {
  if (v == null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}`;
}

function formatDollarAbbrev(v: number | null): string {
  if (v == null) return 'N/A';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPct(v: number | null): string {
  if (v == null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function renderDarkPoolBlock(d: DarkPoolVelocity | null): string {
  if (d == null) {
    return [
      '  Dark pool velocity:',
      '    Strikes active (last 5m): N/A',
      '    Baseline mean: N/A',
      '    Z-score: N/A',
      '    Classification: N/A',
    ].join('\n');
  }
  return [
    '  Dark pool velocity:',
    `    Strikes active (last 5m): ${d.count5m}`,
    `    Baseline mean (12 × 5m): ${d.baselineMean.toFixed(2)}`,
    `    Z-score: ${formatSigned(d.zscore, 2)}`,
    `    Classification: ${d.classification}`,
  ].join('\n');
}

function renderGexBlock(g: GexIntradayDelta | null): string {
  if (g == null) {
    return [
      '  GEX intraday delta:',
      '    GEX at open: N/A',
      '    GEX now: N/A',
      '    Delta %: N/A',
      '    Classification: N/A',
    ].join('\n');
  }
  return [
    '  GEX intraday delta:',
    `    GEX at open: ${formatSigned(g.gexOpen, 0)}`,
    `    GEX now: ${formatSigned(g.gexNow, 0)}`,
    `    Delta %: ${formatPct(g.deltaPct)}`,
    `    Classification: ${g.classification}`,
  ].join('\n');
}

function renderWhaleBlock(w: WhaleFlowPositioning | null): string {
  if (w == null) {
    return [
      '  Whale flow positioning:',
      '    Call premium: N/A',
      '    Put premium: N/A',
      '    Net premium: N/A',
      '    Net ratio: N/A',
      '    Classification: N/A',
    ].join('\n');
  }
  return [
    '  Whale flow positioning:',
    `    Call premium (cumulative): ${formatDollarAbbrev(w.callPremium)}`,
    `    Put premium (cumulative): ${formatDollarAbbrev(w.putPremium)}`,
    `    Net premium: ${formatDollarAbbrev(w.netPremium)}`,
    `    Net ratio: ${formatSigned(w.netRatio, 2)}`,
    `    Classification: ${w.classification}`,
  ].join('\n');
}

function renderEtfBlock(e: EtfTideDivergence | null): string {
  if (e == null) {
    return [
      '  ETF tide divergence:',
      '    SPY ETF tide delta: N/A',
      '    QQQ ETF tide delta: N/A',
      '    Classification: N/A',
    ].join('\n');
  }
  return [
    '  ETF tide divergence:',
    `    SPY ETF tide delta: ${formatDollarAbbrev(e.spyDelta)}`,
    `    QQQ ETF tide delta: ${formatDollarAbbrev(e.qqqDelta)}`,
    `    Classification: ${e.classification}`,
  ].join('\n');
}

/**
 * Render the UW deltas block for injection into the analyze prompt.
 * Returns null when every signal is null so the orchestrator can drop
 * the section cleanly. Partial coverage always renders — missing
 * components show "N/A".
 *
 * Output is wrapped in a `<uw_deltas>` tag so the cached
 * `<uw_deltas_rules>` block in the system prompt can reference this
 * section by name.
 */
export function formatUwDeltasForClaude(d: UwDeltas | null): string | null {
  if (!d) return null;
  if (
    d.darkPool == null &&
    d.gex == null &&
    d.whaleFlow == null &&
    d.etfTide == null
  ) {
    return null;
  }
  return [
    '<uw_deltas>',
    renderDarkPoolBlock(d.darkPool),
    '',
    renderGexBlock(d.gex),
    '',
    renderWhaleBlock(d.whaleFlow),
    '',
    renderEtfBlock(d.etfTide),
    '</uw_deltas>',
  ].join('\n');
}
