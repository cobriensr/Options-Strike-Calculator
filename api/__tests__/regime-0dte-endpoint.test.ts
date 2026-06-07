// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { getGexStrikes, getPutIvSeries, getCandles30 } = vi.hoisted(() => ({
  getGexStrikes: vi.fn(),
  getPutIvSeries: vi.fn(),
  getCandles30: vi.fn(),
}));
vi.mock('../_lib/regime-0dte-queries.js', () => ({
  getGexStrikes,
  getPutIvSeries,
  getCandles30,
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));
vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));
vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import handler from '../regime-0dte.js';

// A deep-negative-gamma fixture (live units, ~1e10 magnitudes): five strikes
// tightly around spot 7460, each strongly net-negative → gexNear well below
// GATE_DEEP_NEG (−1.5e10) → gate 'lean_down'.
const DEEP_NEG_STRIKES = {
  strikes: [
    { strike: 7440, netGex: -6e9 },
    { strike: 7450, netGex: -6e9 },
    { strike: 7460, netGex: -6e9 },
    { strike: 7470, netGex: -6e9 },
    { strike: 7480, netGex: -6e9 },
  ],
  spot: 7460,
};

describe('GET /api/regime-0dte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGuard.mockResolvedValue(false); // false = request passed the guard
    getGexStrikes.mockResolvedValue(DEEP_NEG_STRIKES);
    getPutIvSeries.mockResolvedValue([
      { ctMin: 520, iv: 0.2 },
      { ctMin: 650, iv: 0.27 },
    ]);
    getCandles30.mockResolvedValue([
      { ctMin: 510, open: 7530, close: 7520 },
      { ctMin: 540, open: 7520, close: 7510 },
      { ctMin: 570, open: 7510, close: 7500 },
      { ctMin: 600, open: 7500, close: 7480 },
      { ctMin: 630, open: 7480, close: 7470 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 200 with a gate + triggers in the body', async () => {
    vi.useFakeTimers();
    // 12:00 ET / 11:00 CT — inside the session, after the persistence window.
    vi.setSystemTime(new Date('2026-06-06T16:00:00Z'));

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { gate: string; triggers: unknown };
    expect(body).toHaveProperty('gate');
    expect(body).toHaveProperty('triggers');
    expect(body.gate).toBe('lean_down');
  });

  it('returns 401 when the owner/guest guard rejects', async () => {
    mockGuard.mockResolvedValue(true); // true = guard already sent the 401

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    // The guard owns the response; the handler must not run the read path.
    expect(getGexStrikes).not.toHaveBeenCalled();
    expect(res._json).toBeNull();
  });

  it('rejects a malformed date query with 400', async () => {
    const req = mockRequest({ method: 'GET', query: { date: 'not-a-date' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(getGexStrikes).not.toHaveBeenCalled();
  });
});
