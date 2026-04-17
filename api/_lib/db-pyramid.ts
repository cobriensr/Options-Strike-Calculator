/**
 * Pyramid trade tracker — database operations.
 *
 * Droppable experiment per docs/superpowers/specs/pyramid-tracker-2026-04-16.md.
 * Two tables: `pyramid_chains` (one row per trade sequence) and `pyramid_legs`
 * (one row per contract entry). All feature fields are nullable — partial rows
 * save successfully so the owner can log live during trades.
 *
 * If the hypothesis fails, this whole file is deleted and a single cleanup
 * migration drops both tables. See the cleanup runbook in the spec.
 */

import { getDb } from './db.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import type { PyramidChainInput, PyramidLegInput } from './validation.js';

// ============================================================
// TYPES
// ============================================================

export interface PyramidChainRow {
  id: string;
  trade_date: string | null;
  instrument: string | null;
  direction: string | null;
  entry_time_ct: string | null;
  exit_time_ct: string | null;
  initial_entry_price: number | null;
  final_exit_price: number | null;
  exit_reason: string | null;
  total_legs: number | null;
  winning_legs: number | null;
  net_points: number | null;
  session_atr_pct: number | null;
  day_type: string | null;
  higher_tf_bias: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PyramidLegRow {
  id: string;
  chain_id: string;
  leg_number: number;
  signal_type: string | null;
  entry_time_ct: string | null;
  entry_price: number | null;
  stop_price: number | null;
  stop_distance_pts: number | null;
  stop_compression_ratio: number | null;
  vwap_at_entry: number | null;
  vwap_1sd_upper: number | null;
  vwap_1sd_lower: number | null;
  vwap_band_position: string | null;
  vwap_band_distance_pts: number | null;
  minutes_since_chain_start: number | null;
  minutes_since_prior_bos: number | null;
  ob_quality: number | null;
  relative_volume: number | null;
  session_phase: string | null;
  session_high_at_entry: number | null;
  session_low_at_entry: number | null;
  retracement_extreme_before_entry: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  points_captured: number | null;
  r_multiple: number | null;
  was_profitable: boolean | null;
  notes: string | null;
  ob_high: number | null;
  ob_low: number | null;
  ob_poc_price: number | null;
  ob_poc_pct: number | null;
  ob_secondary_node_pct: number | null;
  ob_tertiary_node_pct: number | null;
  ob_total_volume: number | null;
  rth_structure_bias: string | null;
  eth_structure_bias: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProgressCounts {
  total_chains: number;
  chains_by_day_type: {
    trend: number;
    chop: number;
    news: number;
    mixed: number;
    unspecified: number;
  };
  elapsed_calendar_days: number | null;
  /** Column name -> fraction in [0, 1] representing non-null / total legs */
  fill_rates: Record<string, number>;
}

// Columns used for fill-rate computation on pyramid_legs.
// Identity / required fields (id, chain_id, leg_number) and system
// timestamps (created_at, updated_at) are excluded — they're always
// filled so they carry no signal about user capture discipline.
const LEG_FILL_RATE_COLUMNS = [
  'signal_type',
  'entry_time_ct',
  'entry_price',
  'stop_price',
  'stop_distance_pts',
  'stop_compression_ratio',
  'vwap_at_entry',
  'vwap_1sd_upper',
  'vwap_1sd_lower',
  'vwap_band_position',
  'vwap_band_distance_pts',
  'minutes_since_chain_start',
  'minutes_since_prior_bos',
  'ob_quality',
  'relative_volume',
  'session_phase',
  'session_high_at_entry',
  'session_low_at_entry',
  'retracement_extreme_before_entry',
  'exit_price',
  'exit_reason',
  'points_captured',
  'r_multiple',
  'was_profitable',
  'notes',
  'ob_high',
  'ob_low',
  'ob_poc_price',
  'ob_poc_pct',
  'ob_secondary_node_pct',
  'ob_tertiary_node_pct',
  'ob_total_volume',
  'rth_structure_bias',
  'eth_structure_bias',
] as const;

// ============================================================
// CHAIN CRUD
// ============================================================

/**
 * Insert a new pyramid chain. All feature fields are optional — any
 * missing field is stored as NULL so partial rows save successfully.
 */
export async function createChain(
  input: PyramidChainInput,
): Promise<PyramidChainRow> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO pyramid_chains (
      id, trade_date, instrument, direction,
      entry_time_ct, exit_time_ct,
      initial_entry_price, final_exit_price, exit_reason,
      total_legs, winning_legs, net_points,
      session_atr_pct, day_type, higher_tf_bias,
      notes, status
    ) VALUES (
      ${input.id},
      ${input.trade_date ?? null},
      ${input.instrument ?? null},
      ${input.direction ?? null},
      ${input.entry_time_ct ?? null},
      ${input.exit_time_ct ?? null},
      ${input.initial_entry_price ?? null},
      ${input.final_exit_price ?? null},
      ${input.exit_reason ?? null},
      ${input.total_legs ?? 0},
      ${input.winning_legs ?? 0},
      ${input.net_points ?? 0},
      ${input.session_atr_pct ?? null},
      ${input.day_type ?? null},
      ${input.higher_tf_bias ?? null},
      ${input.notes ?? null},
      ${input.status ?? 'open'}
    )
    RETURNING *
  `;
  return rows[0] as PyramidChainRow;
}

/**
 * List all chains, newest trade_date first, then newest created_at first.
 */
export async function getChains(): Promise<PyramidChainRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM pyramid_chains
    ORDER BY trade_date DESC NULLS LAST, created_at DESC
  `;
  return rows as PyramidChainRow[];
}

/**
 * Fetch a single chain with its legs (ordered by leg_number).
 * Returns null if the chain does not exist.
 */
export async function getChainWithLegs(id: string): Promise<{
  chain: PyramidChainRow;
  legs: PyramidLegRow[];
} | null> {
  const sql = getDb();
  const chainRows = await sql`
    SELECT * FROM pyramid_chains WHERE id = ${id}
  `;
  if (chainRows.length === 0) return null;

  const legRows = await sql`
    SELECT * FROM pyramid_legs
    WHERE chain_id = ${id}
    ORDER BY leg_number ASC
  `;
  return {
    chain: chainRows[0] as PyramidChainRow,
    legs: legRows as PyramidLegRow[],
  };
}

/**
 * Partial update of a chain. Uses COALESCE so undefined fields in the patch
 * leave the existing DB value untouched. Explicit null in the patch clears
 * the value (except for non-nullable `status`, where null is coerced to the
 * existing value — same effect as omitting it).
 *
 * Always bumps `updated_at`.
 */
export async function updateChain(
  id: string,
  patch: Partial<PyramidChainInput>,
): Promise<PyramidChainRow | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE pyramid_chains SET
      trade_date          = COALESCE(${patch.trade_date ?? null}, trade_date),
      instrument          = COALESCE(${patch.instrument ?? null}, instrument),
      direction           = COALESCE(${patch.direction ?? null}, direction),
      entry_time_ct       = COALESCE(${patch.entry_time_ct ?? null}, entry_time_ct),
      exit_time_ct        = COALESCE(${patch.exit_time_ct ?? null}, exit_time_ct),
      initial_entry_price = COALESCE(${patch.initial_entry_price ?? null}, initial_entry_price),
      final_exit_price    = COALESCE(${patch.final_exit_price ?? null}, final_exit_price),
      exit_reason         = COALESCE(${patch.exit_reason ?? null}, exit_reason),
      total_legs          = COALESCE(${patch.total_legs ?? null}, total_legs),
      winning_legs        = COALESCE(${patch.winning_legs ?? null}, winning_legs),
      net_points          = COALESCE(${patch.net_points ?? null}, net_points),
      session_atr_pct     = COALESCE(${patch.session_atr_pct ?? null}, session_atr_pct),
      day_type            = COALESCE(${patch.day_type ?? null}, day_type),
      higher_tf_bias      = COALESCE(${patch.higher_tf_bias ?? null}, higher_tf_bias),
      notes               = COALESCE(${patch.notes ?? null}, notes),
      status              = COALESCE(${patch.status ?? null}, status),
      updated_at          = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) return null;
  return rows[0] as PyramidChainRow;
}

