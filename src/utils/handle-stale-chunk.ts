/**
 * Rejection handler for lazy `import()` calls. After a deploy, a stale
 * service-worker-cached chunk throws on import; prompt the user to reload
 * instead of silently failing inside Suspense. Matches the pattern in the
 * BWBSection / IronCondorSection export buttons.
 */
export function handleStaleChunk(err: unknown): never {
  const isChunkError =
    err instanceof TypeError &&
    /dynamically imported module|fetch/i.test(err.message);
  if (isChunkError) {
    if (confirm('A new version is available. Reload now?')) {
      globalThis.location.reload();
    }
  }
  throw err;
}
