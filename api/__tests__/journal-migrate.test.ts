// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  rejectIfNotOwner: vi.fn(),
  checkBot: vi.fn().mockResolvedValue({ isBot: false }),
}));

vi.mock('../_lib/db.js', () => ({
  migrateDb: vi.fn(),
}));

import handler from '../journal/migrate.js';
import { rejectIfNotOwner, checkBot } from '../_lib/api-helpers.js';
import { migrateDb } from '../_lib/db.js';

describe('POST /api/journal/migrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('rejects non-owner requests', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(true as never);
    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(rejectIfNotOwner).toHaveBeenCalled();
  });

  it('runs migrations and returns applied columns', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(migrateDb).mockResolvedValue([
      'vix_term_shape',
      'cluster_put_mult',
      'cluster_call_mult',
      'rv_iv_ratio',
      'rv_iv_label',
      'rv_annualized',
      'iv_accel_mult',
    ]);

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(200);
    const json = res._json as {
      success: boolean;
      columnsAdded: string[];
      message: string;
    };
    expect(json.success).toBe(true);
    expect(json.columnsAdded).toHaveLength(7);
    expect(json.columnsAdded).toContain('rv_iv_ratio');
    expect(migrateDb).toHaveBeenCalled();
  });

  it('returns 500 on migration failure', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(migrateDb).mockRejectedValue(new Error('DB unreachable'));

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);

    expect(res._status).toBe(500);
    expect((res._json as { error: string }).error).toBe('DB unreachable');
  });

  it('returns 403 when bot detected', async () => {
    vi.mocked(checkBot).mockResolvedValueOnce({ isBot: true });

    const res = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: 'Access denied' });
  });

  it('is idempotent (safe to call multiple times)', async () => {
    vi.mocked(rejectIfNotOwner).mockReturnValue(false);
    vi.mocked(migrateDb).mockResolvedValue(['vix_term_shape', 'rv_iv_ratio']);

    const res1 = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res1);
    expect(res1._status).toBe(200);

    const res2 = mockResponse();
    await handler(mockRequest({ method: 'POST' }), res2);
    expect(res2._status).toBe(200);
    expect(migrateDb).toHaveBeenCalledTimes(2);
  });
});