/**
 * Hard-delete a chain. Cascade drops all attached legs.
 */
export async function deleteChain(id: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM pyramid_chains WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

// ============================================================
// LEG CRUD
// ============================================================

/**
 * Fetch leg 1's stop_distance_pts for a chain. Used to compute the
 * compression ratio on leg insert/update.
 */
async function getLeg1StopDistance(chainId: string): Promise<number | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT stop_distance_pts FROM pyramid_legs
    WHERE chain_id = ${chainId} AND leg_number = 1
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const raw = rows[0]?.stop_distance_pts;
  if (raw === null || raw === undefined) return null;
  const asNum = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(asNum) ? asNum : null;
}

/**
 * Compute stop_compression_ratio for a leg. Returns null when either
 * the current leg's stop_distance_pts or leg 1's stop_distance_pts
 * is missing or zero. For leg 1 itself, the ratio is always 1.0 when
 * stop_distance_pts is present and non-zero.
 *
 * Exported for direct unit testing; also consumed internally by
 * createLeg and updateLeg.
 */
export function computeCompressionRatio(
  legNumber: number,
  currentStopDistance: number | null | undefined,
  leg1StopDistance: number | null,
): number | null {
  if (currentStopDistance === null || currentStopDistance === undefined) {
    return null;
  }
  if (legNumber === 1) {
    // Leg 1 is the reference — ratio against itself is 1.
    // A zero distance on leg 1 is a divide-by-zero trap for siblings,
    // so we refuse to store a ratio at all in that case.
    return currentStopDistance === 0 ? null : 1;
  }
  if (leg1StopDistance === null || leg1StopDistance === 0) return null;
  return currentStopDistance / leg1StopDistance;
}

