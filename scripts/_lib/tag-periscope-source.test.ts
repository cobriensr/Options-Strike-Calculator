// @vitest-environment node

/**
 * REAL-SQL test for the one-time periscope_snapshots source backfill
 * (scripts/tag-periscope-source.mts → ./tag-periscope-source.ts).
 *
 * periscope_snapshots comes from replaying the REAL migrations #140
 * (table), #141 (timeframe) and #194 (source) on pglite. Only the DB
 * handle is replaced: getDb() returns a neon-shaped client over pglite,
 * and withDbRetry runs its callback once.
 *
 * Seeded rows mirror production (measured 2026-10-28): scraper slices
 * carry the UW label of the PRIOR 10-min CT slot (or no label), GEXBot
 * slices carry the slot their own captured_at falls in, and the cutover
 * day 2026-05-26 holds both feeds (last scraper slice 17:13:26Z, first
 * GEXBot slice 17:29:32Z). Owner decision D1 revised (2026-10-29): the
 * backfill only tags rows; no value changes, in either feed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

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

import { runTag, tagDay } from './tag-periscope-source.js';

interface Seed {
  capturedAt: string;
  panel: 'gamma' | 'charm' | 'vanna';
  strike: number;
  value: number;
  timeframe: string | null;
  source?: string;
}

/** One slice: gamma, charm and vanna rows at one captured_at. */
function slice(
  capturedAt: string,
  timeframe: string | null,
  [gamma, charm, vanna]: [number, number, number],
  strike = 7000,
): Seed[] {
  return [
    { capturedAt, panel: 'gamma', strike, value: gamma, timeframe },
    { capturedAt, panel: 'charm', strike, value: charm, timeframe },
    { capturedAt, panel: 'vanna', strike, value: vanna, timeframe },
  ];
}

const SCRAPER: Seed[] = [
  // EST day before the 2026-03-08 DST change: 15:21Z = 09:21 CST.
  ...slice('2026-03-06T15:21:00Z', '09:10 - 09:20', [10.5, -3.25, 0.75]),
  // EDT day after it: 13:31Z = 08:31 CDT.
  ...slice('2026-03-09T13:31:00Z', '08:20 - 08:30', [-4, 2, -1]),
  // The 05-08 pre-market rows with no label.
  ...slice('2026-05-08T06:40:02Z', null, [-2, 1, 3]),
  // Cutover day, last scraper slice: 12:13 CDT, labelled the prior slot.
  ...slice('2026-05-26T17:13:26.475Z', '12:00 - 12:10', [6, -6, 6]),
];

const GEXBOT: Seed[] = [
  // Cutover day, first GEXBot slice: 12:29 CDT, its own slot.
  ...slice('2026-05-26T17:29:32.914Z', '12:20 - 12:30', [-1295.76, 55.75, -9]),
  ...slice('2026-10-27T19:59:00Z', '14:50 - 15:00', [6500.28, -12, 0.45]),
  // ET day 2026-10-27 although its UTC date is 10-28 (23:30 ET, 22:30 CT).
  ...slice('2026-10-28T03:30:00Z', '22:30 - 22:40', [0, 4, -4]),
];

/**
 * Rows the new populate code already wrote (tagged), on the same ET day
 * as untagged GEXBot rows: the deploy day, when the code ships and the
 * script runs after the close.
 */
const ALREADY_TAGGED: Seed[] = slice(
  '2026-10-27T20:00:00Z',
  '15:00 - 15:10',
  [-50, 7, 8],
).map((r) => ({ ...r, source: 'gexbot' }));

const ALL = [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED];

async function seed(db: PGlite, rows: Seed[]): Promise<void> {
  for (const r of rows) {
    await db.query(
      `INSERT INTO periscope_snapshots
         (captured_at, expiry, panel, strike, value, timeframe, source)
       VALUES ($1::timestamptz,
               ($1::timestamptz AT TIME ZONE 'America/New_York')::date,
               $2, $3, $4, $5, $6)`,
      [r.capturedAt, r.panel, r.strike, r.value, r.timeframe, r.source ?? null],
    );
  }
}

