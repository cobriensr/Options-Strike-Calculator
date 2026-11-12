// @vitest-environment node

/**
 * /api/cron/check-live-snapshots — pushes a phone alert when a live
 * market_snapshots row has saved today and then none has for 30 minutes
 * during the session, once per stall. A day with no live row yet sends
 * nothing, and neither does a stall that follows a deliberate close of the
 * app (the `snapshot-app-closed:{date}` marker, written by
 * `POST /api/snapshot-close`).
 *
 * Mocks sit at the external boundaries: Neon (`getDb`), the Upstash client
 * (the claim key and the close marker), the web-push fan-out, Sentry, the
 * logger and Axiom. The real `cronGuard`, `withCronInstrumentation` and
 * `sendOwnerPushOnce` run, so the 401, the time window, the claim and its
 * release go through the same code production does. Only `Date` is faked, so
 * the clock is exact and the wrapper's own timers still run.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const {
  mockSql,
  mockRedisSet,
  mockRedisGet,
  mockRedisEval,
  mockSendPush,
  mockSentry,
  mockLogger,
  mockReportCronRun,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisEval: vi.fn(),
  mockSendPush: vi.fn(),
  mockSentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockReportCronRun: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class MockRedis {
    set = mockRedisSet;
    get = mockRedisGet;
    eval = mockRedisEval;
  },
}));

vi.mock('../_lib/push.js', () => ({ sendPushToOwner: mockSendPush }));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: mockSentry,
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/axiom.js', () => ({ reportCronRun: mockReportCronRun }));

import handler, {
  isLiveSnapshotWatchWindow,
} from '../cron/check-live-snapshots.js';

const JOB = 'check-live-snapshots';
const MINUTE_MS = 60_000;
const CLAIM_TTL_SEC = 24 * 60 * 60;
const PUSH_TTL_SEC = 60 * 60;
const OPEN_APP = 'Open the app signed in as owner.';
const UNDELIVERED = 'snapshot.stale_alert.undelivered';

// Wed Nov 11 2026, 11:00 AM CT (12:00 ET, EST).
const TODAY = '2026-11-11';
const NOW = Date.parse('2026-11-11T17:00:00Z');
const CLOSED_KEY = `snapshot-app-closed:${TODAY}`;

function minutesAgo(min: number, from = NOW): Date {
  return new Date(from - min * MINUTE_MS);
}

/** The claim key for the stall that began after this last save. */
function claimKeyFor(lastSave: Date, date = TODAY): string {
  return `snapshot-stale-alert:${date}:${lastSave.getTime()}`;
}

/** The notification tag for the stall that began after this last save. */
function tagFor(lastSave: Date, date = TODAY): string {
  return `snapshot-stale-${date}-${lastSave.getTime()}`;
}

// The last save most stale-path tests use: 35 min before NOW, 10:25 AM CT.
const STALE_SAVE = minutesAgo(35);
const STALE_KEY = claimKeyFor(STALE_SAVE);

/** Queue the one SELECT MAX(created_at) the handler issues. */
function queueLastLive(lastLiveAt: Date | string | null): void {
  mockSql.mockResolvedValueOnce([{ last_live_at: lastLiveAt }]);
}

async function runCron(query: Record<string, string> = {}) {
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query,
    }),
    res,
  );
  return res;
}

function bodyOf(res: ReturnType<typeof mockResponse>) {
  return res._json as Record<string, unknown>;
}

/** The claim token this run wrote with SET NX. */
function claimToken(): string {
  return mockRedisSet.mock.calls[0]![1] as string;
}

