// @vitest-environment node

/**
 * Tests for /api/periscope-playbook handler.
 *
 * Phase 2c of docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md.
 *
 * Verifies the contract the panel hook depends on:
 *   - 200 with data when a complete auto-generated row exists
 *   - 200 with data=null + reason='no_playbook' when nothing yet
 *   - 200 with latestInProgress=true when a newer slot is mid-flight
 *   - 405 on non-GET
 *   - 400 on malformed date
 *   - 500 on auth-bypass exception path
 *   - Cache headers vary correctly: nocache > historical > live
 */

import { vi, beforeEach, describe, it, expect } from 'vitest';

const {
  mockSql,
  mockGuard,
  mockSetCacheHeaders,
  mockIsMarketOpen,
  TransientDbError,
} = vi.hoisted(() => {
  class TransientDbError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TransientDbError';
    }
  }
  return {
    mockSql: vi.fn(),
    mockGuard: vi.fn(),
    mockSetCacheHeaders: vi.fn(),
    mockIsMarketOpen: vi.fn(),
    TransientDbError,
  };
});

vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCacheHeaders,
  isMarketOpen: mockIsMarketOpen,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: (
      fn: (s: { setTransactionName: (n: string) => void }) => unknown,
    ) => fn({ setTransactionName: () => undefined }),
  },
  metrics: { request: () => () => undefined },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn() },
}));

import handler from '../periscope-playbook.js';

function makeReqRes(
  query: Record<string, string> = {},
  method = 'GET',
): {
  req: never;
  res: {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    status: (c: number) => unknown;
    json: (p: unknown) => unknown;
    setHeader: (k: string, v: string) => unknown;
  };
} {
  const req = { query, method, headers: {} } as never;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return { req, res };
}

const COMPLETE_ROW = {
  id: '777',
  mode: 'intraday' as const,
  status: 'complete' as const,
  slot_captured_at: '2026-05-12T13:30:00.000Z',
  read_time: '2026-05-12T13:30:00.000Z',
  spot_at_read_time: '5800.50',
  panel_payload: { spot: 5800.5, regime: 'drift-and-cap' },
  parent_id: '776',
  model: 'claude-opus-4-7',
  failure_reason: null,
  duration_ms: 1234,
  created_at: '2026-05-12T13:30:01.000Z',
};

beforeEach(() => {
  mockSql.mockReset();
  mockGuard.mockReset();
  mockGuard.mockResolvedValue(false);
  mockSetCacheHeaders.mockReset();
  mockIsMarketOpen.mockReset();
  mockIsMarketOpen.mockReturnValue(true);
});

// ============================================================
// Happy paths
// ============================================================

describe('GET /api/periscope-playbook — happy paths', () => {
  it('returns 200 with normalized data when a complete row exists', async () => {
    // First call: latest complete
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    // Second call: hasLaterInProgress (none)
    mockSql.mockResolvedValueOnce([]);

    const { req, res } = makeReqRes({ date: '2026-05-12' });
    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      data: { id: number; spot: number; mode: string };
      latestInProgress: boolean;
    };
    expect(body.data).toMatchObject({
      id: 777,
      mode: 'intraday',
      status: 'complete',
      spot: 5800.5,
      parentId: 776,
      panelPayload: { spot: 5800.5, regime: 'drift-and-cap' },
    });
    expect(body.latestInProgress).toBe(false);
  });

  it('returns latestInProgress=true when a newer slot is mid-flight', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]);

    const { req, res } = makeReqRes();
    await handler(req, res as never);

    const body = res.body as { latestInProgress: boolean };
    expect(body.latestInProgress).toBe(true);
  });

  it('parses panel_payload when stored as a JSON string (Neon driver edge case)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ...COMPLETE_ROW,
        panel_payload: JSON.stringify({ spot: 5800.5, regime: 'pin' }),
      },
    ]);
    mockSql.mockResolvedValueOnce([]);

    const { req, res } = makeReqRes();
    await handler(req, res as never);

    const body = res.body as {
      data: { panelPayload: Record<string, unknown> };
    };
    expect(body.data.panelPayload).toEqual({ spot: 5800.5, regime: 'pin' });
  });

  it('returns 200 + reason=no_playbook when no completed row exists', async () => {
    mockSql.mockResolvedValueOnce([]); // latest complete: none
    mockSql.mockResolvedValueOnce([]); // in_progress: none

    const { req, res } = makeReqRes();
    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: null, reason: 'no_playbook' });
  });

  it('still surfaces latestInProgress=true even when no complete row exists', async () => {
    mockSql.mockResolvedValueOnce([]); // no complete
    mockSql.mockResolvedValueOnce([{ '?column?': 1 }]); // an in-flight row

    const { req, res } = makeReqRes();
    await handler(req, res as never);

    expect(res.body).toMatchObject({
      data: null,
      reason: 'no_playbook',
      latestInProgress: true,
    });
  });
});

