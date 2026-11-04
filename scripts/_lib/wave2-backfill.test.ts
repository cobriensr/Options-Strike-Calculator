// @vitest-environment node

/**
 * REAL-SQL parity test for the one-shot wave2_status backfill
 * (scripts/backfill-wave2-status.ts -> ./wave2-backfill.ts).
 *
 * The contract is "the backfill writes exactly what the cron would". So the
 * test runs the cron's REAL handler (api/cron/wave2-confirmation.ts) tick by
 * tick on one pglite database, runs the backfill on a second database seeded
 * with the same rows, and compares every row's status and wave2_detected_at.
 * pglite's now() follows the faked Date, which is what lets the cron see the
 * old fixtures inside its 70-minute lookback.
 *
 * Tables come from the REAL migrations (#110 lottery_finder_fires, #134
 * silent_boom_alerts, #164 the wave2 columns and indexes). The session time
 * zone is Asia/Tokyo, neither UTC nor New York, so an ET-day bound that
 * leans on the session zone would shift. Only the DB handle, the logger and
 * Sentry are replaced.
 *
 * Fixtures sit on two late-day clusters (15:30 ET, the population the
 * 2026-11-03 cron fix is about): Fri 2026-10-30 in EDT and Mon 2026-11-02 in
 * EST. Every scenario's expected label is written out below by hand, so a
 * mistake shared by the cron and the backfill (they share wave2Verdict)
 * still fails here.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { mockRequest, mockResponse } from '../../api/__tests__/helpers.js';
import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations.js';

const holder = vi.hoisted(() => ({
  sql: null as unknown,
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: () => holder.sql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../../api/_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../api/_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
  metrics: { request: vi.fn(() => vi.fn()) },
}));

import handler from '../../api/cron/wave2-confirmation.js';
import { parseArgs, runBackfill } from './wave2-backfill.js';

// ── Fixtures ─────────────────────────────────────────────────────────

type TableName = 'lottery_finder_fires' | 'silent_boom_alerts';
const TABLES: TableName[] = ['lottery_finder_fires', 'silent_boom_alerts'];

type Status = 'confirmed' | 'lagging' | 'fizzled';

interface Cluster {
  key: string;
  /** Wave-1 time of every scenario in the cluster. */
  base: string;
  /** The ET trading day the cluster falls on. */
  day: string;
}

const CLUSTERS: Cluster[] = [
  { key: 'edt', base: '2026-10-30T19:30:00.000Z', day: '2026-10-30' },
  { key: 'est', base: '2026-11-02T20:30:00.000Z', day: '2026-11-02' },
];

/** The backfill runs when every cluster row is more than 2 hours old. */
const BACKFILL_NOW = '2026-11-03T00:30:00.000Z';

interface GridRow {
  /** Unique within a cluster; becomes the option_chain_id. */
  name: string;
  sym: string;
  side: 'C' | 'P';
  /** Seconds after the cluster base. */
  at: number;
  /** Extra microseconds below the millisecond (0 to 999). */
  micros?: number;
  want: Status;
  /** Seconds after the base of the follow-up the label must record. */
  detectedAt?: number;
}

interface Scenario {
  title: string;
  rows: GridRow[];
}

const m = (min: number, sec = 0): number => min * 60 + sec;

/**
 * A wave-1 row at the base and one same-symbol, same-side row `followAt`
 * seconds later. The follow-up row has no follow-up of its own, so it is
 * the fizzle case.
 */
function pair(
  title: string,
  sym: string,
  followAt: number,
  want: Status,
): Scenario {
  const w1: GridRow =
    want === 'fizzled'
      ? { name: `${sym}-w1`, sym, side: 'C', at: 0, want }
      : {
          name: `${sym}-w1`,
          sym,
          side: 'C',
          at: 0,
          want,
          detectedAt: followAt,
        };
  return {
    title,
    rows: [
      w1,
      { name: `${sym}-f`, sym, side: 'C', at: followAt, want: 'fizzled' },
    ],
  };
}

