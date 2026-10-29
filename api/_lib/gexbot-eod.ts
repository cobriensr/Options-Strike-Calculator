/**
 * GEXBot end-of-day report capture: list tickers, download one ZIP per
 * ticker, store it in private R2, and index it in `gexbot_eod_reports`.
 *
 * Library only; the nightly cron calls it. Nothing here serves the files
 * (data-licensing rule), and there is no module-level state (R1).
 */

import { createHash } from 'node:crypto';
import { isTradingDay, priorTradingDay } from '../../src/data/marketHours.js';
import { getETDateStr, getETTime } from '../../src/utils/timezone.js';
import { getDb, withDbRetry } from './db.js';
import { buildAuthHeader, GEXBOT_BASE } from './gexbot-client.js';
import { r2HeadObject, r2PutObject } from './r2.js';

export const EOD_PRIORITY: readonly string[] = [
  'SPX',
  'ES_SPX',
  'NDX',
  'NQ_NDX',
  'RUT',
  'VIX',
  'SPY',
  'QQQ',
  'IWM',
  'TLT',
  'GLD',
  'USO',
  'TQQQ',
  'UVXY',
  'HYG',
  'SLV',
];

const TICKER_RE = /^[A-Z0-9_.]+$/;
const TICKERS_TIMEOUT_MS = 15_000;
/** GEXBot publishes the day's report after the 16:00 ET close; 17:00 is safe. */
const REPORT_READY_ET_HOUR = 17;
/** Largest report seen is 167.6 MB; 3 concurrent downloads stay under the 2 GB function memory. */
const MAX_EOD_REPORT_BYTES = 512 * 1024 * 1024;
const CONTENT_LENGTH_RE = /^[1-9]\d*$/;
const DISPOSITION_RE =
  /(?:^|[;\s])filename\*?=(?:UTF-8'')?"?eod_report_([A-Z0-9_.]+)_(\d{4}-\d{2}-\d{2})\.zip(?:["';\s]|$)/;

export type EodResponse =
  | { kind: 'quota' }
  | { kind: 'http_error'; status: number }
  | {
      kind: 'bad_response';
      reason: 'bad_disposition' | 'bad_content_type' | 'no_length';
    }
  | {
      kind: 'ok';
      servedDate: string;
      contentLength: number;
      readBody(): Promise<Uint8Array>;
      discard(): Promise<void>;
    };

export function eodKey(ticker: string, date: string): string {
  return `gexbot-eod/${ticker}/${date}.zip`;
}

export function parseEodDisposition(
  header: string | null,
): { ticker: string; date: string } | null {
  if (header == null) return null;
  const m = DISPOSITION_RE.exec(header);
  const ticker = m?.[1];
  const date = m?.[2];
  if (ticker == null || date == null || !TICKER_RE.test(ticker)) return null;
  return { ticker, date };
}

