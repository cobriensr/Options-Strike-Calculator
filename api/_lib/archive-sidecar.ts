/**
 * Thin client for the Railway sidecar's /archive/* read endpoints.
 *
 * The sidecar owns the DBN→Parquet archive on its persistent volume
 * and exposes DuckDB-backed queries as HTTP. This module is the
 * Vercel-side wrapper that Vercel cron jobs + the analyze endpoint
 * use to reach it.
 *
 * Policy:
 *   - Every call has a hard timeout (sidecar should answer in < 500ms
 *     for most queries; we cap at 2s to protect the analyze latency).
 *   - Every function returns `null` on any error rather than throwing.
 *     The analyze endpoint treats archive context as additive — a
 *     failed fetch should degrade the prompt, not break the call.
 *   - Errors go to logger.warn, not Sentry. A sidecar outage is worth
 *     knowing about but it's not an application bug.
 *
 * Env:
 *   SIDECAR_URL — required. No default; absence disables archive
 *                 context gracefully.
 */

import logger from './logger.js';

const DEFAULT_TIMEOUT_MS = 2000;

function sidecarUrl(): string | null {
  const url = process.env.SIDECAR_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

async function getJson<T>(
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
  const base = sidecarUrl();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    if (!res.ok) {
      logger.warn(
        { path, status: res.status },
        'Sidecar archive fetch returned non-2xx',
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path }, 'Sidecar archive fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the canonical deterministic text summary for a single trading
 * day from the sidecar. Used as input to the embedding pipeline.
 *
 * Returns null when SIDECAR_URL is unset, the sidecar is unreachable,
 * the date has no ES bars in the archive (404), or any other failure.
 * Callers should treat null as "no archive context available" and
 * proceed without it.
 */
export async function fetchDaySummary(dateIso: string): Promise<string | null> {
  const body = await getJson<{ date: string; summary: string }>(
    `/archive/day-summary?date=${encodeURIComponent(dateIso)}`,
  );
  return body?.summary ?? null;
}

/**
 * Fetch the 60-dim engineered feature vector for a single trading day.
 * Used by the Phase C feature-embedding backend.
 *
 * Returns null on any sidecar / network failure. Callers should treat
 * null as "no feature-based analog context available" and either fall
 * back to the text-embedding backend or skip the block entirely.
 */
export async function fetchDayFeatures(
  dateIso: string,
): Promise<number[] | null> {
  const body = await getJson<{ date: string; dim: number; vector: number[] }>(
    `/archive/day-features?date=${encodeURIComponent(dateIso)}`,
  );
  if (!body || !Array.isArray(body.vector)) return null;
  return body.vector;
}

/**
 * Per-day microstructure summary from the TBBO archive (Phase 4b).
 *
 * Minimum-viable shape — OFI means at 5m / 15m / 1h plus metadata.
 * See `sidecar/src/archive_query.py::tbbo_day_microstructure` for the
 * authoritative schema.
 */
export interface TbboDayMicrostructure {
  date: string;
  symbol: 'ES' | 'NQ';
  front_month_contract: string;
  trade_count: number;
  ofi_5m_mean: number | null;
  ofi_15m_mean: number | null;
  ofi_1h_mean: number | null;
}

/** Historical percentile rank of a given OFI value. */
export interface TbboOfiPercentile {
  symbol: 'ES' | 'NQ';
  window: '5m' | '15m' | '1h';
  current_value: number;
  percentile: number;
  mean: number;
  std: number;
  count: number;
}

/**
 * Fetch the per-day microstructure summary for `(date, symbol)` from
 * the sidecar's TBBO archive.
 *
 * Returns null on any failure (sidecar unreachable, date missing from
 * archive, etc.). The analyze endpoint treats this as additive context.
 */
export async function fetchTbboDayMicrostructure(
  dateIso: string,
  symbol: 'ES' | 'NQ',
): Promise<TbboDayMicrostructure | null> {
  const qs = `date=${encodeURIComponent(dateIso)}&symbol=${encodeURIComponent(symbol)}`;
  const body = await getJson<TbboDayMicrostructure>(
    `/archive/tbbo-day-microstructure?${qs}`,
  );
  return body ?? null;
}

/**
 * Fetch the historical percentile rank of an OFI `value` for `symbol`
 * at `window`, against the last ~1y of archive data.
 *
 * Used by the analyze endpoint to enrich the Phase 5a live OFI signal
 * with "today's 1h OFI is in the Nth percentile of the last 252 days"
 * historical context. Null on any failure — the formatter drops the
 * Historical rank line cleanly.
 */
export async function fetchTbboOfiPercentile(
  symbol: 'ES' | 'NQ',
  value: number,
  window: '5m' | '15m' | '1h' = '1h',
): Promise<TbboOfiPercentile | null> {
  if (!Number.isFinite(value)) return null;
  const qs =
    `symbol=${encodeURIComponent(symbol)}` +
    `&value=${encodeURIComponent(String(value))}` +
    `&window=${encodeURIComponent(window)}`;
  const body = await getJson<TbboOfiPercentile>(
    `/archive/tbbo-ofi-percentile?${qs}`,
  );
  return body ?? null;
}
