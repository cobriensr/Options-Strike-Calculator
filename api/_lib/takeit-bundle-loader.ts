/**
 * Take-It bundle loader — fetches and caches the trained model JSON from
 * Vercel Blob with version-aware refresh + fail-open stale-cache semantics.
 *
 * Spec: docs/superpowers/specs/takeit-phase3-production-scoring-2026-05-16.md
 *
 * Layout in Blob (private store):
 *   takeit/latest.json          — manifest: {"lottery": "...v2026-05-23.json", "silentboom": "..."}
 *   takeit/{at}_classifier_v{ISO_DATE}.json  — immutable bundle, ~3.5MB
 *
 * Resolution path on every getBundle() call:
 *   1. If a fresh bundle is in module-scope cache (TTL not expired), return it.
 *   2. Else read the manifest to discover the current version's URL.
 *   3. If the URL matches the cached bundle's `version`, refresh the TTL and
 *      return the cached bundle (Blob fetch avoided).
 *   4. Else fetch the new bundle, schema-check, replace the cache.
 *
 * Failure modes (spec resolved decision #3):
 *   - Manifest fetch fails → keep the stale cached bundle, capture Sentry warn.
 *     If no cached bundle exists, return null → caller writes
 *     `takeit_prob = NULL`; the heuristic score still lands.
 *   - Bundle fetch fails → same as above.
 *   - Schema check fails (`xgb_json_schema` not in supported set) → THROW.
 *     Silent miscompute is worse than visibly stuck.
 */

import { list } from '@vercel/blob';

import { Sentry } from './sentry.js';
import {
  assertBundleCompat,
  BundleSchemaError,
  type TakeitBundle,
} from './takeit-score.js';

const BUNDLE_REFRESH_TTL_MS = 15 * 60 * 1000;
const MANIFEST_PATH = 'takeit/latest.json';

