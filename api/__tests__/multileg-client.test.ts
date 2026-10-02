// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MultilegTradeInput,
  classifyMultilegBatch as classifyMultilegBatchType,
  MultilegClassifyError as MultilegClassifyErrorType,
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

function isVersionUrl(input: unknown): boolean {
  if (typeof input === 'string') return input.endsWith('/version');
  if (input instanceof URL) return input.pathname.endsWith('/version');
  if (input instanceof Request) return input.url.endsWith('/version');
  return false;
}

function versionOkResponse(): Response {
  return new Response(
    JSON.stringify({
      matcher_sha: 'abc1234',
      release: 'phase1.5',
      patterns: [
        'vertical',
        'strangle',
        'risk_reversal',
        'butterfly',
        'isolated_leg',
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Returns a fetch mock implementation that auto-responds to /version
 * probes with a healthy pattern list, and delegates non-/version
 * requests to the supplied handler. Tests that don't care about the
 * version probe use this to make their assertions independent of the
 * cold-start probe firing or not.
 */
function makeFetchMockWithVersionAuto(
  postHandler: (
    input: unknown,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  return (input: unknown, init?: RequestInit) => {
    if (isVersionUrl(input)) return Promise.resolve(versionOkResponse());
    return Promise.resolve(postHandler(input, init));
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('classifyMultilegBatch', () => {
  const originalClassifier = process.env.CLASSIFIER_URL;
  const originalSidecar = process.env.SIDECAR_URL;

  // Re-imported per test so module-level gates (versionChecked,
  // classifySentryLastEmit) are fresh each time. Vitest's
  // vi.resetModules() drops the cached module, and the dynamic import
  // below rebuilds it with cleared state.
  let classifyMultilegBatch: typeof classifyMultilegBatchType;
  let MultilegClassifyError: typeof MultilegClassifyErrorType;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let Sentry: { captureMessage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    process.env.CLASSIFIER_URL = 'https://classifier.example';
    delete process.env.SIDECAR_URL;
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import('../_lib/multileg-client.js');
    classifyMultilegBatch = mod.classifyMultilegBatch;
    MultilegClassifyError = mod.MultilegClassifyError;
    const loggerMod = await import('../_lib/logger.js');
    logger = loggerMod.default as unknown as typeof logger;
    const sentryMod = await import('../_lib/sentry.js');
    Sentry = sentryMod.Sentry as unknown as typeof Sentry;
  });

  afterEach(() => {
    if (originalClassifier === undefined) {
      delete process.env.CLASSIFIER_URL;
    } else {
      process.env.CLASSIFIER_URL = originalClassifier;
    }
    if (originalSidecar === undefined) {
      delete process.env.SIDECAR_URL;
    } else {
      process.env.SIDECAR_URL = originalSidecar;
    }
    vi.restoreAllMocks();
  });

  it('returns 2 classifications keyed by id when the classifier returns 2 rows', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() =>
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
      ),
    );

    const result = await classifyMultilegBatch([TRADE_A, TRADE_B]);

    // Either 2 calls (version + classify) or 1 call (version skipped) —
    // assertion is on the result, not the call count.
    expect(spy).toHaveBeenCalled();
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
    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: TRADE_A.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: TRADE_A.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([TRADE_A]);

    // Find the POST call (not the /version GET).
    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    expect(postCall).toBeDefined();
    const [calledUrl, init] = postCall!;
    expect(calledUrl).toBe('https://classifier.example/multileg-classify');
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
    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: TRADE_A.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: TRADE_A.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([TRADE_A], {
      windowSeconds: 60,
      strikeTolerance: 0.02,
      sizeTolerance: 0.25,
    });

    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    const init = postCall![1];
    const sent = JSON.parse(
      (init?.body as string | undefined) ?? '{}',
    ) as Record<string, unknown>;
    expect(sent.window_seconds).toBe(60);
    expect(sent.strike_tolerance).toBe(0.02);
    expect(sent.size_tolerance).toBe(0.25);
  });

  it('throws http_4xx on 400 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(
        () =>
          new Response('{"error":"trades is required"}', {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'http_4xx',
      status: 400,
    });
  });

  it('throws http_5xx on 500 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(
        () =>
          new Response('{"error":"matcher exploded"}', {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'http_5xx',
      status: 500,
    });
  });

  it('throws length_mismatch when response array length != input length', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() =>
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
      ),
    );

    await expect(
      classifyMultilegBatch([TRADE_A, TRADE_B]),
    ).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'length_mismatch',
    });
  });

  it('throws schema_mismatch when response is missing the classifications array', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() => makeJsonResponse({ wrong_key: [] })),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'schema_mismatch',
    });
  });

  it('throws schema_mismatch when inferred_structure is unknown', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() =>
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
      ),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'schema_mismatch',
    });
  });

  it('throws network on fetch rejection', async () => {
    // Fail the version probe AND the classify call.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('socket hang up'),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      name: 'MultilegClassifyError',
      kind: 'network',
    });
  });

  // ── CLASSIFIER_URL is required (sidecar fallback removed 2026-10-02) ──

  describe('when CLASSIFIER_URL is unset', () => {
    it('throws config_missing without any request, even when SIDECAR_URL is set', async () => {
      delete process.env.CLASSIFIER_URL;
      // The sidecar no longer serves /takeit/multileg-classify; a stale
      // SIDECAR_URL must not resurrect the old fallback.
      process.env.SIDECAR_URL = 'https://sidecar.example';
      const spy = vi.spyOn(globalThis, 'fetch');

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        name: 'MultilegClassifyError',
        kind: 'config_missing',
        message: 'CLASSIFIER_URL is not configured',
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('surfaces the failure by name: config_missing Sentry event + warn log', async () => {
      delete process.env.CLASSIFIER_URL;

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'config_missing',
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.config_missing',
        {
          level: 'error',
          extra: { envVar: 'CLASSIFIER_URL' },
        },
      );
      expect(logger.warn).toHaveBeenCalledWith(
        {},
        'multileg-classify CLASSIFIER_URL unset; skipping classification',
      );
    });

    it('treats a whitespace-only CLASSIFIER_URL as unset', async () => {
      process.env.CLASSIFIER_URL = '   ';
      process.env.SIDECAR_URL = 'https://sidecar.example';
      const spy = vi.spyOn(globalThis, 'fetch');

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'config_missing',
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('throttles the Sentry event but warns on every call', async () => {
      delete process.env.CLASSIFIER_URL;

      for (let i = 0; i < 3; i += 1) {
        await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
          kind: 'config_missing',
        });
      }

      const configMissingCaptures = Sentry.captureMessage.mock.calls.filter(
        (call: unknown[]) => call[0] === 'multileg.classify.config_missing',
      );
      expect(configMissingCaptures).toHaveLength(1);
      const unsetWarns = logger.warn.mock.calls.filter(
        (call: unknown[]) =>
          call[1] ===
          'multileg-classify CLASSIFIER_URL unset; skipping classification',
      );
      expect(unsetWarns).toHaveLength(3);
    });

    it('still returns an empty Map for empty input without touching config', async () => {
      delete process.env.CLASSIFIER_URL;

      const result = await classifyMultilegBatch([]);

      expect(result.size).toBe(0);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  it('strips trailing slash from CLASSIFIER_URL when building the endpoint URL', async () => {
    process.env.CLASSIFIER_URL = 'https://classifier.railway/';
    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: TRADE_A.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: TRADE_A.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([TRADE_A]);
    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    const [calledUrl] = postCall!;
    expect(calledUrl).toBe('https://classifier.railway/multileg-classify');
  });

  it('posts to CLASSIFIER_URL and ignores SIDECAR_URL', async () => {
    process.env.CLASSIFIER_URL = 'https://classifier.example';
    process.env.SIDECAR_URL = 'https://sidecar.example';
    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: TRADE_A.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: TRADE_A.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([TRADE_A]);
    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    const [calledUrl] = postCall!;
    expect(calledUrl).toBe('https://classifier.example/multileg-classify');
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

    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: tradeNoDelta.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: tradeNoDelta.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([tradeNoDelta]);
    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    const init = postCall![1];
    const sent = JSON.parse((init?.body as string | undefined) ?? '{}') as {
      trades: Array<Record<string, unknown>>;
    };
    expect('delta' in sent.trades[0]!).toBe(false);
  });

  it('passes delta=null through to the wire body when caller set it null', async () => {
    const tradeNullDelta: MultilegTradeInput = { ...TRADE_A, delta: null };

    const classifyResponse = makeJsonResponse({
      classifications: [
        {
          id: tradeNullDelta.id,
          inferred_structure: 'isolated_leg',
          is_isolated_leg: true,
          match_confidence: 0,
          pattern_group_id: tradeNullDelta.id,
        },
      ],
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(makeFetchMockWithVersionAuto(() => classifyResponse));

    await classifyMultilegBatch([tradeNullDelta]);
    const postCall = spy.mock.calls.find((call) => !isVersionUrl(call[0]));
    const init = postCall![1];
    const sent = JSON.parse((init?.body as string | undefined) ?? '{}') as {
      trades: Array<Record<string, unknown>>;
    };
    expect(sent.trades[0]!.delta).toBeNull();
  });

  it('returned Map preserves snake_case → camelCase response conversion', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() =>
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
      ),
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
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('socket hang up'),
    );
    try {
      await classifyMultilegBatch([TRADE_A]);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultilegClassifyError);
    }
  });

  it('logs durationMs on successful classify call', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(() =>
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
      ),
    );

    await classifyMultilegBatch([TRADE_A]);

    expect(logger.info).toHaveBeenCalledWith(
      { count: 1, durationMs: expect.any(Number) },
      'multileg-classify classifier ok',
    );
  });

  it('includes durationMs in the sidecar_non_2xx Sentry extra', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMockWithVersionAuto(
        () =>
          new Response(
            '{"status":"error","code":502,"message":"Application failed to respond"}',
            { status: 502, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      kind: 'http_5xx',
      status: 502,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'multileg.classify.sidecar_non_2xx',
      expect.objectContaining({
        extra: expect.objectContaining({
          status: 502,
          count: 1,
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  it('includes durationMs in the sidecar_unreachable Sentry extra', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('socket hang up'),
    );

    await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
      kind: 'network',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'multileg.classify.sidecar_unreachable',
      expect.objectContaining({
        extra: expect.objectContaining({
          count: 1,
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  // ── Fix 2 (Finding 1.1) — Zod schema accepts nulls for structure fields ──

  describe('nullable response fields (Fix 2 / Finding 1.1)', () => {
    it('accepts null for inferred_structure / is_isolated_leg / match_confidence / pattern_group_id', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(() =>
          makeJsonResponse({
            classifications: [
              {
                id: TRADE_A.id,
                inferred_structure: null,
                is_isolated_leg: null,
                match_confidence: null,
                pattern_group_id: null,
              },
            ],
          }),
        ),
      );

      const map = await classifyMultilegBatch([TRADE_A]);
      const row = map.get(TRADE_A.id);
      expect(row).toEqual({
        id: TRADE_A.id,
        inferredStructure: null,
        isIsolatedLeg: null,
        matchConfidence: null,
        patternGroupId: null,
      });
    });

    it('still rejects null for the required id field', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(() =>
          makeJsonResponse({
            classifications: [
              {
                id: null,
                inferred_structure: 'isolated_leg',
                is_isolated_leg: true,
                match_confidence: 0,
                pattern_group_id: 'grp-1',
              },
            ],
          }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'schema_mismatch',
      });
    });
  });

  // ── Named Sentry event per failure mode ──────────────────────────────────

  describe('Sentry event per failure mode', () => {
    it('emits schema_mismatch when the 2xx body fails the response schema', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(() => makeJsonResponse({ wrong_key: [] })),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
        MultilegClassifyError,
      );

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.schema_mismatch',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ durationMs: expect.any(Number) }),
        }),
      );
    });

    it('emits length_mismatch when the response row count differs', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(() =>
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
        ),
      );

      await expect(
        classifyMultilegBatch([TRADE_A, TRADE_B]),
      ).rejects.toBeInstanceOf(MultilegClassifyError);

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.length_mismatch',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ inputLength: 2, responseLength: 1 }),
        }),
      );
    });

    it('emits sidecar_non_2xx at error level for a generic 4xx (not 422)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response('{"error":"trades missing"}', {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
        MultilegClassifyError,
      );

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.sidecar_non_2xx',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ status: 400 }),
        }),
      );
    });
  });

  // ── Fix 4 (Finding 2.4) — 422 → contract_drift, not sidecar_non_2xx ──────

  describe('422 contract drift (Fix 4 / Finding 2.4)', () => {
    it('emits contract_drift with parsed Pydantic details on 422', async () => {
      const pydanticBody = JSON.stringify({
        details: [
          { loc: ['body', 'trades', 0, 'strike'], msg: 'field required' },
        ],
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response(pydanticBody, {
              status: 422,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'schema_drift',
        status: 422,
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.contract_drift',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({
            status: 422,
            details: [
              expect.objectContaining({
                loc: ['body', 'trades', 0, 'strike'],
              }),
            ],
          }),
        }),
      );
    });

    it('does NOT emit sidecar_non_2xx on 422', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response('{"details":[]}', {
              status: 422,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'schema_drift',
      });

      const nonTwoXxCalls = Sentry.captureMessage.mock.calls.filter(
        (call: unknown[]) => call[0] === 'multileg.classify.sidecar_non_2xx',
      );
      expect(nonTwoXxCalls).toHaveLength(0);
    });

    it('tolerates a non-JSON 422 body (details stays null)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response('not json', {
              status: 422,
              headers: { 'Content-Type': 'text/plain' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'schema_drift',
      });

      const driftCall = Sentry.captureMessage.mock.calls.find(
        (call: unknown[]) => call[0] === 'multileg.classify.contract_drift',
      );
      expect(driftCall).toBeDefined();
      const extra = (driftCall![1] as { extra: Record<string, unknown> }).extra;
      expect(extra.details).toBeNull();
    });
  });

  // ── Fix 5 (Finding 2.5) — Per-process Sentry throttle ────────────────────

  describe('Sentry per-message throttle (Fix 5 / Finding 2.5)', () => {
    it('emits sidecar_non_2xx only once within 60s for repeated 500s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          makeFetchMockWithVersionAuto(
            () =>
              new Response('{"error":"boom"}', {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              }),
          ),
        );

        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );
        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );

        const nonTwoXxCalls = Sentry.captureMessage.mock.calls.filter(
          (call: unknown[]) => call[0] === 'multileg.classify.sidecar_non_2xx',
        );
        expect(nonTwoXxCalls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits a new sidecar_non_2xx after 60s has elapsed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          makeFetchMockWithVersionAuto(
            () =>
              new Response('{"error":"boom"}', {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              }),
          ),
        );

        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );

        // Advance the clock past the 60s throttle window.
        vi.setSystemTime(Date.now() + 61_000);

        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );

        const nonTwoXxCalls = Sentry.captureMessage.mock.calls.filter(
          (call: unknown[]) => call[0] === 'multileg.classify.sidecar_non_2xx',
        );
        expect(nonTwoXxCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still logs warn locally even when Sentry is throttled', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.spyOn(globalThis, 'fetch').mockImplementation(
          makeFetchMockWithVersionAuto(
            () =>
              new Response('{"error":"boom"}', {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
              }),
          ),
        );

        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );
        await expect(classifyMultilegBatch([TRADE_A])).rejects.toBeInstanceOf(
          MultilegClassifyError,
        );

        const warnNon2xxCalls = logger.warn.mock.calls.filter(
          (call: unknown[]) =>
            typeof call[1] === 'string' &&
            (call[1] as string).includes(
              'multileg-classify classifier non-2xx',
            ),
        );
        expect(warnNon2xxCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Fix 6 (Finding 2.2) — Cold-start /version probe ──────────────────────

  describe('cold-start /version probe (Fix 6 / Finding 2.2)', () => {
    it('GETs /version on first classify call, not on second', async () => {
      const classifyResponse = makeJsonResponse({
        classifications: [
          {
            id: TRADE_A.id,
            inferred_structure: 'isolated_leg',
            is_isolated_leg: true,
            match_confidence: 0,
            pattern_group_id: TRADE_A.id,
          },
        ],
      });
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (isVersionUrl(input)) return Promise.resolve(versionOkResponse());
        return Promise.resolve(classifyResponse.clone());
      });

      await classifyMultilegBatch([TRADE_A]);
      await classifyMultilegBatch([TRADE_A]);

      const versionCalls = spy.mock.calls.filter((call) =>
        isVersionUrl(call[0]),
      );
      expect(versionCalls).toHaveLength(1);
      const [versionUrl, versionInit] = versionCalls[0]!;
      expect(versionUrl).toBe('https://classifier.example/version');
      expect(versionInit?.method).toBe('GET');
    });

    it('emits pattern_set_drift when server patterns are missing client values', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (isVersionUrl(input)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                matcher_sha: 'def4567',
                release: 'phase1.0',
                // Missing 'butterfly' and 'risk_reversal' from client list
                patterns: ['vertical', 'strangle', 'isolated_leg'],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
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
      });

      await classifyMultilegBatch([TRADE_A]);

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.pattern_set_drift',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({
            server_patterns: ['vertical', 'strangle', 'isolated_leg'],
            missing_on_server: expect.arrayContaining([
              'risk_reversal',
              'butterfly',
            ]),
          }),
        }),
      );
    });

    it('logs warn but does NOT throw when /version returns 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (isVersionUrl(input)) {
          return Promise.resolve(new Response('not found', { status: 404 }));
        }
        return Promise.resolve(
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
      });

      // Should succeed (404 on /version is non-fatal).
      const result = await classifyMultilegBatch([TRADE_A]);
      expect(result.size).toBe(1);

      const warnCalls = logger.warn.mock.calls.filter(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('/version returned non-2xx'),
      );
      expect(warnCalls).toHaveLength(1);
    });

    it('no pattern_set_drift when /version exposes all client patterns', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (isVersionUrl(input)) return Promise.resolve(versionOkResponse());
        return Promise.resolve(
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
      });

      await classifyMultilegBatch([TRADE_A]);

      const driftCalls = Sentry.captureMessage.mock.calls.filter(
        (call: unknown[]) => call[0] === 'multileg.classify.pattern_set_drift',
      );
      expect(driftCalls).toHaveLength(0);
    });
  });

  // ── Fix 7 — 503 queue saturation distinct from generic 5xx ──────────────

  describe('503 queue saturation (Fix 7)', () => {
    it('emits queue_saturation (not sidecar_non_2xx) on 503', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response(
              JSON.stringify({
                retry_after_sec: 5,
                queue_wait_sec: 12.3,
                concurrency_cap: 8,
                error: 'queue saturated',
              }),
              {
                status: 503,
                headers: {
                  'Content-Type': 'application/json',
                  'Retry-After': '5',
                },
              },
            ),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'http_503',
        status: 503,
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.queue_saturation',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({
            status: 503,
            retryAfterSec: 5,
          }),
        }),
      );

      const nonTwoXxCalls = Sentry.captureMessage.mock.calls.filter(
        (call: unknown[]) => call[0] === 'multileg.classify.sidecar_non_2xx',
      );
      expect(nonTwoXxCalls).toHaveLength(0);
    });

    it('falls back to Retry-After header when body lacks retry_after_sec', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response('not json', {
              status: 503,
              headers: { 'Retry-After': '7' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'http_503',
      });

      const call = Sentry.captureMessage.mock.calls.find(
        (c: unknown[]) => c[0] === 'multileg.classify.queue_saturation',
      );
      expect(call).toBeDefined();
      const extra = (call![1] as { extra: Record<string, unknown> }).extra;
      expect(extra.retryAfterSec).toBe('7');
    });
  });

  // ── Coverage gap fills ───────────────────────────────────────────────────

  describe('residual error paths', () => {
    it('throws schema_mismatch and emits invalid_json Sentry when 2xx body is not JSON', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        makeFetchMockWithVersionAuto(
          () =>
            new Response('not json at all', {
              status: 200,
              headers: { 'Content-Type': 'text/plain' },
            }),
        ),
      );

      await expect(classifyMultilegBatch([TRADE_A])).rejects.toMatchObject({
        kind: 'schema_mismatch',
      });

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'multileg.classify.invalid_json',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ durationMs: expect.any(Number) }),
        }),
      );
    });

    it('continues classifying when /version body fails its own schema (non-fatal)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        if (isVersionUrl(input)) {
          // Missing required `patterns` array — version schema fails,
          // probe logs warn and returns without throwing.
          return Promise.resolve(
            new Response(JSON.stringify({ matcher_sha: 'abc' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
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
      });

      const result = await classifyMultilegBatch([TRADE_A]);
      expect(result.size).toBe(1);

      const versionSchemaWarn = logger.warn.mock.calls.find(
        (call: unknown[]) =>
          typeof call[1] === 'string' &&
          (call[1] as string).includes('/version body failed schema'),
      );
      expect(versionSchemaWarn).toBeDefined();
    });
  });
});
