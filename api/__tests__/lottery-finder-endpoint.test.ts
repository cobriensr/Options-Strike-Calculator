// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

// A Phase-3 suppression fragment marker. The real keptSuppressionSql returns
// a composable neon fragment; here we model it as a tagged object so the
// outer query's tagged-template can FLATTEN it into raw predicate text +
// (showAll, keptTickers) params — exactly mirroring how @neondatabase splices
// a nested `db`…`` fragment. This keeps every existing SQL-text and param
// assertion in this file valid against the helper-wired query without coupling
// the endpoint test to the helper's internals (those are pinned in
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

// The `db` handle the handler uses. A tagged-template wrapper that flattens
// any SuppressionFragment in the interpolated values into raw predicate text
// + its two params before delegating to mockSql. Non-fragment template calls
// pass straight through unchanged (so existing tests are unaffected).
function dbTag(strings: TemplateStringsArray, ...values: unknown[]) {
  if (!values.some(isSuppressionFragment)) {
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
        '::boolean OR s.inversion_quintile IS NULL OR s.inversion_quintile > 2 OR underlying_symbol = ANY(',
      );
      outValues.push(v.kept);
      outStrings.push('::text[]))' + strings[i + 1]!);
    } else {
      outValues.push(v);
      outStrings.push(strings[i + 1]!);
    }
  }
  return mockSql(outStrings as unknown as TemplateStringsArray, ...outValues);
}

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => dbTag),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  // Real classifier — matches `timeout`, `fetch failed`, etc. The
  // degradeOnTimeout tests below depend on this returning true for
  // the synthetic 'db attempt timeout' error.
  isRetryableDbError: (err: unknown): boolean =>
    err instanceof Error &&
    /timeout|fetch failed|connection|ECONNRESET|terminated|socket/i.test(
      err.message,
    ),
}));

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: mockCaptureMessage,
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGuard } = vi.hoisted(() => ({ mockGuard: vi.fn() }));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: vi.fn(),
}));

const { mockReadLastGood, mockWriteLastGood } = vi.hoisted(() => ({
  mockReadLastGood: vi.fn(),
  mockWriteLastGood: vi.fn(),
}));

vi.mock('../_lib/last-good-cache.js', () => ({
  readLastGood: mockReadLastGood,
  writeLastGood: mockWriteLastGood,
}));

const { mockReadKeptTickers, mockAddKeptTickers } = vi.hoisted(() => ({
  mockReadKeptTickers: vi.fn(),
  mockAddKeptTickers: vi.fn(),
}));

vi.mock('../_lib/kept-tickers.js', () => ({
  readKeptTickers: mockReadKeptTickers,
  addKeptTickers: mockAddKeptTickers,
}));

import handler, { degradeOnTimeout } from '../lottery-finder.js';

const ROW = {
  id: 42,
  date: '2026-05-01',
  trigger_time_ct: '2026-05-01T19:00:00Z',
  entry_time_ct: '2026-05-01T19:01:00Z',
  option_chain_id: 'SNDK260501C01175000',
  underlying_symbol: 'SNDK',
  option_type: 'C',
  strike: '1175',
  expiry: '2026-05-01',
  dte: 0,
  trigger_vol_to_oi_window: '0.06',
  trigger_vol_to_oi_cum: '0.12',
  trigger_iv: '0.4',
  trigger_delta: '0.2',
  trigger_ask_pct: '0.7',
  trigger_window_size: '250',
  trigger_window_prints: 8,
  entry_price: '0.55',
  open_interest: 1000,
  spot_at_first: '1170',
  alert_seq: 2,
  minutes_since_prev_fire: '320',
  flow_quad: 'call_ask',
  tod: 'PM',
  mode: 'A_intraday_0DTE',
  reload_tagged: true,
  cheap_call_pm_tagged: true,
  burst_ratio_vs_prev: '2.5',
  entry_drop_pct_vs_prev: '-40',
  mkt_tide_ncp: '12.5',
  mkt_tide_npp: '8.2',
  mkt_tide_diff: '4.3',
  mkt_tide_otm_diff: null,
  spx_flow_diff: null,
  spy_etf_diff: null,
  qqq_etf_diff: null,
  zero_dte_diff: null,
  spx_spot_gamma_oi: null,
  spx_spot_gamma_vol: null,
  spx_spot_charm_oi: null,
  spx_spot_vanna_oi: null,
  gex_strike_call_minus_put: null,
  gex_strike_call_ask_minus_bid: null,
  gex_strike_put_ask_minus_bid: null,
  gex_strike_actual_strike: null,
  realized_trail30_10_pct: null,
  realized_hard30m_pct: null,
  realized_tier50_holdeod_pct: null,
  realized_eod_pct: null,
  peak_ceiling_pct: null,
  minutes_to_peak: null,
  inserted_at: '2026-05-01T19:01:05Z',
  enriched_at: null,
  // Score column (migration #126) — SNDK 0DTE call at $0.55 PM is
  // ticker(10) + mode(5) + price(3, ≤$1.00) + tod(0, PM) + opt(2) = 20
  // → Tier 1 (≥18). Ticker stats reflect a "reliable" SNDK row.
  score: 20,
  direction_gated: false,
  range_pos_at_trigger: null,
  // Round-trip score deduct (migration #154 / Phase 2C). Null until the
  // evaluate-round-trip cron has run for the alert; deduct defaults to 0.
  round_trip_net_pct: null,
  round_trip_score_deduct: 0,
  ticker_n_fires: 8147,
  ticker_high_peak_rate: 67.4,
  ticker_ci_lower: 66.4,
  ticker_ci_upper: 68.4,
  ticker_ci_width: 2.0,
  ticker_tier: 'reliable',
  // Phase 3 inversion-quality fields (refit columns on
  // lottery_ticker_stats, populated by Phase 2A's nightly job).
  // Default ROW gets quintile 5 (top performer, +5 bonus) so the
  // baseline `score: 20` keeps qualityAdjustedScore at 25 → tier1
  // under the V2 cutoffs.
  ticker_inversion_blend: '0.42',
  ticker_inversion_quintile: 5,
  ticker_inversion_n_21d: 18,
  ticker_inversion_n_90d: 64,
  // realized_flow_inversion_pct (4th exit policy) — null when not yet
  // enriched, mirroring the other realized_* columns above.
  realized_flow_inversion_pct: null,
  // fire_count comes from the chain-day dedup CTE's window function.
  // 5 lands in the neutral fire_count_score_adjustment bucket (4-7
  // fires → 0 adjustment), so existing tests that pin a specific
  // score outcome stay correct under the burst-count adjustment.
  // Tests exercising single-fire (-3) or 8+ (+1/+2) adjustments
  // override both columns locally.
  fire_count: 5,
  // Post-#167 the adjustment is a stored DB column — explicit 0 here
  // documents the neutral bucket and matches what the trigger would
  // populate for a 4-7 fire chain-day.
  fire_count_score_adjustment: 0,
  first_fire_time_ct: '2026-05-01T18:55:00Z',
  // Chain-level peak TAKE-IT + its timestamp (spec
  // lottery-no-vanish-2026-05-29.md). The chain is gated on
  // chain_max_takeit so a chain that ever cleared the floor never
  // disappears intraday. Here the latest rep fire's takeit_prob is null
  // but the chain peaked at 0.78 at 18:58 — the row stays visible.
  chain_max_takeit: '0.78',
  peak_takeit_at: '2026-05-01T18:58:00Z',
  // Ticker net flow snapshot at trigger_time_ct (LATERAL on
  // ws_net_flow_per_ticker + history). Used by Flow Match / Flow
  // Inverted badges. Null is the cold-start default.
  fire_time_cum_ncp: '4250.50',
  fire_time_cum_npp: '-1800.75',
};

