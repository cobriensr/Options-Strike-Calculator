/**
 * SPY Dark Pool Block Trade Analysis
 *
 * Fetches large SPY dark pool prints from Unusual Whales API,
 * clusters them by price level, identifies buyer/seller-initiated trades,
 * and translates SPY prices to approximate SPX levels.
 *
 * SPX is an index and doesn't trade on dark pools — SPY is the ETF proxy.
 * Large SPY blocks ($5M+) indicate institutional support/resistance levels
 * that aren't visible in options flow, gamma, or charm data.
 *
 * Called on-demand at analysis time — not a cron job.
 * Uses the existing UW_API_KEY.
 */
import logger from './logger.js';
import { metrics, Sentry } from './sentry.js';
import { getCTTime, getETDateStr } from '../../src/utils/timezone.js';

const UW_BASE = 'https://api.unusualwhales.com/api';

// ── Intraday-window guard ───────────────────────────────────

/**
 * Regular-hours US equity session in Central Time:
 * 08:30 inclusive → 15:00 exclusive (minutes-of-day 510..900).
 *
 * `ext_hour_sold_codes` catches trades that UW flags as extended-hours,
 * but it does NOT catch regular-session-flagged trades whose `executed_at`
 * falls outside normal RTH — e.g. 06:15 CT pre-open block prints with
 * `ext_hour_sold_codes: null`. Per trader preference, those distort the
 * intraday volume profile and must be dropped before aggregation.
 */
const INTRADAY_START_MIN_CT = 8 * 60 + 30; // 08:30 CT
const INTRADAY_END_MIN_CT = 15 * 60; // 15:00 CT (exclusive)

function isIntradayCT(executedAt: string): boolean {
  const d = new Date(executedAt);
  if (Number.isNaN(d.getTime())) return false;
  const { hour, minute } = getCTTime(d);
  const mins = hour * 60 + minute;
  return mins >= INTRADAY_START_MIN_CT && mins < INTRADAY_END_MIN_CT;
}

// ── Types ───────────────────────────────────────────────────

export interface DarkPoolTrade {
  canceled: boolean;
  executed_at: string;
  ext_hour_sold_codes: string | null;
  market_center: string;
  nbbo_ask: string;
  nbbo_ask_quantity: number;
  nbbo_bid: string;
  nbbo_bid_quantity: number;
  premium: string;
  price: string;
  sale_cond_codes: string | null;
  size: number;
  ticker: string;
  tracking_id: number;
  trade_code: string | null;
  trade_settlement: string;
  volume: number;
}

export interface DarkPoolCluster {
  spyPriceLow: number;
  spyPriceHigh: number;
  spxApprox: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  buyerInitiated: number;
  sellerInitiated: number;
  neutral: number;
  latestTime: string;
}

// ── Fetch ───────────────────────────────────────────────────

/**
 * Fetch large SPY dark pool trades for a given date.
 * Filters to $5M+ premium to capture only institutional blocks.
 * Returns raw trades or empty array on failure.
 */
