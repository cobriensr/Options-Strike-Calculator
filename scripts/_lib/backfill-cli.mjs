/**
 * The generic half of the plain-node REST backfill scripts, shared so each
 * retrofit imports it instead of copying it: the CLI flags, the market-hours
 * guard, trading-day selection, chunking and a worker pool, the UW request
 * throttle, the Neon retry, the guarded run loops, the failure bookkeeping
 * and the report helpers. Nothing here knows a table, an endpoint or a row.
 *
 * It started as two modules, which now import from here and re-export what
 * they used to define, so their scripts and tests are unchanged:
 *   - range-pos-backfill.mjs: parseArgs, isMarketHoursCt, chunk, runPool,
 *     retryTransientDb, summarizeFailures, redact
 *   - net-prem-ticks-backfill.mjs: parseArgs (here parseRangeArgs),
 *     marketHoursRefusal, tradingDaysInRange, selectDates,
 *     createRequestThrottle, runTickerDays, summarizeByDay,
 *     UW_REQUESTS_PER_MINUTE
 * The UW GET itself is uw-day-fetch.mjs's fetchUwDayRows.
 *
 * New for the retrofits (P3.1–P3.9), which don't abort on a failed day:
 *   - runDays: the day loop. Per-day try/catch, the market-hours guard
 *     before each day, each failure recorded against its day with a kind
 *     (classifyFailure: uw_http_<n>, network, timeout, malformed, db, other)
 *     and a redacted detail.
 *   - runDayItems: a day's fan-out over tickers or strikes. Tries every item
 *     and throws one DayFailure that keeps the first failure's kind.
 *   - summarizeRun: failures counted by day and by kind, the empty days, and
 *     the exit code (EXIT_OK, EXIT_FAILED, EXIT_GUARD_STOP);
 *     formatRunSummary turns it into printable lines; summarizeItemRun adds
 *     the days where only some of a day's items had rows.
 *   - planRangeDays: the flags and days of a retrofit that has no lookback
 *     default (--from/--to required, --to a finished ET day, --limit).
 *   - storeRows: the batched (≤ WRITE_BATCH rows) INSERT ... ON CONFLICT DO
 *     NOTHING, the write side of a worker.
 * A worker returns counts, not rows: { fetched, stored }. It marks a DB
 * failure by running its Neon calls, and only them, through
 * retryTransientDb, which labels whatever it throws.
 *
 * Two parsers, on purpose: parseArgs lets --from and --to come alone (the
 * range-pos backfill), parseRangeArgs also requires them together and
 * refuses a --to after today (the net-prem backfill, and the retrofits).
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md
 * (P3.0). Parent spec: docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md.
 */

import { isTradingDay } from '../../src/data/marketHours.ts';
import { getETToday } from '../../src/utils/timezone.ts';
import { ctDateStr, getTradingDays } from './trading-days.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

// ── Exit codes ─────────────────────────────────────────────

/** Every day ran and none failed. */
export const EXIT_OK = 0;
/** A day failed (summarizeRun), or a script's env is missing. */
export const EXIT_FAILED = 1;
/** The flags did not parse. */
export const EXIT_BAD_ARGS = 2;
/**
 * The market-hours guard refused or stopped the run: before any work in the
 * scripts, or, from summarizeRun, mid-run with no day failed.
 */
export const EXIT_GUARD_STOP = 3;

// ── Arguments ──────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/**
 * Parse the CLI flags. Throws with a message naming the bad flag.
 *   --dry-run             compute and report, but write nothing
 *   --allow-market-hours  run even inside isMarketHoursCt's window
 *   --limit N             a whole number ≥ 1; what it counts is the script's
 *                         own (for runDays scripts: the first N trading days
 *                         of the range, by slicing the dates)
 *   --from YYYY-MM-DD     first trading date to fill (inclusive)
 *   --to YYYY-MM-DD       last trading date to fill (inclusive)
 * --from and --to may come alone here; parseRangeArgs is the stricter form.
 */