/** The latest trading day whose report is out: now >= 17:00 ET that day. */
export function latestEligibleReportDate(now: Date): string {
  const d = getETDateStr(now);
  if (isTradingDay(d) && getETTime(now).hour >= REPORT_READY_ET_HOUR) return d;
  return priorTradingDay(d);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export async function fetchEodTickers(): Promise<{
  tickers: string[];
  rejected: string[];
}> {
  const res = await fetch(`${GEXBOT_BASE}/tickers`, {
    signal: AbortSignal.timeout(TICKERS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gexbot_tickers_failed: HTTP ${res.status}`);
  let json: Record<string, unknown> | null;
  try {
    json = (await res.json()) as Record<string, unknown> | null;
  } catch {
    throw new Error('gexbot_tickers_failed: invalid JSON');
  }
  const all: string[] = [];
  for (const group of ['stocks', 'indexes', 'futures'] as const) {
    const list = json?.[group];
    if (!isStringArray(list)) {
      throw new Error(`gexbot_tickers_failed: "${group}" is not a string list`);
    }
    all.push(...list);
  }
  const unique = [...new Set(all)];
  const rejected = unique.filter((t) => !TICKER_RE.test(t));
  const valid = new Set(unique.filter((t) => TICKER_RE.test(t)));
  const priority = EOD_PRIORITY.filter((t) => valid.has(t));
  const prioritySet = new Set(priority);
  const rest = [...valid].filter((t) => !prioritySet.has(t)).sort();
  return { tickers: [...priority, ...rest], rejected };
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // An unreadable body is already being dropped; nothing to surface.
  }
}

/** Stream the body into one buffer sized to the declared length (1x memory). */
async function readBody(
  res: Response,
  contentLength: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(contentLength);
  const reader = res.body?.getReader();
  let received = 0;
  if (reader != null) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > contentLength) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `truncated: got ${received + value.length} of ${contentLength} bytes`,
        );
      }
      out.set(value, received);
      received += value.length;
    }
  }
  if (received !== contentLength) {
    throw new Error(`truncated: got ${received} of ${contentLength} bytes`);
  }
  return out;
}

export async function requestEodReport(
  apiKey: string,
  ticker: string,
  signal: AbortSignal,
): Promise<EodResponse> {
  const res = await fetch(`${GEXBOT_BASE}/hist/eod/${ticker}`, {
    headers: { Authorization: buildAuthHeader(apiKey) },
    signal,
  });
  if (res.status === 429) {
    await cancelBody(res);
    return { kind: 'quota' };
  }
  if (res.status !== 200) {
    await cancelBody(res);
    return { kind: 'http_error', status: res.status };
  }
  const served = parseEodDisposition(res.headers.get('content-disposition'));
  if (served == null || served.ticker !== ticker) {
    await cancelBody(res);
    return { kind: 'bad_response', reason: 'bad_disposition' };
  }
  if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('zip')) {
    await cancelBody(res);
    return { kind: 'bad_response', reason: 'bad_content_type' };
  }
  const lengthHeader = res.headers.get('content-length');
  const contentLength =
    lengthHeader != null && CONTENT_LENGTH_RE.test(lengthHeader)
      ? Number(lengthHeader)
      : Number.NaN;
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > MAX_EOD_REPORT_BYTES
  ) {
    await cancelBody(res);
    return { kind: 'bad_response', reason: 'no_length' };
  }
  return {
    kind: 'ok',
    servedDate: served.date,
    contentLength,
    readBody: () => readBody(res, contentLength),
    discard: () => cancelBody(res),
  };
}

interface IndexRow {
  ticker: string;
  date: string;
  bytes: number;
  sha256: string;
  entryCount: number;
  source: string;
  /** ISO timestamp, or null to let the DB default (now()) apply. */
  fetchedAt: string | null;
}

async function insertIndexRow(row: IndexRow): Promise<void> {
  const sql = getDb();
  const key = eodKey(row.ticker, row.date);
  await withDbRetry(
    () => sql`
      INSERT INTO gexbot_eod_reports
        (ticker, report_date, r2_key, bytes, sha256, entry_count, source, fetched_at)
      VALUES
        (${row.ticker}, ${row.date}, ${key}, ${row.bytes}, ${row.sha256},
         ${row.entryCount}, ${row.source}, COALESCE(${row.fetchedAt}::timestamptz, now()))
      ON CONFLICT (ticker, report_date) DO NOTHING`,
  );
}

export async function storeEodReport(args: {
  ticker: string;
  date: string;
  body: Uint8Array;
  entryCount: number;
}): Promise<{ key: string; sha256: string; bytes: number }> {
  const { ticker, date, body, entryCount } = args;
  const key = eodKey(ticker, date);
  const sha256 = createHash('sha256').update(body).digest('hex');
  // R2's single-part ETag is the body's MD5; this is an integrity check, not security.
  // eslint-disable-next-line sonarjs/hashing
  const md5 = createHash('md5').update(body).digest('hex');
  const fetchedAt = new Date().toISOString();
  await r2PutObject(key, body, {
    contentType: 'application/zip',
    metadata: {
      sha256,
      ticker,
      'report-date': date,
      'entry-count': String(entryCount),
      'source-content-length': String(body.length),
      'fetched-at': fetchedAt,
      source: 'cron',
    },
  });
  const head = await r2HeadObject(key);
  if (head == null) throw new Error('r2_verify_failed: object not found');
  if (head.contentLength !== body.length) {
    throw new Error(
      `r2_verify_failed: length ${head.contentLength} != ${body.length}`,
    );
  }
  if (head.etag !== md5) throw new Error('r2_verify_failed: etag mismatch');
  if (head.metadata.sha256 !== sha256) {
    throw new Error('r2_verify_failed: sha256 metadata mismatch');
  }
  await insertIndexRow({
    ticker,
    date,
    bytes: body.length,
    sha256,
    entryCount,
    source: 'cron',
    fetchedAt,
  });
  return { key, sha256, bytes: body.length };
}

/** Index an object already in R2 (e.g. the 10-28 rescue) from its metadata. */
export async function indexExistingObject(
  ticker: string,
  date: string,
): Promise<'indexed' | 'absent'> {
  const head = await r2HeadObject(eodKey(ticker, date));
  if (head == null) return 'absent';
  const { sha256, source } = head.metadata;
  const entryCount = Number(head.metadata['entry-count']);
  if (
    !sha256 ||
    !source ||
    !Number.isSafeInteger(entryCount) ||
    entryCount <= 0
  ) {
    throw new Error('object_without_metadata');
  }
  const fetchedRaw = head.metadata['fetched-at'];
  const fetchedMs = fetchedRaw == null ? Number.NaN : Date.parse(fetchedRaw);
  await insertIndexRow({
    ticker,
    date,
    bytes: head.contentLength,
    sha256,
    entryCount,
    source,
    fetchedAt: Number.isNaN(fetchedMs) ? null : (fetchedRaw ?? null),
  });
  return 'indexed';
}

export async function listStoredTickers(date: string): Promise<Set<string>> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () =>
      sql`SELECT ticker FROM gexbot_eod_reports WHERE report_date = ${date}`,
  )) as { ticker: string }[];
  return new Set(rows.map((r) => r.ticker));
}