/**
 * Error thrown when the caller tries to insert leg N (N > 1) before
 * leg 1 exists for the chain. We reject explicitly rather than silently
 * storing a permanently-null `stop_compression_ratio` — the spec's
 * "log live, in order" workflow makes out-of-order inserts a user error,
 * and stale nulls would silently corrupt the research data.
 */
export class PyramidLegOrderError extends Error {
  constructor(chainId: string, legNumber: number) {
    super(
      `Cannot insert leg ${legNumber} for chain ${chainId}: leg 1 does not exist yet. Insert legs in order (leg 1 first).`,
    );
    this.name = 'PyramidLegOrderError';
  }
}

/**
 * Insert a new leg. Computes `stop_compression_ratio` server-side
 * as `stop_distance_pts / leg_1_stop_distance_for_chain` when both
 * values are present. Otherwise stores NULL.
 *
 * Throws `PyramidLegOrderError` when the caller tries to insert leg
 * N > 1 before leg 1 has been inserted for the chain.
 */
export async function createLeg(
  input: PyramidLegInput,
): Promise<PyramidLegRow> {
  const sql = getDb();

  let leg1Stop: number | null;
  if (input.leg_number === 1) {
    leg1Stop = input.stop_distance_pts ?? null;
  } else {
    // Enforce in-order insertion. If leg 1 is missing the ratio would
    // be permanently null for this leg — we'd rather fail loud.
    const existsRows = await sql`
      SELECT 1 AS ok FROM pyramid_legs
      WHERE chain_id = ${input.chain_id} AND leg_number = 1
      LIMIT 1
    `;
    if (existsRows.length === 0) {
      throw new PyramidLegOrderError(input.chain_id, input.leg_number);
    }
    leg1Stop = await getLeg1StopDistance(input.chain_id);
  }

  const compressionRatio = computeCompressionRatio(
    input.leg_number,
    input.stop_distance_pts,
    leg1Stop,
  );

  const rows = await sql`
    INSERT INTO pyramid_legs (
      id, chain_id, leg_number,
      signal_type, entry_time_ct, entry_price,
      stop_price, stop_distance_pts, stop_compression_ratio,
      vwap_at_entry, vwap_1sd_upper, vwap_1sd_lower,
      vwap_band_position, vwap_band_distance_pts,
      minutes_since_chain_start, minutes_since_prior_bos,
      ob_quality, relative_volume, session_phase,
      session_high_at_entry, session_low_at_entry,
      retracement_extreme_before_entry,
      exit_price, exit_reason, points_captured,
      r_multiple, was_profitable, notes,
      ob_high, ob_low, ob_poc_price, ob_poc_pct,
      ob_secondary_node_pct, ob_tertiary_node_pct, ob_total_volume,
      rth_structure_bias, eth_structure_bias
    ) VALUES (
      ${input.id},
      ${input.chain_id},
      ${input.leg_number},
      ${input.signal_type ?? null},
      ${input.entry_time_ct ?? null},
      ${input.entry_price ?? null},
      ${input.stop_price ?? null},
      ${input.stop_distance_pts ?? null},
      ${compressionRatio},
      ${input.vwap_at_entry ?? null},
      ${input.vwap_1sd_upper ?? null},
      ${input.vwap_1sd_lower ?? null},
      ${input.vwap_band_position ?? null},
      ${input.vwap_band_distance_pts ?? null},
      ${input.minutes_since_chain_start ?? null},
      ${input.minutes_since_prior_bos ?? null},
      ${input.ob_quality ?? null},
      ${input.relative_volume ?? null},
      ${input.session_phase ?? null},
      ${input.session_high_at_entry ?? null},
      ${input.session_low_at_entry ?? null},
      ${input.retracement_extreme_before_entry ?? null},
      ${input.exit_price ?? null},
      ${input.exit_reason ?? null},
      ${input.points_captured ?? null},
      ${input.r_multiple ?? null},
      ${input.was_profitable ?? null},
      ${input.notes ?? null},
      ${input.ob_high ?? null},
      ${input.ob_low ?? null},
      ${input.ob_poc_price ?? null},
      ${input.ob_poc_pct ?? null},
      ${input.ob_secondary_node_pct ?? null},
      ${input.ob_tertiary_node_pct ?? null},
      ${input.ob_total_volume ?? null},
      ${input.rth_structure_bias ?? null},
      ${input.eth_structure_bias ?? null}
    )
    RETURNING *
  `;
  return rows[0] as PyramidLegRow;
}