// ============================================================
// Method, validation, auth
// ============================================================

describe('GET /api/periscope-playbook — input contract', () => {
  it('returns 405 on non-GET', async () => {
    const { req, res } = makeReqRes({}, 'POST');
    await handler(req, res as never);
    expect(res.statusCode).toBe(405);
  });

  it('returns 400 on malformed date', async () => {
    const { req, res } = makeReqRes({ date: 'not-a-date' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on malformed slot', async () => {
    const { req, res } = makeReqRes({
      date: '2026-05-12',
      slot: 'definitely-not-iso',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects when guardOwnerOrGuestEndpoint returns true', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    // Guard wrote its own response; handler should not have written one.
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// ============================================================
// Slot-pinned lookups (time-travel from the panel)
// ============================================================

describe('GET /api/periscope-playbook — slot pinning', () => {
  it('returns the row whose slot_captured_at matches when ?slot=ISO is set', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]); // fetchComplete (slot-pinned)
    mockSql.mockResolvedValueOnce([]); // hasLaterInProgress

    const { req, res } = makeReqRes({
      date: '2026-05-12',
      slot: '2026-05-12T13:30:00.000Z',
    });
    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      data: { id: number; slotCapturedAt: string };
    };
    expect(body.data).toMatchObject({
      id: 777,
      slotCapturedAt: '2026-05-12T13:30:00.000Z',
    });
  });

  it('returns data=null when no row matches the pinned slot', async () => {
    mockSql.mockResolvedValueOnce([]); // no match for that slot
    mockSql.mockResolvedValueOnce([]); // no in_progress

    const { req, res } = makeReqRes({
      date: '2026-05-12',
      slot: '2026-05-12T14:00:00.000Z',
    });
    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: null, reason: 'no_playbook' });
  });

  it('uses historical cache headers when ?slot is set even without ?date', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([]);

    const { req, res } = makeReqRes({
      slot: '2026-05-12T13:30:00.000Z',
    });
    await handler(req, res as never);

    expect(mockSetCacheHeaders).toHaveBeenCalledWith(
      expect.anything(),
      600,
      60,
    );
  });
});

// ============================================================
// Cache headers
// ============================================================

describe('GET /api/periscope-playbook — cache headers', () => {
  it('sets no-store when ?nocache is present (manual rerun)', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([]);

    const { req, res } = makeReqRes({ nocache: 'abc123' });
    await handler(req, res as never);

    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(mockSetCacheHeaders).not.toHaveBeenCalled();
  });

  it('uses 600s cache for historical date reads', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([]);

    const { req, res } = makeReqRes({ date: '2026-04-15' });
    await handler(req, res as never);

    expect(mockSetCacheHeaders).toHaveBeenCalledWith(
      expect.anything(),
      600,
      60,
    );
  });

  it('uses 60s cache when live during RTH', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([]);
    mockIsMarketOpen.mockReturnValue(true);

    const { req, res } = makeReqRes(); // no date param = live
    await handler(req, res as never);

    expect(mockSetCacheHeaders).toHaveBeenCalledWith(expect.anything(), 60, 60);
  });

  it('uses 600s cache when live but market closed (after-hours panel)', async () => {
    mockSql.mockResolvedValueOnce([COMPLETE_ROW]);
    mockSql.mockResolvedValueOnce([]);
    mockIsMarketOpen.mockReturnValue(false);

    const { req, res } = makeReqRes();
    await handler(req, res as never);

    expect(mockSetCacheHeaders).toHaveBeenCalledWith(
      expect.anything(),
      600,
      60,
    );
  });
});
