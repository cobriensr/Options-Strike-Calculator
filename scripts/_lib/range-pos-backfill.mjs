/**
 * Pure pieces of scripts/backfill-range-pos.mjs, kept here so they can be
 * tested: argument parsing, the selection window, the UW candle fetch,
 * range_pos row mapping, chunking, a small concurrency pool, a Neon retry
 * and the report helpers.
 *
 * Plain `node` can't import the TypeScript originals (their relative
 * `./x.js` imports only resolve under a bundler, and uwFetch pulls in the
 * Redis limiter), so two things are mirrored here. Each is pinned to its
 * source by range-pos-backfill.test.mjs:
 *   - computeRangePos  ← api/_lib/uw-stock-candles.ts
 *   - CASH_INDEX_ROOTS ← api/_lib/constants.ts
 *
 * Spec: docs/superpowers/specs/range-pos-fix-and-backfill-2026-10-28.md
 * (Phase 2).
 */

import { ctDateStr } from './trading-days.mjs';

// ── Mirrors of the TypeScript sources ─────────────────────

/**
 * Cash-settled index roots. UW refuses their OHLC with a 422 (code
 * `cboe_index_access_missing`), so their fires stay NULL by design.
 * Mirror of CASH_INDEX_ROOTS in api/_lib/constants.ts.
 */
export const CASH_INDEX_ROOTS = Object.freeze([
  'SPXW',
  'SPX',
  'NDXP',
  'NDX',
  'RUTW',
  'RUT',
]);

/**
 * Exact port of computeRangePos in api/_lib/uw-stock-candles.ts:
 * (spot − low) / (high − low) over the candles whose start_time is at or
 * before the trigger, clamped to [0, 1]. Null when there's no such
 * candle, the range is flat, or the trigger or spot isn't a number.
 */
export function computeRangePos(candles, triggerTimeIso, spotAtFirst) {
  const triggerMs =
    triggerTimeIso instanceof Date
      ? triggerTimeIso.getTime()
      : new Date(triggerTimeIso).getTime();
  if (!Number.isFinite(triggerMs)) return null;

  let high = -Infinity;
  let low = Infinity;
  let sawCandle = false;
  for (const c of candles) {
    const ms = new Date(c.start_time).getTime();
    if (!Number.isFinite(ms) || ms > triggerMs) continue;
    sawCandle = true;
    const h = Number.parseFloat(c.high);
    const l = Number.parseFloat(c.low);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  if (!sawCandle) return null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }
  const pos = (spotAtFirst - low) / (high - low);
  if (!Number.isFinite(pos)) return null;
  return Math.max(0, Math.min(1, pos));
}

// ── Arguments and selection ────────────────────────────────

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
 * Date bounds for the run. `before` is today's CT date: the selection
 * stops short of it so today's in-progress session (still being written
 * by the cron) is never touched. A session's CT and ET dates are the
 * same day, so this matches the ET `date` the cron stamps on each fire.
 */
export function selectionWindow({ from, to }) {
  return { from, to, before: ctDateStr() };
}

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

// ── Row mapping and batching ───────────────────────────────

/**
 * Map one ticker-day's NULL fires to UPDATE arrays. `id` is BIGSERIAL,
 * which Neon returns as a string; it's passed through untouched.
 * `spot` comes from `spot_at_first::float8`; a NULL spot stays NULL.
 */
export function rangePosUpdates(fires, candles) {
  const ids = [];
  const positions = [];
  let leftNull = 0;
  for (const fire of fires) {
    const spot = fire.spot == null ? Number.NaN : Number(fire.spot);
    const pos = computeRangePos(candles, fire.trigger_time_ct, spot);
    if (pos == null) {
      leftNull++;
      continue;
    }
    ids.push(fire.id);
    positions.push(pos);
  }
  return { ids, positions, leftNull };
}

/**
 * Split the pending UPDATE rows into write chunks. Only full chunks are
 * taken until `final`, when the partial tail goes too. Pure: returns the
 * chunks and the rows left over, and doesn't touch `pending`.
 */
