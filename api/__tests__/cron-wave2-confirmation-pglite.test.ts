// @vitest-environment node

/**
 * REAL-SQL timeline test for the wave2-confirmation settle age.
 *
 * cron-wave2-confirmation.test.ts mocks the SQL, so it cannot see the
 * candidate SELECT's age bounds or a table that changes between ticks. This
 * file runs the cron's real handler tick by tick on pglite (real Postgres in
 * WASM), on tables built by the real migrations (#110 lottery_finder_fires,
 * #134 silent_boom_alerts, #164 the wave2 columns), and writes rows into the
 * table the way the detectors do: some of them minutes AFTER the trigger time
 * they carry.
 *
 * The bug it pins (fixed 2026-11-04): fires reach the table 40 s to 9 min
 * after their trigger time. A cron that labelled a fire as soon as it could
 * (a follow-up exists, or age 60) saw a table that was still missing rows. It
 * fizzled fires whose follow-up was not written yet, and recorded a later
 * follow-up as the first one when an earlier one arrived late. The cron now
 * waits until a fire is 75 minutes old (SETTLE_AGE_MIN), so every label is the
 * one a complete table gives. The lookback is 90 minutes (SETTLE_AGE_MIN + 15),
 * so a fire survives two missed ticks in a row, and on the session's last tick
 * the cron counts today's rows that fell out of it (a lost slice).
 *
 * Every expected label is written out by hand, from the rule, not read back
 * from the code. pglite's now() follows the faked Date. The session time zone
 * is Asia/Tokyo, neither UTC nor New York, so a bound that leans on the
 * session zone would shift. Only the DB handle, the logger and Sentry are
 * replaced; cronGuard and the market-hours gate are real.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { mockRequest, mockResponse } from './helpers';
import { applyMigration, neonOverPglite } from './pglite-migrations';

const holder = vi.hoisted(() => ({
  sql: null as unknown,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: () => holder.sql,
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
import { Sentry } from '../_lib/sentry.js';

type TableName = 'lottery_finder_fires' | 'silent_boom_alerts';
const TABLES: TableName[] = ['lottery_finder_fires', 'silent_boom_alerts'];

let pg: PGlite;
const originalSecret = process.env.CRON_SECRET;

beforeAll(async () => {
  process.env.CRON_SECRET = 'test-secret';
  pg = await PGlite.create();
  await pg.query(`SET TimeZone = 'Asia/Tokyo'`);
  await applyMigration(pg, 110);
  await applyMigration(pg, 134);
  await applyMigration(pg, 164);
  vi.useFakeTimers({ toFake: ['Date'] });
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  await pg.close();
});

// ── Harness ──────────────────────────────────────────────────────────

async function resetTables(): Promise<void> {
  await pg.query(
    'TRUNCATE lottery_finder_fires, silent_boom_alerts RESTART IDENTITY',
  );
}

async function insertRow(
  table: TableName,
  row: { label: string; sym: string; at: string },
): Promise<void> {
  const params = [row.at, row.label, row.sym, 'C'];
  if (table === 'lottery_finder_fires') {
    await pg.query(
      `INSERT INTO lottery_finder_fires (
         date, trigger_time_ct, entry_time_ct, option_chain_id,
         underlying_symbol, option_type, strike, expiry, dte,
         trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
         trigger_delta, trigger_ask_pct, trigger_window_size,
         trigger_window_prints, entry_price, open_interest, spot_at_first,
         alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged)
       VALUES (
         ($1::timestamptz AT TIME ZONE 'America/New_York')::date,
         $1::timestamptz, $1::timestamptz, $2, $3, $4, 100, '2026-12-31', 0,
         1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 1, 'call_ask', 'PM',
         'A_intraday_0DTE', false, false)`,
      params,
    );
  } else {
    await pg.query(
      `INSERT INTO silent_boom_alerts (
         date, bucket_ct, option_chain_id, underlying_symbol, option_type,
         strike, expiry, dte, spike_volume, baseline_volume, spike_ratio,
         ask_pct, vol_oi, entry_price, open_interest)
       VALUES (
         ($1::timestamptz AT TIME ZONE 'America/New_York')::date,
         $1::timestamptz, $2, $3, $4, 100, '2026-12-31', 0,
         1, 1, 1, 1, 1, 1, 1)`,
      params,
    );
  }
}

/** label -> "status @ detected" for every row of a table. */
async function snapshot(table: TableName): Promise<Map<string, string>> {
  const { rows } = await pg.query<{
    label: string;
    status: string | null;
    detected: Date | null;
  }>(
    `SELECT option_chain_id AS label, wave2_status AS status,
            wave2_detected_at AS detected
       FROM ${table} ORDER BY option_chain_id`,
  );
  return new Map(
    rows.map((r) => [
      r.label,
      `${r.status ?? 'NULL'} @ ${r.detected ? r.detected.toISOString() : '-'}`,
    ]),
  );
}

