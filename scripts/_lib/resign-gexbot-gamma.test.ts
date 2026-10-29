// @vitest-environment node

/**
 * REAL-SQL test for the one-time GEXBot gamma re-sign
 * (scripts/resign-gexbot-gamma.mts → ./resign-gexbot-gamma.ts).
 *
 * periscope_snapshots comes from replaying the REAL migrations #140
 * (table), #141 (timeframe) and #194 (source) on pglite. Only the DB
 * handle is replaced: getDb() returns a neon-shaped client over pglite,
 * and withDbRetry runs its callback once.
 *
 * Seeded rows mirror production (measured 2026-10-28): scraper slices
 * carry the UW label of the PRIOR 10-min CT slot (or no label), GEXBot
 * slices carry the slot their own captured_at falls in, and the cutover
 * day 2026-05-26 holds both eras (last scraper slice 17:13:26Z, first
 * GEXBot slice 17:29:32Z).
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

import { GEXBOT_CUTOVER, resignDay, runResign } from './resign-gexbot-gamma.js';

interface Seed {
  capturedAt: string;
  panel: 'gamma' | 'charm' | 'vanna';
  strike: number;
  value: number;
  timeframe: string | null;
  source?: string;
}

/** One slice per tuple: [captured_at, timeframe, gamma, charm, vanna]. */
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
 * Rows the new populate code already wrote (negated and tagged), on the
 * same ET day as untagged GEXBot rows: the deploy day, when the code
 * ships mid-session and the script runs after the close.
 */