export function parseArgs(argv) {
  const args = {
    dryRun: false,
    allowMarketHours: false,
    limit: null,
    from: null,
    to: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--allow-market-hours') {
      args.allowMarketHours = true;
    } else if (flag === '--limit') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--limit needs a whole number, got ${raw}`);
      }
      args.limit = n;
    } else if (flag === '--from' || flag === '--to') {
      const raw = argv[++i];
      if (!isIsoDate(raw)) {
        throw new Error(`${flag} needs a YYYY-MM-DD date, got ${raw}`);
      }
      args[flag.slice(2)] = raw;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (args.from != null && args.to != null && args.from > args.to) {
    throw new Error(`--from ${args.from} is after --to ${args.to}`);
  }
  return args;
}

/**
 * parseArgs plus the two rules of a date-range backfill: --from and --to go
 * together (with neither, the script keeps its own default, such as a DAYS
 * lookback), and --to can't be after today in CT. Throws with a message
 * naming the bad flag.
 */
export function parseRangeArgs(argv) {
  const args = parseArgs(argv);
  if ((args.from == null) !== (args.to == null)) {
    throw new Error(
      '--from and --to go together: pass both for a date range, or ' +
        'neither for the DAYS lookback',
    );
  }
  const today = ctDateStr();
  if (args.to != null && args.to > today) {
    throw new Error(`--to ${args.to} is after today (${today} CT)`);
  }
  return args;
}

// ── Market-hours guard ─────────────────────────────────────

const CT_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
/** 08:15 CT, a little before the open. */
const GUARD_START_MIN = 8 * 60 + 15;
/** 15:30 CT, a little after the close. */
const GUARD_END_MIN = 15 * 60 + 30;

/**
 * True on a weekday from 08:15 up to 15:30 CT. The backfill refuses to
 * run then (unless --allow-market-hours): its UW calls skip the shared
 * Redis semaphore, so they compete with the live crons for the key's 3
 * concurrent slots, and a 429 there opens detect-lottery-fires' candle
 * breaker. Holidays aren't known here; the flag covers them.
 * (scripts/_lib/trading-days.mjs only does dates, not time of day.)
 */
export function isMarketHoursCt() {
  const parts = Object.fromEntries(
    CT_CLOCK.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= GUARD_START_MIN && minute < GUARD_END_MIN;
}

/**
 * The refusal to print when the run would start 08:15–15:30 CT on a weekday
 * without --allow-market-hours, else null. Same window and reason as
 * isMarketHoursCt: these UW calls skip the shared Redis semaphore, so they
 * compete with the live crons for the key's concurrency cap.
 */
export function marketHoursRefusal({ allowMarketHours }) {
  if (allowMarketHours || !isMarketHoursCt()) return null;
  return (
    'Refusing to run 08:15–15:30 CT on a weekday: the backfill would compete ' +
    "with the live crons for UW's concurrency cap. Run after the close, or " +
    'pass --allow-market-hours (e.g. on a market holiday).'
  );
}

// ── Dates ──────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * NYSE trading days from `from` to `to` (YYYY-MM-DD), inclusive, ascending:
 * weekdays that src/data/marketHours.ts doesn't list as full closures. That
 * list covers 2025–2027; outside it a holiday reads as a trading day, and
 * UW's empty answer then shows up in the per-day summary.
 */
export function tradingDaysInRange(from, to) {
  const days = [];
  // UTC noon steps by exactly one day: UTC has no DST.
  const end = Date.parse(`${to}T12:00:00Z`);
  for (let ms = Date.parse(`${from}T12:00:00Z`); ms <= end; ms += ONE_DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (isTradingDay(day)) days.push(day);
  }
  return days;
}

/**
 * The dates to fetch. With --from/--to: the range's trading days (throws
 * when it holds none). Without: the last `lookbackDays` weekdays ending
 * today, the original lookback behavior (holidays included, as before).
 */
export function selectDates({ from, to }, lookbackDays) {
  if (from == null) {
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
      throw new Error(
        `DAYS must be a whole number of days, got ${lookbackDays}`,
      );
    }
    return { mode: 'lookback', dates: getTradingDays(lookbackDays) };
  }
  const dates = tradingDaysInRange(from, to);
  if (dates.length === 0) {
    throw new Error(`no trading days between --from ${from} and --to ${to}`);
  }
  return { mode: 'range', dates };
}

/**
 * The flags and the days of a backfill that has no lookback default: --from
 * and --to are both required (`noDefaultReason` says why, in the error), and
 * --to must be a finished ET day, because for today the live crons own the
 * rows and the day's last print is still forming. --limit N keeps the first N
 * trading days of the range, in order. Returns `{ args, dates }`, or throws a
 * message naming the problem, which the scripts print and exit 2 on.
 */
export function planRangeDays(argv, noDefaultReason) {
  const args = parseRangeArgs(argv);
  if (args.from == null) {
    throw new Error(`--from and --to are required: ${noDefaultReason}`);
  }
  const etToday = getETToday();
  if (args.to >= etToday) {
    throw new Error(
      `--to ${args.to} is not a finished day (today is ${etToday} ET): ` +
        'the live crons fill today',
    );
  }
  const { dates } = selectDates(args);
  return {
    args,
    dates: args.limit == null ? dates : dates.slice(0, args.limit),
  };
}

// ── Batching and concurrency ───────────────────────────────

export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be at least 1, got ${size}`);
  }
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, results in
 * input order. After a worker throws, no new item starts and the pool
 * rejects with that error.
 */
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

