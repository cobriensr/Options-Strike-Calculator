// @vitest-environment node

/**
 * Tests for the three /api/pyramid/* endpoints. Mocks `guardOwnerEndpoint`
 * and every db-pyramid export so we exercise the endpoint dispatch, auth
 * rejection, Zod validation, not-found handling, and the
 * PyramidLegOrderError -> 409 translation without touching Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../_lib/db-pyramid.js', async () => {
  const actual = await vi.importActual<typeof import('../_lib/db-pyramid.js')>(
    '../_lib/db-pyramid.js',
  );
  return {
    // Real PyramidLegOrderError class so `instanceof` checks in the
    // endpoint match what the mocked `createLeg` throws.
    PyramidLegOrderError: actual.PyramidLegOrderError,
    createChain: vi.fn(),
    getChains: vi.fn(),
    getChainWithLegs: vi.fn(),
    updateChain: vi.fn(),
    deleteChain: vi.fn(),
    createLeg: vi.fn(),
    updateLeg: vi.fn(),
    deleteLeg: vi.fn(),
    getProgressCounts: vi.fn(),
  };
});

import chainsHandler from '../pyramid/chains.js';
import legsHandler from '../pyramid/legs.js';
import progressHandler from '../pyramid/progress.js';
import { guardOwnerEndpoint } from '../_lib/api-helpers.js';
import {
  createChain,
  getChains,
  getChainWithLegs,
  updateChain,
  deleteChain,
  createLeg,
  updateLeg,
  deleteLeg,
  getProgressCounts,
  PyramidLegOrderError,
} from '../_lib/db-pyramid.js';

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

const chainRow = {
  id: '2026-04-16-MNQ-1',
  trade_date: '2026-04-16',
  instrument: 'MNQ',
  direction: 'long',
  entry_time_ct: null,
  exit_time_ct: null,
  initial_entry_price: null,
  final_exit_price: null,
  exit_reason: null,
  total_legs: 0,
  winning_legs: 0,
  net_points: 0,
  session_atr_pct: null,
  day_type: 'trend',
  higher_tf_bias: null,
  notes: null,
  status: 'open',
  created_at: '2026-04-16T14:30:00Z',
  updated_at: '2026-04-16T14:30:00Z',
};

const legRow = {
  id: 'leg-1',
  chain_id: chainRow.id,
  leg_number: 1,
  signal_type: 'CHoCH',
  entry_time_ct: null,
  entry_price: null,
  stop_price: null,
  stop_distance_pts: 20,
  stop_compression_ratio: 1,
  vwap_at_entry: null,
  vwap_1sd_upper: null,
  vwap_1sd_lower: null,
  vwap_band_position: null,
  vwap_band_distance_pts: null,
  minutes_since_chain_start: null,
  minutes_since_prior_bos: null,
  ob_quality: null,
  relative_volume: null,
  session_phase: null,
  session_high_at_entry: null,
  session_low_at_entry: null,
  retracement_extreme_before_entry: null,
  exit_price: null,
  exit_reason: null,
  points_captured: null,
  r_multiple: null,
  was_profitable: null,
  notes: null,
  created_at: '2026-04-16T14:30:00Z',
  updated_at: '2026-04-16T14:30:00Z',
};

const progressShape = {
  total_chains: 5,
  chains_by_day_type: {
    trend: 2,
    chop: 1,
    news: 1,
    mixed: 1,
    unspecified: 0,
  },
  elapsed_calendar_days: 3,
  fill_rates: { entry_price: 0.8 },
};

function reject401() {
  vi.mocked(guardOwnerEndpoint).mockImplementation(async (_req, res) => {
    res.status(401).json({ error: 'Not authenticated' });
    return true;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(guardOwnerEndpoint).mockResolvedValue(false);
  // Silence the endpoint's console.error on forced-failure tests.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ============================================================
// /api/pyramid/chains
// ============================================================

describe('/api/pyramid/chains', () => {
  it('rejects unsupported methods with 405', async () => {
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'PUT' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when non-owner on every method', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      reject401();
      const res = mockResponse();
      await chainsHandler(mockRequest({ method }), res);
      expect(res._status).toBe(401);
    }
  });

  it('GET lists all chains when no id given', async () => {
    vi.mocked(getChains).mockResolvedValue([chainRow]);
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ chains: [chainRow] });
  });

  it('GET ?id=<id> returns chain with legs', async () => {
    vi.mocked(getChainWithLegs).mockResolvedValue({
      chain: chainRow,
      legs: [legRow],
    });
    const res = mockResponse();
    await chainsHandler(
      mockRequest({ method: 'GET', query: { id: chainRow.id } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ chain: chainRow, legs: [legRow] });
  });

  it('GET ?id=<missing> returns 404', async () => {
    vi.mocked(getChainWithLegs).mockResolvedValue(null);
    const res = mockResponse();
    await chainsHandler(
      mockRequest({ method: 'GET', query: { id: 'nope' } }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'not_found' });
  });

  it('POST creates a chain from a valid body', async () => {
    vi.mocked(createChain).mockResolvedValue(chainRow);
    const res = mockResponse();
    await chainsHandler(
      mockRequest({
        method: 'POST',
        body: { id: chainRow.id, day_type: 'trend' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual(chainRow);
    expect(createChain).toHaveBeenCalledWith(
      expect.objectContaining({ id: chainRow.id, day_type: 'trend' }),
    );
  });

  it('POST rejects invalid enum with 400', async () => {
    const res = mockResponse();
    await chainsHandler(
      mockRequest({
        method: 'POST',
        body: { id: chainRow.id, day_type: 'bogus' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(createChain).not.toHaveBeenCalled();
  });

  it('POST rejects missing id with 400', async () => {
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('PATCH updates a chain when id exists', async () => {
    vi.mocked(updateChain).mockResolvedValue({ ...chainRow, status: 'closed' });
    const res = mockResponse();
    await chainsHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: chainRow.id },
        body: { status: 'closed' },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(updateChain).toHaveBeenCalledWith(
      chainRow.id,
      expect.objectContaining({ status: 'closed' }),
    );
  });

  it('PATCH returns 400 when id query param missing', async () => {
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'PATCH', body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('PATCH returns 404 when chain not found', async () => {
    vi.mocked(updateChain).mockResolvedValue(null);
    const res = mockResponse();
    await chainsHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: 'missing' },
        body: { status: 'closed' },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('PATCH rejects invalid enum with 400', async () => {
    const res = mockResponse();
    await chainsHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: chainRow.id },
        body: { day_type: 'garbage' },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(updateChain).not.toHaveBeenCalled();
  });

  it('DELETE removes a chain and returns ok', async () => {
    vi.mocked(deleteChain).mockResolvedValue(true);
    const res = mockResponse();
    await chainsHandler(
      mockRequest({ method: 'DELETE', query: { id: chainRow.id } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
  });

  it('DELETE returns 404 when id not found', async () => {
    vi.mocked(deleteChain).mockResolvedValue(false);
    const res = mockResponse();
    await chainsHandler(
      mockRequest({ method: 'DELETE', query: { id: 'missing' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('DELETE returns 400 when id missing', async () => {
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'DELETE', query: {} }), res);
    expect(res._status).toBe(400);
  });

  it('returns 500 on unexpected DB error', async () => {
    vi.mocked(getChains).mockRejectedValue(new Error('DB down'));
    const res = mockResponse();
    await chainsHandler(mockRequest({ method: 'GET', query: {} }), res);
    expect(res._status).toBe(500);
  });
});

// ============================================================
// /api/pyramid/legs
// ============================================================

describe('/api/pyramid/legs', () => {
  it('rejects unsupported methods with 405', async () => {
    const res = mockResponse();
    await legsHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when non-owner on every method', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      reject401();
      const res = mockResponse();
      await legsHandler(mockRequest({ method }), res);
      expect(res._status).toBe(401);
    }
  });

  it('POST creates a leg from a valid body', async () => {
    vi.mocked(createLeg).mockResolvedValue(legRow);
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'POST',
        body: {
          id: legRow.id,
          chain_id: legRow.chain_id,
          leg_number: 1,
          signal_type: 'CHoCH',
        },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual(legRow);
  });

  it('POST rejects leg_number < 1 with 400', async () => {
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'POST',
        body: { id: legRow.id, chain_id: legRow.chain_id, leg_number: 0 },
      }),
      res,
    );
    expect(res._status).toBe(400);
    expect(createLeg).not.toHaveBeenCalled();
  });

  it('POST translates PyramidLegOrderError into 409 leg_1_missing', async () => {
    vi.mocked(createLeg).mockRejectedValue(
      new PyramidLegOrderError(legRow.chain_id, 2),
    );
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'POST',
        body: { id: 'leg-2', chain_id: legRow.chain_id, leg_number: 2 },
      }),
      res,
    );
    expect(res._status).toBe(409);
    expect(res._json).toEqual({ error: 'leg_1_missing' });
  });

  it('POST propagates other errors as 500', async () => {
    vi.mocked(createLeg).mockRejectedValue(new Error('DB down'));
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'POST',
        body: { id: legRow.id, chain_id: legRow.chain_id, leg_number: 1 },
      }),
      res,
    );
    expect(res._status).toBe(500);
  });

  it('PATCH updates a leg when id exists', async () => {
    vi.mocked(updateLeg).mockResolvedValue({ ...legRow, entry_price: 17500 });
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: legRow.id },
        body: { entry_price: 17500 },
      }),
      res,
    );
    expect(res._status).toBe(200);
    expect(updateLeg).toHaveBeenCalledWith(
      legRow.id,
      expect.objectContaining({ entry_price: 17500 }),
    );
  });

  it('PATCH returns 404 when leg not found', async () => {
    vi.mocked(updateLeg).mockResolvedValue(null);
    const res = mockResponse();
    await legsHandler(
      mockRequest({
        method: 'PATCH',
        query: { id: 'missing' },
        body: { entry_price: 17500 },
      }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('PATCH returns 400 when id query param missing', async () => {
    const res = mockResponse();
    await legsHandler(mockRequest({ method: 'PATCH', body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('DELETE removes a leg and returns ok', async () => {
    vi.mocked(deleteLeg).mockResolvedValue(true);
    const res = mockResponse();
    await legsHandler(
      mockRequest({ method: 'DELETE', query: { id: legRow.id } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
  });

  it('DELETE returns 404 when id not found', async () => {
    vi.mocked(deleteLeg).mockResolvedValue(false);
    const res = mockResponse();
    await legsHandler(
      mockRequest({ method: 'DELETE', query: { id: 'missing' } }),
      res,
    );
    expect(res._status).toBe(404);
  });

  it('DELETE returns 400 when id missing', async () => {
    const res = mockResponse();
    await legsHandler(mockRequest({ method: 'DELETE', query: {} }), res);
    expect(res._status).toBe(400);
  });
});

// ============================================================
// /api/pyramid/progress
// ============================================================

describe('/api/pyramid/progress', () => {
  it('rejects non-GET with 405', async () => {
    const res = mockResponse();
    await progressHandler(mockRequest({ method: 'POST' }), res);
    expect(res._status).toBe(405);
  });

  it('returns 401 when non-owner', async () => {
    reject401();
    const res = mockResponse();
    await progressHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(401);
  });

  it('GET returns progress counts', async () => {
    vi.mocked(getProgressCounts).mockResolvedValue(progressShape);
    const res = mockResponse();
    await progressHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual(progressShape);
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getProgressCounts).mockRejectedValue(new Error('DB down'));
    const res = mockResponse();
    await progressHandler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(500);
  });
});
