import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// `vi.mock` replaces the module binding before chime-audio.ts imports it,
// which is required because vi.spyOn on a named ESM import doesn't
// intercept the SUT's internal call. Same approach is used by the rest
// of the codebase for module-level mocks.
vi.mock('../utils/audio-utils', () => ({
  getAudioContextCtor: vi.fn(),
}));

import { playChime } from '../components/TRACELive/hooks/chime-audio';
import { getAudioContextCtor } from '../utils/audio-utils';

const mockedGetCtor = getAudioContextCtor as unknown as Mock;

// ============================================================
// FACTORIES
// ============================================================

function makeMockAudioContext() {
  // Model real WebAudio chaining: osc.connect(gain) returns gain so the
  // SUT's `osc.connect(gain).connect(ctx.destination)` actually calls
  // gain.connect(destination), not osc.connect twice.
  const gain = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  };
  const osc = {
    type: '',
    frequency: { value: 0 },
    connect: vi.fn(() => gain),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as null | (() => void),
  };
  const close = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    currentTime: 0,
    destination: {} as unknown,
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
    close,
  };
  return { ctx, osc, gain };
}

// ============================================================
// playChime
// ============================================================

describe('playChime', () => {
  beforeEach(() => {
    mockedGetCtor.mockReset();
  });

  it('returns silently when AudioContext is unavailable', () => {
    mockedGetCtor.mockReturnValue(undefined);
    expect(() => playChime()).not.toThrow();
  });

  it('configures an 880 Hz sine oscillator with a 0.5s envelope', () => {
    const { ctx, osc, gain } = makeMockAudioContext();
    // Use a plain class — new vi.fn() does not honor the implementation's
    // return value as a constructor result.
    class MockCtor {
      constructor() {
        return ctx;
      }
    }
    mockedGetCtor.mockReturnValue(MockCtor as unknown as typeof AudioContext);

    playChime();

    expect(osc.type).toBe('sine');
    expect(osc.frequency.value).toBe(880);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.18, 0);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      0.001,
      0.5,
    );
    expect(osc.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
    expect(osc.start).toHaveBeenCalled();
    expect(osc.stop).toHaveBeenCalledWith(0.5);
  });

  it('closes the AudioContext when the tone ends', async () => {
    const { ctx, osc } = makeMockAudioContext();
    class MockCtor {
      constructor() {
        return ctx;
      }
    }
    mockedGetCtor.mockReturnValue(MockCtor as unknown as typeof AudioContext);

    playChime();
    expect(osc.onended).toBeInstanceOf(Function);
    osc.onended?.();
    // Give the resolved close() promise a tick to settle without throwing.
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('swallows errors thrown during AudioContext construction', () => {
    class ThrowingCtor {
      constructor() {
        throw new Error('autoplay denied');
      }
    }
    mockedGetCtor.mockReturnValue(
      ThrowingCtor as unknown as typeof AudioContext,
    );
    expect(() => playChime()).not.toThrow();
  });

  it('swallows ctx.close() rejection when the tone ends', async () => {
    const { ctx, osc } = makeMockAudioContext();
    ctx.close.mockRejectedValueOnce(new Error('teardown'));
    class MockCtor {
      constructor() {
        return ctx;
      }
    }
    mockedGetCtor.mockReturnValue(MockCtor as unknown as typeof AudioContext);

    playChime();
    // Should not throw even though close() rejects.
    expect(() => osc.onended?.()).not.toThrow();
    await Promise.resolve();
    expect(ctx.close).toHaveBeenCalledOnce();
  });
});
