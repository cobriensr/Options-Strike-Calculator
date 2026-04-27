/**
 * Cross-environment AudioContext lookup.
 *
 * Browsers expose the standard `AudioContext`. Older Safari (and any
 * webview built on it) only expose the prefixed `webkitAudioContext`.
 * Tests using `vi.stubGlobal('AudioContext', ...)` bind to `globalThis`
 * rather than `window`, so we look up via globalThis to cover both.
 *
 * Returns the constructor or `undefined` when WebAudio is unavailable
 * (e.g. autoplay denied before user gesture, or a runtime without
 * audio support). Callers should bail silently — a missed chime is
 * never a real failure mode.
 */
type AudioContextCtor = typeof AudioContext;

export function getAudioContextCtor(): AudioContextCtor | undefined {
  return (
    (globalThis as unknown as { AudioContext?: AudioContextCtor })
      .AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext
  );
}
