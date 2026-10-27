// @vitest-environment node

/**
 * Auth tier of the shared write endpoints, exercised through the real
 * owner and guest guards (only botid, the DB, Sentry and the logger are
 * mocked). Every shared write requires the owner session; a guest key
 * keeps read access to the tracker list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { mockRequest, mockResponse } from './helpers';

const { checkBotIdMock, TransientDbError } = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(cause?: unknown) {
      super('db attempt timeout');
      this.name = 'TransientDbError';
      this.cause = cause;
    }
  }
  return {
    checkBotIdMock: vi.fn(async () => ({ isBot: false })),
    TransientDbError,
  };
});
vi.mock('botid/server', () => ({ checkBotId: checkBotIdMock }));

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb) => cb({ setTransactionName: vi.fn() })),
    captureException: vi.fn(),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
    rateLimited: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import listCreateHandler from '../tracker/contracts.js';
import idHandler from '../tracker/contracts/[id].js';

const OWNER_SECRET = 'owner-secret-for-tests';
const GUEST_KEY = 'guest-key-for-tests';

const CONTRACT_ROW = {
  id: 1,
  occ_symbol: 'NVDA  260522P00225000',
  ticker: 'NVDA',
  expiry: '2026-05-22',
  status: 'active',
};

const CREATE_BODY = {
  ticker: 'NVDA',
  expiry: '2026-05-22',
  strike: 225,
  side: 'P',
  direction: 'long',
  entry_price: 4.3,
  quantity: 5,
};

type Caller = 'owner' | 'guest' | 'anonymous';

const COOKIES: Record<Caller, string | undefined> = {
  owner: `sc-owner=${OWNER_SECRET}`,
  guest: `sc-guest=${GUEST_KEY}`,
  anonymous: undefined,
};

function requestAs(
  caller: Caller,
  overrides: Partial<VercelRequest>,
): VercelRequest {
  const cookie = COOKIES[caller];
  return mockRequest({
    headers: cookie ? { cookie } : {},
    ...overrides,
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.VERCEL;
  process.env.OWNER_SECRET = OWNER_SECRET;
  process.env.GUEST_ACCESS_KEYS = GUEST_KEY;
  mockSql.mockReset();
  checkBotIdMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/tracker/contracts', () => {
  it('rejects a guest with 401 and writes nothing', async () => {
    const res = mockResponse();
    await listCreateHandler(
      requestAs('guest', { method: 'POST', body: CREATE_BODY }),
      res,
    );
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Not authenticated' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401 and writes nothing', async () => {
    const res = mockResponse();
    await listCreateHandler(
      requestAs('anonymous', { method: 'POST', body: CREATE_BODY }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('lets the owner create a contract (201)', async () => {
    mockSql.mockResolvedValueOnce([CONTRACT_ROW]);
    const res = mockResponse();
    await listCreateHandler(
      requestAs('owner', { method: 'POST', body: CREATE_BODY }),
      res,
    );
    expect(res._status).toBe(201);
    expect(res._json).toEqual({ contract: CONTRACT_ROW });
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/tracker/contracts', () => {
  it('still serves the list to a guest (200)', async () => {
    mockSql.mockResolvedValueOnce([CONTRACT_ROW]);
    const res = mockResponse();
    await listCreateHandler(
      requestAs('guest', { method: 'GET', query: {} }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ contracts: [CONTRACT_ROW], count: 1 });
  });

  it('still rejects an unauthenticated caller (401)', async () => {
    const res = mockResponse();
    await listCreateHandler(
      requestAs('anonymous', { method: 'GET', query: {} }),
      res,
    );
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tracker/contracts/[id]', () => {
  const patch = { method: 'PATCH', query: { id: '1' }, body: { notes: 'x' } };

  it('rejects a guest with 401 and writes nothing', async () => {
    const res = mockResponse();
    await idHandler(requestAs('guest', patch), res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Not authenticated' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401 and writes nothing', async () => {
    const res = mockResponse();
    await idHandler(requestAs('anonymous', patch), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('lets the owner update a contract (200)', async () => {
    mockSql.mockResolvedValueOnce([{ ...CONTRACT_ROW, notes: 'x' }]);
    const res = mockResponse();
    await idHandler(requestAs('owner', patch), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ contract: { ...CONTRACT_ROW, notes: 'x' } });
  });
});

describe('DELETE /api/tracker/contracts/[id]', () => {
  const del = { method: 'DELETE', query: { id: '1' } };

  it('rejects a guest with 401 and deletes nothing', async () => {
    const res = mockResponse();
    await idHandler(requestAs('guest', del), res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Not authenticated' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401 and deletes nothing', async () => {
    const res = mockResponse();
    await idHandler(requestAs('anonymous', del), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('lets the owner delete a contract (200)', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    const res = mockResponse();
    await idHandler(requestAs('owner', del), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ deleted: 1 });
  });
});