export async function fetchDarkPoolBlocks(
  apiKey: string,
  date?: string,
  minPremium: number = 5_000_000,
): Promise<DarkPoolTrade[]> {
  try {
    const params = new URLSearchParams({
      min_premium: minPremium.toString(),
      limit: '500',
    });
    if (date) params.set('date', date);

    const res = await fetch(`${UW_BASE}/darkpool/SPY?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: text.slice(0, 200) },
        'Dark pool API returned non-OK',
      );
      return [];
    }

    const body = await res.json();
    const trades: DarkPoolTrade[] = body.data ?? [];

    // Filter out canceled trades, extended-hours-only trades, and
    // uncertain-price trades. Average-price and derivative-priced
    // trades reflect a blended price over a period — they don't
    // represent confirmed execution at the stated price, so they
    // can inflate premium at price levels where no real institutional
    // conviction existed.
    //
    // `contingent_trade` prints are pre-arranged swap resets / basket
    // unwinds that clear on the tape at session-unrelated prices; they
    // distort the per-level volume profile and must be dropped
    // unconditionally. (If UW exposes further pre-arranged codes like
    // `cross_trade` or `form_t` in the future, add them here.)
    //
    // The intraday-window guard drops anything that falls outside
    // 08:30–15:00 CT — `ext_hour_sold_codes` alone misses
    // regular-session-flagged trades that print pre-open or after 15:00.
    //
    // Also enforce a hard ET-date guard when a date is specified: UW's
    // date filter can be loose, so we never trust it alone.
    return trades.filter((t) => {
      if (t.canceled) return false;
      if (t.ext_hour_sold_codes) return false;
      if (
        t.trade_settlement !== 'regular' &&
        t.trade_settlement !== 'regular_settlement'
      ) {
        return false;
      }
      if (t.sale_cond_codes === 'average_price_trade') return false;
      if (t.sale_cond_codes === 'contingent_trade') return false;
      if (t.trade_code === 'derivative_priced') return false;
      if (!isIntradayCT(t.executed_at)) return false;
      if (date && getETDateStr(new Date(t.executed_at)) !== date) return false;
      return true;
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch dark pool data');
    metrics.increment('darkpool.fetch_error');
    Sentry.captureException(err);
    return [];
  }
}

/**
 * Fetch SPY dark pool trades for a date by paginating through
 * the UW API in batches of 500 using the `older_than` cursor.
 * No premium floor — captures the full tape for accurate level aggregation.
 * Applies the same quality filters as fetchDarkPoolBlocks.
 *
 * @param opts.newerThan - Unix timestamp cursor; only fetch trades after this
 * @param opts.maxPages - safety limit on pagination (default 100 = 50K trades)
 */
export async function fetchAllDarkPoolTrades(
  apiKey: string,
  date?: string,
  opts: { newerThan?: number; maxPages?: number } = {},
): Promise<DarkPoolTrade[]> {
  const { newerThan, maxPages = 100 } = opts;
  const all: DarkPoolTrade[] = [];
  let olderThan: number | undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        min_premium: '0',
        limit: '500',
      });
      if (date) params.set('date', date);
      if (newerThan != null) params.set('newer_than', String(newerThan));
      if (olderThan != null) params.set('older_than', String(olderThan));

      const res = await fetch(`${UW_BASE}/darkpool/SPY?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn(
          { status: res.status, body: text.slice(0, 200), page },
          'Dark pool paginated fetch non-OK',
        );
        break;
      }

      const body = await res.json();
      const batch: DarkPoolTrade[] = body.data ?? [];

      if (batch.length === 0) break;

      all.push(...batch);

      // Use the oldest trade's timestamp as the cursor for the next page
      const oldest = batch.at(-1);
      if (!oldest) break;

      // Defense in depth: if the oldest trade in this page has already
      // crossed the requested ET date boundary, stop paginating. UW's
      // `date` parameter can be loose when combined with `older_than`,
      // and without this guard the loop walks backward into prior sessions
      // and pollutes today's aggregates with yesterday's tape.
      if (date) {
        const oldestEtDate = getETDateStr(new Date(oldest.executed_at));
        if (oldestEtDate < date) break;
      }

      const oldestTs = Math.floor(
        new Date(oldest.executed_at).getTime() / 1000,
      );
      // If cursor didn't advance, we're stuck — stop
      if (olderThan != null && oldestTs >= olderThan) break;
      olderThan = oldestTs;

      // Less than 500 means we got the last page
      if (batch.length < 500) break;

      // Rate limit: UW allows 120 req/60s. 600ms between pages = ~1.7/sec.
      await new Promise((r) => setTimeout(r, 600));
    }
  } catch (err) {
    logger.error({ err, fetched: all.length }, 'Dark pool pagination error');
  }

  // Apply the same quality filters, plus a hard ET-date guard.
  // The date guard is defense in depth against UW's date/older_than
  // interaction so a contaminated page still can't reach the DB.
  // See `fetchDarkPoolBlocks` for the rationale on each filter —
  // the two chains must stay in sync.
  return all.filter((t) => {
    if (t.canceled) return false;
    if (t.ext_hour_sold_codes) return false;
    if (
      t.trade_settlement !== 'regular' &&
      t.trade_settlement !== 'regular_settlement'
    ) {
      return false;
    }
    if (t.sale_cond_codes === 'average_price_trade') return false;
    if (t.sale_cond_codes === 'contingent_trade') return false;
    if (t.trade_code === 'derivative_priced') return false;
    if (!isIntradayCT(t.executed_at)) return false;
    if (date && getETDateStr(new Date(t.executed_at)) !== date) return false;
    return true;
  });
}

// ── Clustering ──────────────────────────────────────────────

/**
 * Cluster dark pool trades by SPY price level (±$0.50 bands).
 * Identifies buyer vs seller initiated by comparing trade price to NBBO.
 * Translates SPY prices to approximate SPX levels.
 *
 * @param trades - Raw dark pool trades
 * @param spyToSpxRatio - SPX/SPY ratio for translation (default ~10)
 * @returns Clusters sorted by total premium descending
 */