const SCENARIOS: Scenario[] = [
  pair('follow-up at 29:59 is confirmed', 'F2959', m(29, 59), 'confirmed'),
  pair('follow-up at exactly 30:00 is confirmed', 'F3000', m(30), 'confirmed'),
  pair('follow-up at 30:01 is lagging', 'F3001', m(30, 1), 'lagging'),
  pair('follow-up at 59:59 is lagging', 'F5959', m(59, 59), 'lagging'),
  pair(
    'follow-up at exactly 60:00 is lagging (the bound is inclusive)',
    'F6000',
    m(60),
    'lagging',
  ),
  pair(
    'follow-up at 60:01 is outside the window: fizzled',
    'F6001',
    m(60, 1),
    'fizzled',
  ),
  {
    title: 'a fire with no follow-up fizzles',
    rows: [{ name: 'NONE-w1', sym: 'NONE', side: 'C', at: 0, want: 'fizzled' }],
  },
  {
    title: 'a same-minute twin is a follow-up for the earlier row only',
    rows: [
      {
        name: 'TWIN-a',
        sym: 'TWIN',
        side: 'C',
        at: 0,
        want: 'confirmed',
        detectedAt: 20,
      },
      { name: 'TWIN-b', sym: 'TWIN', side: 'C', at: 20, want: 'fizzled' },
    ],
  },
  {
    title: 'two rows at the same instant are not follow-ups of each other',
    rows: [
      { name: 'TIE-x', sym: 'TIE', side: 'C', at: 0, want: 'fizzled' },
      { name: 'TIE-y', sym: 'TIE', side: 'C', at: 0, want: 'fizzled' },
    ],
  },
  {
    title: 'the other side (put vs call) does not count',
    rows: [
      { name: 'SIDE-c', sym: 'SIDE', side: 'C', at: 0, want: 'fizzled' },
      { name: 'SIDE-p', sym: 'SIDE', side: 'P', at: m(10), want: 'fizzled' },
    ],
  },
  {
    title: 'another symbol does not count',
    rows: [
      { name: 'SYMA-a', sym: 'SYMA', side: 'C', at: 0, want: 'fizzled' },
      { name: 'SYMB-b', sym: 'SYMB', side: 'C', at: m(10), want: 'fizzled' },
    ],
  },
  {
    title: 'the earliest follow-up is the one recorded, down a chain',
    rows: [
      // w1 sees e2 (+10) first; e2 sees e1 (+35 from it); e1 sees e3
      // (+25 from it). e3 has nothing after it.
      {
        name: 'EARLY-w1',
        sym: 'EARLY',
        side: 'C',
        at: 0,
        want: 'confirmed',
        detectedAt: m(10),
      },
      {
        name: 'EARLY-e1',
        sym: 'EARLY',
        side: 'C',
        at: m(45),
        want: 'confirmed',
        detectedAt: m(70),
      },
      {
        name: 'EARLY-e2',
        sym: 'EARLY',
        side: 'C',
        at: m(10),
        want: 'lagging',
        detectedAt: m(45),
      },
      { name: 'EARLY-e3', sym: 'EARLY', side: 'C', at: m(70), want: 'fizzled' },
    ],
  },
  {
    title: 'a sub-millisecond trigger does not count as its own follow-up',
    rows: [
      {
        name: 'SUBSELF-s',
        sym: 'SUBSELF',
        side: 'C',
        at: 0,
        micros: 500,
        want: 'fizzled',
      },
    ],
  },
  {
    // The cron builds its lookup bound from a JS Date, so it truncates the
    // trigger to the millisecond: two rows in one millisecond see each
    // other. The backfill restates that truncation; this pins it.
    title: 'two rows in the same millisecond are follow-ups of each other',
    rows: [
      {
        name: 'SUBPAIR-a',
        sym: 'SUBPAIR',
        side: 'C',
        at: 0,
        micros: 500,
        want: 'confirmed',
        detectedAt: 0,
      },
      {
        name: 'SUBPAIR-b',
        sym: 'SUBPAIR',
        side: 'C',
        at: 0,
        micros: 300,
        want: 'confirmed',
        detectedAt: 0,
      },
    ],
  },
];

