/**
 * Microstructure signals — order flow imbalance (OFI), spread widening
 * z-score, and top-of-book (TOB) pressure — per subscribed futures
 * symbol.
 *
 * Reads the Phase 2a tables `futures_trade_ticks` and
 * `futures_top_of_book` written by the Databento sidecar. All signals
 * are computed on-demand per analyze call — no cron, no snapshot
 * table, no cache.
 *
 * Phase 5a widens the Phase 2b compute layer from ES-only to any
 * subscribed front-month symbol (currently ES + NQ). The live tables
 * already carry a `symbol` column written by the sidecar's
 * `QuoteProcessor`, so generalizing is a SQL-parameter change.
 *
 * Signal definitions (see Phase 2b spec for full reasoning):
 *
 *   1. OFI (1-min / 5-min / 1-hour): aggressor-classified flow balance
 *      computed as `(buy_volume - sell_volume) / (buy_volume +
 *      sell_volume)` where volumes sum sizes of trades with
 *      aggressor_side = 'B' and 'S'. 'N' trades (printed between
 *      spread — rare auction crosses) are excluded from both
 *      numerator and denominator. Below 20 trades in the window the
 *      signal is statistically weak → return null.
 *
 *      The 1-hour window is Phase 4d's empirically validated signal
 *      on NQ (Spearman ρ=0.313, p_bonf<0.001, n=312). It's included
 *      for ES too but ES OFI carries no Bonferroni-significant signal —
 *      treat the ES 1h number as qualitative tape flavor.
 *
 *   2. Spread z-score: per-minute median spread in the current minute
 *      vs a baseline of per-minute medians over the trailing 30
 *      minutes. Z = (current_median - baseline_median) /
 *      baseline_stddev. Below 30 baseline quotes or 3 current-minute
 *      quotes → null. Stddev exactly zero → null (constant baseline
 *      provides no dispersion reference).
 *
 *   3. TOB pressure: bid_size / ask_size of the most recent quote.
 *      If the latest quote is older than 30 sec relative to `now`
 *      (data stream stalled), or if ask_size is zero (degenerate
 *      book), return null.
 *
 * Composite classification collapses the three into one of four
 * labels when signals align. LIQUIDITY_STRESS (spread widening) takes
 * precedence over directional composites because a dealer pull-back
 * is a regime signal that trumps any flow imbalance read.
 *
 * Top-level null is returned only when all four individual signals
 * fail — a partial result is still useful and the formatter renders
 * "N/A" for missing components.
 */

import { getDb } from './db.js';

// ── Configuration ─────────────────────────────────────────────

/** OFI window lengths. */
const OFI_1M_MS = 60 * 1000;
const OFI_5M_MS = 5 * 60 * 1000;
const OFI_1H_MS = 60 * 60 * 1000;

/** Minimum trades (B + S combined) before OFI is meaningful. */
const MIN_OFI_TRADES = 20;

/** Spread z-score windows. */
const SPREAD_BASELINE_MS = 30 * 60 * 1000;
const SPREAD_CURRENT_MS = 60 * 1000;

/** Minimum quote counts for spread z-score. */
const MIN_SPREAD_BASELINE_QUOTES = 30;
const MIN_SPREAD_CURRENT_QUOTES = 3;

/** Max staleness for the most recent TOB quote (ms). */
const TOB_STALENESS_MS = 30 * 1000;

/** Composite thresholds. */
const OFI_DIRECTIONAL_THRESHOLD = 0.3;
const TOB_BUY_THRESHOLD = 1.5;
const TOB_SELL_THRESHOLD = 0.67;
const SPREAD_STRESS_THRESHOLD = 2.0;

/** Cross-asset divergence thresholds (Phase 5a). */
const CROSS_ASSET_DIVERGENCE_DELTA = 0.4;
const CROSS_ASSET_ALIGNED_THRESHOLD = 0.3;

// ── Types ─────────────────────────────────────────────────────

export type MicrostructureComposite =
  | 'AGGRESSIVE_BUY'
  | 'AGGRESSIVE_SELL'
  | 'LIQUIDITY_STRESS'
  | 'BALANCED';

