/**
 * Strike IV detection helpers — extracted from `api/cron/fetch-strike-iv.ts`
 * during the Phase 4b refactor (api-refactor-2026-05-02). These helpers
 * load the trailing window of `strike_iv_snapshots`, fetch supporting net
 * dealer gamma context, run the gamma-squeeze detector, enrich each flag
 * with precision-stack metrics (HHI + morning IV-vol correlation), and
 * persist the results into `gamma_squeeze_events`.
 *
 * Scope: pure DB + detection wiring. The cron handler still owns:
 *   - Schwab chain fetch
 *   - row extraction + IV inversion
 *   - the per-ticker fan-out + Sentry tagging via `withTickerScope`
 *
 * Behaviour is unchanged — see the original cron's tests
 * (`api/__tests__/cron-fetch-strike-iv.test.ts`) which still exercise
 * these helpers transitively through the handler.
 */

import { Sentry } from './sentry.js';
import logger from './logger.js';
import type { getDb } from './db.js';
import {
  detectGammaSqueezes,
  squeezeKey,
  type SqueezeFlag,
  type SqueezeWindowSample,
} from './gamma-squeeze.js';
import { gatherContextSnapshot } from './anomaly-context.js';
import {
  computeHhi,
  computeIvMorningVolCorr,
  IV_MORNING_CUTOFF_HOUR_CT,
  PROXIMITY_BAND_PCT,
  type BandStrikeSample,
  type IvVolSample,
} from './precision-stack.js';
import type { StrikeIVTicker } from './constants.js';

// Re-export types the cron handler still references after the move so
// import paths stay short on the call site.
export type SqlClient = ReturnType<typeof getDb>;

// ── Sentry scope helper ──────────────────────────────────────
//
// fetch-strike-iv used to set `cron.job` + `strike_iv.ticker` (and
// optionally `strike_iv.phase`) at FIVE separate sites — once per
// caught error path. Collapsing into a single helper keeps the tag
// shape consistent and shrinks the per-error boilerplate.
//
// We deliberately use plain `Sentry.setTag` rather than the more
// hygienic `Sentry.withScope` because (a) the wrapper already sets
// `cron.job` at the active scope on entry, so a stale ticker tag is
// the only risk we need to worry about, and (b) every call site
// overwrites the same `strike_iv.ticker` key on the next per-ticker
// error, so within-run tag bleed is bounded to "the most-recently
// captured ticker" which is the same shape the original code had.

/**
 * Capture an exception to Sentry with the standard fetch-strike-iv tag
 * bundle. Mirrors the verbatim setTag + captureException sequence the
 * original cron repeated five times so the per-error noise stays
 * consistent across detection, persist, enrichment, and per-ticker
 * crash sites.
 */
export function captureTickerException(
  ticker: StrikeIVTicker,
  err: unknown,
  phase?: string,
): void {
  Sentry.setTag('cron.job', 'fetch-strike-iv');
  Sentry.setTag('strike_iv.ticker', ticker);
  if (phase) Sentry.setTag('strike_iv.phase', phase);
  Sentry.captureException(err);
}

// ── Snapshot row payload ─────────────────────────────────────
//
// Re-exported because callers (the cron) build SnapshotRow values from
// Schwab data and pass them through to `runDetection` for trace logging.

export interface SnapshotRow {
  ticker: StrikeIVTicker;
  strike: number;
  side: 'call' | 'put';
  expiry: string; // YYYY-MM-DD
  spot: number;
  ivMid: number | null;
  ivBid: number | null;
  ivAsk: number | null;
  midPrice: number;
  oi: number;
  volume: number;
}

// ── Squeeze-window loader ────────────────────────────────────

/**
 * Load the trailing 45-min window of `strike_iv_snapshots` for the gamma
 * squeeze detector. Same source as `loadHistoryForTicker` but with a
 * different shape: keyed by squeezeKey(strike, side, expiry) and
 * including spot per sample.
 *
 * 45 min covers the detector's deepest lookback (30-min for prior
 * velocity baseline) plus 15 min of the current velocity window.
 */
