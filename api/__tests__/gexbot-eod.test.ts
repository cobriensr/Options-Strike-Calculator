// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockPut, mockHead, mockRetry } = vi.hoisted(() => ({
  mockRetry: vi.fn(),
  mockSql: vi.fn(),
  mockPut: vi.fn(),
  mockHead: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: mockRetry,
}));
vi.mock('../_lib/r2.js', () => ({
  r2PutObject: mockPut,
  r2HeadObject: mockHead,
}));

import {
  EOD_PRIORITY,
  eodKey,
  fetchEodTickers,
  indexExistingObject,
  latestEligibleReportDate,
  listStoredTickers,
  parseEodDisposition,
  requestEodReport,
  storeEodReport,
} from '../_lib/gexbot-eod.js';
import { GEXBOT_TICKERS } from '../_lib/gexbot-client.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mockRetry.mockImplementation((fn: () => Promise<unknown>) => fn());
  mockSql.mockResolvedValue([]);
  vi.stubGlobal('fetch', fetchMock);
});

function etInstant(date: string, hour: number, minute: number): Date {
  const iso = etWallClockToUtcIso(date, hour * 60 + minute);
  if (iso == null) throw new Error('bad test instant');
  return new Date(iso);
}

describe('latestEligibleReportDate', () => {
  it.each([
    ['2026-10-29', 16, 59, '2026-10-28'],
    ['2026-10-29', 17, 0, '2026-10-29'],
    ['2026-10-31', 12, 0, '2026-10-30'],
    ['2026-11-02', 9, 0, '2026-10-30'],
    ['2026-11-26', 20, 0, '2026-11-25'],
    ['2026-11-27', 18, 0, '2026-11-27'],
  ])('%s %i:%i ET -> %s', (date, h, m, expected) => {
    expect(latestEligibleReportDate(etInstant(date, h, m))).toBe(expected);
  });
});

describe('parseEodDisposition', () => {
  it.each([
    [
      'attachment; filename=eod_report_SPX_2026-10-28.zip',
      { ticker: 'SPX', date: '2026-10-28' },
    ],
    [
      'attachment; filename="eod_report_SPX_2026-10-28.zip"',
      { ticker: 'SPX', date: '2026-10-28' },
    ],
    [
      "attachment; filename*=UTF-8''eod_report_SPX_2026-10-28.zip",
      { ticker: 'SPX', date: '2026-10-28' },
    ],
    [
      'attachment; filename=eod_report_ES_SPX_2026-10-28.zip',
      { ticker: 'ES_SPX', date: '2026-10-28' },
    ],
  ])('parses %s', (header, expected) => {
    expect(parseEodDisposition(header)).toEqual(expected);
  });

  it.each([
    [null],
    [''],
    ['attachment'],
    ['attachment; filename=junk.zip'],
    ['attachment; filename=eod_report_spx_2026-10-28.zip'],
    ['attachment; filename=eod_report_SPX_2026-10-28.csv'],
    ['attachment; filename=eod_report_SPX_26-10-28.zip'],
    ['attachment; x-filename=eod_report_SPX_2026-10-28.zip'],
    ['x-filename=eod_report_SPX_2026-10-28.zip'],
  ])('returns null for %s', (header) => {
    expect(parseEodDisposition(header)).toBeNull();
  });
});

describe('eodKey', () => {
  it('builds the R2 key', () => {
    expect(eodKey('ES_SPX', '2026-10-28')).toBe(
      'gexbot-eod/ES_SPX/2026-10-28.zip',
    );
  });
});