interface Tick {
  /** The statements the handler sent, as text with `?` for each bind. */
  sent: string[];
  body: Record<string, unknown>;
}

/** Run the real handler once at `iso`, recording every statement it sends. */
async function tick(
  iso: string,
  query: Record<string, string> = {},
): Promise<Tick> {
  vi.setSystemTime(new Date(iso));
  const client = neonOverPglite(pg);
  const sent: string[] = [];
  holder.sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const q = client(strings, ...params);
    sent.push(strings.join('?'));
    return q;
  };
  const res = mockResponse();
  await handler(
    mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
      query,
    }),
    res,
  );
  expect(res._status).toBe(200);
  return { sent, body: res._json as Record<string, unknown> };
}

const updates = (t: Tick) => t.sent.filter((s) => /UPDATE/.test(s));
const followupLookups = (t: Tick) => t.sent.filter((s) => /ORDER BY/.test(s));
const lostSliceCounts = (t: Tick) =>
  t.sent.filter((s) => /COUNT\(\*\)/.test(s));

// ── Late writes: the fires the old cron got wrong ────────────────────

const T0 = Date.parse('2026-05-21T14:00:00.000Z'); // 10:00 ET, Thursday, EDT
const minuteIso = (min: number) => new Date(T0 + min * 60_000).toISOString();

interface TimelineRow {
  label: string;
  sym: string;
  /** Minutes after T0 that the row's trigger time carries. */
  triggerMin: number;
  /** Minutes after T0 at which the row reaches the table. */
  writtenMin: number;
}

/**
 * Two groups of same-symbol, same-side fires. Write delays are within the
 * observed 40 s to 9 min.
 *
 *   LATE: W fires at 0. F2 fires at +8 and is written at +9. F1 fires at +3,
 *     earlier than F2, but is written only at +12. A cron deciding at +11
 *     finds F2 and takes it as W's first follow-up. The complete table says
 *     F1.
 *   SOLE: S fires at 0 and has one follow-up, SF, which fires at +59 but is
 *     written at +68. A cron deciding at +61 finds nothing and fizzles S. The
 *     complete table says lagging.
 */
const TIMELINE: TimelineRow[] = [
  { label: 'W', sym: 'LATE', triggerMin: 0, writtenMin: 1 },
  { label: 'F2', sym: 'LATE', triggerMin: 8, writtenMin: 9 },
  { label: 'F1', sym: 'LATE', triggerMin: 3, writtenMin: 12 },
  { label: 'S', sym: 'SOLE', triggerMin: 0, writtenMin: 1 },
  { label: 'SF', sym: 'SOLE', triggerMin: 59, writtenMin: 68 },
];

/** The labels a complete table gives, by hand from the 30 / 60 minute rule. */
const COMPLETE_LABELS: Record<string, string> = {
  W: `confirmed @ ${minuteIso(3)}`, // earliest follow-up is F1 at +3
  F1: `confirmed @ ${minuteIso(8)}`, // F2 at +8, 5 min after F1
  F2: 'fizzled @ -', // nothing fires after it
  S: `lagging @ ${minuteIso(59)}`, // SF at +59: past 30, inside 60
  SF: 'fizzled @ -',
};

/** Ticks every 5 minutes from T0 + 1 until every row is past the lookback. */
const TICK_MINUTES = Array.from({ length: 30 }, (_, i) => 1 + 5 * i);

