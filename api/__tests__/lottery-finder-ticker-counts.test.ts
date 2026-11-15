// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import { expectedQasSql, squashSql } from './lottery-qas-sql';

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn().mockResolvedValue(false),
  setCacheHeaders: vi.fn(),
}));

// A Phase-4 suppression fragment marker. The real keptSuppressionSql returns
// a composable neon fragment; here we model it as a tagged object so the
// outer query's tagged-template can FLATTEN it into raw predicate text +
// (showAll, keptTickers) params — exactly mirroring how @neondatabase splices
// a nested `db`…`` fragment. This keeps every existing SQL-text and param
// assertion in this file valid against the helper-wired query without coupling
// the test to the helper's internals (those are pinned in
// api/__tests__/lottery-suppression.test.ts).
interface SuppressionFragment {
  __suppressionFragment: true;
  showAll: boolean;
  kept: string[];
}
const isSuppressionFragment = (v: unknown): v is SuppressionFragment =>
  typeof v === 'object' && v !== null && '__suppressionFragment' in v;

const { mockKeptSuppressionSql } = vi.hoisted(() => ({
  mockKeptSuppressionSql: vi.fn(
    (
      _db: unknown,
      alias: string,
      showAll: boolean | undefined,
      kept: string[],
    ) =>
      ({
        __suppressionFragment: true as const,
        // Carry the alias only for debugging; the canonical predicate text is
        // emitted by the flattener below so SQL-text assertions match.
        alias,
        showAll: showAll ?? false,
        kept,
      }) as unknown as SuppressionFragment,
  ),
}));

vi.mock('../_lib/lottery-suppression.js', () => ({
  keptSuppressionSql: mockKeptSuppressionSql,
  SYMBOL_ALIAS_WHITELIST: ['f', 'ranked', 'cd'] as const,
}));

// Raw mock query fn — receives the FLATTENED (strings, ...values) so that
// `mock.calls[N][0]` is the full template-strings array (with the suppression
// predicate text inlined) and the values include showAll + keptTickers.
const mockSql = vi.fn();

// Raw-SQL marker produced by `db.unsafe(...)` (mirrors the neon driver's
// UnsafeRawSql). The flattener inlines the marker's text directly into the
// strings array (no bound param) — exactly like neon splices raw SQL — so the
// inlined inversion-bonus CASE text is visible to SQL-text assertions.
interface RawSqlFragment {
  __rawSql: string;
}
const isRawSqlFragment = (v: unknown): v is RawSqlFragment =>
  typeof v === 'object' && v !== null && '__rawSql' in v;

// The `db` handle the handler uses. A tagged-template wrapper that flattens
// any SuppressionFragment + RawSqlFragment in the interpolated values into raw
// predicate / expression text (plus the suppression bound params) before
// delegating to mockSql. Non-fragment template calls pass straight through
// unchanged (so existing tests are unaffected).
function dbTag(strings: TemplateStringsArray, ...values: unknown[]) {
  if (!values.some(isSuppressionFragment) && !values.some(isRawSqlFragment)) {
    return mockSql(strings, ...values);
  }
  const outStrings: string[] = [strings[0]!];
  const outValues: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isSuppressionFragment(v)) {
      // Splice the canonical predicate: text + (showAll, kept) params.
      // `<prefix>(${showAll}::boolean OR s.inversion_quintile IS NULL OR
      //  s.inversion_quintile > 2 OR <alias>.underlying_symbol =
      //  ANY(${kept}::text[]))<suffix>`
      outStrings[outStrings.length - 1] += '(';
      outValues.push(v.showAll);
      outStrings.push(
        '::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2 OR cd.underlying_symbol = ANY(',
      );
      outValues.push(v.kept);
      outStrings.push('::text[]))' + strings[i + 1]!);
    } else if (isRawSqlFragment(v)) {
      // Inline raw text into the surrounding strings (no bound param).
      outStrings[outStrings.length - 1] += v.__rawSql + strings[i + 1]!;
    } else {
      outValues.push(v);
      outStrings.push(strings[i + 1]!);
    }
  }
  return mockSql(outStrings as unknown as TemplateStringsArray, ...outValues);
}
// `db.unsafe(raw)` → raw-SQL marker (mirrors neon's UnsafeRawSql).
(dbTag as unknown as { unsafe: (raw: string) => RawSqlFragment }).unsafe = (
  raw: string,
) => ({ __rawSql: raw });

