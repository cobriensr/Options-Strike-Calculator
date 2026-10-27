import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleStaleChunk,
  isChunkLoadError,
  promptReloadOnStaleChunk,
} from '../utils/handle-stale-chunk';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockReload(): ReturnType<typeof vi.fn> {
  const reloadSpy = vi.fn();
  vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
    ...globalThis.location,
    reload: reloadSpy,
  } as unknown as Location);
  return reloadSpy;
}

// The message each browser (or Vite's preload helper) raises when a lazily
// loaded chunk can't be fetched, and look-alikes that are not chunk errors.
const CHUNK_ERRORS: Array<[string, Error]> = [
  [
    'Chrome',
    new TypeError('Failed to fetch dynamically imported module: /x.js'),
  ],
  [
    'Firefox',
    new TypeError('error loading dynamically imported module: /x.js'),
  ],
  ['Safari', new TypeError('Importing a module script failed.')],
  [
    "Vite's CSS preload (a plain Error)",
    new Error('Unable to preload CSS for /assets/x.css'),
  ],
];

const NON_CHUNK_ERRORS: Array<[string, unknown]> = [
  ["a bare 'Failed to fetch' (offline/CORS)", new TypeError('Failed to fetch')],
  ['a module-fetch look-alike', new TypeError('error during fetch for module')],
  ['an unrelated Error', new Error('some unrelated error')],
  [
    'a non-Error carrying a chunk message',
    'Failed to fetch dynamically imported module: /x.js',
  ],
];

describe('isChunkLoadError', () => {
  it.each(CHUNK_ERRORS)('matches the %s chunk-load error', (_label, err) => {
    expect(isChunkLoadError(err)).toBe(true);
  });

  it.each(NON_CHUNK_ERRORS)('does not match %s', (_label, err) => {
    expect(isChunkLoadError(err)).toBe(false);
  });
});

describe('promptReloadOnStaleChunk', () => {
  it.each(CHUNK_ERRORS)(
    'prompts and reloads on the %s error when online',
    (_label, err) => {
      const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
      const reloadSpy = mockReload();
      expect(promptReloadOnStaleChunk(err, 'Reload?')).toBe(true);
      expect(confirmSpy).toHaveBeenCalledWith('Reload?');
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(NON_CHUNK_ERRORS)('does not prompt on %s', (_label, err) => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = mockReload();
    expect(promptReloadOnStaleChunk(err, 'Reload?')).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('does not prompt on a chunk-load error while the browser is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = mockReload();
    const err = new TypeError(
      'Failed to fetch dynamically imported module: /x.js',
    );
    expect(promptReloadOnStaleChunk(err, 'Reload?')).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('still prompts when the browser does not report navigator.onLine', () => {
    // Only an explicit `false` means offline; jsdom's default `true` alone
    // wouldn't catch a falsy check that also skips `undefined`.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(
      undefined as unknown as boolean,
    );
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = mockReload();
    const err = new TypeError(
      'Failed to fetch dynamically imported module: /x.js',
    );
    expect(promptReloadOnStaleChunk(err, 'Reload?')).toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith('Reload?');
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('does not reload when the user declines the prompt', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const reloadSpy = mockReload();
    const err = new TypeError('Importing a module script failed.');
    expect(promptReloadOnStaleChunk(err, 'Reload?')).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe('handleStaleChunk', () => {
  it('rethrows a non-chunk error without prompting', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const err = new Error('some unrelated error');
    expect(() => handleStaleChunk(err)).toThrow('some unrelated error');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('prompts, reloads and rethrows on a chunk-load error when confirmed', () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const reloadSpy = mockReload();
    const err = new TypeError('Importing a module script failed.');
    expect(() => handleStaleChunk(err)).toThrow(err);
    expect(confirmSpy).toHaveBeenCalledWith(
      'A new version is available. Reload now?',
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("rethrows a bare 'Failed to fetch' without prompting", () => {
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const err = new TypeError('Failed to fetch');
    expect(() => handleStaleChunk(err)).toThrow(err);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
