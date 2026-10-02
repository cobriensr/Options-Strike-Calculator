// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery, mockCaptureMessage } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureMessage: mockCaptureMessage },
}));

vi.mock('../_lib/db.js', () => ({
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  READ_CHUNK_SIZE,
  aggregatesById,
  chunkByChain,
  classifyAggregate,
  enrichOutcomeWindows,
  outcomePassStatus,
  prepareWindows,
  readContinuityGaps,
  readOutcomeAggregates,
  realizedFromAggregate,
  sessionTapeBounds,
  windowHitsGap,
  type OutcomeAggregateRow,
  type OutcomeWindow,
} from '../_lib/option-outcome-aggregate.js';

/** A healthy aggregate row as the Neon driver returns it (strings for int8). */
function row(o: Partial<OutcomeAggregateRow> = {}): OutcomeAggregateRow {
  return {
    window_id: '7',
    tape_live: true,
    ticks: 12,
    peak_px: 2,
    peak_minutes: 14.5,
    last_px: 1.2,
    h30_px: 1.5,
    h60_px: 1.4,
    h120_px: 1.3,
    tier1_px: 1.6,
    trail_exit_px: 1.4,
    ...o,
  };
}

describe('sessionTapeBounds', () => {
  it('bounds a regular EDT session: open, close, 10 min tail, close + 15 min', () => {
    expect(sessionTapeBounds('2026-10-01')).toEqual({
      openAt: new Date('2026-10-01T13:30:00.000Z'),
      closeAt: new Date('2026-10-01T20:00:00.000Z'),
      tailStart: new Date('2026-10-01T19:50:00.000Z'),
      tapeEnd: new Date('2026-10-01T20:15:00.000Z'),
      settledAt: new Date('2026-10-01T20:20:00.000Z'),
    });
  });

  it('shifts with DST (EST close is 21:00 UTC)', () => {
    expect(sessionTapeBounds('2026-12-01')).toMatchObject({
      openAt: new Date('2026-12-01T14:30:00.000Z'),
      tapeEnd: new Date('2026-12-01T21:15:00.000Z'),
    });
  });

  it('uses the 13:00 ET close on early-close days', () => {
    expect(sessionTapeBounds('2026-11-27')).toEqual({
      openAt: new Date('2026-11-27T14:30:00.000Z'),
      closeAt: new Date('2026-11-27T18:00:00.000Z'),
      tailStart: new Date('2026-11-27T17:50:00.000Z'),
      tapeEnd: new Date('2026-11-27T18:15:00.000Z'),
      settledAt: new Date('2026-11-27T18:20:00.000Z'),
    });
  });

  it('returns null for an unparseable date', () => {
    expect(sessionTapeBounds('not-a-date')).toBeNull();
  });
});

describe('chunkByChain', () => {
  const w = (id: number, chain: string, date = '2026-10-01') => ({
    id,
    chain,
    date,
  });
  /** `n` windows on one chain. */
  const group = (chain: string, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => w(from + i, chain));
  const sizes = (chunks: Array<Array<{ chain: string }>>) =>
    chunks.map((c) => c.map((x) => x.chain).join(''));

  it('keeps each chain group whole and in first-seen (newest-first) order', () => {
    const half = READ_CHUNK_SIZE / 2;
    // A and B (half each) fill one chunk; C (half + 1) does not fit next to them.
    const input = [
      ...group('A', half, 0),
      ...group('B', half, 1000),
      ...group('C', half + 1, 2000),
    ];
    expect(sizes(chunkByChain(input))).toEqual([
      'A'.repeat(half) + 'B'.repeat(half),
      'C'.repeat(half + 1),
    ]);
  });

  it('groups interleaved fires of one chain into the same chunk', () => {
    const input = [w(1, 'A'), w(2, 'B'), w(3, 'A')];
    expect(chunkByChain(input).map((c) => c.map((x) => x.id))).toEqual([
      [1, 3, 2],
    ]);
  });

  it('separates the same chain on different dates (different tape windows)', () => {
    const input = [...group('A', READ_CHUNK_SIZE), w(9999, 'A', '2026-09-30')];
    expect(chunkByChain(input).map((c) => c.length)).toEqual([
      READ_CHUNK_SIZE,
      1,
    ]);
  });

  it('splits a group larger than READ_CHUNK_SIZE and returns [] for no windows', () => {
    expect(
      chunkByChain(group('A', READ_CHUNK_SIZE * 2 + 1)).map((c) => c.length),
    ).toEqual([READ_CHUNK_SIZE, READ_CHUNK_SIZE, 1]);
    expect(chunkByChain([])).toEqual([]);
  });
});

describe('classifyAggregate', () => {
  it('prices a healthy row, accepting driver strings', () => {
    const v = classifyAggregate(
      row({ ticks: '12', peak_px: '2.0000', last_px: '1.2' }),
    );
    expect(v).toEqual({
      kind: 'priced',
      agg: {
        ticks: 12,
        peakPx: 2,
        peakMinutes: 14.5,
        lastPx: 1.2,
        h30Px: 1.5,
        h60Px: 1.4,
        h120Px: 1.3,
        tier1Px: 1.6,
        trailExitPx: 1.4,
      },
    });
  });

  it('keeps optional prices NULL (no tier fill, no trail exit, no horizon print)', () => {
    const v = classifyAggregate(
      row({ h30_px: null, tier1_px: null, trail_exit_px: null }),
    );
    expect(v.kind).toBe('priced');
    if (v.kind === 'priced') {
      expect(v.agg.h30Px).toBeNull();
      expect(v.agg.tier1Px).toBeNull();
      expect(v.agg.trailExitPx).toBeNull();
    }
  });

  it('reports a quiet ticker tail as tapeGap even when the contract printed', () => {
    // Feed died before the close: the prints it has are a truncated tape.
    expect(classifyAggregate(row({ tape_live: false }))).toEqual({
      kind: 'tapeGap',
    });
  });

  it('reports a live ticker with zero contract prints as noPrints', () => {
    expect(
      classifyAggregate(
        row({
          ticks: 0,
          peak_px: null,
          peak_minutes: null,
          last_px: null,
          h30_px: null,
          h60_px: null,
          h120_px: null,
          tier1_px: null,
          trail_exit_px: null,
        }),
      ),
    ).toEqual({ kind: 'noPrints' });
  });

  it.each<[string, OutcomeAggregateRow | undefined]>([
    ['a missing row', undefined],
    ['a NULL tape_live', row({ tape_live: null })],
    ['a NaN tick count', row({ ticks: 'abc' })],
    ['a NULL tick count', row({ ticks: null })],
    ['a fractional tick count', row({ ticks: 1.5 })],
    ['a NULL last print despite ticks', row({ last_px: null })],
    ['a NULL peak despite ticks', row({ peak_px: null })],
    ['an unparseable price', row({ tier1_px: 'n/a' })],
    ['a zero price', row({ h60_px: 0 })],
    ['a negative price', row({ trail_exit_px: -1 })],
    ['a NULL peak minute', row({ peak_minutes: null })],
    ['a negative peak minute', row({ peak_minutes: -1 })],
    ['a selected print above the peak', row({ last_px: 2.5 })],
  ])('rejects %s as unreadable (never locked)', (_label, r) => {
    expect(classifyAggregate(r)).toEqual({ kind: 'unreadable' });
  });
});

describe('realizedFromAggregate', () => {
  it('mirrors the JS exit policies on the selected prints', () => {
    const v = classifyAggregate(row());
    if (v.kind !== 'priced') throw new Error('expected priced');
    const out = realizedFromAggregate(v.agg, 1);
    expect(out.peakPct).toBeCloseTo(100, 9);
    expect(out.minutesToPeak).toBe(14.5);
    expect(out.eodPct).toBeCloseTo(20, 9);
    expect(out.trail30_10Pct).toBeCloseTo(40, 9);
    expect(out.hard30mPct).toBeCloseTo(50, 9);
    expect(out.tier50Pct).toBeCloseTo((60 + 20) / 2, 9);
    expect(out.r30Pct).toBeCloseTo(50, 9);
    expect(out.r60Pct).toBeCloseTo(40, 9);
    expect(out.r120Pct).toBeCloseTo(30, 9);
  });

  it('falls back like the JS policies when nothing was selected', () => {
    const v = classifyAggregate(
      row({
        h30_px: null,
        h60_px: null,
        h120_px: null,
        tier1_px: null,
        trail_exit_px: null,
      }),
    );
    if (v.kind !== 'priced') throw new Error('expected priced');
    const out = realizedFromAggregate(v.agg, 1);
    expect(out.trail30_10Pct).toBe(out.eodPct); // never exited → last print
    expect(out.tier50Pct).toBe(out.eodPct); // tier 1 never filled
    expect(out.hard30mPct).toBe(0); // realizedHardStop30m's no-print value
    expect(out.r30Pct).toBeNull();
  });
});

describe('aggregatesById / readOutcomeAggregates', () => {
  it('keys rows by numeric id whatever JS type the driver gives int8', () => {
    const byId = aggregatesById([
      row({ window_id: '42' }),
      row({ window_id: 7 }),
    ]);
    expect([...byId.keys()]).toEqual([42, 7]);
  });

  it('runs one parameterized statement per chunk and propagates a DB reject', async () => {
    const win: OutcomeWindow = {
      id: 9,
      chain: 'AAA261002C00100000',
      ticker: 'AAA',
      date: '2026-10-01',
      entry: new Date('2026-10-01T14:00:00Z'),
      entryPx: 1.25,
      tailStart: new Date('2026-10-01T19:50:00Z'),
      tapeEnd: new Date('2026-10-01T20:15:00Z'),
    };
    const sql = { query: mockQuery } as unknown as Parameters<
      typeof readOutcomeAggregates
    >[0];

    mockQuery.mockResolvedValueOnce([row({ window_id: '9' })]);
    await expect(readOutcomeAggregates(sql, [win])).resolves.toHaveLength(1);
    const [text, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(text).toContain('$1::bigint[]');
    expect(text).toContain('t.executed_at <= u.tape_end');
    expect(params).toEqual([
      [9],
      ['AAA261002C00100000'],
      ['AAA'],
      ['2026-10-01T14:00:00.000Z'],
      [1.25],
      ['2026-10-01T20:15:00.000Z'],
      ['2026-10-01T19:50:00.000Z'],
    ]);

    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(readOutcomeAggregates(sql, [win])).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('prepareWindows', () => {
  const settledAt = Date.parse('2026-10-01T20:20:00Z');
  const cand = (o: Record<string, unknown> = {}) => ({
    id: '11',
    chain: 'AAA261002C00100000',
    ticker: 'AAA',
    date: '2026-10-01',
    entry: '2026-10-01T14:00:00Z',
    entryPx: '1.25',
    ...o,
  });

  it('turns a settled candidate into a window with numeric id, entry and bounds', () => {
    const out = prepareWindows([cand()], settledAt);
    expect(out).toMatchObject({ skipped: 0, inFlight: 0 });
    expect(out.windows).toEqual([
      {
        id: 11,
        chain: 'AAA261002C00100000',
        ticker: 'AAA',
        date: '2026-10-01',
        entry: new Date('2026-10-01T14:00:00Z'),
        entryPx: 1.25,
        tailStart: new Date('2026-10-01T19:50:00Z'),
        tapeEnd: new Date('2026-10-01T20:15:00Z'),
      },
    ]);
  });

  it('holds a candidate whose session has not settled (in flight)', () => {
    const out = prepareWindows([cand()], settledAt - 1);
    expect(out).toEqual({ windows: [], skipped: 0, inFlight: 1 });
  });

  it.each([
    ['a NULL entry price', { entryPx: null }],
    ['a zero entry price', { entryPx: 0 }],
    ['an unparseable entry price', { entryPx: 'n/a' }],
    ['an unparseable entry time', { entry: 'not-a-time' }],
    ['an unparseable date', { date: 'bad' }],
    ['an entry after the tape end', { entry: '2026-10-01T21:00:00Z' }],
  ])('skips %s', (_label, o) => {
    expect(prepareWindows([cand(o)], settledAt)).toEqual({
      windows: [],
      skipped: 1,
      inFlight: 0,
    });
  });
});

describe('outcomePassStatus', () => {
  const pass = (o: Record<string, number[]> = {}) => ({
    locked: 1,
    alreadyLocked: 0,
    deferred: 0,
    tapeGapIds: [],
    noPrintsIds: [],
    unreadableIds: [],
    ...o,
  });

  it('pages on a feed gap, degrades on missing/unreadable rows, else succeeds', () => {
    expect(outcomePassStatus(pass())).toBe('success');
    expect(outcomePassStatus(pass({ noPrintsIds: [1] }))).toBe('partial');
    expect(outcomePassStatus(pass({ unreadableIds: [1] }))).toBe('partial');
    expect(outcomePassStatus(pass({ tapeGapIds: [1], noPrintsIds: [2] }))).toBe(
      'error',
    );
  });
});

/** A settled 2026-10-01 window (EDT session 13:30Z-20:00Z). */
function win(id: number, o: Partial<OutcomeWindow> = {}): OutcomeWindow {
  return {
    id,
    chain: 'AAA261002C00100000',
    ticker: 'AAA',
    date: '2026-10-01',
    entry: new Date('2026-10-01T15:00:00Z'),
    entryPx: 1,
    tailStart: new Date('2026-10-01T19:50:00Z'),
    tapeEnd: new Date('2026-10-01T20:15:00Z'),
    ...o,
  };
}

const sqlWith = (query: typeof mockQuery) =>
  ({ query }) as unknown as Parameters<typeof readContinuityGaps>[0];

describe('readContinuityGaps / windowHitsGap', () => {
  beforeEach(() => mockQuery.mockReset());

  it('probes each (ticker, date) session once over [open, close)', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await readContinuityGaps(sqlWith(mockQuery), [
      win(1),
      win(2),
      win(3, { ticker: 'BBB', date: '2026-09-30' }),
    ]);

    const [text, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(text).toContain('generate_series');
    expect(text).toContain('NOT EXISTS');
    expect(params).toEqual([
      ['AAA', 'BBB'],
      ['2026-10-01', '2026-09-30'],
      ['2026-10-01T13:30:00.000Z', '2026-09-30T13:30:00.000Z'],
      ['2026-10-01T20:00:00.000Z', '2026-09-30T20:00:00.000Z'],
    ]);
  });

  it('runs no query for no windows', async () => {
    await expect(readContinuityGaps(sqlWith(mockQuery), [])).resolves.toEqual(
      new Map(),
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('flags a window only when an empty bucket ends after its entry', async () => {
    mockQuery.mockResolvedValueOnce([
      { ticker: 'AAA', date: '2026-10-01', gap_start: '2026-10-01T14:00:00Z' },
      {
        ticker: 'AAA',
        date: '2026-10-01',
        gap_start: new Date('2026-10-01T17:00:00Z'),
      },
    ]);
    const gaps = await readContinuityGaps(sqlWith(mockQuery), [win(1)]);

    // 17:00Z gap is after a 15:00Z entry: truncated path.
    expect(windowHitsGap(win(1), gaps)).toBe(true);
    // Entry after both gaps: its window is intact.
    expect(
      windowHitsGap(win(2, { entry: new Date('2026-10-01T17:05:00Z') }), gaps),
    ).toBe(false);
    // Entry inside the last 5-min bucket of the gap still overlaps it.
    expect(
      windowHitsGap(win(3, { entry: new Date('2026-10-01T17:04:00Z') }), gaps),
    ).toBe(true);
    // Another ticker is unaffected.
    expect(windowHitsGap(win(4, { ticker: 'ZZZ' }), gaps)).toBe(false);
  });

  it('throws on a malformed continuity row and propagates a DB reject', async () => {
    mockQuery.mockResolvedValueOnce([
      { ticker: 'AAA', date: '2026-10-01', gap_start: 'garbage' },
    ]);
    await expect(
      readContinuityGaps(sqlWith(mockQuery), [win(1)]),
    ).rejects.toThrow(/malformed continuity row/);

    mockQuery.mockRejectedValueOnce(new Error('neon: connection reset'));
    await expect(
      readContinuityGaps(sqlWith(mockQuery), [win(1)]),
    ).rejects.toThrow('connection reset');
  });
});

describe('enrichOutcomeWindows', () => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const opts = (lock: (u: number[]) => Promise<number>) => ({
    job: 'test-job',
    recovery: 'scripts/recover.py',
    logger: logger as never,
    deadlineMs: Date.now() + 60_000,
    toUpdate: (w: OutcomeWindow) => w.id,
    lock,
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockCaptureMessage.mockReset();
  });

  /** Route the two statements by text. */
  function routeQuery(
    gapRows: unknown[],
    aggRows: (ids: number[]) => unknown[],
  ) {
    mockQuery.mockImplementation(async (text: string, params: unknown[]) =>
      text.includes('generate_series')
        ? gapRows
        : aggRows(params[0] as number[]),
    );
  }

  it('marks a window hit by a feed gap as tapeGap without reading it', async () => {
    routeQuery(
      [
        {
          ticker: 'BBB',
          date: '2026-10-01',
          gap_start: '2026-10-01T16:00:00Z',
        },
      ],
      (ids) => ids.map((id) => row({ window_id: String(id) })),
    );
    const lock = vi.fn(async (u: number[]) => u.length);

    const r = await enrichOutcomeWindows(
      sqlWith(mockQuery),
      [win(1), win(2, { ticker: 'BBB', chain: 'BBB261002C00010000' })],
      opts(lock),
    );

    expect(r).toMatchObject({ locked: 1, tapeGapIds: [2] });
    const aggCall = mockQuery.mock.calls.find(
      (c) => !(c[0] as string).includes('generate_series'),
    )!;
    expect((aggCall[1] as unknown[][])[0]).toEqual([1]);
    expect(lock).toHaveBeenCalledWith([1]);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 row(s) whose ticker tape has a gap'),
      expect.objectContaining({ fingerprint: ['test-job', 'missing-tape'] }),
    );
  });

  it('reports unreadable aggregates to Sentry and never locks them', async () => {
    routeQuery([], () => []); // no row back for the window
    const lock = vi.fn(async (u: number[]) => u.length);

    const r = await enrichOutcomeWindows(
      sqlWith(mockQuery),
      [win(1)],
      opts(lock),
    );

    expect(r.unreadableIds).toEqual([1]);
    expect(lock).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('1 unreadable aggregate row(s)'),
      expect.objectContaining({
        fingerprint: ['test-job', 'unreadable-aggregate'],
      }),
    );
  });

  it('propagates a failed lock after reporting what it classified', async () => {
    routeQuery([], (ids) =>
      ids.map((id) => row({ window_id: String(id), tape_live: id !== 2 })),
    );

    await expect(
      enrichOutcomeWindows(
        sqlWith(mockQuery),
        [win(1), win(2)],
        opts(() => Promise.reject(new Error('neon: write timeout'))),
      ),
    ).rejects.toThrow('write timeout');
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        extra: expect.objectContaining({ tapeGapIds: [2] }),
      }),
    );
  });
});