vi.mock('../_lib/db.js', async () => {
  const actual =
    await vi.importActual<typeof import('../_lib/db.js')>('../_lib/db.js');
  return {
    getDb: vi.fn(() => dbTag),
    withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    TransientDbError: actual.TransientDbError,
  };
});

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { increment: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockReadKeptTickers } = vi.hoisted(() => ({
  mockReadKeptTickers: vi.fn(),
}));

vi.mock('../_lib/kept-tickers.js', () => ({
  readKeptTickers: mockReadKeptTickers,
}));

// The loader reads the weights store through `getDb`, which the db mock above
// routes into `mockSql`: unmocked, it would eat the responses each test queues
// for the chip query. The default, set in beforeEach, is the frozen seed as the
// active version.
const { mockLoadLotteryWeights } = vi.hoisted(() => ({
  mockLoadLotteryWeights: vi.fn(),
}));

vi.mock('../_lib/lottery-weights-loader.js', () => ({
  loadLotteryWeights: mockLoadLotteryWeights,
}));

import { TransientDbError } from '../_lib/db.js';
import handler from '../lottery-finder-ticker-counts.js';
import {
  loadedWeights,
  loadedWithFeedCutoffs,
} from './loaded-lottery-weights.js';

// The seed in the active slot: the loader's answer until a test overrides it.
const SEED_LOADED = loadedWeights();

// A promoted version whose cutoffs differ from the seed's 13 / 10.
const VERSION_16_12 = loadedWithFeedCutoffs('v-16-12', {
  tier1_min_score: 16,
  tier2_min_score: 12,
});