describe('cron check-live-snapshots', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    // The cron calls no UW API: it must run whatever the shell exports.
    delete process.env.UW_API_KEY;
    mockSql.mockReset();
    mockRedisSet.mockReset().mockResolvedValue('OK');
    // No close marker unless a test sets one.
    mockRedisGet.mockReset().mockResolvedValue(null);
    mockRedisEval.mockReset().mockResolvedValue(1);
    mockSendPush
      .mockReset()
      .mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockReportCronRun.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  describe('auth guard', () => {
    it('returns 401 without the cron secret and reads nothing', async () => {
      const res = mockResponse();
      await handler(mockRequest({ method: 'GET', headers: {} }), res);
      expect(res._status).toBe(401);
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('returns 401 with the wrong cron secret and reads nothing', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: { authorization: 'Bearer wrong-secret' },
        }),
        res,
      );
      expect(res._status).toBe(401);
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('returns 405 for a POST and reads nothing', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'POST',
          headers: { authorization: 'Bearer test-secret' },
        }),
        res,
      );
      expect(res._status).toBe(405);
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });
  });

  describe('isLiveSnapshotWatchWindow', () => {
    // 09:00 CT is 10:00 ET and the last check is 15 min before the close, so
    // the window is 10:00-15:45 ET (09:00-14:45 CT) on a full day, in both
    // DST regimes.
    it.each([
      ['EST 08:55 CT is before the window', '2026-11-11T14:55:00Z', false],
      ['EST 09:00 CT opens the window', '2026-11-11T15:00:00Z', true],
      ['EST 14:45 CT is the last check', '2026-11-11T20:45:00Z', true],
      ['EST 14:50 CT is after the window', '2026-11-11T20:50:00Z', false],
      ['EDT 08:55 CT is before the window', '2026-10-14T13:55:00Z', false],
      ['EDT 09:00 CT opens the window', '2026-10-14T14:00:00Z', true],
      ['EDT 14:45 CT is the last check', '2026-10-14T19:45:00Z', true],
      ['EDT 14:50 CT is after the window', '2026-10-14T19:50:00Z', false],
      // Black Friday closes at 13:00 ET, so the last check is 12:45 ET.
      ['half-day 11:45 CT is the last check', '2026-11-27T17:45:00Z', true],
      ['half-day 12:00 CT is after the window', '2026-11-27T18:00:00Z', false],
      ['Thanksgiving is a holiday', '2026-11-26T17:00:00Z', false],
      ['Saturday is closed', '2026-11-14T17:00:00Z', false],
      ['Sunday is closed', '2026-11-15T17:00:00Z', false],
    ])('%s', (_label, iso, expected) => {
      vi.setSystemTime(Date.parse(iso));
      expect(isLiveSnapshotWatchWindow()).toBe(expected);
    });

    it('skips a run outside the window without reading anything', async () => {
      vi.setSystemTime(Date.parse('2026-11-11T14:55:00Z')); // 08:55 CT
      const res = await runCron();
      expect(bodyOf(res)).toEqual({
        skipped: true,
        reason: 'Outside time window',
      });
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockRedisGet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    // The window is local to the cron, so cron-schedules.test.ts cannot tie it
    // to vercel.json. Sweep the ticks vercel.json fires on a full Wednesday in
    // each DST regime and check the window admits 10:00-15:45 ET in both. The
    // ticks come from FIRED_SCHEDULE, which the first test pins to vercel.json.
    const FIRED_SCHEDULE = '*/15 14-20 * * 1-5';
    const scheduleParts = /^\*\/(\d+) (\d+)-(\d+) /.exec(FIRED_SCHEDULE);
    if (scheduleParts === null) throw new Error('unreadable FIRED_SCHEDULE');
    const [stepMin, firstHour, lastHour] = scheduleParts
      .slice(1)
      .map(Number) as [number, number, number];
    const firedUtcMinutes: number[] = [];
    for (let min = firstHour * 60; min < (lastHour + 1) * 60; min += stepMin) {
      firedUtcMinutes.push(min);
    }

    it('vercel.json fires the schedule the sweep walks', () => {
      const { crons } = JSON.parse(
        readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
      ) as { crons: { path: string; schedule: string }[] };
      expect(
        crons
          .filter((c) => c.path === '/api/cron/check-live-snapshots')
          .map((c) => c.schedule),
      ).toEqual([FIRED_SCHEDULE]);
    });

    it.each([
      ['EDT', '2026-10-14', 240],
      ['EST', '2026-11-11', 300],
    ])(
      '%s: the fired ticks admit 10:00 through 15:45 ET',
      (_regime, date, utcOffsetMin) => {
        const midnightUtc = Date.parse(`${date}T00:00:00Z`);
        const admitted: string[] = [];
        for (const utcMin of firedUtcMinutes) {
          vi.setSystemTime(midnightUtc + utcMin * MINUTE_MS);
          if (!isLiveSnapshotWatchWindow()) continue;
          const etMin = utcMin - utcOffsetMin;
          const etHour = String(Math.floor(etMin / 60)).padStart(2, '0');
          admitted.push(`${etHour}:${String(etMin % 60).padStart(2, '0')}`);
        }
        expect(admitted).toHaveLength(24);
        expect(admitted[0]).toBe('10:00');
        expect(admitted.at(-1)).toBe('15:45');
      },
    );
  });

  describe('the last live save', () => {
    it('reads only today’s live rows, keyed on the ET date', async () => {
      queueLastLive(minutesAgo(5));
      await runCron();

      expect(mockSql).toHaveBeenCalledTimes(1);
      const [strings, ...values] = mockSql.mock.calls[0] as [
        string[],
        ...unknown[],
      ];
      const query = strings.join('?').replaceAll(/\s+/g, ' ');
      expect(query).toContain('MAX(created_at)');
      expect(query).toContain('FROM market_snapshots');
      expect(query).toContain('date = ?');
      expect(query).toContain('is_backtest = false');
      expect(query).toContain("entry_time <> 'pre-market'");
      expect(values).toEqual([TODAY]);
    });

    it('reports success and sends nothing when the last save is 20 min old', async () => {
      const lastLive = minutesAgo(20);
      queueLastLive(lastLive);

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(bodyOf(res)).toMatchObject({
        job: JOB,
        status: 'success',
        message: 'live snapshots current',
        lastLiveAt: lastLive.toISOString(),
        minutesSince: 20,
      });
      // Current: no close marker read, no claim, no push.
      expect(mockRedisGet).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('is still current one second short of 30 min', async () => {
      queueLastLive(new Date(NOW - 30 * MINUTE_MS + 1000));
      const res = await runCron();
      expect(bodyOf(res)).toMatchObject({
        status: 'success',
        minutesSince: 29,
      });
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('is stale at exactly 30 min', async () => {
      queueLastLive(minutesAgo(30));
      const res = await runCron();
      expect(bodyOf(res)).toMatchObject({
        status: 'success',
        minutesSince: 30,
      });
      expect(mockSendPush).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a Date', (d: Date) => d],
      ['an ISO string', (d: Date) => d.toISOString()],
      [
        'a Postgres timestamptz string',
        (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '+00'),
      ],
    ])('reads a last save returned as %s', async (_shape, toDriver) => {
      queueLastLive(toDriver(STALE_SAVE));
      await runCron();
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({
          body: `Last live snapshot 10:25 AM CT. ${OPEN_APP}`,
        }),
        { ttlSec: PUSH_TTL_SEC },
      );
      // The same save keys the same stall, whatever shape the driver used.
      expect(mockRedisSet).toHaveBeenCalledWith(
        STALE_KEY,
        expect.any(String),
        expect.anything(),
      );
    });
  });

  describe('a stale last save', () => {
    it('pushes once, claimed and tagged per stall, with the last save time', async () => {
      queueLastLive(STALE_SAVE); // 10:25 AM CT

      const res = await runCron();

      // The key and the tag carry the last save's epoch ms, so they come from
      // the stall and not from the day.
      expect(STALE_KEY).toBe(
        `snapshot-stale-alert:${TODAY}:${STALE_SAVE.getTime()}`,
      );
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      expect(mockRedisSet).toHaveBeenCalledWith(STALE_KEY, expect.any(String), {
        nx: true,
        ex: CLAIM_TTL_SEC,
      });
      expect(mockSendPush).toHaveBeenCalledTimes(1);
      expect(mockSendPush).toHaveBeenCalledWith(
        {
          title: 'Live snapshots stopped saving',
          body: `Last live snapshot 10:25 AM CT. ${OPEN_APP}`,
          tag: `snapshot-stale-${TODAY}-${STALE_SAVE.getTime()}`,
          requireInteraction: true,
          url: '/',
        },
        { ttlSec: PUSH_TTL_SEC },
      );
      expect(bodyOf(res)).toMatchObject({
        job: JOB,
        status: 'success',
        message: 'stale alert sent',
        today: TODAY,
        minutesSince: 35,
        sent: 1,
      });
      expect(mockRedisEval).not.toHaveBeenCalled();
    });

    it('claims before it sends', async () => {
      queueLastLive(STALE_SAVE);
      await runCron();
      expect(mockRedisSet.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendPush.mock.invocationCallOrder[0]!,
      );
    });

    // 2:30 PM CT, so every one of these is more than 30 min old.
    it.each([
      ['2026-11-11T15:05:00Z', '9:05 AM CT'],
      ['2026-11-11T17:00:00Z', '11:00 AM CT'],
      ['2026-11-11T18:05:00Z', '12:05 PM CT'],
      ['2026-11-11T19:20:00Z', '1:20 PM CT'],
    ])('writes %s as %s', async (savedAt, expected) => {
      vi.setSystemTime(Date.parse('2026-11-11T20:30:00Z'));
      queueLastLive(savedAt);
      await runCron();
      expect(mockSendPush).toHaveBeenCalledWith(
        expect.objectContaining({
          body: `Last live snapshot ${expected}. ${OPEN_APP}`,
        }),
        expect.anything(),
      );
    });

    it('says the alert already went out when an earlier run holds the stall’s claim', async () => {
      queueLastLive(STALE_SAVE);
      mockRedisSet.mockResolvedValueOnce(null);

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(bodyOf(res)).toMatchObject({
        status: 'skipped',
        message: 'alert already sent for this stall',
      });
      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockRedisEval).not.toHaveBeenCalled();
    });

    it('reports partial and keeps the claim when some devices failed', async () => {
      queueLastLive(STALE_SAVE);
      mockSendPush.mockResolvedValueOnce({ sent: 1, expired: 0, failed: 1 });

      const res = await runCron();

      expect(bodyOf(res)).toMatchObject({
        status: 'partial',
        message: 'stale alert sent',
        sent: 1,
        failed: 1,
      });
      expect(mockRedisEval).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('one push per stall', () => {
    /** SET NX over a set of held keys, as Upstash does, so a rerun sees an earlier claim. */
    function installClaimStore(): Set<string> {
      const held = new Set<string>();
      mockRedisSet.mockImplementation((key: string) => {
        if (held.has(key)) return Promise.resolve(null);
        held.add(key);
        return Promise.resolve('OK');
      });
      return held;
    }

    it('pushes again when saves resume and stop again, under a new key and tag', async () => {
      const held = installClaimStore();

      // Stall 1: the last save is 10:25 AM CT, and the 11:00 AM CT check pushes.
      queueLastLive(STALE_SAVE);
      const first = await runCron();
      expect(bodyOf(first)).toMatchObject({
        status: 'success',
        message: 'stale alert sent',
      });
      expect(mockSendPush).toHaveBeenCalledTimes(1);

      // 11:15 AM CT, the same stall (the last save has not changed): skipped.
      vi.setSystemTime(NOW + 15 * MINUTE_MS);
      queueLastLive(STALE_SAVE);
      const sameStall = await runCron();
      expect(bodyOf(sameStall)).toMatchObject({
        status: 'skipped',
        message: 'alert already sent for this stall',
      });
      expect(mockSendPush).toHaveBeenCalledTimes(1);

      // Saves resume and the last one lands at 12:05 PM CT. The 12:45 PM CT
      // check sees a 40-minute gap: a new stall.
      const secondSave = new Date('2026-11-11T18:05:00Z');
      vi.setSystemTime(Date.parse('2026-11-11T18:45:00Z'));
      queueLastLive(secondSave);
      const secondStall = await runCron();
      expect(bodyOf(secondStall)).toMatchObject({
        status: 'success',
        message: 'stale alert sent',
        minutesSince: 40,
      });

      expect(mockSendPush).toHaveBeenCalledTimes(2);
      expect([...held]).toEqual([
        claimKeyFor(STALE_SAVE),
        claimKeyFor(secondSave),
      ]);
      // A second tag, so the phone shows a second notification instead of
      // silently replacing the first (sw.ts sets no `renotify`).
      const tags = mockSendPush.mock.calls.map(
        ([payload]) => (payload as { tag: string }).tag,
      );
      expect(tags).toEqual([tagFor(STALE_SAVE), tagFor(secondSave)]);
      expect(tags[0]).not.toBe(tags[1]);
    });
  });

  describe('no live row today', () => {
    // 09:00 CT is the first check of the window and 14:45 CT the last.
    it.each([
      ['09:00 CT (EST)', '2026-11-11T15:00:00Z'],
      ['14:45 CT (EST)', '2026-11-11T20:45:00Z'],
      ['09:00 CT (EDT)', '2026-10-14T14:00:00Z'],
    ])('reports success and sends nothing at %s', async (_label, iso) => {
      vi.setSystemTime(Date.parse(iso));
      queueLastLive(null);

      const res = await runCron();

      expect(res._status).toBe(200);
      expect(bodyOf(res)).toMatchObject({
        job: JOB,
        status: 'success',
        message: 'no live snapshot yet today',
        lastLiveAt: null,
      });
      expect(mockRedisGet).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
      expect(mockSentry.captureMessage).not.toHaveBeenCalled();
      expect(mockSentry.captureException).not.toHaveBeenCalled();
    });

    it('treats an empty result like no row', async () => {
      vi.setSystemTime(Date.parse('2026-11-11T15:00:00Z'));
      mockSql.mockResolvedValueOnce([]);

      const res = await runCron();

      expect(bodyOf(res)).toMatchObject({
        status: 'success',
        message: 'no live snapshot yet today',
        lastLiveAt: null,
      });
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });
  });

  describe('a deliberate close', () => {
    // STALE_SAVE is 10:25 AM CT and the check runs at 11:00 AM CT.
    it.each([
      ['at the last save', 0, '10:25 AM CT'],
      ['after the last save', 10 * MINUTE_MS, '10:35 AM CT'],
    ])(
      'reports success and sends nothing when the app closed %s',
      async (_label, afterSaveMs, clock) => {
        const closedAt = new Date(STALE_SAVE.getTime() + afterSaveMs);
        queueLastLive(STALE_SAVE);
        mockRedisGet.mockResolvedValueOnce(closedAt.toISOString());

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(bodyOf(res)).toMatchObject({
          job: JOB,
          status: 'success',
          message: `app closed at ${clock}`,
          lastLiveAt: STALE_SAVE.toISOString(),
          closedAt: closedAt.toISOString(),
        });
        expect(mockRedisGet).toHaveBeenCalledTimes(1);
        expect(mockRedisGet).toHaveBeenCalledWith(CLOSED_KEY);
        expect(mockRedisSet).not.toHaveBeenCalled();
        expect(mockSendPush).not.toHaveBeenCalled();
        expect(mockSentry.captureMessage).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['1 ms before the last save', 1],
      ['an hour before the last save', 60 * MINUTE_MS],
    ])(
      'ignores a close marker from %s and pushes the stall',
      async (_label, beforeSaveMs) => {
        // The app was reopened and saved after it closed, then stalled.
        queueLastLive(STALE_SAVE);
        mockRedisGet.mockResolvedValueOnce(
          new Date(STALE_SAVE.getTime() - beforeSaveMs).toISOString(),
        );

        const res = await runCron();

        expect(bodyOf(res)).toMatchObject({
          status: 'success',
          message: 'stale alert sent',
          sent: 1,
        });
        expect(mockRedisGet).toHaveBeenCalledWith(CLOSED_KEY);
        expect(mockRedisSet).toHaveBeenCalledWith(
          STALE_KEY,
          expect.any(String),
          expect.anything(),
        );
        expect(mockSendPush).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      },
    );

    it('pushes the stall when there is no marker', async () => {
      queueLastLive(STALE_SAVE);

      await runCron();

      expect(mockRedisGet).toHaveBeenCalledWith(CLOSED_KEY);
      expect(mockSendPush).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['text', 'not a time'],
      ['a number', 1_762_876_800_000],
    ])(
      'warns and pushes the stall when the marker is %s, not a time',
      async (_shape, marker) => {
        queueLastLive(STALE_SAVE);
        mockRedisGet.mockResolvedValueOnce(marker);

        const res = await runCron();

        expect(bodyOf(res)).toMatchObject({
          status: 'success',
          message: 'stale alert sent',
        });
        expect(mockSendPush).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { today: TODAY, marker },
          'check-live-snapshots: close marker unreadable; treating as not closed',
        );
      },
    );
  });

  describe('failure modes', () => {
    it.each([
      [
        'every send failed',
        { sent: 0, expired: 0, failed: 2 },
        'every send failed',
      ],
      [
        'every subscription expired',
        { sent: 0, expired: 1, failed: 0 },
        'every subscription expired',
      ],
      [
        'there are no subscriptions',
        { sent: 0, expired: 0, failed: 0 },
        'no push subscriptions',
      ],
    ])(
      'reports error, captures an error and releases the claim when %s',
      async (_case, result, reason) => {
        queueLastLive(STALE_SAVE);
        mockSendPush.mockResolvedValueOnce(result);

        const res = await runCron();

        expect(res._status).toBe(200);
        expect(bodyOf(res)).toMatchObject({
          job: JOB,
          status: 'error',
          message: `alert not delivered: ${reason}`,
        });
        expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
        expect(mockSentry.captureMessage).toHaveBeenCalledWith(UNDELIVERED, {
          level: 'error',
          fingerprint: [UNDELIVERED],
          extra: expect.objectContaining({ reason, today: TODAY, ...result }),
        });
        expect(mockReportCronRun).toHaveBeenCalledWith(
          JOB,
          expect.objectContaining({
            status: 'error',
            message: `alert not delivered: ${reason}`,
          }),
        );
        // Released with this run's token, so the next 15-min check retries
        // the same stall.
        expect(mockRedisEval).toHaveBeenCalledTimes(1);
        expect(mockRedisEval).toHaveBeenCalledWith(
          expect.any(String),
          [STALE_KEY],
          [claimToken()],
        );
      },
    );

    it('reports 500 and captures the error when the push throws', async () => {
      queueLastLive(STALE_SAVE);
      const boom = new Error('push service down');
      mockSendPush.mockRejectedValueOnce(boom);

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(bodyOf(res)).toEqual({ job: JOB, error: 'Internal error' });
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockReportCronRun).toHaveBeenCalledWith(
        JOB,
        expect.objectContaining({
          status: 'error',
          message: 'push service down',
        }),
      );
      expect(mockRedisEval).toHaveBeenCalledWith(
        expect.any(String),
        [STALE_KEY],
        [claimToken()],
      );
    });

    it('sends nothing and captures the error when the claim throws', async () => {
      queueLastLive(STALE_SAVE);
      const boom = new Error('redis down');
      mockRedisSet.mockRejectedValueOnce(boom);

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('fails the run, not "closed", when the close marker read throws', async () => {
      queueLastLive(STALE_SAVE);
      const boom = new Error('redis read down');
      mockRedisGet.mockRejectedValueOnce(boom);

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(bodyOf(res)).toEqual({ job: JOB, error: 'Internal error' });
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockReportCronRun).toHaveBeenCalledWith(
        JOB,
        expect.objectContaining({
          status: 'error',
          message: 'redis read down',
        }),
      );
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('reports 500 and sends nothing when the DB read rejects', async () => {
      const boom = new Error('connection lost');
      mockSql.mockRejectedValueOnce(boom);

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(bodyOf(res)).toEqual({ job: JOB, error: 'Internal error' });
      expect(mockSentry.captureException).toHaveBeenCalledWith(boom);
      expect(mockReportCronRun).toHaveBeenCalledWith(
        JOB,
        expect.objectContaining({
          status: 'error',
          message: 'connection lost',
        }),
      );
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('fails loud, not current, when the last save is not a time', async () => {
      queueLastLive('not a timestamp');

      const res = await runCron();

      expect(res._status).toBe(500);
      expect(mockSentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: `live snapshot reference time unreadable for ${TODAY}`,
        }),
      );
      expect(mockRedisGet).not.toHaveBeenCalled();
      expect(mockRedisSet).not.toHaveBeenCalled();
      expect(mockSendPush).not.toHaveBeenCalled();
    });
  });
});
