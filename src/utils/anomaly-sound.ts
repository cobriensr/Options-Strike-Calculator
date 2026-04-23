/**
 * Anomaly chime utility — plays a short sound when a new IV anomaly surfaces.
 *
 * Honors a `localStorage['anomalySoundEnabled']` flag (default: true) so the
 * owner can silence the chime without removing the banner. Throttled to at
 * most one play per {@link SOUND_THROTTLE_MS} so a burst of simultaneous
 * anomalies doesn't turn into an audio spam stream.
 *
 * All calls are try/caught — blocked autoplay, a missing sound file, and an
 * inaccessible `localStorage` are all silent no-ops. Alerting must never
 * break the render path.
 *
 * **Asset note**: the chime lives at `public/sounds/anomaly-chime.mp3`.
 * The binary is NOT yet committed — feature ships with a no-op sound until
 * a short (~0.5s) royalty-free chime is dropped into that path. Banner +
 * detection pipeline work regardless.
 */

const STORAGE_KEY = 'anomalySoundEnabled';
/** Minimum ms between two consecutive plays. */
export const SOUND_THROTTLE_MS = 3_000;
/** Static path served from the Vite `public/` directory. */
export const CHIME_URL = '/sounds/anomaly-chime.mp3';

let lastPlayMs = 0;

/**
 * Reset internal state. Intended for use in tests — production code should
 * never need to call this.
 */
export function __resetAnomalySoundForTests(): void {
  lastPlayMs = 0;
}

/**
 * Read the localStorage flag. Missing key → enabled (true).
 * Any error (private mode, SecurityError) → enabled (fail-open).
 */
export function isAnomalySoundEnabled(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw == null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

/**
 * Toggle persistence — exposed so a settings UI (future) can flip the flag
 * without reimplementing the storage contract.
 */
export function setAnomalySoundEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Private browsing / storage disabled — accept silent failure.
  }
}

/**
 * Play the chime if enabled and not within the throttle window.
 *
 * Returns `'played'` on success, `'throttled'` if the previous play was
 * too recent, `'disabled'` if the storage flag is off, and `'error'` for
 * any runtime exception (blocked autoplay, missing asset, etc.). The
 * return is purely observational for tests — callers should never branch
 * on it; alerting is best-effort by design.
 */
export function playAnomalyChime(): 'played' | 'throttled' | 'disabled' {
  if (!isAnomalySoundEnabled()) return 'disabled';

  const now = Date.now();
  if (now - lastPlayMs < SOUND_THROTTLE_MS) return 'throttled';
  lastPlayMs = now;

  try {
    if (typeof Audio === 'undefined') return 'played';
    const audio = new Audio(CHIME_URL);
    audio.volume = 0.4;
    const maybePromise = audio.play();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      // Swallow autoplay rejections — some browsers disallow sound before
      // the user has interacted with the page. Not worth surfacing.
      maybePromise.catch(() => {});
    }
  } catch {
    // Construction failure (Audio constructor unavailable, network issue
    // on asset fetch) — ignore.
  }
  return 'played';
}
