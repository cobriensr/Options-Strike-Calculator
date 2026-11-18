// @vitest-environment node

/**
 * Failed machine-secret checks (`api/_lib/auth-failure.ts`).
 *
 * `reportSecretMismatch` logs and counts every mismatch and sends one Sentry
 * message per surface per 10 minutes. The throttle is module state, so each
 * test imports a fresh copy of the module (`vi.resetModules()` plus a dynamic
 * import) to start with it empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequest } from './helpers';

// Created once so a module imported again after `vi.resetModules()` reports to
// the same spies the tests assert on.
const { mockWarn, mockCaptureMessage, mockSecretMismatch } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockSecretMismatch: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: { warn: mockWarn } }));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: mockCaptureMessage },
  metrics: { secretMismatch: mockSecretMismatch },
}));

// The cron path calls this module, so it must not load the request-path auth
// modules (botid, Redis). A direct import of one of them throws on import. The
// logger and Sentry modules are mocked above, so this guards only
// auth-failure.ts's own imports.
vi.mock('../_lib/auth-helpers.js', () => {
  throw new Error('auth-failure must not load auth-helpers');
});
vi.mock('../_lib/api-helpers.js', () => {
  throw new Error('auth-failure must not load api-helpers');
});
vi.mock('../_lib/guest-auth.js', () => {
  throw new Error('auth-failure must not load guest-auth');
});

const MESSAGE = 'Secret check failed';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const SURFACES = ['cron', 'notify', 'analyze-plots'] as const;

async function freshModule(): Promise<
  typeof import('../_lib/auth-failure.js')
> {
  vi.resetModules();
  return import('../_lib/auth-failure.js');
}

function request(
  headers: Record<string, string | string[]> = {},
  url = '/api/cron/example',
) {
  return mockRequest({
    url,
    headers: { 'x-real-ip': '203.0.113.7', ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T15:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

it('loads without the request-path auth modules', async () => {
  await expect(freshModule()).resolves.toMatchObject({
    reportSecretMismatch: expect.any(Function),
  });
});

describe('reportSecretMismatch', () => {
  it('logs and counts every mismatch, throttled or not', async () => {
    const { reportSecretMismatch } = await freshModule();

    reportSecretMismatch('cron', request());
    reportSecretMismatch('cron', request());
    reportSecretMismatch('notify', request());

    expect(mockSecretMismatch).toHaveBeenCalledTimes(3);
    expect(mockSecretMismatch).toHaveBeenNthCalledWith(1, 'cron');
    expect(mockSecretMismatch).toHaveBeenNthCalledWith(2, 'cron');
    expect(mockSecretMismatch).toHaveBeenNthCalledWith(3, 'notify');
    expect(mockWarn).toHaveBeenCalledTimes(3);
  });

  it('logs the surface, the path, the client address and whether a credential came', async () => {
    const { reportSecretMismatch } = await freshModule();

    reportSecretMismatch(
      'cron',
      request({ authorization: 'Bearer something' }, '/api/cron/example'),
    );

    expect(mockWarn).toHaveBeenCalledWith(
      {
        surface: 'cron',
        path: '/api/cron/example',
        ip: '203.0.113.7',
        hadCredential: true,
      },
      MESSAGE,
    );
  });

  it('logs the path without its query string', async () => {
    const { reportSecretMismatch } = await freshModule();

    reportSecretMismatch(
      'cron',
      request({}, '/api/cron/example?force=1&token=query-value'),
    );

    const [fields] = mockWarn.mock.calls[0] as [{ path: string }];
    expect(fields.path).toBe('/api/cron/example');
  });

  describe('path length', () => {
    const MAX_LOGGED_PATH = 200;

    async function loggedPath(url: string): Promise<string> {
      const { reportSecretMismatch } = await freshModule();
      reportSecretMismatch('cron', request({}, url));
      const [fields] = mockWarn.mock.calls[0] as [{ path: string }];
      return fields.path;
    }

    it('cuts a longer path to its first 200 characters', async () => {
      const url = `/api/cron/${'a'.repeat(500)}`;

      const path = await loggedPath(url);

      expect(path).toHaveLength(MAX_LOGGED_PATH);
      expect(path).toBe(url.slice(0, MAX_LOGGED_PATH));
    });

    it('cuts a path of 201 characters and keeps one of 200', async () => {
      const exact = `/${'a'.repeat(MAX_LOGGED_PATH - 1)}`;

      expect(await loggedPath(exact)).toBe(exact);
      mockWarn.mockClear();
      expect(await loggedPath(`${exact}a`)).toBe(exact);
    });

    it('drops a long query string before it can count against the cap', async () => {
      const path = await loggedPath(`/api/cron/example?q=${'a'.repeat(500)}`);

      expect(path).toBe('/api/cron/example');
    });
  });

  it('logs an empty path when the request has no url', async () => {
    const { reportSecretMismatch } = await freshModule();

    reportSecretMismatch('cron', mockRequest({ headers: {} }));

    const [fields] = mockWarn.mock.calls[0] as [{ path: string }];
    expect(fields.path).toBe('');
  });

  describe('client address', () => {
    it.each<[string, string | undefined, string]>([
      ['an IPv4 address as written', '203.0.113.7', '203.0.113.7'],
      [
        'an IPv6 address as its /64',
        '2001:db8:1:2:3:4:5:6',
        '2001:db8:1:2::/64',
      ],
      ['a missing header as unknown', undefined, 'unknown'],
      ['text that is not an address as unknown', 'not-an-ip', 'unknown'],
    ])('logs %s', async (_name, header, expected) => {
      const { reportSecretMismatch } = await freshModule();
      const headers: Record<string, string> = header
        ? { 'x-real-ip': header }
        : {};

      // `request` adds a default address, so build this request by hand.
      reportSecretMismatch('cron', mockRequest({ url: '/x', headers }));

      const [fields] = mockWarn.mock.calls[0] as [{ ip: string }];
      expect(fields.ip).toBe(expected);
    });
  });

  describe('hadCredential is true only for the surface’s own credential header', () => {
    it.each<
      [(typeof SURFACES)[number], Record<string, string | string[]>, boolean]
    >([
      ['cron', { authorization: 'Bearer a' }, true],
      ['cron', {}, false],
      ['cron', { authorization: '' }, false],
      ['cron', { 'x-internal-notify-secret': 'a' }, false],
      ['analyze-plots', { authorization: 'Bearer a' }, true],
      ['analyze-plots', {}, false],
      ['analyze-plots', { 'x-internal-notify-secret': 'a' }, false],
      ['notify', { 'x-internal-notify-secret': 'a' }, true],
      ['notify', { 'x-internal-notify-secret': ['a', 'b'] }, true],
      ['notify', {}, false],
      ['notify', { 'x-internal-notify-secret': '' }, false],
      ['notify', { authorization: 'Bearer a' }, false],
    ])('%s with %j gives %s', async (surface, headers, expected) => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch(surface, request(headers));

      const [fields] = mockWarn.mock.calls[0] as [{ hadCredential: boolean }];
      expect(fields.hadCredential).toBe(expected);
    });
  });

  describe('Sentry message', () => {
    it('sends the pinned message, level, fingerprint, surface tag and a reason of missing when no credential came', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('analyze-plots', request());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(MESSAGE, {
        level: 'warning',
        fingerprint: ['secret-mismatch', 'analyze-plots'],
        tags: { surface: 'analyze-plots', reason: 'missing' },
      });
    });

    it('tags a reason of wrong when a credential came and did not match', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch(
        'analyze-plots',
        request({ authorization: 'Bearer something' }),
      );

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(MESSAGE, {
        level: 'warning',
        fingerprint: ['secret-mismatch', 'analyze-plots'],
        tags: { surface: 'analyze-plots', reason: 'wrong' },
      });
    });

    it.each<
      [(typeof SURFACES)[number], Record<string, string | string[]>, string]
    >([
      ['cron', {}, 'missing'],
      ['cron', { authorization: 'Bearer a' }, 'wrong'],
      ['cron', { 'x-internal-notify-secret': 'a' }, 'missing'],
      ['notify', {}, 'missing'],
      ['notify', { 'x-internal-notify-secret': 'a' }, 'wrong'],
      ['notify', { authorization: 'Bearer a' }, 'missing'],
      ['analyze-plots', {}, 'missing'],
      ['analyze-plots', { authorization: 'Bearer a' }, 'wrong'],
    ])(
      '%s with %j is reported with a reason of %s',
      async (surface, headers, reason) => {
        const { reportSecretMismatch } = await freshModule();

        reportSecretMismatch(surface, request(headers));

        const [, sent] = mockCaptureMessage.mock.calls[0] as [
          string,
          { tags: { reason: string } },
        ];
        expect(sent.tags.reason).toBe(reason);
      },
    );

    it('second mismatch inside 10 min sends no Sentry message', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', request());
      vi.advanceTimersByTime(TEN_MINUTES_MS - 1);
      reportSecretMismatch('cron', request());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it('a new message after 10 min', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', request());
      vi.advanceTimersByTime(TEN_MINUTES_MS);
      reportSecretMismatch('cron', request());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });

    it('measures the 10 min from the last message, not from the last mismatch', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', request());
      // A mismatch every 4 minutes: throttled ones must not push the window.
      vi.advanceTimersByTime(4 * 60 * 1000);
      reportSecretMismatch('cron', request());
      vi.advanceTimersByTime(4 * 60 * 1000);
      reportSecretMismatch('cron', request());
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2 * 60 * 1000);
      reportSecretMismatch('cron', request());
      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });

    it('surfaces throttle independently', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', request());
      reportSecretMismatch('notify', request());
      reportSecretMismatch('analyze-plots', request());
      reportSecretMismatch('cron', request());
      reportSecretMismatch('notify', request());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(3);
      const options = mockCaptureMessage.mock.calls.map(
        ([, sent]) =>
          sent as { fingerprint: string[]; tags: { surface: string } },
      );
      expect(options.map((sent) => sent.fingerprint)).toEqual([
        ['secret-mismatch', 'cron'],
        ['secret-mismatch', 'notify'],
        ['secret-mismatch', 'analyze-plots'],
      ]);
      expect(options.map((sent) => sent.tags)).toEqual([
        { surface: 'cron', reason: 'missing' },
        { surface: 'notify', reason: 'missing' },
        { surface: 'analyze-plots', reason: 'missing' },
      ]);
    });

    it('a new module instance sends again, since the throttle starts empty', async () => {
      const first = await freshModule();
      first.reportSecretMismatch('cron', request());
      const second = await freshModule();
      second.reportSecretMismatch('cron', request());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });

    // The window is opened before the send, so a Sentry that throws costs the
    // first mismatch's message and nothing more: the guards call this on every
    // rejected request, and a second throw would repeat on each of them.
    it('a throw from Sentry fails that call only, and nothing is sent again inside the window', async () => {
      mockCaptureMessage.mockImplementationOnce(() => {
        throw new Error('sentry down');
      });
      const { reportSecretMismatch } = await freshModule();

      expect(() => reportSecretMismatch('cron', request())).toThrow(
        'sentry down',
      );
      expect(() => reportSecretMismatch('cron', request())).not.toThrow();
      expect(() => reportSecretMismatch('cron', request())).not.toThrow();

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      // The log line and the count came first, so the failed call has both.
      expect(mockWarn).toHaveBeenCalledTimes(3);
      expect(mockSecretMismatch).toHaveBeenCalledTimes(3);
    });
  });

  // A caller that sends nothing must not use up the window a wrong secret
  // needs: the Sentry alert may later be narrowed to `reason:wrong`.
  describe('Sentry throttle is per surface and reason', () => {
    const missing = () => request();
    const wrong = () => request({ authorization: 'Bearer something' });
    const notifyWrong = () => request({ 'x-internal-notify-secret': 'a' });

    function sentReasons(): string[] {
      return mockCaptureMessage.mock.calls.map(
        ([, sent]) => (sent as { tags: { reason: string } }).tags.reason,
      );
    }

    it('a missing then a wrong inside 10 min send two messages, tagged in that order', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', missing());
      vi.advanceTimersByTime(60 * 1000);
      reportSecretMismatch('cron', wrong());

      expect(sentReasons()).toEqual(['missing', 'wrong']);
      const fingerprints = mockCaptureMessage.mock.calls.map(
        ([, sent]) => (sent as { fingerprint: string[] }).fingerprint,
      );
      expect(fingerprints).toEqual([
        ['secret-mismatch', 'cron'],
        ['secret-mismatch', 'cron'],
      ]);
    });

    it('a wrong then a missing inside 10 min send two messages too', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', wrong());
      reportSecretMismatch('cron', missing());

      expect(sentReasons()).toEqual(['wrong', 'missing']);
    });

    it.each([
      ['missing', missing],
      ['wrong', wrong],
    ])('a second %s inside 10 min sends nothing', async (_reason, again) => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', again());
      reportSecretMismatch('cron', again());
      vi.advanceTimersByTime(TEN_MINUTES_MS - 1);
      reportSecretMismatch('cron', again());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it('a wrong 10 min after the first wrong sends again, a missing in between or not', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', wrong());
      vi.advanceTimersByTime(TEN_MINUTES_MS - 1000);
      reportSecretMismatch('cron', missing());
      vi.advanceTimersByTime(1000);
      reportSecretMismatch('cron', wrong());

      expect(sentReasons()).toEqual(['wrong', 'missing', 'wrong']);
    });

    it('a missing 10 min after the first missing sends again', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', missing());
      vi.advanceTimersByTime(TEN_MINUTES_MS);
      reportSecretMismatch('cron', missing());

      expect(sentReasons()).toEqual(['missing', 'missing']);
    });

    it('keeps the surfaces apart for the same reason', async () => {
      const { reportSecretMismatch } = await freshModule();

      reportSecretMismatch('cron', wrong());
      reportSecretMismatch('notify', notifyWrong());

      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });

    it('holds at most one message per surface and reason, however many requests come', async () => {
      const { reportSecretMismatch } = await freshModule();

      // Varied paths, addresses and credential values: nothing taken from a
      // request may open a new throttle entry.
      for (let i = 0; i < 200; i += 1) {
        for (const surface of SURFACES) {
          const header =
            surface === 'notify' ? 'x-internal-notify-secret' : 'authorization';
          reportSecretMismatch(
            surface,
            mockRequest({
              url: `/api/example/${i}?q=${i}`,
              headers: {
                'x-real-ip': `203.0.113.${i % 250}`,
                ...(i % 2 === 0 ? { [header]: `value-${i}` } : {}),
              },
            }),
          );
        }
      }

      // 3 surfaces x 2 reasons is the most the window can hold.
      expect(mockCaptureMessage).toHaveBeenCalledTimes(6);
      const keys = mockCaptureMessage.mock.calls.map(([, sent]) => {
        const { fingerprint, tags } = sent as {
          fingerprint: string[];
          tags: { reason: string };
        };
        return `${fingerprint[1]}:${tags.reason}`;
      });
      expect(new Set(keys).size).toBe(6);
    });

    it('opens the window before the send for each reason, so a throw costs one failure only', async () => {
      mockCaptureMessage.mockImplementationOnce(() => {
        throw new Error('sentry down');
      });
      const { reportSecretMismatch } = await freshModule();

      expect(() => reportSecretMismatch('cron', wrong())).toThrow(
        'sentry down',
      );
      expect(() => reportSecretMismatch('cron', wrong())).not.toThrow();
      // The other reason's window is untouched by that failure.
      reportSecretMismatch('cron', missing());

      expect(sentReasons()).toEqual(['wrong', 'missing']);
    });
  });

  it('never includes the Authorization header, the notify header, a cookie, the query string or a length', async () => {
    // Distinct prefixes and lengths, so a leak of any of them is findable.
    const bearer = 'zq9-bearer-'.padEnd(37, 'x');
    const notify = 'zq9-notify-'.padEnd(41, 'x');
    const cookie = 'sc-owner=zq9-cookie-'.padEnd(29, 'x');
    const query = 'zq9-query-'.padEnd(53, 'x');
    const authorization = `Bearer ${bearer}`;
    const { reportSecretMismatch } = await freshModule();

    for (const surface of SURFACES) {
      reportSecretMismatch(
        surface,
        request(
          {
            authorization,
            'x-internal-notify-secret': notify,
            cookie,
          },
          `/api/example?token=${query}`,
        ),
      );
    }

    // The check is only meaningful if every reporter was called.
    expect(mockWarn).toHaveBeenCalledTimes(3);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(3);
    expect(mockSecretMismatch).toHaveBeenCalledTimes(3);

    const sent = JSON.stringify([
      mockWarn.mock.calls,
      mockCaptureMessage.mock.calls,
      mockSecretMismatch.mock.calls,
    ]);
    for (const value of [bearer, notify, cookie, query]) {
      expect(sent).not.toContain(value);
    }
    // A prefix of any value, however short.
    expect(sent).not.toContain('zq9');
    // Every value's length as a number, the whole Authorization header's
    // included (44), as well as the token inside it (37).
    for (const length of [37, 44, 41, 29, 53]) {
      expect(sent).not.toMatch(new RegExp(`\\b${length}\\b`));
    }
    // What the payload does carry: the path, the flag, and the Sentry options
    // (so the check above covers the tag, not only the message and fingerprint).
    expect(sent).toContain('/api/example');
    expect(sent).toContain('hadCredential');
    expect(sent).toContain('"tags":{"surface":"notify","reason":"wrong"}');
  });
});