export function takeReadyChunks(pending, size, final) {
  const { ids, positions } = pending;
  if (ids.length !== positions.length) {
    throw new Error(
      `pending rows out of step: ${ids.length} ids but ${positions.length} positions`,
    );
  }
  const ready = final ? ids.length : ids.length - (ids.length % size);
  if (ready === 0) return { chunks: [], rest: pending };
  const idChunks = chunk(ids.slice(0, ready), size);
  const positionChunks = chunk(positions.slice(0, ready), size);
  return {
    chunks: idChunks.map((chunkIds, k) => ({
      ids: chunkIds,
      positions: positionChunks[k],
    })),
    rest: { ids: ids.slice(ready), positions: positions.slice(ready) },
  };
}

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

// ── Unusual Whales ─────────────────────────────────────────

export const UW_BASE = 'https://api.unusualwhales.com/api';
/** Explicit UA: UW turns away some default client UAs (Python-urllib). */
export const UW_USER_AGENT = 'strike-calculator-range-pos-backfill (node)';
/** Same per-request timeout as uwFetch (TIMEOUTS.UW_API). */
const UW_TIMEOUT_MS = 15_000;
const UW_RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

async function attemptCandles(url, apiKey) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': UW_USER_AGENT,
      },
      signal: AbortSignal.timeout(UW_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const cause = err?.cause?.code ?? err?.cause?.message;
    const detail = cause ? `${messageOf(err)} (${cause})` : messageOf(err);
    return {
      kind: 'error',
      status: timedOut ? 'timeout' : 'network',
      detail,
      retryable: true,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      kind: 'error',
      status: `http_${res.status}`,
      detail: text.slice(0, 200),
      retryable: res.status === 429 || res.status >= 500,
    };
  }
  const malformed = (detail) => ({
    kind: 'error',
    status: 'malformed',
    detail,
    retryable: false,
  });
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return malformed(messageOf(err));
  }
  // uwFetch reads a null or missing `data` as []; do the same.
  const rows = body?.data;
  if (rows == null) return { kind: 'empty' };
  if (!Array.isArray(rows)) {
    return malformed(`data is ${typeof rows}, not an array`);
  }
  if (rows.length === 0) return { kind: 'empty' };
  const badIdx = rows.findIndex(
    (row) =>
      typeof row !== 'object' ||
      row === null ||
      typeof row.start_time !== 'string',
  );
  if (badIdx !== -1) return malformed(`candle ${badIdx} has no start_time`);
  return { kind: 'ok', candles: rows };
}

/**
 * One UW 1-min OHLC call for a ticker-day. Retries once, after 1 s, on a
 * 5xx, a 429, a network error or a timeout; a definite 4xx or a malformed
 * body is final. Never throws:
 *   { kind: 'ok', candles } | { kind: 'empty' }
 *   | { kind: 'error', status: 'http_<n>' | 'network' | 'timeout' | 'malformed', detail }
 */
export async function fetchDayCandles(apiKey, ticker, date) {
  const url = `${UW_BASE}/stock/${encodeURIComponent(ticker)}/ohlc/1m?date=${date}`;
  let outcome = await attemptCandles(url, apiKey);
  if (outcome.kind === 'error' && outcome.retryable) {
    await sleep(UW_RETRY_DELAY_MS);
    outcome = await attemptCandles(url, apiKey);
  }
  if (outcome.kind !== 'error') return outcome;
  return { kind: 'error', status: outcome.status, detail: outcome.detail };
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
 * Run a Neon query with a 30 s deadline per attempt, retrying a transient
 * failure (the deadline included) twice, after 2 s and then 4 s. A
 * genuine error (bad SQL, constraint) rethrows at once.
 */
export async function retryTransientDb(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withAttemptDeadline(fn);
    } catch (err) {
      const delay = DB_RETRY_DELAYS_MS[attempt];
      if (delay == null || !DB_TRANSIENT.test(messageOf(err))) throw err;
      await sleep(delay);
    }
  }
}

// ── Report ─────────────────────────────────────────────────

/**
 * Line up the per-month counts taken before and after the run. `after`
 * is null on a dry run, which reads as nothing filled. Rows come from
 * `COUNT(...)::int`, so they're already numbers.
 */
export function mergeMonthCounts(before, after) {
  const afterByMonth = new Map((after ?? []).map((row) => [row.month, row]));
  return before.map((row) => {
    const nullAfter =
      after == null
        ? row.null_all
        : (afterByMonth.get(row.month)?.null_all ?? 0);
    return {
      month: row.month,
      fires: row.fires,
      nullBefore: row.null_all,
      nullAfter,
      filled: row.null_all - nullAfter,
      nullIndex: row.null_index,
    };
  });
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
