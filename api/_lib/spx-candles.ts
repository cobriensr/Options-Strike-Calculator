/**
 * SPX Intraday Candles (DB-first, UW live fallback)
 *
 * Primary path: reads pre-baked 1-minute OHLCV candles from the
 * `spx_candles_1m` Postgres table. The `fetch-spx-candles-1m` cron
 * populates that table every minute during market hours, translating
 * UW SPY candles to SPX prices via the 10× ratio before insert. The
 * backfill script `scripts/backfill-spx-candles-1m.mjs` seeds the last
 * 30 days of history.
 *
 * Fallback path: if the table has zero rows for the requested date
 * (e.g., transition window before the cron has run, or a missed date),
 * we fall back to the on-demand UW 5-minute endpoint. This is a
 * degraded mode — 5m resolution instead of 1m — but keeps the analyze
 * endpoint functional. The fallback should be dead code in steady state
 * and is intentionally kept on the 5m endpoint so existing UW test
 * fixtures continue to apply.
 *
 * Cboe prohibits external distribution of proprietary index prices
 * (SPX, VIX, RUT, etc.) via API — only their web platform is allowed.
 * Both paths therefore source SPY and multiply by the SPX/SPY ratio.
 *
 * Returns only regular-session candles (market_time = 'r'). Premarket
 * candles are still read for the purpose of deriving `previousClose`
 * (first 'pr' open, SPX-translated).
 *
 * Format-for-Claude commitment: `formatSPXCandlesForClaude()` consumes
 * 1-minute candles for the full session with NO truncation. The owner
 * has explicitly accepted the ~5x token cost increase in exchange for
 * Claude seeing granular intraday price action. See
 * `docs/superpowers/plans/gex-target-rebuild.md` Phase 3 and the
 * "Full-session 1-minute candles in Claude analyze prompt"
 * architectural commitment. Do NOT reintroduce truncation without
 * re-confirming with the owner.
 */
import { getDb } from './db.js';
import logger from './logger.js';
import { numOrNull } from './numeric-coercion.js';
import { metrics, Sentry } from './sentry.js';
import { uwFetch } from './api-helpers.js';

// ── Types ───────────────────────────────────────────────────

/** UW candle format from /stock/SPY/ohlc/5m (live fallback only) */
interface UWCandle {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  total_volume: number;
  start_time: string; // ISO timestamp: "2026-03-27T13:30:00Z"
  end_time: string;
  market_time: 'pr' | 'r' | 'po'; // premarket, regular, postmarket
}

/** Normalized candle used by the formatter */
export interface SPXCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // epoch ms (start_time)
}

/** Row shape returned by the SELECT against spx_candles_1m. */
interface SPXCandleDbRow {
  timestamp: string | Date;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
  market_time: 'pr' | 'r' | 'po';
}

// ── Helpers ─────────────────────────────────────────────────

function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function toEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

// ── Fetch ───────────────────────────────────────────────────

/**
 * Fetch regular-session SPX candles for the given date.
 *
 * DB-first: reads 1-minute rows from `spx_candles_1m`. If the table
 * has zero rows for the requested date (both regular and premarket),
 * falls back to the on-demand UW 5-minute endpoint as a degraded mode.
 *
 * Returns candles ordered by time ascending, or empty array if both
 * paths fail.
 *
 * `previousClose` is derived from the first premarket (`'pr'`) bar's
 * open for the same date. If no premarket data exists, returns `null`.
 * We do NOT fall through to the live UW path just to recover
 * `previousClose` — only if BOTH regular-session and premarket queries
 * return zero rows does the fallback path run.
 *
 * @param apiKey - UW API key (used only by the live fallback)
 * @param date - Optional date string (YYYY-MM-DD). Defaults to today UTC.
 * @param spyToSpxRatio - SPX/SPY price ratio for the live fallback path.
 *   The primary DB read path ignores this parameter because the cron
 *   (and backfill script) already translated SPY→SPX with a fixed 10×
 *   ratio before writing. Kept in the signature for backward compat
 *   with the fallback path. Default: 10.
 */
