/**
 * useTraceLiveChime — plays a short half-second chime each time the
 * TRACE Live dashboard receives a new capture. Debounced 1s so paired
 * captures arriving in rapid succession only fire once.
 *
 * Enabled only when:
 *   - the user is in live mode (caller's responsibility — pass enabled),
 *   - the browser allows audio playback (autoplay policy permitting),
 *   - capturedAt has actually changed from the previous render (prevents
 *     re-firing on unrelated re-renders).
 *
 * Implementation note: we don't bundle an audio file — we synthesize a
 * 0.5s tone via WebAudio so there's no asset pipeline to manage. The
 * user requested "a quick chime, real short, just maybe a half second."
 */

import { useEffect, useRef } from 'react';

const DEBOUNCE_MS = 1000;
const TONE_HZ = 880; // A5 — bright, distinct from system sounds
const TONE_DURATION_S = 0.5;

function playChime(): void {
  // AudioContext requires a user gesture in some browsers; we let it
  // throw if denied — the chime is best-effort.
  try {
    const AudioContextCtor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = TONE_HZ;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    // Quick exponential fade so the tail isn't abrupt.
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + TONE_DURATION_S,
    );
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + TONE_DURATION_S);
    osc.onended = () => {
      ctx.close().catch(() => {
        /* close() can reject during teardown — ignore */
      });
    };
  } catch {
    /* autoplay denied / WebAudio unavailable — silent */
  }
}

export function useTraceLiveChime(
  capturedAt: string | null,
  enabled: boolean,
): void {
  const lastFiredAtRef = useRef<number>(0);
  const previousCapturedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!capturedAt) return;
    // Skip first render — don't chime on initial load.
    if (previousCapturedAtRef.current === null) {
      previousCapturedAtRef.current = capturedAt;
      return;
    }
    if (capturedAt === previousCapturedAtRef.current) return;

    previousCapturedAtRef.current = capturedAt;

    const now = Date.now();
    if (now - lastFiredAtRef.current < DEBOUNCE_MS) return;
    lastFiredAtRef.current = now;
    playChime();
  }, [capturedAt, enabled]);
}
