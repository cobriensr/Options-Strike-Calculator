import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { assertNoDbAttempts, scrubDbEnv } from './db-guard';
import { installNetworkBlock } from './net-guard';

// No test may connect to or write to a real database (owner rule,
// 2026-11-04; see ./db-guard.ts and
// docs/superpowers/specs/tests-no-db-2026-11-04.md). First, a shell that
// exports DATABASE_URL, a Redis token or a bucket key must not reach any
// test: tests that need a value stub their own fake after this runs.
scrubDbEnv();

// Beneath every client below, no connection to a host outside this machine:
// the block sits at `net.Socket#connect`, where fetch, http, https, net, tls,
// WebSocket and jsdom's XMLHttpRequest all end, so a raw fetch to a store URL
// or an API no mock covers fails too, with `fetch` left real or spied. See
// ./net-guard.ts.
installNetworkBlock();

// Second, the one place the app builds a Neon client is neon() in
// api/_lib/db.ts. Every test file gets a package whose neon(), Pool and
// Client record the attempt and throw. A file that mocks the package itself
// overrides this one, and in-process pglite never touches it.
vi.mock('@neondatabase/serverless', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@neondatabase/serverless')>();
  const { blockDbAccess: block } = await import('./db-guard');
  return {
    ...actual,
    neon: () => block('neon'),
    Pool: class {
      constructor() {
        block('Pool');
      }
    },
    Client: class {
      constructor() {
        block('Client');
      }
    },
  };
});

// Third, the production stores get the same treatment, reads included (a
// read reaches production as surely as a write). Upstash Redis: every
// command funnels through the HTTP client's request method, which the block
// replaces when the package is first imported. A test file that mocks one of
// these packages itself overrides that mock, as with Neon above.
vi.mock('@upstash/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@upstash/redis')>();
  const { blockRedisRequests } = await import('./db-guard');
  blockRedisRequests(actual.Redis);
  return actual;
});

// Vercel Blob has no client object, so each network-calling export is
// replaced by name; the error classes and pure helpers are kept.
vi.mock('@vercel/blob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vercel/blob')>();
  const { blockBlobExports } = await import('./db-guard');
  return blockBlobExports(actual);
});

// The browser-upload entry point is a separate package export, so it needs
// its own mock. Nothing imports it today; this keeps a future import blocked.
vi.mock('@vercel/blob/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vercel/blob/client')>();
  const { blockBlobClientExports } = await import('./db-guard');
  return blockBlobClientExports(actual);
});

// Cloudflare R2 is S3-compatible and is reached only through S3Client.send.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  const { blockS3Sends } = await import('./db-guard');
  blockS3Sends(actual.S3Client);
  return actual;
});

// Vitest doesn't auto-run @testing-library's cleanup (unlike Jest). Without
// this, every render()/renderHook() call leaves React roots + JSDOM mounts
// allocated for the entire test run, accumulating into gigabytes across
// ~7700 tests and eventually blowing past the Node heap ceiling in CI.
// See the April 2026 CI OOM investigation.
//
// Fourth, an attempt that a best-effort wrapper (safeDb, safeRedis) swallowed
// still fails the test that made it. The afterAll covers what no afterEach
// sees: an attempt made in a file's own afterAll (which runs before this one,
// hooks run in stack order) or by work still running after the last test. A
// file whose tests are all skipped runs no hooks at all, so it is not covered.
afterEach(() => {
  cleanup();
  assertNoDbAttempts();
});

afterAll(() => {
  assertNoDbAttempts();
});

// jsdom doesn't implement createImageBitmap / OffscreenCanvas — stub them for compressImage()
if (typeof globalThis.createImageBitmap !== 'function') {
  globalThis.createImageBitmap = async () =>
    ({ width: 800, height: 600, close() {} }) as unknown as ImageBitmap;
}

if (typeof globalThis.OffscreenCanvas !== 'function') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return { drawImage() {} };
    }
    convertToBlob() {
      return Promise.resolve(new Blob(['fake'], { type: 'image/jpeg' }));
    }
  } as unknown as typeof globalThis.OffscreenCanvas;
}

// jsdom doesn't implement scrollIntoView (there's no layout to scroll), so
// components can call it unguarded. Tests that care spy on it. The api/
// suites run in the node environment, which has no Element at all.
if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.scrollIntoView !== 'function'
) {
  Element.prototype.scrollIntoView = () => {};
}

// Nor ResizeObserver: a no-op one lets components observe unguarded. It
// never calls back, as nothing in jsdom resizes. Tests that need the
// callback stub their own with vi.stubGlobal.
if (
  typeof window !== 'undefined' &&
  typeof globalThis.ResizeObserver !== 'function'
) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement Blob.prototype.text() — polyfill for CSV upload tests
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () =>
        reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsText(this);
    });
  };
}
