// @vitest-environment node

/**
 * Tests for the anchor-column history backfill (apply + compare). The only
 * mock is the DB module boundary (getDb); describeAnchor is the real thing.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.hoisted(() => vi.fn());

// Real withDbRetry (its retry loop is part of the write path); fake getDb.
vi.mock('../../api/_lib/db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/_lib/db.js')>()),
  getDb: () => mockSql,
}));

import { describeAnchor, type TapePrint } from '../../api/_lib/anchor-legs.js';
import {
  WRITE_CHUNK,
  applyDate,
  compareToReference,
  formatCompareReport,
  formatDateResult,
  markerPath,
  parseNdjson,
  toColumns,
  type ExtractLine,
  type Reference,
} from './anchor-backfill.js';

const DATE = '2026-10-27';

function print(over: Partial<TapePrint> = {}): TapePrint {
  return {
    wsTradeId: '01a17d88-f676-7fb0-91a5-8ff96ed15792',
    optionChain: 'SPY261028C00785000',
    optionType: 'C',
    strike: 785,
    expiry: '2026-10-28',
    executedAt: '2026-10-27T15:00:01.123Z',
    price: 1.5,
    size: 10,
    tradeCode: 'auto',
    ...over,
  };
}

const MULTI_ANCHOR = print({
  wsTradeId: '01a17d88-0000-7000-8000-000000000001',
  tradeCode: 'mlet',
  size: 20,
  price: 0.91,
});
const MULTI_SIBLING = print({
  wsTradeId: '01a17d88-0000-7000-8000-000000000002',
  optionChain: 'SPY261030C00785000',
  expiry: '2026-10-30',
  tradeCode: 'mlet',
  size: 20,
  price: 2.3,
});

function line(
  table: ExtractLine['table'],
  id: number,
  anchor: TapePrint | null,
  siblings: TapePrint[] = [],
): ExtractLine {
  return { table, id, anchor, siblings };
}

const ndjson = (lines: ExtractLine[]): string =>
  lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

let dir: string;

beforeEach(() => {
  mockSql.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'anchor-backfill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeDate(lines: ExtractLine[], date = DATE): void {
  writeFileSync(join(dir, `${date}.ndjson`), ndjson(lines));
}

/** The SQL text of one tagged-template call. */
const sqlText = (call: unknown[]): string =>
  (call[0] as string[]).join('?').replace(/\s+/g, ' ');

describe('parseNdjson', () => {
  it('parses valid lines and skips blank ones', () => {
    const text = ndjson([line('lottery_finder_fires', 1, print())]) + '\n';
    expect(parseNdjson(text, 'f.ndjson')).toHaveLength(1);
  });

  it('throws with file:line for a malformed JSON line', () => {
    const good = JSON.stringify(line('silent_boom_alerts', 1, null));
    expect(() => parseNdjson(`${good}\n{not json\n`, 'x.ndjson')).toThrow(
      /^x\.ndjson:2: not JSON/,
    );
  });

  it('throws with file:line and the field for a shape violation', () => {
    const bad = JSON.stringify({
      ...line('silent_boom_alerts', 1, print()),
      id: 'one',
    });
    const good = JSON.stringify(line('silent_boom_alerts', 2, null));
    expect(() => parseNdjson(`${good}\n${good}\n${bad}\n`, 'x.ndjson')).toThrow(
      /^x\.ndjson:3: id /,
    );
  });

  it('rejects an unknown table and a bad optionType', () => {
    const badTable = JSON.stringify({
      table: 'ws_option_trades',
      id: 1,
      anchor: null,
      siblings: [],
    });
    expect(() => parseNdjson(badTable, 'x')).toThrow(/^x:1: table /);
    const badType = JSON.stringify(
      line('lottery_finder_fires', 1, print({ optionType: 'call' as 'C' })),
    );
    expect(() => parseNdjson(badType, 'x')).toThrow(/anchor\.optionType/);
  });
});

describe('toColumns', () => {
  it('maps a single-leg anchor: spread columns are null', () => {
    const legs = describeAnchor(print(), []);
    expect(toColumns(legs)).toEqual({
      anchor_ws_trade_id: '01a17d88-f676-7fb0-91a5-8ff96ed15792',
      anchor_trade_code: 'auto',
      anchor_leg_kind: 'single',
      spread_shape: null,
      spread_legs: null,
    });
  });

  it('writes spread_legs as the cron does: JSON.stringify of the legs', () => {
    const legs = describeAnchor(MULTI_ANCHOR, [MULTI_ANCHOR, MULTI_SIBLING]);
    const cols = toColumns(legs);
    expect(legs.spreadLegs).toHaveLength(2);
    expect(cols.spread_legs).toBe(JSON.stringify(legs.spreadLegs));
    expect(cols.spread_shape).toBe('calendar');
    expect(cols.anchor_leg_kind).toBe('multi_leg');
    expect(JSON.parse(cols.spread_legs ?? '')[0]).toMatchObject({
      optionType: 'C',
      strike: 785,
      expiry: '2026-10-28',
      size: 20,
      price: 0.91,
      tradeCode: 'mlet',
    });
  });

  it('keeps a missing trade code as null columns (kind unknown)', () => {
    const cols = toColumns(describeAnchor(print({ tradeCode: null }), []));
    expect(cols.anchor_trade_code).toBeNull();
    expect(cols.anchor_leg_kind).toBeNull();
  });
});

