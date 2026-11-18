import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/react';
import { captureUnlessAuth } from '../lib/sentry-helpers';

vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
}));

describe('captureUnlessAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures generic errors without status', () => {
    const err = new Error('boom');
    captureUnlessAuth(err);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, undefined);
  });

  it.each([500, 403, 404, 503])(
    'captures errors tagged with status %i',
    (status) => {
      const err = Object.assign(new Error(String(status)), { status });
      captureUnlessAuth(err);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    },
  );

  it('skips errors tagged with status 401', () => {
    const err = Object.assign(new Error('Not authenticated'), { status: 401 });
    captureUnlessAuth(err);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // A limited guest is expected traffic: the server already counts each limit
  // with `metrics.rateLimited`, so a frontend event per 429 only adds noise.
  it('skips errors tagged with status 429', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 });
    captureUnlessAuth(err);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures errors where status is stringly-typed "429" (defensive)', () => {
    const err = Object.assign(new Error('weird'), { status: '429' });
    captureUnlessAuth(err);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('forwards the options arg to Sentry.captureException', () => {
    const err = new Error('boom');
    const opts = { tags: { context: 'test' } };
    captureUnlessAuth(err, opts);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, opts);
  });

  it('captures null without crashing', () => {
    captureUnlessAuth(null);
    expect(Sentry.captureException).toHaveBeenCalledWith(null, undefined);
  });

  it('captures string throws without crashing', () => {
    captureUnlessAuth('oops');
    expect(Sentry.captureException).toHaveBeenCalledWith('oops', undefined);
  });

  it('captures errors where status is stringly-typed "401" (defensive)', () => {
    // Strict-equality check: stringly-typed status does NOT trigger
    // suppression. Caller bug surfaces as a normal captured event
    // rather than silently disappearing.
    const err = Object.assign(new Error('weird'), { status: '401' });
    captureUnlessAuth(err);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
