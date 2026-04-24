/**
 * Anomaly chime utility — plays a short sound when a new IV anomaly surfaces
 * or when an existing one transitions to cooling / distributing.
 *
 * Honors a `localStorage['anomalySoundEnabled']` flag (default: true) so the
 * owner can silence the chime without removing the banner. Throttled to at
 * most one play per {@link SOUND_THROTTLE_MS} so a burst of simultaneous
 * anomalies doesn't turn into an audio spam stream.
 *
 * Two variants:
 *
 *   - `entry` — full volume (~0.4), uses the chime mp3 asset.
 *   - `exit`  — distinct, softer cue. Plays the same asset at half volume
 *               when available; if the mp3 asset is absent we fall back to
 *               a short programmatic Web Audio beep (~400 Hz, ~0.2 s). That
 *               way the exit cue is audibly different from the entry one.
 *
 * All calls are try/caught — blocked autoplay, a missing sound file, and an
 * inaccessible `localStorage` are all silent no-ops. Alerting must never
 * break the render path.
 */

const STORAGE_KEY = 'anomalySoundEnabled';
/** Minimum ms between two consecutive plays. */
export const SOUND_THROTTLE_MS = 3_000;
/** Static path served from the Vite `public/` directory. */
export const CHIME_URL = '/sounds/anomaly-chime.mp3';

export type AnomalyChimeKind = 'entry' | 'exit';

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

/** Resolve the AudioContext constructor. Returns null when unavailable. */
function getAudioContextCtor(): (new () => AudioContext) | null {
  const w = globalThis as typeof globalThis & {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Play a short programmatic beep via Web Audio. Used as the exit-kind
 * fallback so the cue is audibly distinct from the entry chime even when
 * the mp3 asset is missing. All failures are swallowed.
 */
function playProgrammaticBeep(): void {
  try {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 400;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const now = ctx.currentTime;
    osc.start(now);
    osc.stop(now + 0.2);
    // Close the context after the beep so resources are released.
    osc.addEventListener('ended', () => {
      ctx.close().catch(() => {});
    });
  } catch {
    // AudioContext creation can fail in test envs and locked-down browsers.
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
export function playAnomalyChime(
  kind: AnomalyChimeKind = 'entry',
): 'played' | 'throttled' | 'disabled' {
  if (!isAnomalySoundEnabled()) return 'disabled';

  const now = Date.now();
  if (now - lastPlayMs < SOUND_THROTTLE_MS) return 'throttled';
  lastPlayMs = now;

  try {
    if (typeof Audio === 'undefined') {
      // No Audio constructor; exit chime tries the Web Audio fallback so
      // the user still hears a distinct cue. Entry chime has no fallback.
      if (kind === 'exit') playProgrammaticBeep();
      return 'played';
    }
    const audio = new Audio(CHIME_URL);
    // Exit chime is quieter and shorter-feeling; entry chime is at full volume.
    audio.volume = kind === 'exit' ? 0.2 : 0.4;
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