describe('lottery-finder-ticker-counts handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default empty kept-set → pure live suppression (pre-change behavior).
    mockReadKeptTickers.mockResolvedValue([]);
    mockLoadLotteryWeights.mockResolvedValue(SEED_LOADED);
  });

  it('returns chain-deduped counts sorted by count desc', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'TSLA',
        count: 3,
        peak_best_pct: '303.2',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
      {
        ticker: 'NVDA',
        count: 1,
        peak_best_pct: '45.0',
        latest_trigger_time_ct: '2026-05-14T14:30:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      tickers: {
        ticker: string;
        count: number;
        peakBestPct: number | null;
        latestTriggerTimeCt: string;
      }[];
    };
    expect(body.date).toBe('2026-05-14');
    expect(body.tickers).toHaveLength(2);
    expect(body.tickers[0]?.ticker).toBe('TSLA');
    expect(body.tickers[0]?.count).toBe(3);
    expect(body.tickers[0]?.peakBestPct).toBe(303.2);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('returns empty tickers array when no fires match', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { tickers: unknown[] };
    expect(body.tickers).toEqual([]);
  });

  it('echoes filters and forwards mode + minScore', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SMCI',
        count: 2,
        peak_best_pct: '110.0',
        latest_trigger_time_ct: '2026-05-14T15:30:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-05-14',
        mode: 'A_intraday_0DTE',
        minScore: '18',
        reload: 'true',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: {
        mode: string | null;
        minScore: number | null;
        reload: boolean | null;
      };
    };
    expect(body.filters.mode).toBe('A_intraday_0DTE');
    expect(body.filters.minScore).toBe(18);
    expect(body.filters.reload).toBe(true);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('distinguishes reload=false from reload absent', async () => {
    // The zod transform maps 'false' → false (explicit) and missing →
    // undefined. The SQL gate handles them differently: explicit false
    // restricts to `reload_tagged = false`; absent passes the gate. A
    // future schema refactor could collapse one into the other; this
    // test fails loudly if that happens.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAPL',
        count: 1,
        peak_best_pct: '50.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', reload: 'false' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { reload: boolean | null };
    };
    expect(body.filters.reload).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('binds minFireCount to the ranked-CTE filter + echoes it in filters', async () => {
    // Server-side push of the Burst chip — chip counts must stay
    // aligned with the burst-filtered feed, so the ranked CTE filters
    // on fc (window-function fire count) at WHERE rn = 1. Without this
    // binding the chip strip would overstate ticker counts when Burst
    // is active. Pattern mirrors the count subquery in
    // /api/lottery-finder so a chain in the feed and a chain in the
    // strip are the same population.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'TSLA',
        count: 4,
        peak_best_pct: '85.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minFireCount: '8' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { minFireCount: number | null };
    };
    expect(body.filters.minFireCount).toBe(8);

    // SQL uses the ranked-CTE pattern (WITH ranked ... WHERE rn = 1
    // AND fc >= ...) and binds the floor value to the mocked sql call.
    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('WITH ranked');
    expect(sql).toContain('WHERE rn = 1');
    expect(sql).toContain('fc >=');
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(8);
  });

  it('binds minTakeitProb to the ranked-CTE filter + echoes it in filters', async () => {
    // Server-side push of the TAKE-IT chip. Filters on the LATEST
    // fire's takeit_prob per chain so chip counts stay aligned with
    // the feed. Default UI value is 0.70 — the prior client-side
    // filter dropped 40+ of 50 fires per page and made pagination
    // meaningless.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'NVDA',
        count: 2,
        peak_best_pct: '110.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minTakeitProb: '0.7' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { minTakeitProb: number | null };
    };
    expect(body.filters.minTakeitProb).toBe(0.7);

    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    // Gates on the chain-level peak (chain_max_takeit), not the latest
    // fire's takeit_prob, so chip counts match the monotonic feed
    // (spec lottery-no-vanish-2026-05-29.md).
    expect(sql).toContain('chain_max_takeit >=');
    expect(sql).not.toContain('OR takeit_prob >=');
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(0.7);
  });

  it('omits minTakeitProb from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { minTakeitProb: number | null } };
    expect(body.filters.minTakeitProb).toBeNull();
  });

  it('omits minFireCount from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { minFireCount: number | null } };
    expect(body.filters.minFireCount).toBeNull();
  });

  it('binds maxFireCount to the ranked-CTE cap + echoes it in filters', async () => {
    // Inverse of minFireCount — the chip strip must stay aligned with
    // the burst-CAPPED feed, so the ranked CTE filters fc <= cap at
    // WHERE rn = 1. Mirrors the cap subquery in /api/lottery-finder so
    // a chain in the feed and a chain in the strip are the same set.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'TSLA',
        count: 4,
        peak_best_pct: '85.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', maxFireCount: '12' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: { maxFireCount: number | null };
    };
    expect(body.filters.maxFireCount).toBe(12);

    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('WITH ranked');
    expect(sql).toContain('WHERE rn = 1');
    expect(sql).toContain('fc <=');
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(12);
  });

  it('omits maxFireCount from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: { maxFireCount: number | null } };
    expect(body.filters.maxFireCount).toBeNull();
  });

  it('rejects minFireCount below 1 with 400 (Zod min(1))', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minFireCount: '0' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid date', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: 'not-a-date' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('binds MIN_ALERT_ENTRY_PRICE + the Q1/Q2 inversion suppression into the SQL', async () => {
    // Chip totals must mirror /api/lottery-finder so the count and
    // the visible feed agree. Two server-side filters are load-bearing:
    //   1. entry_price >= MIN_ALERT_ENTRY_PRICE (penny-option floor)
    //   2. Phase 3 inversion-quality suppression — LEFT JOIN
    //      lottery_ticker_stats + inversion_quintile > 2 unless showAll
    // This test fails loudly if either is dropped or refactored away.
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAPL',
        count: 1,
        peak_best_pct: '40.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('entry_price >=');
    expect(sql).toContain('LEFT JOIN lottery_ticker_stats');
    expect(sql).toContain('inversion_quintile');
    // showAll default is false; the bind value must reach the SQL call.
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(false);

    const body = res._json as { filters: { showAll: boolean } };
    expect(body.filters.showAll).toBe(false);
  });

  it('FIX D: minScore gates the chip on the DISPLAYED qas (GREATEST(0,score+rt)+inversion CASE), not raw score', async () => {
    // Chip totals must mirror the qas-filtered feed (post-Fix-C). The chip
    // query carries score/rt through ranked → chain_day and gates minScore
    // on the qas expression in the final WHERE (where the lottery_ticker_stats
    // LEFT JOIN exposes inversion_quintile). This test fails loudly if the
    // chip reverts to raw `score >= minScore`, or if its qas drifts from the
    // one the feed and the detector's tier monitor use (lottery-qas-sql.ts).
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'SNDK',
        count: 1,
        peak_best_pct: '50.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', minScore: '13' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Normalize whitespace so the assertion is robust to SQL formatting.
    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray)
      .join('?')
      .replace(/\s+/g, ' ');
    // qas expression spliced into the chip query (cd.* score components +
    // the shared inversion-bonus CASE): the same text the feed computes.
    expect(squashSql(sql)).toContain(expectedQasSql('cd.'));
    expect(sql).toContain(
      'CASE s.inversion_quintile WHEN 1 THEN -5 WHEN 2 THEN -2 WHEN 3 THEN 0 WHEN 4 THEN 3 WHEN 5 THEN 5 ELSE 0 END',
    );
    // The retired fire-count term is gone: the query neither carries the
    // column through its CTEs nor adds it to the qas.
    expect(sql).not.toContain('fire_count_score_adjustment');
    // OLD raw-score predicate is gone.
    expect(sql).not.toContain('OR score >= ?');
    // Floor value still binds.
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(13);
  });

  // ============================================================
  // minTier — the chip floor follows the ACTIVE weights version
  // ============================================================
  //
  // The cutoffs belong to a weights version (`feed_cutoffs`), so `minTier`
  // names a tier and the chip query binds that tier's cutoff from the active
  // version, the way the feed does — the chip strip must count the same chains
  // the `minTier` feed shows. The loader is mocked at its module boundary (see
  // the top of the file). The comparison is the one `minScore` already makes:
  // the displayed qas, not the raw score.
  describe('minTier and the active version feed cutoffs', () => {
    const SNDK_ROW = {
      ticker: 'SNDK',
      count: 1,
      peak_best_pct: '50.0',
      latest_trigger_time_ct: '2026-05-14T15:00:00Z',
    };
    // The values bound into the chip query (the tagged template's `...values`).
    const bound = (): unknown[] =>
      (mockSql.mock.calls[0] as unknown[]).slice(1);
    const timesBound = (value: number): number =>
      bound().filter((v) => v === value).length;

    it.each([
      ['tier1', 16, 13],
      ['tier2', 12, 10],
    ] as const)(
      "minTier=%s binds the active version's cutoff (%i), not the seed's (%i)",
      async (minTier, cutoff, seedCutoff) => {
        mockLoadLotteryWeights.mockResolvedValue(VERSION_16_12);
        mockSql.mockResolvedValueOnce([SNDK_ROW]);

        const res = mockResponse();
        await handler(
          mockRequest({
            method: 'GET',
            query: { date: '2026-05-14', minTier },
          }),
          res,
        );

        expect(res._status).toBe(200);
        // The cutoff binds twice: the IS NULL probe and the comparison.
        expect(timesBound(cutoff)).toBe(2);
        expect(bound()).not.toContain(seedCutoff);
        // It gates on the qas expression, as minScore does (Fix D).
        const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray)
          .join('?')
          .replace(/\s+/g, ' ');
        expect(sql).toContain('COALESCE(cd.score, 0)');
        expect(sql).toContain('COALESCE(cd.round_trip_score_deduct, 0)');
        // The request is echoed, as minScore is.
        const body = res._json as {
          filters: { minTier: string | null; minScore: number | null };
        };
        expect(body.filters.minTier).toBe(minTier);
        expect(body.filters.minScore).toBeNull();
      },
    );

    it('minScore still binds the number it was given, whatever the active cutoffs are', async () => {
      mockLoadLotteryWeights.mockResolvedValue(VERSION_16_12);
      mockSql.mockResolvedValueOnce([SNDK_ROW]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-05-14', minScore: '14' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(timesBound(14)).toBe(2);
      expect(bound()).not.toContain(16);
      expect(bound()).not.toContain(12);
      const body = res._json as {
        filters: { minTier: string | null; minScore: number | null };
      };
      expect(body.filters.minScore).toBe(14);
      expect(body.filters.minTier).toBeNull();
    });

    it('sets no floor when neither minTier nor minScore is sent', async () => {
      mockLoadLotteryWeights.mockResolvedValue(VERSION_16_12);
      mockSql.mockResolvedValueOnce([SNDK_ROW]);

      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { date: '2026-05-14' } }),
        res,
      );

      expect(res._status).toBe(200);
      expect(bound()).not.toContain(16);
      expect(bound()).not.toContain(12);
    });

    it('loads the weights alongside the kept-set read, and showAll still skips the kept-set', async () => {
      mockLoadLotteryWeights.mockResolvedValue(VERSION_16_12);
      mockSql.mockResolvedValueOnce([]);

      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-05-14', minTier: 'tier1', showAll: 'true' },
        }),
        res,
      );

      expect(res._status).toBe(200);
      expect(mockLoadLotteryWeights).toHaveBeenCalledTimes(1);
      expect(mockReadKeptTickers).not.toHaveBeenCalled();
      expect(timesBound(16)).toBe(2);
    });

    it('rejects minTier together with minScore as a 400 before the weights load or any query runs', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({
          method: 'GET',
          query: { date: '2026-05-14', minTier: 'tier1', minScore: '13' },
        }),
        res,
      );

      expect(res._status).toBe(400);
      expect(res._json).toMatchObject({
        error: 'Invalid query',
        details: [
          {
            path: ['minTier'],
            message: 'minTier and minScore are exclusive',
          },
        ],
      });
      expect(mockLoadLotteryWeights).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
    });

    it('rejects an unknown minTier as a 400', async () => {
      const res = mockResponse();
      await handler(
        mockRequest({ method: 'GET', query: { minTier: 'tier3' } }),
        res,
      );

      expect(res._status).toBe(400);
      expect(mockLoadLotteryWeights).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
    });
  });

  it('passes showAll=true through to the SQL bind and the filter echo', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', showAll: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect((mockSql.mock.calls[0] as unknown[]).slice(1)).toContain(true);
    const body = res._json as { filters: { showAll: boolean } };
    expect(body.filters.showAll).toBe(true);
  });

  it('handles peak_best_pct = null without throwing', async () => {
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'XYZ',
        count: 1,
        peak_best_pct: null,
        latest_trigger_time_ct: '2026-05-14T13:30:00Z',
      },
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      tickers: { peakBestPct: number | null }[];
    };
    expect(body.tickers[0]?.peakBestPct).toBeNull();
  });

  // ============================================================
  // MONOTONIC Q1/Q2 SUPPRESSION (fix/feed-never-vanish)
  // ============================================================
  //
  // The chip strip must mirror the feed: a ticker ever shown today
  // (quintile > 2 at some point) stays counted after a quintile flip into
  // Q1/Q2. The endpoint reads the per-day kept-set and adds an ANY() keep
  // term to the suppression predicate. It is READ-ONLY here — the feed
  // endpoint owns accumulation.
  it('reads the kept-set and binds the monotonic keep term into the suppression SQL', async () => {
    mockReadKeptTickers.mockResolvedValueOnce(['AAA']);
    mockSql.mockResolvedValueOnce([
      {
        ticker: 'AAA',
        count: 1,
        peak_best_pct: '40.0',
        latest_trigger_time_ct: '2026-05-14T15:00:00Z',
      },
    ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // kept-set read for the request date.
    expect(mockReadKeptTickers).toHaveBeenCalledWith('2026-05-14');

    const sql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(' ');
    // NON-VACUOUS: the monotonic keep is exactly this ANY(...) term.
    expect(sql).toContain('= ANY(');
    expect(sql).toContain('::text[]');
    // The kept-set array reached the SQL params.
    const params = (mockSql.mock.calls[0] as unknown[]).slice(1);
    expect(
      params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === 'AAA'),
    ).toBe(true);
  });

  it('showAll=true short-circuits the kept-set (never read)', async () => {
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-14', showAll: 'true' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockReadKeptTickers).not.toHaveBeenCalled();
  });

  it('KV-down (readKeptTickers returns []) → empty keep array, no crash', async () => {
    mockReadKeptTickers.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const params = (mockSql.mock.calls[0] as unknown[]).slice(1);
    expect(params.some((p) => Array.isArray(p) && p.length === 0)).toBe(true);
  });

  it('soft-degrades to 503 + Retry-After on a transient DB blip', async () => {
    mockReadKeptTickers.mockResolvedValueOnce([]);
    mockSql.mockRejectedValueOnce(
      new TransientDbError(new Error('db attempt timeout')),
    );

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-14' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    expect(res._json).toEqual({
      error: 'temporarily unavailable',
      transient: true,
    });
  });
});
