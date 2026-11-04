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
    // Each binds the lookback and the settle age: 90 (75 + 15) and 75. The
    // SQL is mocked, so this is the only place the unit tests see them.
    for (const call of mockSql.mock.calls) {
      expect(call.slice(1)).toEqual([90, 75]);
    }
    // Not the last tick of the session: no lost-slice check, no metadata.
    expect(body).not.toHaveProperty('lotteryLostSlice');
    expect(body).not.toHaveProperty('silentBoomLostSlice');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
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
// close + 90 (17:30 ET, age 84:01) is one retry, inside the 90-min lookback,
// and the last tick of the session (the gate ends there; 17:35 is closed even
// though the fire would still be inside the lookback at age 89:01). Without a
// gate past the close, a fire after about 15:05 ET never got labelled: the
// next morning it was outside the lookback and stayed NULL instead of
// 'fizzled'.
//
// Here the SQL is mocked, so these tests pin the time gate and the verdict.
// That the candidate SELECT really returns the fire at 17:25 and 17:30, and
// not at 17:20, is pinned on real SQL in cron-wave2-confirmation-pglite.test.ts.
// These tests use the real cronGuard under the pinned clock.

/** What the lost-slice COUNT returns when nothing is lost. */
const NO_LOST_SLICE = [{ lost: 0, earliest: null, latest: null }];

