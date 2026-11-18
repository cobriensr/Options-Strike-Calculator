// @vitest-environment node

/**
 * Warn-only check for configured secrets shorter than the minimum
 * (`api/_lib/secret-strength.ts`).
 *
 * `weakSecretNames` is not gated and is tested directly. `warnWeakSecretsOnce`
 * does nothing unless `VERCEL` is set, and holds a module-level boolean, so
 * each test imports a fresh copy of the module (`vi.resetModules()` plus a
 * dynamic import) to start with the boolean cleared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Created once so a module imported again after `vi.resetModules()` reports to
// the same spies the tests assert on.
const { mockWarn, mockCaptureMessage } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../_lib/logger.js', () => ({ default: { warn: mockWarn } }));
vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: mockCaptureMessage },
}));

// The check runs on the cron path, which must not load the request-path auth
// modules (botid, Redis). A direct import of one of them throws on import.
// The logger and Sentry modules are mocked above, so this guards only
// secret-strength.ts's own imports; it does not follow what those two modules
// import.
vi.mock('../_lib/auth-helpers.js', () => {
  throw new Error('secret-strength must not load auth-helpers');
});
vi.mock('../_lib/api-helpers.js', () => {
  throw new Error('secret-strength must not load api-helpers');
});
vi.mock('../_lib/guest-auth.js', () => {
  throw new Error('secret-strength must not load guest-auth');
});

const CHECKED_VARS = [
  'OWNER_SECRET',
  'CRON_SECRET',
  'INTERNAL_NOTIFY_SECRET',
  'GUEST_ACCESS_KEYS',
  'VERCEL',
] as const;

const SECRET_VARS = [
  'OWNER_SECRET',
  'CRON_SECRET',
  'INTERNAL_NOTIFY_SECRET',
] as const;

/** A value of exactly `length` characters that starts with `prefix`. */
const secretOfLength = (prefix: string, length: number): string =>
  prefix.padEnd(length, 'x');

async function freshModule(): Promise<
  typeof import('../_lib/secret-strength.js')
