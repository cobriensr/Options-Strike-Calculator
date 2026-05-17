#!/usr/bin/env node

/**
 * Backfill cum_ncp_at_fire + cum_npp_at_fire on historical
 * lottery_finder_fires AND silent_boom_alerts rows. Mirrors the
 * scripts/backfill-range-pos.mjs pattern: group by (ticker, date),
 * fetch the cumulative ticker net-flow series ONCE per group, then
 * binary-search each fire's snapshot and issue one batched UPDATE
 * per group via jsonb_array_elements.
 *
 * Idempotent: only updates rows where cum_ncp_at_fire IS NULL.
 *
 * Tickers outside the WS net-flow universe (the ~50 tickers the
 * uw-stream daemon subscribes to) end up with empty series and stay
 * NULL — same end-state as today's LATERAL which also returns NULL
 * for those tickers. The feed JS already tolerates null.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-ticker-flow-at-fire.mjs
 *
 * Options:
 *   --limit N            Cap the number of (ticker, date) groups processed.
 *   --table lottery|silentboom|both   Restrict to one table (default: both).
 *   --ticker TICKER      Only this ticker.
 *   --date YYYY-MM-DD    Only this date.
 *   --dry-run            Compute but don't UPDATE.
 *
 * Spec: docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md
 * Schema columns added in migration #158.
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function argValue(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

const groupLimit = Number.parseInt(argValue('--limit') ?? '0', 10);
const filterTable = (argValue('--table') ?? 'both').toLowerCase();
const filterTicker = argValue('--ticker');
const filterDate = argValue('--date');

if (!['lottery', 'silentboom', 'both'].includes(filterTable)) {
  console.error('--table must be one of: lottery | silentboom | both');
  process.exit(1);
}

// ── Pull (ticker, date) groups across both tables ──────────

console.log('Querying NULL cum_ncp_at_fire groups…');
const tableFilter = filterTable;
const groups = await sql`
  SELECT ticker, date::text AS date, SUM(n_rows)::int AS n_rows
  FROM (
    SELECT
      underlying_symbol AS ticker,
      date,
      COUNT(*) AS n_rows
    FROM lottery_finder_fires
    WHERE cum_ncp_at_fire IS NULL
      AND ${tableFilter}::text IN ('lottery', 'both')
      AND (${filterTicker ?? null}::text IS NULL OR underlying_symbol = ${filterTicker ?? ''})
      AND (${filterDate ?? null}::text IS NULL OR date = ${filterDate ?? '1970-01-01'}::date)
    GROUP BY underlying_symbol, date
    UNION ALL
    SELECT
      underlying_symbol AS ticker,
      date,
      COUNT(*) AS n_rows
    FROM silent_boom_alerts
    WHERE cum_ncp_at_fire IS NULL
      AND ${tableFilter}::text IN ('silentboom', 'both')
      AND (${filterTicker ?? null}::text IS NULL OR underlying_symbol = ${filterTicker ?? ''})
      AND (${filterDate ?? null}::text IS NULL OR date = ${filterDate ?? '1970-01-01'}::date)
    GROUP BY underlying_symbol, date
  ) combined
  GROUP BY ticker, date
  ORDER BY date DESC, ticker
  ${groupLimit > 0 ? sql`LIMIT ${groupLimit}` : sql``}
`;

const totalRows = groups.reduce((acc, g) => acc + g.n_rows, 0);
console.log(
  `Found ${groups.length} (ticker, date) groups; ${totalRows} total rows ` +
    `to update (across lottery + silent_boom, deduped by group).`,
);

// ── Per-group processing ───────────────────────────────────

let groupsProcessed = 0;
let lotteryUpdated = 0;
let silentUpdated = 0;
let leftNullEmptySeries = 0;
let leftNullPreSeries = 0;
let emptyGroups = 0;

for (const g of groups) {
  groupsProcessed++;
  console.log(
    `[${groupsProcessed}/${groups.length}] ${g.ticker} ${g.date} ` +
      `(${g.n_rows} rows across both tables)`,
  );

  // Fetch the ticker-day cumulative series ONCE. Session bounds are
  // computed SQL-side via AT TIME ZONE 'America/Chicago' to match
  // ctSessionBounds(date) in api/_lib/ticker-flow-snapshot.ts.
  const series = await sql`
    WITH unified AS (
      SELECT DISTINCT ON (ts) ts, net_call_prem, net_put_prem
      FROM (
        SELECT ts, net_call_prem, net_put_prem, 1 AS priority
        FROM ws_net_flow_per_ticker
        WHERE ticker = ${g.ticker}
          AND ts >= ((${g.date}::date + TIME '08:30:00') AT TIME ZONE 'America/Chicago')
          AND ts <= ((${g.date}::date + TIME '15:00:00') AT TIME ZONE 'America/Chicago')
        UNION ALL
        SELECT ts, net_call_prem, net_put_prem, 2 AS priority
        FROM net_flow_per_ticker_history
        WHERE ticker = ${g.ticker}
          AND ts >= ((${g.date}::date + TIME '08:30:00') AT TIME ZONE 'America/Chicago')
          AND ts <= ((${g.date}::date + TIME '15:00:00') AT TIME ZONE 'America/Chicago')
      ) combined
      ORDER BY ts, priority
    )
    SELECT
      ts,
      SUM(net_call_prem) OVER (ORDER BY ts) AS cum_ncp,
      SUM(net_put_prem)  OVER (ORDER BY ts) AS cum_npp
    FROM unified
    ORDER BY ts
  `;

  if (series.length === 0) {
    emptyGroups++;
    leftNullEmptySeries += g.n_rows;
    console.log('   (empty series; ticker not in WS universe or no history)');
    continue;
  }

  // In-memory parallel arrays for binary search.
  const tsArr = series.map((r) =>
    r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime(),
  );
  const ncpArr = series.map((r) => Number(r.cum_ncp ?? 0));
  const nppArr = series.map((r) => Number(r.cum_npp ?? 0));

  function lookup(fireMs) {
    if (tsArr[0] > fireMs) return { ncp: null, npp: null };
    let lo = 0;
    let hi = tsArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (tsArr[mid] <= fireMs) lo = mid;
      else hi = mid - 1;
    }
    return { ncp: ncpArr[lo], npp: nppArr[lo] };
  }

  // ── Lottery batched UPDATE ─────────────────────────────
  if (filterTable === 'lottery' || filterTable === 'both') {
    const lotFires = await sql`
      SELECT id, trigger_time_ct
      FROM lottery_finder_fires
      WHERE underlying_symbol = ${g.ticker}
        AND date = ${g.date}::date
        AND cum_ncp_at_fire IS NULL
    `;
    const lotUpdates = [];
    for (const f of lotFires) {
      const fireMs =
        f.trigger_time_ct instanceof Date
          ? f.trigger_time_ct.getTime()
          : new Date(f.trigger_time_ct).getTime();
      const { ncp, npp } = lookup(fireMs);
      if (ncp == null) {
        leftNullPreSeries++;
        continue;
      }
      lotUpdates.push({ id: f.id, ncp, npp });
    }
    if (lotUpdates.length > 0 && !dryRun) {
      await sql`
        UPDATE lottery_finder_fires AS f
        SET cum_ncp_at_fire = (u->>'ncp')::numeric,
            cum_npp_at_fire = (u->>'npp')::numeric
        FROM jsonb_array_elements(${JSON.stringify(lotUpdates)}::jsonb) AS u
        WHERE f.id = (u->>'id')::int
          AND f.cum_ncp_at_fire IS NULL
      `;
    }
    lotteryUpdated += lotUpdates.length;
  }

  // ── Silent boom batched UPDATE ─────────────────────────
  if (filterTable === 'silentboom' || filterTable === 'both') {
    const sbFires = await sql`
      SELECT id, bucket_ct
      FROM silent_boom_alerts
      WHERE underlying_symbol = ${g.ticker}
        AND date = ${g.date}::date
        AND cum_ncp_at_fire IS NULL
    `;
    const sbUpdates = [];
    for (const f of sbFires) {
      const fireMs =
        f.bucket_ct instanceof Date
          ? f.bucket_ct.getTime()
          : new Date(f.bucket_ct).getTime();
      const { ncp, npp } = lookup(fireMs);
      if (ncp == null) {
        leftNullPreSeries++;
        continue;
      }
      sbUpdates.push({ id: f.id, ncp, npp });
    }
    if (sbUpdates.length > 0 && !dryRun) {
      await sql`
        UPDATE silent_boom_alerts AS s
        SET cum_ncp_at_fire = (u->>'ncp')::numeric,
            cum_npp_at_fire = (u->>'npp')::numeric
        FROM jsonb_array_elements(${JSON.stringify(sbUpdates)}::jsonb) AS u
        WHERE s.id = (u->>'id')::int
          AND s.cum_ncp_at_fire IS NULL
      `;
    }
    silentUpdated += sbUpdates.length;
  }
}

console.log('\n── Backfill summary ──');
console.log(`  Groups processed:        ${groupsProcessed}`);
console.log(`  Empty-series groups:     ${emptyGroups}`);
console.log(
  `  Lottery rows updated:    ${lotteryUpdated}${dryRun ? ' (dry-run)' : ''}`,
);
console.log(
  `  Silent boom rows updated:${silentUpdated}${dryRun ? ' (dry-run)' : ''}`,
);
console.log(`  Left NULL (no series):   ${leftNullEmptySeries}`);
console.log(`  Left NULL (pre-series):  ${leftNullPreSeries}`);