export async function loadSqueezeWindowForTicker(
  sql: SqlClient,
  ticker: StrikeIVTicker,
  sampledAtIso: string,
): Promise<Map<string, SqueezeWindowSample[]>> {
  type WindowRow = {
    strike: string | number;
    side: string;
    expiry: string | Date;
    ts: string | Date;
    volume: string | number | null;
    oi: string | number | null;
    spot: string | number | null;
  };
  const rows = (await sql`
    SELECT strike, side, expiry, ts, volume, oi, spot
    FROM strike_iv_snapshots
    WHERE ticker = ${ticker}
      AND ts >= (${sampledAtIso}::timestamptz - INTERVAL '45 minutes')
      AND ts <= ${sampledAtIso}
      AND volume IS NOT NULL
      AND oi IS NOT NULL
      AND oi > 0
    ORDER BY strike, side, expiry, ts
  `) as WindowRow[];

  const out = new Map<string, SqueezeWindowSample[]>();
  for (const r of rows) {
    const strike = Number(r.strike);
    const side = r.side === 'call' ? 'call' : 'put';
    const expiry =
      r.expiry instanceof Date
        ? r.expiry.toISOString().slice(0, 10)
        : String(r.expiry).slice(0, 10);
    const ts = r.ts instanceof Date ? r.ts.toISOString() : String(r.ts);
    const volume = Number(r.volume ?? 0);
    const oi = Number(r.oi ?? 0);
    const spot = Number(r.spot ?? 0);
    if (!Number.isFinite(strike) || !Number.isFinite(volume)) continue;
    if (!Number.isFinite(oi) || oi <= 0) continue;
    if (!Number.isFinite(spot) || spot <= 0) continue;
    const key = squeezeKey(strike, side, expiry);
    const sample: SqueezeWindowSample = {
      strike,
      side,
      expiry,
      ts,
      volume,
      oi,
      spot,
    };
    const bucket = out.get(key);
    if (bucket) bucket.push(sample);
    else out.set(key, [sample]);
  }
  return out;
}

// ── Net dealer gamma loader ──────────────────────────────────

/**
 * Load net dealer gamma per strike from `strike_exposures` for SPXW.
 *
 * Schema reality (2026-04-28): the `strike_exposures` table is populated
 * exclusively by the SPX GEX cron with `ticker = 'SPX'` (literal). SPY,
 * QQQ, and single names have no rows here. So this loader normalizes
 * SPXW → 'SPX' for the lookup and returns an empty Map for every other
 * ticker. The squeeze detector treats unknown NDG as 'pass' on Gate 6,
 * so non-SPXW tickers run on Gates 1-5 only.
 *
 * Net gamma is computed as `call_gamma_oi + put_gamma_oi` matching the
 * convention in `gex-per-strike.ts`. Sign convention: NDG > 0 = dealers
 * net LONG gamma (their hedging dampens moves) → squeeze gate filters
 * those strikes out. NDG < 0 = dealers SHORT gamma (hedging amplifies
 * moves — squeeze is real).
 */
export async function loadNetDealerGammaForTicker(
  sql: SqlClient,
  ticker: StrikeIVTicker,
  sampledAtIso: string,
): Promise<Map<number, number>> {
  // Only SPXW has a corresponding row set in strike_exposures (under
  // ticker 'SPX'). NDXP / SPY / QQQ / IWM / SMH / single-names all skip
  // this query and inherit 'unknown' NDG from the detector.
  if (ticker !== 'SPXW') return new Map();

  type ExposureRow = {
    strike: string | number;
    net_gamma: string | number | null;
  };
  // Most-recent snapshot per strike, looking back 1 hour from the detect
  // ts. The GEX cron writes 5-min-rounded timestamps so a 1-hour window
  // comfortably covers the freshest snapshot even after a cron skip.
  const rows = (await sql`
    SELECT DISTINCT ON (strike)
           strike,
           (COALESCE(call_gamma_oi, 0) + COALESCE(put_gamma_oi, 0)) AS net_gamma
    FROM strike_exposures
    WHERE ticker = 'SPX'
      AND timestamp <= ${sampledAtIso}
      AND timestamp >= (${sampledAtIso}::timestamptz - INTERVAL '1 hour')
    ORDER BY strike, timestamp DESC
  `) as ExposureRow[];

  const out = new Map<number, number>();
  for (const r of rows) {
    const strike = Number(r.strike);
    const ndg = Number(r.net_gamma ?? 0);
    if (!Number.isFinite(strike) || !Number.isFinite(ndg)) continue;
    out.set(strike, ndg);
  }
  return out;
}

// ── Precision-stack enrichment ───────────────────────────────