/** Run the real handler once with the clock pinned at `iso`. */
async function runAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  const res = mockResponse();
  await handler(authedReq(), res);
  return res;
}

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
      .mockResolvedValueOnce([]) // silent-boom candidates
      .mockResolvedValueOnce(NO_LOST_SLICE) // last tick: lottery lost-slice count
      .mockResolvedValueOnce(NO_LOST_SLICE); // last tick: silent-boom count

    const res = await runAt('2026-05-21T21:30:00.000Z');

    expect(res._json).toMatchObject({
      status: 'success',
      lotteryProcessed: 1,
      lotteryFizzled: 1,
      lotteryLostSlice: 0,
      silentBoomLostSlice: 0,
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
    ['EST close + 85 (17:25 ET)', '2026-12-02T22:25:00.000Z'],
    ['half-day close + 85 (14:25 ET)', '2026-11-27T19:25:00.000Z'],
  ])('still runs at %s', async (_label, iso) => {
    mockSql.mockResolvedValue([]);

    const res = await runAt(iso);

    expect(res._json).not.toMatchObject({ reason: 'Outside time window' });
    // One candidate SELECT per table, and no lost-slice count: not the last tick.
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['EDT close + 90 (17:30 ET)', '2026-05-21T21:30:00.000Z'],
    ['EST close + 90 (17:30 ET)', '2026-12-02T22:30:00.000Z'],
    ['half-day close + 90 (14:30 ET)', '2026-11-27T19:30:00.000Z'],
  ])('still runs at %s, the last tick', async (_label, iso) => {
    mockSql
      .mockResolvedValueOnce([]) // lottery candidates
      .mockResolvedValueOnce([]) // silent-boom candidates
      .mockResolvedValueOnce(NO_LOST_SLICE) // lottery lost-slice count
      .mockResolvedValueOnce(NO_LOST_SLICE); // silent-boom lost-slice count

    const res = await runAt(iso);

    expect(res._json).not.toMatchObject({ reason: 'Outside time window' });
    // One candidate SELECT and one lost-slice COUNT per table.
    expect(mockSql).toHaveBeenCalledTimes(4);
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

// ── Lost-slice alert (last tick of the session) ──────────────
//
// A fire the cron misses for more than the 90-min lookback is never labelled
// by it. On the last tick of the session (close + 90, 17:30 ET) the cron
// counts today's NULL rows older than the lookback in each table and sends one
// fingerprinted error-level message per table (error, because that is the
// level the Sentry project's high-priority rule emails the owner for). The
// fingerprint ends in the ET date, so a later day opens a new issue. The count
// SQL itself (ET-midnight bound, the NULL and age predicates) runs on real
// Postgres in cron-wave2-confirmation-pglite.test.ts.

describe('cron wave2-confirmation lost-slice alert', () => {
  const originalEnv = process.env;
  const LAST_TICK = '2026-05-21T21:30:00.000Z'; // 17:30 ET, EDT
  const LOTTERY_FINGERPRINT = [
    'wave2-confirmation',
    'lost-slice',
    'lottery_finder_fires',
    '2026-05-21',
  ];
  const SILENT_BOOM_FINGERPRINT = [
    'wave2-confirmation',
    'lost-slice',
    'silent_boom_alerts',
    '2026-05-21',
  ];

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

  /** Both candidate SELECTs empty, then the two lost-slice COUNTs. */
  function queueLastTick(lottery: unknown, silentBoom: unknown) {
    mockSql
      .mockResolvedValueOnce([]) // lottery candidates
      .mockResolvedValueOnce([]) // silent-boom candidates
      .mockResolvedValueOnce(lottery) // lottery lost-slice COUNT
      .mockResolvedValueOnce(silentBoom); // silent-boom lost-slice COUNT
  }

  it('sends one error-level, fingerprinted alert per table with the count and the first and last trigger time', async () => {
    queueLastTick(
      [
        {
          lost: 3,
          earliest: '2026-05-21T13:41:00.000Z',
          latest: '2026-05-21T19:55:00.000Z',
        },
      ],
      // The driver may hand back a Date; the extra carries an ISO string.
      [
        {
          lost: 2,
          earliest: new Date('2026-05-21T14:05:00.000Z'),
          latest: new Date('2026-05-21T15:10:00.000Z'),
        },
      ],
    );

    const res = await runAt(LAST_TICK);

    expect(res._status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('3 lottery_finder_fires row(s)'),
      {
        level: 'error',
        fingerprint: LOTTERY_FINGERPRINT,
        tags: { 'cron.anomaly': 'wave2-lost-slice' },
        extra: {
          table: 'lottery_finder_fires',
          date: '2026-05-21',
          lost: 3,
          earliestTrigger: '2026-05-21T13:41:00.000Z',
          latestTrigger: '2026-05-21T19:55:00.000Z',
          lookbackMin: 90,
        },
      },
    );
    expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('2 silent_boom_alerts row(s)'),
      {
        level: 'error',
        fingerprint: SILENT_BOOM_FINGERPRINT,
        tags: { 'cron.anomaly': 'wave2-lost-slice' },
        extra: {
          table: 'silent_boom_alerts',
          date: '2026-05-21',
          lost: 2,
          earliestTrigger: '2026-05-21T14:05:00.000Z',
          latestTrigger: '2026-05-21T15:10:00.000Z',
          lookbackMin: 90,
        },
      },
    );
    // The alert says how to repair the rows.
    const message = vi.mocked(Sentry.captureMessage).mock.calls[0]![0];
    expect(message).toContain('scripts/backfill-wave2-status.ts');
    // The count is in the run's metadata too, and the run itself is healthy.
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: 3,
      silentBoomLostSlice: 2,
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('binds today (ET) and the 90-min lookback in both COUNTs, over NULL rows only', async () => {
    queueLastTick(NO_LOST_SLICE, NO_LOST_SLICE);

    await runAt(LAST_TICK);

    expect(mockSql).toHaveBeenCalledTimes(4);
    for (const index of [2, 3]) {
      const call = mockSql.mock.calls[index]!;
      expect((call[0] as string[]).join('?')).toMatch(
        /COUNT\(\*\).*wave2_status IS NULL/s,
      );
      expect(call.slice(1)).toEqual(['2026-05-21', 90]);
    }
  });

  it('alerts only for the table that lost rows', async () => {
    queueLastTick(NO_LOST_SLICE, [
      {
        lost: 1,
        earliest: '2026-05-21T16:00:00.000Z',
        latest: '2026-05-21T16:00:00.000Z',
      },
    ]);

    const res = await runAt(LAST_TICK);

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: SILENT_BOOM_FINGERPRINT }),
    );
    expect(res._json).toMatchObject({
      lotteryLostSlice: 0,
      silentBoomLostSlice: 1,
    });
  });

  it('sends no alert when nothing is lost, and records the zero counts', async () => {
    queueLastTick(NO_LOST_SLICE, NO_LOST_SLICE);

    const res = await runAt(LAST_TICK);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: 0,
      silentBoomLostSlice: 0,
    });
  });

  it.each([
    ['mid-session (10:00 ET)', '2026-05-21T14:00:00.000Z'],
    ['the 17:25 ET tick, close + 85 (EDT)', '2026-05-21T21:25:00.000Z'],
    ['the 17:25 ET tick, close + 85 (EST)', '2026-12-02T22:25:00.000Z'],
    ['the 14:25 ET tick of a half-day', '2026-11-27T19:25:00.000Z'],
  ])('runs no count and sends no alert at %s', async (_label, iso) => {
    mockSql.mockResolvedValue([]); // nothing to label

    const res = await runAt(iso);

    // The two candidate SELECTs only: not the last tick.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(res._json).not.toHaveProperty('lotteryLostSlice');
    expect(res._json).not.toHaveProperty('silentBoomLostSlice');
  });

  it('runs no count at 17:35 ET, which the gate skips', async () => {
    const res = await runAt('2026-05-21T21:35:00.000Z');

    expect(res._json).toEqual({
      skipped: true,
      reason: 'Outside time window',
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['EST (17:30 ET)', '2026-12-02T22:30:00.000Z', '2026-12-02'],
    ['a half-day (14:30 ET)', '2026-11-27T19:30:00.000Z', '2026-11-27'],
  ])(
    'finds the last tick on %s through the market calendar',
    async (_label, iso, etDate) => {
      queueLastTick(
        [
          {
            lost: 4,
            earliest: '2026-05-21T13:41:00.000Z',
            latest: '2026-05-21T13:59:00.000Z',
          },
        ],
        NO_LOST_SLICE,
      );

      const res = await runAt(iso);

      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      // The fingerprint ends in that run's own ET date, not a fixed one.
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          fingerprint: [
            'wave2-confirmation',
            'lost-slice',
            'lottery_finder_fires',
            etDate,
          ],
        }),
      );
      expect(res._json).toMatchObject({ lotteryLostSlice: 4 });
    },
  );

  it('catches a failed COUNT, surfaces it by name, still checks the other table and does not fail the run', async () => {
    const countErr = new Error('connection lost');
    mockSql
      .mockResolvedValueOnce([]) // lottery candidates
      .mockResolvedValueOnce([]) // silent-boom candidates
      .mockRejectedValueOnce(countErr) // lottery lost-slice COUNT
      .mockResolvedValueOnce([
        {
          lost: 1,
          earliest: '2026-05-21T16:00:00.000Z',
          latest: '2026-05-21T16:00:00.000Z',
        },
      ]); // silent-boom lost-slice COUNT

    const res = await runAt(LAST_TICK);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: null,
      silentBoomLostSlice: 1,
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(countErr);
    expect(logger.error).toHaveBeenCalledWith(
      { err: countErr },
      'wave2-confirmation: lottery lost-slice count failed',
    );
    // The other table's COUNT still ran and still warned.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fingerprint: SILENT_BOOM_FINGERPRINT }),
    );
  });

  it('treats a COUNT that returns no row as a failure, not as zero lost', async () => {
    queueLastTick([], NO_LOST_SLICE);

    const res = await runAt(LAST_TICK);

    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: null,
      silentBoomLostSlice: 0,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'lost-slice count returned no row',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'wave2-confirmation: lottery lost-slice count failed',
    );
  });

  it('still sends the alert, with null first and last trigger times, when the COUNT returns an unparseable timestamp', async () => {
    // A positive count is known. A garbage timestamp must not turn it into a
    // "count failed" and lose the alert (new Date(...).toISOString() throws a
    // RangeError on an invalid date). A string and a Date are both covered.
    queueLastTick(
      [
        {
          lost: 2,
          earliest: 'not-a-timestamp',
          latest: new Date(Number.NaN),
        },
      ],
      NO_LOST_SLICE,
    );

    const res = await runAt(LAST_TICK);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('2 lottery_finder_fires row(s)'),
      {
        level: 'error',
        fingerprint: LOTTERY_FINGERPRINT,
        tags: { 'cron.anomaly': 'wave2-lost-slice' },
        extra: {
          table: 'lottery_finder_fires',
          date: '2026-05-21',
          lost: 2,
          earliestTrigger: null,
          latestTrigger: null,
          lookbackMin: 90,
        },
      },
    );
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: 2,
      silentBoomLostSlice: 0,
    });
  });

  it('reads the last-tick clock before labelling, so a run that crosses 17:31 still counts the lost slice', async () => {
    // The tick starts at 17:30:40 ET (21:30:40Z). The first candidate SELECT
    // takes 25 s, so by the time labelling ends the wall clock reads 17:31:05
    // and a last-tick check made then would see 17:31 and skip the count.
    const STARTED_AT = '2026-05-21T21:30:40.000Z';
    mockSql
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(25_000); // labelling takes 25 s
        return [];
      }) // lottery candidates
      .mockResolvedValueOnce([]) // silent-boom candidates
      .mockResolvedValueOnce([
        {
          lost: 3,
          earliest: '2026-05-21T13:41:00.000Z',
          latest: '2026-05-21T19:55:00.000Z',
        },
      ]) // lottery lost-slice COUNT
      .mockResolvedValueOnce(NO_LOST_SLICE); // silent-boom lost-slice COUNT

    const res = await runAt(STARTED_AT);

    // The clock really did cross 17:31:00 ET while the tick ran.
    expect(Date.now()).toBeGreaterThan(
      new Date('2026-05-21T21:31:00.000Z').getTime(),
    );
    // Two candidate SELECTs and two COUNTs ran, and the alert went out.
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('3 lottery_finder_fires row(s)'),
      expect.objectContaining({
        level: 'error',
        fingerprint: LOTTERY_FINGERPRINT,
      }),
    );
    expect(res._json).toMatchObject({
      status: 'success',
      lotteryLostSlice: 3,
      silentBoomLostSlice: 0,
    });
  });

  it.each([
    ['lottery', 'lotteryError'],
    ['silent-boom', 'silentboomError'],
  ])(
    'on the last tick, still counts both tables and alerts when the %s scan throws, and reports a partial run',
    async (failing, errorKey) => {
      const scanErr = new Error(`${failing} scan down`);
      const queueScan = (fails: boolean) =>
        fails
          ? mockSql.mockRejectedValueOnce(scanErr)
          : mockSql.mockResolvedValueOnce([]);
      queueScan(failing === 'lottery'); // lottery candidates
      queueScan(failing === 'silent-boom'); // silent-boom candidates
      mockSql
        .mockResolvedValueOnce([
          {
            lost: 2,
            earliest: '2026-05-21T13:41:00.000Z',
            latest: '2026-05-21T19:55:00.000Z',
          },
        ]) // lottery lost-slice COUNT
        .mockResolvedValueOnce([
          {
            lost: 1,
            earliest: '2026-05-21T16:00:00.000Z',
            latest: '2026-05-21T16:00:00.000Z',
          },
        ]); // silent-boom lost-slice COUNT

      const res = await runAt(LAST_TICK);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        status: 'partial',
        [errorKey]: scanErr.message,
        lotteryLostSlice: 2,
        silentBoomLostSlice: 1,
      });
      // The scan failure is the only exception captured; the counts did not fail.
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(scanErr);
      // Two scans and two COUNTs ran, and each table raised its alert.
      expect(mockSql).toHaveBeenCalledTimes(4);
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
      expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('2 lottery_finder_fires row(s)'),
        expect.objectContaining({
          level: 'error',
          fingerprint: LOTTERY_FINGERPRINT,
        }),
      );
      expect(Sentry.captureMessage).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('1 silent_boom_alerts row(s)'),
        expect.objectContaining({
          level: 'error',
          fingerprint: SILENT_BOOM_FINGERPRINT,
        }),
      );
    },
  );
});
