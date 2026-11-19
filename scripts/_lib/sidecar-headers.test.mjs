// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sidecarArchiveHeaders } from './sidecar-headers.mjs';

const NOT_SET = /^SIDECAR_TAKEIT_SECRET is not set/;

describe('sidecarArchiveHeaders', () => {
  let saved;

  beforeEach(() => {
    saved = process.env.SIDECAR_TAKEIT_SECRET;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // Put back whatever the run started with (a direct delete below is not
    // tracked by vi.unstubAllEnvs).
    if (saved === undefined) {
      delete process.env.SIDECAR_TAKEIT_SECRET;
    } else {
      process.env.SIDECAR_TAKEIT_SECRET = saved;
    }
  });

  /** Make SIDECAR_TAKEIT_SECRET unset (undefined) or empty. */
  function setSecret(value) {
    if (value === undefined) {
      delete process.env.SIDECAR_TAKEIT_SECRET;
    } else {
      vi.stubEnv('SIDECAR_TAKEIT_SECRET', value);
    }
  }

  it('returns the bearer when SIDECAR_TAKEIT_SECRET is set', () => {
    vi.stubEnv('SIDECAR_TAKEIT_SECRET', 's3cret');

    expect(sidecarArchiveHeaders()).toEqual({
      Authorization: 'Bearer s3cret',
    });
  });

  it.each([[undefined], ['']])(
    'throws when SIDECAR_TAKEIT_SECRET is %j',
    (value) => {
      setSecret(value);

      expect(() => sidecarArchiveHeaders()).toThrow(NOT_SET);
      expect(() => sidecarArchiveHeaders()).toThrow(Error);
    },
  );

  it('names the sidecar archive routes in the message', () => {
    setSecret(undefined);

    expect(() => sidecarArchiveHeaders()).toThrow(/\/archive\/\*/);
  });

  it('never reaches fetch when the secret is unset', async () => {
    setSecret(undefined);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}'));

    await expect(
      (async () =>
        fetch('https://sidecar.example/archive/x', {
          headers: sidecarArchiveHeaders(),
        }))(),
    ).rejects.toThrow(NOT_SET);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