/**
 * Stamp HHI and morning IV-vol correlation on every squeeze flag in place.
 * Two queries per flag — one for the band's per-strike notional (within
 * ±0.5% of spot, same side), one for the strike's pre-11:00 CT IV
 * trajectory. Both run in parallel across all flags via Promise.all so
 * a 10-flag batch issues 20 concurrent queries instead of 20 sequential.
 * Per-flag failures are caught individually so one bad fire can't poison
 * the rest of the batch — failed enrichment stamps null (columns are
 * nullable; the read endpoint treats null as "not eligible for pass").
 */
type NumericFromDb = string | number | null;
interface BandRow {
  strike: string | number;
  volume: NumericFromDb;
  mid_price: NumericFromDb;
}
interface IvRow {
  minute_ct: string | Date;
  iv: NumericFromDb;
  cum_volume: NumericFromDb;
}

export async function enrichSingleFlag(
  sql: SqlClient,
  f: SqueezeFlag,
): Promise<void> {
  try {
    const bandLow = f.spot_at_detect * (1 - PROXIMITY_BAND_PCT);
    const bandHigh = f.spot_at_detect * (1 + PROXIMITY_BAND_PCT);

    // Fire both queries in parallel — they're independent.
    const [bandRows, ivRows] = (await Promise.all([
      sql`
        SELECT DISTINCT ON (strike)
               strike, volume, mid_price
        FROM strike_iv_snapshots
        WHERE ticker = ${f.ticker}
          AND side = ${f.side}
          AND expiry = ${f.expiry}
          AND ts <= ${f.ts}
          AND ts >= (${f.ts}::timestamptz - INTERVAL '15 minutes')
          AND strike BETWEEN ${bandLow} AND ${bandHigh}
        ORDER BY strike, ts DESC
      `,
      sql`
        SELECT date_trunc('minute', ts AT TIME ZONE 'America/Chicago') AS minute_ct,
               AVG(iv_mid) AS iv,
               MAX(volume) AS cum_volume
        FROM strike_iv_snapshots
        WHERE ticker = ${f.ticker}
          AND strike = ${f.strike}
          AND side = ${f.side}
          AND expiry = ${f.expiry}
          -- Sargable lower bound on raw \`ts\`: morning data lives within
          -- the 12 hours preceding any market-hours fire, so this both
          -- enables the (ticker, strike, side, expiry, ts) index AND
          -- keeps the per-tz filter narrow.
          AND ts >= (${f.ts}::timestamptz - INTERVAL '12 hours')
          AND ts <= ${f.ts}::timestamptz
          AND DATE(ts AT TIME ZONE 'America/Chicago') = DATE(${f.ts}::timestamptz AT TIME ZONE 'America/Chicago')
          AND EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Chicago') < ${IV_MORNING_CUTOFF_HOUR_CT}
          AND iv_mid IS NOT NULL
          AND iv_mid > 0
          AND iv_mid < 5
        GROUP BY 1
        ORDER BY minute_ct
      `,
    ])) as [BandRow[], IvRow[]];

    const bandSamples: BandStrikeSample[] = [];
    for (const r of bandRows) {
      const strike = Number(r.strike);
      const volume = r.volume == null ? Number.NaN : Number(r.volume);
      const midPrice = r.mid_price == null ? Number.NaN : Number(r.mid_price);
      if (
        Number.isFinite(strike) &&
        Number.isFinite(volume) &&
        Number.isFinite(midPrice)
      ) {
        bandSamples.push({ strike, volume, midPrice });
      }
    }
    f.hhi_neighborhood = computeHhi(bandSamples);

    const ivSamples: IvVolSample[] = [];
    for (const r of ivRows) {
      const ts =
        r.minute_ct instanceof Date
          ? r.minute_ct.toISOString()
          : String(r.minute_ct);
      const iv = r.iv == null ? Number.NaN : Number(r.iv);
      const volume = r.cum_volume == null ? Number.NaN : Number(r.cum_volume);
      if (Number.isFinite(iv) && Number.isFinite(volume)) {
        ivSamples.push({ ts, iv, volume });
      }
    }
    f.iv_morning_vol_corr = computeIvMorningVolCorr(ivSamples);
  } catch (err) {
    captureTickerException(
      f.ticker as StrikeIVTicker,
      err,
      'precision_stack_enrichment',
    );
    logger.warn(
      { err, ticker: f.ticker, strike: f.strike },
      'fetch-strike-iv: precision-stack enrichment failed (non-fatal)',
    );
    f.hhi_neighborhood = null;
    f.iv_morning_vol_corr = null;
  }
}

