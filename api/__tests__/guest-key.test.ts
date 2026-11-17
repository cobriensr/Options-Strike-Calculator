// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolationScopeStub, mockRequest, mockResponse } from './helpers';

// Every mock the handler's modules call is created here, once, so a handler
// imported again after `vi.resetModules()` (see `freshHandler`) is wired to
// the same spies the tests assert on.
const {
  mockDone,
  mockCaptureMessage,
  mockCaptureException,
  mockCheckBot,
  mockRateLimit,
  mockInvalid,
  mockBudgetSpent,
  mockRecordFailure,
  mockIsValidGuestKey,
} = vi.hoisted(() => ({
  mockDone: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockCaptureException: vi.fn(),
  mockCheckBot: vi.fn(),
  mockRateLimit: vi.fn(),
  mockInvalid: vi.fn(),
  mockBudgetSpent: vi.fn(),
  mockRecordFailure: vi.fn(),
  mockIsValidGuestKey: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    withIsolationScope: vi.fn((cb: (scope: unknown) => unknown) =>
      cb(isolationScopeStub()),
    ),
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  metrics: { request: vi.fn(() => mockDone), increment: vi.fn() },
}));

// The bot check, limiter, failure budget and body check are stubbed; the
// local-deployment rule and the hour arithmetic stay real so the Secure flag
// and Retry-After tests below pin the handler's actual output.
vi.mock('../_lib/api-helpers.js', async () => {
  const { isLocalDeployment, hourWindow } = await vi.importActual<
    typeof import('../_lib/auth-helpers.js')
  >('../_lib/auth-helpers.js');
  return {
    isLocalDeployment,
    hourWindow,
    checkBot: mockCheckBot,
    rejectIfRateLimited: mockRateLimit,
    respondIfInvalid: mockInvalid,
    guestKeyBudgetSpent: mockBudgetSpent,
    recordGuestKeyFailure: mockRecordFailure,
  };
});

// Real key comparison, behind a spy so a test can assert it was or was not
// reached.
vi.mock('../_lib/guest-auth.js', async () => {
  const actual = await vi.importActual<typeof import('../_lib/guest-auth.js')>(
    '../_lib/guest-auth.js',
  );
  mockIsValidGuestKey.mockImplementation(actual.isValidGuestKey);
  return { ...actual, isValidGuestKey: mockIsValidGuestKey };
});

import handler from '../auth/guest-key.js';
import {
  checkBot,
  guestKeyBudgetSpent,
  recordGuestKeyFailure,
  rejectIfRateLimited,
  respondIfInvalid,
} from '../_lib/api-helpers.js';
import { isValidGuestKey } from '../_lib/guest-auth.js';

const ORIGINAL_ENV = { ...process.env };
const HOUR_MS = 3_600_000;
const BUDGET_FINGERPRINT = ['guest-key-failure-budget'];
const BUDGET_UNAVAILABLE_FINGERPRINT = ['guest-key-budget-unavailable'];
const HOUR = 500_001;

/** Pin the clock `offsetMs` into the given epoch hour. */
function setClock(epochHour: number, offsetMs = 0): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(epochHour * HOUR_MS + offsetMs);
}

/**
 * The handler as a newly loaded module. It remembers, in one module-level
 * number, the last hour it sent the spent-budget message for, so a test that
 * counts that message must not inherit the hour a previous test left behind.
 * The spies are hoisted above, so the new copy reports to the same ones.
 */
async function freshHandler(): Promise<typeof handler> {
  vi.resetModules();
  return (await import('../auth/guest-key.js')).default;
}

