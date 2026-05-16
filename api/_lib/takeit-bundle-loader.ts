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
  const res = await fetch(entry.url);
  if (!res.ok) {
    throw new Error(
      `take-it manifest fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ManifestPayload;
}

async function fetchBundleByPath(blobPath: string): Promise<TakeitBundle> {
  // The manifest stores the relative pathname; list() turns it into a
  // signed URL we can fetch.
  const { blobs } = await list({ prefix: blobPath });
  const entry = blobs.find((b) => b.pathname === blobPath);
  if (!entry) {
    throw new Error(`take-it bundle missing at ${blobPath}`);
  }
  const res = await fetch(entry.url);
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
    manifest = await fetchManifest();
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
    const bundle = await fetchBundleByPath(targetPath);
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