export async function fetchSPXCandles(
  apiKey: string,
  date?: string,
  spyToSpxRatio = 10,
): Promise<{
  candles: SPXCandle[];
  previousClose: number | null;
}> {
  const targetDate = date ?? todayUtcDateString();

  // ── Primary: read from spx_candles_1m ──────────────────────
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT timestamp, open, high, low, close, volume, market_time
      FROM spx_candles_1m
      WHERE date = ${targetDate}
        AND market_time IN ('r', 'pr')
      ORDER BY timestamp ASC
    `) as SPXCandleDbRow[];

    if (rows.length > 0) {
      const candles: SPXCandle[] = [];
      let previousClose: number | null = null;

      for (const row of rows) {
        if (row.market_time === 'r') {
          const open = numOrNull(row.open);
          const high = numOrNull(row.high);
          const low = numOrNull(row.low);
          const close = numOrNull(row.close);
          if (
            open === null ||
            high === null ||
            low === null ||
            close === null
          ) {
            continue;
          }
          candles.push({
            open,
            high,
            low,
            close,
            volume: Number(row.volume) || 0,
            datetime: toEpochMs(row.timestamp),
          });
        } else if (row.market_time === 'pr' && previousClose === null) {
          // ORDER BY timestamp ASC guarantees the first pr row we see
          // is the earliest premarket bar of the session.
          const prOpen = numOrNull(row.open);
          if (prOpen !== null) previousClose = prOpen;
        }
      }

      return { candles, previousClose };
    }

    logger.warn(
      { date: targetDate },
      'spx_candles_1m empty for date; falling back to live UW 5m fetch',
    );
  } catch (err) {
    logger.error(
      { err },
      'Failed to read spx_candles_1m; falling back to live UW 5m fetch',
    );
    metrics.increment('spx_candles.fetch_error');
    Sentry.captureException(err);
  }

  // ── Fallback: live UW 5-minute endpoint ────────────────────
  return fetchSPXCandlesLive(apiKey, date, spyToSpxRatio);
}

/**
 * Live fallback: fetch 5-minute SPY candles from UW and translate to
 * SPX. Degraded mode — only used when `spx_candles_1m` is empty for the
 * requested date. Kept on the 5m endpoint (not 1m) so existing test
 * fixtures continue to apply and so the fallback is clearly lower
 * fidelity than the primary path.
 */
async function fetchSPXCandlesLive(
  apiKey: string,
  date: string | undefined,
  spyToSpxRatio: number,
): Promise<{
  candles: SPXCandle[];
  previousClose: number | null;
}> {
  try {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    // Limit to today's candles only — regular session is ~78 bars
    params.set('limit', '500');

    const qs = params.toString();
    const suffix = qs ? '?' + qs : '';

    const candles = await uwFetch<UWCandle>(
      apiKey,
      `/stock/SPY/ohlc/5m${suffix}`,
    );

    if (!candles.length) {
      return { candles: [], previousClose: null };
    }

    // Filter to regular session only, normalize, and translate to SPX
    const regularCandles = candles
      .filter((c) => c.market_time === 'r')
      .map(
        (c): SPXCandle => ({
          open: Number.parseFloat(c.open) * spyToSpxRatio,
          high: Number.parseFloat(c.high) * spyToSpxRatio,
          low: Number.parseFloat(c.low) * spyToSpxRatio,
          close: Number.parseFloat(c.close) * spyToSpxRatio,
          volume: c.volume,
          datetime: new Date(c.start_time).getTime(),
        }),
      )
      .filter(
        (c) =>
          !Number.isNaN(c.open) &&
          !Number.isNaN(c.high) &&
          !Number.isNaN(c.low) &&
          !Number.isNaN(c.close),
      )
      .sort((a, b) => a.datetime - b.datetime);

    // Derive previous close from the first premarket candle's open,
    // translated to SPX via ratio
    let previousClose: number | null = null;
    const prCandles = candles.filter((c) => c.market_time === 'pr');
    if (prCandles.length > 0) {
      const firstPr = Number.parseFloat(prCandles[0]!.open);
      if (!Number.isNaN(firstPr)) previousClose = firstPr * spyToSpxRatio;
    }

    return { candles: regularCandles, previousClose };
  } catch (err) {
    logger.error({ err }, 'Failed to fetch SPY candles from UW');
    metrics.increment('spx_candles.fetch_error');
    Sentry.captureException(err);
    return { candles: [], previousClose: null };
  }
}

// ── Format for Claude ───────────────────────────────────────

/**
 * Format SPX candles as structured text for Claude's context.
 *
 * IMPORTANT: this formatter consumes 1-minute candles (~390 per
 * regular session) and emits the FULL session with NO truncation into
 * Claude's prompt. The owner has explicitly accepted the token-cost
 * trade-off in exchange for granular intraday visibility. See
 * `docs/superpowers/plans/gex-target-rebuild.md` Phase 3 — do not
 * reintroduce truncation without re-confirming with the owner.
 *
 * Provides:
 *   - Session OHLC summary over the full session
 *   - Gap analysis (vs previous close)
 *   - Key structural features tuned to 1m resolution:
 *       - Higher lows / lower highs over the last 15 candles (~15 min)
 *       - Range compression (last 15 vs first 15 candles)
 *       - Wide-range bar detection (> 2x average range AND > 5 pts)
 *   - Approx session VWAP (running sum, candle-period agnostic)
 *   - Last 30 candles as a compact table (= last 30 minutes of detail)
 *   - Range consumed relative to straddle cone (if provided)
 *
 * @param candles - 1-min OHLCV candles (time ascending)
 * @param previousClose - Previous session close
 * @param coneUpper - Optional straddle cone upper boundary
 * @param coneLower - Optional straddle cone lower boundary
 * @returns Formatted text block, or null if no data
 */
export function formatSPXCandlesForClaude(
  candles: SPXCandle[],
  previousClose: number | null,
  coneUpper?: number,
  coneLower?: number,
): string | null {
  if (candles.length === 0) return null;

  const lines: string[] = [];

  // Session OHLC
  const sessionOpen = candles[0]!.open;
  let sessionHigh = -Infinity;
  let sessionLow = Infinity;
  const sessionClose = candles.at(-1)!.close;

  for (const c of candles) {
    if (c.high > sessionHigh) sessionHigh = c.high;
    if (c.low < sessionLow) sessionLow = c.low;
  }

  const sessionRange = sessionHigh - sessionLow;
  const latestTime = new Date(candles.at(-1)!.datetime);
  const firstTime = new Date(candles[0]!.datetime);

  const fmtTime = (d: Date) =>
    d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

  lines.push(
    `SPX Intraday Price Data (1-min candles, full session):`,
    `  Session: ${fmtTime(firstTime)} – ${fmtTime(latestTime)} ET`,
    `  Open: ${sessionOpen.toFixed(2)} | High: ${sessionHigh.toFixed(2)} | Low: ${sessionLow.toFixed(2)} | Last: ${sessionClose.toFixed(2)}`,
    `  Session Range: ${sessionRange.toFixed(1)} pts`,
  );

  // Previous close and gap
  if (previousClose != null) {
    const gap = sessionOpen - previousClose;
    const gapPct = ((gap / previousClose) * 100).toFixed(2);
    const gapDir = gap > 0 ? 'UP' : gap < 0 ? 'DOWN' : 'FLAT';
    lines.push(
      `  Previous Close: ${previousClose.toFixed(2)} | Gap: ${gapDir} ${Math.abs(gap).toFixed(1)} pts (${gapPct}%)`,
    );
  }

  // Cone context
  if (coneUpper != null && coneLower != null) {
    const coneWidth = coneUpper - coneLower;
    const consumed = coneWidth > 0 ? (sessionRange / coneWidth) * 100 : 0;
    const priceInCone = sessionClose >= coneLower && sessionClose <= coneUpper;
    lines.push(
      `  Straddle Cone: ${coneLower.toFixed(1)} – ${coneUpper.toFixed(1)} (${coneWidth.toFixed(0)} pts)`,
      `  Range consumed: ${consumed.toFixed(0)}% of cone | Price ${priceInCone ? 'INSIDE' : 'OUTSIDE'} cone`,
    );
  }

  // ── Structural analysis ─────────────────────────────────
  lines.push('');

  // Higher lows / lower highs detection (last 15 1-min candles).
  // At 1m resolution, a 15-minute window is long enough to establish
  // a pattern. Threshold stays at 2/3 of the window (was 4/6).
  const TREND_WINDOW = 15;
  const TREND_THRESHOLD = 10;
  if (candles.length >= TREND_WINDOW) {
    const recent = candles.slice(-TREND_WINDOW);
    let higherLows = 0;
    let lowerHighs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i]!.low > recent[i - 1]!.low) higherLows++;
      if (recent[i]!.high < recent[i - 1]!.high) lowerHighs++;
    }

    if (higherLows >= TREND_THRESHOLD) {
      lines.push(
        `  Pattern: HIGHER LOWS (${TREND_THRESHOLD}+ of last ${TREND_WINDOW} candles) — uptrend intact, selling pressure not translating to lower prices`,
      );
    } else if (lowerHighs >= TREND_THRESHOLD) {
      lines.push(
        `  Pattern: LOWER HIGHS (${TREND_THRESHOLD}+ of last ${TREND_WINDOW} candles) — downtrend intact, buying pressure not translating to higher prices`,
      );
    }

    // Range compression (last 15 vs first 15 1-min candles)
    if (candles.length >= TREND_WINDOW * 2) {
      const early = candles.slice(0, TREND_WINDOW);
      const late = candles.slice(-TREND_WINDOW);
      const earlyAvgRange =
        early.reduce((s, c) => s + (c.high - c.low), 0) / early.length;
      const lateAvgRange =
        late.reduce((s, c) => s + (c.high - c.low), 0) / late.length;
      if (lateAvgRange < earlyAvgRange * 0.5) {
        lines.push(
          `  Pattern: RANGE COMPRESSION — recent candles averaging ${lateAvgRange.toFixed(1)} pts vs ${earlyAvgRange.toFixed(1)} pts earlier. Narrowing range often precedes a breakout.`,
        );
      }
    }
  }

  // Wide-range bar detection (any candle > 2x average range AND > 5 pts).
  // The 5-pt floor is still meaningful at 1m resolution because typical
  // 1-min SPX ranges are 2–3 pts, so a > 5 pt bar is already exceptional.
  if (candles.length >= 4) {
    const avgRange =
      candles.reduce((s, c) => s + (c.high - c.low), 0) / candles.length;
    const wideBars = candles.filter(
      (c) => c.high - c.low > avgRange * 2 && c.high - c.low > 5,
    );
    if (wideBars.length > 0) {
      const latest = wideBars.at(-1)!;
      const barTime = fmtTime(new Date(latest.datetime));
      const barRange = (latest.high - latest.low).toFixed(1);
      const barDir = latest.close > latest.open ? 'bullish' : 'bearish';
      lines.push(
        `  Wide-Range Bar: ${barTime} ET — ${barRange} pts ${barDir} (${(latest.high - latest.low).toFixed(1)}/${avgRange.toFixed(1)} avg). ${wideBars.length} total wide bars this session.`,
      );
    }
  }

  // Price relative to session VWAP approximation. Running sum — works
  // for any candle period, no change needed for 1m resolution.
  // Also computes volume-weighted standard deviation for sigma bands.
  const totalVolume = candles.reduce((s, c) => s + c.volume, 0);
  if (totalVolume > 0) {
    const vwap =
      candles.reduce(
        (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume,
        0,
      ) / totalVolume;

    const variance =
      candles.reduce((s, c) => {
        const tp = (c.high + c.low + c.close) / 3;
        const diff = tp - vwap;
        return s + diff * diff * c.volume;
      }, 0) / totalVolume;
    const stdDev = Math.sqrt(variance);

    if (stdDev > 0) {
      const sigma1Lo = vwap - stdDev;
      const sigma1Hi = vwap + stdDev;
      const sigma2Lo = vwap - 2 * stdDev;
      const sigma2Hi = vwap + 2 * stdDev;
      const sigmaDist = (sessionClose - vwap) / stdDev;
      const sigmaAbs = Math.abs(sigmaDist).toFixed(1);
      const sigmaDir = sigmaDist > 0 ? 'above' : sigmaDist < 0 ? 'below' : 'at';
      const sigma1Band = `[${sigma1Lo.toFixed(1)}, ${sigma1Hi.toFixed(1)}]`;
      const sigma2Band = `[${sigma2Lo.toFixed(1)}, ${sigma2Hi.toFixed(1)}]`;
      const sigmaLabel =
        sigmaDir === 'at' ? '0.0σ at VWAP' : `${sigmaAbs}σ ${sigmaDir} VWAP`;
      lines.push(
        `  Approx VWAP: ${vwap.toFixed(1)} | ±1σ: ${sigma1Band} | ±2σ: ${sigma2Band} | Price ${sigmaLabel}`,
      );
    } else {
      // All candles printed at identical typical price — sigma undefined;
      // fall back to simple point-distance format.
      const vwapDist = sessionClose - vwap;
      const distDir = vwapDist > 0 ? 'above' : 'below';
      lines.push(
        `  Approx VWAP: ${vwap.toFixed(1)} | Price ${distDir} VWAP by ${Math.abs(vwapDist).toFixed(1)} pts`,
      );
    }
  }

  // ── Recent candle table (last 30 = 30 minutes of detail) ───
  const RECENT_WINDOW = 30;
  const recentCandles = candles.slice(-RECENT_WINDOW);
  lines.push(
    '',
    `  Recent 1-min Candles (last ${RECENT_WINDOW}):`,
    '    Time ET     | Open    | High    | Low     | Close   | Range | Vol',
  );

  for (const c of recentCandles) {
    const time = fmtTime(new Date(c.datetime));
    const range = (c.high - c.low).toFixed(1);
    const dir = c.close >= c.open ? '▲' : '▼';
    lines.push(
      `    ${time} ${dir} | ${c.open.toFixed(2)} | ${c.high.toFixed(2)} | ${c.low.toFixed(2)} | ${c.close.toFixed(2)} | ${range.padStart(5)} | ${c.volume.toLocaleString()}`,
    );
  }

  return lines.join('\n');
}
