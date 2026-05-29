// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClassifyMultilegBatch = vi.hoisted(() => vi.fn());

vi.mock('../_lib/multileg-client.js', () => ({
  classifyMultilegBatch: mockClassifyMultilegBatch,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setTag: vi.fn(),
  },
}));

import {
  classifyAlertMultileg,
  type MultilegClassifyCache,
} from '../_lib/multileg-classify-batch.js';
import type { MultilegClassification } from '../_lib/multileg-client.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

interface FakeTradeRow {
  ws_trade_id: string;
  ticker: string;
  option_chain: string;
  option_type: 'C' | 'P';
  strike: number;
  expiry: string;
  executed_at: string;
  price: number;
  size: number;
  side: 'ask' | 'bid' | 'mid' | 'no_side';
  delta: number | null;
}

function makeRow(overrides: Partial<FakeTradeRow> = {}): FakeTradeRow {
  return {
    ws_trade_id: overrides.ws_trade_id ?? 'trade-default',
    ticker: overrides.ticker ?? 'AAPL',
    option_chain: overrides.option_chain ?? 'AAPL260501C00200000',
    option_type: overrides.option_type ?? 'C',
    strike: overrides.strike ?? 200,
    expiry: overrides.expiry ?? '2026-05-01',
    executed_at: overrides.executed_at ?? '2026-05-01T14:30:00.000Z',
    price: overrides.price ?? 1.5,
    size: overrides.size ?? 10,
    side: overrides.side ?? 'ask',
    delta: overrides.delta ?? 0.4,
  };
}