// ── Unusual Whales throttle ────────────────────────────────

/**
 * UW requests a minute, at most. The spec's ceiling: the live crons keep
 * the rest of the key's per-minute cap.
 */
export const UW_REQUESTS_PER_MINUTE = 300;

/**
 * A gate shared by every lane: each call resolves at least
 * ceil(60 000 / perMinute) ms after the previous one, so no 60 s window
 * [t, t + 60 s) holds more than `perMinute` starts. Await it before each
 * UW request, retries included. The slot is reserved before the first
 * await, so concurrent callers never share one.
 */
export function createRequestThrottle(perMinute) {
  if (!Number.isInteger(perMinute) || perMinute < 1) {
    throw new Error(`perMinute must be a whole number, got ${perMinute}`);
  }
  const spacingMs = Math.ceil(60_000 / perMinute);
  let nextStart = -Infinity;
  return async function waitForSlot() {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + spacingMs;
    if (start > now) await sleep(start - now);
  };
}

// ── Neon ───────────────────────────────────────────────────

/** Same transient pattern as DB_RETRYABLE_RX in api/_lib/db.ts. */
const DB_TRANSIENT =
  /timeout|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|fetch failed|socket hang up|TLS connection|EAI_AGAIN|recovery_mode|server_login_retry|Too many connections|connection closed|server conn crashed/i;
const DB_RETRY_DELAYS_MS = [2_000, 4_000];
/**
 * Per-attempt deadline. The heaviest call (the per-month counts over the
 * table) takes seconds; this only cuts off a hung HTTP request or a long
 * row-lock wait. Its "timeout" message is transient, so it's retried.
 */
const DB_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Race one attempt against DB_ATTEMPT_TIMEOUT_MS, clearing the timer once
 * it settles (the withDbRetry pattern in api/_lib/db.ts). The abandoned
 * request isn't cancelled: if it was an UPDATE that later commits, the
 * retry's `IS NULL` guard skips those rows.
 */
async function withAttemptDeadline(fn) {
  let timeoutHandle;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(`db attempt timeout after ${DB_ATTEMPT_TIMEOUT_MS} ms`),
            ),
          DB_ATTEMPT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Every error retryTransientDb has thrown. This is how a day's failure is
 * told apart as `db` (see classifyFailure): the error object itself is left
 * as it was, and a WeakSet lets it be collected once nothing holds it.
 * Membership is by identity, so the label survives only while the error
 * itself, or an error holding it as `cause`, is what reaches classifyFailure.
 * A DB error that is caught and re-wrapped without `cause` loses it.
 */
const dbErrors = new WeakSet();

function markDbError(err) {
  if (err !== null && typeof err === 'object') dbErrors.add(err);
  return err;
}

/**
 * How many `cause` links below the error isDbError follows: the error itself
 * and up to this many causes are checked.
 */
const MAX_CAUSE_DEPTH = 5;

