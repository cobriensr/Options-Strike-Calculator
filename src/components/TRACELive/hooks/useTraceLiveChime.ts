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
 * The actual WebAudio synthesis lives in `./chime-audio.ts` so tests
 * can `vi.spyOn` the named import to verify the hook fires it correctly
 * without depending on JSDOM's effect-flush + WebAudio availability.
 *
 * Silent-first-capture is intentional: when the page first loads with
 * an existing latest capture, `previousCapturedAtRef === null` is set
 * to that capture and we DO NOT chime — the user is seeing data that
 * was already there, not a freshly arrived tick. The next REAL new
 * capture will then fire the chime as intended.
 */

import { useEffect, useRef } from 'react';
import { playChime } from './chime-audio.js';

const DEBOUNCE_MS = 1000;

export function useTraceLiveChime(
  capturedAt: string | null,
  enabled: boolean,
): void {
  const lastFiredAtRef = useRef<number>(0);
  const previousCapturedAtRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!capturedAt) return;
    // Skip first observation — don't chime on existing-data load.
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