describe('fetchEodTickers', () => {
  function tickersResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it('orders priority first, then alphabetical, deduped', async () => {
    fetchMock.mockResolvedValueOnce(
      tickersResponse({
        stocks: ['ZZZ', 'AAPL', 'QQQ', 'SPY', 'AAPL'],
        indexes: ['VIX', 'SPX', 'NDX'],
        futures: ['NQ_NDX', 'ES_SPX'],
      }),
    );
    const out = await fetchEodTickers();
    expect(out.tickers).toEqual([
      'SPX',
      'ES_SPX',
      'NDX',
      'NQ_NDX',
      'VIX',
      'SPY',
      'QQQ',
      'AAPL',
      'ZZZ',
    ]);
    expect(out.rejected).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.gex.bot/v2/tickers');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects tickers outside the charset and never lists them', async () => {
    fetchMock.mockResolvedValueOnce(
      tickersResponse({
        stocks: ['BAD TICKER', 'AAPL', '../x'],
        indexes: ['SPX'],
        futures: [],
      }),
    );
    const out = await fetchEodTickers();
    expect(out.tickers).toEqual(['SPX', 'AAPL']);
    expect(out.rejected).toEqual(['BAD TICKER', '../x']);
  });

  it('throws on an empty list', async () => {
    fetchMock.mockResolvedValueOnce(
      tickersResponse({ stocks: [], indexes: [], futures: [] }),
    );
    await expect(fetchEodTickers()).rejects.toThrow(
      'gexbot_tickers_failed: implausible list (0 tickers)',
    );
  });

  it('throws when the list has no SPX', async () => {
    fetchMock.mockResolvedValueOnce(
      tickersResponse({ stocks: ['AAPL'], indexes: ['NDX'], futures: [] }),
    );
    await expect(fetchEodTickers()).rejects.toThrow(
      'gexbot_tickers_failed: implausible list (2 tickers)',
    );
  });

  it('throws gexbot_tickers_failed on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(tickersResponse({}, 503));
    await expect(fetchEodTickers()).rejects.toThrow(/gexbot_tickers_failed/);
  });

  it('throws gexbot_tickers_failed when a group is not a string array', async () => {
    fetchMock.mockResolvedValueOnce(
      tickersResponse({ stocks: [1, 2], indexes: [], futures: [] }),
    );
    await expect(fetchEodTickers()).rejects.toThrow(/gexbot_tickers_failed/);
  });

  it('throws gexbot_tickers_failed on invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(fetchEodTickers()).rejects.toThrow(
      'gexbot_tickers_failed: invalid JSON',
    );
  });

  it('throws gexbot_tickers_failed when a group is missing', async () => {
    fetchMock.mockResolvedValueOnce(tickersResponse({ stocks: ['A'] }));
    await expect(fetchEodTickers()).rejects.toThrow(/gexbot_tickers_failed/);
  });

  it('exposes the priority list verbatim', () => {
    expect(EOD_PRIORITY[0]).toBe('SPX');
    expect(EOD_PRIORITY).toHaveLength(16);
  });

  it('keeps the original 16-name priority order, now sourced from GEXBOT_TICKERS', () => {
    expect([...GEXBOT_TICKERS]).toEqual([
      'SPX',
      'ES_SPX',
      'NDX',
      'NQ_NDX',
      'RUT',
      'VIX',
      'SPY',
      'QQQ',
      'IWM',
      'TLT',
      'GLD',
      'USO',
      'TQQQ',
      'UVXY',
      'HYG',
      'SLV',
    ]);
    expect(EOD_PRIORITY).toEqual([...GEXBOT_TICKERS]);
  });

  it.each([['..'], ['.A'], ['A'.repeat(17)], ['_A']])(
    'rejects ticker %s',
    async (bad) => {
      fetchMock.mockResolvedValueOnce(
        tickersResponse({ stocks: [bad], indexes: ['SPX'], futures: [] }),
      );
      const out = await fetchEodTickers();
      expect(out.rejected).toEqual([bad]);
      expect(out.tickers).toEqual(['SPX']);
    },
  );

  it.each([['ES_SPX'], ['BRK.B'], ['A'], ['A'.repeat(16)]])(
    'accepts ticker %s',
    async (good) => {
      fetchMock.mockResolvedValueOnce(
        tickersResponse({ stocks: [good], indexes: ['SPX'], futures: [] }),
      );
      const out = await fetchEodTickers();
      expect(out.rejected).toEqual([]);
      expect(out.tickers).toContain(good);
    },
  );
});

