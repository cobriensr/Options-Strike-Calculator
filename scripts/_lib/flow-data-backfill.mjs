/**
 * What the three flow_data REST backfills share. Each fills `flow_data` for a
 * range of finished ET days, one UW GET per source and day:
 *
 *   MARKET_TIDE  scripts/backfill-local.mjs      market_tide, market_tide_otm
 *   ETF_TIDE     scripts/backfill-etf-tide.mjs   spy_etf_tide, qqq_etf_tide
 *   NET_FLOW     scripts/backfill-netflow.mjs    spx_flow, spy_flow, qqq_flow
 *
 * Each is a spec: the items a day fans out over, the UW URL for an item, the
 * script's User-Agent, and `toRows`, which maps UW's answer to flow_data rows
 * the way the live crons do (fetch-flow.ts, fetch-net-flow.ts; fetch-etf-tide.ts
 * did until 2026-11-09, see the ETF_TIDE warning below). The CLI, the day loop and the failure bookkeeping are
 * backfill-cli.mjs's; the UW GET is uw-day-fetch.mjs's. What is here is the
 * flow_data part: the row mapping, the table's key, the day worker and the
 * script runner.
 *
 * Writes are DO NOTHING, like the live market-tide and net-flow crons: the
 * 07-22 partial day keeps the rows the live crons wrote that morning, and
 * fills in the rest.
 *
 * ETF_TIDE: do not run it for spy_etf_tide or qqq_etf_tide, on any day, until
 * toEtfTideRows adopts the window-END label (spec P2.1,
 * docs/superpowers/specs/live-data-integrity-2026-11-06.md). Since 2026-11-09
 * the live fetch-etf-tide cron (and fetch-zero-dte-flow for zero_dte_index)
 * stamps a closed bucket at its END and upserts it. toEtfTideRows still
 * stamps the window START and these writes are DO NOTHING, so a backfilled
 * day would hold two conventions at once.
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md (P3.2).
 */

import { neon } from '@neondatabase/serverless';

import { getETDateStr } from '../../src/utils/timezone.ts';
import {
  DayFailure,
  EXIT_BAD_ARGS,
  EXIT_FAILED,
  EXIT_GUARD_STOP,
  UW_REQUESTS_PER_MINUTE,
  createRequestThrottle,
  marketHoursRefusal,
  planRangeDays,
  redact,
  runDayItems,
  runDays,
  storeRows,
  summarizeItemRun,
} from './backfill-cli.mjs';
import { UW_BASE, fetchUwDayRows } from './uw-day-fetch.mjs';

// ── The table ──────────────────────────────────────────────

/**
 * Where every row goes: flow_data, UNIQUE (date, timestamp, source) from
 * migration #4 in api/_lib/db-migrations.ts (a test reads the migration, so a
 * different key there fails it). `id` is the SERIAL key storeRows counts.
 */
export const FLOW_DATA_TARGET = {
  table: 'flow_data',
  columns: ['date', 'timestamp', 'source', 'ncp', 'npp', 'net_volume'],
  conflictTarget: '(date, timestamp, source)',
};

// ── Row mapping ────────────────────────────────────────────

const FIVE_MIN_MS = 300_000;

/**
 * flow_data's column ranges (migrations #4 and #48): net_volume is INTEGER;
 * ncp and npp are DECIMAL(14,2), 12 digits before the point, so 100 times the
 * value rounded to a cent is at most 99_999_999_999_999. A value outside its
 * range makes Postgres reject the whole multi-row INSERT.
 */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const DECIMAL_14_2_MAX_CENTS = 99_999_999_999_999;

const fitsInteger = (n) => n >= INT4_MIN && n <= INT4_MAX;
const fitsDecimal = (n) =>
  Math.round(Math.abs(n) * 100) <= DECIMAL_14_2_MAX_CENTS;

/**
 * How many rows an item needs before "every premium is zero" fails the day.
 * The live crons' own floor: checkDataQuality's `minRows` is 10 (it alerts
 * above 10, this fails at 10).
 */
const ALL_ZERO_MIN_ROWS = 10;

/** A finite number from a number or a numeric string (UW sends decimals as strings), else null. */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The start of the 5-minute window holding `ms`, as epoch ms. */
const windowStart = (ms) => Math.floor(ms / FIVE_MIN_MS) * FIVE_MIN_MS;