> {
  vi.resetModules();
  return import('../_lib/secret-strength.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  // Start from a known state whatever the machine's own environment holds.
  for (const name of CHECKED_VARS) vi.stubEnv(name, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('loads without the request-path auth modules', async () => {
  await expect(freshModule()).resolves.toMatchObject({
    weakSecretNames: expect.any(Function),
    warnWeakSecretsOnce: expect.any(Function),
  });
});

describe('weakSecretNames', () => {
  describe.each(SECRET_VARS)('%s', (name) => {
    it('reports a value of 31 characters', async () => {
      vi.stubEnv(name, 'a'.repeat(31));
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([name]);
    });

    it('does not report a value of 32 characters', async () => {
      vi.stubEnv(name, 'a'.repeat(32));
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
    });

    it('does not report a value longer than 32 characters', async () => {
      vi.stubEnv(name, 'a'.repeat(64));
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
    });

    it('does not report an unset variable', async () => {
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
    });

    it('does not report an empty variable, which the guards treat as unset', async () => {
      vi.stubEnv(name, '');
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
    });
  });

  it('reports each short secret and each short guest key, in a fixed order', async () => {
    vi.stubEnv('INTERNAL_NOTIFY_SECRET', 'a'.repeat(5));
    vi.stubEnv('OWNER_SECRET', 'a'.repeat(5));
    vi.stubEnv('CRON_SECRET', 'a'.repeat(5));
    vi.stubEnv('GUEST_ACCESS_KEYS', `${'a'.repeat(5)},${'b'.repeat(5)}`);
    const { weakSecretNames } = await freshModule();
    expect(weakSecretNames()).toEqual([
      'OWNER_SECRET',
      'CRON_SECRET',
      'INTERNAL_NOTIFY_SECRET',
      'GUEST_ACCESS_KEYS[0]',
      'GUEST_ACCESS_KEYS[1]',
    ]);
  });

  describe('GUEST_ACCESS_KEYS', () => {
    it('reports only the short key of a short and a long one', async () => {
      vi.stubEnv('GUEST_ACCESS_KEYS', `${'a'.repeat(23)},${'b'.repeat(40)}`);
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual(['GUEST_ACCESS_KEYS[0]']);
    });

    it('reports the index of a short key that follows a long one', async () => {
      vi.stubEnv('GUEST_ACCESS_KEYS', `${'b'.repeat(40)},${'a'.repeat(23)}`);
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual(['GUEST_ACCESS_KEYS[1]']);
    });

    it('does not report a key of 24 characters', async () => {
      vi.stubEnv('GUEST_ACCESS_KEYS', 'a'.repeat(24));
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
    });

    it('reports a key shorter than 8, which guest login already drops', async () => {
      vi.stubEnv('GUEST_ACCESS_KEYS', 'abc');
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual(['GUEST_ACCESS_KEYS[0]']);
    });

    it('measures a key after trimming it', async () => {
      // 23 characters padded to 30 with spaces: short once trimmed.
      // 24 characters padded to 30: long enough once trimmed.
      vi.stubEnv(
        'GUEST_ACCESS_KEYS',
        `${'a'.repeat(23)}       ,       ${'b'.repeat(24)}`,
      );
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual(['GUEST_ACCESS_KEYS[0]']);
    });

    it('numbers keys by position among the non-empty entries', async () => {
      // The empty and blank entries are not keys: the short key is the second
      // key configured, so index 1.
      vi.stubEnv(
        'GUEST_ACCESS_KEYS',
        `,${'b'.repeat(40)}, ,,${'a'.repeat(23)},`,
      );
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual(['GUEST_ACCESS_KEYS[1]']);
    });

    it('does not report an unset, empty or all-blank list', async () => {
      const { weakSecretNames } = await freshModule();
      expect(weakSecretNames()).toEqual([]);
      vi.stubEnv('GUEST_ACCESS_KEYS', '');
      expect(weakSecretNames()).toEqual([]);
      vi.stubEnv('GUEST_ACCESS_KEYS', ' , ,, ');
      expect(weakSecretNames()).toEqual([]);
    });
  });
});

describe('warnWeakSecretsOnce', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL', '1');
  });

  it('warns once per instance: two calls give one log line and one Sentry message', async () => {
    vi.stubEnv('OWNER_SECRET', 'a'.repeat(10));
    const { warnWeakSecretsOnce } = await freshModule();

    warnWeakSecretsOnce();
    warnWeakSecretsOnce();
    warnWeakSecretsOnce();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('sends the pinned message, level, fingerprint and names', async () => {
    vi.stubEnv('OWNER_SECRET', 'a'.repeat(10));
    vi.stubEnv('GUEST_ACCESS_KEYS', 'b'.repeat(10));
    const { warnWeakSecretsOnce } = await freshModule();

    warnWeakSecretsOnce();

    const names = ['OWNER_SECRET', 'GUEST_ACCESS_KEYS[0]'];
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Configured secret shorter than the minimum',
      { level: 'warning', fingerprint: ['weak-secret'], extra: { names } },
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { names },
      'Configured secret shorter than the minimum',
    );
  });

  it('warns again in a new instance, which starts with the boolean cleared', async () => {
    vi.stubEnv('CRON_SECRET', 'a'.repeat(10));
    const first = await freshModule();
    first.warnWeakSecretsOnce();
    const second = await freshModule();
    second.warnWeakSecretsOnce();

    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it('evaluates the configuration once, not on every call', async () => {
    const { warnWeakSecretsOnce } = await freshModule();
    warnWeakSecretsOnce(); // every secret unset: nothing to report

    vi.stubEnv('OWNER_SECRET', 'a'.repeat(10));
    warnWeakSecretsOnce();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // The flag is set before the reports, so a reporter that throws costs the
  // first call only: `isOwner` and `cronGuard` call this on nearly every
  // request, and a second throw would repeat on each of them.
  it.each([
    ['logger.warn', mockWarn],
    ['Sentry.captureMessage', mockCaptureMessage],
  ])(
    'a throw from %s fails the first call only, and nothing is reported again',
    async (_name, reporter) => {
      vi.stubEnv('OWNER_SECRET', 'a'.repeat(10));
      reporter.mockImplementationOnce(() => {
        throw new Error('reporter down');
      });
      const { warnWeakSecretsOnce } = await freshModule();

      expect(() => warnWeakSecretsOnce()).toThrow('reporter down');
      expect(() => warnWeakSecretsOnce()).not.toThrow();
      expect(() => warnWeakSecretsOnce()).not.toThrow();

      expect(reporter).toHaveBeenCalledTimes(1);
    },
  );

  it('empty list sends nothing', async () => {
    vi.stubEnv('OWNER_SECRET', 'a'.repeat(32));
    vi.stubEnv('CRON_SECRET', 'b'.repeat(40));
    vi.stubEnv('INTERNAL_NOTIFY_SECRET', 'c'.repeat(32));
    vi.stubEnv('GUEST_ACCESS_KEYS', `${'d'.repeat(24)},${'e'.repeat(60)}`);
    const { warnWeakSecretsOnce } = await freshModule();

    warnWeakSecretsOnce();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('sends nothing when VERCEL is unset, even with a short secret', async () => {
    vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('OWNER_SECRET', 'a'.repeat(10));
    const { warnWeakSecretsOnce } = await freshModule();

    warnWeakSecretsOnce();
    warnWeakSecretsOnce();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('payload never carries a value, a prefix, a length or a byte count', async () => {
    // Distinct prefixes and lengths, so a leak of any of them is findable.
    const owner = secretOfLength('zq9owner', 31);
    const cron = secretOfLength('zq9cron', 17);
    const notify = secretOfLength('zq9notify', 14);
    const guestShort = secretOfLength('zq9guest', 23);
    const guestLong = secretOfLength('zq9longkey', 40);
    vi.stubEnv('OWNER_SECRET', owner);
    vi.stubEnv('CRON_SECRET', cron);
    vi.stubEnv('INTERNAL_NOTIFY_SECRET', notify);
    vi.stubEnv('GUEST_ACCESS_KEYS', `${guestShort},${guestLong}`);
    const { warnWeakSecretsOnce } = await freshModule();

    warnWeakSecretsOnce();

    // The check is only meaningful if both calls were made.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    const sent = JSON.stringify([
      mockWarn.mock.calls,
      mockCaptureMessage.mock.calls,
    ]);
    for (const value of [owner, cron, notify, guestShort, guestLong]) {
      expect(sent).not.toContain(value);
    }
    // A prefix of any value, however short.
    expect(sent).not.toContain('zq9');
    // Every length as a number: the weak values' lengths, and the long key's.
    for (const length of [31, 17, 14, 23, 40]) {
      expect(sent).not.toMatch(new RegExp(`\\b${length}\\b`));
    }
    // The names are what the payload does carry.
    expect(sent).toContain('OWNER_SECRET');
    expect(sent).toContain('CRON_SECRET');
    expect(sent).toContain('INTERNAL_NOTIFY_SECRET');
    expect(sent).toContain('GUEST_ACCESS_KEYS[0]');
    expect(sent).not.toContain('GUEST_ACCESS_KEYS[1]');
  });
});