interface Row {
  captured_at: string;
  panel: string;
  value: number;
  source: string | null;
}

async function snapshot(db: PGlite): Promise<Row[]> {
  const r = await db.query<Row>(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
            panel, value::float8 AS value, source
     FROM periscope_snapshots ORDER BY id`,
  );
  return r.rows;
}

function key(capturedAt: string): string {
  return new Date(capturedAt).toISOString();
}

let db: PGlite;
let logs: string[];

beforeEach(async () => {
  db = new PGlite();
  await applyMigration(db, 140);
  await applyMigration(db, 141);
  await applyMigration(db, 194);
  holder.sql = neonOverPglite(db);
  logs = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

/** Wrap the client's transaction() so a test can act around one call. */
function onTransaction(
  hook: (call: number, run: () => Promise<unknown[][]>) => Promise<unknown[][]>,
): void {
  const sql = holder.sql as ReturnType<typeof neonOverPglite>;
  const real = sql.transaction;
  let calls = 0;
  sql.transaction = (queries) => {
    calls += 1;
    return hook(calls, () => real(queries));
  };
}

describe('tag-periscope-source (pglite)', () => {
  it('one run tags scraper rows and GEXBot rows and changes no value', async () => {
    await seed(db, ALL);

    expect(await runTag({ dryRun: false })).toBe(0);

    const after = await snapshot(db);
    expect(after).toHaveLength(ALL.length);
    const scraperAt = new Set(SCRAPER.map((r) => key(r.capturedAt)));
    for (const [i, row] of after.entries()) {
      const before = ALL[i]!;
      const want = scraperAt.has(key(before.capturedAt)) ? 'scraper' : 'gexbot';
      // Every value, gamma included, is exactly what was stored.
      expect(row).toMatchObject({ value: before.value, source: want });
    }
    expect(after).toContainEqual({
      captured_at: '2026-05-26T17:29:32.914Z',
      panel: 'gamma',
      value: -1295.76,
      source: 'gexbot',
    });
    expect(after).toContainEqual({
      captured_at: '2026-05-26T17:13:26.475Z',
      panel: 'gamma',
      value: 6,
      source: 'scraper',
    });
    const out = logs.join('\n');
    expect(out).toMatch(/Done: tagged 9 GEXBot rows and 12 scraper rows/);
    expect(out).toMatch(/Verified: no row is left with source IS NULL/);
    expect(out).not.toMatch(/warning/);
  });

  it('a second run changes nothing', async () => {
    await seed(db, ALL);
    expect(await runTag({ dryRun: false })).toBe(0);
    const once = await snapshot(db);

    logs = [];
    expect(await runTag({ dryRun: false })).toBe(0);
    expect(await snapshot(db)).toEqual(once);
    expect(logs.join('\n')).toMatch(/Nothing to do/);
  });

  it('re-running a day (a retried transaction whose commit was lost) changes nothing', async () => {
    await seed(db, ALL);
    const none = { gexbotTagged: 0, scraperTagged: 0 };
    // The cutover day holds both feeds; 10-27 also holds new-code rows.
    expect(await tagDay('2026-05-26')).toEqual({
      gexbotTagged: 3,
      scraperTagged: 3,
    });
    expect(await tagDay('2026-10-27')).toEqual({
      gexbotTagged: 6,
      scraperTagged: 0,
    });
    const once = await snapshot(db);

    expect(await tagDay('2026-05-26')).toEqual(none);
    expect(await tagDay('2026-10-27')).toEqual(none);
    expect(await snapshot(db)).toEqual(once);
  });

  it('--dry-run prints the counts and writes nothing', async () => {
    await seed(db, ALL);
    const before = await snapshot(db);

    expect(await runTag({ dryRun: true })).toBe(0);

    expect(await snapshot(db)).toEqual(before);
    const out = logs.join('\n');
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(
      /5 ET days · 9 GEXBot rows to tag · 12 scraper rows to tag \(21 total\)/,
    );
    expect(out).toMatch(/2026-05-26 {2}gexbot 3 · scraper 3/);
    expect(out).toMatch(/Dry run: nothing written/);
  });

  it('refuses, writing nothing, when migration #194 is not applied', async () => {
    const bare = new PGlite();
    await applyMigration(bare, 140);
    await applyMigration(bare, 141);
    await bare.query(
      `INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value)
       VALUES ('2026-10-27T19:59:00Z', '2026-10-27', 'gamma', 7000, 5)`,
    );
    holder.sql = neonOverPglite(bare);

    expect(await runTag({ dryRun: false })).toBe(1);

    const r = await bare.query<{ value: number }>(
      'SELECT value::float8 AS value FROM periscope_snapshots',
    );
    expect(r.rows).toEqual([{ value: 5 }]);
    expect(logs.join('\n')).toMatch(/apply migration #194 first/);
    await bare.close();
  });

  it('refuses, writing nothing, when a row contradicts the cutover (timeframe fingerprint)', async () => {
    // A GEXBot-era row carrying a scraper-style label (the prior slot).
    await seed(db, [
      ...GEXBOT,
      ...slice('2026-10-27T19:41:00Z', '14:30 - 14:40', [1, 1, 1], 7100),
    ]);
    const before = await snapshot(db);

    expect(await runTag({ dryRun: false })).toBe(1);

    expect(await snapshot(db)).toEqual(before);
    expect(logs.join('\n')).toMatch(
      /3 rows disagree with the cutover[\s\S]*2026-10-27: 3/,
    );
  });

  it('a DB error mid-day rolls that whole day back and propagates; re-running finishes the job', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT]);
    const sql = holder.sql as ReturnType<typeof neonOverPglite>;
    // Days run oldest first: 03-06, 03-09, 05-08, 05-26, 10-27. On the
    // 4th (the cutover day) a failing statement runs AFTER both UPDATEs,
    // inside the same transaction.
    const real = sql.transaction;
    let calls = 0;
    sql.transaction = (queries) => {
      calls += 1;
      return real(calls === 4 ? [...queries, sql`SELECT 1 / 0`] : queries);
    };

    await expect(runTag({ dryRun: false })).rejects.toThrow(/division by zero/);
    const mid = await snapshot(db);
    // The three earlier (scraper) days committed: 9 rows tagged.
    expect(mid.filter((r) => r.source === 'scraper')).toHaveLength(9);
    expect(mid.filter((r) => r.source === 'gexbot')).toHaveLength(0);

    sql.transaction = real;
    expect(await runTag({ dryRun: false })).toBe(0);
    expect((await snapshot(db)).filter((r) => r.source == null)).toHaveLength(
      0,
    );
  });

  it('exits 1 when rows are still NULL after the run (written while it ran)', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT]);
    // After the last day commits, an untagged row lands on a day the run
    // already finished (old code still deployed, or a late insert).
    onTransaction(async (call, run) => {
      const out = await run();
      if (call === 5) {
        await seed(
          db,
          slice('2026-03-06T15:31:00Z', '09:20 - 09:30', [1, 1, 1], 7200),
        );
      }
      return out;
    });

    expect(await runTag({ dryRun: false })).toBe(1);

    expect(logs.join('\n')).toMatch(
      /3 rows still have no source[\s\S]*Re-run to finish/,
    );
    expect((await snapshot(db)).filter((r) => r.source == null)).toHaveLength(
      3,
    );
  });

  it("warns when a day's tagged counts differ from its planned counts", async () => {
    await seed(db, [...SCRAPER, ...GEXBOT]);
    // Between the scan and the cutover day's transaction, one more GEXBot
    // slice lands on that day: 3 more rows tagged than planned.
    onTransaction(async (call, run) => {
      if (call === 4) {
        await seed(
          db,
          slice('2026-05-26T17:39:32Z', '12:30 - 12:40', [1, 1, 1], 7300),
        );
      }
      return run();
    });

    expect(await runTag({ dryRun: false })).toBe(0);

    expect(logs.join('\n')).toMatch(
      /warning: 2026-05-26 tagged gexbot 6 · scraper 3, planned gexbot 3 · scraper 3/,
    );
  });
});