describe('requestEodReport', () => {
  const signal = new AbortController().signal;

  function zipResponse(
    opts: {
      status?: number;
      disposition?: string | null;
      type?: string;
      length?: string | null;
      body?: ConstructorParameters<typeof Response>[0];
    } = {},
  ): Response {
    const headers = new Headers();
    if (opts.disposition !== null) {
      headers.set(
        'Content-Disposition',
        opts.disposition ??
          'attachment; filename=eod_report_SPX_2026-10-28.zip',
      );
    }
    headers.set('Content-Type', opts.type ?? 'application/zip');
    if (opts.length !== null) headers.set('Content-Length', opts.length ?? '5');
    return new Response(
      opts.body === undefined ? new Uint8Array(5) : opts.body,
      {
        status: opts.status ?? 200,
        headers,
      },
    );
  }

  it('sends the auth header to the hist/eod URL', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse());
    await requestEodReport('k', 'SPX', signal);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.gex.bot/v2/hist/eod/SPX');
    expect(init.signal).toBe(signal);
    expect(
      (init.headers as Record<string, string>).Authorization ??
        (init.headers as Record<string, string>).authorization,
    ).toMatch(/^Bearer /);
  });

  it('maps 429 to quota and cancels the body', async () => {
    const res = zipResponse({ status: 429 });
    const cancel = vi.spyOn(res.body as ReadableStream, 'cancel');
    fetchMock.mockResolvedValueOnce(res);
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'quota',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('maps 503 to http_error with status', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ status: 503 }));
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'http_error',
      status: 503,
    });
  });

  it('flags a disposition for another ticker (Review Focus 2)', async () => {
    const res = zipResponse({
      disposition: 'attachment; filename=eod_report_QQQ_2026-10-28.zip',
    });
    const cancel = vi.spyOn(res.body as ReadableStream, 'cancel');
    fetchMock.mockResolvedValueOnce(res);
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'bad_response',
      reason: 'bad_disposition',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('flags a missing disposition', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ disposition: null }));
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'bad_response',
      reason: 'bad_disposition',
    });
  });

  it('flags a non-zip content type', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ type: 'text/html' }));
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'bad_response',
      reason: 'bad_content_type',
    });
  });

  it.each([
    [null],
    ['0'],
    ['abc'],
    ['-3'],
    ['1.5'],
    ['1e3'],
    ['0x10'],
    [String(300 * 1024 * 1024 + 1)],
  ])('flags content-length %s as no_length', async (length) => {
    fetchMock.mockResolvedValueOnce(zipResponse({ length }));
    expect(await requestEodReport('k', 'SPX', signal)).toEqual({
      kind: 'bad_response',
      reason: 'no_length',
    });
  });

  it.each([[' 5'], ['5 ']])(
    'flags raw content-length %j as no_length',
    async (raw) => {
      // Headers trims whitespace, so hand back a raw header value.
      const res = zipResponse();
      vi.spyOn(res.headers, 'get').mockImplementation((name: string) =>
        name.toLowerCase() === 'content-length'
          ? raw
          : Headers.prototype.get.call(zipResponse().headers, name),
      );
      fetchMock.mockResolvedValueOnce(res);
      expect(await requestEodReport('k', 'SPX', signal)).toEqual({
        kind: 'bad_response',
        reason: 'no_length',
      });
    },
  );

  it('accepts a content-length exactly at the cap', async () => {
    fetchMock.mockResolvedValueOnce(
      zipResponse({ length: String(300 * 1024 * 1024) }),
    );
    const res = await requestEodReport('k', 'SPX', signal);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') await res.discard();
  });

  it('returns ok with the served date and reads the body', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ length: '5' }));
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.servedDate).toBe('2026-10-28');
    expect(res.contentLength).toBe(5);
    expect((await res.readBody()).length).toBe(5);
  });

  it('assembles a multi-chunk body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.enqueue(new Uint8Array([4, 5]));
        c.close();
      },
    });
    fetchMock.mockResolvedValueOnce(zipResponse({ length: '5', body: stream }));
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect([...(await res.readBody())]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a short body with truncated', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ length: '10' }));
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    await expect(res.readBody()).rejects.toThrow(
      'truncated: got 5 of 10 bytes',
    );
  });

  it('rejects an overflowing body with truncated', async () => {
    fetchMock.mockResolvedValueOnce(zipResponse({ length: '3' }));
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    await expect(res.readBody()).rejects.toThrow(
      /^truncated: got \d+ of 3 bytes/,
    );
  });

  it('propagates a mid-stream abort error as-is', async () => {
    const boom = new Error('aborted mid-stream');
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(boom);
      },
    });
    fetchMock.mockResolvedValueOnce(zipResponse({ length: '5', body: stream }));
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    await expect(res.readBody()).rejects.toBe(boom);
  });

  it('discard cancels the body, and swallows a cancel rejection', async () => {
    const res0 = zipResponse();
    const cancel = vi
      .spyOn(res0.body as ReadableStream, 'cancel')
      .mockRejectedValue(new Error('cancel failed'));
    fetchMock.mockResolvedValueOnce(res0);
    const res = await requestEodReport('k', 'SPX', signal);
    if (res.kind !== 'ok') throw new Error('expected ok');
    await expect(res.discard()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it('propagates a fetch rejection', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(requestEodReport('k', 'SPX', signal)).rejects.toThrow(
      'network down',
    );
  });
});

