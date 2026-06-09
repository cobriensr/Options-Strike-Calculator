/**
 * alert-chime — shared chime-lifecycle manager for the alert-polling hooks.
 *
 * Owns a SINGLE module-scoped `activeChimes` Map so the repeating-chime
 * dedupe survives component remounts (the hooks are mounted once in the
 * SPA, but a remount must not double-ring an already-active alert).
 *
 * Each caller passes its OWN sound function (`play`) and repeat cadence
 * (`intervalMs`) so the audible behavior stays caller-specific — this
 * module only owns the setInterval lifecycle, never the tone.
 *
 * Key namespacing: callers pass a `namespace` so the two hooks
 * (`useAlertPolling` → "alert", `useIntervalBAAlerts` → "intervalBA") can
 * reuse the same numeric alert ids without one hook ever stopping the
 * other's chime. Internally a chime is keyed by `${namespace}:${id}`.
 */

/** Internal namespaced-key set. */
function chimeKey(namespace: string, id: number): string {
  return `${namespace}:${id}`;
}

/** Active chime intervals keyed by `${namespace}:${id}`. */
const activeChimes = new Map<string, ReturnType<typeof setInterval>>();

export interface StartChimeOptions {
  /** Caller namespace — prevents id collisions across hooks. */
  namespace: string;
  /** Repeat cadence in ms between chimes. */
  intervalMs: number;
  /** Caller-owned sound function. Invoked once immediately, then per interval. */
  play: () => void;
}

/**
 * Start a repeating chime for an alert. Plays immediately, then every
 * `intervalMs`. Idempotent per (namespace, id): a second call while the
 * chime is active is a no-op (no double-ring, no leaked interval).
 */
export function startChime(id: number, options: StartChimeOptions): void {
  const key = chimeKey(options.namespace, id);
  if (activeChimes.has(key)) return;
  options.play();
  const interval = setInterval(options.play, options.intervalMs);
  activeChimes.set(key, interval);
}

/**
 * Stop the repeating chime for an alert. Idempotent — calling it when no
 * chime is active (or twice in a row) is a safe no-op.
 */
export function stopChime(namespace: string, id: number): void {
  const key = chimeKey(namespace, id);
  const interval = activeChimes.get(key);
  if (interval !== undefined) {
    clearInterval(interval);
    activeChimes.delete(key);
  }
}

/**
 * Stop every chime in `ids` for the given namespace. Idempotent — ids with
 * no active chime are skipped. Used by the gate-flip / unmount cleanup.
 */
export function stopAllChimes(namespace: string, ids: Iterable<number>): void {
  for (const id of ids) stopChime(namespace, id);
}

/**
 * Reset all chime state. Test-only — production code should never need
 * this. Without it, a chime started in one test leaks across to the next
 * (the dedupe map is module-scope by design).
 */
export function __resetChimesForTests(): void {
  for (const interval of activeChimes.values()) {
    clearInterval(interval);
  }
  activeChimes.clear();
}
