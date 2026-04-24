/**
 * Anomaly chime utility — plays a short programmatic tone when a new IV
 * anomaly surfaces or when an existing one transitions to cooling /
 * distributing. Uses the Web Audio API with no external audio assets.
 *
 * Honors a `localStorage['anomalySoundEnabled']` flag (default: true) so the
 * owner can silence the chime without removing the banner. Throttled to at
 * most one play per {@link SOUND_THROTTLE_MS} so a burst of simultaneous
 * anomalies doesn't turn into an audio spam stream.
 *
 * Two variants with audibly distinct tones:
 *
 *   - `entry` — 660 Hz, 250ms, volume 0.4. Brighter, more attention-grabbing
 *               for a newly-detected anomaly worth looking at.
 *   - `exit`  — 400 Hz, 200ms, volume 0.2. Lower, softer for the "holder
 *               exiting" transition — present but non-intrusive.
 *
 * A small attack + exponential-decay envelope shapes both tones so they
 * don't "click" on/off (clicks are annoying even at low volume).
 *
 * All calls are try/caught — blocked autoplay, missing AudioContext support,
 * and inaccessible localStorage are all silent no-ops. Alerting must never
 * break the render path.
 */

const STORAGE_KEY = 'anomalySoundEnabled';
/** Minimum ms between two consecutive plays. */
export const SOUND_THROTTLE_MS = 3_000;

export type AnomalyChimeKind = 'entry' | 'exit';

interface ChimeSpec {
  /** Tone frequency in Hz. */
  frequency: number;
  /** Duration in seconds. */
  duration: number;
  /** Peak gain (0–1). */
  volume: number;
}

const CHIME_SPECS: Record<AnomalyChimeKind, ChimeSpec> = {
  entry: { frequency: 660, duration: 0.25, volume: 0.4 },
  exit: { frequency: 400, duration: 0.2, volume: 0.2 },
};

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
 * Play a short sine-wave tone with attack + exponential-decay envelope.
 * All failures are swallowed — AudioContext creation can fail in test envs
 * and locked-down browsers, and autoplay policies may reject the start.
 */
function playTone(spec: ChimeSpec): void {
  try {
    const Ctor = getAudioContextCtor();
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = spec.frequency;

    // Envelope: 10ms attack, exponential decay to silence over duration.
    // exponentialRampToValueAtTime requires a strictly positive target, so
    // we decay toward 0.0001 (effectively silent) not 0.
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(spec.volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + spec.duration);
    // Close the context after the tone so resources are released.
    osc.addEventListener('ended', () => {
      ctx.close().catch(() => {
        // Close can reject if the context is already closed — ignore.
      });
    });
  } catch {
    // AudioContext creation / node wiring failed — ignore.
  }
}

/**
 * Play the chime if enabled and not within the throttle window.
 *
 * Returns `'played'` on success, `'throttled'` if the previous play was
 * too recent, and `'disabled'` if the storage flag is off. Errors during
 * audio setup are silently swallowed (still returns `'played'`) — the
 * return is purely observational for tests. Alerting is best-effort by
 * design; a missing AudioContext or blocked autoplay must never surface
 * as a thrown error.
 */
export function playAnomalyChime(
  kind: AnomalyChimeKind = 'entry',
): 'played' | 'throttled' | 'disabled' {
  if (!isAnomalySoundEnabled()) return 'disabled';

  const now = Date.now();
  if (now - lastPlayMs < SOUND_THROTTLE_MS) return 'throttled';
  lastPlayMs = now;

  playTone(CHIME_SPECS[kind]);
  return 'played';
}