/** True for an error out of retryTransientDb, or one that has it as a cause. */
function isDbError(err) {
  let current = err;
  for (
    let depth = 0;
    depth <= MAX_CAUSE_DEPTH && current !== null && typeof current === 'object';
    depth++
  ) {
    if (dbErrors.has(current)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Run a Neon query with a 30 s deadline per attempt, retrying a transient
 * failure (the deadline included) twice, after 2 s and then 4 s. A
 * genuine error (bad SQL, constraint) rethrows at once.
 *
 * Whatever it throws, the deadline error too, is labelled `db` for
 * classifyFailure. That has two halves for a day worker:
 *   - The closure holds the Neon call and nothing else. Anything thrown
 *     inside it, a bug in code that doesn't touch Neon included, is
 *     labelled `db`.
 *   - A Neon call outside it is not recognised as `db` (it lands in `other`),
 *     and a DB error caught and re-thrown must keep the original as `cause`.
 */
export async function retryTransientDb(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withAttemptDeadline(fn);
    } catch (err) {
      const delay = DB_RETRY_DELAYS_MS[attempt];
      if (delay == null || !DB_TRANSIENT.test(messageOf(err))) {
        throw markDbError(err);
      }
      await sleep(delay);
    }
  }
}

/** Rows per INSERT (the ≤500 batching rule). */
export const WRITE_BATCH = 500;

/**
 * One multi-row INSERT for `rows`. `target` is `{ table, columns,
 * conflictTarget }`: constants in the calling module, never data, because they
 * are spliced into the text. Every value is a bound parameter, a missing field
 * a NULL. DO NOTHING, so a row already stored (a live cron's) stays as it is.
 * RETURNING id counts the rows ON CONFLICT let in, so the table needs an `id`.
 */
function insertStatement({ table, columns, conflictTarget }, rows) {
  const values = [];
  const groups = rows.map((row) => {
    const params = columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${params.join(', ')})`;
  });
  const text =
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${groups.join(', ')} ` +
    `ON CONFLICT ${conflictTarget} DO NOTHING RETURNING id`;
  return { text, values };
}

/**
 * Write `rows` to `target` in statements of WRITE_BATCH rows, in order, and stop
 * at the first that fails. Returns how many rows the database took (RETURNING
 * counts only rows ON CONFLICT let in); a dry run writes nothing and returns 0.
 * Each statement goes through retryTransientDb, so a transient Neon error is
 * retried and any Neon error comes out labelled `db`. A retry after a lost
 * response finds its rows already stored, so the count can read low, never the
 * data.
 */
export async function storeRows(sql, target, rows, { dryRun }) {
  if (dryRun || rows.length === 0) return 0;
  let stored = 0;
  for (const part of chunk(rows, WRITE_BATCH)) {
    const { text, values } = insertStatement(target, part);
    const result = await retryTransientDb(() => sql.query(text, values));
    stored += Array.isArray(result)
      ? result.length
      : (result.rows?.length ?? 0);
  }
  return stored;
}

// ── Run loops ──────────────────────────────────────────────

/**
 * Run `processPair` over `pairs`, `concurrency` at a time (runPool),
 * checking the market-hours guard before each ticker-day unless
 * `allowMarketHours`: a run started at 08:05 CT stops taking new
 * ticker-days at 08:15 (in-flight ones finish). Returns the refusal that
 * stopped it, or null when every pair ran. A processPair rejection rejects.
 */
export async function runTickerDays(
  pairs,
  { concurrency, allowMarketHours },
  processPair,
) {
  let stoppedBy = null;
  await runPool(pairs, concurrency, async (pair) => {
    stoppedBy ??= marketHoursRefusal({ allowMarketHours });
    if (stoppedBy != null) return;
    await processPair(pair);
  });
  return stoppedBy;
}

/**
 * Run `worker(date)` over `dates`, one day at a time, in order. The
 * market-hours guard is checked before every day (the first included)
 * unless `allowMarketHours`, so a run started at 08:05 CT stops taking new
 * days at 08:15 while the day in flight finishes. The refusal that stopped
 * it comes back as `stoppedBy`, and the days it never started as `notRun`.
 *
 * A worker returns counts, not rows: `{ fetched, stored }`, both whole
 * numbers ≥ 0.
 *   - `fetched` is the rows UW returned, before any filter. `fetched: 0` is
 *     the empty-day signal in summarizeRun: UW had no rows for a trading
 *     day, a hole worth a look.
 *   - `stored` is the rows actually written, so 0 on `--dry-run`. A count of
 *     what a dry run would have written goes in an extra field such as
 *     `wouldStore`.
 *   - Any extra fields are left unchecked and printed by formatRunSummary as
 *     `name value`. Keep them small: summarizeRun holds them for every day
 *     of the run.
 * A return value without the two counts fails that day as `other`, so a
 * worker can't hide an empty day by leaving `fetched` out.
 *
 * One day's failure never ends the run. It is recorded against that day and
 * the loop moves on. A day fails when its worker
 *   - rejects: kind from classifyFailure (`db` for anything thrown through
 *     retryTransientDb, else `timeout`, `malformed`, `network` or `other`);
 *   - or returns a UW error outcome, `{ kind: 'error', status, detail }`,
 *     the way fetchUwDayRows gives one: `uw_http_<n>`, `network`,
 *     `timeout` or `malformed`.
 *
 * One failure is recorded per day: the first. A worker that fans out over
 * tickers, strikes or the like should use runDayItems: it tries every item
 * and throws one DayFailure that keeps the first failure's kind. A plain
 * `new Error` thrown at the end of the day is `other`, whatever failed
 * behind it, and a runPool fan-out stops starting items after its first
 * rejection.
 *
 * `secrets` is `{ uwKey, databaseUrl }`; every failure detail is redacted
 * with them before it is stored, so it is safe to print.
 *
 * Returns `{ days, stoppedBy, notRun }` where each day is
 *   { date, ok: true, value } | { date, ok: false, failure: { kind, detail } }
 * Feed it to summarizeRun for the counts and the exit code.
 */
export async function runDays(dates, { allowMarketHours, secrets }, worker) {
  if (secrets == null) {
    throw new Error(
      'runDays needs the secrets to redact from failure details: ' +
        '{ uwKey, databaseUrl }',
    );
  }
  const days = [];
  let stoppedBy = null;
  for (const date of dates) {
    stoppedBy = marketHoursRefusal({ allowMarketHours });
    if (stoppedBy != null) break;
    days.push(await runOneDay(date, worker, secrets));
  }
  return { days, stoppedBy, notRun: dates.slice(days.length) };
}

async function runOneDay(date, worker, secrets) {
  let value;
  try {
    value = await worker(date);
  } catch (err) {
    return failedDay(date, err, secrets);
  }
  if (isUwErrorOutcome(value)) return failedDay(date, value, secrets);
  if (!isDayCounts(value)) {
    return failedDay(date, wrongValueError(value), secrets);
  }
  return { date, ok: true, value };
}

function wrongValueError(value) {
  return new TypeError(
    'worker value must be { fetched, stored } as whole numbers ≥ 0, ' +
      `got ${describeValue(value)}`,
  );
}

function isCount(n) {
  return Number.isInteger(n) && n >= 0;
}

function isDayCounts(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isCount(value.fetched) &&
    isCount(value.stored)
  );
}

/** How many key names of a wrong worker value to list; more end in ", ...". */
const MAX_KEYS_SHOWN = 10;

/**
 * A short, safe description of a bad worker value: an object's key names and
 * the two counts (a number as itself, anything else as its type), never any
 * other value. `return await fetchUwDayRows(...)` reads as "keys kind, rows".
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  const shown = keys.slice(0, MAX_KEYS_SHOWN).join(', ');
  const names = keys.length > MAX_KEYS_SHOWN ? `${shown}, ...` : shown;
  const show = (n) => (typeof n === 'number' ? String(n) : typeof n);
  return (
    `keys ${names === '' ? '(none)' : names}; ` +
    `fetched is ${show(value.fetched)}, stored is ${show(value.stored)}`
  );
}

function failedDay(date, failed, secrets) {
  const { kind, detail } = classifyFailure(failed);
  return {
    date,
    ok: false,
    failure: { kind, detail: redact(detail, secrets) },
  };
}

/**
 * The kinds a failure may carry. Checked on a DayFailure because its kind is
 * trusted as given: an undefined one would make summarizeRun's sort throw,
 * and a newline in one would break a printed line.
 */
const FAILURE_KIND = /^(uw_http_\d+|network|timeout|malformed|db|other)$/;

/**
 * A failure whose kind is stated, not read off an error: classifyFailure
 * returns `kind` as given, one of its kinds (`uw_http_<n>`, `network`,
 * `timeout`, `malformed`, `db`, `other`). runDayItems throws one. A plain
 * `new Error` thrown at the end of a day is `other`, whatever failed behind
 * it, and wrapping the errors as `cause` keeps only `db` and `network`.
 */
export class DayFailure extends Error {
  constructor(kind, message) {
    super(message);
    if (typeof kind !== 'string' || !FAILURE_KIND.test(kind)) {
      // Quoted, so a newline in a bad kind can't break the message.
      throw new TypeError(
        'DayFailure kind must be uw_http_<n>, network, timeout, malformed, ' +
          `db or other, got ${JSON.stringify(String(kind))}`,
      );
    }
    this.name = 'DayFailure';
    this.kind = kind;
  }
}

/**
 * The fan-out of one day over its items (tickers, strikes, expiries):
 * `perItem(item, index)` runs for every item, `concurrency` at a time
 * (default 1), and one item's failure never stops the others. It returns
 * counts like a runDays worker (`{ fetched, stored }` plus extras) or a UW
 * error outcome, or it throws; any other return value is a failure.
 *
 * All items succeeded: the counts are summed over the items, every numeric
 * field, extras included (a non-numeric extra is dropped; an extra that isn't
 * additive, a ratio, belongs on the totals the worker returns, not on the
 * items).
 *
 * Any item failed: it throws one DayFailure that keeps the kind of the first
 * failure in item order (classifyFailure, so a retryTransientDb error stays
 * `db`), with the message "<k> of <n> <label> failed; first (<item>):
 * <detail>". The counts of the items that did succeed are lost then. That is
 * fine for the one-failure-per-day rule: the day is re-run, and its writes
 * are idempotent (ON CONFLICT). `<item>` is a string or number item as it
 * is, any other item by its position, `#<index>`. The detail is raw, and
 * runDays redacts it.
 *
 * The throttle is the caller's: perItem awaits it before each UW request
 * (fetchUwDayRows' `waitForSlot`), so a higher concurrency shares it.
 */
export async function runDayItems(
  items,
  perItem,
  { concurrency = 1, label = 'items' } = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `concurrency must be a whole number ≥ 1, got ${concurrency}`,
    );
  }
  const results = await runPool(items, concurrency, (item, index) =>
    tryItem(item, index, perItem),
  );
  const totals = { fetched: 0, stored: 0 };
  let failedCount = 0;
  let first = null;
  for (const result of results) {
    if (result.ok) {
      addCounts(totals, result.value);
    } else {
      failedCount++;
      first ??= result;
    }
  }
  if (first == null) return totals;
  const { kind, detail } = classifyFailure(first.failed);
  throw new DayFailure(
    kind,
    `${failedCount} of ${items.length} ${label} failed; ` +
      `first (${first.name}): ${detail}`,
  );
}