describe.each(TABLES)('wave2-confirmation timeline: %s', (table) => {
  const ticks = new Map<number, Tick>();
  const snapshots = new Map<number, Map<string, string>>();

  beforeAll(async () => {
    await resetTables();
    const pending = [...TIMELINE];
    for (const minute of TICK_MINUTES) {
      for (const row of pending.filter((r) => r.writtenMin <= minute)) {
        await insertRow(table, {
          label: row.label,
          sym: row.sym,
          at: minuteIso(row.triggerMin),
        });
        pending.splice(pending.indexOf(row), 1);
      }
      ticks.set(minute, await tick(minuteIso(minute)));
      snapshots.set(minute, await snapshot(table));
    }
    expect(pending).toEqual([]);
  }, 120_000);

  it('sends only the two candidate SELECTs at every tick before a fire is 75 minutes old', () => {
    // A fire younger than 75 minutes is no candidate, so no follow-up lookup
    // and no UPDATE is issued, whatever the table holds at that moment. SF is
    // the youngest row (trigger +59): the earliest candidate tick is the
    // first one that finds W and S 75 minutes old, at minute 76.
    for (const minute of TICK_MINUTES.filter((m) => m < 76)) {
      expect(ticks.get(minute)?.sent.length, `minute ${minute}`).toBe(2);
      const labelled = [...(snapshots.get(minute) ?? [])].filter(
        ([, v]) => v !== 'NULL @ -',
      );
      expect(labelled, `minute ${minute}`).toEqual([]);
    }
  });

  it('does not take F2 as the first follow-up of W at the +11 tick, where F1 is not written yet', () => {
    // The old cron labelled W confirmed @ +8 here, at once, and never revised it.
    expect(snapshots.get(11)?.get('W')).toBe('NULL @ -');
    expect(updates(ticks.get(11)!)).toEqual([]);
  });

  it('does not fizzle S at the +61 tick, where its follow-up SF is not written yet', () => {
    // The old cron fizzled S at age 60, permanently.
    expect(snapshots.get(61)?.get('S')).toBe('NULL @ -');
    expect(updates(ticks.get(61)!)).toEqual([]);
    expect(followupLookups(ticks.get(61)!)).toEqual([]);
  });

  it('still has not labelled S at +71, with SF already written but S 71 minutes old', () => {
    expect(snapshots.get(71)?.get('SF')).toBe('NULL @ -');
    expect(snapshots.get(71)?.get('S')).toBe('NULL @ -');
    expect(updates(ticks.get(71)!)).toEqual([]);
  });

  it('labels W and S at the first tick that finds them 75 minutes old (+76), from the complete table', () => {
    const at76 = snapshots.get(76);
    expect(at76?.get('W')).toBe(COMPLETE_LABELS.W);
    expect(at76?.get('S')).toBe(COMPLETE_LABELS.S);
    // The other rows are younger than 75 minutes and stay NULL.
    expect(at76?.get('F1')).toBe('NULL @ -');
    expect(at76?.get('F2')).toBe('NULL @ -');
    expect(at76?.get('SF')).toBe('NULL @ -');
  });

  it('ends with the label a complete table gives for every row', () => {
    const last = snapshots.get(TICK_MINUTES.at(-1) ?? 0);
    expect(Object.fromEntries(last ?? [])).toEqual(COMPLETE_LABELS);
  });

  it('writes each label once: a tick that finds no new candidate sends no UPDATE', () => {
    const labelled = TICK_MINUTES.filter((m) => updates(ticks.get(m)!).length);
    // W and S settle together at +76; F1 (+3) at +81 (age 78), F2 (+8) at
    // +86 (age 78), SF (+59) at +136 (age 77).
    expect(labelled).toEqual([76, 81, 86, 136]);
  });
});

// ── The post-close ticks ─────────────────────────────────────────────

/**
 * The session's last fire, 16:05:59 ET (the detectors stop at close + 5), with
 * no follow-up. It is 75 minutes old at 17:20:59 ET, so the 17:25 tick is the
 * first that can label it and the 17:30 tick is the retry (age 84:01, inside
 * the 90-minute lookback). The gate (close + 90) ends the retries there, not
 * the lookback: at 17:35 the fire would still be a candidate (age 89:01), and
 * only at 17:40 (age 94:01) is it outside the lookback.
 */