const ALREADY_TAGGED: Seed[] = slice(
  '2026-10-27T20:00:00Z',
  '15:00 - 15:10',
  [-50, 7, 8],
).map((r) => ({ ...r, source: 'gexbot' }));

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
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe('resign-gexbot-gamma (pglite)', () => {
  it('the cutover sits between the last scraper and the first GEXBot row', () => {
    const t = Date.parse(GEXBOT_CUTOVER);
    expect(t).toBeGreaterThan(Date.parse('2026-05-26T17:13:26.475Z'));
    expect(t).toBeLessThan(Date.parse('2026-05-26T17:29:32.914Z'));
  });

  it('one run negates and tags GEXBot gamma, tags other GEXBot rows unchanged, tags scraper rows unchanged', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED]);

    expect(await runResign({ dryRun: false })).toBe(0);

    const after = await snapshot(db);
    const scraperAt = new Set(SCRAPER.map((r) => key(r.capturedAt)));
    const gexbotAt = new Set(GEXBOT.map((r) => key(r.capturedAt)));
    const seeded = [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED];
    expect(after).toHaveLength(seeded.length);

    for (const [i, row] of after.entries()) {
      const before = seeded[i]!;
      const at = key(before.capturedAt);
      if (scraperAt.has(at)) {
        expect(row).toMatchObject({ value: before.value, source: 'scraper' });
      } else if (gexbotAt.has(at)) {
        const want =
          before.panel === 'gamma' && before.value !== 0
            ? -before.value
            : before.value;
        expect(row).toMatchObject({ value: want, source: 'gexbot' });
      } else {
        // Written by the new populate code: already MM-signed, left alone.
        expect(row).toMatchObject({ value: before.value, source: 'gexbot' });
      }
    }
    // Spot checks on the cutover day.
    expect(after).toContainEqual({
      captured_at: '2026-05-26T17:29:32.914Z',
      panel: 'gamma',
      value: 1295.76,
      source: 'gexbot',
    });
    expect(after).toContainEqual({
      captured_at: '2026-05-26T17:13:26.475Z',
      panel: 'gamma',
      value: 6,
      source: 'scraper',
    });
    expect(logs.join('\n')).toMatch(
      /Done: negated 3 gamma rows, tagged 6 GEXBot rows and 12 scraper rows/,
    );
  });

  it('a second run changes nothing', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED]);
    expect(await runResign({ dryRun: false })).toBe(0);
    const once = await snapshot(db);

    logs = [];
    expect(await runResign({ dryRun: false })).toBe(0);
    expect(await snapshot(db)).toEqual(once);
    expect(logs.join('\n')).toMatch(/Nothing to do/);
  });

  it('re-running a day (a retried transaction whose commit was lost) changes nothing', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED]);
    const none = { gammaNegated: 0, gexbotTagged: 0, scraperTagged: 0 };
    // The cutover day holds both eras; 10-27 also holds new-code rows.
    expect(await resignDay('2026-05-26')).toEqual({
      gammaNegated: 1,
      gexbotTagged: 2,
      scraperTagged: 3,
    });
    expect(await resignDay('2026-10-27')).toEqual({
      gammaNegated: 2,
      gexbotTagged: 4,
      scraperTagged: 0,
    });
    const once = await snapshot(db);

    expect(await resignDay('2026-05-26')).toEqual(none);
    expect(await resignDay('2026-10-27')).toEqual(none);
    expect(await snapshot(db)).toEqual(once);
  });

  it('--dry-run prints the counts and writes nothing', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT, ...ALREADY_TAGGED]);
    const before = await snapshot(db);

    expect(await runResign({ dryRun: true })).toBe(0);

    expect(await snapshot(db)).toEqual(before);
    const out = logs.join('\n');
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(
      /5 ET days · 3 gamma rows to negate · 6 GEXBot rows to tag · 12 scraper rows to tag/,
    );
    expect(out).toMatch(/2026-05-26 {2}negate 1 · gexbot 2 · scraper 3/);
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

    expect(await runResign({ dryRun: false })).toBe(1);

    const r = await bare.query<{ value: number }>(
      'SELECT value::float8 AS value FROM periscope_snapshots',
    );
    expect(r.rows).toEqual([{ value: 5 }]);
    expect(logs.join('\n')).toMatch(/migration #194/);
    await bare.close();
  });

  it('refuses, writing nothing, when a row contradicts the cutover (timeframe fingerprint)', async () => {
    // A GEXBot-era row carrying a scraper-style label (the prior slot).
    await seed(db, [
      ...GEXBOT,
      ...slice('2026-10-27T19:41:00Z', '14:30 - 14:40', [1, 1, 1], 7100),
    ]);
    const before = await snapshot(db);

    expect(await runResign({ dryRun: false })).toBe(1);

    expect(await snapshot(db)).toEqual(before);
    expect(logs.join('\n')).toMatch(
      /3 rows disagree with the cutover[\s\S]*2026-10-27: 3/,
    );
  });

  it('a DB error mid-day rolls that whole day back (gamma flip included) and propagates; re-running finishes the job', async () => {
    await seed(db, [...SCRAPER, ...GEXBOT]);
    const sql = holder.sql as ReturnType<typeof neonOverPglite>;
    const realTransaction = sql.transaction;
    let calls = 0;
    // Days run oldest first: 03-06, 03-09, 05-08, 05-26, 10-27. On the
    // 4th (the cutover day) a failing statement runs AFTER the three
    // UPDATEs, inside the same transaction.
    sql.transaction = (queries) => {
      calls += 1;
      return realTransaction(
        calls === 4 ? [...queries, sql`SELECT 1 / 0`] : queries,
      );
    };

    await expect(runResign({ dryRun: false })).rejects.toThrow(
      /division by zero/,
    );
    const mid = await snapshot(db);
    // The three earlier (scraper) days committed: 9 rows tagged.
    expect(mid.filter((r) => r.source === 'scraper')).toHaveLength(9);
    expect(mid.filter((r) => r.source === 'gexbot')).toHaveLength(0);
    // The cutover day rolled back whole: its gamma is still taker-signed.
    expect(mid).toContainEqual({
      captured_at: '2026-05-26T17:29:32.914Z',
      panel: 'gamma',
      value: -1295.76,
      source: null,
    });

    sql.transaction = realTransaction;
    expect(await runResign({ dryRun: false })).toBe(0);
    const done = await snapshot(db);
    expect(done.filter((r) => r.source == null)).toHaveLength(0);
    expect(done).toContainEqual({
      captured_at: '2026-05-26T17:29:32.914Z',
      panel: 'gamma',
      value: 1295.76,
      source: 'gexbot',
    });
    expect(
      done.find(
        (r) =>
          r.captured_at === '2026-10-27T19:59:00.000Z' && r.panel === 'gamma',
      )?.value,
    ).toBe(-6500.28);
  });
});