/**
 * Partial update of a leg. Semantics:
 *
 *   - Fields OMITTED from the patch are left untouched (via COALESCE).
 *   - `stop_distance_pts` is the one exception: omitted leaves it alone,
 *     but explicit null CLEARS it (no COALESCE swallow). This keeps the
 *     distance and the derived `stop_compression_ratio` in sync — when
 *     the distance is cleared, the ratio is cleared too.
 *   - When `stop_distance_pts` is in the patch (including explicit null),
 *     `stop_compression_ratio` is recomputed from leg 1's stop distance.
 *   - When the updated row is leg 1 itself AND `stop_distance_pts` is in
 *     the patch, every sibling leg's `stop_compression_ratio` is cascaded
 *     in the same transaction — otherwise sibling ratios would go stale.
 *
 * Always bumps `updated_at`.
 */
export async function updateLeg(
  id: string,
  patch: Partial<PyramidLegInput>,
): Promise<PyramidLegRow | null> {
  const sql = getDb();

  const recomputeRatio = patch.stop_distance_pts !== undefined;
  // Normalize explicit undefined to null so the SQL binding is a concrete
  // value. When recomputeRatio is false this value is not read; when true
  // it becomes the new stop_distance_pts for the target leg.
  const newDistance: number | null = patch.stop_distance_pts ?? null;
  let ratioOverride: number | null = null;
  let cascadeSiblings = false;
  let chainIdForCascade: string | null = null;

  if (recomputeRatio) {
    const existingRows = await sql`
      SELECT chain_id, leg_number FROM pyramid_legs WHERE id = ${id}
    `;
    if (existingRows.length === 0) return null;
    const existing = existingRows[0] as {
      chain_id: string;
      leg_number: number;
    };
    const leg1Stop =
      existing.leg_number === 1
        ? newDistance
        : await getLeg1StopDistance(existing.chain_id);
    ratioOverride = computeCompressionRatio(
      existing.leg_number,
      newDistance,
      leg1Stop,
    );
    cascadeSiblings = existing.leg_number === 1;
    chainIdForCascade = existing.chain_id;
  }

  // Build the statements. When cascading, we run both UPDATEs atomically
  // via sql.transaction so a partial failure can't leave ratios stale.
  const targetUpdate = sql`
    UPDATE pyramid_legs SET
      signal_type                      = COALESCE(${patch.signal_type ?? null}, signal_type),
      entry_time_ct                    = COALESCE(${patch.entry_time_ct ?? null}, entry_time_ct),
      entry_price                      = COALESCE(${patch.entry_price ?? null}, entry_price),
      stop_price                       = COALESCE(${patch.stop_price ?? null}, stop_price),
      stop_distance_pts                = CASE
                                           WHEN ${recomputeRatio}::boolean THEN ${newDistance}
                                           ELSE stop_distance_pts
                                         END,
      stop_compression_ratio           = CASE
                                           WHEN ${recomputeRatio}::boolean THEN ${ratioOverride}
                                           ELSE stop_compression_ratio
                                         END,
      vwap_at_entry                    = COALESCE(${patch.vwap_at_entry ?? null}, vwap_at_entry),
      vwap_1sd_upper                   = COALESCE(${patch.vwap_1sd_upper ?? null}, vwap_1sd_upper),
      vwap_1sd_lower                   = COALESCE(${patch.vwap_1sd_lower ?? null}, vwap_1sd_lower),
      vwap_band_position               = COALESCE(${patch.vwap_band_position ?? null}, vwap_band_position),
      vwap_band_distance_pts           = COALESCE(${patch.vwap_band_distance_pts ?? null}, vwap_band_distance_pts),
      minutes_since_chain_start        = COALESCE(${patch.minutes_since_chain_start ?? null}, minutes_since_chain_start),
      minutes_since_prior_bos          = COALESCE(${patch.minutes_since_prior_bos ?? null}, minutes_since_prior_bos),
      ob_quality                       = COALESCE(${patch.ob_quality ?? null}, ob_quality),
      relative_volume                  = COALESCE(${patch.relative_volume ?? null}, relative_volume),
      session_phase                    = COALESCE(${patch.session_phase ?? null}, session_phase),
      session_high_at_entry            = COALESCE(${patch.session_high_at_entry ?? null}, session_high_at_entry),
      session_low_at_entry             = COALESCE(${patch.session_low_at_entry ?? null}, session_low_at_entry),
      retracement_extreme_before_entry = COALESCE(${patch.retracement_extreme_before_entry ?? null}, retracement_extreme_before_entry),
      exit_price                       = COALESCE(${patch.exit_price ?? null}, exit_price),
      exit_reason                      = COALESCE(${patch.exit_reason ?? null}, exit_reason),
      points_captured                  = COALESCE(${patch.points_captured ?? null}, points_captured),
      r_multiple                       = COALESCE(${patch.r_multiple ?? null}, r_multiple),
      was_profitable                   = COALESCE(${patch.was_profitable ?? null}, was_profitable),
      notes                            = COALESCE(${patch.notes ?? null}, notes),
      ob_high                          = COALESCE(${patch.ob_high ?? null}, ob_high),
      ob_low                           = COALESCE(${patch.ob_low ?? null}, ob_low),
      ob_poc_price                     = COALESCE(${patch.ob_poc_price ?? null}, ob_poc_price),
      ob_poc_pct                       = COALESCE(${patch.ob_poc_pct ?? null}, ob_poc_pct),
      ob_secondary_node_pct            = COALESCE(${patch.ob_secondary_node_pct ?? null}, ob_secondary_node_pct),
      ob_tertiary_node_pct             = COALESCE(${patch.ob_tertiary_node_pct ?? null}, ob_tertiary_node_pct),
      ob_total_volume                  = COALESCE(${patch.ob_total_volume ?? null}, ob_total_volume),
      rth_structure_bias               = COALESCE(${patch.rth_structure_bias ?? null}, rth_structure_bias),
      eth_structure_bias               = COALESCE(${patch.eth_structure_bias ?? null}, eth_structure_bias),
      updated_at                       = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  if (cascadeSiblings && chainIdForCascade !== null) {
    // Recompute every sibling's compression ratio against the new leg 1
    // distance in the same atomic transaction. The CASE expression handles
    // the "new distance is null/zero" and "sibling distance is null" cases
    // by writing NULL rather than producing a divide-by-zero or stale
    // value.
    const cascadeUpdate = sql`
      UPDATE pyramid_legs
      SET
        stop_compression_ratio = CASE
          WHEN stop_distance_pts IS NULL
            OR ${newDistance}::numeric IS NULL
            OR ${newDistance}::numeric = 0
          THEN NULL
          ELSE stop_distance_pts / ${newDistance}::numeric
        END,
        updated_at = NOW()
      WHERE chain_id = ${chainIdForCascade}
        AND leg_number > 1
    `;
    const [targetResult] = await sql.transaction([targetUpdate, cascadeUpdate]);
    const rows = targetResult as unknown as PyramidLegRow[];
    if (!rows || rows.length === 0) return null;
    return rows[0]!;
  }

  const rows = (await targetUpdate) as unknown as PyramidLegRow[];
  if (rows.length === 0) return null;
  return rows[0]!;
}

/**
 * Hard-delete a single leg.
 */
export async function deleteLeg(id: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM pyramid_legs WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

// ============================================================
// PROGRESS COUNTS
// ============================================================

/**
 * Aggregate counters for the ProgressCounter UI:
 *   - total chains
 *   - chains stratified by day_type (nulls -> "unspecified")
 *   - calendar days elapsed since first logged chain
 *   - per-feature fill rates (0..1) across all legs for every
 *     nullable column (excludes id, chain_id, leg_number)
 */
export async function getProgressCounts(): Promise<ProgressCounts> {
  const sql = getDb();

  // Chain-level aggregates: total + day_type breakdown + earliest trade date.
  const chainAgg = await sql`
    SELECT
      COUNT(*)::int                                                    AS total_chains,
      COUNT(*) FILTER (WHERE day_type = 'trend')::int                  AS trend,
      COUNT(*) FILTER (WHERE day_type = 'chop')::int                   AS chop,
      COUNT(*) FILTER (WHERE day_type = 'news')::int                   AS news,
      COUNT(*) FILTER (WHERE day_type = 'mixed')::int                  AS mixed,
      COUNT(*) FILTER (WHERE day_type IS NULL)::int                    AS unspecified,
      MIN(trade_date)                                                  AS first_trade_date
    FROM pyramid_chains
  `;
  const agg = chainAgg[0] as {
    total_chains: number;
    trend: number;
    chop: number;
    news: number;
    mixed: number;
    unspecified: number;
    first_trade_date: string | null;
  };

  // Elapsed calendar days since the earliest chain's trade_date.
  //
  // Both dates are interpreted as Eastern-Time calendar dates (the
  // trading-day convention used throughout this codebase — see
  // src/utils/timezone.ts and db-analyses.ts). computeElapsedCalendarDays
  // compares YYYY-MM-DD strings as UTC midnights so DST transitions and
  // host-TZ drift cannot produce off-by-one errors.
  const elapsed = computeElapsedCalendarDays(agg.first_trade_date);

  // Per-column fill rates. Build a single SELECT with COUNT(*) and
  // COUNT(col) for each nullable column, then divide.
  //
  // Column names are hardcoded in LEG_FILL_RATE_COLUMNS — no user
  // input flows into the SQL — so interpolating them directly into the
  // query string is safe. We use sql.query() (the plain-string variant)
  // because the column list is dynamic in length.
  const fillRates: Record<string, number> = {};
  const selectParts = LEG_FILL_RATE_COLUMNS.map(
    (col) => `COUNT(${col})::int AS ${col}`,
  );
  const fillQuery = `SELECT COUNT(*)::int AS total_legs, ${selectParts.join(', ')} FROM pyramid_legs`;
  const fillResult = (await sql.query(fillQuery, [])) as Array<
    Record<string, number>
  >;
  const fillRow = fillResult[0];
  const totalLegs = Number(fillRow?.total_legs ?? 0);

  for (const col of LEG_FILL_RATE_COLUMNS) {
    if (totalLegs === 0) {
      fillRates[col] = 0;
    } else {
      const filled = Number(fillRow?.[col] ?? 0);
      fillRates[col] = filled / totalLegs;
    }
  }

  return {
    total_chains: agg.total_chains,
    chains_by_day_type: {
      trend: agg.trend,
      chop: agg.chop,
      news: agg.news,
      mixed: agg.mixed,
      unspecified: agg.unspecified,
    },
    elapsed_calendar_days: elapsed,
    fill_rates: fillRates,
  };
}

const DATE_STR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Compute whole calendar days between `firstTradeDate` (YYYY-MM-DD in ET)
 * and today (also in ET). Returns null when the input is missing or not a
 * valid YYYY-MM-DD string. Exported for direct unit testing.
 */
export function computeElapsedCalendarDays(
  firstTradeDate: string | null | undefined,
): number | null {
  if (!firstTradeDate) return null;
  const match = DATE_STR_RE.exec(firstTradeDate);
  if (!match) return null;
  const firstUtcMs = Date.UTC(
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10) - 1,
    Number.parseInt(match[3]!, 10),
  );
  if (!Number.isFinite(firstUtcMs)) return null;

  // Today's ET calendar date -> UTC midnight. Using getETDateStr ensures
  // we compare calendar-date to calendar-date rather than instants, so
  // DST transitions and a server running in UTC don't produce off-by-ones.
  const todayStr = getETDateStr(new Date());
  const todayMatch = DATE_STR_RE.exec(todayStr);
  if (!todayMatch) return null;
  const todayUtcMs = Date.UTC(
    Number.parseInt(todayMatch[1]!, 10),
    Number.parseInt(todayMatch[2]!, 10) - 1,
    Number.parseInt(todayMatch[3]!, 10),
  );

  const diffDays = Math.floor((todayUtcMs - firstUtcMs) / 86_400_000);
  return Math.max(0, diffDays);
}