function stamp(baseIso: string, atSec: number, micros = 0): string {
  const iso = new Date(Date.parse(baseIso) + atSec * 1000).toISOString();
  return micros === 0
    ? iso
    : iso.replace('Z', `${String(micros).padStart(3, '0')}Z`);
}

function label(cluster: Cluster, name: string): string {
  return `${cluster.key}:${name}`;
}

interface SeedRow {
  label: string;
  sym: string;
  side: 'C' | 'P';
  at: string;
  status?: Status;
  detectedAt?: string;
}

async function insertRow(
  pg: PGlite,
  table: TableName,
  r: SeedRow,
): Promise<void> {
  const params = [
    r.at,
    r.label,
    r.sym,
    r.side,
    r.status ?? null,
    r.detectedAt ?? null,
  ];
  if (table === 'lottery_finder_fires') {
    await pg.query(
      `INSERT INTO lottery_finder_fires (
         date, trigger_time_ct, entry_time_ct, option_chain_id,
         underlying_symbol, option_type, strike, expiry, dte,
         trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
         trigger_delta, trigger_ask_pct, trigger_window_size,
         trigger_window_prints, entry_price, open_interest, spot_at_first,
         alert_seq, flow_quad, tod, mode, reload_tagged,
         cheap_call_pm_tagged, wave2_status, wave2_detected_at)
       VALUES (
         ($1::timestamptz AT TIME ZONE 'America/New_York')::date,
         $1::timestamptz, $1::timestamptz, $2, $3, $4, 100, '2026-12-31', 0,
         1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 1, 'call_ask', 'PM',
         'A_intraday_0DTE', false, false, $5, $6::timestamptz)`,
      params,
    );
  } else {
    await pg.query(
      `INSERT INTO silent_boom_alerts (
         date, bucket_ct, option_chain_id, underlying_symbol, option_type,
         strike, expiry, dte, spike_volume, baseline_volume, spike_ratio,
         ask_pct, vol_oi, entry_price, open_interest,
         wave2_status, wave2_detected_at)
       VALUES (
         ($1::timestamptz AT TIME ZONE 'America/New_York')::date,
         $1::timestamptz, $2, $3, $4, 100, '2026-12-31', 0,
         1, 1, 1, 1, 1, 1, 1, $5, $6::timestamptz)`,
      params,
    );
  }
}

function gridRows(cluster: Cluster): SeedRow[] {
  return SCENARIOS.flatMap((s) =>
    s.rows.map((r) => ({
      label: label(cluster, r.name),
      sym: r.sym,
      side: r.side,
      at: stamp(cluster.base, r.at, r.micros),
    })),
  );
}

/** Rows only the backfill database holds: the scope edges. */
const EXTRA = {
  // The table's first labelled row: it defines the boundary at run time.
  firstLabelled: {
    label: 'first-labelled',
    sym: 'LBL0',
    side: 'C',
    at: '2026-10-30T16:30:00.000Z',
    status: 'confirmed',
    detectedAt: '2026-10-30T16:40:00.000Z',
  },
  // Labelled inside the scope, with a value the rule would not give (no
  // follow-up means fizzled): it must come back exactly as it went in.
  labelledInside: {
    label: 'labelled-inside',
    sym: 'LBL1',
    side: 'C',
    at: '2026-11-02T20:35:00.000Z',
    status: 'lagging',
    detectedAt: '2026-11-02T21:20:00.000Z',
  },
  // Before the first labelled row: predates the feature, stays NULL.
  preBoundary: {
    label: 'pre-boundary',
    sym: 'PRE',
    side: 'C',
    at: '2026-10-30T14:30:00.000Z',
  },
  // 121 and 119 minutes before BACKFILL_NOW: just over and just under 2 h.
  justOldEnough: {
    label: 'just-old-enough',
    sym: 'OLD',
    side: 'C',
    at: '2026-11-02T22:29:00.000Z',
  },
  tooRecent: {
    label: 'too-recent',
    sym: 'REC',
    side: 'C',
    at: '2026-11-02T22:31:00.000Z',
  },
} satisfies Record<string, SeedRow>;

