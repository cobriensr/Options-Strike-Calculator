/**
 * The message each browser raises when a lazy `import()` can't fetch its
 * chunk, which after a deploy means the old hashed file is gone:
 * - Chrome:  "Failed to fetch dynamically imported module: <url>"
 * - Firefox: "error loading dynamically imported module: <url>"
 * - Safari:  "Importing a module script failed."
 * Vite's preload helper adds a plain `Error('Unable to preload CSS for <url>')`
 * when a chunk's stylesheet fails. A bare "Failed to fetch" (offline, CORS)
 * is deliberately not matched.
 */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(e: unknown): boolean {
  return e instanceof Error && CHUNK_LOAD_ERROR.test(e.message);
}

/**
 * Offers a reload when `err` is a chunk-load error and the browser isn't
 * known to be offline (an offline failure is not a new version). Returns
 * whether `err` was handled as a stale chunk, so callers can log the rest.
 */
export function promptReloadOnStaleChunk(
  err: unknown,
  message: string,
): boolean {
  if (!isChunkLoadError(err) || navigator.onLine === false) return false;
  if (confirm(message)) {
    globalThis.location.reload();
  }
  return true;
}

/**
 * Rejection handler for lazy `import()` calls. After a deploy, the running
 * build's lazy chunks may no longer exist, so the import rejects; prompt the
 * user to reload instead of silently failing inside Suspense. The BWBSection /
 * IronCondorSection export buttons share the same check.
 */
export function handleStaleChunk(err: unknown): never {
  promptReloadOnStaleChunk(err, 'A new version is available. Reload now?');
  throw err;
}
