// @vitest-environment node

/**
 * Self-tests for the production-store blocks (src/__tests__/db-guard.ts, wired
 * in src/__tests__/setup.ts): Upstash Redis, Vercel Blob and Cloudflare R2.
 * They extend the no-database guard and share its attempts log, so the
 * `afterEach` and `afterAll` checks in setup.ts also catch an attempt that a
 * best-effort wrapper swallowed. Each test that provokes an attempt discards
 * its own entries with `trackDbAttempts`, because that `afterEach` fails any
 * test that leaves one behind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Redis } from '@upstash/redis';
import * as blob from '@vercel/blob';
import * as blobClient from '@vercel/blob/client';
import { limiterRedis, redis, safeRedis } from '../_lib/redis.js';
import * as guard from '../../src/__tests__/db-guard.js';

const {
  BLOB_ERROR_CLASSES,
  BLOCKED_BLOB_CLIENT_EXPORTS,
  BLOCKED_BLOB_EXPORTS,
  PURE_BLOB_CLIENT_EXPORTS,
  PURE_BLOB_EXPORTS,
  STORE_BLOCK_MESSAGE,
  trackDbAttempts,
} = guard;
const REDIS_URL = 'https://example.invalid';
const TOKEN = 'hunter2-token';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the global @upstash/redis block', () => {
  it('rejects a command with the block message and records the attempt', async () => {
    const attempts = trackDbAttempts();
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
  });

  it('blocks a pipeline too, which goes through the same request method', async () => {
    const attempts = trackDbAttempts();
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    await expect(client.pipeline().get('k').exec()).rejects.toThrow(
      STORE_BLOCK_MESSAGE,
    );
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
  });

  it('never echoes the token', async () => {
    const attempts = trackDbAttempts();
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    const err = await client.get('k').catch((e: Error) => e);
    attempts.discard();
    expect((err as Error).message).toContain(STORE_BLOCK_MESSAGE);
    expect((err as Error).message).not.toContain('hunter2');
  });

  it.each([
    ['redis', redis],
    ['limiterRedis', limiterRedis],
  ])(
    'blocks the production singleton %s (built without env, as in tests)',
    async (_name, client) => {
      const attempts = trackDbAttempts();
      await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
      expect(attempts.made).toEqual(['redis']);
      attempts.discard();
    },
  );

  it('stays blocked when a test has replaced fetch with a stub', async () => {
    const attempts = trackDbAttempts();
    const stub = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(stub).not.toHaveBeenCalled();
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
  });

  it('stays blocked behind a call-through spy on fetch, which would reach the store', async () => {
    // archive-sidecar.test.ts and build-features-phase2.test.ts spy this way.
    const attempts = trackDbAttempts();
    const spy = vi.spyOn(globalThis, 'fetch');
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
    spy.mockRestore();
  });

  it('stays blocked behind a wrapper that delegates to the original fetch', async () => {
    const attempts = trackDbAttempts();
    const original = globalThis.fetch;
    const wrapper = vi.fn((...args: Parameters<typeof fetch>) =>
      original(...args),
    );
    vi.stubGlobal('fetch', wrapper);
    const client = new Redis({ url: REDIS_URL, token: TOKEN });
    await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(wrapper).not.toHaveBeenCalled();
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
  });

  it('stays blocked when fetch is stubbed before modules are reset and the package is imported afresh', async () => {
    const attempts = trackDbAttempts();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );
    vi.resetModules();
    const { Redis: FreshRedis } = await import('@upstash/redis');
    const client = new FreshRedis({ url: REDIS_URL, token: TOKEN });
    await expect(client.get('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    // The attempt lands in the log this file's own setup.ts afterEach reads,
    // although the fresh import re-ran the mock factory.
    expect(attempts.made).toEqual(['redis']);
    attempts.discard();
  });
});

describe('the global @aws-sdk/client-s3 block (R2)', () => {
  const config = {
    region: 'auto',
    endpoint: 'https://example.invalid',
    credentials: {
      accessKeyId: 'AKIA-test',
      secretAccessKey: 'hunter2-secret',
    },
  };

  it('rejects send() with the block message and records the attempt', async () => {
    const attempts = trackDbAttempts();
    const client = new S3Client(config);
    await expect(
      client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' })),
    ).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['s3']);
    attempts.discard();
  });

  it('blocks a read and a write alike', async () => {
    const attempts = trackDbAttempts();
    const client = new S3Client(config);
    await expect(
      client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' })),
    ).rejects.toThrow(STORE_BLOCK_MESSAGE);
    await expect(
      client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' })),
    ).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['s3', 's3']);
    attempts.discard();
  });

  it('blocks the aggregated S3 client, which extends S3Client', async () => {
    const attempts = trackDbAttempts();
    const client = new S3(config);
    await expect(client.headObject({ Bucket: 'b', Key: 'k' })).rejects.toThrow(
      STORE_BLOCK_MESSAGE,
    );
    expect(attempts.made).toEqual(['s3']);
    attempts.discard();
  });

  it('never echoes the credentials', async () => {
    const attempts = trackDbAttempts();
    const err = await new S3Client(config)
      .send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }))
      .catch((e: Error) => e);
    attempts.discard();
    expect((err as Error).message).toContain(STORE_BLOCK_MESSAGE);
    expect((err as Error).message).not.toMatch(/hunter2|AKIA-test/);
  });

  it('keeps the non-client exports the code relies on', () => {
    expect(new HeadObjectCommand({ Bucket: 'b', Key: 'k' })).toBeInstanceOf(
      HeadObjectCommand,
    );
    const err = new S3ServiceException({
      name: 'NotFound',
      $fault: 'client',
      $metadata: {},
    });
    expect(err).toBeInstanceOf(S3ServiceException);
    expect(err).toBeInstanceOf(Error);
  });

  it('blocks the production path: r2HeadObject and r2PutObject with R2 set', async () => {
    const attempts = trackDbAttempts();
    vi.stubEnv('R2_ACCESS_KEY_ID', 'AKIA-test');
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'hunter2-secret');
    vi.stubEnv('R2_ENDPOINT_URL', 'https://example.invalid');
    vi.stubEnv('R2_BUCKET_FULLTAPE', 'bucket');
    vi.resetModules();
    const { r2HeadObject, r2PutObject } = await import('../_lib/r2.js');
    await expect(r2HeadObject('k')).rejects.toThrow(STORE_BLOCK_MESSAGE);
    await expect(
      r2PutObject('k', new Uint8Array([1]), {
        contentType: 'text/plain',
        metadata: {},
      }),
    ).rejects.toThrow(STORE_BLOCK_MESSAGE);
    expect(attempts.made).toEqual(['s3', 's3']);
    attempts.discard();
  });
});

describe('the global @vercel/blob block', () => {
  it.each(BLOCKED_BLOB_EXPORTS)(
    '%s rejects with the block message and records the attempt',
    async (name) => {
      const attempts = trackDbAttempts();
      const call = blob[name] as () => Promise<unknown>;
      await expect(call()).rejects.toThrow(STORE_BLOCK_MESSAGE);
      expect(attempts.made).toEqual([`blob.${name}`]);
      attempts.discard();
    },
  );

  it('blocks the production reads: api/ml/plot-image.ts and analyze-plots.ts call get() and list()', async () => {
    const attempts = trackDbAttempts();
    await expect(
      blob.get('ml/plot.png', { access: 'private' }),
    ).rejects.toThrow(STORE_BLOCK_MESSAGE);
    await expect(blob.list({ prefix: 'ml/' })).rejects.toThrow(
      STORE_BLOCK_MESSAGE,
    );
    expect(attempts.made).toEqual(['blob.get', 'blob.list']);
    attempts.discard();
  });

  it('never echoes the token', async () => {
    const attempts = trackDbAttempts();
    const err = await blob
      .put('p', 'x', { access: 'public', token: 'vercel_blob_rw_hunter2' })
      .catch((e: Error) => e);
    attempts.discard();
    expect((err as Error).message).toContain(STORE_BLOCK_MESSAGE);
    expect((err as Error).message).not.toContain('hunter2');
  });

  it('keeps the pure helpers and the error classes the code relies on', () => {
    expect(blob.getDownloadUrl('https://store.example.invalid/a.png')).toBe(
      'https://store.example.invalid/a.png?download=1',
    );
    // takeit-bundle-loader.ts and plot-image.ts branch on instanceof.
    const notFound = new blob.BlobNotFoundError();
    expect(notFound).toBeInstanceOf(blob.BlobNotFoundError);
    expect(notFound).toBeInstanceOf(blob.BlobError);
    expect(notFound).toBeInstanceOf(Error);
  });
});

describe('the global @vercel/blob/client block', () => {
  // A separate package export with its own mock. Nothing imports it today.
  it.each(BLOCKED_BLOB_CLIENT_EXPORTS)(
    '%s rejects with the block message and records the attempt',
    async (name) => {
      const attempts = trackDbAttempts();
      const call = blobClient[name] as () => Promise<unknown>;
      await expect(call()).rejects.toThrow(STORE_BLOCK_MESSAGE);
      expect(attempts.made).toEqual([`blob.client.${name}`]);
      attempts.discard();
    },
  );
});

describe('the Blob export lists', () => {
  const isClass = (value: unknown) =>
    typeof value === 'function' &&
    Function.prototype.toString.call(value).startsWith('class');

  // Every export of the installed package must be named in exactly one list,
  // so a function, class or object added by an upgrade fails here instead of
  // slipping through unblocked.
  it.each([
    [
      '@vercel/blob',
      BLOCKED_BLOB_EXPORTS,
      PURE_BLOB_EXPORTS,
      BLOB_ERROR_CLASSES,
    ],
    [
      '@vercel/blob/client',
      BLOCKED_BLOB_CLIENT_EXPORTS,
      PURE_BLOB_CLIENT_EXPORTS,
      [],
    ],
  ] as [string, readonly string[], readonly string[], readonly string[]][])(
    'classify every export of %s as blocked, pure or an error class',
    async (specifier, blocked, pure, errorClasses) => {
      const actual = await vi.importActual<Record<string, unknown>>(specifier);

      const classified = [...blocked, ...pure, ...errorClasses];
      expect(
        Object.keys(actual).filter((name) => !classified.includes(name)),
        'exports in no list',
      ).toEqual([]);
      expect(
        classified.filter((name) => !(name in actual)),
        'listed names the package no longer exports',
      ).toEqual([]);
      expect(new Set(classified).size, 'a name in two lists').toBe(
        classified.length,
      );

      for (const name of [...blocked, ...pure]) {
        expect(typeof actual[name], name).toBe('function');
        expect(isClass(actual[name]), `${name} is a class`).toBe(false);
      }
      for (const name of errorClasses) {
        expect(isClass(actual[name]), `${name} is a class`).toBe(true);
      }
    },
  );

  it.each([
    ['@vercel/blob', blob, PURE_BLOB_EXPORTS],
    ['@vercel/blob/client', blobClient, PURE_BLOB_CLIENT_EXPORTS],
  ] as [string, Record<string, unknown>, readonly string[]][])(
    'leave the pure and error-class exports of %s as the real ones',
    async (specifier, mocked, pure) => {
      const actual = await vi.importActual<Record<string, unknown>>(specifier);
      for (const name of pure) expect(mocked[name], name).toBe(actual[name]);
      if (specifier === '@vercel/blob') {
        for (const name of BLOB_ERROR_CLASSES) {
          expect(mocked[name], name).toBe(actual[name]);
        }
      }
    },
  );
});

describe('the attempts log across vi.resetModules()', () => {
  // A package imported for the first time after a reset re-runs its setup.ts
  // factory, which imports a new db-guard instance. The end-to-end case is
  // probed in no-database-guard.test.ts; this pins the shared state itself.
  it('is one log and one set of store kinds: a fresh db-guard instance writes where the check reads', async () => {
    vi.resetModules();
    const fresh = await import('../../src/__tests__/db-guard.js');
    expect(fresh).not.toBe(guard);
    expect(fresh.dbAttempts).toBe(guard.dbAttempts);

    const attempts = trackDbAttempts();
    expect(() => fresh.blockStoreAccess('blob.list')).toThrow(
      STORE_BLOCK_MESSAGE,
    );
    expect(attempts.made).toEqual(['blob.list']);
    // The original instance names the store rule for a kind the fresh one saw.
    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(`^${STORE_BLOCK_MESSAGE}; this test tried: blob.list`),
    );
    expect(guard.dbAttempts).toEqual([]);
  });
});

describe('a swallowed store attempt', () => {
  it('is recorded when safeRedis eats the throw, and the check names the store rule', async () => {
    const attempts = trackDbAttempts();
    const result = await safeRedis(() => redis.get<string>('k'), 'fell back');
    expect(result).toBe('fell back');
    expect(attempts.made).toEqual(['redis']);

    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(`${STORE_BLOCK_MESSAGE}.*redis`),
    );
    // The check clears the log, so one attempt fails one test only.
    expect(guard.dbAttempts).toEqual([]);
  });

  it.each([
    ['blob', 'blob.list', () => blob.list({ prefix: 'ml/' })],
    [
      'r2',
      's3',
      () =>
        new S3Client({
          region: 'auto',
          endpoint: 'https://example.invalid',
          credentials: { accessKeyId: 'AKIA-test', secretAccessKey: 'x' },
        }).send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' })),
    ],
  ])(
    'is recorded when a best-effort wrapper eats the %s throw, and the check names it',
    async (_client, kind, call) => {
      const attempts = trackDbAttempts();
      // The way safeDb and safeRedis swallow: catch everything, return a fallback.
      const result = await call().catch(() => 'fell back');
      expect(result).toBe('fell back');
      expect(attempts.made).toEqual([kind]);

      expect(() => guard.assertNoDbAttempts()).toThrow(
        new RegExp(`${STORE_BLOCK_MESSAGE}.*${kind}`),
      );
      expect(guard.dbAttempts).toEqual([]);
    },
  );

  it('names both rules when a database attempt and a store attempt are both left', () => {
    guard.dbAttempts.push('neon');
    expect(() => guard.blockStoreAccess('redis')).toThrow(STORE_BLOCK_MESSAGE);
    expect(guard.dbAttempts).toEqual(['neon', 'redis']);
    expect(() => guard.assertNoDbAttempts()).toThrow(
      new RegExp(`${guard.BLOCK_MESSAGE}; ${STORE_BLOCK_MESSAGE}.*neon, redis`),
    );
    expect(guard.dbAttempts).toEqual([]);
  });
});