const EXTRAS: SeedRow[] = Object.values(EXTRA);

async function resetTables(pg: PGlite): Promise<void> {
  await pg.query(
    'TRUNCATE lottery_finder_fires, silent_boom_alerts RESTART IDENTITY',
  );
}

async function seedGrid(pg: PGlite): Promise<void> {
  for (const table of TABLES) {
    for (const cluster of CLUSTERS) {
      for (const row of gridRows(cluster)) await insertRow(pg, table, row);
    }
  }
}

async function seedExtras(pg: PGlite): Promise<void> {
  for (const table of TABLES) {
    for (const row of EXTRAS) await insertRow(pg, table, row);
  }
}

async function createDb(): Promise<PGlite> {
  const pg = await PGlite.create();
  await pg.query(`SET TimeZone = 'Asia/Tokyo'`);
  await applyMigration(pg, 110); // lottery_finder_fires
  await applyMigration(pg, 134); // silent_boom_alerts
  await applyMigration(pg, 164); // wave2_status, wave2_detected_at, indexes
  return pg;
}

/** label -> "status @ detected" for every row of a table. */
async function snapshot(
  pg: PGlite,
  table: TableName,
): Promise<Map<string, string>> {
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

function want(cluster: Cluster, row: GridRow): string {
  const at =
    row.detectedAt === undefined ? '-' : stamp(cluster.base, row.detectedAt);
  return `${row.want} @ ${at}`;
}

// ── Harness ──────────────────────────────────────────────────────────

let cronPg: PGlite;
let backfillPg: PGlite;
let logSpy: MockInstance<typeof console.log>;
let warnSpy: MockInstance<typeof console.warn>;

/** Everything the backfill printed since the last call. */
function printed(): string {
  const lines = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) =>
    c.join(' '),
  );
  logSpy.mockClear();
  warnSpy.mockClear();
  return lines.join('\n');
}

/**
 * Run the cron's real handler every 5 minutes, from one minute after each
 * cluster's first fire until every row has passed its 60-minute fizzle age
 * and left the 70-minute lookback. `?force=1` skips only the market-hours
 * window, so the same ticks serve both ET regimes.
 */
async function runCronTicks(): Promise<void> {
  holder.sql = neonOverPglite(cronPg);
  for (const cluster of CLUSTERS) {
    const baseMs = Date.parse(cluster.base);
    for (let minute = 1; minute <= 135; minute += 5) {
      vi.setSystemTime(new Date(baseMs + minute * 60_000));
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          headers: { authorization: 'Bearer test-secret' },
          query: { force: '1' },
        }),
        res,
      );
      expect(res._status).toBe(200);
      expect((res._json as { status: string }).status).toBe('success');
    }
  }
}

/** The text of every statement the last `backfill()` sent. */
const sent: string[] = [];

async function backfill(args: string[] = []): Promise<number> {
  vi.setSystemTime(new Date(BACKFILL_NOW));
  const client = neonOverPglite(backfillPg);
  const realQuery = client.query;
  sent.length = 0;
  client.query = (text: string, params: unknown[] = []) => {
    sent.push(text);
    return realQuery(text, params);
  };
  holder.sql = client;
  return runBackfill(parseArgs(args));
}

beforeAll(async () => {
  process.env.CRON_SECRET = 'test-secret';
  cronPg = await createDb();
  backfillPg = await createDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seedGrid(cronPg);
  await runCronTicks();
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  await cronPg.close();
  await backfillPg.close();
});