const REGIMES = [
  {
    name: 'EDT',
    fire: '2026-05-21T20:05:59.000Z',
    t1720: '2026-05-21T21:20:00.000Z',
    t1725: '2026-05-21T21:25:00.000Z',
    t1730: '2026-05-21T21:30:00.000Z',
    t1735: '2026-05-21T21:35:00.000Z',
    t1740: '2026-05-21T21:40:00.000Z',
  },
  {
    name: 'EST',
    fire: '2026-12-02T21:05:59.000Z',
    t1720: '2026-12-02T22:20:00.000Z',
    t1725: '2026-12-02T22:25:00.000Z',
    t1730: '2026-12-02T22:30:00.000Z',
    t1735: '2026-12-02T22:35:00.000Z',
    t1740: '2026-12-02T22:40:00.000Z',
  },
] as const;

describe.each(TABLES)('wave2-confirmation post-close: %s', (table) => {
  beforeEach(async () => {
    await resetTables();
  });

  describe.each(REGIMES)('$name', (r) => {
    beforeEach(async () => {
      await insertRow(table, { label: 'LAST', sym: 'LAST', at: r.fire });
    });

    it('leaves the last fire alone at 17:20 ET, 74:01 old', async () => {
      const t = await tick(r.t1720);
      expect(t.sent.length).toBe(2);
      expect((await snapshot(table)).get('LAST')).toBe('NULL @ -');
    });

    it('fizzles it at 17:25 ET, the first tick that finds it 75 minutes old', async () => {
      const t = await tick(r.t1725);
      expect(updates(t).length).toBe(1);
      expect((await snapshot(table)).get('LAST')).toBe('fizzled @ -');
    });

    it('fizzles it at the 17:30 ET retry when the 17:25 tick never ran', async () => {
      const t = await tick(r.t1730);
      expect(updates(t).length).toBe(1);
      expect((await snapshot(table)).get('LAST')).toBe('fizzled @ -');
    });

    it('sends nothing at 17:35 ET: the gate is closed, though the fire is still inside the lookback', async () => {
      // The real gate answers before any SQL is sent.
      const t = await tick(r.t1735);
      expect(t.body).toEqual({ skipped: true, reason: 'Outside time window' });
      expect(t.sent).toEqual([]);
      expect((await snapshot(table)).get('LAST')).toBe('NULL @ -');
    });

    it('would still find it at 17:35 ET with force=1 (89:01 of a 90-minute lookback), so the gate ends the retries, not the lookback', async () => {
      const t = await tick(r.t1735, { force: '1' });
      expect(updates(t).length).toBe(1);
      expect((await snapshot(table)).get('LAST')).toBe('fizzled @ -');
    });

    it('no longer finds it at 17:40 ET with force=1 (94:01 old), past the lookback', async () => {
      const t = await tick(r.t1740, { force: '1' });
      expect(t.sent.length).toBe(2);
      expect((await snapshot(table)).get('LAST')).toBe('NULL @ -');
    });
  });
});

// ── Missed ticks: the 90-minute lookback ─────────────────────────────

/**
 * A fire is a candidate from age 75:00 to 90:00, so three 5-minute ticks look
 * at it. A fire that first turns 75 at the +77 tick has its looks at +77, +82
 * and +87 (age 77, 82, 87). The lookback was 85 minutes: two missed ticks in a
 * row left the +87 look outside it and the fire NULL forever.
 */
describe.each(TABLES)('wave2-confirmation missed ticks: %s', (table) => {
  beforeEach(async () => {
    await resetTables();
    await insertRow(table, { label: 'W', sym: 'MISS', at: minuteIso(0) });
  });

  it('labels a fire at its third look (age 87) when the two ticks before it never ran', async () => {
    const t = await tick(minuteIso(87));
    expect(updates(t).length).toBe(1);
    expect((await snapshot(table)).get('W')).toBe('fizzled @ -');
  });

  it('still labels it at exactly 90:00 old, the inclusive bound', async () => {
    const t = await tick(minuteIso(90));
    expect(updates(t).length).toBe(1);
    expect((await snapshot(table)).get('W')).toBe('fizzled @ -');
  });

  it('no longer sees it at 90:01 old: that fire is a lost slice for the cron', async () => {
    const t = await tick(new Date(T0 + 90 * 60_000 + 1000).toISOString());
    expect(t.sent.length).toBe(2);
    expect((await snapshot(table)).get('W')).toBe('NULL @ -');
  });
});

// ── The lost-slice check on the last tick ────────────────────────────

