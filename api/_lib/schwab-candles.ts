/**
 * Schwab SPX Intraday Candles
 *
 * Fetches 5-minute OHLCV candles for $SPX from the Schwab Market Data API.
 * Used on-demand at analysis time (not a cron) to give Claude price
 * structure context: higher lows, range compression, wide-range bars,
 * session high/low relative to the straddle cone.
 *
 * Uses the same OAuth token as positions (getAccessToken from schwab.ts).
 */
import { getAccessToken } from './schwab.js';
import logger from './logger.js';

const MARKET_DATA_BASE = 'https://api.schwabapi.com/marketdata/v1';

// ── Types ───────────────────────────────────────────────────

export interface SPXCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  datetime: number; // epoch ms
}

interface PriceHistoryResponse {
  symbol: string;
  empty: boolean;
  previousClose?: number;
  candles: SPXCandle[];
}

// ── Fetch ───────────────────────────────────────────────────

/**
 * Fetch today's 5-minute SPX candles from Schwab Market Data API.
 * Returns candles ordered by time ascending, or empty array on failure.
 *
 * Uses the same OAuth token as positions — no separate auth needed.
 */
export async function fetchSPXCandles(): Promise<{
  candles: SPXCandle[];
  previousClose: number | null;
}> {
  const authResult = await getAccessToken();
  if ('error' in authResult) {
    logger.warn(
      { err: authResult.error },
      'Schwab auth failed for candles fetch — skipping',
    );
    return { candles: [], previousClose: null };
  }

  try {
    const params = new URLSearchParams({
      symbol: '$SPX',
      periodType: 'day',
      period: '1',
      frequencyType: 'minute',
      frequency: '5',
      needPreviousClose: 'true',
    });

    const res = await fetch(`${MARKET_DATA_BASE}/pricehistory?${params}`, {
      headers: { Authorization: `Bearer ${authResult.token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: body.slice(0, 200) },
        'Schwab candles API returned non-OK',
      );
      return { candles: [], previousClose: null };
    }

    const data: PriceHistoryResponse = await res.json();
    if (data.empty || !data.candles?.length) {
      return { candles: [], previousClose: data.previousClose ?? null };
    }

    // Sort by time ascending (should already be, but ensure)
    const sorted = data.candles.sort((a, b) => a.datetime - b.datetime);

    return {
      candles: sorted,
      previousClose: data.previousClose ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to fetch SPX candles from Schwab');
    return { candles: [], previousClose: null };
  }
}

// ── Format for Claude ───────────────────────────────────────

/**
 * Format SPX candles as structured text for Claude's context.
 * Provides:
 *   - Session OHLC summary
 *   - Key structural features (higher lows, range compression, wide bars)
 *   - Last 12 candles as a compact table
 *   - Range consumed relative to straddle cone (if provided)
 *
 * @param candles - 5-min OHLCV candles (time ascending)
 * @param previousClose - Previous session close
 * @param entryTimeStr - Optional entry time to filter candles (e.g. "9:35 AM CT")
 * @param coneUpper - Optional straddle cone upper boundary
 * @param coneLower - Optional straddle cone lower boundary
 * @returns Formatted text block, or null if no data
 */
export function formatSPXCandlesForClaude(
  candles: SPXCandle[],
  previousClose: number | null,
  _entryTimeStr?: string,
  coneUpper?: number,
  coneLower?: number,
): string | null {
  if (candles.length === 0) return null;

  const lines: string[] = [];

  // Session OHLC
  const sessionOpen = candles[0]!.open;
  let sessionHigh = -Infinity;
  let sessionLow = Infinity;
  const sessionClose = candles[candles.length - 1]!.close;

  for (const c of candles) {
    if (c.high > sessionHigh) sessionHigh = c.high;
    if (c.low < sessionLow) sessionLow = c.low;
  }

  const sessionRange = sessionHigh - sessionLow;
  const latestTime = new Date(candles[candles.length - 1]!.datetime);
  const firstTime = new Date(candles[0]!.datetime);

  const fmtTime = (d: Date) =>
    d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

  lines.push(
    `SPX Intraday Price Data (from Schwab, 5-min candles):`,
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

    // Range compression (last 6 candles average range vs first 6)
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
      const latest = wideBars[wideBars.length - 1]!;
      const barTime = fmtTime(new Date(latest.datetime));
      const barRange = (latest.high - latest.low).toFixed(1);
      const barDir = latest.close > latest.open ? 'bullish' : 'bearish';
      lines.push(
        `  Wide-Range Bar: ${barTime} ET — ${barRange} pts ${barDir} (${(latest.high - latest.low).toFixed(1)}/${avgRange.toFixed(1)} avg). ${wideBars.length} total wide bars this session.`,
      );
    }
  }

  // Price relative to session VWAP approximation (volume-weighted)
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
