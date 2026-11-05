// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';

const mockSql = vi.fn();

vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => mockSql),
    withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    // The real classifier: the cron picks the Sentry level from it.
    isRetryableDbError: actual.isRetryableDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

const { mockCronGuard } = vi.hoisted(() => ({
  mockCronGuard: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: mockCronGuard,
}));

import handler from '../cron/takeit-fill-shap.js';
import { reportCronRun } from '../_lib/axiom.js';
import { Sentry } from '../_lib/sentry.js';

const GUARD = { apiKey: '', today: '2026-05-16' };
const JOB = 'takeit-fill-shap';

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockCronGuard.mockReturnValue(GUARD);
  // Clear sidecar env for each test; opt-in via per-test enableSidecar().
  delete process.env.SIDECAR_TAKEIT_URL;
  delete process.env.SIDECAR_TAKEIT_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function enableSidecar() {
  process.env.SIDECAR_TAKEIT_URL = 'http://sidecar.test:8123';
  process.env.SIDECAR_TAKEIT_SECRET = 'shh';
}

/**
 * A backlog row as the Neon driver returns it: `id` is a BIGSERIAL, which
 * arrives as a STRING (see enrich-lottery-outcomes.ts).
 */
function backlogRow(id: string) {
  return { id, takeit_features: { session_phase: 2, option_type_C: 1 } };
}

/** One sidecar result, echoing the id it was sent. */
function shapResult(id: string | number) {
  return {
    alert_id: id,
    top_positive: [
      { name: 'session_phase', shap_value: 0.3, feature_value: 1 },
    ],
    top_negative: [
      { name: 'is_itm_at_fire', shap_value: -0.2, feature_value: null },
    ],
  };
}

/** The `{ positive, negative }` JSON the cron stores for `shapResult`. */
function storedJson(id: string | number): string {
  const r = shapResult(id);
  return JSON.stringify({ positive: r.top_positive, negative: r.top_negative });
}

function sidecarOk(results: unknown[]) {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchOnce(response: Response | Error) {
  const spy = vi.spyOn(global, 'fetch');
  if (response instanceof Error) spy.mockRejectedValueOnce(response);
  else spy.mockResolvedValueOnce(response);
  return spy;
}

async function runCron() {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
    res,
  );
  return res;
}

/** SQL text and bound values of the n-th tagged-template call on mockSql. */
function sqlCall(n: number): { text: string; values: unknown[] } {
  const [strings, ...values] = mockSql.mock.calls[n] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  return { text: strings.join('?'), values };
}

/** The payload the cron handed to reportCronRun (the Axiom event). */
function reportedRun(): Record<string, unknown> {
  expect(reportCronRun).toHaveBeenCalledTimes(1);
  const [job, payload] = vi.mocked(reportCronRun).mock.calls[0]!;
  expect(job).toBe(JOB);
  return payload as Record<string, unknown>;
}