describe('lottery-finder endpoint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGuard.mockResolvedValue(false); // proceed past auth gate
    mockSql.mockResolvedValue([]);
    // Default: empty kept-set (KV up but nothing shown yet) → pure live
    // suppression, exactly as before the monotonic-keep change.
    mockReadKeptTickers.mockResolvedValue([]);
    mockAddKeptTickers.mockResolvedValue(undefined);
  });

  it('returns transformed fires with default date (ET-today) and asOf=null', async () => {
    // Two SQL calls: rows query then COUNT(*) total query.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      date: string;
      asOf: string | null;
      filters: Record<string, unknown>;
      count: number;
      total: number;
      limit: number;
      fires: Array<Record<string, unknown>>;
    };
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50); // page size default
    expect(body.asOf).toBeNull();
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.fires[0]).toMatchObject({
      id: 42,
      underlyingSymbol: 'SNDK',
      strike: 1175,
      score: 20,
      scoreTier: 'tier1',
      forecastHighPeakPct: '30-50%',
      // SNDK tier1 has a per-ticker override at 340 (vs tier1 default of 219).
      avgHoldMinutes: 340,
      // Neutral 4-7 bucket per the 2026-05-17 burst-count adjustment.
      fireCount: 5,
      tickerStats: {
        nFires: 8147,
        highPeakRate: 67.4,
        ciLower: 66.4,
        ciUpper: 68.4,
        ciWidth: 2.0,
        tier: 'reliable',
      },
      tags: {
        flowQuad: 'call_ask',
        tod: 'PM',
        mode: 'A_intraday_0DTE',
        reload: true,
        cheapCallPm: true,
        burstRatioVsPrev: 2.5,
        entryDropPctVsPrev: -40,
      },
      entry: {
        price: 0.55,
        openInterest: 1000,
        alertSeq: 2,
      },
    });
    // Ticker net flow snapshot at fire time — LATERAL on
    // ws_net_flow_per_ticker + history. Verified separately because the
    // shape lives under .macro alongside the SPY-wide mktTide fields.
    expect(body.fires[0]!.macro).toMatchObject({
      tickerCumNcpAtFire: 4250.5,
      tickerCumNppAtFire: -1800.75,
    });
  });

  it('surfaces chain peak TAKE-IT (chain_max_takeit / peak_takeit_at) so a chain stays visible on its peak, not its latest fire', async () => {
    // Regression guard for the "alerts disappear intraday" bug
    // (spec lottery-no-vanish-2026-05-29.md). The rep ROW's own
    // takeit_prob is null, but the chain peaked at 0.78 — the mapper
    // must emit that peak so the UI can keep the chain visible + badge it.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<Record<string, unknown>>;
    };
    expect(body.fires[0]).toMatchObject({
      peakTakeitProb: 0.78,
      peakTakeitAt: '2026-05-01T18:58:00Z',
    });
  });

  it('gates chains on chain_max_takeit (monotonic), never the latest rep fire', async () => {
    // The whole bug was the TAKE-IT floor being applied to the LATEST
    // fire (rn=1). Once a chain re-fired below 0.70 it vanished even
    // though earlier fires cleared the floor. The fix gates on the
    // chain-level MAX, which only grows → a chain that ever qualified
    // can never disappear. Assert the generated SQL reflects that and
    // never reverts to per-representative gating.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: { minTakeitProb: '0.7' } });
    const res = mockResponse();
    await handler(req, res);

    const allSql = mockSql.mock.calls
      .map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join('?') : ''))
      .join('\n');
    // Both the rows query and the COUNT(*) total query must gate on the
    // chain-level peak, not the rep row's scalar.
    expect(allSql).toContain('f.chain_max_takeit >=');
    expect(allSql).toContain('chain_max_takeit >=');
    // The old, non-monotonic gates must be gone.
    expect(allSql).not.toContain('f.takeit_prob >=');
    expect(allSql).not.toContain('OR takeit_prob >=');
  });

  // ============================================================
  // MONOTONIC-VISIBILITY INVARIANT (lottery-no-vanish-2026-05-29)
  // ============================================================
  //
  // The vanish bug: each chain collapses to one representative row = the
  // LATEST fire (rn=1), and the TAKE-IT floor was tested on THAT row's
  // takeit_prob. Since the representative changes every re-fire, a chain
  // blinked in/out as its newest fire crossed the floor. The fix gates on
  // chain_max_takeit (MAX over the chain), which only grows → a chain
  // that ever cleared the floor can never disappear.
  //
  // The mock can't enforce a WHERE, so this locks the invariant at the
  // SQL-shape level for EVERY sort branch independently — each is its own
  // query that could regress on its own. If any branch ever reverts to
  // per-representative gating, this fails.
  describe('monotonic visibility invariant', () => {
    it.each(['chronological', 'score', 'peak'] as const)(
      'sort=%s gates the rows query on chain-max TAKE-IT, never the latest fire',
      async (sort) => {
        mockSql
          .mockResolvedValueOnce([ROW])
          .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]);

        const req = mockRequest({
          method: 'GET',
          query: { sort, minTakeitProb: '0.7' },
        });
        const res = mockResponse();
        await handler(req, res);

        // calls[0] is the rows query for the selected sort branch.
        const rowsSql = (
          mockSql.mock.calls[0]![0] as TemplateStringsArray
        ).join('?');
        // The chain-level MAX window must be present and the gate must
        // reference it — not the representative row's scalar.
        expect(rowsSql).toContain('MAX(f.takeit_prob) OVER');
        expect(rowsSql).toContain('f.chain_max_takeit >=');
        expect(rowsSql).not.toContain('f.takeit_prob >=');
      },
    );

    it('the COUNT(*) total query also gates on chain-max (so total matches reachable rows)', async () => {
      mockSql
        .mockResolvedValueOnce([ROW])
        .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]);

      const req = mockRequest({
        method: 'GET',
        query: { minTakeitProb: '0.7' },
      });
      const res = mockResponse();
      await handler(req, res);

      // calls[1] is the COUNT(*) total query.
      const countSql = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join(
        '?',
      );
      expect(countSql).toContain('MAX(takeit_prob) OVER');
      expect(countSql).toContain('chain_max_takeit >=');
      expect(countSql).not.toContain('OR takeit_prob >=');
    });
  });

  it('falls through to null tickerCumNcp/Npp at fire when LATERAL has no rows', async () => {
    // Older fires + tickers not yet in the WS subscription list will
    // produce nulls from the LATERAL aggregate. Mapper must coerce
    // cleanly to null (not NaN).
    const ROW_NO_FLOW = {
      ...ROW,
      fire_time_cum_ncp: null,
      fire_time_cum_npp: null,
    };
    mockSql
      .mockResolvedValueOnce([ROW_NO_FLOW])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<{ macro: Record<string, unknown> }>;
    };
    expect(body.fires[0]!.macro).toMatchObject({
      tickerCumNcpAtFire: null,
      tickerCumNppAtFire: null,
    });
  });

  it('exposes chain-day fire_count + first_fire_time_ct as fireCount + firstFireTimeCt', async () => {
    // Real-world: TSLA 392.5C fires 315 times across the session; the
    // chain-day CTE (PARTITION BY ticker × strike × type × expiry)
    // collapses to one rep row. fire_count = 315 is the burst size,
    // first_fire_time_ct = 09:35 the burst start, trigger_time_ct =
    // 15:30 the latest fire (also the rep's macro/score basis).
    const ROW_COLLAPSED = {
      ...ROW,
      fire_count: 315,
      first_fire_time_ct: '2026-05-01T14:35:00Z',
      trigger_time_ct: '2026-05-01T20:30:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_COLLAPSED])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<{
        fireCount: number;
        firstFireTimeCt: string;
        triggerTimeCt: string;
      }>;
    };
    expect(body.fires[0]!.fireCount).toBe(315);
    expect(body.fires[0]!.firstFireTimeCt).toBe('2026-05-01T14:35:00Z');
    expect(body.fires[0]!.triggerTimeCt).toBe('2026-05-01T20:30:00Z');
  });

  it('reports tickerStats=null when ticker_n_fires is missing (no JOIN match)', async () => {
    const ROW_NO_STATS = {
      ...ROW,
      ticker_n_fires: null,
      ticker_high_peak_rate: null,
      ticker_ci_lower: null,
      ticker_ci_upper: null,
      ticker_ci_width: null,
      ticker_tier: null,
    };
    mockSql
      .mockResolvedValueOnce([ROW_NO_STATS])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<{ tickerStats: unknown }> };
    expect(body.fires[0]!.tickerStats).toBeNull();
  });

  it('honors sort=score and echoes it in filters', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', sort: 'score' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.sort).toBe('score');
  });

  it('honors sort=peak and echoes it in filters', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', sort: 'peak' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.sort).toBe('peak');
  });

  it('honors minScore=18 — High Conviction filter binds the floor on both queries', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minScore: '18' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.minScore).toBe(18);
    // Both the rows query and the COUNT query must include the 18
    // threshold so the page total stays accurate when the filter is
    // on. Each tagged-template call is `(strings, ...values)`, so the
    // 18 lives among the bound values.
    const rowsCall = mockSql.mock.calls[0] as unknown[];
    const countCall = mockSql.mock.calls[1] as unknown[];
    expect(rowsCall.slice(1)).toContain(18);
    expect(countCall.slice(1)).toContain(18);
  });

  it('honors minPremium=100000 — $-floor gates rows + COUNT queries + echoes in filters', async () => {
    // Mirrors the SilentBoom minPremium chip: server-side filter on
    // entry_price * trigger_window_size * 100 (lottery's analog of
    // SB's entry_price * spike_volume * 100). Must bind on BOTH the
    // rows query AND the COUNT query so pagination stays accurate
    // when the filter is on, and the SQL template must reference the
    // correct columns.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minPremium: '100000' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.minPremium).toBe(100000);

    // Rows + COUNT both bind the floor.
    const rowsCall = mockSql.mock.calls[0] as unknown[];
    const countCall = mockSql.mock.calls[1] as unknown[];
    expect(rowsCall.slice(1)).toContain(100000);
    expect(countCall.slice(1)).toContain(100000);

    // SQL text references the correct columns (entry_price *
    // trigger_window_size * 100), not the SilentBoom spike_volume
    // shape. Both queries should have the filter inline.
    const rowsSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      ' ',
    );
    const countSql = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(rowsSql).toContain('entry_price * f.trigger_window_size * 100');
    expect(countSql).toContain('entry_price * trigger_window_size * 100');
  });

  it('honors minFireCount=8 — burst floor gates rows + COUNT queries + echoes in filters', async () => {
    // Server-side push of the Burst chip. Previously the floor was
    // applied client-side AFTER the page slice arrived, which left
    // pagination inflated and empty pages when most chains had
    // fire_count < floor. Server-side filter must bind on BOTH the
    // rows query (outer WHERE f.rn = 1 AND f.fire_count >= floor) AND
    // the COUNT query (outer WHERE fc >= floor on a ranked CTE) so
    // pagination reflects the post-filter total. The count's shape
    // mirrors the rows shape so a chain qualifying for the displayed
    // feed always shows in the count.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minFireCount: '8' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.minFireCount).toBe(8);

    // Rows + COUNT both bind the floor.
    const rowsCall = mockSql.mock.calls[0] as unknown[];
    const countCall = mockSql.mock.calls[1] as unknown[];
    expect(rowsCall.slice(1)).toContain(8);
    expect(countCall.slice(1)).toContain(8);

    // Rows SQL filters fire_count via the outer WHERE (post-CTE).
    // Count SQL uses the ranked-CTE pattern with WHERE rn = 1 + fc
    // filter, mirroring the rows path so a chain in the feed is the
    // same chain counted toward total.
    const rowsSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      ' ',
    );
    const countSql = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(rowsSql).toContain('f.fire_count >=');
    expect(countSql).toContain('WITH ranked');
    expect(countSql).toContain('WHERE rn = 1');
    expect(countSql).toContain('fc >=');
  });

  it('omits minFireCount from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.minFireCount).toBeNull();
  });

  it('rejects minFireCount below 1 with 400 (Zod min(1))', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minFireCount: '0' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('omits minPremium from filters echo when not provided', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { filters: Record<string, unknown> };
    // Filters echo defaults to null when the query omitted the param.
    expect(body.filters.minPremium).toBeNull();
  });

  it('rejects negative minPremium with 400 (Zod min(0))', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minPremium: '-1' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects non-numeric minPremium with 400 (Zod coerce.number)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', minPremium: 'abc' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('does NOT apply quality floors to the reignited query — Hot Right Now is floor-blind', async () => {
    // Reversed by design (spec hot-right-now-floorblind-2026-05-29.md):
    // the "Hot Right Now" reignited payload is FLOOR-BLIND — it ignores
    // the quality floors (TAKE-IT / score / premium / Q1-Q2 quintile) so
    // it surfaces the day's most re-ignited chains by cadence even when
    // the model scored them below the floor (the case that hid SNDK
    // 1670C +1974%). It still respects structural scoping
    // (ticker/type/mode/tod). This pins that the quality GATES are absent
    // from the reignited query while remaining on the main feed.
    mockSql
      .mockResolvedValueOnce([ROW]) // rows
      .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]) // COUNT
      .mockResolvedValue([]); // chainExtras, mega-cluster, reignited, …

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-05-01',
        minPremium: '100000',
        minTakeitProb: '0.7',
        minScore: '12',
      },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);

    const reignitedCalls = mockSql.mock.calls.filter((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      return strings ? strings.join(' ').includes('top_reignited') : false;
    });
    expect(reignitedCalls.length).toBeGreaterThan(0);
    for (const call of reignitedCalls) {
      const sql = (call[0] as TemplateStringsArray).join('?');
      // No quality GATES (columns may still be SELECTed for display).
      expect(sql).not.toContain('chain_max_takeit >=');
      expect(sql).not.toContain('inversion_quintile > 2');
      expect(sql).not.toContain('f.score >=');
      expect(sql).not.toContain('trigger_window_size * 100 >=');
      // And the quality-floor VALUES are not bound to this query.
      const values = (call as unknown[]).slice(1);
      expect(values).not.toContain(100000); // minPremium
      expect(values).not.toContain(0.7); // minTakeitProb
    }

    // Sanity: the MAIN rows query DOES still gate on chain-max (the
    // no-vanish guard must remain intact for the main feed).
    const mainSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      '?',
    );
    expect(mainSql).toContain('f.chain_max_takeit >=');
  });

  it('rows query reads cum_ncp/cum_npp from the snapshot column on the row', async () => {
    // Pin the post-LATERAL shape: migration #158 added cum_ncp_at_fire +
    // cum_npp_at_fire columns populated at detect time by
    // api/_lib/ticker-flow-snapshot.ts; the feed now reads them directly
    // and aliases them as fire_time_cum_ncp / fire_time_cum_npp. Spec:
    // docs/superpowers/specs/lottery-silentboom-feed-perf-2026-05-17.md.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const sqlText = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
      ' ',
    );
    expect(sqlText).toContain('f.cum_ncp_at_fire AS fire_time_cum_ncp');
    expect(sqlText).toContain('f.cum_npp_at_fire AS fire_time_cum_npp');
    // No LATERAL — the per-row sub-aggregation was what made page loads ~30s.
    expect(sqlText).not.toContain('LEFT JOIN LATERAL');
    expect(sqlText).not.toContain('ws_net_flow_per_ticker');
    expect(sqlText).not.toContain('net_flow_per_ticker_history');
  });

  it('rejects sort outside the {chronological|score|peak} enum', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { sort: 'random' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('handles DATE column returned as a Date object (neon serverless default)', async () => {
    // Production regression: neon-serverless returns DATE columns as
    // Date objects, not strings. The endpoint was calling
    // `r.date.slice(0, 10)` which threw "r.date.slice is not a
    // function" on every prod request. toIso() at the boundary fixes
    // it; this test pins the behavior so a future "type says string,
    // why am I calling toIso?" cleanup doesn't regress.
    const ROW_WITH_DATE_OBJ = {
      ...ROW,
      date: new Date('2026-05-01T00:00:00.000Z'),
    };
    mockSql
      .mockResolvedValueOnce([ROW_WITH_DATE_OBJ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { fires: Array<{ date: string }> };
    expect(body.fires[0]!.date).toBe('2026-05-01');
  });

  it('honors explicit date param + at scrubber cutoff', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-04-21', at: '2026-04-21T18:30:00.000Z' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { date: string; asOf: string | null };
    expect(body.date).toBe('2026-04-21');
    expect(body.asOf).toBe('2026-04-21T18:30:00.000Z');
  });

  it('rejects malformed date (not YYYY-MM-DD)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { date: '04/21/2026' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects malformed at (not ISO datetime with offset)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { at: '14:30 PM' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('coerces numeric DB strings to numbers and nullable fields to null', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<Record<string, unknown>> };
    const fire = body.fires[0]!;
    expect(typeof fire.strike).toBe('number');
    expect((fire as { trigger: { askPct: unknown } }).trigger.askPct).toBe(0.7);
    // Nullable column → null after coercion (not NaN, not undefined)
    expect(
      (fire as { macro: { spxFlowDiff: unknown } }).macro.spxFlowDiff,
    ).toBeNull();
    expect(
      (fire as { outcomes: { realizedHard30mPct: unknown } }).outcomes
        .realizedHard30mPct,
    ).toBeNull();
  });

  it('rejects malformed ticker query (not 1-8 uppercase letters)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { ticker: 'sndk' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('rejects malformed mode (not in enum)', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { mode: 'C_overnight' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._json).toMatchObject({ error: 'invalid query' });
  });

  it('caps limit at 200', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { limit: '5000' },
    });
    const res = mockResponse();
    await handler(req, res);

    // Schema rejects > 200; the handler returns 400.
    expect(res._status).toBe(400);
  });

  it('paginates via offset + reports hasMore when more pages exist', async () => {
    // Page 2 (offset=50, limit=50) of a 1247-fire day.
    const ROWS = Array.from({ length: 50 }, (_, i) => ({ ...ROW, id: i + 51 }));
    mockSql
      .mockResolvedValueOnce(ROWS)
      .mockResolvedValueOnce([{ total: 1247 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', offset: '50', limit: '50' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      count: number;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    expect(body.count).toBe(50);
    expect(body.total).toBe(1247);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(50);
    expect(body.hasMore).toBe(true); // 50 + 50 < 1247
  });

  it('hasMore=false on the last page', async () => {
    const ROWS = Array.from({ length: 47 }, (_, i) => ({
      ...ROW,
      id: i + 1200,
    }));
    mockSql
      .mockResolvedValueOnce(ROWS)
      .mockResolvedValueOnce([{ total: 1247 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', offset: '1200', limit: '50' },
    });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { hasMore: boolean };
    expect(body.hasMore).toBe(false); // 1200 + 47 == 1247
  });

  it('honors minute param as a 1-minute point-in-time bucket', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: {
        date: '2026-05-01',
        minute: '2026-05-01T14:35:00.000Z',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { minute: string | null };
    expect(body.minute).toBe('2026-05-01T14:35:00.000Z');
  });

  it('filters by optionType (calls only)', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', optionType: 'C' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.optionType).toBe('C');
  });

  it('filters by tod bucket', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    const req = mockRequest({
      method: 'GET',
      query: { date: '2026-05-01', tod: 'PM' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { filters: Record<string, unknown> };
    expect(body.filters.tod).toBe('PM');
  });

  it('rejects invalid optionType', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { optionType: 'X' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects invalid tod', async () => {
    const req = mockRequest({
      method: 'GET',
      query: { tod: 'CLOSE' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(400);
  });

  it('reflects filter params back in the response envelope', async () => {
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0 }]);

    const req = mockRequest({
      method: 'GET',
      query: {
        ticker: 'SNDK',
        reload: 'true',
        cheapCallPm: 'true',
        mode: 'A_intraday_0DTE',
      },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      filters: Record<string, unknown>;
      count: number;
    };
    expect(body.filters).toMatchObject({
      ticker: 'SNDK',
      reload: true,
      cheapCallPm: true,
      mode: 'A_intraday_0DTE',
    });
    expect(body.count).toBe(0);
  });

  it('honors the guard short-circuit (returns immediately if guard returns true)', async () => {
    mockGuard.mockResolvedValueOnce(true); // guard already responded
    const req = mockRequest({ method: 'GET', query: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('applies round-trip score deduct and re-derives tier (-3 demotes tier2 → tier3)', async () => {
    // V2 tiers (recalibrated 2026-06-03): tier1 ≥ 13, tier2 ≥ 10, else tier3.
    // Default ROW fixture has inversion_quintile=5 (+5 bonus).
    // score=7 + deduct=-3 = 4 → qas = 4 + 5 = 9 → tier3 (was tier2 at qas=12).
    mockSql
      .mockResolvedValueOnce([
        {
          ...ROW,
          score: 7,
          round_trip_net_pct: '-0.65',
          round_trip_score_deduct: -3,
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      fires: {
        score: number | null;
        rawScore: number | null;
        roundTripNetPct: number | null;
        roundTripScoreDeduct: number;
        scoreTier: string;
      }[];
    };
    expect(body.fires[0]).toMatchObject({
      score: 4,
      rawScore: 7,
      roundTripNetPct: -0.65,
      roundTripScoreDeduct: -3,
      scoreTier: 'tier3',
    });
  });

  it('demotes tier1 → tier2 when -3 deduct lands score on the V2 tier2 cutoff', async () => {
    // V2 tiers: tier1 ≥ 13, tier2 ≥ 10. Default ROW Q5 (+5 bonus).
    // score=8 + deduct=-3 = 5 → qas = 5 + 5 = 10 → tier2 (at cutoff;
    // pre-deduct qas = 8 + 5 = 13 = tier1).
    mockSql
      .mockResolvedValueOnce([
        {
          ...ROW,
          score: 8,
          round_trip_net_pct: '-0.55',
          round_trip_score_deduct: -3,
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      fires: {
        score: number | null;
        scoreTier: string;
        qualityAdjustedScore: number;
        inversionQuintile: number | null;
      }[];
    };
    expect(body.fires[0]).toMatchObject({
      score: 5,
      qualityAdjustedScore: 10,
      inversionQuintile: 5,
      scoreTier: 'tier2',
    });
  });

  it('passes through deduct=0 / round_trip_net_pct=null when cron has not evaluated yet', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      fires: {
        score: number | null;
        rawScore: number | null;
        roundTripScoreDeduct: number;
        roundTripNetPct: number | null;
      }[];
    };
    expect(body.fires[0]).toMatchObject({
      score: 20,
      rawScore: 20,
      roundTripScoreDeduct: 0,
      roundTripNetPct: null,
    });
  });

  it('floors negative effective score at 0', async () => {
    // score=1 + deduct=-3 → −2 → floored to 0. Then qas = 0 + 5 (Q5)
    // = 5 → tier3 under V2 cutoffs (< 10). The Math.max(0, ...) floor
    // is on the displayed `score` field, not on `qualityAdjustedScore`.
    mockSql
      .mockResolvedValueOnce([
        {
          ...ROW,
          score: 1,
          round_trip_net_pct: '-0.80',
          round_trip_score_deduct: -3,
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      fires: {
        score: number | null;
        rawScore: number | null;
        scoreTier: string;
      }[];
    };
    expect(body.fires[0]).toMatchObject({
      score: 0,
      rawScore: 1,
      scoreTier: 'tier3',
    });
  });

  it('binds MIN_ALERT_ENTRY_PRICE (0.10) into both rows + count SQL templates', async () => {
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    // The rows CTE + count subquery + chainExtras + mega-cluster
    // query + reignited-rows query all bind 0.1 as the entry-price
    // floor parameter. Neon's tagged-template invocation packs
    // interpolated values as call args after the strings array. The
    // mega-cluster query (added 2026-05-17) raised the count from
    // 3 → 4; the dedicated reignited-rows query (added with this fix
    // so the pinned section survives pagination) raised it to 5.
    const callsWithFloor = mockSql.mock.calls.filter((args) =>
      args.slice(1).some((v) => v === 0.1),
    );
    expect(callsWithFloor.length).toBe(5);
  });

  // ============================================================
  // Phase 1 of lottery-reignition-ui-2026-05-17 — historicalFires
  // + reignited fields surfaced from the chainExtras parallel query.
  // ============================================================

  it('attaches historicalFires (past fires only) + reignited=true for a chain in the daily top-N', async () => {
    // Latest fire is the row rep; chainExtras returns the full chain
    // history including the latest. The handler slices off the last
    // element so historicalFires carries past fires only — the chart
    // already renders the latest as the purple marker.
    const ROW_MULTI = {
      ...ROW,
      fire_count: 4,
      first_fire_time_ct: '2026-05-01T14:00:00Z',
      trigger_time_ct: '2026-05-01T19:30:00Z',
    };
    const CHAIN_EXTRA = {
      underlying_symbol: 'SNDK',
      strike: '1175',
      option_type: 'C',
      expiry: '2026-05-01',
      fires_json: [
        {
          triggerTimeCt: '2026-05-01T14:00:00Z',
          entryPrice: '0.40',
          spotAtTrigger: '1170.25',
        },
        {
          triggerTimeCt: '2026-05-01T14:10:00Z',
          entryPrice: '0.42',
          spotAtTrigger: '1170.50',
        },
        {
          triggerTimeCt: '2026-05-01T19:00:00Z',
          entryPrice: '0.55',
          spotAtTrigger: '1171.10',
        },
        {
          triggerTimeCt: '2026-05-01T19:30:00Z',
          entryPrice: '0.55',
          spotAtTrigger: '1171.40',
        },
      ],
      reignited: true,
    };
    mockSql
      .mockResolvedValueOnce([ROW_MULTI])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([CHAIN_EXTRA]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<{
        reignited: boolean;
        historicalFires?: Array<{
          triggerTimeCt: string;
          entryPrice: number;
          spotAtTrigger: number | null;
        }>;
      }>;
    };
    expect(body.fires[0]!.reignited).toBe(true);
    expect(body.fires[0]!.historicalFires).toEqual([
      {
        triggerTimeCt: '2026-05-01T14:00:00Z',
        entryPrice: 0.4,
        spotAtTrigger: 1170.25,
      },
      {
        triggerTimeCt: '2026-05-01T14:10:00Z',
        entryPrice: 0.42,
        spotAtTrigger: 1170.5,
      },
      {
        triggerTimeCt: '2026-05-01T19:00:00Z',
        entryPrice: 0.55,
        spotAtTrigger: 1171.1,
      },
    ]);
  });

  it('omits historicalFires entirely for a single-fire chain + sets reignited=false', async () => {
    // Single-fire chain — chainExtras query filters on fire_count > 1,
    // so this chain has no entry in the result set. Handler should
    // emit `reignited: false` (the additive default) and skip the
    // `historicalFires` key entirely to keep the response compact.
    const ROW_SINGLE = { ...ROW, fire_count: 1 };
    mockSql
      .mockResolvedValueOnce([ROW_SINGLE])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([]); // empty chainExtras

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: Array<{ reignited: boolean; historicalFires?: unknown }>;
    };
    expect(body.fires[0]!.reignited).toBe(false);
    expect(body.fires[0]!.historicalFires).toBeUndefined();
  });

  it('sets reignited=false for a multi-fire chain that did not make the daily top-N', async () => {
    // Chain has multiple fires + history populated, but its reignition
    // rank fell outside REIGNITION_TOP_N_PER_DAY — the SQL emits
    // reignited=false. Handler must preserve the flag verbatim.
    const ROW_MULTI = { ...ROW, fire_count: 3 };
    const CHAIN_EXTRA_NOT_TOP_N = {
      underlying_symbol: 'SNDK',
      strike: '1175',
      option_type: 'C',
      expiry: '2026-05-01',
      fires_json: [
        { triggerTimeCt: '2026-05-01T14:00:00Z', entryPrice: '0.40' },
        { triggerTimeCt: '2026-05-01T19:00:00Z', entryPrice: '0.55' },
      ],
      reignited: false,
    };
    mockSql
      .mockResolvedValueOnce([ROW_MULTI])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([CHAIN_EXTRA_NOT_TOP_N]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        reignited: boolean;
        historicalFires?: Array<unknown>;
      }>;
    };
    expect(body.fires[0]!.reignited).toBe(false);
    // Fixture omits spotAtTrigger on each fires_json item — verifies the
    // NULL-tolerant pass-through path for rows inserted before migration #176.
    expect(body.fires[0]!.historicalFires).toEqual([
      {
        triggerTimeCt: '2026-05-01T14:00:00Z',
        entryPrice: 0.4,
        spotAtTrigger: null,
      },
    ]);
  });

  it('surfaces reignitedFires from the dedicated parallel query, independent of pagination', async () => {
    // Bug fix for the "Hot Right Now" section: the pinned reignited
    // rows must ride alongside the page slice — when a reignited chain
    // sorts into page 2, the box still has to render on page 1. Tests
    // the 6th parallel query (reignitedRows) by feeding a payload
    // through it while the main rows + chainExtras stay empty. Mock
    // order: rows, total, chainExtras, clusterByMinute, sbChains,
    // reignitedRows.
    const REIGNITED_ROW = {
      ...ROW,
      id: 999,
      underlying_symbol: 'SNDK',
      strike: '1410',
      trigger_time_ct: '2026-05-15T15:38:00Z',
      fire_count: 15,
    };
    mockSql
      .mockResolvedValueOnce([]) // rows (page slice, empty)
      .mockResolvedValueOnce([{ total: 0 }]) // total
      .mockResolvedValueOnce([]) // chainExtras
      .mockResolvedValueOnce([]) // clusterByMinute
      .mockResolvedValueOnce([]) // sbChains
      .mockResolvedValueOnce([REIGNITED_ROW]); // reignitedRows

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-15' } });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as {
      fires: unknown[];
      reignitedFires: Array<{
        id: number;
        underlyingSymbol: string;
        strike: number;
      }>;
    };
    expect(body.fires).toEqual([]);
    expect(body.reignitedFires).toHaveLength(1);
    expect(body.reignitedFires[0]).toMatchObject({
      id: 999,
      underlyingSymbol: 'SNDK',
      strike: 1410,
    });
  });

  it('defaults reignitedFires to [] when the parallel query returns no rows', async () => {
    // Empty reignited result must still serialise as [] in the
    // response, never undefined — the client hook coalesces but the
    // contract is explicit on the server.
    mockSql.mockResolvedValueOnce([ROW]).mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { reignitedFires: unknown[] };
    expect(body.reignitedFires).toEqual([]);
  });

  it('chainExtras SQL binds the REIGNITION threshold constants (3, 30, 2, 5)', async () => {
    // Pin the locked thresholds into the SQL contract. The handler
    // must pass REIGNITION_MIN_FIRES, REIGNITION_MIN_GAP_MIN,
    // REIGNITION_MIN_POST_GAP_FIRES, and REIGNITION_TOP_N_PER_DAY as
    // parameters into the chainExtras tagged template; changing any
    // of them requires re-tuning against the parquet archive per
    // feedback_tune_before_ship.
    mockSql
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const chainExtrasCall = mockSql.mock.calls[2] as unknown[];
    const boundValues = chainExtrasCall.slice(1);
    expect(boundValues).toContain(3); // REIGNITION_MIN_FIRES
    expect(boundValues).toContain(30); // REIGNITION_MIN_GAP_MIN
    expect(boundValues).toContain(2); // REIGNITION_MIN_POST_GAP_FIRES
    expect(boundValues).toContain(5); // REIGNITION_TOP_N_PER_DAY
  });

  // ============================================================
  // fireCountScoreAdjustment integration (basis:
  // docs/tmp/burst-profitability-findings-2026-05-17.md)
  // ============================================================

  it('applies -3 score adjustment + surfaces fireCountScoreAdjustment for single-fire chains', async () => {
    // Single-fire chains carry -3 from fire_count_score_adjustment.
    // rawScore=20, so the displayed score drops to 17 → tier2.
    // Post-#167 the adjustment is a stored DB column maintained by
    // the lottery_finder_fires_fc_adj_trg trigger, so tests mock the
    // column directly.
    const ROW_SINGLE = {
      ...ROW,
      fire_count: 1,
      fire_count_score_adjustment: -3,
    };
    mockSql
      .mockResolvedValueOnce([ROW_SINGLE])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        rawScore: number | null;
        scoreTier: string;
        fireCountScoreAdjustment: number;
      }>;
    };
    expect(body.fires[0]!.rawScore).toBe(20);
    expect(body.fires[0]!.fireCountScoreAdjustment).toBe(-3);
    expect(body.fires[0]!.score).toBe(17);
    // rawScore 20 + adj -3 = 17 → qas = 17 + 5 (Q5) = 22 → tier1 (>= 13).
    expect(body.fires[0]!.scoreTier).toBe('tier1');
  });

  it('applies -1 score adjustment for 2-3 fire chains (still below baseline)', async () => {
    const ROW_2_FIRES = {
      ...ROW,
      fire_count: 3,
      fire_count_score_adjustment: -1,
      first_fire_time_ct: '2026-05-01T18:00:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_2_FIRES])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        rawScore: number | null;
        fireCountScoreAdjustment: number;
      }>;
    };
    expect(body.fires[0]!.fireCountScoreAdjustment).toBe(-1);
    // rawScore 20 + adj -1 = 19 (displayed score). Tier derivation is
    // covered by lottery-tier.test.ts + the round-trip-deduct tests.
    expect(body.fires[0]!.score).toBe(19);
  });

  it('applies +1 score adjustment for 8-15 fire chains', async () => {
    const ROW_8_FIRES = {
      ...ROW,
      fire_count: 10,
      fire_count_score_adjustment: 1,
      first_fire_time_ct: '2026-05-01T14:00:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_8_FIRES])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        rawScore: number | null;
        fireCountScoreAdjustment: number;
      }>;
    };
    expect(body.fires[0]!.rawScore).toBe(20);
    expect(body.fires[0]!.fireCountScoreAdjustment).toBe(1);
    // rawScore 20 + adj +1 = 21 (displayed score).
    expect(body.fires[0]!.score).toBe(21);
  });

  it('applies +2 score adjustment for ≥16 fire chains (highest-edge cohort)', async () => {
    const ROW_BURST = {
      ...ROW,
      fire_count: 21, // matches the QQQ 708P 2026-05-15 anchor
      fire_count_score_adjustment: 2,
      first_fire_time_ct: '2026-05-01T13:30:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_BURST])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{ fireCountScoreAdjustment: number; score: number | null }>;
    };
    expect(body.fires[0]!.fireCountScoreAdjustment).toBe(2);
    // rawScore 20 + adj +2 = 22 (displayed score).
    expect(body.fires[0]!.score).toBe(22);
  });

  it('fire_count_score_adjustment drives the derived tier (boundary crossing)', async () => {
    // End-to-end guard that the fire_count adjustment flows into the
    // score→qas→tier path (not just the displayed score). Quintile 3 (+0)
    // and null gamma isolate fire_count_adj as the sole tier driver:
    // rawScore 12 + adj -3 = 9 → qas 9 → tier3. Without the -3, qas would be
    // 12 → tier2, so the adjustment is what demotes it.
    mockSql
      .mockResolvedValueOnce([
        {
          ...ROW,
          score: 12,
          fire_count: 1,
          fire_count_score_adjustment: -3,
          ticker_inversion_quintile: 3,
          gamma_at_trigger: null,
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }]);
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);
    const body = res._json as {
      fires: Array<{
        score: number | null;
        fireCountScoreAdjustment: number;
        qualityAdjustedScore: number;
        scoreTier: string;
      }>;
    };
    expect(body.fires[0]).toMatchObject({
      score: 9,
      fireCountScoreAdjustment: -3,
      qualityAdjustedScore: 9,
      scoreTier: 'tier3',
    });
  });

  it('attaches megaCluster + megaClusterSize when this fire is in a ≥12-ticker minute', async () => {
    // The mega-cluster query (4th Promise.all element) returns rows
    // for any minute with >= MEGA_CLUSTER_MIN_DISTINCT_TICKERS distinct
    // tickers firing. When that minute matches the fire's
    // trigger_time_ct (truncated to minute), the handler attaches the
    // flag + size to the row.
    const ROW_AT_CLUSTER_MIN = {
      ...ROW,
      trigger_time_ct: '2026-05-01T19:00:00Z',
    };
    mockSql
      .mockResolvedValueOnce([ROW_AT_CLUSTER_MIN])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([]) // chainExtras empty
      .mockResolvedValueOnce([
        // 2026-05-01T19:00:00 = 14:00 CT
        { minute_bucket_ct: '2026-05-01T19:00:00Z', distinct_tickers: 18 },
      ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{ megaCluster: boolean; megaClusterSize?: number }>;
    };
    expect(body.fires[0]!.megaCluster).toBe(true);
    expect(body.fires[0]!.megaClusterSize).toBe(18);
  });

  it('omits megaClusterSize + sets megaCluster=false when the fire-minute is below the cluster threshold', async () => {
    mockSql
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // no qualifying mega-cluster minutes

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{ megaCluster: boolean; megaClusterSize?: number }>;
    };
    expect(body.fires[0]!.megaCluster).toBe(false);
    expect(body.fires[0]!.megaClusterSize).toBeUndefined();
  });

  it('mega-cluster SQL binds MEGA_CLUSTER_MIN_DISTINCT_TICKERS (=12) as the HAVING threshold', async () => {
    mockSql
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    // 4th Promise.all entry is the mega-cluster query.
    const clusterCall = mockSql.mock.calls[3] as unknown[];
    const boundValues = clusterCall.slice(1);
    expect(boundValues).toContain(12);
  });

  it('attaches dualFlag=true when the chain appears in silent_boom_alerts for the date', async () => {
    // 5th Promise.all entry — Silent Boom chain-id Set for the date.
    mockSql
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ option_chain_id: ROW.option_chain_id }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<{ dualFlag: boolean }> };
    expect(body.fires[0]!.dualFlag).toBe(true);
  });

  it('sets dualFlag=false when the chain is not in silent_boom_alerts', async () => {
    mockSql
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        // A different chain — should NOT match
        { option_chain_id: 'AAPL260501C00200000' },
      ]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as { fires: Array<{ dualFlag: boolean }> };
    expect(body.fires[0]!.dualFlag).toBe(false);
  });

  it('applies +1 gamma bonus when gamma_at_trigger >= 0.025 AND ticker not in {SPY,USO}', async () => {
    const ROW_HIGH_GAMMA = {
      ...ROW,
      underlying_symbol: 'TSLA',
      gamma_at_trigger: 0.05,
    };
    mockSql
      .mockResolvedValueOnce([ROW_HIGH_GAMMA])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        gammaAtTrigger?: number | null;
        gammaScoreAdjustment?: number;
      }>;
    };
    // rawScore=20 + fireCountAdj=0 + gammaAdj=+1 = 21 → tier1
    expect(body.fires[0]!.gammaAtTrigger).toBe(0.05);
    expect(body.fires[0]!.gammaScoreAdjustment).toBe(1);
    expect(body.fires[0]!.score).toBe(21);
  });

  it('does NOT apply gamma bonus when ticker is SPY (signal reverses on SPY)', async () => {
    const ROW_SPY = {
      ...ROW,
      underlying_symbol: 'SPY',
      gamma_at_trigger: 0.1, // high gamma, but SPY excluded
    };
    mockSql
      .mockResolvedValueOnce([ROW_SPY])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        gammaAtTrigger?: number | null;
        gammaScoreAdjustment?: number;
      }>;
    };
    expect(body.fires[0]!.gammaAtTrigger).toBe(0.1);
    expect(body.fires[0]!.gammaScoreAdjustment).toBe(0);
    // No bonus → score stays at rawScore + fireCountAdj = 20
    expect(body.fires[0]!.score).toBe(20);
  });

  it('emits gammaAtTrigger=null + gammaScoreAdjustment=0 when DB column is NULL (older rows)', async () => {
    const ROW_NULL_GAMMA = {
      ...ROW,
      gamma_at_trigger: null,
    };
    mockSql
      .mockResolvedValueOnce([ROW_NULL_GAMMA])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        gammaAtTrigger?: number | null;
        gammaScoreAdjustment?: number;
      }>;
    };
    expect(body.fires[0]!.gammaAtTrigger).toBeNull();
    expect(body.fires[0]!.gammaScoreAdjustment).toBe(0);
  });

  it('stacks fireCountScoreAdjustment with round_trip_score_deduct (both apply)', async () => {
    // Multi-fire chain (10 fires → +1 adj) that ALSO round-tripped
    // (-2 deduct). Both must apply: 20 + 1 + (-2) = 19 → tier1.
    const ROW_STACKED = {
      ...ROW,
      fire_count: 10,
      fire_count_score_adjustment: 1,
      first_fire_time_ct: '2026-05-01T14:00:00Z',
      round_trip_score_deduct: -2,
    };
    mockSql
      .mockResolvedValueOnce([ROW_STACKED])
      .mockResolvedValueOnce([{ total: 1 }]);

    const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
    const res = mockResponse();
    await handler(req, res);

    const body = res._json as {
      fires: Array<{
        score: number | null;
        rawScore: number | null;
        roundTripScoreDeduct?: number;
        fireCountScoreAdjustment: number;
      }>;
    };
    expect(body.fires[0]!.rawScore).toBe(20);
    expect(body.fires[0]!.roundTripScoreDeduct).toBe(-2);
    expect(body.fires[0]!.fireCountScoreAdjustment).toBe(1);
    expect(body.fires[0]!.score).toBe(19);
  });

  // ============================================================
  // Phase 3 — inversion-quality filter
  // ============================================================
  //
  // Default behaviour: suppress fires whose ticker is in inversion
  // quintile 1 or 2. `?showAll=true` bypasses the filter. NULL quintile
  // (cold-start tickers without 21-day inversion history) is never
  // filtered. `qualityAdjustedScore` = combined_score + bonus(quintile)
  // and `scoreTier` is derived from it under the V2 cutoffs
  // (Tier 1 >= 13, Tier 2 >= 10).
  describe('inversion-quality filter', () => {
    const rowWithQuintile = (
      id: number,
      ticker: string,
      quintile: number | null,
    ): typeof ROW => ({
      ...ROW,
      id,
      underlying_symbol: ticker,
      option_chain_id: `${ticker}260501C01175000`,
      ticker_inversion_quintile: quintile as never,
    });

    it('applies Q1/Q2 suppression in SQL by default (not post-SELECT JS) and surfaces suppressedCount', async () => {
      // Phase 2 (spec lottery-no-vanish-2026-05-29.md) moved the
      // inversion-quality suppression from a post-SELECT JS filter into
      // the SQL — on BOTH the row queries and the COUNT(*) totals — so
      // `total`/`hasMore` reflect the reachable set and the page counter
      // never implies missing fires. The mock can't enforce a WHERE, so
      // we assert (a) the generated SQL carries the quintile predicate,
      // (b) the handler no longer JS-filters rows (all mocked rows pass
      // through), and (c) suppressedCount comes straight from the count
      // query.
      const rows = [
        rowWithQuintile(1, 'AAA', 1),
        rowWithQuintile(2, 'BBB', 2),
        rowWithQuintile(3, 'CCC', 3),
        rowWithQuintile(4, 'DDD', null),
      ];
      mockSql
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ total: 2, suppressed: 2 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const allSql = mockSql.mock.calls
        .map((c) => (Array.isArray(c[0]) ? (c[0] as string[]).join('?') : ''))
        .join('\n');
      // Quintile predicate present (row queries + count query).
      expect(allSql).toContain('inversion_quintile > 2');
      expect(allSql).toContain('inversion_quintile IS NULL');
      // No post-SELECT JS filter — every mocked row passes through; the
      // SQL (not the handler) drops Q1/Q2.
      const body = res._json as {
        count: number;
        total: number;
        suppressedCount: number;
        fires: Array<{ underlyingSymbol: string }>;
      };
      expect(body.fires.map((f) => f.underlyingSymbol).sort()).toEqual([
        'AAA',
        'BBB',
        'CCC',
        'DDD',
      ]);
      expect(body.total).toBe(2);
      expect(body.suppressedCount).toBe(2);
    });

    it('?showAll=true passes the bypass boolean into the SQL', async () => {
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(1, 'AAA', 1)])
        .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]);

      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-01', showAll: 'true' },
      });
      const res = mockResponse();
      await handler(req, res);

      // showAll=true is interpolated into the quintile predicate so it
      // short-circuits to TRUE (no suppression). Assert the boolean true
      // reached the SQL params.
      expect(
        mockSql.mock.calls.some((c) =>
          (c as unknown[]).slice(1).includes(true),
        ),
      ).toBe(true);
      const body = res._json as { suppressedCount: number };
      expect(body.suppressedCount).toBe(0);
    });

    it('NULL quintile is never filtered (cold-start protection)', async () => {
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(99, 'NEWT', null)])
        .mockResolvedValueOnce([{ total: 1 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const body = res._json as {
        count: number;
        fires: Array<{
          underlyingSymbol: string;
          inversionQuintile: number | null;
        }>;
      };
      expect(body.count).toBe(1);
      expect(body.fires[0]).toMatchObject({
        underlyingSymbol: 'NEWT',
        inversionQuintile: null,
      });
    });

    // ============================================================
    // MONOTONIC Q1/Q2 SUPPRESSION (fix/feed-never-vanish)
    // ============================================================
    //
    // `inversion_quintile` can FLIP mid-day when the detect cron re-runs,
    // so a ticker shown earlier (quintile > 2) could suddenly be suppressed
    // — its chains vanish from the FEED. The fix: a per-day Redis kept-set
    // accumulates every ever-shown ticker, and the suppression predicate
    // (rows + COUNT) also keeps any ticker in that set.

    it('keeps a ticker in the kept-set even after its quintile flips to Q1/Q2 (monotonic) — and the keep term is in BOTH row + count SQL', async () => {
      // FLIP scenario: AAA is now quintile 1 (would be suppressed by the
      // live gate) but it was shown earlier, so it's in the kept-set. The
      // monotonic keep must re-admit it. We assert the kept-tickers ANY()
      // term reached BOTH the row query AND the count query so rows and
      // suppressedCount stay coherent.
      mockReadKeptTickers.mockResolvedValueOnce(['AAA']);
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(1, 'AAA', 1)]) // rows
        .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]); // count

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      // kept-set was read for the request's target date.
      expect(mockReadKeptTickers).toHaveBeenCalledWith('2026-05-01');

      const rowsSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join(
        '?',
      );
      const countSql = (mockSql.mock.calls[1]![0] as TemplateStringsArray).join(
        '?',
      );
      // NON-VACUOUS: the monotonic keep is exactly this ANY(...) term.
      // Remove it from the predicate and this assertion fails.
      expect(rowsSql).toContain('= ANY(');
      expect(rowsSql).toContain('::text[]');
      expect(countSql).toContain('= ANY(');
      expect(countSql).toContain('::text[]');

      // The kept-set array reached the SQL params of both queries.
      const rowsParams = (mockSql.mock.calls[0] as unknown[]).slice(1);
      const countParams = (mockSql.mock.calls[1] as unknown[]).slice(1);
      const containsKept = (params: unknown[]): boolean =>
        params.some(
          (p) => Array.isArray(p) && p.length === 1 && p[0] === 'AAA',
        );
      expect(containsKept(rowsParams)).toBe(true);
      expect(containsKept(countParams)).toBe(true);

      // A kept ticker is NOT counted as suppressed (it's re-admitted).
      const body = res._json as { suppressedCount: number };
      expect(body.suppressedCount).toBe(0);
    });

    it('a Q1/Q2 ticker NOT in the kept-set still passes only an empty keep array (live suppression preserved)', async () => {
      // Empty kept-set → the ANY('{}'::text[]) term matches nothing, so the
      // predicate reduces to today's exact live behavior. We can't enforce
      // a WHERE in the mock, but we assert the empty array is what reached
      // the SQL (so nothing is spuriously re-admitted).
      mockReadKeptTickers.mockResolvedValueOnce([]);
      mockSql
        .mockResolvedValueOnce([]) // rows (BBB suppressed by live gate)
        .mockResolvedValueOnce([{ total: 0, suppressed: 1 }]); // count

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const rowsParams = (mockSql.mock.calls[0] as unknown[]).slice(1);
      const passedEmptyKept = rowsParams.some(
        (p) => Array.isArray(p) && p.length === 0,
      );
      expect(passedEmptyKept).toBe(true);

      const body = res._json as { suppressedCount: number; total: number };
      expect(body.total).toBe(0);
      expect(body.suppressedCount).toBe(1);
    });

    it('accumulates the PAGE-INDEPENDENT ever-qualifying set (from the COUNT query) into the kept-set', async () => {
      // The accumulation source is the COUNT query's `ever_qualifying` column
      // — array_agg(DISTINCT underlying_symbol) FILTER (WHERE quintile > 2)
      // over the FULL ranked set (no LIMIT). So even tickers NOT on the page
      // slice are accumulated. CCC quintile 3 (>2) → remembered. AAA quintile
      // 1 (kept only via the set) and NEWT NULL quintile are excluded by the
      // SQL FILTER (quintile > 2 is false for both), so they're not in
      // ever_qualifying. The handler passes ever_qualifying straight through.
      mockReadKeptTickers.mockResolvedValueOnce(['AAA']);
      mockSql
        .mockResolvedValueOnce([
          rowWithQuintile(1, 'AAA', 1),
          rowWithQuintile(3, 'CCC', 3),
          rowWithQuintile(9, 'NEWT', null),
        ])
        .mockResolvedValueOnce([
          { total: 3, suppressed: 0, ever_qualifying: ['CCC'] },
        ]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      expect(mockAddKeptTickers).toHaveBeenCalledTimes(1);
      const [addDate, addTickers] = mockAddKeptTickers.mock.calls[0]!;
      expect(addDate).toBe('2026-05-01');
      // ever_qualifying came straight from the page-independent COUNT query.
      expect(addTickers).toEqual(['CCC']);
    });

    it('never-vanish: a ticker qualifying (quintile>2) but NOT on the returned page is still accumulated (page-independence)', async () => {
      // THE HEADLINE FIX (#1). The page (rows) shows only AAA — a Q1 ticker
      // re-admitted via the kept-set. ZZZ qualifies live (quintile > 2) but
      // sits past the LIMIT/OFFSET slice, so it is ABSENT from `rows`. The
      // OLD code derived the accumulation set from `rows`, so ZZZ would never
      // be recorded and would vanish on its next quintile flip. The NEW code
      // sources from the COUNT query's page-independent `ever_qualifying`, so
      // ZZZ IS passed to addKeptTickers despite never appearing on the page.
      mockReadKeptTickers.mockResolvedValueOnce(['AAA']);
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(1, 'AAA', 1)]) // page slice
        .mockResolvedValueOnce([
          // page-independent COUNT over the FULL ranked set
          { total: 2, suppressed: 0, ever_qualifying: ['ZZZ'] },
        ]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      expect(mockAddKeptTickers).toHaveBeenCalledTimes(1);
      const [, addTickers] = mockAddKeptTickers.mock.calls[0]!;
      // ZZZ is accumulated even though it is NOT in the rendered `rows`.
      expect(addTickers).toEqual(['ZZZ']);
    });

    it('?showAll=true → suppression bypassed, kept-set never read or written', async () => {
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(1, 'AAA', 1)])
        .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]);

      const req = mockRequest({
        method: 'GET',
        query: { date: '2026-05-01', showAll: 'true' },
      });
      const res = mockResponse();
      await handler(req, res);

      // showAll short-circuits the kept-set entirely (no read, no write).
      expect(mockReadKeptTickers).not.toHaveBeenCalled();
      expect(mockAddKeptTickers).not.toHaveBeenCalled();
    });

    it('KV-down (readKeptTickers returns []) → graceful: pure live suppression, no crash', async () => {
      // The helper swallows KV errors and returns [] — the handler treats
      // that identically to "nothing shown yet". No throw, 200, empty keep.
      mockReadKeptTickers.mockResolvedValueOnce([]);
      mockSql
        .mockResolvedValueOnce([rowWithQuintile(3, 'CCC', 3)])
        .mockResolvedValueOnce([{ total: 1, suppressed: 0 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      expect(res._status).toBe(200);
      const rowsParams = (mockSql.mock.calls[0] as unknown[]).slice(1);
      expect(rowsParams.some((p) => Array.isArray(p) && p.length === 0)).toBe(
        true,
      );
    });

    it('qualityAdjustedScore = score + inversionQualityBonus(quintile)', async () => {
      // score = 8, quintile = 4 (+3) → qas = 11 → tier2 (>= 10, < 13)
      const row = {
        ...ROW,
        score: 8,
        ticker_inversion_quintile: 4,
      };
      mockSql
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([{ total: 1 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const body = res._json as {
        fires: Array<{
          score: number;
          qualityAdjustedScore: number;
          inversionQuintile: number;
          scoreTier: string;
        }>;
      };
      expect(body.fires[0]).toMatchObject({
        score: 8,
        qualityAdjustedScore: 11,
        inversionQuintile: 4,
        scoreTier: 'tier2',
      });
    });

    it('scoreTier reflects V2 cutoffs: 13→tier1, 10→tier2, 9→tier3', async () => {
      // Use quintile 3 (bonus 0) so qas == score for direct cutoff verification.
      const t1 = { ...ROW, id: 101, score: 13, ticker_inversion_quintile: 3 };
      const t2 = { ...ROW, id: 102, score: 10, ticker_inversion_quintile: 3 };
      const t3 = { ...ROW, id: 103, score: 9, ticker_inversion_quintile: 3 };
      mockSql
        .mockResolvedValueOnce([t1, t2, t3])
        .mockResolvedValueOnce([{ total: 3 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const body = res._json as {
        fires: Array<{ id: number; scoreTier: string }>;
      };
      const byId = new Map(body.fires.map((f) => [f.id, f.scoreTier]));
      expect(byId.get(101)).toBe('tier1');
      expect(byId.get(102)).toBe('tier2');
      expect(byId.get(103)).toBe('tier3');
    });

    it('exposes inversionBlend, inversionN21d, inversionN90d on the row', async () => {
      mockSql
        .mockResolvedValueOnce([ROW])
        .mockResolvedValueOnce([{ total: 1 }]);

      const req = mockRequest({ method: 'GET', query: { date: '2026-05-01' } });
      const res = mockResponse();
      await handler(req, res);

      const body = res._json as {
        fires: Array<{
          inversionBlend: number | null;
          inversionN21d: number | null;
          inversionN90d: number | null;
          inversionQuintile: number | null;
        }>;
      };
      expect(body.fires[0]).toMatchObject({
        inversionBlend: 0.42,
        inversionN21d: 18,
        inversionN90d: 64,
        inversionQuintile: 5,
      });
    });
  });

  // ============================================================
  // Suspicious-flow cluster detection (Task 2)
  // ============================================================

  it('stamps suspiciousCluster=true and clusterStrikeCount on rows whose ticker+side clusters', async () => {
    // META call row — option_type must be 'C' to match the cluster mock below.
    const ROW_META: typeof ROW = {
      ...ROW,
      id: 77,
      underlying_symbol: 'META',
      option_type: 'C',
      option_chain_id: 'META260527C00617500',
      strike: '617.5',
      spot_at_first: '613',
    };
    // Re-create the FULL mock sequence the handler expects, in order.
    // Slot order: rows, count, chainExtras, clusterByMinute, sbChains,
    // reignitedRows, clusterCandidates (7th = new slot).
    mockSql
      .mockResolvedValueOnce([ROW_META]) // rows (main page)
      .mockResolvedValueOnce([{ total: 1 }]) // count
      .mockResolvedValueOnce([]) // chainExtras
      .mockResolvedValueOnce([]) // clusterByMinute
      .mockResolvedValueOnce([]) // sbChains
      .mockResolvedValueOnce([]) // reignitedRows
      .mockResolvedValueOnce([
        // 3 cheap OTM ask-side META calls → triggers suspicious cluster
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '617.5',
          dte: 0,
          entry_price: '0.34',
          spot_at_first: '613',
          trigger_ask_pct: '0.74',
        },
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '615',
          dte: 0,
          entry_price: '0.91',
          spot_at_first: '613',
          trigger_ask_pct: '0.75',
        },
        {
          underlying_symbol: 'META',
          option_type: 'C',
          strike: '622.5',
          dte: 0,
          entry_price: '1.25',
          spot_at_first: '613',
          trigger_ask_pct: '0.71',
        },
      ]); // clusterCandidates
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-27' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const fire = (
      res._json as {
        fires: Array<{
          suspiciousCluster: boolean;
          clusterStrikeCount: number;
        }>;
      }
    ).fires[0];
    expect(fire!.suspiciousCluster).toBe(true);
    expect(fire!.clusterStrikeCount).toBe(3);
  });

  it('stamps suspiciousCluster=false and clusterStrikeCount=0 when no cluster for that ticker+side', async () => {
    // SNDK is not in the cluster candidates at all.
    mockSql
      .mockResolvedValueOnce([ROW]) // rows (main page)
      .mockResolvedValueOnce([{ total: 1 }]) // count
      .mockResolvedValueOnce([]) // chainExtras
      .mockResolvedValueOnce([]) // clusterByMinute
      .mockResolvedValueOnce([]) // sbChains
      .mockResolvedValueOnce([]) // reignitedRows
      .mockResolvedValueOnce([]); // clusterCandidates — empty
    const req = mockRequest({ method: 'GET', query: { date: '2026-05-27' } });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(200);
    const fire = (
      res._json as {
        fires: Array<{
          suspiciousCluster: boolean;
          clusterStrikeCount: number;
        }>;
      }
    ).fires[0];
    expect(fire!.suspiciousCluster).toBe(false);
    expect(fire!.clusterStrikeCount).toBe(0);
  });
});

describe('degradeOnTimeout', () => {
  beforeEach(() => {
    mockCaptureMessage.mockReset();
    mockReadLastGood.mockReset();
    mockWriteLastGood.mockReset();
    mockWriteLastGood.mockResolvedValue(undefined);
  });

  it('returns fallback + emits Sentry warning when the inner query throws a retryable error', async () => {
    // Pin SENTRY-EMERALD-DESERT-7J behavior: when a nice-to-have query
    // (chainExtras / clusterByMinute / sbChains / reignitedRows) hits
    // a Neon timeout, the helper degrades to a typed empty result so
    // the load-bearing rows + COUNT path can still respond 200. The
    // fallback is emitted as a Sentry warning so we can see degradation
    // rate in production — explicit observability, not a silent
    // `.catch(() => [])`.
    const result = await degradeOnTimeout(
      async () => {
        throw new Error('db attempt timeout');
      },
      [] as { foo: number }[],
      'chainExtras',
      { retries: 0 }, // retries=0 so the test doesn't wait on real-time setTimeout
    );
    expect(result).toEqual([]);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('chainExtras'),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ context: 'chainExtras' }),
      }),
    );
  });

  it('re-throws when the inner query fails with a non-retryable error', async () => {
    // SQL syntax error / type mismatch is a real bug, not a transient
    // Neon blip — must surface as 500, not get masked by the degradation
    // fallback.
    await expect(
      degradeOnTimeout(
        async () => {
          throw new Error('syntax error at or near "FORM"');
        },
        [] as { foo: number }[],
        'chainExtras',
        { retries: 0 },
      ),
    ).rejects.toThrow(/syntax error/);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // ── Last-good cache (fix/feed-never-vanish) ──────────────────────────

  it('overwrites the cache with the fresh result on success and returns it', async () => {
    const fresh = [{ id: 7 }];
    const result = await degradeOnTimeout(
      async () => fresh,
      [] as { id: number }[],
      'chainExtras',
      { retries: 0, timeout: 20_000, cacheKey: 'lf:lg:chainExtras:2026-05-01' },
    );
    expect(result).toBe(fresh);
    expect(mockWriteLastGood).toHaveBeenCalledWith(
      'lf:lg:chainExtras:2026-05-01',
      fresh,
      6 * 3600,
    );
    // SAFETY INVARIANT: last-good is NEVER read on the success path.
    expect(mockReadLastGood).not.toHaveBeenCalled();
  });

  it('ANTI-RESURRECTION: a legit-empty success overwrites cache with [] and never reads last-good', async () => {
    // The core invariant. A query that legitimately returns `[]` (rows
    // genuinely left) RESOLVES successfully — so it must overwrite the
    // cache with `[]` and the read path must be unreachable. If
    // readLastGood were consulted here, a removed row could be resurrected.
    const result = await degradeOnTimeout(
      async () => [] as { id: number }[],
      [{ id: 1 }] as { id: number }[], // distinct fallback to prove [] wins
      'reignitedRows',
      {
        retries: 0,
        timeout: 20_000,
        cacheKey: 'lf:lg:reignited:2026-05-01::::::',
      },
    );
    expect(result).toEqual([]);
    expect(mockWriteLastGood).toHaveBeenCalledWith(
      'lf:lg:reignited:2026-05-01::::::',
      [],
      6 * 3600,
    );
    expect(mockReadLastGood).not.toHaveBeenCalled();
  });

  it('serves the cached last-good value (not fallback) on a retryable timeout when present', async () => {
    const cached = [{ id: 99 }];
    mockReadLastGood.mockResolvedValueOnce(cached);
    const result = await degradeOnTimeout(
      async () => {
        throw new Error('db attempt timeout');
      },
      [] as { id: number }[],
      'chainExtras',
      { retries: 0, timeout: 20_000, cacheKey: 'lf:lg:chainExtras:2026-05-01' },
    );
    // last-good served, NOT the empty fallback.
    expect(result).toBe(cached);
    expect(mockReadLastGood).toHaveBeenCalledWith(
      'lf:lg:chainExtras:2026-05-01',
    );
    // Both the original 'degraded to fallback' warning AND the distinct
    // 'served last-good' message are emitted.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('degraded to fallback'),
      expect.anything(),
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('served last-good'),
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['lottery-finder', 'served-last-good', 'chainExtras'],
        tags: expect.objectContaining({ degrade_mode: 'served-last-good' }),
      }),
    );
  });

  it('falls back to the typed empty result on a retryable timeout when NO last-good is cached', async () => {
    mockReadLastGood.mockResolvedValueOnce(null);
    const result = await degradeOnTimeout(
      async () => {
        throw new Error('db attempt timeout');
      },
      [] as { id: number }[],
      'sbChains',
      { retries: 0, timeout: 20_000, cacheKey: 'lf:lg:sbChains:2026-05-01' },
    );
    expect(result).toEqual([]);
    expect(mockReadLastGood).toHaveBeenCalledWith('lf:lg:sbChains:2026-05-01');
  });

  it('does not touch the cache on a non-retryable error (rethrows)', async () => {
    await expect(
      degradeOnTimeout(
        async () => {
          throw new Error('syntax error at or near "FORM"');
        },
        [] as { id: number }[],
        'chainExtras',
        {
          retries: 0,
          timeout: 20_000,
          cacheKey: 'lf:lg:chainExtras:2026-05-01',
        },
      ),
    ).rejects.toThrow(/syntax error/);
    expect(mockReadLastGood).not.toHaveBeenCalled();
    expect(mockWriteLastGood).not.toHaveBeenCalled();
  });

  it('does not crash when the KV write throws on success (fire-and-forget)', async () => {
    mockWriteLastGood.mockRejectedValueOnce(new Error('KV unavailable'));
    const fresh = [{ id: 3 }];
    // writeLastGood is called via `void` (fire-and-forget); a rejection
    // must not propagate into the request path.
    const result = await degradeOnTimeout(
      async () => fresh,
      [] as { id: number }[],
      'chainExtras',
      { retries: 0, timeout: 20_000, cacheKey: 'lf:lg:chainExtras:2026-05-01' },
    );
    expect(result).toBe(fresh);
  });

  it('falls back when the KV read throws on a retryable timeout (no crash)', async () => {
    // last-good-cache.readLastGood swallows its own errors and returns
    // null, but assert degradeOnTimeout stays resilient even if it threw.
    mockReadLastGood.mockResolvedValueOnce(null);
    const result = await degradeOnTimeout(
      async () => {
        throw new Error('connection terminated');
      },
      [] as { id: number }[],
      'clusterByMinute',
      { retries: 0, timeout: 20_000, cacheKey: 'lf:lg:cluster:2026-05-01' },
    );
    expect(result).toEqual([]);
  });
});
