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
 *     `takeit_prob = NULL`; the heuristic score still lands. The caller's
 *     `onUnavailable` hears why (BundleUnavailable), so a detect cron can
 *     report its run 'partial' or 'error' instead of 'success'.
 *   - Bundle fetch fails → same as above.
 *   - assertBundleCompat rejects the bundle → THROW. It checks the Zod
 *     structure (including equal per-node tree array lengths), that
 *     `xgb_json_schema` is in the supported set, and that
 *     `isotonic.out_of_bounds` is 'clip'. Silent miscompute is worse than
 *     visibly stuck. Separately, the scorer throws per row on a non-finite
 *     logit; the detect crons catch that and write a NULL probability.
 */

import {
  BlobRequestAbortedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobUnknownError,
  list,
} from '@vercel/blob';

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
function blobAuthHeaders(): Record<string, string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN not set');
  return { Authorization: `Bearer ${token}` };
}

/** A non-2xx Blob download, keeping its status for fetchFailureKind. */
class BlobDownloadError extends Error {
  readonly status: number;
  constructor(what: 'manifest' | 'bundle', res: Response) {
    super(`take-it ${what} fetch failed: ${res.status} ${res.statusText}`);
    this.name = 'BlobDownloadError';
    this.status = res.status;
  }
}

/**
 * Why getBundle has no bundle to give (none cached and the load failed),
 * for a detect cron's run status:
 *   - 'transient': Blob didn't answer through every retry (a network
 *     error, a 5xx or 429, an aborted request); the next run may load it;
 *   - 'error': a config problem every later run hits too: the manifest
 *     names no bundle for this alert type, or Blob refused the read (a 403
 *     or 404, a missing token or blob, a manifest that isn't JSON).
 */
export interface BundleUnavailable {
  reason: string;
  kind: 'transient' | 'error';
}

/**
 * Whether a manifest or bundle read that failed through every retry is
 * worth waiting out. Unrecognized failures count as config problems
 * ('error'), so a new failure mode goes red rather than quiet.
 */
function fetchFailureKind(err: unknown): BundleUnavailable['kind'] {
  if (err instanceof BlobDownloadError) {
    return err.status >= 500 || err.status === 429 ? 'transient' : 'error';
  }
  const unreachable =
    // fetch() rejects with a TypeError when no answer came back: 'fetch
    // failed', or 'terminated' for a body cut off mid-read (undici's two
    // messages, as in the SDK's own isNetworkError). Matched by message so
    // a TypeError from a code bug, or from the SDK choking on a changed
    // list() response (response.blobs.map), stays an 'error'.
    (err instanceof TypeError &&
      (err.message === 'fetch failed' || err.message === 'terminated')) ||
    // The SDK retries BlobServiceNotAvailable itself; list() throws it once
    // those retries run out on a Blob outage. BlobServiceRateLimited is not
    // retried by the SDK, only by withRetry above.
    err instanceof BlobServiceNotAvailable ||
    err instanceof BlobServiceRateLimited ||
    // The SDK also uses BlobUnknownError for a 'not_allowed' answer, a
    // permission problem it does not retry. That, too, counts as transient
    // here, because the class can't tell it from a Blob outage: a
    // persistent permission problem shows as 'partial' plus a Sentry
    // warning on every run, not as a red check-in.
    err instanceof BlobUnknownError ||
    err instanceof BlobRequestAbortedError;
  return unreachable ? 'transient' : 'error';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  if (!res.ok) throw new BlobDownloadError('manifest', res);
  return (await res.json()) as ManifestPayload;
}

async function fetchBundleByPath(blobPath: string): Promise<TakeitBundle> {
  const { blobs } = await list({ prefix: blobPath });
  const entry = blobs.find((b) => b.pathname === blobPath);
  if (!entry) {
    throw new Error(`take-it bundle missing at ${blobPath}`);
  }
  const res = await fetch(entry.downloadUrl, { headers: blobAuthHeaders() });
  if (!res.ok) throw new BlobDownloadError('bundle', res);
  const bundle = (await res.json()) as TakeitBundle;
  assertBundleCompat(bundle); // throws BundleSchemaError on any failed check
  return bundle;
}

/**
 * Return the current bundle for `alertType`, or `null` if no bundle is
 * available and none is cached (fail-open path).
 *
 * Throws BundleSchemaError when a freshly fetched bundle fails
 * assertBundleCompat: bad Zod structure (including unequal per-node tree
 * array lengths), an unsupported xgb_json_schema, or an
 * isotonic.out_of_bounds other than 'clip'. Those are the only fail-closed
 * conditions here; the scorer's non-finite-logit guard fails per row, not
 * per bundle.
 *
 * `onUnavailable` is called once, just before getBundle resolves null,
 * with why. Not when it serves a stale bundle in place of a failed refresh
 * (scoring still works), and not for a BundleSchemaError (thrown instead).
 */
export async function getBundle(
  alertType: AlertType,
  onUnavailable?: (unavailable: BundleUnavailable) => void,
): Promise<TakeitBundle | null> {
  const cached: CacheEntry | undefined = CACHE[alertType];
  if (cached !== undefined && isFresh(cached)) return cached.bundle;
  const fallback: TakeitBundle | null = cached ? cached.bundle : null;
  // Every failed load returns through here: the stale bundle if there is
  // one, else null with the reason passed on.
  const giveUp = (unavailable: BundleUnavailable): TakeitBundle | null => {
    if (fallback == null) onUnavailable?.(unavailable);
    return fallback;
  };

  let manifest: ManifestPayload;
  try {
    manifest = await withRetry('fetchManifest', () => fetchManifest());
  } catch (err) {
    Sentry.captureMessage('takeit.bundle.manifest_fetch_failed', {
      level: 'warning',
      extra: { error: (err as Error).message, alertType },
    });
    return giveUp({
      reason: `Take-It manifest unavailable: ${errorMessage(err)}`,
      kind: fetchFailureKind(err),
    });
  }

  const targetPath = manifest[alertType];
  if (!targetPath) {
    Sentry.captureMessage('takeit.bundle.manifest_missing_alert_type', {
      level: 'warning',
      extra: { alertType, manifestKeys: Object.keys(manifest) },
    });
    return giveUp({
      reason: `Take-It manifest names no ${alertType} bundle`,
      kind: 'error',
    });
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
    return giveUp({
      reason: `Take-It bundle ${targetPath} unavailable: ${errorMessage(err)}`,
      kind: fetchFailureKind(err),
    });
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
