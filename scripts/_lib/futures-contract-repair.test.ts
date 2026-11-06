// @vitest-environment node

/**
 * Unit tests for the ES/NQ contract-mix repair: the field-wise rule, the
 * excursion test behind the tick-span delete, the Phase 1 input checks and the
 * argument parser. The SQL runs against pglite in
 * futures-contract-repair-pglite.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveChanges,
  buildPlan,
  classifySession,
  dayDigest,
  excursions,
  formatReport,
  loadManifest,
  loadRebuild,
  loadTicklessWindows,
  markerPath,
  markerState,
  parseNdjson,
  parseRepairArgs,
  roundNumeric,
  runRepair,
  tickChanges,
  toBar,
  unsplittableCount,
  type Manifest,
  type PgBar,
  type PgRow,
  type RebuiltBar,
  type Root,
} from './futures-contract-repair.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ms = (iso: string): number => Date.parse(iso);

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    gitHead: 'fbe7c057154fee85ca59ed5a43ecac1cfa4f720a',
    moduleEdited: false,
    finishedUtc: '2026-11-06T20:00:11Z',
    spans: {
      archive: {
        startMs: ms('2026-04-05T22:00:00Z'),
        endMs: ms('2026-04-17T21:00:00Z'),
      },
      ticks: {
        startMs: ms('2026-04-20T01:56:00Z'),
        endMs: ms('2026-06-15T14:12:00Z'),
      },
    },
    roots: {
      ES: { front: 'ESM6', gap: 17, carry: 60.75, carryHalf: 30.375 },
      NQ: { front: 'NQM6', gap: 65, carry: 279.75, carryHalf: 139.875 },
    },
    gate: {
      ES: { minutes: 13680, exactOhlc: 13680, volumeWithin1pct: 13680 },
      NQ: { minutes: 13680, exactOhlc: 13680, volumeWithin1pct: 13680 },
    },
    rows: { 'ES/archive': 0, 'ES/ticks': 0, 'NQ/archive': 0, 'NQ/ticks': 0 },
    ndjsonFiles: 0,
    unsplittable: 0,
    ...over,
  };
}

function row(
  symbol: string,
  iso: string,
  p: [number, number, number, number],
  volume = 100,
  id = '1',
): PgRow {
  return {
    id,
    symbol,
    ts: iso,
    open: p[0].toFixed(4),
    high: p[1].toFixed(4),
    low: p[2].toFixed(4),
    close: p[3].toFixed(4),
    volume: String(volume),
    buy_volume: null,
    sell_volume: null,
    buy_prints: null,
    sell_prints: null,
  };
}

const pg = (
  symbol: string,
  iso: string,
  p: [number, number, number, number],
  volume = 100,
  id = '1',
): PgBar => toBar(row(symbol, iso, p, volume, id));

function rebuilt(
  symbol: Root,
  iso: string,
  p: [number, number, number, number],
  over: Partial<RebuiltBar> = {},
): RebuiltBar {
  return {
    symbol,
    tsMs: ms(iso),
    open: p[0],
    high: p[1],
    low: p[2],
    close: p[3],
    volume: 100,
    source: 'ticks',
    nClusters: 1,
    partial: false,
    ...over,
  };
}

const minuteIso = (base: string, plus: number): string =>
  new Date(ms(base) + plus * 60_000).toISOString().replace('.000Z', 'Z');

// ── NUMERIC(12,4) rounding ──────────────────────────────────────────────────

describe('roundNumeric', () => {
  it.each([
    [7155.25, 7155.25],
    [7155.250000001, 7155.25],
    [7155.25004, 7155.25],
    [7155.25005, 7155.2501],
    [0.1 + 0.2, 0.3],
    [24123.4, 24123.4],
  ])('%s rounds to %s', (input, expected) => {
    expect(roundNumeric(input)).toBe(expected);
  });
});

describe('toBar', () => {
  it('parses the text columns the way Postgres NUMERIC(12,4) prints them', () => {
    const bar = toBar(
      row(
        'ES',
        '2026-04-21T13:30:00Z',
        [7155, 7156.75, 7154.75, 7155.5],
        487,
        '42',
      ),
    );
    expect(bar).toMatchObject({
      id: '42',
      symbol: 'ES',
      tsMs: ms('2026-04-21T13:30:00Z'),
      open: 7155,
      high: 7156.75,
      low: 7154.75,
      close: 7155.5,
      volume: 487,
    });
  });

  it('rejects a bar that is not on a minute boundary', () => {
    expect(() =>
      toBar(row('ES', '2026-04-21T13:30:07Z', [1, 1, 1, 1])),
    ).toThrow(/not minute-aligned/);
  });

  it('rejects a column that is not a number', () => {
    const bad = {
      ...row('ES', '2026-04-21T13:30:00Z', [1, 1, 1, 1]),
      high: 'NaN',
    };
    expect(() => toBar(bad)).toThrow(/high/);
  });
});

// ── Archive span: every field follows the rebuild ───────────────────────────

describe('archiveChanges', () => {
  const iso = '2026-04-07T14:31:00Z';

  it('lists no change when every field matches at NUMERIC(12,4) precision', () => {
    const bar = pg('ES', iso, [7000, 7001.25, 6999.5, 7000.75], 300);
    const rb = rebuilt('ES', iso, [7000, 7001.25000001, 6999.5, 7000.75], {
      volume: 300,
      source: 'archive',
    });
    expect(archiveChanges(bar, rb)).toEqual([]);
  });

  it('replaces open and high from the back month, and nothing else', () => {
    const bar = pg('ES', iso, [7060.75, 7062, 6999.5, 7000.75], 300);
    const rb = rebuilt('ES', iso, [7000, 7001.25, 6999.5, 7000.75], {
      volume: 300,
      source: 'archive',
    });
    expect(archiveChanges(bar, rb)).toEqual([
      { field: 'open', from: 7060.75, to: 7000 },
      { field: 'high', from: 7062, to: 7001.25 },
    ]);
  });

  it('replaces volume too, however small the price move', () => {
    const bar = pg('NQ', iso, [24000, 24001, 23999, 24000.25], 41);
    const rb = rebuilt('NQ', iso, [24000, 24001, 23999, 24000.25], {
      volume: 40,
      source: 'archive',
    });
    expect(archiveChanges(bar, rb)).toEqual([
      { field: 'volume', from: 41, to: 40 },
    ]);
  });
});

// ── Tick span: the field-wise rule ──────────────────────────────────────────

describe('tickChanges', () => {
  const iso = '2026-04-21T14:00:00Z';
  const CARRY_HALF_ES = 30.375;
  const CARRY_HALF_NQ = 139.875;

  it('replaces a back-month field a full carry off, keeps the others', () => {
    const bar = pg('ES', iso, [7061, 7062, 7001, 7001.5]); // open/high +60
    const rb = rebuilt('ES', iso, [7000.75, 7001.75, 7001, 7001.5]);
    expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([
      { field: 'open', from: 7061, to: 7000.75 },
      { field: 'high', from: 7062, to: 7001.75 },
    ]);
  });

  it('keeps a front-month field that differs from the rebuild by a boundary print', () => {
    // PG saw a print the rebuild did not: 2.5 points apart, far under the carry.
    const bar = pg('ES', iso, [7000, 7003.5, 6999, 7001]);
    const rb = rebuilt('ES', iso, [7000, 7001, 6999, 7001]);
    expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([]);
  });

  it.each([
    ['ES', 30.375, CARRY_HALF_ES, false],
    ['ES', 30.5, CARRY_HALF_ES, true],
    ['NQ', 139.875, CARRY_HALF_NQ, false],
    ['NQ', 140, CARRY_HALF_NQ, true],
  ])(
    '%s: a difference of %s against %s is replaced=%s (strictly greater)',
    (symbol, diff, half, replaced) => {
      const bar = pg(symbol, iso, [10000 + diff, 10000 + diff, 10000, 10000]);
      const rb = rebuilt(symbol as Root, iso, [10000, 10000, 10000, 10000]);
      const fields = tickChanges(bar, rb, half).map((c) => c.field);
      expect(fields).toEqual(replaced ? ['open', 'high'] : []);
    },
  );

  it('replaces a field that sits below the rebuild by a carry as well', () => {
    const bar = pg('ES', iso, [7000, 7001, 6939, 6940]); // low/close -60
    const rb = rebuilt('ES', iso, [7000, 7001, 6999.75, 7000.5]);
    expect(tickChanges(bar, rb, CARRY_HALF_ES).map((c) => c.field)).toEqual([
      'low',
      'close',
    ]);
  });

  describe('volume', () => {
    const base = (day: string, over: Partial<RebuiltBar> = {}) => {
      const stamp = `${day}T14:00:00Z`;
      return {
        bar: pg('ES', stamp, [7000, 7001, 6999, 7000], 5000),
        rb: rebuilt('ES', stamp, [7000, 7001, 6999, 7000], {
          volume: 4800,
          nClusters: 2,
          ...over,
        }),
      };
    };

    it('is kept outside the roll week, even on a mixed non-partial minute', () => {
      const { bar, rb } = base('2026-06-08');
      expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([]);
    });

    it('is written in the roll week on a mixed, non-partial minute that differs', () => {
      const { bar, rb } = base('2026-06-10');
      expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([
        { field: 'volume', from: 5000, to: 4800 },
      ]);
    });

    it('is kept in the roll week on a single-cluster minute', () => {
      const { bar, rb } = base('2026-06-10', { nClusters: 1 });
      expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([]);
    });

    it('is kept in the roll week on a partial minute', () => {
      const { bar, rb } = base('2026-06-10', { partial: true });
      expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([]);
    });

    it('is not a change when the volumes already agree', () => {
      const { bar, rb } = base('2026-06-10', { volume: 5000 });
      expect(tickChanges(bar, rb, CARRY_HALF_ES)).toEqual([]);
    });

    it.each([
      ['2026-06-08T23:59:00Z', false],
      ['2026-06-09T00:00:00Z', true],
      ['2026-06-15T14:11:00Z', true],
    ])('roll week boundary: %s applies=%s', (stamp, applies) => {
      const bar = pg('ES', stamp, [7000, 7001, 6999, 7000], 5000);
      const rb = rebuilt('ES', stamp, [7000, 7001, 6999, 7000], {
        volume: 4800,
        nClusters: 3,
      });
      expect(tickChanges(bar, rb, CARRY_HALF_ES).length).toBe(applies ? 1 : 0);
    });
  });

  describe('volume follows a replaced low', () => {
    // A back-only minute: no front-month bar was ever merged into the row, so
    // every PG field is the back month's and its volume is a handful of lots.
    const backOnly = (stamp: string, over: Partial<RebuiltBar> = {}) => ({
      bar: pg('ES', stamp, [7060.75, 7062, 7060, 7061], 33),
      rb: rebuilt('ES', stamp, [7000, 7001.25, 6999.5, 7000.5], {
        volume: 8436,
        ...over,
      }),
    });

    it('writes the rebuilt volume outside the roll week, even on a partial minute', () => {
      const { bar, rb } = backOnly('2026-05-20T15:18:00Z', { partial: true });
      const changes = tickChanges(bar, rb, CARRY_HALF_ES);
      expect(changes.map((c) => c.field)).toEqual([
        'open',
        'high',
        'low',
        'close',
        'volume',
      ]);
      expect(changes.at(-1)).toEqual({ field: 'volume', from: 33, to: 8436 });
    });

    it('writes it in the roll week on a partial single-cluster minute too', () => {
      const { bar, rb } = backOnly('2026-06-10T15:18:00Z', {
        partial: true,
        nClusters: 1,
      });
      expect(tickChanges(bar, rb, CARRY_HALF_ES).map((c) => c.field)).toContain(
        'volume',
      );
    });

    it('is not a change when the replaced low comes with an equal volume', () => {
      const { bar, rb } = backOnly('2026-05-20T15:18:00Z', { volume: 33 });
      expect(tickChanges(bar, rb, CARRY_HALF_ES).map((c) => c.field)).toEqual([
        'open',
        'high',
        'low',
        'close',
      ]);
    });

    it('leaves a differing volume alone when only the high is replaced', () => {
      const stamp = '2026-05-20T15:18:00Z';
      const bar = pg('ES', stamp, [7000, 7062, 6999, 7000], 33);
      const rb = rebuilt('ES', stamp, [7000, 7001, 6999, 7000], {
        volume: 8436,
      });
      expect(tickChanges(bar, rb, CARRY_HALF_ES).map((c) => c.field)).toEqual([
        'high',
      ]);
    });
  });
});

// ── Excursion test (b-forensics.md §3.1) ────────────────────────────────────

describe('excursions', () => {
  const base = '2026-04-20T02:00:00Z';
  const flat = (n: number, close = 24000): PgBar[] =>
    Array.from({ length: n }, (_, i) =>
      pg(
        'NQ',
        minuteIso(base, i),
        [close, close + 1, close - 1, close],
        100,
        String(i),
      ),
    );

  it('flags a bar whose field sits X or more from the centred median of 11 closes', () => {
    const bars = flat(15);
    bars[7] = pg('NQ', minuteIso(base, 7), [24240, 24240, 24000, 24000]); // +240
    const result = excursions(bars, 120);
    expect(result[7]).toMatchObject({ f: 24000, flagged: true, e: 240 });
    expect(result.filter((r) => r.flagged)).toHaveLength(1);
  });

  it('does not flag an excursion just under X', () => {
    const bars = flat(15);
    bars[7] = pg('NQ', minuteIso(base, 7), [24119.75, 24119.75, 24000, 24000]);
    expect(excursions(bars, 120)[7]?.flagged).toBe(false);
  });

  it('flags at exactly X', () => {
    const bars = flat(15);
    bars[7] = pg('NQ', minuteIso(base, 7), [24120, 24120, 24000, 24000]);
    expect(excursions(bars, 120)[7]?.flagged).toBe(true);
  });

  it('gives no F, and so no flag, to a bar whose window has fewer than 6 closes', () => {
    const bars = flat(5);
    bars[2] = pg('NQ', minuteIso(base, 2), [25000, 25000, 25000, 25000]);
    const result = excursions(bars, 120);
    expect(result.every((r) => r.f === null && !r.flagged)).toBe(true);
  });

  it('shrinks the window at a run edge but still tests with 6 or more closes', () => {
    const bars = flat(11);
    const result = excursions(bars, 120);
    expect(result[0]?.f).toBe(24000); // window 0..5 = 6 closes
    expect(result[10]?.f).toBe(24000);
  });

  it('starts a new run after a gap of more than 5 minutes', () => {
    const left = flat(8, 24000);
    const right = Array.from({ length: 8 }, (_, i) =>
      pg(
        'NQ',
        minuteIso(base, 14 + i),
        [25000, 25001, 24999, 25000],
        100,
        String(100 + i),
      ),
    );
    const result = excursions([...left, ...right], 120);
    // Neither side leaks into the other's median, so nothing is flagged.
    expect(result.filter((r) => r.flagged)).toHaveLength(0);
    expect(result[7]?.f).toBe(24000);
    expect(result[8]?.f).toBe(25000);
  });

  it('keeps one run across a gap of exactly 5 minutes', () => {
    // Five bars on each side are too few alone; one run of ten is enough.
    const left = flat(5, 24000);
    const right = Array.from({ length: 5 }, (_, i) =>
      pg(
        'NQ',
        minuteIso(base, 9 + i),
        [24000, 24001, 23999, 24000],
        100,
        String(100 + i),
      ),
    );
    const result = excursions([...left, ...right], 120);
    expect(result[4]?.f).toBe(24000);
    expect(result[5]?.f).toBe(24000);
  });

  it('takes the mean of the two middle closes when the window has an even count', () => {
    const bars = [
      ...[1, 2, 3, 4, 5, 6].map((c, i) =>
        pg('NQ', minuteIso(base, i), [c, c, c, c], 100, String(i)),
      ),
    ];
    // 6 closes in the window for bar 0 (0..5): median of 1..6 = 3.5.
    expect(excursions(bars, 999)[0]?.f).toBe(3.5);
  });
});

// ── buildPlan ───────────────────────────────────────────────────────────────

describe('buildPlan', () => {
  const m = manifest();
  const TICK_DAY = '2026-04-21T13:00:00Z';

  function planFor(
    bars: Record<string, PgBar[]>,
    rebuild: Partial<Record<Root, RebuiltBar[]>> = {},
    tickless: Parameters<typeof buildPlan>[0]['tickless'] = [],
  ) {
    const map = {
      ES: new Map(rebuild.ES?.map((r) => [r.tsMs, r])),
      NQ: new Map(rebuild.NQ?.map((r) => [r.tsMs, r])),
    };
    return buildPlan({ manifest: m, rebuild: map, bars, tickless });
  }

  it('deletes an archive-span row with no rebuilt minute and updates the rest', () => {
    const stamp = '2026-04-07T14:31:00Z';
    const next = '2026-04-07T14:32:00Z';
    const plan = planFor(
      {
        NQ: [
          pg('NQ', stamp, [24000, 24001, 23999, 24000.5], 10, '1'),
          pg('NQ', next, [216, 217, 215.6, 216], 10, '2'),
        ],
      },
      {
        NQ: [
          rebuilt('NQ', stamp, [24000, 24001, 23999.25, 24000.5], {
            source: 'archive',
            volume: 10,
          }),
        ],
      },
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({
      symbol: 'NQ',
      span: 'archive',
      changes: [{ field: 'low', from: 23999, to: 23999.25 }],
    });
    expect(plan.deletes).toHaveLength(1);
    expect(plan.deletes[0]).toMatchObject({
      symbol: 'NQ',
      reason: 'archive_no_rebuild',
      id: '2',
    });
  });

  describe('tick-span delete', () => {
    // 21 flat closes around 24000, one contaminated row in the middle.
    const series = (contaminated: Set<number>): PgBar[] =>
      Array.from({ length: 21 }, (_, i) => {
        const hot = contaminated.has(i);
        const c = 24000;
        return pg(
          'NQ',
          minuteIso(TICK_DAY, i),
          hot ? [c + 240, c + 240, c, c] : [c, c + 1, c - 1, c],
          100,
          String(i + 1),
        );
      });

    it('deletes a row with no rebuilt minute that fails the excursion test', () => {
      const plan = planFor({ NQ: series(new Set([10])) });
      expect(plan.deletes).toHaveLength(1);
      expect(plan.deletes[0]).toMatchObject({
        symbol: 'NQ',
        reason: 'tick_excursion',
        id: '11',
        f: 24000,
        excursion: 240,
      });
    });

    it('keeps a tick-less row that passes the test', () => {
      const plan = planFor({ NQ: series(new Set()) });
      expect(plan.deletes).toEqual([]);
      expect(plan.updates).toEqual([]);
    });

    it('never deletes a row that has a rebuilt minute, however far out it sits', () => {
      const bars = series(new Set([10]));
      const hotTs = minuteIso(TICK_DAY, 10);
      const plan = planFor(
        { NQ: bars },
        { NQ: [rebuilt('NQ', hotTs, [24000, 24001, 23999, 24000])] },
      );
      expect(plan.deletes).toEqual([]);
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0]?.changes.map((c) => c.field)).toEqual([
        'open',
        'high',
      ]);
    });

    it('leaves a row alone when its window is too short to test', () => {
      const bars = series(new Set([2])).slice(0, 5);
      const plan = planFor({ NQ: bars });
      expect(plan.deletes).toEqual([]);
    });

    it('applies the ES threshold of 25 to ES', () => {
      const bars = Array.from({ length: 21 }, (_, i) =>
        i === 10
          ? pg(
              'ES',
              minuteIso(TICK_DAY, i),
              [7026, 7026, 7000, 7000],
              100,
              '11',
            )
          : pg(
              'ES',
              minuteIso(TICK_DAY, i),
              [7000, 7001, 6999, 7000],
              100,
              String(i + 1),
            ),
      );
      const plan = planFor({ ES: bars });
      expect(plan.deletes.map((d) => d.id)).toEqual(['11']);
      expect(plan.deletes[0]?.reason).toBe('tick_excursion');
    });
  });

  describe('spans', () => {
    it('touches nothing outside the archive span, the tick span and the junk window', () => {
      const plan = planFor({
        ES: [
          pg('ES', '2026-04-05T21:59:00Z', [1, 1, 1, 1]), // just before the archive span
          pg('ES', '2026-04-17T21:00:00Z', [1, 1, 1, 1]), // archive end is exclusive
          pg('ES', '2026-04-19T23:00:00Z', [1, 1, 1, 1]), // between the spans
          pg('ES', '2026-06-15T14:12:00Z', [1, 1, 1, 1]), // tick end is exclusive
        ],
      });
      expect(plan.updates).toEqual([]);
      expect(plan.deletes).toEqual([]);
    });

    it('does not plan a write for a root other than ES/NQ outside the junk window', () => {
      const plan = planFor({
        RTY: [
          pg('RTY', '2026-04-07T14:00:00Z', [2000, 2001, 1999, 2000], 10, '1'),
          pg('RTY', '2026-04-21T14:00:00Z', [2000, 2001, 1999, 2000], 10, '2'),
        ],
      });
      expect(plan.updates).toEqual([]);
      expect(plan.deletes).toEqual([]);
    });
  });

  describe('junk window', () => {
    it.each([
      ['2026-04-10T20:59:00Z', false],
      ['2026-04-10T21:00:00Z', true],
      ['2026-04-11T14:00:00Z', true],
      ['2026-04-12T21:59:00Z', true],
      ['2026-04-12T22:00:00Z', false],
    ])('%s deleted=%s for every root', (stamp, deleted) => {
      const bars: Record<string, PgBar[]> = {};
      for (const symbol of ['ES', 'NQ', 'RTY', 'CL', 'GC', 'ZN']) {
        bars[symbol] = [
          pg(symbol, stamp, [100, 101, 99, 100], 1, `${symbol}-1`),
        ];
      }
      const plan = planFor(bars);
      const gone = plan.deletes.filter((d) => d.reason === 'junk_window');
      expect(gone.length).toBe(deleted ? 6 : 0);
    });

    it('counts an ES row once when it is both junk and has no rebuilt minute', () => {
      const plan = planFor({
        ES: [
          pg(
            'ES',
            '2026-04-11T14:00:00Z',
            [8098.75, 8098.75, 8098.75, 8098.75],
            900,
            '9',
          ),
        ],
      });
      expect(plan.deletes).toHaveLength(1);
      expect(plan.deletes[0]).toMatchObject({
        reason: 'junk_window',
        alsoNoRebuild: true,
      });
    });

    it('lets the delete win when the rebuild has a row inside the window', () => {
      const stamp = '2026-04-11T14:00:00Z';
      const plan = planFor(
        { ES: [pg('ES', stamp, [7000, 7001, 6999, 7000], 10, '9')] },
        {
          ES: [
            rebuilt('ES', stamp, [7000, 7001, 6999.5, 7000], {
              source: 'archive',
            }),
          ],
        },
      );
      expect(plan.deletes).toHaveLength(1);
      expect(plan.updates).toEqual([]);
      expect(plan.junkWithRebuild).toBe(1);
    });
  });

  it('reports PG rows and excursion flags inside each tick-less window', () => {
    const bars = Array.from({ length: 21 }, (_, i) =>
      i === 10
        ? pg(
            'NQ',
            minuteIso(TICK_DAY, i),
            [24240, 24240, 24000, 24000],
            100,
            '11',
          )
        : pg(
            'NQ',
            minuteIso(TICK_DAY, i),
            [24000, 24001, 23999, 24000],
            100,
            String(i + 1),
          ),
    );
    const plan = planFor({ NQ: bars }, {}, [
      {
        symbol: 'NQ',
        firstMs: ms(minuteIso(TICK_DAY, 8)),
        lastMs: ms(minuteIso(TICK_DAY, 12)),
        minutes: 5,
        openMinutes: 5,
      },
    ]);
    expect(plan.tickless).toEqual([
      expect.objectContaining({ pgRows: 5, flagged: 1 }),
    ]);
  });

  it('counts rebuilt minutes that have no PG row, and plans no insert for them', () => {
    const plan = planFor(
      { ES: [] },
      { ES: [rebuilt('ES', TICK_DAY, [7000, 7001, 6999, 7000])] },
    );
    expect(plan.rebuiltWithoutRow).toEqual({
      ES: { archive: 0, ticks: 1 },
      NQ: { archive: 0, ticks: 0 },
    });
    expect(plan.updates).toEqual([]);
  });
});

// ── Report ──────────────────────────────────────────────────────────────────

describe('classifySession', () => {
  it.each([
    ['2026-04-21T13:29:00Z', 'overnight'], // 08:29 CDT
    ['2026-04-21T13:30:00Z', 'rth'], // 08:30 CDT
    ['2026-04-21T19:59:00Z', 'rth'], // 14:59 CDT
    ['2026-04-21T20:00:00Z', 'overnight'], // 15:00 CDT
    ['2026-01-21T14:30:00Z', 'rth'], // 08:30 CST
    ['2026-01-21T14:29:00Z', 'overnight'],
  ])('%s is %s', (stamp, expected) => {
    expect(classifySession(ms(stamp))).toBe(expected);
  });
});

describe('formatReport', () => {
  it('prints the manifest provenance, the low moves over G and the close moves split by session', () => {
    const rth = '2026-04-07T14:31:00Z'; // 09:31 CDT
    const night = '2026-04-07T03:10:00Z'; // 22:10 CDT
    const small = '2026-04-07T14:33:00Z';
    const plan = buildPlan({
      manifest: manifest(),
      rebuild: {
        ES: new Map([
          [
            ms(rth),
            rebuilt('ES', rth, [7000, 7001, 6999, 7000], { source: 'archive' }),
          ],
          [
            ms(night),
            rebuilt('ES', night, [7000, 7001, 6999, 7000], {
              source: 'archive',
            }),
          ],
          [
            ms(small),
            rebuilt('ES', small, [7000, 7001, 6999, 7000], {
              source: 'archive',
            }),
          ],
        ]),
        NQ: new Map(),
      },
      bars: {
        ES: [
          // low moves 40 (> G = 17) and close moves 40
          pg('ES', night, [7000, 7001, 7039, 7040], 100, '1'),
          // low moves 20 (> G) and close moves 30 (> G)
          pg('ES', rth, [7000, 7001, 6979, 6970], 100, '2'),
          // close moves 10, under G
          pg('ES', small, [7000, 7001, 6999, 6990], 100, '3'),
        ],
      },
      tickless: [],
    });
    const text = formatReport(plan, manifest());

    expect(text).toContain('fbe7c057154fee85ca59ed5a43ecac1cfa4f720a');
    expect(text).toMatch(/ES front ESM6 G=17 carry=60\.75 carry_half=30\.375/);
    expect(text).toMatch(
      /NQ front NQM6 G=65 carry=279\.75 carry_half=139\.875/,
    );
    expect(text).toContain('Low moves greater than G (ES 17, NQ 65): 2');
    const lowLines = text.split('\n').filter((l) => /^ {2}ES \S+ low /.test(l));
    expect(lowLines).toEqual([
      '  ES 2026-04-07T03:10:00Z low 7039 -> 6999',
      '  ES 2026-04-07T14:31:00Z low 6979 -> 6999',
    ]);
    expect(text).toContain(
      'ES close moves greater than G=17: rth 1, overnight 1',
    );
    expect(text).toContain(
      'NQ close moves greater than G=65: rth 0, overnight 0',
    );
  });
});

// ── Phase 1 inputs ──────────────────────────────────────────────────────────

describe('inputs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repair-inputs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifestJson = (over: Record<string, unknown> = {}) => ({
    status: 'passed',
    reason: '',
    git: {
      head: 'fbe7c057154fee85ca59ed5a43ecac1cfa4f720a',
      module_edited: false,
    },
    finished_utc: '2026-11-06T20:00:11.087871+00:00',
    spans: {
      archive: ['2026-04-05 22:00:00+00:00', '2026-04-17 21:00:00+00:00'],
      ticks: ['2026-04-20 01:56:00+00:00', '2026-06-15 14:12:00+00:00'],
    },
    roots: {
      ES: { front: 'ESM6', gap: 17.0, carry: 60.75, carry_half: 30.375 },
      NQ: { front: 'NQM6', gap: 65.0, carry: 279.75, carry_half: 139.875 },
    },
    gate: {
      ts_recv: {
        ES: {
          minutes: 13680,
          exact_ohlc: 13680,
          volume_within_1pct: 13680,
          passed: true,
        },
        NQ: {
          minutes: 13680,
          exact_ohlc: 13680,
          volume_within_1pct: 13680,
          passed: true,
        },
      },
      ts_event: {
        ES: {
          minutes: 13680,
          exact_ohlc: 13663,
          volume_within_1pct: 13680,
          passed: false,
        },
        NQ: {
          minutes: 13680,
          exact_ohlc: 13638,
          volume_within_1pct: 13677,
          passed: false,
        },
      },
    },
    post_check: { listed: 0, allowlisted: 0, unsplittable: 0 },
    rows: { 'ES/archive': 1, 'ES/ticks': 1, 'NQ/archive': 0, 'NQ/ticks': 0 },
    ndjson_files: 2,
    ...over,
  });

  const writeManifest = (over?: Record<string, unknown>) =>
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(manifestJson(over)),
    );

  describe('loadManifest', () => {
    it('refuses when manifest.json is missing', () => {
      expect(() => loadManifest(dir)).toThrow(/manifest\.json not found/);
    });

    it('refuses when it is not JSON', () => {
      writeFileSync(join(dir, 'manifest.json'), '{nope');
      expect(() => loadManifest(dir)).toThrow(
        /manifest\.json is not valid JSON/,
      );
    });

    it('refuses a manifest that lacks a field it relies on', () => {
      writeManifest({ roots: { ES: { front: 'ESM6' } } });
      expect(() => loadManifest(dir)).toThrow(/manifest\.json is malformed/);
    });

    it('refuses when the run did not pass, naming the reason', () => {
      writeManifest({ status: 'failed', reason: 'ES exact rate 0.97 < 0.999' });
      expect(() => loadManifest(dir)).toThrow(
        /did not pass.*ES exact rate 0\.97 < 0\.999/s,
      );
    });

    it('refuses when the ts_recv gate failed for a root', () => {
      const base = manifestJson();
      const gate = structuredClone(base.gate);
      gate.ts_recv.NQ.passed = false;
      writeManifest({ gate });
      expect(() => loadManifest(dir)).toThrow(/gate.*NQ/);
    });

    it('ignores the informational ts_event gate, which Phase 1 expects to fail', () => {
      writeManifest();
      const loaded = loadManifest(dir);
      expect(loaded.gitHead).toBe('fbe7c057154fee85ca59ed5a43ecac1cfa4f720a');
      expect(loaded.roots.ES).toEqual({
        front: 'ESM6',
        gap: 17,
        carry: 60.75,
        carryHalf: 30.375,
      });
      expect(loaded.roots.NQ.carryHalf).toBe(139.875);
      expect(loaded.spans.archive).toEqual({
        startMs: ms('2026-04-05T22:00:00Z'),
        endMs: ms('2026-04-17T21:00:00Z'),
      });
      expect(loaded.spans.ticks.endMs).toBe(ms('2026-06-15T14:12:00Z'));
    });
  });

  describe('parseNdjson', () => {
    const good = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        symbol: 'ES',
        ts: '2026-04-21T13:30:00Z',
        open: 7155.0,
        high: 7156.75,
        low: 7154.75,
        close: 7155.5,
        volume: 487,
        source: 'ticks',
        n_clusters: 2,
        partial: false,
        ...over,
      });

    it('reads one bar per line and skips blank lines', () => {
      const bars = parseNdjson(
        `${good()}\n\n${good({ ts: '2026-04-21T13:31:00Z' })}\n`,
        'f.ndjson',
      );
      expect(bars).toHaveLength(2);
      expect(bars[0]).toEqual({
        symbol: 'ES',
        tsMs: ms('2026-04-21T13:30:00Z'),
        open: 7155,
        high: 7156.75,
        low: 7154.75,
        close: 7155.5,
        volume: 487,
        source: 'ticks',
        nClusters: 2,
        partial: false,
      });
    });

    it('names the file and line of a line that is not JSON', () => {
      expect(() =>
        parseNdjson(`${good()}\n{"symbol":\n`, 'ES-2026-04-21.ndjson'),
      ).toThrow(/ES-2026-04-21\.ndjson:2: not JSON/);
    });

    it('names the file and line of a NaN, which Python writes and JSON forbids', () => {
      expect(() =>
        parseNdjson(good().replace('7155.5', 'NaN'), 'f.ndjson'),
      ).toThrow(/f\.ndjson:1: not JSON/);
    });

    it.each([
      ['a symbol outside ES/NQ', { symbol: 'RTY' }, /symbol/],
      ['a timestamp with seconds', { ts: '2026-04-21T13:30:05Z' }, /ts/],
      ['a timestamp without Z', { ts: '2026-04-21 13:30:00' }, /ts/],
      ['a fractional volume', { volume: 12.5 }, /volume/],
      ['a negative volume', { volume: -1 }, /volume/],
      ['a non-positive price', { low: 0 }, /low/],
      ['an unknown source', { source: 'rest' }, /source/],
      ['zero clusters', { n_clusters: 0 }, /n_clusters/],
      ['a string for partial', { partial: 'no' }, /partial/],
      ['a high below the close', { high: 7155.0 }, /high/],
    ])('rejects %s with the line number', (_label, over, pattern) => {
      expect(() =>
        parseNdjson(`${good()}\n${good(over)}\n`, 'f.ndjson'),
      ).toThrow(new RegExp(`f\\.ndjson:2: .*${pattern.source}`));
    });

    it('rejects a line that is missing a field', () => {
      const line = JSON.parse(good()) as Record<string, unknown>;
      delete line.partial;
      expect(() => parseNdjson(JSON.stringify(line), 'f.ndjson')).toThrow(
        /f\.ndjson:1: partial/,
      );
    });
  });

  describe('loadRebuild', () => {
    const bar = (
      symbol: string,
      iso: string,
      source: string,
      over: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        symbol,
        ts: iso,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        source,
        n_clusters: 1,
        partial: false,
        ...over,
      });

    function setup(files: Record<string, string[]>, m: Partial<Manifest>) {
      mkdirSync(join(dir, 'ndjson'));
      for (const [name, lines] of Object.entries(files)) {
        writeFileSync(join(dir, 'ndjson', name), `${lines.join('\n')}\n`);
      }
      return manifest({
        rows: {
          'ES/archive': 1,
          'ES/ticks': 1,
          'NQ/archive': 0,
          'NQ/ticks': 0,
        },
        ndjsonFiles: 2,
        ...m,
      });
    }

    it('loads every file into a per-root map keyed by minute', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [bar('ES', '2026-04-21T14:31:00Z', 'ticks')],
        },
        {},
      );
      const rebuild = loadRebuild(dir, m);
      expect([...rebuild.ES.keys()]).toEqual([
        ms('2026-04-07T14:31:00Z'),
        ms('2026-04-21T14:31:00Z'),
      ]);
      expect(rebuild.NQ.size).toBe(0);
    });

    it('refuses when a file is missing against the manifest count', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
          ],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(
        /1 NDJSON file.*manifest says 2/s,
      );
    });

    it('refuses when a root/source row count differs from the manifest', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [
            bar('ES', '2026-04-21T14:31:00Z', 'ticks'),
            bar('ES', '2026-04-21T14:32:00Z', 'ticks'),
          ],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(
        'ES/ticks has 2 rows, manifest says 1',
      );
    });

    it('refuses a bar whose day is not the file name day', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-08T14:31:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [bar('ES', '2026-04-21T14:31:00Z', 'ticks')],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(
        /ES-2026-04-07\.ndjson:1.*2026-04-08/s,
      );
    });

    it('refuses a bar whose symbol is not the file name root', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('NQ', '2026-04-07T14:31:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [bar('ES', '2026-04-21T14:31:00Z', 'ticks')],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(/ES-2026-04-07\.ndjson:1.*NQ/s);
    });

    it('refuses an archive bar outside the archive span', () => {
      const m = setup(
        {
          'ES-2026-04-17.ndjson': [
            bar('ES', '2026-04-17T21:00:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [bar('ES', '2026-04-21T14:31:00Z', 'ticks')],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(/archive span/);
    });

    it('refuses a ticks bar outside the tick span', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
          ],
          'ES-2026-06-15.ndjson': [bar('ES', '2026-06-15T14:12:00Z', 'ticks')],
        },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(/tick span/);
    });

    it('refuses a minute that appears twice for a root', () => {
      const m = setup(
        {
          'ES-2026-04-07.ndjson': [
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
            bar('ES', '2026-04-07T14:31:00Z', 'archive'),
          ],
          'ES-2026-04-21.ndjson': [bar('ES', '2026-04-21T14:31:00Z', 'ticks')],
        },
        {
          rows: {
            'ES/archive': 2,
            'ES/ticks': 1,
            'NQ/archive': 0,
            'NQ/ticks': 0,
          },
          ndjsonFiles: 2,
        },
      );
      expect(() => loadRebuild(dir, m)).toThrow(/appears twice/);
    });

    it('refuses an NDJSON file whose name is not {ROOT}-{YYYY-MM-DD}', () => {
      const m = setup(
        { 'ES-latest.ndjson': [bar('ES', '2026-04-07T14:31:00Z', 'archive')] },
        {},
      );
      expect(() => loadRebuild(dir, m)).toThrow(/ES-latest\.ndjson/);
    });

    it('refuses when the ndjson folder is missing', () => {
      expect(() => loadRebuild(dir, manifest())).toThrow(
        /ndjson folder not found/,
      );
    });
  });

  describe('unsplittableCount', () => {
    it('is 0 when the file is absent', () => {
      expect(unsplittableCount(dir)).toBe(0);
    });

    it('is 0 when the file holds only its header', () => {
      writeFileSync(
        join(dir, 'unsplittable.csv'),
        'symbol,ts,rule,open,high,low,close,allowlisted,reason\n',
      );
      expect(unsplittableCount(dir)).toBe(0);
    });

    it('counts the listed minutes', () => {
      writeFileSync(
        join(dir, 'unsplittable.csv'),
        'symbol,ts,rule\nES,2026-04-21 14:00:00+00:00,a\nNQ,2026-04-21 14:01:00+00:00,b\n',
      );
      expect(unsplittableCount(dir)).toBe(2);
    });
  });

  describe('loadTicklessWindows', () => {
    it('parses the Phase 1 csv', () => {
      writeFileSync(
        join(dir, 'tickless_windows.csv'),
        'symbol,first_minute,last_minute,minutes,open_minutes\n' +
          'ES,2026-04-20 05:11:00+00:00,2026-04-20 05:17:00+00:00,7,7\n' +
          'NQ,2026-04-20 01:56:00+00:00,2026-04-20 02:36:00+00:00,41,41\n',
      );
      expect(loadTicklessWindows(dir)).toEqual([
        {
          symbol: 'ES',
          firstMs: ms('2026-04-20T05:11:00Z'),
          lastMs: ms('2026-04-20T05:17:00Z'),
          minutes: 7,
          openMinutes: 7,
        },
        {
          symbol: 'NQ',
          firstMs: ms('2026-04-20T01:56:00Z'),
          lastMs: ms('2026-04-20T02:36:00Z'),
          minutes: 41,
          openMinutes: 41,
        },
      ]);
    });

    it('refuses a row it cannot read, naming the line', () => {
      writeFileSync(
        join(dir, 'tickless_windows.csv'),
        'symbol,first_minute,last_minute,minutes,open_minutes\nES,not-a-date,2026-04-20 05:17:00+00:00,7,7\n',
      );
      expect(() => loadTicklessWindows(dir)).toThrow(/tickless_windows\.csv:2/);
    });

    it('refuses when the file is missing', () => {
      expect(() => loadTicklessWindows(dir)).toThrow(
        /tickless_windows\.csv not found/,
      );
    });
  });
});

// ── Done markers ────────────────────────────────────────────────────────────

describe('dayDigest and markerState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repair-markers-'));
    mkdirSync(join(dir, 'ndjson'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const day = '2026-04-21';
  const write = (name: string, text: string) =>
    writeFileSync(join(dir, 'ndjson', name), text);
  const stamp = (ndjsonSha256: string, gitHead = 'aaaaaaaa11112222') => ({
    gitHead,
    ndjsonSha256,
  });
  const mark = (body: unknown) =>
    writeFileSync(
      markerPath(dir, day),
      typeof body === 'string' ? body : JSON.stringify(body),
    );

  it('hashes both roots files of the day, so a change to either shows', () => {
    write(`ES-${day}.ndjson`, 'a');
    const first = dayDigest(dir, day);
    expect(dayDigest(dir, day)).toBe(first);
    write(`ES-${day}.ndjson`, 'b');
    const second = dayDigest(dir, day);
    expect(second).not.toBe(first);
    write(`NQ-${day}.ndjson`, 'c');
    expect(dayDigest(dir, day)).not.toBe(second);
  });

  it('tells a day with no file from a day whose file is empty', () => {
    const absent = dayDigest(dir, day);
    write(`ES-${day}.ndjson`, '');
    expect(dayDigest(dir, day)).not.toBe(absent);
  });

  it('is none without a marker', () => {
    expect(markerState(dir, day, stamp('x'))).toEqual({ state: 'none' });
  });

  it('is done when the marker names this Phase 1 run and these bars', () => {
    mark({ ...stamp('x'), appliedAt: '2026-11-08T12:00:00Z' });
    expect(markerState(dir, day, stamp('x'))).toEqual({ state: 'done' });
  });

  it('ignores a marker from another Phase 1 git SHA, naming both', () => {
    mark({ ...stamp('x', 'bbbbbbbb33334444'), appliedAt: 'now' });
    expect(markerState(dir, day, stamp('x'))).toEqual({
      state: 'stale',
      reason: 'is from Phase 1 git bbbbbbbb, not aaaaaaaa',
    });
  });

  it('ignores a marker written for different rebuilt bars', () => {
    mark({ ...stamp('old'), appliedAt: 'now' });
    expect(markerState(dir, day, stamp('new'))).toEqual({
      state: 'stale',
      reason: 'was written for different rebuilt bars',
    });
  });

  it.each([
    [
      'a bare timestamp (the first version of the tool)',
      '2026-11-08T12:00:00.000Z',
    ],
    ['text that is not JSON', '{nope'],
    ['JSON without the stamp', JSON.stringify({ appliedAt: 'now' })],
  ])('ignores a marker that is %s', (_label, body) => {
    mark(body);
    expect(markerState(dir, day, stamp('x'))).toEqual({
      state: 'stale',
      reason: 'is unreadable',
    });
  });
});

// ── Arguments ───────────────────────────────────────────────────────────────

describe('parseRepairArgs', () => {
  it('defaults to a dry run over the Phase 1 output folder', () => {
    expect(parseRepairArgs([])).toEqual({
      dir: 'ml/data/futures-contract-repair',
      workDir: 'docs/tmp/futures-contract-repair',
      apply: false,
      force: false,
      dates: [],
      expectUpdates: null,
      expectDeletes: null,
      envFile: null,
    });
  });

  it('reads every flag', () => {
    expect(
      parseRepairArgs([
        '--dir',
        'in',
        '--work-dir',
        'out',
        '--apply',
        '--expect-updates',
        '39061',
        '--expect-deletes',
        '0',
        '--force',
        '--dates',
        '2026-04-07',
        '2026-04-08',
        '--env-file',
        '.env.test',
      ]),
    ).toEqual({
      dir: 'in',
      workDir: 'out',
      apply: true,
      force: true,
      dates: ['2026-04-07', '2026-04-08'],
      expectUpdates: 39061,
      expectDeletes: 0,
      envFile: '.env.test',
    });
  });

  it.each([
    [['--bogus'], /unknown argument --bogus/],
    [['--dir'], /--dir needs a value/],
    [['--work-dir'], /--work-dir needs a value/],
    [['--env-file'], /--env-file needs a value/],
    [['--dates'], /--dates needs a value/],
    [['--dates', '--apply'], /--dates needs a value/],
    [['--dates', '2026-4-7'], /not a YYYY-MM-DD date/],
    [['--dates', '2026-02-30'], /not a YYYY-MM-DD date/],
    [['--force'], /--force only applies with --apply/],
    [['--apply'], /--apply needs --expect-updates N and --expect-deletes M/],
    [
      ['--apply', '--expect-updates', '5'],
      /--apply needs --expect-updates N and --expect-deletes M/,
    ],
    [
      ['--apply', '--expect-deletes', '5'],
      /--apply needs --expect-updates N and --expect-deletes M/,
    ],
    [
      ['--expect-updates', '5', '--expect-deletes', '1'],
      /only apply with --apply/,
    ],
    [['--apply', '--expect-updates'], /--expect-updates needs a value/],
    [
      ['--apply', '--expect-updates', 'many', '--expect-deletes', '1'],
      /--expect-updates needs a whole number, got "many"/,
    ],
    [
      ['--apply', '--expect-updates', '1', '--expect-deletes', '-1'],
      /--expect-deletes needs a whole number, got "-1"/,
    ],
    [
      ['--apply', '--expect-updates', '1.5', '--expect-deletes', '1'],
      /--expect-updates needs a whole number, got "1.5"/,
    ],
  ])('rejects %j', (argv, message) => {
    expect(() => parseRepairArgs(argv)).toThrow(message);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe('runRepair guards', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'repair-guards-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (over = {}) => ({
    dir: join(dir, 'in'),
    workDir: join(dir, 'work'),
    apply: true,
    force: false,
    dates: [],
    expectUpdates: null,
    expectDeletes: null,
    ...over,
  });

  it('refuses --apply during market hours before it reads anything', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z')); // Monday 11:00 ET
    expect(await runRepair(options())).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Refusing to --apply during market hours/),
    );
  });

  it('does not let market hours stop a dry run: it goes on to read the manifest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T16:00:00Z'));
    expect(await runRepair(options({ apply: false }))).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/manifest\.json not found/),
    );
  });

  it('exits non-zero with the reason when the manifest is missing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); // Sunday
    expect(await runRepair(options())).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/manifest\.json not found/),
    );
  });
});
