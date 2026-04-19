import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDaySummary } from '../_lib/archive-sidecar.js';

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
});