describe('applyDate', () => {
  it('updates both tables with a conditional unnest UPDATE and counts RETURNING', async () => {
    writeDate([
      line('lottery_finder_fires', 11, print()),
      line('lottery_finder_fires', 12, MULTI_ANCHOR, [
        MULTI_ANCHOR,
        MULTI_SIBLING,
      ]),
      line('lottery_finder_fires', 13, null),
      line('silent_boom_alerts', 21, print()),
    ]);
    // lf: one of two already set (RETURNING only id 11); sb: written.
    mockSql
      .mockResolvedValueOnce([{ id: '11' }])
      .mockResolvedValueOnce([{ id: 21 }]);

    const result = await applyDate(DATE, { outDir: dir });

    expect(result).toEqual({
      date: DATE,
      counts: {
        lottery_finder_fires: { updated: 1, skipped: 1, noAnchor: 1 },
        silent_boom_alerts: { updated: 1, skipped: 0, noAnchor: 0 },
      },
      seconds: expect.any(Number),
    });
    expect(formatDateResult(result, DATE, false)).toMatch(
      /^2026-10-27 lf updated=1 skipped=1 no_anchor=1 \| sb updated=1 skipped=0 no_anchor=0 \| secs=\d+\.\d$/,
    );
    expect(mockSql).toHaveBeenCalledTimes(2);
    const first = mockSql.mock.calls[0] as unknown[];
    const text = sqlText(first);
    expect(text).toContain('UPDATE lottery_finder_fires t');
    expect(text).toContain('t.id = v.id');
    expect(text).toContain(
      'AND t.anchor_ws_trade_id IS NULL AND t.anchor_leg_kind IS NULL',
    );
    expect(text).toContain('RETURNING t.id');
    expect(text).toContain('v.legs::jsonb');
    expect(text).toContain('AND t.date = ?::date');
    // The second statement is the silent_boom one, with its own ids and the
    // same guards.
    const second = mockSql.mock.calls[1] as unknown[];
    const secondText = sqlText(second);
    expect(secondText).toContain('UPDATE silent_boom_alerts t');
    expect(secondText).toContain('t.id = v.id');
    expect(secondText).toContain('AND t.date = ?::date');
    expect(secondText).toContain(
      'AND t.anchor_ws_trade_id IS NULL AND t.anchor_leg_kind IS NULL',
    );
    expect(secondText).toContain('RETURNING t.id');
    expect(second[1]).toEqual([21]);
    expect(second[2]).toEqual([print().wsTradeId]);
    expect(second.at(-1)).toBe(DATE);
    expect(first.at(-1)).toBe(DATE);
    // Parameters: ids, ws ids, codes, kinds, shapes, legs (no-anchor row excluded).
    const [, ids, wsIds, codes, kinds, shapes, legs] = first;
    expect(ids).toEqual([11, 12]);
    expect(wsIds).toEqual([print().wsTradeId, MULTI_ANCHOR.wsTradeId]);
    expect(codes).toEqual(['auto', 'mlet']);
    expect(kinds).toEqual(['single', 'multi_leg']);
    expect(shapes).toEqual([null, 'calendar']);
    expect(legs).toEqual([
      null,
      JSON.stringify(
        describeAnchor(MULTI_ANCHOR, [MULTI_ANCHOR, MULTI_SIBLING]).spreadLegs,
      ),
    ]);
    expect(existsSync(markerPath(dir, DATE))).toBe(true);
  });

  it('splits into batches of WRITE_CHUNK rows', async () => {
    expect(WRITE_CHUNK).toBe(500);
    const lines = Array.from({ length: 1201 }, (_, i) =>
      line('silent_boom_alerts', i + 1, print()),
    );
    writeDate(lines);
    mockSql.mockImplementation((_s: unknown, ids: number[]) =>
      Promise.resolve(ids.map((id) => ({ id }))),
    );
    const result = await applyDate(DATE, { outDir: dir });
    const sizes = mockSql.mock.calls.map((c) => (c[1] as number[]).length);
    expect(sizes).toEqual([500, 500, 201]);
    expect(result?.counts.silent_boom_alerts.updated).toBe(1201);
  });

  it('dry-run makes no DB call, writes no marker, and reports the same counts', async () => {
    writeDate([
      line('lottery_finder_fires', 1, print()),
      line('lottery_finder_fires', 2, null),
      line('silent_boom_alerts', 3, print()),
    ]);
    const result = await applyDate(DATE, { outDir: dir, dryRun: true });
    expect(mockSql).not.toHaveBeenCalled();
    expect(existsSync(markerPath(dir, DATE))).toBe(false);
    expect(result?.counts.lottery_finder_fires).toEqual({
      updated: 1,
      skipped: 0,
      noAnchor: 1,
    });
    expect(formatDateResult(result, DATE, true)).toContain('dry-run');
  });

  it('skips a date with a done marker unless forced', async () => {
    writeDate([line('lottery_finder_fires', 1, print())]);
    writeFileSync(markerPath(dir, DATE), 'done\n');
    expect(await applyDate(DATE, { outDir: dir })).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    const forced = await applyDate(DATE, { outDir: dir, force: true });
    expect(forced?.counts.lottery_finder_fires.updated).toBe(1);
  });

  it('a DB reject names the date, table and batch, and writes no marker', async () => {
    const lines = Array.from({ length: 501 }, (_, i) =>
      line('lottery_finder_fires', i + 1, print()),
    );
    writeDate(lines);
    mockSql
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })),
      )
      .mockRejectedValueOnce(new Error('connection lost'));
    await expect(applyDate(DATE, { outDir: dir })).rejects.toThrow(
      'apply failed: date 2026-10-27, table lottery_finder_fires, batch 1: connection lost',
    );
    expect(existsSync(markerPath(dir, DATE))).toBe(false);
  });

  describe('transient DB errors (real withDbRetry, fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a transient failure once and then counts the batch', async () => {
      writeDate([line('silent_boom_alerts', 1, print())]);
      mockSql
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce([{ id: 1 }]);
      const pending = applyDate(DATE, { outDir: dir });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(mockSql).toHaveBeenCalledTimes(2);
      expect(result?.counts.silent_boom_alerts.updated).toBe(1);
      expect(existsSync(markerPath(dir, DATE))).toBe(true);
    });

    it('surfaces a transient error that outlasts the retries, with date, table and batch', async () => {
      writeDate([line('silent_boom_alerts', 1, print())]);
      mockSql.mockRejectedValue(new Error('fetch failed'));
      const pending = applyDate(DATE, { outDir: dir });
      const settled = expect(pending).rejects.toThrow(
        'apply failed: date 2026-10-27, table silent_boom_alerts, batch 0: fetch failed',
      );
      await vi.advanceTimersByTimeAsync(3000);
      await settled;
      expect(mockSql).toHaveBeenCalledTimes(3);
      expect(existsSync(markerPath(dir, DATE))).toBe(false);
    });

    it('does not retry a genuine error', async () => {
      writeDate([line('silent_boom_alerts', 1, print())]);
      mockSql.mockRejectedValue(new Error('column "x" does not exist'));
      await expect(applyDate(DATE, { outDir: dir })).rejects.toThrow(
        /batch 0: column "x" does not exist/,
      );
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  it('a malformed NDJSON line throws before any write', async () => {
    writeFileSync(
      join(dir, `${DATE}.ndjson`),
      '{"table":"silent_boom_alerts"\n',
    );
    await expect(applyDate(DATE, { outDir: dir })).rejects.toThrow(
      /\.ndjson:1: not JSON/,
    );
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('compareToReference', () => {
  const single = describeAnchor(print(), []);
  const multi = describeAnchor(MULTI_ANCHOR, [MULTI_ANCHOR, MULTI_SIBLING]);

  function tape(lines: ExtractLine[]): Map<string, ExtractLine[]> {
    return new Map([[DATE, lines]]);
  }

  it('reports full agreement and passes the gate', () => {
    const report = compareToReference(
      tape([
        line('lottery_finder_fires', 1, print()),
        line('silent_boom_alerts', 2, MULTI_ANCHOR, [
          MULTI_ANCHOR,
          MULTI_SIBLING,
        ]),
      ]),
      { [`${DATE}|lf:1`]: single, [`${DATE}|sb:2`]: multi },
    );
    expect(report.overall).toMatchObject({
      rows: 2,
      both: 2,
      oneSided: 0,
      anchorIdAgree: 2,
      legKindAgree: 2,
      shapeAgree: 2,
      legsAgree: 2,
    });
    expect(report.pass).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(formatCompareReport(report)).toContain('GATE: PASS');
  });

  it('fails the gate on an anchor-id disagreement and samples the mismatch', () => {
    const other = {
      ...single,
      anchorWsTradeId: '01a17d88-ffff-7000-8000-00000000000f',
    };
    const report = compareToReference(
      tape([line('lottery_finder_fires', 1, print())]),
      { [`${DATE}|lf:1`]: other },
    );
    expect(report.overall.anchorIdAgree).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.failures.join(' ')).toContain('anchor-id agreement 0.00%');
    expect(report.mismatchClasses.anchor_id).toBe(1);
    expect(report.mismatches[0]).toMatchObject({
      key: `${DATE}|lf:1`,
      kind: 'anchor_id',
    });
    expect(report.mismatches[0]?.tape).toEqual(single);
    expect(report.mismatches[0]?.reference).toEqual(other);
  });

  it('counts a one-sided anchor against the one-sided ceiling', () => {
    // 1 of 100 rows one-sided = 1% > 0.5%.
    const lines: ExtractLine[] = [];
    const ref: Reference = {};
    for (let i = 1; i <= 99; i += 1) {
      lines.push(line('lottery_finder_fires', i, print()));
      ref[`${DATE}|lf:${i}`] = single;
    }
    lines.push(line('lottery_finder_fires', 100, null));
    ref[`${DATE}|lf:100`] = single;
    const report = compareToReference(tape(lines), ref);
    expect(report.overall.oneSided).toBe(1);
    expect(report.overall.both).toBe(99);
    expect(report.pass).toBe(false);
    expect(report.failures.join(' ')).toContain('one-sided 1.00% > 0.5%');
    expect(report.mismatchClasses.one_sided).toBe(1);
  });

  it('tolerates a one-sided row inside the 0.5% ceiling and counts legKind and shape separately', () => {
    const lines: ExtractLine[] = [];
    const ref: Reference = {};
    for (let i = 1; i <= 400; i += 1) {
      lines.push(line('lottery_finder_fires', i, print()));
      ref[`${DATE}|lf:${i}`] = single;
    }
    // One more row where only the reference found an anchor: 1/401 = 0.25%.
    lines.push(line('lottery_finder_fires', 401, null));
    ref[`${DATE}|lf:401`] = single;
    const report = compareToReference(tape(lines), ref);
    expect(report.pass).toBe(true);
    expect(report.overall.oneSided).toBe(1);

    const legKindOnly = compareToReference(
      tape([line('lottery_finder_fires', 1, print())]),
      { [`${DATE}|lf:1`]: { ...single, legKind: 'multi_leg' } },
    );
    expect(legKindOnly.mismatchClasses.leg_kind).toBe(1);
    expect(legKindOnly.overall.legKindAgree).toBe(0);
  });

  it('treats a row neither side anchored as agreement without a both-count, and fails an empty comparison', () => {
    const report = compareToReference(
      tape([line('lottery_finder_fires', 1, null)]),
      { [`${DATE}|lf:1`]: null },
    );
    expect(report.overall).toMatchObject({ rows: 1, both: 0, oneSided: 0 });
    expect(report.pass).toBe(false);
    expect(report.failures[0]).toContain(
      'no rows where both sides found an anchor',
    );
  });

  it('records lines with no reference key and reference keys with no line', () => {
    const report = compareToReference(
      tape([line('lottery_finder_fires', 1, print())]),
      {
        [`${DATE}|lf:1`]: single,
        [`${DATE}|lf:2`]: single,
        '2026-10-26|lf:9': single,
      },
    );
    expect(report.overall.missingLine).toBe(1);
    expect(report.overall.both).toBe(1);

    const noRef = compareToReference(
      tape([line('lottery_finder_fires', 5, print())]),
      {},
    );
    expect(noRef.overall.missingRef).toBe(1);
  });

  it('flags a spreadLegs difference even when the leg kind and shape agree', () => {
    const tweaked = {
      ...multi,
      spreadLegs:
        multi.spreadLegs?.map((l) => ({ ...l, size: l.size + 1 })) ?? null,
    };
    const report = compareToReference(
      tape([
        line('silent_boom_alerts', 2, MULTI_ANCHOR, [
          MULTI_ANCHOR,
          MULTI_SIBLING,
        ]),
      ]),
      { [`${DATE}|sb:2`]: tweaked },
    );
    expect(report.overall.shapeAgree).toBe(1);
    expect(report.overall.legsAgree).toBe(0);
    expect(report.mismatchClasses.legs).toBe(1);
  });

  it('keeps only the first 50 mismatches but counts them all', () => {
    const lines: ExtractLine[] = [];
    const ref: Reference = {};
    for (let i = 1; i <= 60; i += 1) {
      lines.push(line('lottery_finder_fires', i, print()));
      ref[`${DATE}|lf:${i}`] = { ...single, legKind: 'multi_leg' };
    }
    const report = compareToReference(tape(lines), ref);
    expect(report.mismatches).toHaveLength(50);
    expect(report.mismatchClasses.leg_kind).toBe(60);
  });
});
