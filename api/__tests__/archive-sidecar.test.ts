import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDaySummary,
  fetchTbboDayMicrostructure,
  fetchTbboOfiPercentile,
} from '../_lib/archive-sidecar.js';

describe('archive-sidecar', () => {
  const originalEnv = process.env.SIDECAR_URL;

  beforeEach(() => {
    process.env.SIDECAR_URL = 'https://sidecar.example';
  });

  afterEach(() => {
    process.env.SIDECAR_URL = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns the summary when the sidecar responds 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        date: '2024-08-05',
        summary: '2024-08-05 ESU4 | open 5324.00 | ...',
      }),
    } as Response);

    const result = await fetchDaySummary('2024-08-05');
    expect(result).toBe('2024-08-05 ESU4 | open 5324.00 | ...');
  });

  it('returns null on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no data' }),
    } as Response);

    expect(await fetchDaySummary('1999-12-31')).toBeNull();
  });

  it('returns null when SIDECAR_URL is unset', async () => {
    delete process.env.SIDECAR_URL;
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchDaySummary('2024-08-05')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null and does not throw on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('socket hang up'),
    );
    expect(await fetchDaySummary('2024-08-05')).toBeNull();
  });

  it('URL-encodes the date parameter', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ date: '2024-08-05', summary: 'x' }),
    } as Response);

    await fetchDaySummary('2024-08-05');
    expect(spy).toHaveBeenCalledWith(
      'https://sidecar.example/archive/day-summary?date=2024-08-05',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // ── TBBO day microstructure (Phase 4b) ──────────────────────────

  describe('fetchTbboDayMicrostructure', () => {
    it('returns the feature dict on 200', async () => {
      const body = {
        date: '2025-10-15',
        symbol: 'ES' as const,
        front_month_contract: 'ESZ5',
        trade_count: 676_965,
        ofi_5m_mean: 0.011,
        ofi_15m_mean: 0.014,
        ofi_1h_mean: 0.017,
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response);

      const result = await fetchTbboDayMicrostructure('2025-10-15', 'ES');
      expect(result).toEqual(body);
    });

    it('returns null on 404 (date missing from archive)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'no data' }),
      } as Response);
      expect(await fetchTbboDayMicrostructure('1999-12-31', 'ES')).toBeNull();
    });

    it('returns null when SIDECAR_URL is unset', async () => {
      delete process.env.SIDECAR_URL;
      const spy = vi.spyOn(globalThis, 'fetch');
      expect(await fetchTbboDayMicrostructure('2025-10-15', 'ES')).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns null and does not throw on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('socket hang up'),
      );
      expect(await fetchTbboDayMicrostructure('2025-10-15', 'NQ')).toBeNull();
    });

    it('passes date + symbol as query params with abort signal', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          date: '2025-10-15',
          symbol: 'NQ',
          front_month_contract: 'NQZ5',
          trade_count: 0,
          ofi_5m_mean: null,
          ofi_15m_mean: null,
          ofi_1h_mean: null,
        }),
      } as Response);

      await fetchTbboDayMicrostructure('2025-10-15', 'NQ');
      expect(spy).toHaveBeenCalledWith(
        'https://sidecar.example/archive/tbbo-day-microstructure?date=2025-10-15&symbol=NQ',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // ── TBBO OFI percentile (Phase 4b) ─────────────────────────────

  describe('fetchTbboOfiPercentile', () => {
    it('returns the percentile body on 200', async () => {
      const body = {
        symbol: 'NQ' as const,
        window: '1h' as const,
        current_value: 0.38,
        percentile: 92.1,
        mean: 0.02,
        std: 0.09,
        count: 252,
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response);
      const result = await fetchTbboOfiPercentile('NQ', 0.38, '1h');
      expect(result).toEqual(body);
    });

    it('returns null on 404 (no history available)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'no history' }),
      } as Response);
      expect(await fetchTbboOfiPercentile('ES', 0.1, '1h')).toBeNull();
    });

    it('returns null without fetching when value is non-finite', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      expect(await fetchTbboOfiPercentile('ES', Number.NaN, '1h')).toBeNull();
      expect(
        await fetchTbboOfiPercentile('ES', Number.POSITIVE_INFINITY, '1h'),
      ).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('defaults window to 1h when omitted', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          symbol: 'ES',
          window: '1h',
          current_value: 0,
          percentile: 50,
          mean: 0,
          std: 0,
          count: 1,
        }),
      } as Response);
      await fetchTbboOfiPercentile('ES', 0);
      expect(spy).toHaveBeenCalledWith(
        'https://sidecar.example/archive/tbbo-ofi-percentile?symbol=ES&value=0&window=1h',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('returns null and does not throw on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('socket hang up'),
      );
      expect(await fetchTbboOfiPercentile('NQ', 0.1, '1h')).toBeNull();
    });
  });
});