/** One item, never rejecting: { ok: true, value } | { ok: false, name, failed }. */
async function tryItem(item, index, perItem) {
  const named = typeof item === 'string' || typeof item === 'number';
  const name = named ? String(item) : `#${index}`;
  try {
    const value = await perItem(item, index);
    if (isUwErrorOutcome(value)) return { ok: false, name, failed: value };
    if (!isDayCounts(value)) {
      return { ok: false, name, failed: wrongValueError(value) };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, name, failed: err };
  }
}

function addCounts(totals, value) {
  for (const [name, n] of Object.entries(value)) {
    if (typeof n === 'number') totals[name] = (totals[name] ?? 0) + n;
  }
}

// ── Failures ───────────────────────────────────────────────

const UW_HTTP_STATUS = /^http_(\d+)$/;
/** fetchUwDayRows statuses that are their own failure kind. */
const UW_PLAIN_STATUSES = new Set(['network', 'timeout', 'malformed']);
const NETWORK_ERROR =
  /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|socket hang up/i;

/** A UW error outcome: { kind: 'error', status: 'http_<n>' | 'network' | ... }. */
function isUwErrorOutcome(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.kind === 'error' &&
    typeof value.status === 'string'
  );
}

/**
 * Read what failed into `{ kind, detail }`, where `kind` is one of
 *   uw_http_<n>  a UW outcome with status http_<n> (a 4xx is never "no data")
 *   network      a UW outcome of that status, or a thrown fetch/socket error
 *   timeout      a UW outcome of that status, or a thrown TimeoutError or
 *                AbortError
 *   malformed    a UW outcome of that status, or a thrown SyntaxError (a
 *                body that isn't JSON)
 *   db           anything thrown through retryTransientDb, its 30 s deadline
 *                error included (a db timeout is a db failure, not a timeout)
 *   other        everything else; a UW outcome with an unknown status keeps
 *                the status in its detail
 * A DayFailure is the exception: its `kind` is returned as given.
 * `failed` is a UW error outcome or a thrown value. The detail is the raw
 * message (with the cause's code when it has one): redact it before printing.
 */
