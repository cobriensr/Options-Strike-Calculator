// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockSentry } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockSentry: { captureMessage: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));
vi.mock('../_lib/sentry.js', () => ({ Sentry: mockSentry }));

import {
  fetchDayFeatures,
  fetchDaySummary,
  sidecarArchiveHeaders,
} from '../_lib/archive-sidecar.js';

function okSummary() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ date: '2024-08-05', summary: 'x' }),
  } as Response;
}

function refused(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'unauthorized' }),
  } as Response;
}

/** The RequestInit of the nth fetch call. */
function initOf(spy: ReturnType<typeof vi.spyOn>, n = 0): RequestInit {
  return (spy.mock.calls[n]?.[1] ?? {}) as RequestInit;
}

describe('archive-sidecar', () => {
  const originalUrl = process.env.SIDECAR_URL;
  const originalSecret = process.env.SIDECAR_TAKEIT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SIDECAR_URL = 'https://sidecar.example';
    process.env.SIDECAR_TAKEIT_SECRET = 's3cret';
  });

  afterEach(() => {
    process.env.SIDECAR_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SIDECAR_TAKEIT_SECRET;
    else process.env.SIDECAR_TAKEIT_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  describe('sidecarArchiveHeaders', () => {
    it('returns the bearer when SIDECAR_TAKEIT_SECRET is set', () => {
      expect(sidecarArchiveHeaders()).toEqual({
        Authorization: 'Bearer s3cret',
      });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it.each([undefined, ''])(
      'returns no header and warns when SIDECAR_TAKEIT_SECRET is %j',
      (value) => {
        if (value === undefined) delete process.env.SIDECAR_TAKEIT_SECRET;
        else process.env.SIDECAR_TAKEIT_SECRET = value;

        expect(sidecarArchiveHeaders()).toEqual({});
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(String(mockLogger.warn.mock.calls[0]?.[0])).toContain(
          'SIDECAR_TAKEIT_SECRET',
        );
      },
    );
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

  it('sends the sidecar bearer on archive requests', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okSummary());

    await fetchDaySummary('2024-08-05');

    expect(initOf(spy).headers).toEqual({ Authorization: 'Bearer s3cret' });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('sends no Authorization header and warns when the secret is unset', async () => {
    delete process.env.SIDECAR_TAKEIT_SECRET;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okSummary());

    expect(await fetchDaySummary('2024-08-05')).toBe('x');

    expect(initOf(spy).headers).toEqual({});
    expect(String(mockLogger.warn.mock.calls[0]?.[0])).toContain(
      'SIDECAR_TAKEIT_SECRET',
    );
  });

  it.each([
    [401, 'fetchDaySummary', () => fetchDaySummary('2024-08-05')],
    [403, 'fetchDaySummary', () => fetchDaySummary('2024-08-05')],
    [401, 'fetchDayFeatures', () => fetchDayFeatures('2024-08-05')],
  ] as const)(
    'returns null and raises archive_sidecar.unauthorized on a %i (%s)',
    async (status, _name, call) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refused(status));

      expect(await call()).toBeNull();

      expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(mockSentry.captureMessage).toHaveBeenCalledWith(
        'archive_sidecar.unauthorized',
        expect.objectContaining({
          level: 'warning',
          fingerprint: ['archive_sidecar.unauthorized'],
          extra: expect.objectContaining({ status }),
        }),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        expect.stringContaining('refused'),
      );
    },
  );

  it('returns null on a non-auth non-2xx without a Sentry event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'no data' }),
    } as Response);

    expect(await fetchDaySummary('1999-12-31')).toBeNull();
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404 }),
      'Sidecar archive fetch returned non-2xx',
    );
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
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Sidecar archive fetch failed',
    );
  });

  it('returns null and warns when a 2xx body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    } as unknown as Response);

    expect(await fetchDaySummary('2024-08-05')).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(SyntaxError) }),
      'Sidecar archive fetch failed',
    );
  });

  it('returns the vector when fetchDayFeatures gets a 200 with an array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ date: '2024-08-05', dim: 2, vector: [0.1, -0.2] }),
    } as Response);

    expect(await fetchDayFeatures('2024-08-05')).toEqual([0.1, -0.2]);
  });

  it('returns null when fetchDayFeatures gets a 200 whose vector is not an array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ vector: 'x' }),
    } as Response);

    expect(await fetchDayFeatures('2024-08-05')).toBeNull();
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

  it('returns null when the sidecar exceeds the 2s timeout', async () => {
    // Simulate a sidecar that never responds (common sign of a hung
    // worker) and confirm the fetcher aborts + returns null rather than
    // letting the caller stall.
    //
    // We wire a Promise that rejects with an AbortError when the
    // AbortSignal fires, mirroring how `fetch()` actually behaves when
    // its signal aborts. Fake timers drive the 2000ms clock without
    // burning real wall time.
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener('abort', () => {
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            });
          }),
      );

      const promise = fetchDaySummary('2024-08-05');
      // Advance past the 2000ms AbortSignal timeout wired in
      // archive-sidecar.getJson.
      await vi.advanceTimersByTimeAsync(2100);
      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