describe('storeEodReport', () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(body).digest('hex');
  // eslint-disable-next-line sonarjs/hashing -- R2 ETag is MD5
  const md5 = createHash('md5').update(body).digest('hex');
  const args = { ticker: 'SPX', date: '2026-10-28', body, entryCount: 15 };

  function goodHead() {
    return { contentLength: 4, etag: md5, metadata: { sha256 } };
  }

  it('puts with exactly the 7 metadata keys, verifies, inserts', async () => {
    mockPut.mockResolvedValueOnce(undefined);
    mockHead.mockResolvedValueOnce(goodHead());
    const out = await storeEodReport(args);
    expect(out).toEqual({
      key: 'gexbot-eod/SPX/2026-10-28.zip',
      sha256,
      bytes: 4,
    });
    const [key, sent, opts] = mockPut.mock.calls[0] as [
      string,
      Uint8Array,
      { contentType: string; metadata: Record<string, string> },
    ];
    expect(key).toBe('gexbot-eod/SPX/2026-10-28.zip');
    expect(sent).toBe(body);
    expect(opts.contentType).toBe('application/zip');
    expect(Object.keys(opts.metadata).sort()).toEqual(
      [
        'entry-count',
        'fetched-at',
        'report-date',
        'sha256',
        'source',
        'source-content-length',
        'ticker',
      ].sort(),
    );
    expect(opts.metadata).toMatchObject({
      sha256,
      ticker: 'SPX',
      'report-date': '2026-10-28',
      'entry-count': '15',
      'source-content-length': '4',
      source: 'cron',
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
    const values = mockSql.mock.calls[0]?.slice(1);
    expect(values).toEqual([
      'SPX',
      '2026-10-28',
      'gexbot-eod/SPX/2026-10-28.zip',
      4,
      sha256,
      15,
      'cron',
      opts.metadata['fetched-at'],
    ]);
    const sqlText = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
    expect(sqlText).toContain('ON CONFLICT (ticker, report_date) DO NOTHING');
  });

  it.each([
    ['length', { ...{ contentLength: 5, etag: md5, metadata: { sha256 } } }],
    ['etag', { contentLength: 4, etag: 'deadbeef', metadata: { sha256 } }],
    ['sha256', { contentLength: 4, etag: md5, metadata: { sha256: 'other' } }],
    ['null', null],
  ])(
    'throws r2_verify_failed on %s mismatch and inserts nothing',
    async (_n, head) => {
      mockPut.mockResolvedValueOnce(undefined);
      mockHead.mockResolvedValueOnce(head);
      await expect(storeEodReport(args)).rejects.toThrow(/^r2_verify_failed: /);
      expect(mockSql).not.toHaveBeenCalled();
    },
  );

  it('propagates an R2 put failure without inserting', async () => {
    mockPut.mockRejectedValueOnce(new Error('r2 down'));
    await expect(storeEodReport(args)).rejects.toThrow('r2 down');
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('propagates a DB reject', async () => {
    mockPut.mockResolvedValueOnce(undefined);
    mockHead.mockResolvedValueOnce(goodHead());
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    await expect(storeEodReport(args)).rejects.toThrow('connection lost');
  });

  it('bounds the insert with retries and a per-attempt timeout', async () => {
    mockPut.mockResolvedValueOnce(undefined);
    mockHead.mockResolvedValueOnce(goodHead());
    await storeEodReport(args);
    expect(mockRetry).toHaveBeenCalledWith(expect.any(Function), 2, 10_000);
  });
});

describe('indexExistingObject', () => {
  const meta = {
    sha256: 'abc',
    ticker: 'SPX',
    'report-date': '2026-10-28',
    'entry-count': '15',
    'source-content-length': '99',
    source: 'rescue-2026-10-28',
    'fetched-at': '2026-10-28T23:05:00.000Z',
  };

  it('inserts from metadata', async () => {
    mockHead.mockResolvedValueOnce({
      contentLength: 99,
      etag: 'x',
      metadata: meta,
    });
    expect(await indexExistingObject('SPX', '2026-10-28')).toBe('indexed');
    const values = mockSql.mock.calls[0]?.slice(1);
    expect(values).toEqual([
      'SPX',
      '2026-10-28',
      'gexbot-eod/SPX/2026-10-28.zip',
      99,
      'abc',
      15,
      'rescue-2026-10-28',
      '2026-10-28T23:05:00.000Z',
    ]);
    const sqlText = (mockSql.mock.calls[0]?.[0] as string[]).join('?');
    expect(sqlText).toContain('ON CONFLICT (ticker, report_date) DO NOTHING');
  });

  it('falls back to the DB default when fetched-at is unparseable', async () => {
    mockHead.mockResolvedValueOnce({
      contentLength: 99,
      etag: 'x',
      metadata: { ...meta, 'fetched-at': 'garbage' },
    });
    await indexExistingObject('SPX', '2026-10-28');
    expect(mockSql.mock.calls[0]?.slice(1).at(-1)).toBeNull();
  });

  it('returns absent on a null head', async () => {
    mockHead.mockResolvedValueOnce(null);
    expect(await indexExistingObject('SPX', '2026-10-28')).toBe('absent');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it.each([
    ['sha256', { ...meta, sha256: undefined }],
    ['entry-count', { ...meta, 'entry-count': undefined }],
    ['source', { ...meta, source: undefined }],
    ['bad entry-count', { ...meta, 'entry-count': 'abc' }],
    ['zero entry-count', { ...meta, 'entry-count': '0' }],
    [
      'no source-content-length',
      { ...meta, 'source-content-length': undefined },
    ],
    ['length mismatch', { ...meta, 'source-content-length': '98' }],
    ['no ticker', { ...meta, ticker: undefined }],
    ['ticker mismatch', { ...meta, ticker: 'QQQ' }],
    ['no report-date', { ...meta, 'report-date': undefined }],
    ['report-date mismatch', { ...meta, 'report-date': '2026-10-27' }],
  ])('throws object_without_metadata for %s', async (_n, metadata) => {
    mockHead.mockResolvedValueOnce({
      contentLength: 99,
      etag: 'x',
      metadata,
    });
    await expect(indexExistingObject('SPX', '2026-10-28')).rejects.toThrow(
      'object_without_metadata',
    );
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('propagates a DB reject', async () => {
    mockHead.mockResolvedValueOnce({
      contentLength: 99,
      etag: 'x',
      metadata: meta,
    });
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    await expect(indexExistingObject('SPX', '2026-10-28')).rejects.toThrow(
      'connection lost',
    );
  });
});

describe('listStoredTickers', () => {
  it('bounds the query with retries and a per-attempt timeout', async () => {
    await listStoredTickers('2026-10-28');
    expect(mockRetry).toHaveBeenCalledWith(expect.any(Function), 2, 10_000);
  });

  it('returns a Set of tickers for the date', async () => {
    mockSql.mockResolvedValueOnce([{ ticker: 'SPX' }, { ticker: 'QQQ' }]);
    const out = await listStoredTickers('2026-10-28');
    expect(out).toEqual(new Set(['SPX', 'QQQ']));
    expect(mockSql.mock.calls[0]?.[1]).toBe('2026-10-28');
  });

  it('propagates a DB reject', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    await expect(listStoredTickers('2026-10-28')).rejects.toThrow(
      'connection lost',
    );
  });
});