export function classifyFailure(failed) {
  if (isUwErrorOutcome(failed)) return classifyUwOutcome(failed);
  if (failed instanceof DayFailure) {
    return { kind: failed.kind, detail: failed.message };
  }
  const message = messageOf(failed);
  const cause = failed?.cause?.code ?? failed?.cause?.message;
  const hint = typeof cause === 'string' && cause !== '' ? cause : null;
  return {
    kind: kindOfThrown(failed, hint == null ? message : `${message} ${hint}`),
    detail: hint == null ? message : `${message} (${hint})`,
  };
}

function classifyUwOutcome({ status, detail }) {
  const http = UW_HTTP_STATUS.exec(status);
  if (http) return { kind: `uw_http_${http[1]}`, detail: detail ?? '' };
  if (UW_PLAIN_STATUSES.has(status)) {
    return { kind: status, detail: detail ?? '' };
  }
  return { kind: 'other', detail: detail ? `${status}: ${detail}` : status };
}

function kindOfThrown(err, text) {
  if (isDbError(err)) return 'db';
  const name = err?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'SyntaxError') return 'malformed';
  if (NETWORK_ERROR.test(text)) return 'network';
  return 'other';
}

// ── Report ─────────────────────────────────────────────────

/**
 * The end-of-run numbers for a runDays result: how many days ran and
 * succeeded, the succeeded days with their counts (`okDays`), the dates among
 * them with `fetched: 0` (`emptyDays`: UW had no rows for a trading day, a
 * hole worth a look; it never changes the exit code), the failed days in run
 * order, the failures counted by kind (most days first, ties by kind name,
 * each with its dates and its first example), and the exit code.
 *
 * exitCode, by plain precedence:
 *   1 (EXIT_FAILED) when any day failed, whether or not the guard also
 *     stopped the run, so a failure is never reported as a plain stop;
 *   3 (EXIT_GUARD_STOP, the scripts' refusal code) when the market-hours
 *     guard stopped the run and no day failed: the days in `notRun` are
 *     still unfilled, so a 0 would hide them;
 *   0 (EXIT_OK) otherwise.
 * backfill-net-prem-ticks.mjs doesn't use this loop; it puts its guard stop
 * ahead of failures (3 even when ticker-days failed) and is left as it was.
 */