/** 17:30 ET on 2026-05-21 (EDT): close + 90, the last tick of the session. */
const LAST_TICK = '2026-05-21T21:30:00.000Z';

/**
 * Rows on one table, all NULL unless noted. Written out by hand: which of
 * them the last tick must count (older than 90 minutes at 17:30 ET and fired
 * on 2026-05-21 ET) and which it must leave alone.
 *
 *   counted:  MIDNIGHT 00:00:30 ET, LOST_AM 09:41 ET, LOST_PM 15:55 ET (95 min)
 *   not:      PREV_LATE 23:59:30 ET the day before (a bound read in the Tokyo
 *             session zone would count it), PREV_DAY 15:00 ET the day before,
 *             DONE (already labelled), JUST_IN 16:00:30 ET (89:30 old, still a
 *             candidate, so this very tick labels it) and LAST 16:05:59 ET.
 */
const LOST_ROWS = [
  { label: 'MIDNIGHT', at: '2026-05-21T04:00:30.000Z' },
  { label: 'LOST_AM', at: '2026-05-21T13:41:00.000Z' },
  { label: 'LOST_PM', at: '2026-05-21T19:55:00.000Z' },
  { label: 'PREV_LATE', at: '2026-05-21T03:59:30.000Z' },
  { label: 'PREV_DAY', at: '2026-05-20T19:00:00.000Z' },
  { label: 'DONE', at: '2026-05-21T14:00:00.000Z' },
  { label: 'JUST_IN', at: '2026-05-21T20:00:30.000Z' },
  { label: 'LAST', at: '2026-05-21T20:05:59.000Z' },
] as const;

const LOST_KEY = {
  lottery_finder_fires: 'lotteryLostSlice',
  silent_boom_alerts: 'silentBoomLostSlice',
} as const;

describe.each(TABLES)('wave2-confirmation lost slice: %s', (table) => {
  const own = LOST_KEY[table];
  const other = LOST_KEY[TABLES.find((t) => t !== table) ?? table];

  beforeEach(async () => {
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
    await resetTables();
    for (const row of LOST_ROWS) {
      await insertRow(table, { label: row.label, sym: row.label, at: row.at });
    }
    await pg.query(
      `UPDATE ${table} SET wave2_status = 'fizzled' WHERE option_chain_id = 'DONE'`,
    );
  });

  it('counts the unlabelled rows of today older than the lookback and alerts once, with their first and last trigger time', async () => {
    const t = await tick(LAST_TICK);

    expect(t.body).toMatchObject({
      status: 'success',
      [own]: 3,
      [other]: 0,
    });
    expect(lostSliceCounts(t).length).toBe(2);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('scripts/backfill-wave2-status.ts'),
      {
        level: 'error',
        fingerprint: ['wave2-confirmation', 'lost-slice', table, '2026-05-21'],
        tags: { 'cron.anomaly': 'wave2-lost-slice' },
        extra: {
          table,
          date: '2026-05-21',
          lost: 3,
          earliestTrigger: '2026-05-21T04:00:30.000Z',
          latestTrigger: '2026-05-21T19:55:00.000Z',
          lookbackMin: 90,
        },
      },
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('labels the rows still inside the lookback in the same tick and leaves the lost ones NULL', async () => {
    await tick(LAST_TICK);

    const rows = await snapshot(table);
    expect(rows.get('JUST_IN')).toBe('fizzled @ -');
    expect(rows.get('LAST')).toBe('fizzled @ -');
    expect(rows.get('DONE')).toBe('fizzled @ -');
    for (const label of [
      'MIDNIGHT',
      'LOST_AM',
      'LOST_PM',
      'PREV_LATE',
      'PREV_DAY',
    ]) {
      expect(rows.get(label), label).toBe('NULL @ -');
    }
  });

  it('sends no count and no alert at the 17:25 ET tick', async () => {
    const t = await tick('2026-05-21T21:25:00.000Z');

    expect(lostSliceCounts(t)).toEqual([]);
    expect(t.body).not.toHaveProperty(own);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('sends no alert when nothing is lost', async () => {
    await pg.query(
      `UPDATE ${table} SET wave2_status = 'fizzled' WHERE wave2_status IS NULL`,
    );

    const t = await tick(LAST_TICK);

    expect(t.body).toMatchObject({ [own]: 0, [other]: 0 });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
