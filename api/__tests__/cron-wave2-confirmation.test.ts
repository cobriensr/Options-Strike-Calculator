// @vitest-environment node

/**
 * Tests for the 5-min cron at /api/cron/wave2-confirmation.
 *
 * Phase 4 of meta-detectors-2026-05-16.md. Scans both lottery_finder_fires
 * and silent_boom_alerts for wave-1 events lacking a wave2_status, then
 * classifies each as 'confirmed' (follow-up <=30 min), 'lagging' (30-60),
 * 'fizzled' (no follow-up in the 60 min after the trigger), or skipped (not
 * settled: under 75 min old, the 60-min window plus the 15-min insert margin).
 *
 * The SQL is mocked here, so the candidate SELECT's age bounds and a table
 * that changes between ticks are NOT exercised; the real-SQL timeline in
 * cron-wave2-confirmation-pglite.test.ts covers those.
 *
 * Covers: auth guard, empty tables, all three verdicts on both tables, the
 * not-settled skip, per-table fault isolation, the partial/error status
 * propagation through the CronResult shape, and the post-close time gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../cron/wave2-confirmation.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';

// 10:00 AM ET (14:00 UTC EDT in May) — comfortably inside the cron's time
// gate. The handler also uses Date.now() to
// compute candidate age in minutes, so this NOW anchor lets us stage
// wave-1 trigger_time values at known offsets in the past.
const NOW = new Date('2026-05-21T14:00:00.000Z');

function isoMinutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

function isoMinutesAfter(base: string, min: number): string {
  return new Date(new Date(base).getTime() + min * 60_000).toISOString();
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

function lotteryCandidate(
  id: number,
  triggerIso: string,
  overrides: Partial<{
    underlying_symbol: string;
    option_type: 'C' | 'P';
  }> = {},
) {
  return {
    id,
    underlying_symbol: overrides.underlying_symbol ?? 'AAPL',
    option_type: overrides.option_type ?? 'C',
    trigger_time: triggerIso,
  };
}

describe('cron wave2-confirmation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when CRON_SECRET header is missing', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when CRON_SECRET header is wrong', async () => {
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
  });

  // ── Both tables empty ────────────────────────────────────

  it('returns success with all counts at 0 when both tables are empty', async () => {
    mockSql
      .mockResolvedValueOnce([]) // lottery candidate SELECT
      .mockResolvedValueOnce([]); // silent-boom candidate SELECT

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.rows).toBe(0);
    expect(body.lotteryProcessed).toBe(0);
    expect(body.lotteryConfirmed).toBe(0);
    expect(body.lotteryLagging).toBe(0);
    expect(body.lotteryFizzled).toBe(0);
    expect(body.silentBoomProcessed).toBe(0);
    expect(body.silentBoomConfirmed).toBe(0);
    expect(body.silentBoomLagging).toBe(0);
    expect(body.silentBoomFizzled).toBe(0);
    // Two candidate SELECTs total, nothing else.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  // ── Lottery: confirmed verdict ───────────────────────────

  it('marks a lottery candidate as confirmed when a follow-up lands within 30 min', async () => {
    const trigger = isoMinutesAgo(76); // wave-1 fired 76 min ago: settled
    const followup = isoMinutesAfter(trigger, 15); // wave-2 +15 min later

    mockSql
      .mockResolvedValueOnce([lotteryCandidate(1, trigger)]) // lottery candidates
      .mockResolvedValueOnce([{ trigger_time: followup }]) // followup SELECT
      .mockResolvedValueOnce([]) // UPDATE
      .mockResolvedValueOnce([]); // silent-boom candidates (empty)

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.lotteryProcessed).toBe(1);
    expect(body.lotteryConfirmed).toBe(1);
    expect(body.lotteryLagging).toBe(0);
    expect(body.lotteryFizzled).toBe(0);
    expect(body.rows).toBe(1);

    // 4 SQL calls: lottery candidates + lottery followup + lottery UPDATE
    // + silent-boom candidates.
    expect(mockSql).toHaveBeenCalledTimes(4);

    // Inspect the UPDATE bind args for 'confirmed' and the follow-up time.
    const updateCall = mockSql.mock.calls[2]!;
    const verdictArg = updateCall.slice(1).find((v) => v === 'confirmed');
    expect(verdictArg).toBe('confirmed');
    expect(updateCall.slice(1)).toContain(followup);
  });

  // ── Lottery: lagging verdict ─────────────────────────────

  it('marks a lottery candidate as lagging when a follow-up lands 30-60 min later', async () => {
    const trigger = isoMinutesAgo(80);
    const followup = isoMinutesAfter(trigger, 45);

    mockSql
      .mockResolvedValueOnce([lotteryCandidate(2, trigger)])
      .mockResolvedValueOnce([{ trigger_time: followup }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.lotteryProcessed).toBe(1);
    expect(body.lotteryLagging).toBe(1);
    expect(body.lotteryConfirmed).toBe(0);
    expect(body.lotteryFizzled).toBe(0);

    const updateCall = mockSql.mock.calls[2]!;
    expect(updateCall.slice(1)).toContain('lagging');
  });

  // ── Lottery: fizzled verdict ─────────────────────────────

  it('marks a lottery candidate as fizzled when no follow-up arrives and ageMin >= 75', async () => {
    const trigger = isoMinutesAgo(75); // exactly at the settle age

    mockSql
      .mockResolvedValueOnce([lotteryCandidate(3, trigger)])
      .mockResolvedValueOnce([]) // no followup
      .mockResolvedValueOnce([]) // UPDATE -> fizzled
      .mockResolvedValueOnce([]); // silent-boom candidates

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.lotteryProcessed).toBe(1);
    expect(body.lotteryFizzled).toBe(1);
    expect(body.lotteryConfirmed).toBe(0);
    expect(body.lotteryLagging).toBe(0);

    const updateCall = mockSql.mock.calls[2]!;
    // The fizzled UPDATE inlines 'fizzled' in the SQL template (not as a
    // bind), so the bind slice won't carry it. But the SQL string fragment
    // for the verdict column must appear in the strings array. Easier:
    // assert this is a different UPDATE shape than confirmed/lagging by
    // confirming none of the bind args are 'confirmed' or 'lagging'.
    const bindValues = updateCall.slice(1);
    expect(bindValues).not.toContain('confirmed');
    expect(bindValues).not.toContain('lagging');
  });

  // ── Lottery: not settled (under 75 min old) ──────────────

  // In production the candidate SELECT keeps a fire under 75 min old out of
  // the set (that bound is exercised on real SQL in
  // cron-wave2-confirmation-pglite.test.ts). The mock returns one anyway, as
  // the database clock running a little ahead of this process's would, so the
  // verdict's own age guard is what is tested here: it labels nothing.

  it.each([
    ['30 min', 30],
    ['exactly 60 min, the old fizzle age', 60],
    ['65 min', 65],
    ['74 min', 74],
    ['74 min 59 s', 74 + 59 / 60],
  ])(
    'gives a lottery fire %s old and with a follow-up already there NO label and no UPDATE',
    async (_label, ageMin) => {
      const trigger = isoMinutesAgo(ageMin);
      const followup = isoMinutesAfter(trigger, 10);

      mockSql
        .mockResolvedValueOnce([lotteryCandidate(4, trigger)])
        .mockResolvedValueOnce([{ trigger_time: followup }]) // follow-up found
        .mockResolvedValueOnce([]); // silent-boom candidates (empty)

      const res = mockResponse();
      await handler(authedReq(), res);

      expect(res._status).toBe(200);
      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.lotteryProcessed).toBe(0);
      expect(body.lotteryConfirmed).toBe(0);
      expect(body.lotteryLagging).toBe(0);
      expect(body.lotteryFizzled).toBe(0);
      expect(body.rows).toBe(0);
      // 3 SQL calls: lottery candidates + lottery follow-up + silent-boom
      // candidates. No UPDATE.
      expect(mockSql).toHaveBeenCalledTimes(3);
      for (const call of mockSql.mock.calls) {
        expect((call[0] as string[]).join('?')).not.toMatch(/UPDATE/);
      }
    },
  );

  it.each([
    ['30 min', 30],
    ['exactly 60 min, the old fizzle age', 60],
    ['74 min', 74],
  ])(
    'gives a lottery fire %s old and with no follow-up yet NO label (it is not fizzled)',
    async (_label, ageMin) => {
      mockSql
        .mockResolvedValueOnce([lotteryCandidate(4, isoMinutesAgo(ageMin))])
        .mockResolvedValueOnce([]) // no follow-up
        .mockResolvedValueOnce([]); // silent-boom candidates (empty)

      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.lotteryProcessed).toBe(0);
      expect(body.lotteryFizzled).toBe(0);
      expect(mockSql).toHaveBeenCalledTimes(3);
    },
  );

  it('gives a silent-boom alert under 75 min old NO label either', async () => {
    const trigger = isoMinutesAgo(70);

    mockSql
      .mockResolvedValueOnce([]) // lottery candidates (empty)
      .mockResolvedValueOnce([lotteryCandidate(6, trigger)]) // silent-boom candidate
      .mockResolvedValueOnce([{ trigger_time: isoMinutesAfter(trigger, 5) }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.silentBoomProcessed).toBe(0);
    expect(body.rows).toBe(0);
    // Candidates x2 + one follow-up lookup; no UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  // ── Silent-boom: same flow, different table ──────────────

  it('processes a silent-boom fizzle independently of the lottery scan', async () => {
    const trigger = isoMinutesAgo(75);

    mockSql
      .mockResolvedValueOnce([]) // lottery candidates (empty)
      .mockResolvedValueOnce([lotteryCandidate(5, trigger)]) // silent-boom candidate
      .mockResolvedValueOnce([]) // silent-boom followup (none)
      .mockResolvedValueOnce([]); // silent-boom UPDATE -> fizzled

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.silentBoomProcessed).toBe(1);
    expect(body.silentBoomFizzled).toBe(1);
    expect(body.silentBoomConfirmed).toBe(0);
    expect(body.silentBoomLagging).toBe(0);
    expect(body.lotteryProcessed).toBe(0);

    // Confirm the silent-boom branch reads `bucket_ct` — the column lives
    // in the strings template, so look it up in mock.calls[1] (candidate
    // SELECT for silent-boom) which is a TemplateStringsArray.
    const sbCandidateCall = mockSql.mock.calls[1]!;
    const strings = sbCandidateCall[0] as unknown as string[];
    const joined = strings.join(' ');
    expect(joined).toContain('bucket_ct');
    expect(joined).toContain('silent_boom_alerts');
  });

  // ── Silent-boom: confirmed verdict (covers the silent_boom_alerts UPDATE) ──

  it('marks a silent-boom candidate as confirmed when a follow-up lands within 30 min', async () => {
    const trigger = isoMinutesAgo(76);
    const followup = isoMinutesAfter(trigger, 10);

    mockSql
      .mockResolvedValueOnce([]) // lottery candidates (empty)
      .mockResolvedValueOnce([lotteryCandidate(20, trigger)]) // silent-boom candidate
      .mockResolvedValueOnce([{ trigger_time: followup }]) // silent-boom followup
      .mockResolvedValueOnce([]); // silent-boom UPDATE -> confirmed

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.silentBoomProcessed).toBe(1);
    expect(body.silentBoomConfirmed).toBe(1);
    expect(body.silentBoomLagging).toBe(0);
    expect(body.silentBoomFizzled).toBe(0);

    // The silent-boom UPDATE binds 'confirmed' (vs 'lagging' / inlined
    // 'fizzled') and points at silent_boom_alerts.
    const updateCall = mockSql.mock.calls[3]!;
    expect(updateCall.slice(1)).toContain('confirmed');
    const updateStrings = updateCall[0] as unknown as string[];
    expect(updateStrings.join(' ')).toContain('silent_boom_alerts');
  });

  // ── Error in lottery only: silent-boom still runs ────────

  it('returns status=partial when lottery throws but silent-boom succeeds', async () => {
    const lotteryErr = new Error('lottery candidate SELECT exploded');

    mockSql
      .mockRejectedValueOnce(lotteryErr) // lottery candidate SELECT throws
      .mockResolvedValueOnce([]); // silent-boom candidates (empty)

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('partial');
    expect(body.lotteryProcessed).toBe(0);
    expect(body.silentBoomProcessed).toBe(0);
    expect(body.lotteryError).toBe('lottery candidate SELECT exploded');

    expect(Sentry.captureException).toHaveBeenCalledWith(lotteryErr);
    expect(logger.error).toHaveBeenCalledWith(
      { err: lotteryErr },
      'wave2-confirmation: lottery scan failed',
    );
  });

  // ── Error in both phases: status=error ───────────────────

  it('returns status=error when both phases throw', async () => {
    const lotteryErr = new Error('lottery exploded');
    const silentBoomErr = new Error('silent-boom exploded');

    mockSql
      .mockRejectedValueOnce(lotteryErr)
      .mockRejectedValueOnce(silentBoomErr);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('error');
    expect(body.lotteryError).toBe('lottery exploded');
    expect(body.silentboomError).toBe('silent-boom exploded');

    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenNthCalledWith(1, lotteryErr);
    expect(Sentry.captureException).toHaveBeenNthCalledWith(2, silentBoomErr);
    expect(logger.error).toHaveBeenCalledWith(
      { err: silentBoomErr },
      'wave2-confirmation: silent-boom scan failed',
    );
  });

  // ── Multiple candidates, mixed verdicts ──────────────────

  it('classifies multiple lottery candidates with mixed verdicts in a single pass', async () => {
    // Candidate A: confirmed (followup at +15 min)
    const triggerA = isoMinutesAgo(76);
    const followupA = isoMinutesAfter(triggerA, 15);

    // Candidate B: lagging (followup at +45 min)
    const triggerB = isoMinutesAgo(80);
    const followupB = isoMinutesAfter(triggerB, 45);

    // Candidate C: fizzled (no followup, age 84 min)
    const triggerC = isoMinutesAgo(84);

    mockSql
      // Lottery candidates SELECT — three rows, distinct symbols so the
      // handler doesn't think any pair correlates.
      .mockResolvedValueOnce([
        lotteryCandidate(10, triggerA, { underlying_symbol: 'AAPL' }),
        lotteryCandidate(11, triggerB, { underlying_symbol: 'TSLA' }),
        lotteryCandidate(12, triggerC, { underlying_symbol: 'NVDA' }),
      ])
      // Per-candidate followup SELECT + UPDATE, in source order.
      .mockResolvedValueOnce([{ trigger_time: followupA }]) // A followup
      .mockResolvedValueOnce([]) // A UPDATE -> confirmed
      .mockResolvedValueOnce([{ trigger_time: followupB }]) // B followup
      .mockResolvedValueOnce([]) // B UPDATE -> lagging
      .mockResolvedValueOnce([]) // C followup (none)
      .mockResolvedValueOnce([]) // C UPDATE -> fizzled
      .mockResolvedValueOnce([]); // silent-boom candidates (empty)

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');
    expect(body.lotteryProcessed).toBe(3);
    expect(body.lotteryConfirmed).toBe(1);
    expect(body.lotteryLagging).toBe(1);
    expect(body.lotteryFizzled).toBe(1);
    expect(body.rows).toBe(3);
    expect(mockSql).toHaveBeenCalledTimes(8);
  });
});

// ── Post-close window ───────────────────────────────────────
//
// A fire is labelled only once it is 75 min old. The session's last fire
// (16:05:59 ET, the detectors stop at close + 5) is 75 min old at 17:20:59 ET,
// so the close + 85 tick (17:25 ET, age 79:01) is the first to label it and
// close + 90 (17:30 ET, age 84:01) is one retry, the last tick that still has
// it inside the 85-min lookback. Without a gate past the close, a fire after
// about 15:05 ET never got labelled: the next morning it was outside the
// lookback and stayed NULL instead of 'fizzled'.
//
// Here the SQL is mocked, so these tests pin the time gate and the verdict.
// That the candidate SELECT really returns the fire at 17:25 and 17:30, and
// not at 17:20, is pinned on real SQL in cron-wave2-confirmation-pglite.test.ts.
// These tests use the real cronGuard under the pinned clock.

describe('cron wave2-confirmation post-close window', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  async function runAt(iso: string) {
    vi.setSystemTime(new Date(iso));
    const res = mockResponse();
    await handler(authedReq(), res);
    return res;
  }

  it('fizzles the last fire of the session at the close + 85 tick (17:25 ET, EDT)', async () => {
    // 2026-05-21 is a Thursday in EDT. The session's last alert fired at
    // 16:05:59 ET (20:05:59Z); at 17:25 ET (21:25Z) it is 79:01 old with no
    // follow-up.
    mockSql
      .mockResolvedValueOnce([lotteryCandidate(7, '2026-05-21T20:05:59.000Z')])
      .mockResolvedValueOnce([]) // no followup
      .mockResolvedValueOnce([]) // UPDATE -> fizzled
      .mockResolvedValueOnce([]); // silent-boom candidates

    const res = await runAt('2026-05-21T21:25:00.000Z');

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryProcessed: 1,
      lotteryFizzled: 1,
    });
    const updateSql = (mockSql.mock.calls[2]![0] as string[]).join('?');
    expect(updateSql).toMatch(/SET wave2_status = 'fizzled'/);
  });

  it('still fizzles it at the close + 90 retry tick (17:30 ET, EDT), 84:01 old', async () => {
    mockSql
      .mockResolvedValueOnce([lotteryCandidate(7, '2026-05-21T20:05:59.000Z')])
      .mockResolvedValueOnce([]) // no followup
      .mockResolvedValueOnce([]) // UPDATE -> fizzled
      .mockResolvedValueOnce([]); // silent-boom candidates

    const res = await runAt('2026-05-21T21:30:00.000Z');

    expect(res._json).toMatchObject({
      status: 'success',
      lotteryProcessed: 1,
      lotteryFizzled: 1,
    });
  });

  it('leaves that same fire unlabelled one tick earlier (17:20 ET), pinning close + 85 as the first evaluable tick', async () => {
    // Same fire (16:05:59 ET) at 17:20 ET (21:20Z): age 74:01, still under
    // the 75-min settle age, so it stays NULL and no UPDATE runs. The mock
    // hands it over as a candidate regardless; the verdict decides.
    mockSql
      .mockResolvedValueOnce([lotteryCandidate(7, '2026-05-21T20:05:59.000Z')])
      .mockResolvedValueOnce([{ trigger_time: '2026-05-21T20:10:00.000Z' }]) // a follow-up is already there
      .mockResolvedValueOnce([]); // silent-boom candidates

    const res = await runAt('2026-05-21T21:20:00.000Z');

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryProcessed: 0,
      lotteryConfirmed: 0,
      lotteryFizzled: 0,
    });
    // Candidate SELECT, follow-up SELECT, silent-boom SELECT: no UPDATE.
    expect(mockSql).toHaveBeenCalledTimes(3);
    for (const call of mockSql.mock.calls) {
      expect((call[0] as string[]).join('?')).not.toMatch(/UPDATE/);
    }
  });

  it.each([
    ['EDT close + 85 (17:25 ET)', '2026-05-21T21:25:00.000Z'],
    ['EDT close + 90 (17:30 ET)', '2026-05-21T21:30:00.000Z'],
    ['EST close + 85 (17:25 ET)', '2026-12-02T22:25:00.000Z'],
    ['EST close + 90 (17:30 ET)', '2026-12-02T22:30:00.000Z'],
    ['half-day close + 85 (14:25 ET)', '2026-11-27T19:25:00.000Z'],
    ['half-day close + 90 (14:30 ET)', '2026-11-27T19:30:00.000Z'],
  ])('still runs at %s', async (_label, iso) => {
    mockSql.mockResolvedValue([]);

    const res = await runAt(iso);

    expect(res._json).not.toMatchObject({ reason: 'Outside time window' });
    // One candidate SELECT per table.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['EDT close + 95 (17:35 ET)', '2026-05-21T21:35:00.000Z'],
    ['EST close + 95 (17:35 ET)', '2026-12-02T22:35:00.000Z'],
    ['half-day close + 95 (14:35 ET)', '2026-11-27T19:35:00.000Z'],
    ['a market holiday (Thanksgiving) mid-session', '2026-11-26T15:00:00.000Z'],
  ])('skips at %s, past the gate', async (_label, iso) => {
    const res = await runAt(iso);

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
  });
});
