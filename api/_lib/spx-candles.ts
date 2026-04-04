/**
 * SPX Intraday Candles (Unusual Whales)
 *
 * Fetches 5-minute OHLCV candles from the UW API and translates to
 * SPX-equivalent prices. Uses SPY as the source ticker because Cboe
 * prohibits external distribution of proprietary index prices (SPX,
 * VIX, RUT, etc.) via API — only their web platform is allowed.
 * SPY prices are multiplied by the SPX/SPY ratio to produce
 * approximate SPX candles.
 *
 * Used on-demand at analysis time (not a cron) to give Claude price
 * structure context: higher lows, range compression, wide-range bars,
 * session high/low relative to the straddle cone.
 *
 * Uses the same UW_API_KEY as all other UW integrations — no separate
 * OAuth dependency.
 */
import logger from './logger.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Types ───────────────────────────────────────────────────

/** UW candle format from /stock/SPY/ohlc/5m */
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

interface UWOHLCResponse {
  data: UWCandle[];
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

// ── Fetch ───────────────────────────────────────────────────

/**
 * Fetch today's 5-minute candles via SPY and translate to SPX prices.
 *
 * Cboe prohibits SPX index OHLC distribution via API, so we fetch SPY
 * candles and multiply by the SPX/SPY ratio. Returns candles ordered
 * by time ascending, or empty array on failure.
 *
 * Only returns regular-session candles (market_time === 'r').
 *
 * @param apiKey - UW API key
 * @param date - Optional date string (YYYY-MM-DD)
 * @param spyToSpxRatio - SPX/SPY price ratio (default 10)
 */
export async function fetchSPXCandles(
  apiKey: string,
  date?: string,
  spyToSpxRatio = 10,
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
    const url = `${UW_BASE}/stock/SPY/ohlc/5m${suffix}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: body.slice(0, 200) },
        'UW candles API returned non-OK',
      );
      return { candles: [], previousClose: null };
    }

    const data: UWOHLCResponse = await res.json();

    if (!data.data?.length) {
      return { candles: [], previousClose: null };
    }

    // Filter to regular session only, normalize, and translate to SPX
    const regularCandles = data.data
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
    const prCandles = data.data.filter((c) => c.market_time === 'pr');
    if (prCandles.length > 0) {
      const firstPr = Number.parseFloat(prCandles[0]!.open);
      if (!Number.isNaN(firstPr)) previousClose = firstPr * spyToSpxRatio;
    }

    return { candles: regularCandles, previousClose };
  } catch (err) {
    logger.error({ err }, 'Failed to fetch SPY candles from UW');
    return { candles: [], previousClose: null };
  }
}

// ── Format for Claude ───────────────────────────────────────

/**
 * Format SPX candles as structured text for Claude's context.
 * Provides:
 *   - Session OHLC summary
 *   - Gap analysis (vs previous close)
 *   - Key structural features (higher lows, range compression, wide bars)
 *   - Approx VWAP
 *   - Last 12 candles as a compact table
 *   - Range consumed relative to straddle cone (if provided)
 *
 * @param candles - 5-min OHLCV candles (time ascending)
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
    `SPX Intraday Price Data (5-min candles):`,
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

  // Higher lows / lower highs detection (last 6 candles)
  if (candles.length >= 6) {
    const recent = candles.slice(-6);
    let higherLows = 0;
    let lowerHighs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i]!.low > recent[i - 1]!.low) higherLows++;
      if (recent[i]!.high < recent[i - 1]!.high) lowerHighs++;
    }

    if (higherLows >= 4) {
      lines.push(
        '  Pattern: HIGHER LOWS (4+ of last 6 candles) — uptrend intact, selling pressure not translating to lower prices',
      );
    } else if (lowerHighs >= 4) {
      lines.push(
        '  Pattern: LOWER HIGHS (4+ of last 6 candles) — downtrend intact, buying pressure not translating to higher prices',
      );
    }

    // Range compression (last 6 vs first 6 candles)
    if (candles.length >= 12) {
      const early = candles.slice(0, 6);
      const late = candles.slice(-6);
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

  // Wide-range bar detection (any candle > 2x average range)
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

  // Price relative to session VWAP approximation
  const totalVolume = candles.reduce((s, c) => s + c.volume, 0);
  if (totalVolume > 0) {
    const vwap =
      candles.reduce(
        (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume,
        0,
      ) / totalVolume;
    const vwapDist = sessionClose - vwap;
    lines.push(
      `  Approx VWAP: ${vwap.toFixed(1)} | Price ${vwapDist > 0 ? 'above' : 'below'} VWAP by ${Math.abs(vwapDist).toFixed(1)} pts`,
    );
  }

  // ── Recent candle table (last 12) ─────────────────────────
  const recentCandles = candles.slice(-12);
  lines.push(
    '',
    '  Recent 5-min Candles:',
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