export function clusterDarkPoolTrades(
  trades: DarkPoolTrade[],
  spyToSpxRatio = 10,
): DarkPoolCluster[] {
  if (trades.length === 0) return [];

  // Group into $0.50 price bands
  const bands = new Map<number, DarkPoolTrade[]>();
  for (const trade of trades) {
    const price = Number.parseFloat(trade.price);
    if (Number.isNaN(price)) continue;
    // Round to nearest $0.50
    const band = Math.round(price * 2) / 2;
    const existing = bands.get(band) ?? [];
    existing.push(trade);
    bands.set(band, existing);
  }

  // Build clusters
  const clusters: DarkPoolCluster[] = [];
  for (const [band, bandTrades] of bands) {
    let totalPremium = 0;
    let totalShares = 0;
    let buyerInitiated = 0;
    let sellerInitiated = 0;
    let neutral = 0;
    let latestTime = '';
    let priceLow = Infinity;
    let priceHigh = -Infinity;

    for (const t of bandTrades) {
      const price = Number.parseFloat(t.price);
      const ask = Number.parseFloat(t.nbbo_ask);
      const bid = Number.parseFloat(t.nbbo_bid);
      const premium = Number.parseFloat(t.premium);

      if (!Number.isNaN(premium)) totalPremium += premium;
      totalShares += t.size;

      if (price < priceLow) priceLow = price;
      if (price > priceHigh) priceHigh = price;

      if (t.executed_at > latestTime) latestTime = t.executed_at;

      // Classify trade direction by comparing to NBBO
      if (!Number.isNaN(ask) && !Number.isNaN(bid)) {
        const mid = (ask + bid) / 2;
        if (price >= ask - 0.005) {
          buyerInitiated++;
        } else if (price <= bid + 0.005) {
          sellerInitiated++;
        } else if (price >= mid) {
          buyerInitiated++;
        } else {
          sellerInitiated++;
        }
      } else {
        neutral++;
      }
    }

    clusters.push({
      spyPriceLow: priceLow,
      spyPriceHigh: priceHigh,
      spxApprox: Math.round(band * spyToSpxRatio),
      totalPremium,
      tradeCount: bandTrades.length,
      totalShares,
      buyerInitiated,
      sellerInitiated,
      neutral,
      latestTime,
    });
  }

  // Sort by total premium descending (most significant clusters first)
  return clusters.sort((a, b) => b.totalPremium - a.totalPremium);
}

// ── Per-strike aggregation (dashboard) ─────────────────────

export interface DarkPoolStrikeLevel {
  spxLevel: number;
  totalPremium: number;
  tradeCount: number;
  totalShares: number;
  latestTime: string;
}

/**
 * Aggregate dark pool trades by $1 SPX strike level.
 * No direction classification — just premium accumulation per level.
 * Used by the dashboard cron to show institutional support/resistance.
 *
 * @returns Levels sorted by total premium descending
 */
export function aggregateDarkPoolLevels(
  trades: DarkPoolTrade[],
  spyToSpxRatio = 10,
): DarkPoolStrikeLevel[] {
  if (trades.length === 0) return [];

  const levels = new Map<
    number,
    {
      totalPremium: number;
      tradeCount: number;
      totalShares: number;
      latestTime: string;
    }
  >();

  for (const trade of trades) {
    const price = Number.parseFloat(trade.price);
    if (Number.isNaN(price)) continue;

    const spxLevel = Math.round(price * spyToSpxRatio);
    const premium = Number.parseFloat(trade.premium) || 0;

    const existing = levels.get(spxLevel) ?? {
      totalPremium: 0,
      tradeCount: 0,
      totalShares: 0,
      latestTime: '',
    };

    existing.totalPremium += premium;
    existing.tradeCount += 1;
    existing.totalShares += trade.size;
    if (trade.executed_at > existing.latestTime) {
      existing.latestTime = trade.executed_at;
    }

    levels.set(spxLevel, existing);
  }

  return [...levels.entries()]
    .map(([spxLevel, data]) => ({ spxLevel, ...data }))
    .sort((a, b) => b.totalPremium - a.totalPremium);
}

// ── Format for Claude ───────────────────────────────────────

/**
 * Format dark pool block trade data for Claude's context.
 * Shows institutional support/resistance levels from large SPY dark pool prints,
 * translated to approximate SPX levels.
 *
 * @param trades - Raw dark pool trades
 * @param currentSpx - Current SPX price for relative positioning
 * @param spyToSpxRatio - SPX/SPY ratio (default ~10)
 * @returns Formatted text block, or null if no significant blocks
 */