export async function enrichWithPrecisionStack(
  sql: SqlClient,
  flags: SqueezeFlag[],
): Promise<void> {
  // Fan out across flags — each enrichSingleFlag handles its own errors.
  await Promise.all(flags.map((f) => enrichSingleFlag(sql, f)));
}

// ── Persistence ──────────────────────────────────────────────

export async function persistSqueezeFlags(
  sql: SqlClient,
  flags: SqueezeFlag[],
  contextJson: string,
): Promise<number> {
  if (flags.length === 0) return 0;
  let inserted = 0;
  for (const f of flags) {
    const result = await sql`
      INSERT INTO gamma_squeeze_events (
        ticker, strike, side, expiry, ts,
        spot_at_detect, pct_from_strike, spot_trend_5m,
        vol_oi_15m, vol_oi_15m_prior, vol_oi_acceleration, vol_oi_total,
        net_gamma_sign, squeeze_phase, context_snapshot,
        hhi_neighborhood, iv_morning_vol_corr
      ) VALUES (
        ${f.ticker}, ${f.strike}, ${f.side}, ${f.expiry}, ${f.ts},
        ${f.spot_at_detect}, ${f.pct_from_strike}, ${f.spot_trend_5m},
        ${f.vol_oi_15m}, ${f.vol_oi_15m_prior}, ${f.vol_oi_acceleration}, ${f.vol_oi_total},
        ${f.net_gamma_sign}, ${f.squeeze_phase}, ${contextJson}::jsonb,
        ${f.hhi_neighborhood ?? null}, ${f.iv_morning_vol_corr ?? null}
      )
      ON CONFLICT (ticker, strike, side, expiry, ts) DO NOTHING
      RETURNING id
    `;
    if ((result as unknown[]).length > 0) inserted += 1;
  }
  return inserted;
}

// ── Detection driver ─────────────────────────────────────────

/**
 * For every row we just inserted, run the gamma-squeeze detector against
 * the trailing window. Flags are enriched with a `ContextSnapshot` and
 * persisted to `gamma_squeeze_events`.
 *
 * IV-anomaly persistence retired with the Whale Anomalies migration —
 * see docs/superpowers/specs/whale-anomalies-2026-04-29.md, Phase 7.
 * `iv_anomalies` is dropped in migration #100 and no consumer reads it.
 *
 * Returns the squeeze flag count (or 0). Detection failures log + capture
 * to Sentry but don't fail the cron — ingestion always takes precedence.
 */
export async function runDetection(
  sql: SqlClient,
  ticker: StrikeIVTicker,
  insertedRows: SnapshotRow[],
  sampledAtIso: string,
): Promise<number> {
  if (insertedRows.length === 0) return 0;

  const [squeezeWindow, ndgByStrike] = await Promise.all([
    loadSqueezeWindowForTicker(sql, ticker, sampledAtIso),
    loadNetDealerGammaForTicker(sql, ticker, sampledAtIso),
  ]);

  const squeezeFlags = detectGammaSqueezes(
    squeezeWindow,
    ticker,
    sampledAtIso,
    ndgByStrike,
  );

  if (squeezeFlags.length === 0) return 0;

  // All flags in this batch share the same (ticker, sampledAtIso) pair —
  // gather the context snapshot ONCE instead of re-running ~30 queries
  // per flag. Any per-flag micro-drift in detectTs is below the
  // staleness windows the context queries use.
  const detectTs = new Date(sampledAtIso);
  const context = await gatherContextSnapshot(ticker, detectTs);
  const contextJson = JSON.stringify(context);

  // Stamp HHI + iv_morning_vol_corr on every flag before persisting. Pure
  // enrichment — failures are caught per-flag and stamp NULL columns.
  await enrichWithPrecisionStack(sql, squeezeFlags);

  try {
    await persistSqueezeFlags(sql, squeezeFlags, contextJson);
  } catch (err) {
    captureTickerException(ticker, err, 'gamma_squeeze_persist');
    logger.error(
      { err, ticker, count: squeezeFlags.length },
      'fetch-strike-iv: gamma squeeze persist failed',
    );
    return 0;
  }
  return squeezeFlags.length;
}
