// @vitest-environment node

/**
 * REAL-SQL equivalence test for the front-month history seed
 * (scripts/_lib/futures-front-month-backfill.ts): the seed walks the rule
 * `ensureFrontMonth` applies in memory, and the rows it writes must be the
 * ones `ensureFrontMonth` would have decided one date at a time, oldest
 * first, over the same volumes and stored rows. The unit tests check the walk
 * against hand-built cases; this one checks it against the real function
 * and the real SQL, on pglite (Postgres in WASM) with the tables built from
 * migration #205.
 *
 * For each of 30 histories from a seeded PRNG (two to four contracts that
 * roll with noise, dropped contract-days, weekends, a running session or a
 * weekend as the current date, and in about two in five a few decision rows
 * already stored, on sessions and on dates with no session):
 *   1. the whole seed runs (`runFrontMonthSeed`) through the REAL
 *      `insertContractVolumes`, `insertFrontMonthRows` and
 *      `fetchStoredFrontMonths`;
 *   2. the rows it wrote are deleted, and `ensureFrontMonth` decides every
 *      one of those dates again, oldest first, from the volumes and the
 *      stored rows left behind: each answer must be the seed's;
 *   3. for dates the seed does not write (weekends between its rows),
 *      `ensureFrontMonth` must agree with the chain: never earlier than the
 *      decision before it, never later than the one after it, and the whole
 *      series still never steps back.
 *
 * Mocked: `fetchDailyContractVolumes` (no UW), the clock, and `getDb`, which
 * is the pglite handle. `withDbRetry` and every store function are real.
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
} from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const { holder, mockFetchVolumes, mockWarn } = vi.hoisted(() => ({
  holder: { sql: null as unknown },
  mockFetchVolumes: vi.fn(),
  mockWarn: vi.fn(),
}));

// Real withDbRetry; getDb() is the Neon-shaped client over pglite (the
// tagged template, query and transaction).
vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => holder.sql,
}));
vi.mock('../../api/_lib/logger.js', () => ({
  default: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../api/_lib/futures-daily-candles.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/futures-daily-candles.js')
  >('../../api/_lib/futures-daily-candles.js');
  return { ...actual, fetchDailyContractVolumes: mockFetchVolumes };
});

import {
  applyMigration,
  neonOverPglite,
} from '../../api/__tests__/pglite-migrations.js';
import {
  compareExpiry,
  parseContract,
  type FuturesRoot,
} from '../../api/_lib/futures-contracts.js';
import type { DailyContractVolume } from '../../api/_lib/futures-daily-candles.js';
import { ensureFrontMonth } from '../../api/_lib/futures-front-month.js';
import {
  SEED_START,
  findOutOfOrder,
  runFrontMonthSeed,
} from './futures-front-month-backfill.js';

// ── Histories ─────────────────────────────────────────────

const HISTORIES = 30;
const FIRST_DECISION = '2026-07-22';

/** mulberry32: a small seeded PRNG, so a failure names a reproducible seed. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** The first `count` weekdays from `start`. */
function weekdaysFrom(start: string, count: number): string[] {
  const days: string[] = [];
  let d = start;
  while (days.length < count) {
    if (!isWeekend(d)) days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

interface History {
  root: FuturesRoot;
  /** The current trade date, set as the clock. */
  today: string;
  contracts: string[];
  /** Every candle UW would serve, the running session's partial row too. */
  candles: DailyContractVolume[];
  /** Decision rows already stored, oldest first, never going back. */
  stored: Array<{ tradeDate: string; contract: string }>;
}

/**
 * CL lists a contract every month, so a history can hold up to four of them
 * (CLU6 and CLV6 are always there: the empty-result rule requires them in
 * August). ES holds the two it lists in July and August.
 */
function buildHistory(index: number): History {
  const rand = prng(1000 + index * 7919);
  const root: FuturesRoot = index % 3 === 1 ? 'ES' : 'CL';
  const contracts =
    root === 'ES'
      ? ['ESU6', 'ESZ6']
      : ['CLU6', 'CLV6', 'CLX6', 'CLZ6'].slice(0, 2 + Math.floor(rand() * 3));
  const sessions = weekdaysFrom(SEED_START, 8 + Math.floor(rand() * 21));
  const last = sessions.at(-1) ?? SEED_START;
  // The running session, or the day after the last one with candles (a
  // weekend, or a weekday whose first candle UW has not posted yet).
  const today = rand() < 0.5 ? last : addDays(last, 1);

  // Each contract's volume peaks around its own session, with noise, so the
  // leader rolls, sometimes more than once or back and forth by a little.
  const centres = contracts.map(
    (_, k) => ((k + rand() * 0.8) / contracts.length) * sessions.length,
  );
  const widths = contracts.map(() => sessions.length * (0.25 + rand() * 0.25));
  const bases = contracts.map(() => 50_000 + Math.floor(rand() * 150_000));
  const candles: DailyContractVolume[] = [];
  for (const [t, tradeDate] of sessions.entries()) {
    for (const [k, contract] of contracts.entries()) {
      // A dropped contract-day, never on the seed start.
      if (t > 0 && rand() < 0.08) continue;
      const z = (t - (centres[k] ?? 0)) / (widths[k] ?? 1);
      const volume =
        Math.round((bases[k] ?? 0) * Math.exp(-z * z) * (0.7 + rand() * 0.6)) +
        Math.floor(rand() * 40);
      candles.push({ contract, tradeDate, volume });
    }
  }

  // Some stored decisions: on any calendar date from the first decision to
  // today, with contracts that never go back.
  const stored: History['stored'] = [];
  if (rand() < 0.5) {
    const calendar: string[] = [];
    for (let d = FIRST_DECISION; d <= today; d = addDays(d, 1)) {
      calendar.push(d);
    }
    // Weekends are drawn twice as often: a stored row on a date with no
    // session is an incumbent and a ceiling the walk must not lose.
    const pool = [...calendar, ...calendar.filter(isWeekend)];
    const dates = new Set<string>();
    const count = 1 + Math.floor(rand() * 3);
    while (dates.size < Math.min(count, calendar.length)) {
      dates.add(pool[Math.floor(rand() * pool.length)] ?? today);
    }
    const picks = [...dates].sort();
    const levels = picks
      .map(() => Math.floor(rand() * contracts.length))
      .sort((a, b) => a - b);
    for (const [i, tradeDate] of picks.entries()) {
      stored.push({
        tradeDate,
        contract: contracts[levels[i] ?? 0] ?? contracts[0] ?? '',
      });
    }
  }
  return { root, today, contracts, candles, stored };
}

// ── Harness ───────────────────────────────────────────────

let db: PGlite;
let logs: string[];

beforeAll(async () => {
  db = new PGlite();
  await applyMigration(db, 205);
  holder.sql = neonOverPglite(db);
});

afterAll(async () => {
  holder.sql = null;
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE futures_contract_volume, futures_front_month');
  mockWarn.mockClear();
  mockFetchVolumes.mockReset();
  logs = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(`ERROR ${args.join(' ')}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FrontRow {
  trade_date: string;
  contract: string;
  source: string;
}

async function frontRows(root: FuturesRoot): Promise<FrontRow[]> {
  const { rows } = await db.query<FrontRow>(
    `SELECT trade_date::text AS trade_date, contract, source
       FROM futures_front_month WHERE product = $1 ORDER BY trade_date`,
    [root],
  );
  return rows;
}

/** Whether `a` expires before `b`, read against the date `ref`. */
function expiresBefore(
  root: FuturesRoot,
  a: string,
  b: string,
  ref: string,
): boolean {
  const pa = parseContract(root, a, ref);
  const pb = parseContract(root, b, ref);
  if (pa == null || pb == null) throw new Error(`bad contract ${a} / ${b}`);
  return compareExpiry(pa, pb) < 0;
}

/** A switch line of the seed's output: root, trade date, `from → to`, .... */
const SWITCH_LINE = /^ {2}[A-Z]+ {2}\d{4}-\d{2}-\d{2} {2}\S+ → .*$/gm;

// What the 30 histories between them exercised, so the equivalence cannot
// pass on histories that never roll, keep a stored row or clamp.
const seen = {
  switches: 0,
  kept: 0,
  lowered: 0,
  clampWarnings: 0,
  weekend: 0,
  storedWeekend: 0,
};

// ── The test ──────────────────────────────────────────────

describe('the seed against ensureFrontMonth, on real SQL', () => {
  it.each(Array.from({ length: HISTORIES }, (_, i) => i))(
    'history %i: every row the seed writes is what ensureFrontMonth decides, and the dates between agree',
    async (index) => {
      const h = buildHistory(index);
      seen.storedWeekend += h.stored.filter((s) =>
        isWeekend(s.tradeDate),
      ).length;
      vi.setSystemTime(new Date(`${h.today}T15:00:00.000Z`));
      mockFetchVolumes.mockImplementation(
        async (_key: string, _root: string, listed: readonly string[]) =>
          h.candles.filter((c) => listed.includes(c.contract)),
      );
      for (const s of h.stored) {
        await db.query(
          `INSERT INTO futures_front_month (product, trade_date, contract, source)
           VALUES ($1, $2::date, $3, 'script')`,
          [h.root, s.tradeDate, s.contract],
        );
      }

      // 1. The whole seed, over the real store.
      const exit = await runFrontMonthSeed({
        apiKey: 'uw-key',
        roots: [h.root],
        dryRun: false,
      });
      expect(logs.filter((l) => l.startsWith('ERROR'))).toEqual([]);
      expect(exit).toBe(0);
      const output = logs.join('\n');
      // Rolls the candles decided, from switch lines only (`  CL  2026-08-10
      // CLU6 → CLV6  (...)`; the banner and each root's header carry arrows
      // too). A switch onto a stored row is not one.
      seen.switches += (output.match(SWITCH_LINE) ?? []).filter(
        (line) => !line.endsWith('[stored row]'),
      ).length;
      seen.kept += (output.match(/kept stored row/g) ?? []).length;
      const lowered = (output.match(/lowered/g) ?? []).length;
      seen.lowered += lowered;

      const written = (await frontRows(h.root)).filter(
        (r) => r.source === 'candles',
      );
      expect(written.length).toBeGreaterThan(0);
      // The running session is decided too.
      expect(
        h.stored.some((s) => s.tradeDate === h.today) ||
          written.some((r) => r.trade_date === h.today),
      ).toBe(true);

      // 2. Decide every one of those dates again, one at a time, oldest
      //    first, from the volumes and the stored rows that remain.
      await db.query(
        `DELETE FROM futures_front_month
          WHERE product = $1 AND source = 'candles'`,
        [h.root],
      );
      mockWarn.mockClear();
      for (const row of written) {
        const decided = await ensureFrontMonth(
          h.root,
          row.trade_date,
          'script',
        );
        expect(decided, `${h.root} ${row.trade_date} (seed ${index})`).toBe(
          row.contract,
        );
      }
      seen.clampWarnings += mockWarn.mock.calls.filter(([, message]) =>
        /later than the next stored decision/.test(String(message)),
      ).length;
      // The same clamps: ensureFrontMonth lowers exactly the dates the walk
      // lowered.
      expect(
        mockWarn.mock.calls.filter(([, message]) =>
          /later than the next stored decision/.test(String(message)),
        ),
      ).toHaveLength(lowered);

      // 3. Dates the seed did not write: a weekend between two of its rows.
      const dates = new Set((await frontRows(h.root)).map((r) => r.trade_date));
      const between: string[] = [];
      for (let d = FIRST_DECISION; d < h.today; d = addDays(d, 1)) {
        if (!dates.has(d) && isWeekend(d)) between.push(d);
      }
      const picks = between.slice(0, 3);
      seen.weekend += picks.length;
      for (const date of picks) {
        const rows = await frontRows(h.root);
        const before = rows.filter((r) => r.trade_date < date).at(-1);
        const after = rows.find((r) => r.trade_date > date);
        const decided = await ensureFrontMonth(h.root, date, 'script');
        if (before != null) {
          expect(
            expiresBefore(h.root, decided, before.contract, date),
            `${h.root} ${date} ${decided} is earlier than ${before.contract}`,
          ).toBe(false);
        }
        if (after != null) {
          expect(
            expiresBefore(h.root, after.contract, decided, date),
            `${h.root} ${date} ${decided} is later than ${after.contract}`,
          ).toBe(false);
        }
      }

      // And the whole series, rows ensureFrontMonth added included, never
      // steps back.
      const series = new Map(
        (await frontRows(h.root)).map((r) => [r.trade_date, r.contract]),
      );
      expect(findOutOfOrder(h.root, series)).toBeNull();
    },
  );

  it('the histories between them rolled, kept stored rows, clamped, and crossed weekends', () => {
    // 34 rolls decided by the candles over these histories (5 more switches
    // land on stored rows); histories that never rolled would read 0.
    expect(seen.switches).toBeGreaterThan(30);
    expect(seen.kept).toBeGreaterThan(0);
    expect(seen.lowered).toBeGreaterThan(0);
    expect(seen.clampWarnings).toBe(seen.lowered);
    expect(seen.weekend).toBeGreaterThan(10);
    expect(seen.storedWeekend).toBeGreaterThan(2);
  });
});