export interface MicrostructureSignals {
  symbol: string;
  ofi1m: number | null;
  ofi5m: number | null;
  ofi1h: number | null;
  spreadZscore: number | null;
  tobPressure: number | null;
  composite: MicrostructureComposite | null;
  computedAt: string;
}

export interface DualSymbolMicrostructure {
  es: MicrostructureSignals | null;
  nq: MicrostructureSignals | null;
}

// ── Internal helpers ──────────────────────────────────────────

type Numeric = string | number | null;

interface OfiAggRow {
  buy_volume: Numeric;
  sell_volume: Numeric;
  total_trades: Numeric;
}

/**
 * Compute OFI for a single window and symbol. Aggregates in SQL with
 * FILTER so we only transfer one row regardless of how many trades
 * fall in the window. `'N'` (mid-spread) trades are excluded from
 * numerator AND denominator — they do not express aggressor pressure.
 *
 * The live `futures_trade_ticks` table stores root symbols ('ES',
 * 'NQ') — see `sidecar/src/databento_client._resolve_symbol`. An
 * equality filter is the correct SQL shape.
 */
async function computeOfiWindow(
  now: Date,
  windowMs: number,
  symbol: string,
): Promise<number | null> {
  const sql = getDb();
  const earliestIso = new Date(now.getTime() - windowMs).toISOString();
  const nowIso = now.toISOString();
  const rows = (await sql`
    SELECT
      COALESCE(SUM(size) FILTER (WHERE aggressor_side = 'B'), 0) AS buy_volume,
      COALESCE(SUM(size) FILTER (WHERE aggressor_side = 'S'), 0) AS sell_volume,
      COUNT(*) FILTER (WHERE aggressor_side IN ('B','S')) AS total_trades
    FROM futures_trade_ticks
    WHERE symbol = ${symbol}
      AND ts > ${earliestIso}
      AND ts <= ${nowIso}
  `) as OfiAggRow[];

  if (rows.length === 0) return null;
  const row = rows[0]!;
  const totalTrades = Number.parseInt(String(row.total_trades ?? 0), 10);
  if (!Number.isFinite(totalTrades) || totalTrades < MIN_OFI_TRADES) {
    return null;
  }
  const buy = Number.parseFloat(String(row.buy_volume ?? 0));
  const sell = Number.parseFloat(String(row.sell_volume ?? 0));
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return null;
  const denom = buy + sell;
  if (denom <= 0) return null;
  return (buy - sell) / denom;
}

interface BaselineBucketRow {
  minute: string | Date;
  median_spread: Numeric;
}

interface CurrentAggRow {
  median_spread: Numeric;
  n: Numeric;
}

/**
 * Median of a numeric array. Returns NaN for empty input — callers
 * must guard length > 0.
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Population stddev. We use population rather than sample stddev
 * because each per-minute median is a population observation for
 * "spread at minute K", not a sample from some meta-distribution.
 */
