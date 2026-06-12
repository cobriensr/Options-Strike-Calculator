#!/usr/bin/env node

/**
 * Local backfill script for 1-minute NDX candles (QQQ × ratio translation).
 *
 * Pulls 1-minute QQQ OHLCV for the last N trading days from Unusual
 * Whales, translates QQQ → NDX via a constant ratio, and upserts into
 * the index_candles_1m table tagged symbol='NDX' via ON CONFLICT
 * (symbol, date, timestamp) DO NOTHING.
 *
 * Why QQQ? Nasdaq prohibits external distribution of NDX index prices,
 * so we fetch QQQ and multiply by the NDX/QQQ ratio. The production
 * cron at api/cron/fetch-spx-candles-1m.ts (which now ingests both
 * SPX and NDX) uses a *live* Schwab-fetched ratio for accuracy. This
 * backfill uses a static QQQ_TO_NDX_RATIO for simplicity — values may
 * drift ~1-2% per quarter from the live-ratio cron output. That's
 * acceptable for chart-context backfill where the goal is "show
 * roughly where NDX was" rather than tick-accurate replay.
 *
 * Mirrors backfill-spx-candles-1m.mjs in structure; the two scripts
 * are kept separate so each is independently runnable without CLI
 * arg surface.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." \
 *     node scripts/backfill-ndx-candles-1m.mjs
 *
 * Environment:
 *   DATABASE_URL   Neon Postgres URL
 *   UW_API_KEY     Unusual Whales API key
 *
 * Idempotent: safe to run multiple times.
 */

import { neon } from '@neondatabase/serverless';

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';
// Approximate NDX/QQQ ratio. As of May 2026: NDX ≈ 24500 / QQQ ≈ 600
// → ~41. The live production cron fetches the ratio from Schwab each
// minute; this static value is a backfill-only approximation that will
// systematically over- or under-state historical NDX values by the
// drift between this constant and the actual session ratio (~1-2% per
// quarter). Recalibrate before running if QQQ has moved >5% since this
// constant was last updated.
//
// We can't compute the ratio from actual prices in this script: Nasdaq
// prohibits external distribution of NDX index prices, which is the
// whole reason we proxy via QQQ — we have QQQ here but no real NDX to
// divide against. The only correct live source is the Schwab quote the
// production cron uses. So the robustness lever here is an env override
// plus a loud warning, not an in-script computation.
const DEFAULT_QQQ_TO_NDX_RATIO = 41;
const QQQ_TO_NDX_RATIO = (() => {
  const raw = process.env.QQQ_TO_NDX_RATIO;
  if (raw == null || raw.trim() === '') return DEFAULT_QQQ_TO_NDX_RATIO;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(
      `Invalid QQQ_TO_NDX_RATIO="${raw}" (must be a positive number)`,
    );
    process.exit(1);
  }
  return parsed;
})();
const DAYS_TO_BACKFILL = 30;

// Loud, unmissable warning: the translated NDX values are an
// approximation pinned to a STATIC ratio. Drifts ~1-2%/quarter from the
// live Schwab ratio the production cron uses, so backfilled rows will
// not tick-match live rows. Override with QQQ_TO_NDX_RATIO to recalibrate.
console.warn(
  '⚠️  STATIC QQQ→NDX ratio approximation in use ' +
    `(QQQ_TO_NDX_RATIO=${QQQ_TO_NDX_RATIO}` +
    `${process.env.QQQ_TO_NDX_RATIO ? ' from env' : ' default'}).`,
);
console.warn(
  '⚠️  Drifts ~1-2%/quarter from the live Schwab ratio; backfilled NDX ' +
    'rows will NOT tick-match live-cron rows. Recalibrate via the ' +
    'QQQ_TO_NDX_RATIO env var if QQQ has moved >5% since 2026-05.',
);

// ── ET timezone helpers ─────────────────────────────────────
//
// Same rationale as backfill-spx-candles-1m.mjs: trading days must be
// computed in ET, not UTC, so the iteration matches what the production
// cron sees and `?date=` parameters target the right session.

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ET_DAY_OF_WEEK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
});

/** Get the ET calendar date for a Date instance, as 'YYYY-MM-DD'. */
function getETDateStr(date) {
  return ET_DATE_FORMATTER.format(date);
}

/** Get the ET day of week (0=Sun, 6=Sat) for a Date instance. */
function getETDayOfWeek(date) {
  const name = ET_DAY_OF_WEEK_FORMATTER.format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? 0;
}

// ── Generate last N trading days (ending yesterday in ET) ───