function post(key = 'wrong-key-12345678') {
  return mockRequest({ method: 'POST', body: { key } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkBot).mockResolvedValue({ isBot: false });
  vi.mocked(rejectIfRateLimited).mockResolvedValue(false);
  vi.mocked(respondIfInvalid).mockReturnValue(false);
  vi.mocked(guestKeyBudgetSpent).mockResolvedValue(false);
  vi.mocked(recordGuestKeyFailure).mockResolvedValue(undefined);
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GUEST_ACCESS_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/guest-key', () => {
  it('returns 405 for non-POST methods', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET' }), res);
    expect(res._status).toBe(405);
    expect(res._json).toEqual({ error: 'POST only' });
    expect(checkBot).not.toHaveBeenCalled();
    expect(rejectIfRateLimited).not.toHaveBeenCalled();
  });

  describe('bot check', () => {
    it('runs the bot check and answers 403 for a bot, before any other check', async () => {
      process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
      vi.mocked(checkBot).mockResolvedValue({ isBot: true });
      const req = post('right-key-12345678');
      const res = mockResponse();

      await handler(req, res);

      expect(checkBot).toHaveBeenCalledWith(req);
      expect(res._status).toBe(403);
      expect(res._json).toEqual({ error: 'Access denied' });
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(mockDone).toHaveBeenCalledWith({ status: 403 });
      expect(isValidGuestKey).not.toHaveBeenCalled();
      expect(rejectIfRateLimited).not.toHaveBeenCalled();
      expect(guestKeyBudgetSpent).not.toHaveBeenCalled();
      expect(recordGuestKeyFailure).not.toHaveBeenCalled();
      expect(res._headers['Set-Cookie']).toBeUndefined();
    });

    it('lets a request that is not a bot through to the key check', async () => {
      process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
      const res = mockResponse();

      await handler(post('right-key-12345678'), res);

      expect(checkBot).toHaveBeenCalledTimes(1);
      expect(res._status).toBe(200);
    });

    it('answers 500 and reports it when the bot check itself throws', async () => {
      const err = new Error('botid unavailable');
      vi.mocked(checkBot).mockRejectedValue(err);
      const res = mockResponse();

      await handler(post(), res);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: 'Internal server error' });
      expect(mockCaptureException).toHaveBeenCalledWith(err);
      expect(isValidGuestKey).not.toHaveBeenCalled();
    });
  });

  it('returns 429 when rate-limited, before the budget and the key', async () => {
    vi.mocked(rejectIfRateLimited).mockImplementation(async (_req, res) => {
      res.status(429).json({ error: 'rate limited' });
      return true;
    });
    const res = mockResponse();
    await handler(post('something-12345678'), res);
    expect(res._status).toBe(429);
    expect(mockDone).toHaveBeenCalledWith({ status: 429 });
    expect(guestKeyBudgetSpent).not.toHaveBeenCalled();
    expect(isValidGuestKey).not.toHaveBeenCalled();
  });

  describe('hourly failure budget', () => {
    it('rejects when the hourly failure budget is spent', async () => {
      setClock(HOUR, 5_000);
      process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
      vi.mocked(guestKeyBudgetSpent).mockResolvedValue(true);
      const res = mockResponse();

      // Even the right key is refused: the budget is checked before the key.
      await (
        await freshHandler()
      )(post('right-key-12345678'), res);

      expect(res._status).toBe(429);
      expect(res._json).toEqual({
        error: 'Too many attempts. Try again later.',
      });
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(res._headers['Set-Cookie']).toBeUndefined();
      expect(mockDone).toHaveBeenCalledWith({ status: 429 });
      expect(isValidGuestKey).not.toHaveBeenCalled();
      expect(recordGuestKeyFailure).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ fingerprint: BUDGET_FINGERPRINT }),
      );
    });

    it('sends Retry-After as the seconds left in the hour', async () => {
      setClock(HOUR, 5_000);
      vi.mocked(guestKeyBudgetSpent).mockResolvedValue(true);
      const res = mockResponse();

      await handler(post(), res);

      expect(res._headers['Retry-After']).toBe('3595');
    });

    it('checks the budget before it parses the body', async () => {
      setClock(HOUR);
      vi.mocked(guestKeyBudgetSpent).mockResolvedValue(true);
      const res = mockResponse();

      await handler(post(), res);

      expect(res._status).toBe(429);
      expect(respondIfInvalid).not.toHaveBeenCalled();
    });

    it('sends one Sentry message per hour however many requests are refused', async () => {
      setClock(HOUR, 1_000);
      vi.mocked(guestKeyBudgetSpent).mockResolvedValue(true);
      const instance = await freshHandler();

      for (let i = 0; i < 3; i += 1) {
        const res = mockResponse();
        await instance(post(), res);
        expect(res._status).toBe(429);
      }
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      // Last millisecond of the same hour: still no second message.
      vi.setSystemTime((HOUR + 1) * HOUR_MS - 1);
      await instance(post(), mockResponse());
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

      // The next hour reports again, once.
      vi.setSystemTime((HOUR + 1) * HOUR_MS);
      await instance(post(), mockResponse());
      await instance(post(), mockResponse());
      expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the budget check errors', async () => {
      const err = new Error('connect timeout');
      vi.mocked(guestKeyBudgetSpent).mockRejectedValue(err);
      process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
      const res = mockResponse();

      await handler(post('right-key-12345678'), res);

      expect(res._status).toBe(503);
      expect(res._json).toEqual({ error: 'Try again later' });
      expect(res._headers['Cache-Control']).toBe('no-store');
      expect(res._headers['Set-Cookie']).toBeUndefined();
      expect(mockDone).toHaveBeenCalledWith({ status: 503 });
      expect(isValidGuestKey).not.toHaveBeenCalled();
      expect(recordGuestKeyFailure).not.toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          fingerprint: BUDGET_UNAVAILABLE_FINGERPRINT,
        }),
      );
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });
  });

  it('returns 400 for invalid body, without checking the key', async () => {
    vi.mocked(respondIfInvalid).mockImplementation((_parsed, res) => {
      res.status(400).json({ error: 'bad body' });
      return true;
    });
    const res = mockResponse();
    await handler(post('short'), res);
    expect(res._status).toBe(400);
    expect(isValidGuestKey).not.toHaveBeenCalled();
    expect(recordGuestKeyFailure).not.toHaveBeenCalled();
  });

  it('returns 401 when env keys are unset, and records the failure', async () => {
    const res = mockResponse();
    await handler(post('unconfigured-key-123'), res);
    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid access key' });
    expect(recordGuestKeyFailure).toHaveBeenCalledTimes(1);
  });

  it('records a failure on a wrong key', async () => {
    process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
    const res = mockResponse();

    await handler(post('wrong-key-12345678'), res);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid access key' });
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(res._headers['Set-Cookie']).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith({ status: 401 });
    expect(isValidGuestKey).toHaveBeenCalledTimes(1);
    expect(recordGuestKeyFailure).toHaveBeenCalledTimes(1);
  });

  it('waits for the failure to be recorded before it answers 401', async () => {
    process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
    let recorded = false;
    vi.mocked(recordGuestKeyFailure).mockImplementation(async () => {
      await Promise.resolve();
      recorded = true;
    });
    const res = mockResponse();
    const original = res.status.bind(res);
    let recordedWhenAnswered: boolean | null = null;
    res.status = (code: number) => {
      if (code === 401) recordedWhenAnswered = recorded;
      return original(code);
    };

    await handler(post('wrong-key-12345678'), res);

    expect(recordedWhenAnswered).toBe(true);
  });

  it('does not record on success', async () => {
    process.env.GUEST_ACCESS_KEYS = 'right-key-12345678';
    const res = mockResponse();

    await handler(post('right-key-12345678'), res);

    expect(res._status).toBe(200);
    expect(guestKeyBudgetSpent).toHaveBeenCalledTimes(1);
    expect(recordGuestKeyFailure).not.toHaveBeenCalled();
  });

  it('sets sc-guest + sc-guest-hint cookies on a valid key', async () => {
    process.env.GUEST_ACCESS_KEYS = 'shared-key-12345678';
    process.env.APP_URL = 'http://localhost:3000';
    const res = mockResponse();
    await handler(post('shared-key-12345678'), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    const setCookie = res._headers['Set-Cookie'];
    // We use setHeader with an array; when re-asserted as string it serializes.
    const cookieStr = Array.isArray(setCookie)
      ? setCookie.join(' | ')
      : String(setCookie);
    expect(cookieStr).toContain('sc-guest=shared-key-12345678');
    expect(cookieStr).toContain('sc-guest-hint=1');
    expect(cookieStr).toContain('HttpOnly');
  });

  // Both guest cookies carry Secure except on a local deployment, by the same
  // rule as the owner cookies (`isLocalDeployment`).
  it.each<[string, Record<string, string>, boolean]>([
    [
      'a production URL on Vercel',
      { APP_URL: 'https://example.com', VERCEL: '1', VERCEL_ENV: 'production' },
      true,
    ],
    // VERCEL is unset here: that alone no longer counts as local.
    ['a production URL', { APP_URL: 'https://example.com' }, true],
    ['an unset APP_URL', {}, true],
    ['a localhost URL', { APP_URL: 'http://localhost:3000' }, false],
    ['a 127.0.0.1 URL', { APP_URL: 'http://127.0.0.1:3000' }, false],
    [
      'a localhost URL on a production deploy',
      { APP_URL: 'http://localhost:3000', VERCEL_ENV: 'production' },
      true,
    ],
  ])(
    'sets Secure on both cookies only off localhost: %s',
    async (_label, env, secure) => {
      process.env.GUEST_ACCESS_KEYS = 'shared-key-12345678';
      delete process.env.APP_URL;
      Object.assign(process.env, env);
      const res = mockResponse();
      await handler(post('shared-key-12345678'), res);
      expect(res._status).toBe(200);
      const cookies = res._headers['Set-Cookie'] as unknown as string[];
      expect(cookies).toHaveLength(2);
      for (const cookie of cookies) {
        expect(cookie.split('; ').includes('Secure')).toBe(secure);
      }
    },
  );

  it('matches against any entry in a comma-separated list', async () => {
    process.env.GUEST_ACCESS_KEYS = 'alpha-12345678,bravo-12345678';
    const res = mockResponse();
    await handler(post('bravo-12345678'), res);
    expect(res._status).toBe(200);
  });
});
