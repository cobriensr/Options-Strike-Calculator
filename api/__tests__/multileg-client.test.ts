// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyMultilegBatch,
  MultilegClassifyError,
  type MultilegTradeInput,
} from '../_lib/multileg-client.js';

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const TRADE_A: MultilegTradeInput = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  underlyingSymbol: 'SPY',
  executedAt: '2026-05-16T18:30:01.123456+00:00',
  optionChainId: 'SPY 250516C00500000',
  strike: 500,
  expiry: '2026-05-16',
  optionType: 'call',
  size: 10,
  price: 1.25,
  nbboBid: 1.2,
  nbboAsk: 1.3,
  premium: 1250,
  delta: 0.42,
};

const TRADE_B: MultilegTradeInput = {
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  underlyingSymbol: 'SPY',
  executedAt: '2026-05-16T18:30:01.234567+00:00',
  optionChainId: 'SPY 250516P00500000',
  strike: 500,
  expiry: '2026-05-16',
  optionType: 'put',
  size: 10,
  price: 0.95,
  nbboBid: 0.9,
  nbboAsk: 1.0,
  premium: 950,
  delta: -0.41,
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyMultilegBatch', () => {
  const originalEnv = process.env.SIDECAR_URL;

  beforeEach(() => {
    process.env.SIDECAR_URL = 'https://sidecar.example';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.SIDECAR_URL = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns 2 classifications keyed by id when sidecar returns 2 rows', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        classifications: [
          {
            id: TRADE_A.id,
            inferred_structure: 'risk_reversal',
            is_isolated_leg: false,
            match_confidence: 0.82,
            pattern_group_id: 'grp-1',
          },
          {
            id: TRADE_B.id,
            inferred_structure: 'risk_reversal',
            is_isolated_leg: false,
            match_confidence: 0.82,
            pattern_group_id: 'grp-1',
          },
        ],
      }),
    );

    const result = await classifyMultilegBatch([TRADE_A, TRADE_B]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(2);
    expect(result.get(TRADE_A.id)).toEqual({
      id: TRADE_A.id,
      inferredStructure: 'risk_reversal',
      isIsolatedLeg: false,
      matchConfidence: 0.82,
      patternGroupId: 'grp-1',
    });
    expect(result.get(TRADE_B.id)).toEqual({
      id: TRADE_B.id,
      inferredStructure: 'risk_reversal',
      isIsolatedLeg: false,
      matchConfidence: 0.82,
      patternGroupId: 'grp-1',
    });
  });

  it('returns an empty Map without calling fetch when trades is empty', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await classifyMultilegBatch([]);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('camelCase → snake_case conversion on request body', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          classifications: [
            {
              id: TRADE_A.id,
              inferred_structure: 'isolated_leg',
              is_isolated_leg: true,
              match_confidence: 0,
              pattern_group_id: TRADE_A.id,
            },
          ],
        }),
      );

    await classifyMultilegBatch([TRADE_A]);

    expect(spy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = spy.mock.calls[0]!;
    expect(calledUrl).toBe('https://sidecar.example/takeit/multileg-classify');
    expect(init?.method).toBe('POST');
    const sentBody = JSON.parse(
      (init?.body as string | undefined) ?? '{}',
    ) as Record<string, unknown>;
    expect(sentBody.trades).toEqual([
      {
        id: TRADE_A.id,
        underlying_symbol: 'SPY',
        executed_at: TRADE_A.executedAt,
        option_chain_id: TRADE_A.optionChainId,
        strike: 500,
        expiry: '2026-05-16',
        option_type: 'call',
        size: 10,
        price: 1.25,
        nbbo_bid: 1.2,
        nbbo_ask: 1.3,
        premium: 1250,
        delta: 0.42,
      },
    ]);
    // tolerance fields omitted when caller didn't pass them
    expect('window_seconds' in sentBody).toBe(false);
    expect('strike_tolerance' in sentBody).toBe(false);
    expect('size_tolerance' in sentBody).toBe(false);
  });

  it('forwards tolerance options in the request body when set', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          classifications: [
            {
              id: TRADE_A.id,
              inferred_structure: 'isolated_leg',
              is_isolated_leg: true,
              match_confidence: 0,
              pattern_group_id: TRADE_A.id,
            },
          ],
        }),
      );

    await classifyMultilegBatch([TRADE_A], {
      windowSeconds: 60,
      strikeTolerance: 0.02,
      sizeTolerance: 0.25,
    });

    const init = spy.mock.calls[0]![1];
    const sent = JSON.parse(
      (init?.body as string | undefined) ?? '{}',
    ) as Record<string, unknown>;
    expect(sent.window_seconds).toBe(60);
    expect(sent.strike_tolerance).toBe(0.02);
    expect(sent.size_tolerance).toBe(0.25);
  });

  it('throws http_4xx on 400 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":"trades is required"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'http_4xx',
      status: 400,
    });
  });

  it('throws http_5xx on 500 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":"matcher exploded"}', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'http_5xx',
      status: 500,
    });
  });

  it('throws length_mismatch when response array length != input length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        classifications: [
          {
            id: TRADE_A.id,
            inferred_structure: 'isolated_leg',
            is_isolated_leg: true,
            match_confidence: 0,
            pattern_group_id: TRADE_A.id,
          },
        ],
      }),
    );

    await expect(
      classifyMultilegBatch([TRADE_A, TRADE_B]),
    ).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'length_mismatch',
    });
  });

  it('throws schema_mismatch when response is missing the classifications array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({ wrong_key: [] }),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'schema_mismatch',
    });
  });

  it('throws schema_mismatch when inferred_structure is unknown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        classifications: [
          {
            id: TRADE_A.id,
            inferred_structure: 'condor', // not in the allowed set
            is_isolated_leg: false,
            match_confidence: 0.5,
            pattern_group_id: 'grp-1',
          },
        ],
      }),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'schema_mismatch',
    });
  });

  it('throws network on fetch rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('socket hang up'),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'network',
    });
  });

  it('throws config_missing when SIDECAR_URL is unset and trades are non-empty', async () => {
    delete process.env.SIDECAR_URL;
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'config_missing',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('strips trailing slash from SIDECAR_URL when building the endpoint URL', async () => {
    process.env.SIDECAR_URL = 'https://sidecar.example/';
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          classifications: [
            {
              id: TRADE_A.id,
              inferred_structure: 'isolated_leg',
              is_isolated_leg: true,
              match_confidence: 0,
              pattern_group_id: TRADE_A.id,
            },
          ],
        }),
      );

    await classifyMultilegBatch([TRADE_A]);
    const [calledUrl] = spy.mock.calls[0]!;
    expect(calledUrl).toBe('https://sidecar.example/takeit/multileg-classify');
  });

  it('omits delta from the wire body when caller did not set it', async () => {
    const tradeNoDelta: MultilegTradeInput = {
      id: 'cccccccc-0000-0000-0000-000000000003',
      underlyingSymbol: 'SPY',
      executedAt: TRADE_A.executedAt,
      optionChainId: TRADE_A.optionChainId,
      strike: 500,
      expiry: '2026-05-16',
      optionType: 'call',
      size: 1,
      price: 1.25,
      nbboBid: 1.2,
      nbboAsk: 1.3,
      premium: 125,
    };

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          classifications: [
            {
              id: tradeNoDelta.id,
              inferred_structure: 'isolated_leg',
              is_isolated_leg: true,
              match_confidence: 0,
              pattern_group_id: tradeNoDelta.id,
            },
          ],
        }),
      );

    await classifyMultilegBatch([tradeNoDelta]);
    const init = spy.mock.calls[0]![1];
    const sent = JSON.parse(
      (init?.body as string | undefined) ?? '{}',
    ) as { trades: Array<Record<string, unknown>> };
    expect('delta' in sent.trades[0]!).toBe(false);
  });

  it('passes delta=null through to the wire body when caller set it null', async () => {
    const tradeNullDelta: MultilegTradeInput = { ...TRADE_A, delta: null };

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          classifications: [
            {
              id: tradeNullDelta.id,
              inferred_structure: 'isolated_leg',
              is_isolated_leg: true,
              match_confidence: 0,
              pattern_group_id: tradeNullDelta.id,
            },
          ],
        }),
      );

    await classifyMultilegBatch([tradeNullDelta]);
    const init = spy.mock.calls[0]![1];
    const sent = JSON.parse(
      (init?.body as string | undefined) ?? '{}',
    ) as { trades: Array<Record<string, unknown>> };
    expect(sent.trades[0]!.delta).toBeNull();
  });

  it('returned Map preserves snake_case → camelCase response conversion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        classifications: [
          {
            id: TRADE_A.id,
            inferred_structure: 'butterfly',
            is_isolated_leg: false,
            match_confidence: 0.7,
            pattern_group_id: 'pat-fly-1',
          },
        ],
      }),
    );

    const map = await classifyMultilegBatch([TRADE_A]);
    const row = map.get(TRADE_A.id);
    expect(row).toBeDefined();
    // camelCase keys only — no lingering snake_case fields
    expect(row).toEqual({
      id: TRADE_A.id,
      inferredStructure: 'butterfly',
      isIsolatedLeg: false,
      matchConfidence: 0.7,
      patternGroupId: 'pat-fly-1',
    });
  });

  it('exposes MultilegClassifyError as an instance check', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('socket hang up'),
    );
    try {
      await classifyMultilegBatch([TRADE_A]);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultilegClassifyError);
    }
  });
});
