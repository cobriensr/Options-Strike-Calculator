import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleStaleChunk } from '../utils/handle-stale-chunk';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleStaleChunk', () => {
  it('rethrows a non-chunk error without prompting', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const err = new Error('some unrelated error');
    expect(() => handleStaleChunk(err)).toThrow('some unrelated error');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('prompts and reloads on a chunk-load TypeError when confirmed', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload: reloadSpy,
    } as unknown as Location);
    const err = new TypeError(
      'Failed to fetch dynamically imported module: /x.js',
    );
    expect(() => handleStaleChunk(err)).toThrow();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the user declines the prompt', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const reloadSpy = vi.fn();
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload: reloadSpy,
    } as unknown as Location);
    const err = new TypeError('error during fetch for module');
    expect(() => handleStaleChunk(err)).toThrow();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
