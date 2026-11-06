// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module per test, so the warn-once flag starts unset. */
async function load() {
  vi.resetModules();
  return import('./sidecar-headers.mjs');
}

describe('sidecarArchiveHeaders', () => {
  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the bearer when SIDECAR_TAKEIT_SECRET is set', async () => {
    vi.stubEnv('SIDECAR_TAKEIT_SECRET', 's3cret');
    const { sidecarArchiveHeaders } = await load();

    expect(sidecarArchiveHeaders()).toEqual({
      Authorization: 'Bearer s3cret',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns no header and warns once when SIDECAR_TAKEIT_SECRET is unset', async () => {
    vi.stubEnv('SIDECAR_TAKEIT_SECRET', '');
    const { sidecarArchiveHeaders } = await load();

    expect(sidecarArchiveHeaders()).toEqual({});
    expect(sidecarArchiveHeaders()).toEqual({});
    expect(sidecarArchiveHeaders()).toEqual({});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SIDECAR_TAKEIT_SECRET');
  });
});
