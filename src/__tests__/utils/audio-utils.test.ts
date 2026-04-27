import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAudioContextCtor } from '../../utils/audio-utils';

describe('getAudioContextCtor', () => {
  let originalAudioContext: unknown;
  let originalWebkitAudioContext: unknown;

  beforeEach(() => {
    originalAudioContext = (globalThis as { AudioContext?: unknown })
      .AudioContext;
    originalWebkitAudioContext = (
      globalThis as { webkitAudioContext?: unknown }
    ).webkitAudioContext;
  });

  afterEach(() => {
    if (originalAudioContext === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
      (globalThis as { AudioContext?: unknown }).AudioContext =
        originalAudioContext;
    }
    if (originalWebkitAudioContext === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { webkitAudioContext?: unknown })
        .webkitAudioContext;
    } else {
      (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext =
        originalWebkitAudioContext;
    }
  });

  it('returns the standard AudioContext when present', () => {
    const stub = vi.fn();
    vi.stubGlobal('AudioContext', stub);
    expect(getAudioContextCtor()).toBe(stub);
    vi.unstubAllGlobals();
  });

  it('falls back to webkitAudioContext when AudioContext is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    const webkit = vi.fn();
    (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext =
      webkit;
    expect(getAudioContextCtor()).toBe(webkit);
  });

  it('prefers AudioContext over webkitAudioContext when both exist', () => {
    const std = vi.fn();
    const webkit = vi.fn();
    vi.stubGlobal('AudioContext', std);
    (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext =
      webkit;
    expect(getAudioContextCtor()).toBe(std);
    vi.unstubAllGlobals();
  });

  it('returns undefined when neither is available', () => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext;
    expect(getAudioContextCtor()).toBeUndefined();
  });
});
