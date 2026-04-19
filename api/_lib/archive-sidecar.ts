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
