/**
 * Unit tests for `fatalExit` and `gracefulShutdown` cleanup ordering.
 *
 * Phase 1 reviewer flagged that the previous `fatalExit` implementation
 * only drained Sentry — leaving the scheduler interval timer + health
 * server orphaned during uncaughtException / unhandledRejection paths.
 * These tests pin the ordering: scheduler.stop() → health.close() →
 * sentry.close() → exit().
 */

import { describe, it, expect, vi } from 'vitest';
import { fatalExit, gracefulShutdown, type ShutdownDeps } from '../src/index';

interface CallLog {
  kind:
    | 'scheduler.stop'
    | 'health.close'
    | 'sentry.close'
    | 'exit';
  arg?: number;
}

function makeDeps(opts?: {
  healthRejects?: boolean;
}): { deps: ShutdownDeps; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const deps: ShutdownDeps = {
    scheduler: {
      stop: vi.fn(() => {
        calls.push({ kind: 'scheduler.stop' });
      }),
    },
    health: {
      close: vi.fn(() => {
        calls.push({ kind: 'health.close' });
        return opts?.healthRejects
          ? Promise.reject(new Error('boom'))
          : Promise.resolve();
      }),
    },
    sentry: {
      close: vi.fn((timeout?: number) => {
        calls.push({ kind: 'sentry.close', arg: timeout });
        return Promise.resolve(true);
      }),
    },
    exit: vi.fn((code: number) => {
      calls.push({ kind: 'exit', arg: code });
    }),
  };
  return { deps, calls };
}

describe('fatalExit', () => {
  it('runs scheduler.stop → health.close → sentry.close → exit(1) in order', async () => {
    const { deps, calls } = makeDeps();
    await fatalExit(deps);
    expect(calls.map((c) => c.kind)).toEqual([
      'scheduler.stop',
      'health.close',
      'sentry.close',
      'exit',
    ]);
    expect(calls[2]?.arg).toBe(2000);
    expect(calls[3]?.arg).toBe(1);
  });

  it('still drains Sentry and exits even when health.close rejects', async () => {
    const { deps, calls } = makeDeps({ healthRejects: true });
    await fatalExit(deps);
    expect(calls.map((c) => c.kind)).toEqual([
      'scheduler.stop',
      'health.close',
      'sentry.close',
      'exit',
    ]);
    expect(calls[3]?.arg).toBe(1);
  });

  it('calls scheduler.stop synchronously before any async work', async () => {
    const { deps, calls } = makeDeps();
    const promise = fatalExit(deps);
    // Before microtasks run, only scheduler.stop + health.close should
    // have been invoked (health.close fires synchronously and returns a
    // pending promise).
    expect(calls.map((c) => c.kind)).toEqual([
      'scheduler.stop',
      'health.close',
    ]);
    await promise;
  });
});

describe('gracefulShutdown', () => {
  it('runs scheduler.stop → health.close → sentry.close → exit(0) in order', async () => {
    const { deps, calls } = makeDeps();
    await gracefulShutdown(deps);
    expect(calls.map((c) => c.kind)).toEqual([
      'scheduler.stop',
      'health.close',
      'sentry.close',
      'exit',
    ]);
    expect(calls[3]?.arg).toBe(0);
  });

  it('still drains Sentry and exits when health.close rejects', async () => {
    const { deps, calls } = makeDeps({ healthRejects: true });
    await gracefulShutdown(deps);
    expect(calls.map((c) => c.kind)).toEqual([
      'scheduler.stop',
      'health.close',
      'sentry.close',
      'exit',
    ]);
    expect(calls[3]?.arg).toBe(0);
  });
});
