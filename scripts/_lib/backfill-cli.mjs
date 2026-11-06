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
 *   - summarizeRun: failures counted by day and by kind, plus the exit code.
 * A worker marks a DB failure by running its Neon calls through
 * retryTransientDb, which tags whatever it throws.
 *
 * Two parsers, on purpose: parseArgs lets --from and --to come alone (the
 * range-pos backfill), parseRangeArgs also requires them together and
 * refuses a --to after today (the net-prem backfill, and the retrofits).
 *
 * Plan: docs/superpowers/plans/2026-11-05-summer-gap-phase3-retrofits.md
 * (P3.0). Parent spec: docs/superpowers/specs/summer-gap-rebuild-2026-10-29.md.
 */

import { isTradingDay } from '../../src/data/marketHours.ts';
import { ctDateStr, getTradingDays } from './trading-days.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** How far down an error's `cause` chain to look for a retryTransientDb error. */
const MAX_CAUSE_DEPTH = 5;

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
 *   --limit N             at most N ticker-days (newest first)
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
        throw new Error(
          `--limit needs a whole number of ticker-days, got ${raw}`,
        );
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
 */
const dbErrors = new WeakSet();

function markDbError(err) {
  if (err !== null && typeof err === 'object') dbErrors.add(err);
  return err;
}

/** True for an error out of retryTransientDb, or one that has it as a cause. */
function isDbError(err) {
  let current = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && typeof current === 'object';
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
 * genuine error (bad SQL, constraint) rethrows at once. Whatever it throws,
 * the deadline error too, is a `db` failure to classifyFailure: route every
 * Neon call of a day worker through it.
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
 * unless `allowMarketHours`, so a run started at 08:05 CT stops at 08:15;
 * the refusal that stopped it comes back as `stoppedBy`, and the days it
 * never started as `notRun`.
 *
 * One day's failure never ends the run. It is recorded against that day and
 * the loop moves on. A day fails when its worker
 *   - rejects: kind from classifyFailure (`db` for anything thrown through
 *     retryTransientDb, else `timeout`, `malformed`, `network` or `other`);
 *   - or returns a UW error outcome, `{ kind: 'error', status, detail }`,
 *     the way fetchUwDayRows gives one: `uw_http_<n>`, `network`,
 *     `timeout` or `malformed`.
 * Any other return value is the day's `value` and counts as done.
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
  return { date, ok: true, value };
}

function failedDay(date, failed, secrets) {
  const { kind, detail } = classifyFailure(failed);
  return {
    date,
    ok: false,
    failure: { kind, detail: redact(detail, secrets) },
  };
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
 * `failed` is a UW error outcome or a thrown value. The detail is the raw
 * message (with the cause's code when it has one): redact it before printing.
 */
export function classifyFailure(failed) {
  if (isUwErrorOutcome(failed)) return classifyUwOutcome(failed);
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
 * succeeded, the failed days in run order, the failures counted by kind
 * (most days first, ties by kind name, each with its dates and its first
 * example), and the exit code.
 *
 * exitCode is 0 only when every day ran and none failed. Otherwise it is 1,
 * a run stopped by the market-hours guard included: the days in `notRun`
 * are still unfilled, so a clean 0 would hide them. (The refusal before any
 * work starts is the script's own check and exit code: 3 in
 * backfill-range-pos.mjs. backfill-net-prem-ticks.mjs, which doesn't use
 * this loop, also exits 3 when the guard stops it mid-run.)
 */
export function summarizeRun({ days, stoppedBy, notRun = [] }) {
  const failedDays = [];
  const byKind = new Map();
  for (const day of days) {
    if (day.ok) continue;
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
    succeeded: days.length - failedDays.length,
    failedDays,
    byKind: [...byKind.values()].sort(
      (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
    ),
    stoppedBy,
    notRun,
    exitCode: failedDays.length === 0 && stoppedBy == null ? 0 : 1,
  };
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
