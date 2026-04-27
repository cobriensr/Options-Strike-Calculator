/**
 * WebAudio-synthesized half-second chime for the TRACE Live dashboard.
 *
 * Extracted to its own module so `vi.spyOn(chimeAudio, 'playChime')` can
 * verify the hook actually triggers a chime — mocking the underlying
 * WebAudio API across React's effect-flush boundary is unreliable in
 * JSDOM, but spying on a named import is rock-solid.
 *
 * Best-effort by design: AudioContext construction can fail (autoplay
 * denied before user gesture, WebAudio unavailable). Errors are silently
 * swallowed — a missed chime is not a real failure mode.
 */

import { getAudioContextCtor } from '../../../utils/audio-utils';

const TONE_HZ = 880; // A5 — bright, distinct from system sounds
const TONE_DURATION_S = 0.5;

export function playChime(): void {
  try {
    const AudioContextCtor = getAudioContextCtor();
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