/** True when the instant `ms` falls on ET calendar day `date`. */
const isOnEtDay = (ms, date) => getETDateStr(new Date(ms)) === date;

function flowRow(date, ms, source, ncp, npp, netVolume) {
  return {
    date,
    timestamp: new Date(ms).toISOString(),
    source,
    ncp,
    npp,
    net_volume: netVolume,
  };
}

/**
 * One market-tide or ETF-tide row as numbers: `{ ms, ncp, npp, netVolume }`, or
 * null when it can't be stored as it is. The premiums must be numbers (the
 * old etf script and, until 2026-11-09, the live ETF cron turn a bad one into
 * a 0, which is then stored as data). `net_volume` may be absent, which is
 * stored as NULL (the live ETF cron stored 0 until 2026-11-09 and now stores
 * NULL too; the readers print a NULL as N/A); a volume that is
 * there must be a whole number inside the INTEGER column's range, and the
 * premiums must fit DECIMAL(14,2), or the row is left out and counted instead
 * of failing the whole INSERT. UW sends tide values already added up, so one
 * bad value spoils only its own row.
 */
function tideValues(row) {
  const ms = Date.parse(row.timestamp);
  const ncp = numberOf(row.net_call_premium);
  const npp = numberOf(row.net_put_premium);
  if (!Number.isFinite(ms) || ncp === null || npp === null) return null;
  if (!fitsDecimal(ncp) || !fitsDecimal(npp)) return null;
  let netVolume = null;
  if (row.net_volume != null) {
    netVolume = numberOf(row.net_volume);
    if (
      netVolume === null ||
      !Number.isSafeInteger(netVolume) ||
      !fitsInteger(netVolume)
    ) {
      return null;
    }
  }
  return { ms, ncp, npp, netVolume };
}

/** The usable tide rows for ET day `date`, oldest first, and how many were not. */
function usableTideRows(date, uwRows) {
  const usable = [];
  let dropped = 0;
  for (const row of uwRows) {
    const values = tideValues(row);
    if (values === null || !isOnEtDay(values.ms, date)) {
      dropped++;
    } else {
      usable.push(values);
    }
  }
  usable.sort((a, b) => a.ms - b.ms);
  return { usable, dropped };
}

/**
 * UW market-tide rows (interval_5m, already one per 5 minutes) → flow_data
 * rows, as fetch-flow.ts stores them: the timestamp as UW sends it (not moved
 * onto a boundary, so a live row of the same minute is skipped by ON CONFLICT),
 * the premiums as numbers. `date` is the ET day asked for. `{ rows, dropped }`:
 * `dropped` counts the UW rows left out, for another ET day, a bad value, an
 * unparseable timestamp, or a minute already taken (the first one stays, as
 * DO NOTHING keeps it).
 */
export function toMarketTideRows(date, source, uwRows) {
  const { usable, dropped: unusable } = usableTideRows(date, uwRows);
  const byMs = new Map();
  for (const values of usable) {
    if (!byMs.has(values.ms)) byMs.set(values.ms, values);
  }
  const rows = [...byMs.values()].map((v) =>
    flowRow(date, v.ms, source, v.ncp, v.npp, v.netVolume),
  );
  return { rows, dropped: unusable + usable.length - byMs.size };
}

/**
 * UW ETF-tide rows (one a minute, cumulative) → flow_data rows, as
 * fetch-etf-tide.ts stored them until 2026-11-09: the last row of each
 * 5-minute window, stamped at the window START. The live cron now stamps the
 * window END and upserts (see the ETF_TIDE warning at the top of the file:
 * do not run this for ETF tide until it does too). The rows are put in time
 * order first, so "last" is the
 * latest minute whatever order UW sent them in. `{ rows, dropped }`: `dropped`
 * counts the UW rows left out as unusable (another ET day, a bad value); the
 * rest collapse into the 5-minute rows.
 */
export function toEtfTideRows(date, source, uwRows) {
  const { usable, dropped } = usableTideRows(date, uwRows);
  const byWindow = new Map();
  for (const values of usable) byWindow.set(windowStart(values.ms), values);
  const rows = [...byWindow.entries()].map(([ms, v]) =>
    flowRow(date, ms, source, v.ncp, v.npp, v.netVolume),
  );
  return { rows, dropped };
}

