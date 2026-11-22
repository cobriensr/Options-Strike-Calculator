// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockCapture, mockException, mockReport, mockError, eod } = vi.hoisted(
  () => ({
    mockCapture: vi.fn(),
    mockException: vi.fn(),
    mockReport: vi.fn(),
    mockError: vi.fn(),
    eod: {
      fetchEodTickers: vi.fn(),
      listStoredTickers: vi.fn(),
      listTickersStoredOnOrBefore: vi.fn(),
    },
  }),
);

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: mockError },
}));

// cronGuard reports a failed secret check through this module; its own
// test covers what it reports.
vi.mock('../_lib/auth-failure.js', () => ({ reportSecretMismatch: vi.fn() }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockException,
    captureMessage: mockCapture,
  },
  metrics: { uwRateLimit: vi.fn() },
}));
vi.mock('../_lib/axiom.js', () => ({ reportCronRun: mockReport }));
vi.mock('../_lib/gexbot-eod.js', () => eod);

import handler from '../cron/audit-gexbot-eod.js';

const AUTH = { authorization: 'Bearer test-secret' };
const DATE = '2026-10-28';
// Thu 22:30 UTC: the window of Wed 2026-10-28's report closed at 21:00 UTC.
const NOW = new Date('2026-10-29T22:30:00.000Z');

type Json = Record<string, any>;

async function run() {
  const res = mockResponse();
  await handler(mockRequest({ method: 'GET', headers: AUTH }), res);
  return res;
}

function setTickers(tickers: string[], rejected: string[] = []) {
  eod.fetchEodTickers.mockResolvedValue({ tickers, rejected });
}