export function formatDarkPoolForClaude(
  trades: DarkPoolTrade[],
  currentSpx?: number,
  spyToSpxRatio = 10,
): string | null {
  if (trades.length === 0) return null;

  const clusters = clusterDarkPoolTrades(trades, spyToSpxRatio);

  if (clusters.length === 0) return null;

  const lines: string[] = [];

  // Summary
  const totalPremium = clusters.reduce((s, c) => s + c.totalPremium, 0);
  const totalTrades = clusters.reduce((s, c) => s + c.tradeCount, 0);
  const totalBuyer = clusters.reduce((s, c) => s + c.buyerInitiated, 0);
  const totalSeller = clusters.reduce((s, c) => s + c.sellerInitiated, 0);

  lines.push(
    `SPY Dark Pool Block Trades (from API, $5M+ blocks):`,
    `  Total: ${totalTrades} blocks, $${fmtDp(totalPremium)} aggregate premium`,
    `  Direction: ${totalBuyer} buyer-initiated, ${totalSeller} seller-initiated`,
    '',
  );

  // Net direction
  if (totalBuyer > totalSeller * 1.5) {
    lines.push(
      '  NET BIAS: Buyer-dominated — institutions accumulating at these levels. Supports put-side structural floors.',
    );
  } else if (totalSeller > totalBuyer * 1.5) {
    lines.push(
      '  NET BIAS: Seller-dominated — institutions distributing at these levels. Supports call-side structural ceilings.',
    );
  } else {
    lines.push(
      '  NET BIAS: Mixed — no clear directional bias from dark pool activity.',
    );
  }
  lines.push('', '  Key Institutional Levels (by premium):');
  const topClusters = clusters.slice(0, 8);

  for (const c of topClusters) {
    const time = new Date(c.latestTime).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });

    const direction =
      c.buyerInitiated > c.sellerInitiated
        ? 'BUYER'
        : c.sellerInitiated > c.buyerInitiated
          ? 'SELLER'
          : 'MIXED';

    let relativePosition = '';
    if (currentSpx != null) {
      const dist = c.spxApprox - currentSpx;
      if (Math.abs(dist) < 3) {
        relativePosition = ' ← AT PRICE';
      } else if (dist > 0) {
        relativePosition = ` (${Math.round(dist)} pts above)`;
      } else {
        relativePosition = ` (${Math.round(Math.abs(dist))} pts below)`;
      }
    }

    lines.push(
      `    SPX ~${c.spxApprox}${relativePosition}: $${fmtDp(c.totalPremium)} | ${c.tradeCount} block${c.tradeCount > 1 ? 's' : ''} | ${c.totalShares.toLocaleString()} shares | ${direction} | ${time} ET`,
    );

    // Note if this aligns with gamma walls or cone boundaries
    if (currentSpx != null) {
      const dist = Math.abs(c.spxApprox - currentSpx);
      if (dist <= 5 && c.buyerInitiated > c.sellerInitiated) {
        lines.push(
          `      ↳ Institutional buying AT current price — strong floor signal`,
        );
      }
    }
  }

  // Structural summary
  const buyerClusters = topClusters.filter(
    (c) => c.buyerInitiated > c.sellerInitiated,
  );
  const sellerClusters = topClusters.filter(
    (c) => c.sellerInitiated > c.buyerInitiated,
  );

  if (buyerClusters.length > 0 || sellerClusters.length > 0) {
    lines.push('');
    if (buyerClusters.length > 0) {
      const levels = buyerClusters.map((c) => `${c.spxApprox}`).join(', ');
      lines.push(`  Dark Pool Support Levels: SPX ~${levels}`);
    }
    if (sellerClusters.length > 0) {
      const levels = sellerClusters.map((c) => `${c.spxApprox}`).join(', ');
      lines.push(`  Dark Pool Resistance Levels: SPX ~${levels}`);
    }
  }

  // Support/resistance premium ratio (relative to current price)
  if (currentSpx != null) {
    let supportPremium = 0;
    let resistancePremium = 0;
    for (const c of clusters) {
      if (c.spxApprox <= currentSpx) {
        supportPremium += c.totalPremium;
      } else {
        resistancePremium += c.totalPremium;
      }
    }
    if (supportPremium > 0 || resistancePremium > 0) {
      const srRatio =
        resistancePremium > 0
          ? (supportPremium / resistancePremium).toFixed(2)
          : 'INF';
      lines.push(
        '',
        `  Support/Resistance Premium Ratio: ${srRatio} ($${fmtDp(supportPremium)} below price / $${fmtDp(resistancePremium)} above price)`,
      );
      if (resistancePremium > supportPremium * 1.5) {
        lines.push(
          '  ↳ More dark pool capital ABOVE price than below — backtested data shows this correlates with wider ranges (~95 pts avg vs ~81 pts). Consider widening strikes.',
        );
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a premium value for display.
 */
function fmtDp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}K`;
  return abs.toFixed(0);
}