/**
 * Throw if a running net-flow total no longer fits the column it will be stored
 * in. `totals` are the running ncp, npp and net call and put volumes after the
 * tick at `ms`. The message names the source, the date, the column, the value
 * and that minute, which is the first one past the end.
 */
function assertTotalsFit(source, date, ms, totals) {
  const { ncp, npp, callVolume, putVolume } = totals;
  const netVolume = callVolume + putVolume;
  const bad =
    (!fitsDecimal(ncp) && ['ncp', ncp, 'DECIMAL(14,2)']) ||
    (!fitsDecimal(npp) && ['npp', npp, 'DECIMAL(14,2)']) ||
    (!fitsInteger(netVolume) && ['net_volume', netVolume, 'INTEGER']);
  if (!bad) return;
  const [column, value, type] = bad;
  throw new DayFailure(
    'malformed',
    `${source} for ${date}: the running ${column} is ${value} at ` +
      `${new Date(ms).toISOString()}, outside the ${type} column; one corrupt ` +
      'tick moves every later total, so nothing is stored for it',
  );
}

/**
 * UW net-prem-ticks (the change in net premium and volume for each minute) →
 * flow_data rows, as fetch-net-flow.ts stores them: the ticks added up in time
 * order, the running total kept at the last tick of each 5-minute window,
 * stamped at the window start. `net_volume` is the running net call volume plus
 * net put volume. The ticks are put in time order first (UW does not promise
 * one, and a running sum depends on it).
 *
 * A tick for another ET day, or with a timestamp that doesn't parse, is left
 * out before anything is added up. A tick whose premium isn't a number stays
 * in the sums with that premium as 0 and its volumes, which is what the live
 * cron's `|| 0` does: its volumes are part of every later row's net_volume,
 * so leaving the whole tick out would shift them all. Both kinds are counted
 * in `dropped` (a tick that is only partly used is counted too). A volume
 * that is missing counts as 0.
 *
 * The running totals are this function's own sums, so one corrupt tick moves
 * every later total, and dropping rows one by one would quietly strip the rest
 * of the day. If a running ncp, npp or net_volume leaves its column's range
 * (see fitsDecimal and fitsInteger), it throws a `malformed` DayFailure naming
 * the source, the date, the column and the first minute, and nothing is
 * stored for the item. `{ rows, dropped }`.
 */
export function toNetFlowRows(date, source, ticks) {
  const usable = [];
  let dropped = 0;
  for (const tick of ticks) {
    const ms = Date.parse(tick.tape_time);
    if (!Number.isFinite(ms) || !isOnEtDay(ms, date)) {
      dropped++;
      continue;
    }
    const ncp = numberOf(tick.net_call_premium);
    const npp = numberOf(tick.net_put_premium);
    if (ncp === null || npp === null) dropped++;
    usable.push({
      ms,
      ncp: ncp ?? 0,
      npp: npp ?? 0,
      callVolume: numberOf(tick.net_call_volume) ?? 0,
      putVolume: numberOf(tick.net_put_volume) ?? 0,
    });
  }
  usable.sort((a, b) => a.ms - b.ms);

  let ncp = 0;
  let npp = 0;
  let callVolume = 0;
  let putVolume = 0;
  const byWindow = new Map();
  for (const tick of usable) {
    ncp += tick.ncp;
    npp += tick.npp;
    callVolume += tick.callVolume;
    putVolume += tick.putVolume;
    assertTotalsFit(source, date, tick.ms, { ncp, npp, callVolume, putVolume });
    byWindow.set(
      windowStart(tick.ms),
      flowRow(
        date,
        windowStart(tick.ms),
        source,
        ncp,
        npp,
        callVolume + putVolume,
      ),
    );
  }
  return { rows: [...byWindow.values()], dropped };
}

// ── The three scripts ──────────────────────────────────────

/**
 * What a script is: `items` the day fans out over (strings, so a failure names
 * one), `urlFor(item, date)`, `sourceOf(item)` the flow_data source, the UW
 * `rowField` that must be a string on every row (`rowLabel` names a row in the
 * error), `toRows(date, source, uwRows)`, and `itemLabel` for "k of n sources
 * failed". `userAgent` is explicit and the script's own: UW turns away some
 * default client UAs (Python-urllib).
 */