function getTradingDays(count) {
  const dates = [];
  const d = new Date();

  let todayET = getETDateStr(new Date());
  d.setUTCDate(d.getUTCDate() - 1);
  while (getETDateStr(d) === todayET) {
    d.setUTCDate(d.getUTCDate() - 1);
  }

  while (dates.length < count) {
    const day = getETDayOfWeek(d);
    if (day !== 0 && day !== 6) {
      dates.push(getETDateStr(d));
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }

  return dates.reverse();
}

// ── Fetch 1m QQQ candles for one date ───────────────────────

async function fetchQQQCandles1m(date) {
  // limit=2500 is UW's documented max; covers a full extended-hours
  // session (~960 candles).
  const res = await fetch(
    `${UW_BASE}/stock/QQQ/ohlc/1m?date=${date}&limit=2500`,
    {
      headers: {
        Authorization: `Bearer ${UW_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW API ${res.status} for QQQ 1m ${date}: ${text.slice(0, 100)}`,
    );
    return null;
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Translate QQQ rows into NDX-equivalent rows ─────────────

function translateRows(rows) {
  const translated = [];

  for (const row of rows) {
    const open = Number.parseFloat(row.open) * QQQ_TO_NDX_RATIO;
    const high = Number.parseFloat(row.high) * QQQ_TO_NDX_RATIO;
    const low = Number.parseFloat(row.low) * QQQ_TO_NDX_RATIO;
    const close = Number.parseFloat(row.close) * QQQ_TO_NDX_RATIO;

    if (
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close)
    ) {
      continue;
    }

    translated.push({
      timestamp: new Date(row.start_time).toISOString(),
      open,
      high,
      low,
      close,
      volume: row.volume ?? 0,
      market_time: row.market_time,
    });
  }

  return translated;
}

// ── Store all translated candles for a single date ─────────

async function storeCandles(candles) {
  if (candles.length === 0) {
    return { stored: 0, marketTimeCounts: { pr: 0, r: 0, po: 0 } };
  }

  let stored = 0;
  const marketTimeCounts = { pr: 0, r: 0, po: 0 };

  for (const c of candles) {
    const rowDate = getETDateStr(new Date(c.timestamp));
    try {
      const result = await sql`
        INSERT INTO index_candles_1m (
          symbol, date, timestamp, open, high, low, close, volume, market_time
        )
        VALUES (
          'NDX', ${rowDate}, ${c.timestamp},
          ${c.open}, ${c.high}, ${c.low}, ${c.close},
          ${c.volume}, ${c.market_time}
        )
        ON CONFLICT (symbol, date, timestamp) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) {
        stored++;
        if (c.market_time in marketTimeCounts) {
          marketTimeCounts[c.market_time]++;
        }
      }
    } catch (err) {
      console.warn(`  Insert error: ${err.message}`);
    }
  }

  return { stored, marketTimeCounts };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const tradingDays = getTradingDays(DAYS_TO_BACKFILL);

  console.log(
    `Backfilling index_candles_1m (NDX, ${DAYS_TO_BACKFILL} trading days)`,
  );
  console.log(
    `Range: ${tradingDays[0]} to ${tradingDays.at(-1)} (skipping weekends)\n`,
  );
  console.log(
    `Using static QQQ→NDX ratio = ${QQQ_TO_NDX_RATIO}x (live cron uses Schwab dynamic ratio)\n`,
  );

  const totals = {
    daysProcessed: 0,
    daysWithData: 0,
    rowsStored: 0,
    rowsSkipped: 0,
    errors: 0,
  };

  for (const date of tradingDays) {
    totals.daysProcessed++;

    // Polite pacing between days to avoid UW rate limits
    await new Promise((r) => setTimeout(r, 500));

    let rawRows;
    try {
      rawRows = await fetchQQQCandles1m(date);
    } catch (err) {
      console.warn(`  [${date}] fetch error: ${err.message}`);
      totals.errors++;
      continue;
    }

    if (rawRows === null) {
      totals.errors++;
      continue;
    }

    if (rawRows.length === 0) {
      console.log(`  [${date}] no data (holiday or pre-IPO, skipping)`);
      continue;
    }

    const translated = translateRows(rawRows);
    if (translated.length === 0) {
      console.log(`  [${date}] fetched ${rawRows.length}, all filtered as NaN`);
      continue;
    }

    let result;
    try {
      result = await storeCandles(translated);
    } catch (err) {
      console.warn(`  [${date}] store error: ${err.message}`);
      totals.errors++;
      continue;
    }

    totals.daysWithData++;
    totals.rowsStored += result.stored;
    totals.rowsSkipped += translated.length - result.stored;

    const { pr, r, po } = result.marketTimeCounts;
    console.log(
      `  [${date}] fetched ${rawRows.length}, stored ${result.stored} ` +
        `(pr=${pr}, r=${r}, po=${po}), skipped ${translated.length - result.stored}`,
    );
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`\nBackfill complete.`);
  console.log(`  Days processed:         ${totals.daysProcessed}`);
  console.log(`  Days with data:         ${totals.daysWithData}`);
  console.log(`  Total rows stored:      ${totals.rowsStored}`);
  console.log(`  Total rows skipped:     ${totals.rowsSkipped}`);
  console.log(`  Errors:                 ${totals.errors}`);
  console.log(`  Duration:               ${durationSec}s`);

  // Truthful exit code so CI/cron detects partial failures (every other
  // date-loop backfill silently exited 0). Mirrors the pattern in
  // backfill-periscope-playbook.mjs.
  if (totals.errors > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
