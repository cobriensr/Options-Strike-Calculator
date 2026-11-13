// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { TransientDbError } from '../_lib/transient-db-error.js';
import {
  TransientDbError as ReexportedTransientDbError,
  withDbRetry,
} from '../_lib/db.js';

describe('TransientDbError', () => {
  it('keeps the original error as `cause` and its message, under a stable name', () => {
    const cause = new Error('db attempt timeout');
    const err = new TransientDbError(cause);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TransientDbError');
    expect(err.message).toBe('db attempt timeout');
    expect(err.cause).toBe(cause);
  });

  it('stringifies a non-Error cause', () => {
    const err = new TransientDbError('fetch failed');

    expect(err.message).toBe('fetch failed');
    expect(err.cause).toBe('fetch failed');
  });

  it('is the same class db.js re-exports, so instanceof holds across both import paths', async () => {
    expect(ReexportedTransientDbError).toBe(TransientDbError);

    // withDbRetry (db.ts) constructs it; a check against the standalone
    // module's class must still recognise that instance.
    const thrown = await withDbRetry(
      () => Promise.reject(new Error('fetch failed')),
      0,
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(TransientDbError);
  });
});
