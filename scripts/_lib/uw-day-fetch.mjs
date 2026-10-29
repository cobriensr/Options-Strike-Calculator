/**
 * One Unusual Whales REST GET for a ticker-day, shared by the plain-node
 * backfills (range-pos-backfill.mjs's fetchDayCandles and
 * net-prem-ticks-backfill.mjs's fetchNetPremTicks). Plain `node` can't
 * import uwFetch (api/_lib/uw-fetch.ts pulls in the Redis limiter), so this
 * is the scripts' own: same timeout, explicit User-Agent, one retry, and a
 * result that never throws.
 */

export const UW_BASE = 'https://api.unusualwhales.com/api';
/** Same per-request timeout as uwFetch (TIMEOUTS.UW_API). */
const UW_TIMEOUT_MS = 15_000;
const UW_RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noWait = async () => {};

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

async function attempt(url, apiKey, { rowField, rowLabel, userAgent }) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': userAgent,
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
      typeof row[rowField] !== 'string',
  );
  if (badIdx !== -1) {
    return malformed(`${rowLabel} ${badIdx} has no ${rowField}`);
  }
  return { kind: 'ok', rows };
}

/**
 * GET `url` with the key and `userAgent`, waiting on `waitForSlot()` (a
 * throttle; default none) before every attempt. Retries once, after 1 s, on
 * a 5xx, a 429, a network error or a timeout; a definite 4xx or a malformed
 * body is final. Every row must be an object with a string `rowField`
 * (`rowLabel` names a row in the error). Never throws:
 *   { kind: 'ok', rows } | { kind: 'empty' }
 *   | { kind: 'error', status: 'http_<n>' | 'network' | 'timeout' | 'malformed', detail }
 * A 4xx is an error, never an empty day: a date outside the plan's window
 * answers 403 (historic_data_access_missing).
 */
export async function fetchUwDayRows(
  url,
  apiKey,
  { rowField, rowLabel = 'row', userAgent, waitForSlot = noWait },
) {
  const options = { rowField, rowLabel, userAgent };
  await waitForSlot();
  let outcome = await attempt(url, apiKey, options);
  if (outcome.kind === 'error' && outcome.retryable) {
    await sleep(UW_RETRY_DELAY_MS);
    await waitForSlot();
    outcome = await attempt(url, apiKey, options);
  }
  if (outcome.kind !== 'error') return outcome;
  return { kind: 'error', status: outcome.status, detail: outcome.detail };
}
