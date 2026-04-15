#!/usr/bin/env node

/**
 * Local backfill script for UW flow-alerts (0-1 DTE SPXW).
 *
 * Walks backwards from the newest available alert using `older_than`
 * pagination until it crosses the `days`-ago cutoff, a short page
 * (< PAGE_SIZE) signals no more data, or the safety cap fires.
 *
 * UW retains ~22 days of flow-alerts data, so the default 30 captures
 * everything available. Idempotent via ON CONFLICT (option_chain,
 * created_at) DO NOTHING — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=... UW_API_KEY=... node scripts/backfill-flow-alerts.mjs [days]
 *
 * Examples:
 *   node scripts/backfill-flow-alerts.mjs          # default 30 days
 *   node scripts/backfill-flow-alerts.mjs 7        # last 7 days only
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

const days = Number.parseInt(process.argv[2] ?? '30', 10);

const PAGE_SIZE = 200;
const SAFETY_CAP = 5000;
const FLOW_ALERTS_PATH = '/option-trades/flow-alerts';

// ── Mirror of api/_lib/flow-alert-derive.ts — keep in sync ──

const SESSION_OPEN_MINUTE_CT = 510; // 08:30 CT

function getCtParts(isoUtc) {
  const d = new Date(isoUtc);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number.parseInt(get('hour'), 10) % 24;
  const minute = Number.parseInt(get('minute'), 10);
  const weekdayMap = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  const dayOfWeek = weekdayMap[get('weekday')] ?? -1;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  return { hour, minute, dayOfWeek, dateStr };
}

function isoDateToEpochDays(iso) {
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  return Math.floor(Date.UTC(y, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function computeDerived(a) {
  const totalPrem = Number.parseFloat(a.total_premium);
  const askPrem = Number.parseFloat(a.total_ask_side_prem);
  const bidPrem = Number.parseFloat(a.total_bid_side_prem);
  const strike = Number.parseFloat(a.strike);
  const spot = Number.parseFloat(a.underlying_price);

  const ask_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? askPrem / totalPrem : null;
  const bid_side_ratio =
    Number.isFinite(totalPrem) && totalPrem > 0 ? bidPrem / totalPrem : null;
  const net_premium = askPrem - bidPrem;

  const { hour, minute, dayOfWeek, dateStr } = getCtParts(a.created_at);
  const alertEpoch = isoDateToEpochDays(dateStr);
  const expiryEpoch = isoDateToEpochDays(a.expiry);
  const dte_at_alert = Math.max(0, expiryEpoch - alertEpoch);

  const distance_from_spot = strike - spot;
  const distance_pct =
    Number.isFinite(spot) && spot > 0 ? (strike - spot) / spot : null;
  const moneyness =
    Number.isFinite(strike) && strike > 0 ? spot / strike : null;

  let is_itm = null;
  if (
    Number.isFinite(strike) &&
    strike > 0 &&
    Number.isFinite(spot) &&
    spot > 0
  ) {
    if (a.type === 'call') is_itm = strike < spot;
    else if (a.type === 'put') is_itm = strike > spot;
  }

  const minute_of_day = hour * 60 + minute;
  const session_elapsed_min = minute_of_day - SESSION_OPEN_MINUTE_CT;

  return {
    ask_side_ratio,
    bid_side_ratio,
    net_premium,
    dte_at_alert,
    distance_from_spot,
    distance_pct,
    moneyness,
    is_itm,
    minute_of_day,
    session_elapsed_min,
    day_of_week: dayOfWeek,
  };
}

// ── UW fetch ────────────────────────────────────────────────

function buildPath(olderThan) {
  const qs = new URLSearchParams();
  qs.append('ticker_symbol', 'SPXW');
  qs.append('issue_types[]', 'Index');
  qs.append('rule_name[]', 'RepeatedHits');
  qs.append('rule_name[]', 'RepeatedHitsAscendingFill');
  qs.append('rule_name[]', 'RepeatedHitsDescendingFill');
  qs.append('min_dte', '0');
  qs.append('max_dte', '1');
  qs.append('limit', String(PAGE_SIZE));
  if (olderThan) qs.append('older_than', olderThan);
  return `${FLOW_ALERTS_PATH}?${qs.toString()}`;
}

async function fetchBatch(olderThan) {
  const url = `${UW_BASE}${buildPath(olderThan)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UW API ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.data ?? [];
}

// ── Insert ──────────────────────────────────────────────────

async function insertAlert(a, d) {
  const result = await sql`
    INSERT INTO flow_alerts (
      alert_rule, ticker, issue_type, option_chain, strike, expiry, type,
      created_at, price, underlying_price,
      total_premium, total_ask_side_prem, total_bid_side_prem,
      total_size, trade_count, expiry_count, volume, open_interest, volume_oi_ratio,
      has_sweep, has_floor, has_multileg, has_singleleg, all_opening_trades,
      ask_side_ratio, bid_side_ratio, net_premium,
      dte_at_alert, distance_from_spot, distance_pct, moneyness, is_itm,
      minute_of_day, session_elapsed_min, day_of_week,
      raw_response
    ) VALUES (
      ${a.alert_rule}, ${a.ticker}, ${a.issue_type}, ${a.option_chain}, ${a.strike}, ${a.expiry}, ${a.type},
      ${a.created_at}, ${a.price}, ${a.underlying_price},
      ${a.total_premium}, ${a.total_ask_side_prem}, ${a.total_bid_side_prem},
      ${a.total_size}, ${a.trade_count}, ${a.expiry_count}, ${a.volume}, ${a.open_interest}, ${a.volume_oi_ratio},
      ${a.has_sweep}, ${a.has_floor}, ${a.has_multileg}, ${a.has_singleleg}, ${a.all_opening_trades},
      ${d.ask_side_ratio}, ${d.bid_side_ratio}, ${d.net_premium},
      ${d.dte_at_alert}, ${d.distance_from_spot}, ${d.distance_pct}, ${d.moneyness}, ${d.is_itm},
      ${d.minute_of_day}, ${d.session_elapsed_min}, ${d.day_of_week},
      ${JSON.stringify(a)}::jsonb
    )
    ON CONFLICT (option_chain, created_at) DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const cutoffMs = Date.now() - days * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  console.log(`Backfilling UW flow-alerts for last ${days} days`);
  console.log(`Cutoff: ${cutoffIso}\n`);

  let olderThan;
  let totalFetched = 0;
  let totalInserted = 0;
  let batchNum = 0;
  let stopReason = 'safety cap';

  while (totalFetched < SAFETY_CAP) {
    batchNum++;
    const batch = await fetchBatch(olderThan);
    if (batch.length === 0) {
      stopReason = 'empty batch';
      break;
    }

    let batchInserted = 0;
    for (const a of batch) {
      const d = computeDerived(a);
      const stored = await insertAlert(a, d);
      if (stored) batchInserted++;
    }

    totalFetched += batch.length;
    totalInserted += batchInserted;

    // Find the oldest created_at in this batch for next page.
    const oldest = batch.reduce(
      (acc, row) => (row.created_at < acc ? row.created_at : acc),
      batch[0].created_at,
    );

    console.log(
      `Batch ${batchNum}: fetched ${batch.length}, inserted ${batchInserted} (cumulative: ${totalInserted} / ${totalFetched}) — oldest ${oldest}`,
    );

    if (batch.length < PAGE_SIZE) {
      stopReason = 'short page (< PAGE_SIZE)';
      break;
    }
    if (oldest < cutoffIso) {
      stopReason = `oldest row past cutoff (${oldest} < ${cutoffIso})`;
      break;
    }

    // Subtract 1ms so a full batch sharing an identical `created_at` can't
    // infinite-loop on an inclusive `older_than` (UW uses microsecond
    // precision, so collisions are vanishingly rare but theoretically possible).
    const oldestTs = new Date(oldest);
    oldestTs.setMilliseconds(oldestTs.getMilliseconds() - 1);
    olderThan = oldestTs.toISOString();
  }

  const skipped = totalFetched - totalInserted;
  console.log(`\nStopped: ${stopReason}`);
  console.log(
    `Backfill complete. Days: ${days}. Total fetched: ${totalFetched}. Total inserted: ${totalInserted}. Skipped duplicates: ${skipped}.`,
  );
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err.message ?? err);
  process.exit(1);
}