// ── Parity with the cron ─────────────────────────────────────────────

describe('wave2 backfill: parity with the cron (real Postgres)', () => {
  const results = new Map<TableName, Map<string, string>>();
  const cronResults = new Map<TableName, Map<string, string>>();
  let exitCode: number;

  beforeAll(async () => {
    await resetTables(backfillPg);
    await seedExtras(backfillPg);
    await seedGrid(backfillPg);
    exitCode = await backfill();
    for (const table of TABLES) {
      results.set(table, await snapshot(backfillPg, table));
      cronResults.set(table, await snapshot(cronPg, table));
    }
    printed();
  }, 120_000);

  it('exits 0 and leaves no in-scope row NULL', async () => {
    expect(exitCode).toBe(0);
    for (const table of TABLES) {
      const { rows } = await backfillPg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}
          WHERE wave2_status IS NULL AND option_chain_id ~ '^(edt|est):'`,
      );
      expect(rows[0]?.n).toBe(0);
    }
  });

  describe.each(TABLES)('%s', (table) => {
    it.each(SCENARIOS)('the cron: $title', (scenario) => {
      // Harness sanity: the hand-written expectation is what the real cron
      // produces, so a wrong expectation cannot hide a wrong rule.
      for (const cluster of CLUSTERS) {
        for (const row of scenario.rows) {
          expect(cronResults.get(table)?.get(label(cluster, row.name))).toBe(
            want(cluster, row),
          );
        }
      }
    });

    it.each(SCENARIOS)('the backfill matches the cron: $title', (scenario) => {
      for (const cluster of CLUSTERS) {
        for (const row of scenario.rows) {
          const key = label(cluster, row.name);
          const fromBackfill = results.get(table)?.get(key);
          expect(fromBackfill).toBe(cronResults.get(table)?.get(key));
          expect(fromBackfill).toBe(want(cluster, row));
        }
      }
    });

    it('labels every grid row the way the cron did, nothing more or less', () => {
      const gridOnly = (all: Map<string, string> | undefined) =>
        [...(all ?? [])].filter(([k]) => /^(edt|est):/.test(k));
      expect(gridOnly(results.get(table))).toEqual(
        gridOnly(cronResults.get(table)),
      );
      expect(gridOnly(results.get(table)).length).toBe(
        CLUSTERS.length * SCENARIOS.flatMap((s) => s.rows).length,
      );
    });

    it('leaves an already-labelled row exactly as it was', () => {
      expect(results.get(table)?.get('first-labelled')).toBe(
        'confirmed @ 2026-10-30T16:40:00.000Z',
      );
      expect(results.get(table)?.get('labelled-inside')).toBe(
        'lagging @ 2026-11-02T21:20:00.000Z',
      );
    });

    it('leaves a row before the first labelled row NULL', () => {
      expect(results.get(table)?.get('pre-boundary')).toBe('NULL @ -');
    });

    it('leaves a row under 2 hours old NULL and labels one just over', () => {
      expect(results.get(table)?.get('too-recent')).toBe('NULL @ -');
      expect(results.get(table)?.get('just-old-enough')).toBe('fizzled @ -');
    });
  });

  it('a rerun changes nothing and reports nothing written', async () => {
    const before = new Map<TableName, Map<string, string>>();
    for (const table of TABLES)
      before.set(table, await snapshot(backfillPg, table));
    const code = await backfill();
    expect(code).toBe(0);
    for (const table of TABLES) {
      expect(await snapshot(backfillPg, table)).toEqual(before.get(table));
    }
    const out = printed();
    expect(out).toContain('lottery_finder_fires: wrote 0 rows');
    expect(out).toContain('silent_boom_alerts: wrote 0 rows');
  });
});

// ── Modes ────────────────────────────────────────────────────────────

describe('wave2 backfill: modes', () => {
  async function seedBackfill(): Promise<void> {
    await resetTables(backfillPg);
    await seedExtras(backfillPg);
    await seedGrid(backfillPg);
  }

  async function snapshots(): Promise<Map<TableName, Map<string, string>>> {
    const all = new Map<TableName, Map<string, string>>();
    for (const table of TABLES)
      all.set(table, await snapshot(backfillPg, table));
    return all;
  }

  /** Verdict counts the grid and the just-old-enough extra should produce. */
  function expectedTotals(day?: string): Record<Status, number> {
    const totals: Record<Status, number> = {
      confirmed: 0,
      lagging: 0,
      fizzled: 0,
    };
    for (const cluster of CLUSTERS) {
      if (day !== undefined && cluster.day !== day) continue;
      for (const s of SCENARIOS) for (const r of s.rows) totals[r.want] += 1;
    }
    // 'just-old-enough' fizzles on the EST day (2026-11-02).
    if (day === undefined || day === '2026-11-02') totals.fizzled += 1;
    return totals;
  }

  const countsLine = (t: Record<Status, number>) =>
    `confirmed ${t.confirmed} · lagging ${t.lagging} · fizzled ${t.fizzled}`;

  beforeEach(async () => {
    await seedBackfill();
    printed();
  });

  afterEach(() => {
    holder.sql = null;
  });

  it('--dry-run writes nothing and reports the counts per table, verdict and day', async () => {
    const before = await snapshots();
    const code = await backfill(['--dry-run']);
    expect(code).toBe(0);
    expect(await snapshots()).toEqual(before);
    // Read-only by construction: it sends SELECTs and nothing else.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((t) => !t.trimStart().startsWith('SELECT'))).toEqual([]);

    const out = printed();
    expect(out).toContain('DRY RUN (no writes)');
    const total = expectedTotals();
    const rows = total.confirmed + total.lagging + total.fizzled;
    for (const table of TABLES) {
      expect(out).toContain(
        `${table}: would write ${rows} rows: ${countsLine(total)}.`,
      );
    }
    for (const cluster of CLUSTERS) {
      const day = expectedTotals(cluster.day);
      const dayRows = day.confirmed + day.lagging + day.fizzled;
      expect(out).toContain(
        `${cluster.day}  would write ${dayRows} of ${dayRows}: ${countsLine(day)}`,
      );
    }
    expect(out).not.toContain('Done.');
  });

  it('--dry-run counts are what the full run then writes', async () => {
    await backfill(['--dry-run']);
    const dry = printed();
    await backfill();
    const wet = printed();
    const totalLine = (out: string, verb: string) =>
      out
        .split('\n')
        .filter((l) => l.startsWith('lottery_finder_fires: ' + verb))
        .at(0)
        ?.replace(verb, 'X');
    expect(totalLine(wet, 'wrote')).toBe(totalLine(dry, 'would write'));
  });

  it('--limit N writes at most N rows per table, and a later run continues', async () => {
    const code = await backfill(['--limit', '3']);
    expect(code).toBe(0);
    for (const table of TABLES) {
      const { rows } = await backfillPg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE wave2_status IS NOT NULL`,
      );
      // The two labelled extras plus exactly three written rows.
      expect(rows[0]?.n).toBe(2 + 3);
    }
    expect(printed()).toContain('wrote 3 rows');

    // Resume: the finished rows no longer match, the rest is labelled, and
    // the end state equals a straight full run's.
    expect(await backfill()).toBe(0);
    const resumed = await snapshots();
    await seedBackfill();
    await backfill();
    expect(resumed).toEqual(await snapshots());
  });

  it('writes at most 500 rows per statement and pages a day with more rows', async () => {
    await resetTables(backfillPg);
    await insertRow(backfillPg, 'lottery_finder_fires', EXTRA.firstLabelled);
    await insertRow(backfillPg, 'silent_boom_alerts', EXTRA.firstLabelled);
    // 1,300 lonely fires on one ET day, one per second, no follow-ups.
    await backfillPg.query(`
      INSERT INTO lottery_finder_fires (
        date, trigger_time_ct, entry_time_ct, option_chain_id,
        underlying_symbol, option_type, strike, expiry, dte,
        trigger_vol_to_oi_window, trigger_vol_to_oi_cum, trigger_iv,
        trigger_delta, trigger_ask_pct, trigger_window_size,
        trigger_window_prints, entry_price, open_interest, spot_at_first,
        alert_seq, flow_quad, tod, mode, reload_tagged, cheap_call_pm_tagged)
      SELECT '2026-10-30'::date, ts, ts, 'bulk-' || g, 'S' || g, 'C', 100,
             '2026-12-31'::date, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100, 1,
             'call_ask', 'PM', 'A_intraday_0DTE', false, false
        FROM (SELECT g, '2026-10-30T18:00:00Z'::timestamptz
                         + g * INTERVAL '1 second' AS ts
                FROM generate_series(1, 1300) g) s`);

    const client = neonOverPglite(backfillPg);
    const batches: number[] = [];
    const realQuery = client.query;
    client.query = (text: string, params: unknown[] = []) => {
      if (text.trimStart().startsWith('UPDATE')) {
        const ids = params.find((p) => Array.isArray(p)) as unknown[];
        batches.push(ids.length);
      }
      return realQuery(text, params);
    };
    vi.setSystemTime(new Date(BACKFILL_NOW));
    holder.sql = client;
    expect(await runBackfill(parseArgs([]))).toBe(0);

    expect(batches).toEqual([500, 500, 300]);
    const { rows } = await backfillPg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lottery_finder_fires
        WHERE wave2_status = 'fizzled' AND wave2_detected_at IS NULL`,
    );
    expect(rows[0]?.n).toBe(1300);
  });

  it('skips a table with no labelled row: there is nothing to anchor the scope', async () => {
    await resetTables(backfillPg);
    await insertRow(backfillPg, 'lottery_finder_fires', EXTRA.justOldEnough);
    expect(await backfill()).toBe(0);
    expect(printed()).toContain('No labelled row yet');
    const { rows } = await backfillPg.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM lottery_finder_fires WHERE wave2_status IS NOT NULL',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('surfaces a rejected UPDATE and does not report the run as done', async () => {
    const client = neonOverPglite(backfillPg);
    const realQuery = client.query;
    client.query = (text: string, params: unknown[] = []) =>
      text.trimStart().startsWith('UPDATE')
        ? Promise.reject(new Error('connection lost'))
        : realQuery(text, params);
    vi.setSystemTime(new Date(BACKFILL_NOW));
    holder.sql = client;

    await expect(runBackfill(parseArgs([]))).rejects.toThrow('connection lost');
    expect(printed()).not.toContain('Done.');
    const { rows } = await backfillPg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lottery_finder_fires
        WHERE wave2_status IS NOT NULL`,
    );
    expect(rows[0]?.n).toBe(2); // only the two labelled extras
  });

  it('surfaces a rejected read', async () => {
    const client = neonOverPglite(backfillPg);
    client.query = () => Promise.reject(new Error('read timed out'));
    holder.sql = client;
    await expect(runBackfill(parseArgs([]))).rejects.toThrow('read timed out');
  });
});

// ── Flags ────────────────────────────────────────────────────────────

describe('wave2 backfill: parseArgs', () => {
  it('defaults to a full write run', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null });
  });

  it('reads --dry-run and --limit N together', () => {
    expect(parseArgs(['--dry-run', '--limit', '50'])).toEqual({
      dryRun: true,
      limit: 50,
    });
  });

  it.each([
    [['--limit']],
    [['--limit', 'abc']],
    [['--limit', '0']],
    [['--limit', '-5']],
    [['--limit', '1.5']],
    [['--apply']],
    [['--dry-run', 'extra']],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/--limit needs|Unknown argument/);
  });
});