function stddev(values: number[], mean: number): number {
  const n = values.length;
  if (n === 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

/**
 * Compute the spread z-score. During active hours
 * `futures_top_of_book` can see 1-5K updates/min per symbol, so the
 * 30-min baseline is 30K-150K raw quote rows. We push aggregation into
 * Postgres with `percentile_cont(0.5) WITHIN GROUP (...)`:
 *   - Baseline query returns ~30 rows (one per minute bucket), each
 *     with the minute's median spread.
 *   - Current-minute query returns ONE row with the median + count.
 * This keeps wire transfer bounded regardless of book activity.
 */
async function computeSpreadZscore(
  now: Date,
  symbol: string,
): Promise<number | null> {
  const sql = getDb();
  const baselineStartIso = new Date(
    now.getTime() - SPREAD_BASELINE_MS,
  ).toISOString();
  const currentStartIso = new Date(
    now.getTime() - SPREAD_CURRENT_MS,
  ).toISOString();
  const nowIso = now.toISOString();

  const [baselineRowsRaw, currentRowsRaw] = await Promise.all([
    sql`
      SELECT
        date_trunc('minute', ts) AS minute,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ask - bid) AS median_spread
      FROM futures_top_of_book
      WHERE symbol = ${symbol}
        AND ts > ${baselineStartIso}
        AND ts <= ${nowIso}
      GROUP BY 1
    `,
    sql`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ask - bid) AS median_spread,
        COUNT(*)::int AS n
      FROM futures_top_of_book
      WHERE symbol = ${symbol}
        AND ts > ${currentStartIso}
        AND ts <= ${nowIso}
    `,
  ]);
  const baselineRows = baselineRowsRaw as BaselineBucketRow[];
  const currentRows = currentRowsRaw as CurrentAggRow[];

  // Baseline gate: need >= MIN_SPREAD_BASELINE_QUOTES distinct minute
  // buckets. Previously this gated on raw-quote count; per-minute
  // bucket count is a stricter and more meaningful signal-strength
  // floor (a 30-min window with stable traffic yields ~30 buckets).
  if (baselineRows.length < MIN_SPREAD_BASELINE_QUOTES) return null;

  const perMinuteMedians: number[] = [];
  for (const row of baselineRows) {
    const v = Number.parseFloat(String(row.median_spread));
    if (Number.isFinite(v) && v >= 0) perMinuteMedians.push(v);
  }
  if (perMinuteMedians.length === 0) return null;

  const baselineMedian = median(perMinuteMedians);
  const baselineStd = stddev(perMinuteMedians, baselineMedian);
  if (!Number.isFinite(baselineStd) || baselineStd === 0) return null;

  if (currentRows.length === 0) return null;
  const currentRow = currentRows[0]!;
  const currentCount = Number.parseInt(String(currentRow.n ?? 0), 10);
  if (
    !Number.isFinite(currentCount) ||
    currentCount < MIN_SPREAD_CURRENT_QUOTES
  ) {
    return null;
  }
  const currentMedian = Number.parseFloat(String(currentRow.median_spread));
  if (!Number.isFinite(currentMedian)) return null;

  const z = (currentMedian - baselineMedian) / baselineStd;
  return Number.isFinite(z) ? z : null;
}

interface TobRow {
  ts: string | Date;
  bid_size: string | number;
  ask_size: string | number;
}

/**
 * Compute TOB pressure from the single most recent quote. Staleness
 * and degenerate-book guards return null rather than a spurious
 * ratio.
 */
async function computeTobPressure(
  now: Date,
  symbol: string,
): Promise<number | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ts, bid_size, ask_size
    FROM futures_top_of_book
    WHERE symbol = ${symbol}
    ORDER BY ts DESC
    LIMIT 1
  `) as TobRow[];

  if (rows.length === 0) return null;
  const row = rows[0]!;
  const tsMs = new Date(row.ts).getTime();
  if (!Number.isFinite(tsMs)) return null;
  if (now.getTime() - tsMs > TOB_STALENESS_MS) return null;

  const bidSize = Number.parseFloat(String(row.bid_size));
  const askSize = Number.parseFloat(String(row.ask_size));
  if (!Number.isFinite(bidSize) || !Number.isFinite(askSize)) return null;
  if (askSize === 0) return null;
  return bidSize / askSize;
}

/**
 * Collapse the three signals into a single composite label. Null
 * when no rule fires or insufficient data to classify.
 */
function classifyComposite(
  ofi5m: number | null,
  spreadZscore: number | null,
  tobPressure: number | null,
): MicrostructureComposite | null {
  // LIQUIDITY_STRESS takes precedence — dealer pull-back is a regime
  // shift and trumps any directional read.
  if (spreadZscore != null && spreadZscore > SPREAD_STRESS_THRESHOLD) {
    return 'LIQUIDITY_STRESS';
  }
  if (
    ofi5m != null &&
    tobPressure != null &&
    ofi5m > OFI_DIRECTIONAL_THRESHOLD &&
    tobPressure > TOB_BUY_THRESHOLD
  ) {
    return 'AGGRESSIVE_BUY';
  }
  if (
    ofi5m != null &&
    tobPressure != null &&
    ofi5m < -OFI_DIRECTIONAL_THRESHOLD &&
    tobPressure < TOB_SELL_THRESHOLD
  ) {
    return 'AGGRESSIVE_SELL';
  }
  // BALANCED only when all three signals are present and none of the
  // directional / stress conditions fired. Partial data → leave the
  // composite null so Claude falls back to per-signal interpretation.
  if (ofi5m != null && spreadZscore != null && tobPressure != null) {
    return 'BALANCED';
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Compute all microstructure signals for a single symbol as of `now`.
 * Returns null only when every individual signal is null — partial
 * coverage is preserved so a single missing source doesn't drop the
 * section.
 *
 * Default symbol='ES' preserves backwards compatibility with any
 * existing single-symbol caller (analyze-context-fetchers currently
 * uses the dual-symbol helper below instead).
 */
export async function computeMicrostructureSignals(
  now: Date,
  symbol: string = 'ES',
): Promise<MicrostructureSignals | null> {
  const [ofi1m, ofi5m, ofi1h, spreadZscore, tobPressure] = await Promise.all([
    computeOfiWindow(now, OFI_1M_MS, symbol),
    computeOfiWindow(now, OFI_5M_MS, symbol),
    computeOfiWindow(now, OFI_1H_MS, symbol),
    computeSpreadZscore(now, symbol),
    computeTobPressure(now, symbol),
  ]);

  if (
    ofi1m == null &&
    ofi5m == null &&
    ofi1h == null &&
    spreadZscore == null &&
    tobPressure == null
  ) {
    return null;
  }

  const composite = classifyComposite(ofi5m, spreadZscore, tobPressure);

  return {
    symbol,
    ofi1m,
    ofi5m,
    ofi1h,
    spreadZscore,
    tobPressure,
    composite,
    computedAt: now.toISOString(),
  };
}

/**
 * Compute ES + NQ microstructure signals in parallel.
 *
 * Each symbol's compute pipeline is independent: a failure / null on
 * one side must not suppress the other. `Promise.allSettled` gives us
 * per-symbol fault isolation; rejected results log and degrade to
 * null rather than bubbling up and dropping the block wholesale.
 *
 * Wall-clock budget: each symbol runs 5 queries in parallel (three
 * OFI windows, two spread queries, one TOB), and the two symbols run
 * in parallel with each other — so the dual-symbol compute adds
 * essentially zero latency over the single-symbol version on a warm
 * Neon connection.
 */
export async function computeAllSymbolSignals(
  now: Date,
): Promise<DualSymbolMicrostructure> {
  const [esResult, nqResult] = await Promise.allSettled([
    computeMicrostructureSignals(now, 'ES'),
    computeMicrostructureSignals(now, 'NQ'),
  ]);

  return {
    es: esResult.status === 'fulfilled' ? esResult.value : null,
    nq: nqResult.status === 'fulfilled' ? nqResult.value : null,
  };
}

// ── Formatter ─────────────────────────────────────────────────

function formatSigned(v: number | null, digits: number): string {
  if (v == null) return 'N/A';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}`;
}

function formatRatio(v: number | null): string {
  if (v == null) return 'N/A';
  return `${v.toFixed(2)}x`;
}

/**
 * Classify the Phase 4d validated 1h OFI signal.
 * BALANCED in [-0.2, +0.2]; AGGRESSIVE_BUY/SELL at >0.3 / <-0.3.
 * Returns 'N/A' when OFI is null.
 */
function classifyOfi1h(ofi: number | null): string {
  if (ofi == null) return 'N/A';
  if (ofi > OFI_DIRECTIONAL_THRESHOLD) return 'AGGRESSIVE_BUY';
  if (ofi < -OFI_DIRECTIONAL_THRESHOLD) return 'AGGRESSIVE_SELL';
  if (Math.abs(ofi) <= 0.2) return 'BALANCED';
  return 'MILD';
}

/**
 * Format the microstructure result for injection into the analyze
 * prompt. Returns null when the input is null so the orchestrator
 * can drop the section cleanly.
 *
 * Retained for backwards compatibility with any caller that still
 * wants a single-symbol render. The dual-symbol formatter below is
 * what the analyze-context orchestrator actually uses post-Phase 5a.
 */
export function formatMicrostructureForClaude(
  s: MicrostructureSignals | null,
): string | null {
  if (!s) return null;

  const lines: string[] = [];
  lines.push(`OFI 1m: ${formatSigned(s.ofi1m, 2)}`);
  lines.push(`OFI 5m: ${formatSigned(s.ofi5m, 2)}`);
  lines.push(`OFI 1h: ${formatSigned(s.ofi1h, 2)}`);
  lines.push(
    `Spread z-score (30m baseline): ${formatSigned(s.spreadZscore, 2)}`,
  );
  lines.push(`TOB pressure (bid/ask size): ${formatRatio(s.tobPressure)}`);
  lines.push(`Composite: ${s.composite ?? 'N/A'}`);
  return lines.join('\n  ');
}

/**
 * Cross-asset read combining ES and NQ 1h OFI values. The validated
 * (Phase 4d) signal is the NQ value; ES OFI serves only as
 * directional confirmation.
 *
 * - ALIGNED: both |OFI| ≥ 0.3 AND same sign — highest conviction
 * - DIVERGENCE: |NQ - ES| > 0.4 AND signs disagree — tech-leading flag
 * - MIXED: partial signal or neither rule fires
 * - INSUFFICIENT_DATA: either symbol's 1h OFI is null
 */
function classifyCrossAssetOfi(
  esOfi: number | null,
  nqOfi: number | null,
): string {
  if (esOfi == null || nqOfi == null) return 'INSUFFICIENT_DATA';

  const diff = Math.abs(nqOfi - esOfi);
  const signsDisagree = Math.sign(nqOfi) !== Math.sign(esOfi);
  if (diff > CROSS_ASSET_DIVERGENCE_DELTA && signsDisagree) {
    // Divergence: the headline signal. Tag by which symbol leads.
    const leader = nqOfi > esOfi ? 'NQ bid, ES offered' : 'ES bid, NQ offered';
    return `DIVERGENCE (${leader})`;
  }

  const bothBullish =
    esOfi > CROSS_ASSET_ALIGNED_THRESHOLD &&
    nqOfi > CROSS_ASSET_ALIGNED_THRESHOLD;
  const bothBearish =
    esOfi < -CROSS_ASSET_ALIGNED_THRESHOLD &&
    nqOfi < -CROSS_ASSET_ALIGNED_THRESHOLD;
  if (bothBullish) return 'ALIGNED_BULLISH';
  if (bothBearish) return 'ALIGNED_BEARISH';

  return 'MIXED';
}

/** Render one symbol's block as indented lines. */
function formatSymbolBlock(
  symbol: string,
  s: MicrostructureSignals | null,
): string {
  if (s == null) {
    return [
      `  ${symbol} (latest front-month):`,
      `    OFI 1h: N/A → N/A`,
      `    Spread z-score (30m): N/A`,
      `    TOB pressure: N/A`,
      `    Composite (short-horizon): N/A`,
    ].join('\n');
  }
  const classification = classifyOfi1h(s.ofi1h);
  return [
    `  ${symbol} (latest front-month):`,
    `    OFI 1h: ${formatSigned(s.ofi1h, 2)} → ${classification}`,
    `    OFI 5m: ${formatSigned(s.ofi5m, 2)}`,
    `    OFI 1m: ${formatSigned(s.ofi1m, 2)}`,
    `    Spread z-score (30m): ${formatSigned(s.spreadZscore, 2)}`,
    `    TOB pressure (bid/ask): ${formatRatio(s.tobPressure)}`,
    `    Composite (short-horizon): ${s.composite ?? 'N/A'}`,
  ].join('\n');
}

/**
 * Format the dual-symbol microstructure result for injection into the
 * analyze prompt. Returns null only when BOTH symbols are null — a
 * one-sided result is still useful.
 *
 * The output is wrapped in a `<microstructure_signals>` tag so the
 * cached `<microstructure_signals_rules>` block in the system prompt
 * can reference this section by name.
 */
export function formatMicrostructureDualSymbolForClaude(
  result: DualSymbolMicrostructure | null,
): string | null {
  if (!result) return null;
  const { es, nq } = result;
  if (es == null && nq == null) return null;

  const crossAsset = classifyCrossAssetOfi(
    es?.ofi1h ?? null,
    nq?.ofi1h ?? null,
  );

  const lines: string[] = [];
  lines.push('<microstructure_signals>');
  lines.push(formatSymbolBlock('ES', es));
  lines.push('');
  lines.push(formatSymbolBlock('NQ', nq));
  lines.push('');
  lines.push('  Cross-asset read (1h OFI):');
  lines.push(`    ${crossAsset}`);
  lines.push('</microstructure_signals>');
  return lines.join('\n');
}