describe('audit-gexbot-eod', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX', 'NDX']));
    // Every ticker the tests below list has a stored report on or before the
    // audited date, so a missing one is a loss. The new-listing tests
    // override it.
    eod.listTickersStoredOnOrBefore.mockResolvedValue(
      new Set(['SPX', 'NDX', 'QQQ', 'Z', 'A']),
    );
    setTickers(['SPX', 'NDX']);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('rejects a request without the cron secret', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(eod.fetchEodTickers).not.toHaveBeenCalled();
  });

  it('reports success and sends no Sentry message when nothing is missing', async () => {
    const res = await run();
    const body = res._json as Json;
    expect(res._status).toBe(200);
    expect(body).toMatchObject({
      status: 'success',
      date: DATE,
      tickers: 2,
      missing: [],
    });
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  // Real calendar helpers, fixed `now`.
  it.each([
    ['Thu, EDT', '2026-10-29T22:30:00.000Z', '2026-10-28'],
    ['Thu, second run 23:30Z', '2026-10-29T23:30:00.000Z', '2026-10-28'],
    ['Mon, EST', '2026-11-02T22:30:00.000Z', '2026-10-30'],
    [
      'Fri after Thanksgiving (half day)',
      '2026-11-27T22:30:00.000Z',
      '2026-11-25',
    ],
  ])(
    'checks the report whose window just closed: %s',
    async (_n, now, want) => {
      vi.setSystemTime(new Date(now));
      const res = await run();
      expect(eod.listStoredTickers).toHaveBeenCalledWith(want);
      expect(eod.listTickersStoredOnOrBefore).toHaveBeenCalledWith(want);
      expect((res._json as Json).date).toBe(want);
    },
  );

  it('skips with no other call on a market holiday', async () => {
    // Thanksgiving 2026-11-26: no window closed today.
    vi.setSystemTime(new Date('2026-11-26T22:30:00.000Z'));
    const res = await run();
    const body = res._json as Json;
    expect(res._status).toBe(200);
    expect(body.status).toBe('skipped');
    expect(body.message).toBe('no download window closed today');
    expect(eod.fetchEodTickers).not.toHaveBeenCalled();
    expect(eod.listStoredTickers).not.toHaveBeenCalled();
    expect(eod.listTickersStoredOnOrBefore).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('returns error and alerts once when tickers are missing', async () => {
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    setTickers(['SPX', 'NDX', 'QQQ']);
    const res = await run();
    const body = res._json as Json;
    expect(body.status).toBe('error');
    expect(body.missing).toEqual(['NDX', 'QQQ']);
    expect(body.message).toContain(DATE);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      `GEXBot EOD reports lost for ${DATE}: 2 tickers (download window closed; automatic retries could not capture them)`,
      {
        level: 'error',
        fingerprint: ['gexbot-eod', 'missed-window'],
        extra: { date: DATE, missing: ['NDX', 'QQQ'] },
      },
    );
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ date: DATE, missing: ['NDX', 'QQQ'] }),
      expect.any(String),
    );
  });

  it('keeps /tickers priority order in missing', async () => {
    setTickers(['Z', 'SPX', 'A', 'NDX']);
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    const res = await run();
    expect((res._json as Json).missing).toEqual(['Z', 'A', 'NDX']);
  });

  it('stays success with rejected tickers reported as information only', async () => {
    setTickers(['SPX', 'NDX'], ['bad/ticker']);
    const res = await run();
    const body = res._json as Json;
    expect(body.status).toBe('success');
    expect(body.rejectedTickers).toEqual(['bad/ticker']);
    expect(body.missing).toEqual([]);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      'GEXBot EOD tickers rejected by the charset: bad/ticker',
      {
        level: 'warning',
        fingerprint: ['gexbot-eod', 'rejected-tickers'],
        extra: { date: DATE, rejected: ['bad/ticker'] },
      },
    );
  });

  it('sends both the rejected-tickers warning and the missed-window error', async () => {
    setTickers(['SPX', 'NDX'], ['a b', 'c d']);
    eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
    const res = await run();
    expect((res._json as Json).status).toBe('error');
    const fingerprints = mockCapture.mock.calls.map(
      ([, o]) => (o as { fingerprint: string[] }).fingerprint[1],
    );
    expect(fingerprints).toEqual(['rejected-tickers', 'missed-window']);
  });

  it('surfaces a /tickers failure as a thrown error', async () => {
    eod.fetchEodTickers.mockRejectedValue(
      new Error('gexbot_tickers_failed: HTTP 503'),
    );
    const res = await run();
    expect(res._status).toBe(500);
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('surfaces a DB rejection as a thrown error', async () => {
    eod.listStoredTickers.mockRejectedValue(new Error('connection lost'));
    const res = await run();
    expect(res._status).toBe(500);
    expect(mockException).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      'audit-gexbot-eod',
      expect.objectContaining({ status: 'error' }),
    );
  });

  // Spec Amendment 2: a listed ticker with no stored report on or before the
  // audited date is a new listing, not a loss.
  describe('a listed ticker with no captured report yet', () => {
    const NEW_LISTING_FP = ['gexbot-eod', 'new-listing'];
    const MISSED_FP = ['gexbot-eod', 'missed-window'];

    function fingerprints(): string[] {
      return mockCapture.mock.calls.map(
        ([, o]) => (o as { fingerprint: string[] }).fingerprint[1] ?? '',
      );
    }

    it('lists a never-stored ticker under newListings: success, one warning, not missing', async () => {
      setTickers(['SPX', 'NDX', 'ANT']);
      eod.listStoredTickers.mockResolvedValue(new Set(['SPX', 'NDX']));
      eod.listTickersStoredOnOrBefore.mockResolvedValue(
        new Set(['SPX', 'NDX']),
      );
      const res = await run();
      const body = res._json as Json;
      expect(body.status).toBe('success');
      expect(body.newListings).toEqual(['ANT']);
      expect(body.missing).toEqual([]);
      expect(body.tickers).toBe(3);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(
        'GEXBot lists tickers with no captured report yet: ANT',
        {
          level: 'warning',
          fingerprint: NEW_LISTING_FP,
          extra: { date: DATE, newListings: ['ANT'] },
        },
      );
      expect(mockError).not.toHaveBeenCalled();
      expect(mockReport).toHaveBeenCalledWith(
        'audit-gexbot-eod',
        expect.objectContaining({ status: 'success' }),
      );
      expect(eod.listTickersStoredOnOrBefore).toHaveBeenCalledTimes(1);
    });

    it('sends one warning for several new listings, in /tickers order', async () => {
      setTickers(['SPX', 'B2', 'NDX', 'B1']);
      eod.listStoredTickers.mockResolvedValue(new Set(['SPX', 'NDX']));
      eod.listTickersStoredOnOrBefore.mockResolvedValue(
        new Set(['SPX', 'NDX']),
      );
      const body = (await run())._json as Json;
      expect(body.newListings).toEqual(['B2', 'B1']);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(
        'GEXBot lists tickers with no captured report yet: B2, B1',
        expect.objectContaining({ fingerprint: NEW_LISTING_FP }),
      );
    });

    it('sends no new-listing warning when every listed ticker was stored before', async () => {
      const body = (await run())._json as Json;
      expect(body.newListings).toEqual([]);
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it('asks "stored before" for the audited date and treats a ticker first stored after it as new', async () => {
      setTickers(['SPX', 'NDX', 'ANT']);
      eod.listStoredTickers.mockResolvedValue(new Set(['SPX', 'NDX']));
      // ANT's first report is dated after DATE: stored on or before any later
      // date, but not on or before DATE.
      eod.listTickersStoredOnOrBefore.mockImplementation(async (d: string) =>
        d === DATE ? new Set(['SPX', 'NDX']) : new Set(['SPX', 'NDX', 'ANT']),
      );
      const body = (await run())._json as Json;
      expect(eod.listTickersStoredOnOrBefore).toHaveBeenCalledWith(DATE);
      expect(body.status).toBe('success');
      expect(body.newListings).toEqual(['ANT']);
      expect(body.missing).toEqual([]);
    });

    it('still reports a ticker stored before and missing on the date as lost', async () => {
      setTickers(['SPX', 'ROKU']);
      eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
      eod.listTickersStoredOnOrBefore.mockResolvedValue(
        new Set(['SPX', 'ROKU']),
      );
      const body = (await run())._json as Json;
      expect(body.status).toBe('error');
      expect(body.missing).toEqual(['ROKU']);
      expect(body.newListings).toEqual([]);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockCapture).toHaveBeenCalledWith(
        expect.stringContaining('lost'),
        expect.objectContaining({
          level: 'error',
          fingerprint: MISSED_FP,
        }),
      );
    });

    it('splits one run: the lost ticker is an error, the new listing a warning', async () => {
      setTickers(['SPX', 'ROKU', 'ANT']);
      eod.listStoredTickers.mockResolvedValue(new Set(['SPX']));
      eod.listTickersStoredOnOrBefore.mockResolvedValue(
        new Set(['SPX', 'ROKU']),
      );
      const body = (await run())._json as Json;
      expect(body.status).toBe('error');
      expect(body.missing).toEqual(['ROKU']);
      expect(body.newListings).toEqual(['ANT']);
      expect(body.message).toContain('1 tickers');
      expect(fingerprints().sort()).toEqual(['missed-window', 'new-listing']);
      expect(mockCapture).toHaveBeenCalledWith(
        'GEXBot lists tickers with no captured report yet: ANT',
        expect.objectContaining({ level: 'warning' }),
      );
    });

    it('throws when the stored-before set lacks SPX, reporting nothing', async () => {
      // An emptied or badly restored table would put every ticker under
      // newListings, and a total loss would read as success.
      setTickers(['SPX', 'NDX'], ['bad/ticker']);
      eod.listStoredTickers.mockResolvedValue(new Set());
      eod.listTickersStoredOnOrBefore.mockResolvedValue(new Set());
      const res = await run();
      expect(res._status).toBe(500);
      expect(mockException).toHaveBeenCalledTimes(1);
      const [err] = mockException.mock.calls[0] as [Error];
      expect(err.message).toContain('SPX');
      expect(mockReport).toHaveBeenCalledWith(
        'audit-gexbot-eod',
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it('surfaces a rejected stored-before query as a thrown error', async () => {
      eod.listTickersStoredOnOrBefore.mockRejectedValue(
        new Error('connection lost'),
      );
      const res = await run();
      expect(res._status).toBe(500);
      expect(mockException).toHaveBeenCalledTimes(1);
      expect(mockReport).toHaveBeenCalledWith(
        'audit-gexbot-eod',
        expect.objectContaining({ status: 'error' }),
      );
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });
});