/** Build a tagged-template-compatible mock that returns the next queued result. */
function makeDb(rowsQueue: Array<FakeTradeRow[] | Error>) {
  const fn = vi.fn(async () => {
    const next = rowsQueue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? [];
  });
  // The helper invokes this as `db\`SELECT ...\`` — vi.fn() handles the call.
  return fn as unknown as Parameters<typeof classifyAlertMultileg>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyAlertMultileg', () => {
  const triggerTimeCt = new Date('2026-05-01T14:30:00.000Z');
  const ticker = 'AAPL';
  const optionChain = 'AAPL260501C00200000';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: classifies the anchor trade among a populated ticker window', async () => {
    // Five trades on AAPL inside the ±30s window. Two form a vertical
    // including the largest-premium trade on optionChain (= anchor).
    const anchorId = 'anchor-uuid';
    const sibLegId = 'sibling-uuid';
    const rows = [
      makeRow({
        ws_trade_id: 'trade-1',
        option_chain: 'AAPL260501C00210000',
        strike: 210,
        price: 0.5,
        size: 10,
      }),
      makeRow({
        ws_trade_id: anchorId,
        option_chain: optionChain,
        strike: 200,
        price: 2.0,
        size: 25, // premium 5000 — biggest on optionChain
      }),
      makeRow({
        ws_trade_id: 'trade-3',
        option_chain: optionChain,
        strike: 200,
        price: 1.8,
        size: 5, // premium 900 — smaller on same chain
      }),
      makeRow({
        ws_trade_id: sibLegId,
        option_chain: 'AAPL260501C00210000',
        strike: 210,
        price: 0.6,
        size: 25,
      }),
      makeRow({
        ws_trade_id: 'trade-5',
        option_chain: 'AAPL260501P00190000',
        option_type: 'P',
        strike: 190,
        price: 1.2,
        size: 8,
      }),
    ];

    const classification: MultilegClassification = {
      id: anchorId,
      inferredStructure: 'vertical',
      isIsolatedLeg: false,
      matchConfidence: 0.92,
      patternGroupId: 'pg-vert-1',
    };
    mockClassifyMultilegBatch.mockResolvedValueOnce(
      new Map([[anchorId, classification]]),
    );

    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();
    const result = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(result).toEqual(classification);
    expect(mockClassifyMultilegBatch).toHaveBeenCalledTimes(1);
    const [tradesArg] = mockClassifyMultilegBatch.mock.calls[0]!;
    // Helper passes the ticker-wide window — not just the alert's chain.
    expect((tradesArg as { id: string }[]).map((t) => t.id)).toEqual([
      'trade-1',
      anchorId,
      'trade-3',
      sibLegId,
      'trade-5',
    ]);
  });

  it('returns null when no trades on the alert chain are in the window', async () => {
    // Window has trades on the ticker, but none on optionChain → no
    // anchor → null. Sidecar is NOT called.
    const rows = [
      makeRow({
        ws_trade_id: 'a',
        option_chain: 'AAPL260501C00210000',
        strike: 210,
      }),
      makeRow({
        ws_trade_id: 'b',
        option_chain: 'AAPL260501P00190000',
        option_type: 'P',
        strike: 190,
      }),
    ];

    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();
    const result = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(result).toBeNull();
    expect(mockClassifyMultilegBatch).not.toHaveBeenCalled();
  });

  it('returns null and does NOT rethrow when the sidecar throws', async () => {
    const rows = [
      makeRow({ ws_trade_id: 'anchor', option_chain: optionChain }),
    ];
    mockClassifyMultilegBatch.mockRejectedValueOnce(
      new Error('sidecar 503 Service Unavailable'),
    );

    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();
    const result = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(result).toBeNull();
    expect(mockClassifyMultilegBatch).toHaveBeenCalledTimes(1);
  });

  it('returns null and does NOT rethrow when the DB query throws', async () => {
    const db = makeDb([new Error('ECONNRESET')]);
    const cache: MultilegClassifyCache = new Map();
    const result = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(result).toBeNull();
    expect(mockClassifyMultilegBatch).not.toHaveBeenCalled();
  });

  it('returns null without calling sidecar when window exceeds the size cap (10000)', async () => {
    // Build > 10000 rows on the chain to trip the defensive size gate.
    // Cap was raised from 5000 → 10000 on 2026-05-19 to stop Sentry
    // noise from high-vol ETF minutes that posted 6–8K-trade windows.
    const rows: FakeTradeRow[] = [];
    for (let i = 0; i < 10001; i += 1) {
      rows.push(
        makeRow({
          ws_trade_id: `t-${i}`,
          option_chain: optionChain,
          size: 1,
          price: 1,
        }),
      );
    }
    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();
    const result = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(result).toBeNull();
    expect(mockClassifyMultilegBatch).not.toHaveBeenCalled();
  });

  it('cache hit: same (ticker, chain, minute) returns memoized result with one sidecar call', async () => {
    const anchorId = 'anchor-cache';
    const rows = [
      makeRow({ ws_trade_id: anchorId, option_chain: optionChain }),
    ];
    const classification: MultilegClassification = {
      id: anchorId,
      inferredStructure: 'isolated_leg',
      isIsolatedLeg: true,
      matchConfidence: 0.3,
      patternGroupId: 'pg-iso-1',
    };
    mockClassifyMultilegBatch.mockResolvedValueOnce(
      new Map([[anchorId, classification]]),
    );

    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();

    const first = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );
    // Second call within the same minute — cache hit, no DB / sidecar call.
    const second = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      new Date(triggerTimeCt.getTime() + 5000),
    );

    expect(first).toEqual(classification);
    expect(second).toEqual(classification);
    expect(mockClassifyMultilegBatch).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Task 6 / Finding 1.5 (cron side): defensive null on match_confidence
  // when the anchor trade's side ∈ {mid, no_side}. synthesizeNbbo() builds
  // a 0.01 × 9999 wide-spread sentinel for those trades so the matcher's
  // side-classification rule still round-trips to 'mid' — but that fake
  // bid/ask makes the matcher's confidence formula meaningless. We
  // preserve structure (still valid from the leg graph) but null the
  // confidence so downstream Take-It scoring can't trust a synthetic
  // number.
  // ──────────────────────────────────────────────────────────────────────
  it.each(['mid', 'no_side'] as const)(
    'nulls match_confidence when anchor side is %s (synthesized NBBO defensive guard)',
    async (anchorSide) => {
      const anchorId = `anchor-${anchorSide}`;
      const rows = [
        makeRow({
          ws_trade_id: anchorId,
          option_chain: optionChain,
          side: anchorSide,
        }),
      ];
      const classification: MultilegClassification = {
        id: anchorId,
        inferredStructure: 'vertical',
        isIsolatedLeg: false,
        // Matcher returned a number on the synthetic spread — we must
        // override to null on the way out.
        matchConfidence: 0.91,
        patternGroupId: 'pg-fake',
      };
      mockClassifyMultilegBatch.mockResolvedValueOnce(
        new Map([[anchorId, classification]]),
      );

      const db = makeDb([rows]);
      const cache: MultilegClassifyCache = new Map();
      const result = await classifyAlertMultileg(
        db,
        cache,
        ticker,
        optionChain,
        triggerTimeCt,
      );

      expect(result).not.toBeNull();
      expect(result?.matchConfidence).toBeNull();
      // Structure label must still come through unchanged.
      expect(result?.inferredStructure).toBe('vertical');
      expect(result?.isIsolatedLeg).toBe(false);
      expect(result?.patternGroupId).toBe('pg-fake');
    },
  );

  it.each(['ask', 'bid'] as const)(
    'preserves match_confidence when anchor side is %s (true NBBO inferred from price)',
    async (anchorSide) => {
      const anchorId = `anchor-${anchorSide}`;
      const rows = [
        makeRow({
          ws_trade_id: anchorId,
          option_chain: optionChain,
          side: anchorSide,
        }),
      ];
      const classification: MultilegClassification = {
        id: anchorId,
        inferredStructure: 'vertical',
        isIsolatedLeg: false,
        matchConfidence: 0.77,
        patternGroupId: 'pg-real',
      };
      mockClassifyMultilegBatch.mockResolvedValueOnce(
        new Map([[anchorId, classification]]),
      );

      const db = makeDb([rows]);
      const cache: MultilegClassifyCache = new Map();
      const result = await classifyAlertMultileg(
        db,
        cache,
        ticker,
        optionChain,
        triggerTimeCt,
      );

      // For ask/bid trades, synthesizeNbbo() builds a real-looking NBBO
      // anchored to the executed price; the matcher's confidence is
      // computed against a non-degenerate spread and we trust it.
      expect(result?.matchConfidence).toBe(0.77);
      expect(result?.inferredStructure).toBe('vertical');
    },
  );

  it('memoizes null results so a transient failure does not cause N retries in one tick', async () => {
    // First call: sidecar throws → null cached. Second call: cache hit.
    const rows = [makeRow({ option_chain: optionChain })];
    mockClassifyMultilegBatch.mockRejectedValueOnce(new Error('boom'));

    const db = makeDb([rows]);
    const cache: MultilegClassifyCache = new Map();

    const first = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );
    const second = await classifyAlertMultileg(
      db,
      cache,
      ticker,
      optionChain,
      triggerTimeCt,
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockClassifyMultilegBatch).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
  });
});