const BUNDLE_FETCH_MAX_RETRIES = 2;
const BUNDLE_FETCH_BACKOFFS_MS = [200, 800];

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BUNDLE_FETCH_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Schema errors are deterministic — retrying won't fix them.
      // Re-throw immediately so the caller's fail-closed path runs.
      // Match on `.name` so the check survives any module-level
      // class-identity surprises that `instanceof` is sensitive to
      // (same defensive pattern as the catch block in getBundle).
      const isSchemaErr =
        err instanceof BundleSchemaError ||
        (err instanceof Error && err.name === 'BundleSchemaError');
      if (isSchemaErr) throw err;

      lastErr = err;
      if (attempt >= BUNDLE_FETCH_MAX_RETRIES) break;
      const delay = BUNDLE_FETCH_BACKOFFS_MS[attempt] ?? 1000;
      Sentry.captureMessage(
        `takeit-bundle: ${label} attempt ${attempt + 1} failed, retrying`,
        {
          level: 'info',
          tags: { 'takeit.bundle.retry': String(attempt + 1) },
          extra: { error: String(err) },
        },
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Private Vercel Blob stores: neither `entry.url` nor `entry.downloadUrl`
// is self-signed — both require a bearer token. The `?download=1` query
// param on downloadUrl only forces Content-Disposition; it does NOT auth.
// (Verified 2026-05-20 via direct probe — list() succeeds with the token
// but fetch() of either URL 403s without an Authorization header.)
function blobAuthHeaders(): HeadersInit {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not set');
  return { Authorization: `Bearer ${token}` };
}

export type AlertType = 'lottery' | 'silentboom';

interface ManifestPayload {
  lottery: string;
  silentboom: string;
}

interface CacheEntry {
  bundle: TakeitBundle;
  fetchedAt: number;
}

const CACHE: Partial<Record<AlertType, CacheEntry>> = {};

// NOT a type predicate: when this returns false, entry can still be a defined
// but stale CacheEntry. A predicate like `entry is CacheEntry` would falsely
// narrow `cached` to `undefined` after the early-return, breaking the
// stale-fallback path.
function isFresh(entry: CacheEntry | undefined): boolean {
  return (
    entry !== undefined && Date.now() - entry.fetchedAt < BUNDLE_REFRESH_TTL_MS
  );
}

/**
 * Fetch the manifest JSON from Vercel Blob.
 *
 * The manifest is the single editable pointer to whichever versions are
 * currently in production; rolling back is one Blob upload.
 */
async function fetchManifest(): Promise<ManifestPayload> {
  const { blobs } = await list({ prefix: MANIFEST_PATH });
  const entry = blobs.find((b) => b.pathname === MANIFEST_PATH);
  if (!entry) {
    throw new Error(`take-it manifest missing at ${MANIFEST_PATH}`);
  }
  const res = await fetch(entry.downloadUrl, { headers: blobAuthHeaders() });
  if (!res.ok) {
    throw new Error(
      `take-it manifest fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ManifestPayload;
}

async function fetchBundleByPath(blobPath: string): Promise<TakeitBundle> {
  const { blobs } = await list({ prefix: blobPath });
  const entry = blobs.find((b) => b.pathname === blobPath);
  if (!entry) {
    throw new Error(`take-it bundle missing at ${blobPath}`);
  }
  const res = await fetch(entry.downloadUrl, { headers: blobAuthHeaders() });
  if (!res.ok) {
    throw new Error(
      `take-it bundle fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  const bundle = (await res.json()) as TakeitBundle;
  assertBundleCompat(bundle); // throws BundleSchemaError if version mismatch
  return bundle;
}

/**
 * Return the current bundle for `alertType`, or `null` if no bundle is
 * available and none is cached (fail-open path).
 *
 * Throws BundleSchemaError when a freshly fetched bundle declares an
 * unsupported xgb_json_schema — that's the only fail-closed condition.
 */
export async function getBundle(
  alertType: AlertType,
): Promise<TakeitBundle | null> {
  const cached: CacheEntry | undefined = CACHE[alertType];
  if (cached !== undefined && isFresh(cached)) return cached.bundle;
  const fallback: TakeitBundle | null = cached ? cached.bundle : null;

  let manifest: ManifestPayload;
  try {
    manifest = await withRetry('fetchManifest', () => fetchManifest());
  } catch (err) {
    Sentry.captureMessage('takeit.bundle.manifest_fetch_failed', {
      level: 'warning',
      extra: { error: (err as Error).message, alertType },
    });
    return fallback;
  }

  const targetPath = manifest[alertType];
  if (!targetPath) {
    Sentry.captureMessage('takeit.bundle.manifest_missing_alert_type', {
      level: 'warning',
      extra: { alertType, manifestKeys: Object.keys(manifest) },
    });
    return fallback;
  }

  // Skip the heavy bundle fetch if the manifest still points to the cached
  // version — only the manifest fetch (~hundreds of bytes) cost was paid.
  if (
    cached &&
    pathnameForVersion(alertType, cached.bundle.version) === targetPath
  ) {
    CACHE[alertType] = { bundle: cached.bundle, fetchedAt: Date.now() };
    return cached.bundle;
  }

  try {
    const bundle = await withRetry(`fetchBundle:${alertType}`, () =>
      fetchBundleByPath(targetPath),
    );
    CACHE[alertType] = { bundle, fetchedAt: Date.now() };
    return bundle;
  } catch (err) {
    // Fail-closed for schema mismatch — silent miscompute is worse than
    // visibly stuck. Match on `.name` so the check survives any module-level
    // class-identity surprises that `instanceof` is sensitive to.
    const isSchemaErr =
      err instanceof BundleSchemaError ||
      (err instanceof Error && err.name === 'BundleSchemaError');
    if (isSchemaErr) {
      Sentry.captureException(err, { extra: { alertType, targetPath } });
      throw err;
    }
    Sentry.captureException(err as Error, { extra: { alertType, targetPath } });
    return fallback;
  }
}

/** Pathname format: `takeit/{alertType}_classifier_{version}.json` */
function pathnameForVersion(alertType: AlertType, version: string): string {
  return `takeit/${alertType}_classifier_${version}.json`;
}

/** Test-only escape hatch for clearing the in-process cache. */
export function _resetBundleCacheForTests(): void {
  delete CACHE.lottery;
  delete CACHE.silentboom;
}