describe('takeit-fill-shap cron', () => {
  describe('missing sidecar config -> error', () => {
    it.each([
      ['both variables', {}, ['SIDECAR_TAKEIT_URL', 'SIDECAR_TAKEIT_SECRET']],
      ['the URL', { SIDECAR_TAKEIT_SECRET: 'shh' }, ['SIDECAR_TAKEIT_URL']],
      [
        'the secret',
        { SIDECAR_TAKEIT_URL: 'http://sidecar.test:8123' },
        ['SIDECAR_TAKEIT_SECRET'],
      ],
    ])(
      'reports error + Sentry ERROR naming the missing variables: %s',
      async (_label, env, missing) => {
        Object.assign(process.env, env);
        const fetchSpy = vi.spyOn(global, 'fetch');

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'error',
          rows: 0,
          message: `config missing: ${missing.join(', ')}`,
          missing,
        });
        // Nothing is read, called or written without the config.
        expect(mockSql).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'takeit.shap_fill.config_missing',
          expect.objectContaining({ level: 'error', extra: { missing } }),
        );
        expect(reportedRun()).toMatchObject({
          status: 'error',
          message: `config missing: ${missing.join(', ')}`,
        });
        // Names only, never values.
        const surfaced = JSON.stringify([
          res._json,
          vi.mocked(Sentry.captureMessage).mock.calls,
          vi.mocked(reportCronRun).mock.calls,
        ]);
        expect(surfaced).not.toContain('shh');
        expect(surfaced).not.toContain('sidecar.test');
      },
    );
  });

  it('does not require UW_API_KEY, which it never uses', async () => {
    // The only upstream is the Railway sidecar. The cron is monitored, and
    // cronGuard answers 500 before any check-in when a required key is
    // missing, so a missing or rotated UW_API_KEY would read as a missed
    // run for a dependency this job doesn't have.
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(mockCronGuard).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({ requireApiKey: false }),
    );
  });

  describe('nothing to fill', () => {
    it('reports success without calling the sidecar or writing', async () => {
      enableSidecar();
      const fetchSpy = vi.spyOn(global, 'fetch');
      mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 0,
        lottery: { status: 'success', scanned: 0, updated: 0, failed: 0 },
        silentboom: { status: 'success', scanned: 0, updated: 0, failed: 0 },
      });
      expect(res._json).not.toHaveProperty('message');
      // Two SELECTs, no UPDATE, no sidecar call.
      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reportedRun()).toMatchObject({ status: 'success', rows: 0 });
    });
  });

  describe('happy path', () => {
    it('POSTs to the sidecar and writes the answer in one batched UPDATE', async () => {
      enableSidecar();
      // Lottery: 1 row needing flags, with the bundle-shaped features dict
      // persisted by the detect cron at fire time. SilentBoom: empty.
      mockSql
        .mockResolvedValueOnce([
          {
            id: '42',
            takeit_features: {
              session_phase: 2,
              is_itm_at_fire: 0,
              ticker_bucket_SPY: 1,
              option_type_C: 1,
            },
          },
        ]) // SELECT lottery
        .mockResolvedValueOnce([{ id: '42' }]) // UPDATE lottery ... RETURNING id
        .mockResolvedValueOnce([]); // SELECT silentboom (empty)
      const fetchSpy = mockFetchOnce(sidecarOk([shapResult('42')]));

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 1,
        lottery: { status: 'success', scanned: 1, updated: 1, failed: 0 },
        silentboom: { scanned: 0, updated: 0, failed: 0 },
      });
      expect(res._json).not.toHaveProperty('message');
      expect(reportedRun()).toMatchObject({ status: 'success', rows: 1 });

      // fetch call shape — verify the body forwards the persisted features
      // dict unchanged, not the raw SQL row.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('http://sidecar.test:8123/takeit/explain');
      expect((opts as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer shh',
      });
      // A hung sidecar must not run the function to its maxDuration.
      expect((opts as RequestInit).signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(((opts as RequestInit).body as string) ?? '{}');
      expect(body).toMatchObject({
        alert_type: 'lottery',
        rows: [
          {
            alert_id: '42',
            features: {
              session_phase: 2,
              is_itm_at_fire: 0,
              ticker_bucket_SPY: 1,
              option_type_C: 1,
            },
          },
        ],
      });
    });

    it('writes N answers with ONE UPDATE: unnest arrays, IS NULL guard, RETURNING', async () => {
      enableSidecar();
      const ids = ['903', '902', '901'];
      mockSql
        .mockResolvedValueOnce(ids.map(backlogRow)) // SELECT lottery
        .mockResolvedValueOnce(ids.map((id) => ({ id }))) // UPDATE lottery
        .mockResolvedValueOnce([]); // SELECT silentboom
      mockFetchOnce(sidecarOk(ids.map((id) => shapResult(id))));

      const res = await runCron();

      // SELECT, ONE UPDATE for all three rows, SELECT: never one per row.
      expect(mockSql).toHaveBeenCalledTimes(3);
      const update = sqlCall(1);
      expect(update.text).toMatch(/UPDATE lottery_finder_fires/);
      expect(update.text).toMatch(/unnest\(/);
      expect(update.text).toMatch(/::bigint\[\]/);
      // R6: a concurrent fill must not be overwritten.
      expect(update.text).toMatch(/takeit_top_features IS NULL/);
      expect(update.text).toMatch(/RETURNING/);
      // Aligned arrays: ids as the driver gave them, one JSON text per id.
      expect(update.values).toEqual([ids, ids.map((id) => storedJson(id))]);
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 3,
        lottery: { scanned: 3, updated: 3, failed: 0, alreadyFilled: 0 },
      });
    });

    it('fills silent-boom rows into silent_boom_alerts with the same batched UPDATE', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([]) // SELECT lottery (empty)
        .mockResolvedValueOnce([backlogRow('7'), backlogRow('6')]) // SELECT sb
        .mockResolvedValueOnce([{ id: '7' }, { id: '6' }]); // UPDATE sb
      const fetchSpy = mockFetchOnce(
        sidecarOk([shapResult('6'), shapResult('7')]),
      );

      const res = await runCron();

      expect(mockSql).toHaveBeenCalledTimes(3);
      const update = sqlCall(2);
      expect(update.text).toMatch(/UPDATE silent_boom_alerts/);
      expect(update.text).toMatch(/takeit_top_features IS NULL/);
      expect(update.text).toMatch(/RETURNING/);
      // The write follows the REQUEST's row order, whatever order the
      // sidecar answered in.
      expect(update.values).toEqual([
        ['7', '6'],
        [storedJson('7'), storedJson('6')],
      ]);
      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.alert_type).toBe('silentboom');
      expect(res._json).toMatchObject({
        status: 'success',
        rows: 2,
        silentboom: { status: 'success', scanned: 2, updated: 2, failed: 0 },
      });
    });

    it('matches a numeric echoed alert_id to the string id the driver returned', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('42')])
        .mockResolvedValueOnce([{ id: '42' }])
        .mockResolvedValueOnce([]);
      mockFetchOnce(sidecarOk([shapResult(42)]));

      const res = await runCron();

      // Written under the id the DB handed out, not the echoed number.
      expect(sqlCall(1).values[0]).toEqual(['42']);
      expect(res._json).toMatchObject({
        status: 'success',
        lottery: { updated: 1, failed: 0 },
      });
    });

    it('does not count a row a concurrent run already filled as failed', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('5')])
        // Another run won the IS NULL guard: this UPDATE writes nothing.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockFetchOnce(sidecarOk([shapResult('5')]));

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'success',
        rows: 0,
        lottery: {
          status: 'success',
          scanned: 1,
          updated: 0,
          failed: 0,
          alreadyFilled: 1,
        },
      });
      expect(reportedRun()).toMatchObject({ status: 'success', rows: 0 });
    });
  });

  describe('sidecar transport failure -> partial (the next tick retries)', () => {
    it('reports partial + Sentry warning when the sidecar is unreachable', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')])
        .mockResolvedValueOnce([]); // SELECT silentboom
      mockFetchOnce(new Error('ECONNREFUSED'));

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 0,
        message: 'lottery: sidecar_unreachable',
        lottery: {
          status: 'partial',
          reason: 'sidecar_unreachable',
          scanned: 1,
          updated: 0,
          failed: 1,
        },
        silentboom: { status: 'success' },
      });
      // Nothing was written: SELECT lottery, SELECT silentboom only.
      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.sidecar_unreachable',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(reportedRun()).toMatchObject({
        status: 'partial',
        message: 'lottery: sidecar_unreachable',
      });
    });

    it('reports partial when the fetch times out', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')])
        .mockResolvedValueOnce([]);
      // What AbortSignal.timeout() makes fetch reject with.
      const timeout = new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
      mockFetchOnce(timeout);

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'partial',
        message: 'lottery: sidecar_unreachable',
        lottery: {
          status: 'partial',
          reason: 'sidecar_unreachable',
          updated: 0,
          failed: 1,
        },
      });
      expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.sidecar_unreachable',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({ error: timeout.message }),
        }),
      );
      expect(reportedRun()).toMatchObject({ status: 'partial' });
    });

    it.each([500, 502, 503, 504])(
      'reports partial + Sentry warning on a %i from the sidecar',
      async (status) => {
        enableSidecar();
        mockSql
          .mockResolvedValueOnce([backlogRow('1')])
          .mockResolvedValueOnce([]);
        mockFetchOnce(new Response('boom', { status }));

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'partial',
          lottery: {
            status: 'partial',
            reason: `sidecar_${status}`,
            updated: 0,
            failed: 1,
          },
        });
        expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'takeit.shap_fill.sidecar_non_2xx',
          expect.objectContaining({ level: 'warning' }),
        );
        expect(reportedRun()).toMatchObject({ status: 'partial' });
      },
    );

    it('treats a 429 as transient: partial + Sentry warning', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')])
        .mockResolvedValueOnce([]);
      mockFetchOnce(new Response('slow down', { status: 429 }));

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'partial',
        lottery: { status: 'partial', reason: 'sidecar_429', failed: 1 },
      });
      expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.sidecar_non_2xx',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(reportedRun()).toMatchObject({ status: 'partial' });
    });

    it('reports partial when the response body is cut off mid-read', async () => {
      // A transport failure after the headers: not a contract violation.
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')])
        .mockResolvedValueOnce([]);
      const cut = new Response('{"results":[', { status: 200 });
      vi.spyOn(cut, 'json').mockRejectedValueOnce(new TypeError('terminated'));
      mockFetchOnce(cut);

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'partial',
        lottery: { status: 'partial', reason: 'sidecar_unreachable' },
      });
      expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.sidecar_unreachable',
        expect.objectContaining({ level: 'warning' }),
      );
      expect(reportedRun()).toMatchObject({ status: 'partial' });
    });
  });

  describe('broken contract -> error (retrying the same call will not help)', () => {
    it.each([400, 401, 403, 404])(
      'reports error + Sentry ERROR on a %i from the sidecar',
      async (status) => {
        // 4xx is a config/auth bug — should page as `error`, not the
        // transient `warning` we use for 5xx/429.
        enableSidecar();
        mockSql
          .mockResolvedValueOnce([backlogRow('1')])
          .mockResolvedValueOnce([]);
        mockFetchOnce(new Response('unauthorized', { status }));

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'error',
          rows: 0,
          message: `lottery: sidecar_${status}`,
          lottery: {
            status: 'error',
            reason: `sidecar_${status}`,
            updated: 0,
            failed: 1,
          },
        });
        expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
        expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'takeit.shap_fill.sidecar_non_2xx',
          expect.objectContaining({ level: 'error' }),
        );
        expect(reportedRun()).toMatchObject({
          status: 'error',
          message: `lottery: sidecar_${status}`,
        });
      },
    );

    it('reports error when a 200 body is not JSON', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')])
        .mockResolvedValueOnce([]);
      mockFetchOnce(
        new Response('<html>maintenance</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'error',
        lottery: {
          status: 'error',
          reason: 'sidecar_malformed_response',
          updated: 0,
          failed: 1,
        },
      });
      expect(mockSql).toHaveBeenCalledTimes(2); // nothing written
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.sidecar_malformed_response',
        expect.objectContaining({ level: 'error' }),
      );
      expect(reportedRun()).toMatchObject({ status: 'error' });
    });

    it.each([
      ['no results key', {}],
      ['results is not an array', { results: 'nope' }],
      [
        'a result without alert_id',
        { results: [{ top_positive: [], top_negative: [] }] },
      ],
      [
        'a result whose top_positive is not a list',
        { results: [{ alert_id: '1', top_positive: {}, top_negative: [] }] },
      ],
      [
        'a contribution with a non-numeric shap_value',
        {
          results: [
            {
              alert_id: '1',
              top_positive: [{ name: 'x', shap_value: 'big' }],
              top_negative: [],
            },
          ],
        },
      ],
    ])(
      'reports error when a 200 body has the wrong shape: %s',
      async (_label, payload) => {
        enableSidecar();
        mockSql
          .mockResolvedValueOnce([backlogRow('1')])
          .mockResolvedValueOnce([]);
        mockFetchOnce(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

        const res = await runCron();

        expect(res._json).toMatchObject({
          status: 'error',
          lottery: { status: 'error', reason: 'sidecar_malformed_response' },
        });
        expect(mockSql).toHaveBeenCalledTimes(2); // nothing written
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          'takeit.shap_fill.sidecar_malformed_response',
          expect.objectContaining({ level: 'error' }),
        );
        expect(reportedRun()).toMatchObject({ status: 'error' });
      },
    );
  });

  describe('rows missing from an otherwise good answer -> partial', () => {
    it('writes the answered rows and reports partial for the missing one', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('3'), backlogRow('2')])
        .mockResolvedValueOnce([{ id: '3' }]) // UPDATE: only the answered row
        .mockResolvedValueOnce([]); // SELECT silentboom
      mockFetchOnce(sidecarOk([shapResult('3')]));

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 1,
        message: 'lottery: rows_missing',
        lottery: {
          status: 'partial',
          reason: 'rows_missing',
          scanned: 2,
          updated: 1,
          failed: 1,
        },
      });
      // The answered row is still written, in one UPDATE.
      expect(mockSql).toHaveBeenCalledTimes(3);
      expect(sqlCall(1).values).toEqual([['3'], [storedJson('3')]]);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.rows_missing',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({
            alertType: 'lottery',
            requested: 2,
            answered: 1,
          }),
        }),
      );
      expect(reportedRun()).toMatchObject({ status: 'partial', rows: 1 });
    });

    it('reports partial and skips the UPDATE when the answer is empty', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('3')])
        .mockResolvedValueOnce([]); // SELECT silentboom
      mockFetchOnce(sidecarOk([]));

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'partial',
        message: 'lottery: rows_missing',
        lottery: {
          status: 'partial',
          reason: 'rows_missing',
          updated: 0,
          failed: 1,
        },
      });
      expect(mockSql).toHaveBeenCalledTimes(2); // no UPDATE
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'takeit.shap_fill.rows_missing',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({ requested: 1, answered: 0 }),
        }),
      );
      expect(reportedRun()).toMatchObject({ status: 'partial', rows: 0 });
    });

    it('never writes a result for a row it did not send', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('3')])
        .mockResolvedValueOnce([{ id: '3' }])
        .mockResolvedValueOnce([]);
      mockFetchOnce(sidecarOk([shapResult('3'), shapResult('999')]));

      await runCron();

      expect(sqlCall(1).values).toEqual([['3'], [storedJson('3')]]);
    });
  });

  describe('DB failures', () => {
    it('reports error + one Sentry exception when the batched UPDATE rejects (genuine)', async () => {
      enableSidecar();
      const boom = new Error('column "takeit_top_features" does not exist');
      mockSql
        .mockResolvedValueOnce([backlogRow('1')]) // SELECT lottery
        .mockRejectedValueOnce(boom) // UPDATE lottery
        .mockResolvedValueOnce([]); // SELECT silentboom still runs
      mockFetchOnce(sidecarOk([shapResult('1')]));

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 0,
        message: 'lottery: db_write_failed',
        lottery: {
          status: 'error',
          reason: 'db_write_failed',
          scanned: 1,
          updated: 0,
          failed: 1,
        },
        silentboom: { status: 'success' },
      });
      // The failed leg does not starve the other one.
      expect(mockSql).toHaveBeenCalledTimes(3);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({ level: 'error' }),
      );
      expect(reportedRun()).toMatchObject({
        status: 'error',
        message: 'lottery: db_write_failed',
      });
    });

    it.each(['fetch failed', 'db attempt timeout'])(
      'reports partial + a Sentry warning for a Neon blip on the UPDATE (%s): the row stays IS NULL for the next tick',
      async (message) => {
        enableSidecar();
        const blip = new Error(message);
        mockSql
          .mockResolvedValueOnce([backlogRow('1')])
          .mockRejectedValueOnce(blip)
          .mockResolvedValueOnce([]); // SELECT silentboom still runs
        mockFetchOnce(sidecarOk([shapResult('1')]));

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(res._json).toMatchObject({
          status: 'partial',
          rows: 0,
          message: 'lottery: db_write_failed',
          lottery: {
            status: 'partial',
            reason: 'db_write_failed',
            scanned: 1,
            updated: 0,
            failed: 1,
          },
          silentboom: { status: 'success' },
        });
        expect(mockSql).toHaveBeenCalledTimes(3);
        expect(Sentry.captureException).toHaveBeenCalledTimes(1);
        expect(Sentry.captureException).toHaveBeenCalledWith(
          blip,
          expect.objectContaining({ level: 'warning' }),
        );
        expect(reportedRun()).toMatchObject({
          status: 'partial',
          message: 'lottery: db_write_failed',
        });
      },
    );

    it('does not report success when the silent-boom UPDATE fails after lottery landed', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')]) // SELECT lottery
        .mockResolvedValueOnce([{ id: '1' }]) // UPDATE lottery ok
        .mockResolvedValueOnce([backlogRow('2')]) // SELECT silentboom
        .mockRejectedValueOnce(new Error('connection lost')); // UPDATE sb
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(sidecarOk([shapResult('1')]))
        .mockResolvedValueOnce(sidecarOk([shapResult('2')]));

      const res = await runCron();

      // The lottery write is still counted: rows is honest.
      expect(res._json).toMatchObject({
        status: 'error',
        rows: 1,
        lottery: { status: 'success', updated: 1 },
        silentboom: { status: 'error', reason: 'db_write_failed', failed: 1 },
      });
      expect(reportedRun()).toMatchObject({ status: 'error', rows: 1 });
    });

    it('lets a failed SELECT reach the wrapper: 500 + error run + one exception', async () => {
      enableSidecar();
      const boom = new Error('relation "lottery_finder_fires" does not exist');
      mockSql.mockRejectedValueOnce(boom);

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(boom);
      expect(reportedRun()).toMatchObject({
        status: 'error',
        message: boom.message,
      });
    });
  });

  describe('run status is the worst of the two legs', () => {
    it('partial (lottery) + error (silent boom) -> error', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')]) // SELECT lottery
        .mockResolvedValueOnce([backlogRow('2')]); // SELECT silentboom
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('boom', { status: 503 }))
        .mockResolvedValueOnce(new Response('nope', { status: 401 }));

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'error',
        message: 'lottery: sidecar_503; silentboom: sidecar_401',
        lottery: { status: 'partial', reason: 'sidecar_503' },
        silentboom: { status: 'error', reason: 'sidecar_401' },
      });
      expect(reportedRun()).toMatchObject({ status: 'error' });
    });

    it('success (lottery) + partial (silent boom) -> partial', async () => {
      enableSidecar();
      mockSql
        .mockResolvedValueOnce([backlogRow('1')]) // SELECT lottery
        .mockResolvedValueOnce([{ id: '1' }]) // UPDATE lottery
        .mockResolvedValueOnce([backlogRow('2')]); // SELECT silentboom
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(sidecarOk([shapResult('1')]))
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      const res = await runCron();

      expect(res._json).toMatchObject({
        status: 'partial',
        rows: 1,
        lottery: { status: 'success', updated: 1 },
        silentboom: { status: 'partial', reason: 'sidecar_unreachable' },
      });
    });
  });
});
