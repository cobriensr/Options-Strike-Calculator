// @vitest-environment node

/**
 * The two periscope readers keep their own rejectIfRateLimited call, so they
 * pass `rateLimit: 0` to `withDbReader`. These tests pin that the wrapper's
 * default reader limiter does not stack on top: stacked, chat-detail would
 * drop from 120 a minute to 60 and both routes would make a second Redis call
 * per request.
 *
 * The wrapper imports its limiter from auth-helpers.js; the handlers import
 * theirs through the api-helpers.js barrel. Mocking the two modules apart
 * gives each limiter its own spy, so a call can be traced to its source.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({ mockSql: vi.fn() }));
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
}));

// Keep the rest of auth-helpers real; spy on the wrapper's limiter only.
vi.mock('../_lib/auth-helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_lib/auth-helpers.js')>()),
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  respondIfInvalid: vi.fn().mockReturnValue(false),
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: vi.fn((cb) =>
      cb({ setTransactionName: vi.fn(), setTag: vi.fn() }),
    ),
  },
  metrics: { request: vi.fn(() => vi.fn()), increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import detailHandler from '../periscope-chat-detail.js';
import listHandler from '../periscope-lessons-list.js';
import { rejectIfRateLimited as wrapperLimiter } from '../_lib/auth-helpers.js';
import { rejectIfRateLimited as ownLimiter } from '../_lib/api-helpers.js';

beforeEach(() => {
  vi.mocked(wrapperLimiter).mockClear();
  vi.mocked(ownLimiter).mockClear();
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

describe('periscope readers keep one limiter, their own', () => {
  it('chat-detail limits at 120 a minute through its own call; the default does not stack', async () => {
    const req = mockRequest({ method: 'GET', query: { id: '42' } });
    const res = mockResponse();

    await detailHandler(req, res);

    expect(ownLimiter).toHaveBeenCalledTimes(1);
    expect(ownLimiter).toHaveBeenCalledWith(
      req,
      res,
      'periscope-chat-detail',
      120,
    );
    expect(wrapperLimiter).not.toHaveBeenCalled();
  });

  it('lessons-list limits at 60 a minute through its own call; the default does not stack', async () => {
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();

    await listHandler(req, res);

    expect(res._status).toBe(200);
    expect(ownLimiter).toHaveBeenCalledTimes(1);
    expect(ownLimiter).toHaveBeenCalledWith(
      req,
      res,
      'periscope-lessons-list',
      60,
    );
    expect(wrapperLimiter).not.toHaveBeenCalled();
  });
});