export function summarizeRun({ days, stoppedBy, notRun = [] }) {
  const okDays = [];
  const emptyDays = [];
  const failedDays = [];
  const byKind = new Map();
  for (const day of days) {
    if (day.ok) {
      okDays.push({ date: day.date, value: day.value });
      if (day.value.fetched === 0) emptyDays.push(day.date);
      continue;
    }
    const { kind, detail } = day.failure;
    failedDays.push({ date: day.date, kind, detail });
    const entry = byKind.get(kind);
    if (entry) {
      entry.count++;
      entry.dates.push(day.date);
    } else {
      byKind.set(kind, {
        kind,
        count: 1,
        dates: [day.date],
        example: { date: day.date, detail },
      });
    }
  }
  return {
    attempted: days.length,
    succeeded: okDays.length,
    okDays,
    emptyDays,
    failedDays,
    byKind: [...byKind.values()].sort(
      (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
    ),
    stoppedBy,
    notRun,
    exitCode: exitCodeOf(failedDays.length, stoppedBy),
  };
}

function exitCodeOf(failedCount, stoppedBy) {
  if (failedCount > 0) return EXIT_FAILED;
  if (stoppedBy != null) return EXIT_GUARD_STOP;
  return EXIT_OK;
}

/**
 * The printable lines for a summarizeRun result: the day counts, each
 * succeeded day's fetched/stored (and any extra fields, as `name value`)
 * with the totals, the failures by kind with their dates and first example,
 * the empty days, and the guard stop with the days not run. Pure: the caller
 * prints the lines. Failure details are already redacted when the days came
 * from runDays. A detail or an extra with a newline in it is printed on one
 * line, its whitespace collapsed.
 */
export function formatRunSummary(summary) {
  const { okDays, emptyDays, failedDays, byKind, stoppedBy, notRun } = summary;
  const lines = [
    `days: ${summary.attempted} run, ${summary.succeeded} done, ` +
      `${failedDays.length} failed`,
  ];
  let fetched = 0;
  let stored = 0;
  for (const { date, value } of okDays) {
    fetched += value.fetched;
    stored += value.stored;
    lines.push(`  ${date}  ${countsOf(value)}`);
  }
  if (okDays.length > 0) {
    lines.push(`  ${'total'.padEnd(10)}  fetched ${fetched}  stored ${stored}`);
  }
  if (byKind.length > 0) {
    lines.push('failures by kind:');
    for (const { kind, count, dates, example } of byKind) {
      lines.push(
        `  ${kind}: ${count} ${count === 1 ? 'day' : 'days'} ` +
          `(${dates.join(', ')}); first: ${example.date}: ` +
          oneLine(example.detail),
      );
    }
  }
  if (emptyDays.length > 0) {
    lines.push(`empty days (UW had no rows): ${emptyDays.join(', ')}`);
  }
  if (stoppedBy != null) lines.push(`stopped: ${stoppedBy}`);
  if (notRun.length > 0) {
    lines.push(`not run (${notRun.length}): ${notRun.join(', ')}`);
  }
  return lines;
}

/**
 * summarizeRun and formatRunSummary for a run whose day worker fans out over
 * items (runDayItems) and returns `emptyItems`, how many of its items UW sent
 * no rows for. `{ lines, exitCode }`: the shared summary's lines and exit code,
 * plus one line naming the dates that were partly empty. `itemCount` is how
 * many items a day fans out over, `itemLabel` what they are called ('tickers',
 * 'sources') and `rowNoun` what UW sends for each ('bars', 'rows').
 *
 * A partly empty day is a done day (UW answered, the rest was written) where
 * some, not all, of the items had no rows: its totals look healthy while one
 * ticker or source has no rows. It is a hole to look at, not a failure, so it
 * does not change the exit code, like a wholly empty day, which the shared
 * summary already lists as an empty day.
 */
export function summarizeItemRun(run, itemCount, itemLabel, rowNoun) {
  const summary = summarizeRun(run);
  const lines = formatRunSummary(summary);
  const partly = run.days.filter(
    (day) => day.ok && day.value.fetched > 0 && day.value.emptyItems > 0,
  );
  if (partly.length > 0) {
    const dates = partly
      .map((day) => `${day.date} (${day.value.emptyItems} empty)`)
      .join(', ');
    lines.push(
      `partly empty days (UW had no ${rowNoun} for some of the ${itemCount} ` +
        `${itemLabel}; a hole to look at, not a failure): ${dates}`,
    );
  }
  return { lines, exitCode: summary.exitCode };
}

/** "fetched 405  stored 390" plus any extra fields, each as "name value". */
function countsOf({ fetched, stored, ...extras }) {
  const parts = [`fetched ${fetched}`, `stored ${stored}`];
  for (const [name, extra] of Object.entries(extras)) {
    parts.push(oneLine(`${name} ${extra}`));
  }
  return parts.join('  ');
}

/** Any run of whitespace, a newline included, as one space: one printed line. */
function oneLine(text) {
  return String(text).replaceAll(/\s+/g, ' ').trim();
}

/** Failures by status, most common first, each with its first example. */
export function summarizeFailures(failures) {
  const byStatus = new Map();
  for (const f of failures) {
    const entry = byStatus.get(f.status);
    if (entry) {
      entry.count++;
    } else {
      byStatus.set(f.status, {
        status: f.status,
        count: 1,
        example: { ticker: f.ticker, date: f.date, detail: f.detail },
      });
    }
  }
  return [...byStatus.values()].sort(
    (a, b) => b.count - a.count || a.status.localeCompare(b.status),
  );
}

/**
 * Per-date totals for the report, ascending by date. Each result is one
 * ticker-day: { date, kind: 'ok' | 'empty' | 'error', fetched, kept, stored }.
 */
export function summarizeByDay(results) {
  const byDate = new Map();
  for (const r of results) {
    let day = byDate.get(r.date);
    if (!day) {
      day = {
        date: r.date,
        tickers: 0,
        ok: 0,
        empty: 0,
        failed: 0,
        fetched: 0,
        kept: 0,
        stored: 0,
      };
      byDate.set(r.date, day);
    }
    day.tickers++;
    if (r.kind === 'error') day.failed++;
    else if (r.kind === 'empty') day.empty++;
    else day.ok++;
    day.fetched += r.fetched;
    day.kept += r.kept;
    day.stored += r.stored;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function urlPasswords(url) {
  try {
    const raw = new URL(url).password;
    return raw ? [raw, decodeURIComponent(raw)] : [];
  } catch {
    return [];
  }
}

/**
 * Scrub the UW key, the database URL and its password from text before
 * it's printed. Longest first, so the URL goes before the password in it.
 */
export function redact(text, { uwKey, databaseUrl }) {
  const secrets = [uwKey, databaseUrl, ...urlPasswords(databaseUrl)]
    .filter((s) => typeof s === 'string' && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}