export const MARKET_TIDE = {
  title: 'flow_data market tide (market_tide, market_tide_otm)',
  userAgent: 'strike-calculator-market-tide-backfill (node)',
  items: ['market_tide', 'market_tide_otm'],
  itemLabel: 'sources',
  rowField: 'timestamp',
  rowLabel: 'tide row',
  urlFor(source, date) {
    const params = new URLSearchParams({ date, interval_5m: 'true' });
    if (source === 'market_tide_otm') params.set('otm_only', 'true');
    return `${UW_BASE}/market/market-tide?${params}`;
  },
  sourceOf: (source) => source,
  toRows: toMarketTideRows,
};

export const ETF_TIDE = {
  title: 'flow_data ETF tide (spy_etf_tide, qqq_etf_tide)',
  userAgent: 'strike-calculator-etf-tide-backfill (node)',
  items: ['SPY', 'QQQ'],
  itemLabel: 'tickers',
  rowField: 'timestamp',
  rowLabel: 'tide row',
  urlFor: (ticker, date) => `${UW_BASE}/market/${ticker}/etf-tide?date=${date}`,
  sourceOf: (ticker) => `${ticker.toLowerCase()}_etf_tide`,
  toRows: toEtfTideRows,
};

export const NET_FLOW = {
  title: 'flow_data net flow (spx_flow, spy_flow, qqq_flow)',
  userAgent: 'strike-calculator-netflow-backfill (node)',
  items: ['SPX', 'SPY', 'QQQ'],
  itemLabel: 'tickers',
  rowField: 'tape_time',
  rowLabel: 'tick',
  urlFor: (ticker, date) =>
    `${UW_BASE}/stock/${ticker}/net-prem-ticks?date=${date}`,
  sourceOf: (ticker) => `${ticker.toLowerCase()}_flow`,
  toRows: toNetFlowRows,
};

// ── Flags ──────────────────────────────────────────────────

/**
 * Parse the flags and pick the days to fill (planRangeDays). Throws a message
 * naming the problem; the scripts exit 2 on it.
 *
 * There is no lookback default and no positional day count or ticker list any
 * more: the old `N` counted weekdays back from today, holidays and the
 * unfinished day included, and so could not target a gap. To fill one source,
 * run all of them: the writes are DO NOTHING.
 */
export function planFlowDays(argv) {
  return planRangeDays(
    argv,
    'the flow_data backfills have no default window ' +
      '(the old N-day lookback could not target a gap)',
  );
}

// ── Day worker ─────────────────────────────────────────────

/**
 * What a day worker needs, from the script:
 *   apiKey       the UW key
 *   sql          a Neon `sql` (null on a dry run)
 *   dryRun       fetch and map, write nothing
 *   waitForSlot  the UW throttle (createRequestThrottle)
 */

/**
 * Fail an item whose answer looks like UW's mistake, not a quiet day. Without
 * this the day reads as healthy and DO NOTHING keeps the bad outcome for good:
 *   - UW sent rows and none is usable for `date` (it ignored `?date=` and
 *     answered another ET day: kept 0, dropped N, exit 0);
 *   - ALL_ZERO_MIN_ROWS or more rows and every premium is zero (the live cron
 *     alerts on this too; a finished session never has it).
 * Both are `malformed`: nothing is written for the item, and the day is re-run
 * once UW answers properly.
 */
function assertUsable(uwRows, rows, source, date) {
  if (uwRows.length > 0 && rows.length === 0) {
    throw new DayFailure(
      'malformed',
      `UW sent ${uwRows.length} rows for ${source}, none usable for ${date}`,
    );
  }
  if (
    rows.length >= ALL_ZERO_MIN_ROWS &&
    rows.every((row) => row.ncp === 0 && row.npp === 0)
  ) {
    throw new DayFailure(
      'malformed',
      `${source} for ${date}: ${rows.length} rows and every premium is zero`,
    );
  }
}

async function ingestItem(item, date, spec, ctx) {
  const outcome = await fetchUwDayRows(spec.urlFor(item, date), ctx.apiKey, {
    rowField: spec.rowField,
    rowLabel: spec.rowLabel,
    userAgent: spec.userAgent,
    waitForSlot: ctx.waitForSlot,
  });
  if (outcome.kind === 'error') return outcome;
  const uwRows = outcome.kind === 'ok' ? outcome.rows : [];
  const source = spec.sourceOf(item);
  const { rows, dropped } = spec.toRows(date, source, uwRows);
  assertUsable(uwRows, rows, source, date);
  const stored = await storeRows(ctx.sql, FLOW_DATA_TARGET, rows, ctx);
  return {
    fetched: uwRows.length,
    stored,
    kept: rows.length,
    dropped,
    emptyItems: uwRows.length === 0 ? 1 : 0,
  };
}

