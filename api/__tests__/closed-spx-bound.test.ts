// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetClosedAnchors, mockSql } = vi.hoisted(() => ({
  mockGetClosedAnchors: vi.fn<(table: string) => Promise<unknown>>(),
  mockSql: vi.fn(),
}));

// The anchors reader is the one gexbot-queries name the module imports; its
// SQL is tested in gexbot-queries.test.ts and gexbot-anchors-pglite.test.ts.
vi.mock('../_lib/gexbot-queries.js', () => ({
  getClosedAnchors: mockGetClosedAnchors,
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The ET midnight is the real conversion; it is a `vi.fn` wrapper only so a
// test can make it return null once.
vi.mock('../../src/utils/timezone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/timezone.js')>();
  return {
    ...actual,
    etWallClockToUtcIso: vi.fn(actual.etWallClockToUtcIso),
  };
});

import {
  getClosedSpxBound,
  readPanelRowInBound,
} from '../_lib/closed-spx-bound.js';
import logger from '../_lib/logger.js';
import { etWallClockToUtcIso } from '../../src/utils/timezone.js';

/** The closed-market session of 2026-11-20 (a Friday, EST). */
const SESSION = '2026-11-20';
const SESSION_MIDNIGHT = '2026-11-20T05:00:00.000Z';
const SPX_ANCHOR = '2026-11-20T21:00:49.000Z';
const NDX_ANCHOR = '2026-11-20T21:00:50.000Z';

function anchorsFor(
  byTicker: Array<[string, string]>,
  sessionDate = SESSION,
): { sessionDate: string; byTicker: ReadonlyMap<string, string> } {
  return { sessionDate, byTicker: new Map(byTicker) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getClosedSpxBound', () => {
  it("bounds a read to the session: ET midnight up to the SPX anchor, on the anchors' session date", async () => {
    mockGetClosedAnchors.mockResolvedValue(anchorsFor([['SPX', SPX_ANCHOR]]));

    const plan = await getClosedSpxBound('periscope-map');

    expect(plan).toEqual({
      kind: 'read',
      date: SESSION,
      bound: { lower: SESSION_MIDNIGHT, upper: SPX_ANCHOR },
    });
    // The anchors come from the raw capture table, once.
    expect(mockGetClosedAnchors).toHaveBeenCalledExactlyOnceWith(
      'gexbot_api_capture',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    // [label, session date, ET midnight as an instant]
    ['an EST session (UTC-5)', '2026-11-20', '2026-11-20T05:00:00.000Z'],
    ['an EDT session (UTC-4)', '2026-06-12', '2026-06-12T04:00:00.000Z'],
    [
      'the Monday after the fall-back change (EST again)',
      '2026-11-02',
      '2026-11-02T05:00:00.000Z',
    ],
    [
      'the Monday after the spring-forward change (EDT again)',
      '2026-03-09',
      '2026-03-09T04:00:00.000Z',
    ],
  ])(
    'takes the lower bound from the session date: %s',
    async (_label, date, midnight) => {
      mockGetClosedAnchors.mockResolvedValue(
        anchorsFor([['SPX', SPX_ANCHOR]], date),
      );
      const plan = await getClosedSpxBound('periscope-map');
      expect(plan).toMatchObject({
        kind: 'read',
        date,
        bound: { lower: midnight, upper: SPX_ANCHOR },
      });
    },
  );

  it("takes SPX's anchor, not another ticker's", async () => {
    mockGetClosedAnchors.mockResolvedValue(
      anchorsFor([
        ['NDX', NDX_ANCHOR],
        ['SPX', SPX_ANCHOR],
      ]),
    );
    const plan = await getClosedSpxBound('periscope-map');
    expect(plan).toMatchObject({
      kind: 'read',
      bound: { upper: SPX_ANCHOR },
    });
  });

  describe('with no SPX anchor there is no slot to read, and it is logged', () => {
    it.each([['periscope-map'], ['gex-landscape']])(
      'an empty table, for %s: no session date',
      async (endpoint) => {
        mockGetClosedAnchors.mockResolvedValue(null);

        const plan = await getClosedSpxBound(endpoint);

        expect(plan).toEqual({ kind: 'no_slot', date: null });
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          { ticker: 'SPX', sessionDate: null },
          `${endpoint}: no SPX anchor for the closed market — returning no_slot`,
        );
      },
    );

    it('a table with no anchored ticker: the session date is still known', async () => {
      mockGetClosedAnchors.mockResolvedValue(anchorsFor([]));

      const plan = await getClosedSpxBound('periscope-map');

      expect(plan).toEqual({ kind: 'no_slot', date: SESSION });
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { ticker: 'SPX', sessionDate: SESSION },
        'periscope-map: no SPX anchor for the closed market — returning no_slot',
      );
    });

    it("another ticker's anchor is not SPX's", async () => {
      mockGetClosedAnchors.mockResolvedValue(anchorsFor([['NDX', NDX_ANCHOR]]));

      const plan = await getClosedSpxBound('periscope-map');

      expect(plan).toEqual({ kind: 'no_slot', date: SESSION });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures surface by name', () => {
    it('a rejected anchors read reaches the caller unchanged', async () => {
      const error = new Error('anchors read failed');
      mockGetClosedAnchors.mockRejectedValue(error);

      await expect(getClosedSpxBound('periscope-map')).rejects.toBe(error);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('throws, naming the endpoint and the session, when the session has no ET midnight', async () => {
      // Cannot happen for a date `to_char` produced; if it ever does, the
      // caller must fail the request, not read without a lower bound.
      mockGetClosedAnchors.mockResolvedValue(anchorsFor([['SPX', SPX_ANCHOR]]));
      vi.mocked(etWallClockToUtcIso).mockReturnValueOnce(null);

      await expect(getClosedSpxBound('periscope-map')).rejects.toThrow(
        `periscope-map: no ET midnight for session date ${SESSION}`,
      );
    });
  });
});

describe('readPanelRowInBound', () => {
  const BOUND = { lower: SESSION_MIDNIGHT, upper: SPX_ANCHOR };
  const ROW = { captured_at: new Date(SPX_ANCHOR), raw_response: { a: 1 } };

  function sqlText(): string {
    return (mockSql.mock.calls[0]![0] as readonly string[]).join('?');
  }

  it.each([
    ['gamma', 'gamma_zero'],
    ['charm', 'charm_zero'],
    ['vanna', 'vanna_zero'],
  ] as const)(
    "reads SPX's %s row between ET midnight and the anchor",
    async (panel, category) => {
      mockSql.mockResolvedValue([ROW]);

      const row = await readPanelRowInBound(panel, BOUND);

      expect(row).toBe(ROW);
      expect(mockSql).toHaveBeenCalledTimes(1);
      expect(mockSql.mock.calls[0]!.slice(1)).toEqual([
        'SPX',
        category,
        SESSION_MIDNIGHT,
        SPX_ANCHOR,
      ]);
      expect(sqlText()).toContain('captured_at >= ?');
      expect(sqlText()).toContain('ORDER BY captured_at DESC');
      expect(sqlText()).toContain('LIMIT 1');
    },
  );

  it("ends the read after the upper bound's whole millisecond", async () => {
    // `captured_at` is `now()` and keeps microseconds; the bound travels as a
    // millisecond ISO string. A plain `<= upper` would drop the very row an
    // anchor names (gex-landscape-pglite.test.ts proves it on real SQL).
    mockSql.mockResolvedValue([]);
    await readPanelRowInBound('gamma', BOUND);
    expect(sqlText()).toContain(
      "captured_at < ?::timestamptz + INTERVAL '1 millisecond'",
    );
  });

  it('returns undefined when no row qualifies', async () => {
    mockSql.mockResolvedValue([]);
    await expect(readPanelRowInBound('gamma', BOUND)).resolves.toBeUndefined();
  });

  it('a rejected read reaches the caller unchanged', async () => {
    const error = new Error('panel read failed');
    mockSql.mockRejectedValue(error);
    await expect(readPanelRowInBound('gamma', BOUND)).rejects.toBe(error);
  });
});
