import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(),
}));
vi.mock('../_lib/api-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/api-helpers.js')>();
  return {
    ...actual,
    rejectIfRateLimited: vi.fn().mockResolvedValue(false),
  };
});
vi.mock('../_lib/guest-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_lib/guest-auth.js')>();
  return {
    ...actual,
    guardOwnerOrGuestEndpoint: vi.fn(),
  };
});

import handler from '../panel-prefs.js';
import { getDb } from '../_lib/db.js';
import { guardOwnerOrGuestEndpoint } from '../_lib/guest-auth.js';

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe('GET /api/panel-prefs', () => {
  const mockSql = vi.fn();
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  });

  it('returns empty arrays for all three axes on first read', async () => {
    mockSql.mockResolvedValueOnce([]); // no row
    const req = {
      method: 'GET',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: undefined,
    } as never;
    process.env.OWNER_SECRET = 'secret';
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: [],
      panelOrder: [],
      groupOrder: [],
    });
  });

  it('returns stored hiddenPanels + panelOrder + groupOrder for owner', async () => {
    mockSql.mockResolvedValueOnce([
      {
        hidden_panels: ['sec-darkpool', 'sec-greek-flow'],
        panel_order: ['sec-spot-price', 'sec-datetime'],
        group_order: ['Market Context', 'Inputs'],
      },
    ]);
    const req = {
      method: 'GET',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: undefined,
    } as never;
    process.env.OWNER_SECRET = 'secret';
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-darkpool', 'sec-greek-flow'],
      panelOrder: ['sec-spot-price', 'sec-datetime'],
      groupOrder: ['Market Context', 'Inputs'],
    });
  });

  it('coerces missing panel_order / group_order columns to empty arrays', async () => {
    mockSql.mockResolvedValueOnce([
      { hidden_panels: ['sec-spot-price'] }, // panel_order/group_order absent (older row)
    ]);
    const req = {
      method: 'GET',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: undefined,
    } as never;
    process.env.OWNER_SECRET = 'secret';
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-spot-price'],
      panelOrder: [],
      groupOrder: [],
    });
  });

  it('uses sha256(guest_key) as identity for guests', async () => {
    const guestKey = 'test-guest-key';
    const expectedHash = crypto
      .createHash('sha256')
      .update(guestKey)
      .digest('hex');
    mockSql.mockImplementationOnce(
      (_strings: TemplateStringsArray, identity: string) => {
        expect(identity).toBe(expectedHash);
        return Promise.resolve([{ hidden_panels: ['sec-spot-price'] }]);
      },
    );
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'GET',
      headers: { cookie: `sc-guest=${guestKey}` },
      query: {},
      body: undefined,
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-spot-price'],
      panelOrder: [],
      groupOrder: [],
    });
  });

  it('returns 405 for unsupported methods', async () => {
    const req = { method: 'DELETE', headers: {}, query: {} } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 when guard rejects', async () => {
    vi.mocked(guardOwnerOrGuestEndpoint).mockImplementationOnce(
      async (_req, res, done) => {
        done({ status: 401 });
        (res as unknown as ReturnType<typeof makeRes>)
          .status(401)
          .json({ error: 'Not authenticated' });
        return true;
      },
    );
    const req = { method: 'GET', headers: {}, query: {} } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /api/panel-prefs', () => {
  const mockSql = vi.fn();
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(getDb).mockReturnValue(
      mockSql as unknown as ReturnType<typeof getDb>,
    );
    vi.mocked(guardOwnerOrGuestEndpoint).mockResolvedValue(false);
  });

  it('upserts hiddenPanels-only PUT and preserves existing order arrays', async () => {
    // 1st query: SELECT existing → has stored order
    mockSql.mockResolvedValueOnce([
      {
        hidden_panels: ['sec-datetime'],
        panel_order: ['sec-spot-price', 'sec-datetime'],
        group_order: ['Market Context', 'Inputs'],
      },
    ]);
    // 2nd query: UPSERT
    mockSql.mockResolvedValueOnce([]);
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { hiddenPanels: ['sec-darkpool', 'sec-greek-flow'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-darkpool', 'sec-greek-flow'],
      panelOrder: ['sec-spot-price', 'sec-datetime'],
      groupOrder: ['Market Context', 'Inputs'],
    });
  });

  it('upserts panelOrder-only PUT and preserves existing visibility + groups', async () => {
    mockSql.mockResolvedValueOnce([
      {
        hidden_panels: ['sec-darkpool'],
        panel_order: [],
        group_order: ['Trading', 'Inputs'],
      },
    ]);
    mockSql.mockResolvedValueOnce([]);
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { panelOrder: ['sec-spot-price', 'sec-datetime'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-darkpool'],
      panelOrder: ['sec-spot-price', 'sec-datetime'],
      groupOrder: ['Trading', 'Inputs'],
    });
  });

  it('upserts all three axes when full body provided (fresh identity)', async () => {
    // SELECT returns empty
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: {
        hiddenPanels: ['sec-iv'],
        panelOrder: ['sec-spot-price'],
        groupOrder: ['Inputs', 'Market Context'],
      },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hiddenPanels: ['sec-iv'],
      panelOrder: ['sec-spot-price'],
      groupOrder: ['Inputs', 'Market Context'],
    });
  });

  it('rejects malformed panel ids with 400', async () => {
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { hiddenPanels: ['NOT-A-PANEL-ID'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed panel ids in panelOrder with 400', async () => {
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { panelOrder: ['totally-bogus'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown group names in groupOrder with 400', async () => {
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { groupOrder: ['NotARealGroup'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate panel ids in panelOrder with 400', async () => {
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { panelOrder: ['sec-spot-price', 'sec-spot-price'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects more than 50 panels with 400', async () => {
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: {
        hiddenPanels: Array.from(
          { length: 51 },
          (_, i) => `sec-panel-${i.toString()}`,
        ),
      },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('accepts `results` as a valid panel id', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    process.env.OWNER_SECRET = 'secret';
    const req = {
      method: 'PUT',
      headers: { cookie: 'sc-owner=secret' },
      query: {},
      body: { panelOrder: ['results', 'sec-spot-price'] },
    } as never;
    const res = makeRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
  });
});