/**
 * One day of flow_data for `spec`: each item fetched, mapped and written. A
 * runDays worker. Returns `{ fetched, stored, kept, dropped, emptyItems }`
 * summed over the items: `fetched` the rows UW sent, `kept` the flow_data rows
 * the mapping produced (the would-be count on a dry run), `stored` the rows the
 * database took (a live row of the same key is skipped), `dropped` the UW rows
 * left out as unusable (net flow: also the ticks whose premium counted as 0),
 * `emptyItems` how many items UW sent no rows for. One item failing doesn't
 * stop the others; the day then fails with the first failure's kind
 * (runDayItems), and a DB error is a `db` failure, never a warning. An item
 * whose rows are all unusable for the day, or all zero (assertUsable), fails
 * as `malformed` too, so it can't pass as a healthy day with kept 0.
 *
 * For the two sampled sources (ETF tide, net flow) the rows that are not
 * dropped collapse into the 5-minute rows, so `kept` is lower than
 * `fetched - dropped`. `emptyItems` is there because the other totals hide a
 * hole: with SPY empty and QQQ full, the day's counts look like a normal day
 * and SPY has no rows. It is not a failure (a wholly empty day isn't either);
 * summarizeItemRun lists the dates.
 */
export function processFlowDay(date, ctx, spec) {
  return runDayItems(spec.items, (item) => ingestItem(item, date, spec, ctx), {
    label: spec.itemLabel,
  });
}

// ── Script runner ──────────────────────────────────────────

/**
 * The body of a flow_data backfill script: flags (exit 2), the market-hours
 * refusal (exit 3), the env (exit 1), the run over the range, the printed
 * summary, and the exit code (0, 1, or 3 when the guard stopped the run
 * mid-way). Reads process.argv and process.env; the key and the database URL
 * are scrubbed from everything printed. A `--dry-run` needs no DATABASE_URL.
 * Anything unexpected after the env check (a bad connection string, a bug) is
 * printed as "backfill aborted" with exit code 1.
 */
export async function runFlowScript(spec) {
  let plan;
  try {
    plan = planFlowDays(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(EXIT_BAD_ARGS);
  }
  const { args, dates } = plan;

  const refusal = marketHoursRefusal(args);
  if (refusal) {
    console.error(refusal);
    process.exit(EXIT_GUARD_STOP);
  }

  const uwKey = process.env.UW_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!uwKey) {
    console.error('Missing UW_API_KEY (run with --env-file=.env.local)');
    process.exit(EXIT_FAILED);
  }
  if (!args.dryRun && !databaseUrl) {
    console.error('Missing DATABASE_URL (or pass --dry-run to skip writes)');
    process.exit(EXIT_FAILED);
  }

  const secrets = { uwKey, databaseUrl };
  const say = (line = '') => console.log(redact(line, secrets));

  say(
    `Backfilling ${spec.title}` + (args.dryRun ? ' (DRY RUN: no writes)' : ''),
  );
  say(
    `  ${dates.length} trading days, ${dates[0]} → ${dates.at(-1)}` +
      (args.limit == null ? '' : ` (--limit ${args.limit})`),
  );

  try {
    const ctx = {
      apiKey: uwKey,
      sql: args.dryRun ? null : neon(databaseUrl),
      dryRun: args.dryRun,
      waitForSlot: createRequestThrottle(UW_REQUESTS_PER_MINUTE),
    };
    const run = await runDays(
      dates,
      { allowMarketHours: args.allowMarketHours, secrets },
      (date) => processFlowDay(date, ctx, spec),
    );
    const report = summarizeItemRun(
      run,
      spec.items.length,
      spec.itemLabel,
      'rows',
    );
    say();
    for (const line of report.lines) say(line);
    if (args.dryRun) {
      say('(dry run: stored is 0 by design; kept is what would go in)');
    }
    process.exitCode = report.exitCode;
  } catch (err) {
    console.error(redact(`backfill aborted: ${err?.message ?? err}`, secrets));
    process.exitCode = EXIT_FAILED;
  }
}
