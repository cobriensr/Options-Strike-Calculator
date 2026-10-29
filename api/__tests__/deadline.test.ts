// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeadlineError, withDeadline } from '../_lib/deadline.js';

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the work’s value and leaves no timer armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await expect(
      withDeadline(Promise.resolve(42), 5_000, 'probe'),
    ).resolves.toBe(42);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the work’s own rejection through unchanged', async () => {
    const err = new Error('relation "x" does not exist');

    await expect(
      withDeadline(Promise.reject(err), 5_000, 'probe'),
    ).rejects.toBe(err);
  });

  it('rejects with a DeadlineError naming the work once the deadline passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = withDeadline(new Promise(() => {}), 5_000, 'ticker flow');
    const settled = expect(pending).rejects.toThrow(
      new DeadlineError('ticker flow', 5_000),
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await settled;
    await expect(pending).rejects.toBeInstanceOf(DeadlineError);
    await expect(pending).rejects.toThrow(
      'ticker flow passed its 5000 ms deadline',
    );
  });
});
