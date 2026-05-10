// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS — declared before module under test
// ============================================================

const mockSql = vi.fn(async (): Promise<unknown[]> => []);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    setTag: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

// ============================================================
// IMPORTS (after mocks)
// ============================================================

import {
  buildPeriscopeSummary,
  fetchPeriscopeAnalysisById,
  fetchParentChain,
  savePeriscopeAnalysis,
  toIsoDate,
  toIsoTimestamp,
  type PeriscopeStructuredFields,
  type SavePeriscopeAnalysisInput,
} from '../_lib/periscope-db.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';

// ============================================================
// FIXTURES
// ============================================================

function emptyStructured(
  overrides: Partial<PeriscopeStructuredFields> = {},
): PeriscopeStructuredFields {
  return {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
    bias: null,
    trade_types_recommended: [],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: null,
    confidence_basis: null,
    futures_plan: null,
    ...overrides,
  };
}

function saveInput(
  overrides: Partial<SavePeriscopeAnalysisInput> = {},
): SavePeriscopeAnalysisInput {
  return {
    capturedAt: '2026-05-08T13:30:00.000Z',
    tradingDate: '2026-05-08',
    readTime: '2026-05-08T13:30:00.000Z',
    spotAtReadTime: 5800,
    spotSource: 'db_exact',
    mode: 'pre_trade',
    parentId: null,
    userContext: null,
    imageUrls: {},
    proseText: 'Today the chart skews neutral.',
    fullResponse: { content: [{ type: 'text', text: 'hello' }] },
    embedding: null,
    structured: emptyStructured(),
    parseOk: true,
    model: 'claude-opus-4-7',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 100,
    durationMs: 1234,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset().mockImplementation(async () => []);
});

// ============================================================
// buildPeriscopeSummary — pure
// ============================================================

describe('buildPeriscopeSummary', () => {
  it('formats all known fields into a stable pipe-delimited line', () => {
    const out = buildPeriscopeSummary({
      mode: 'intraday',
      tradingDate: '2026-05-08',
      structured: emptyStructured({
        spot: 5800,
        cone_lower: 5750,
        cone_upper: 5850,
        long_trigger: 5810,
        short_trigger: 5790,
        regime_tag: 'pin',
      }),
      proseText: 'Pin day with tight cone and twin gamma walls.',
    });
    expect(out).toContain('mode=intraday');
    expect(out).toContain('spot=5800');
    expect(out).toContain('cone=5750-5850');
    expect(out).toContain('long_trigger=5810');
    expect(out).toContain('short_trigger=5790');
    expect(out).toContain('regime=pin');
    expect(out).toContain('prose=Pin day with tight cone');
    // Pipe delimiter on the base line.
    expect(out.split(' | ').length).toBe(7);
  });

  it('uses "null" placeholders when numeric fields are missing', () => {
    const out = buildPeriscopeSummary({
      mode: 'pre_trade',
      tradingDate: '2026-05-08',
      structured: emptyStructured(),
      proseText: '',
    });
    expect(out).toContain('spot=null');
    expect(out).toContain('cone=null-null');
    expect(out).toContain('long_trigger=null');
    expect(out).toContain('short_trigger=null');
    expect(out).toContain('regime=null');
    expect(out).toContain('prose=');
  });

  it('truncates the prose excerpt to 800 chars and collapses whitespace', () => {
    const longProse = 'A'.repeat(1500);
    const out = buildPeriscopeSummary({
      mode: 'debrief',
      tradingDate: '2026-05-08',
      structured: emptyStructured(),
      proseText: longProse,
    });
    const proseSeg = out.slice(out.indexOf('prose=') + 'prose='.length);
    expect(proseSeg.length).toBe(800);
  });

  it('collapses internal whitespace in the prose excerpt', () => {
    const out = buildPeriscopeSummary({
      mode: 'pre_trade',
      tradingDate: '2026-05-08',
      structured: emptyStructured(),
      proseText: 'A\n\nB\t\tC   D',
    });
    expect(out).toContain('prose=A B C D');
  });

  it('appends a futures_plan segment when present', () => {
    const out = buildPeriscopeSummary({
      mode: 'pre_trade',
      tradingDate: '2026-05-08',
      structured: emptyStructured({
        futures_plan: 'LONG: above 5810\n\nSHORT: below 5790\n\nWAIT: in cone',
      }),
      proseText: 'short prose',
    });
    expect(out).toContain(
      'Futures plan: LONG: above 5810 SHORT: below 5790 WAIT: in cone',
    );
  });

  it('skips the futures_plan segment when null or empty', () => {
    const out1 = buildPeriscopeSummary({
      mode: 'pre_trade',
      tradingDate: '2026-05-08',
      structured: emptyStructured({ futures_plan: null }),
      proseText: 'p',
    });
    expect(out1).not.toContain('Futures plan');

    const out2 = buildPeriscopeSummary({
      mode: 'pre_trade',
      tradingDate: '2026-05-08',
      structured: emptyStructured({ futures_plan: '' }),
      proseText: 'p',
    });
    expect(out2).not.toContain('Futures plan');
  });
});

// ============================================================
// toIsoDate / toIsoTimestamp
// ============================================================

describe('toIsoDate', () => {
  it('coerces a Date to YYYY-MM-DD', () => {
    expect(toIsoDate(new Date('2026-05-08T00:00:00Z'))).toBe('2026-05-08');
  });

  it('passes through a string by stringifying', () => {
    expect(toIsoDate('2026-05-08')).toBe('2026-05-08');
  });

  it('coerces unexpected values via String()', () => {
    expect(toIsoDate(20260508)).toBe('20260508');
  });
});

describe('toIsoTimestamp', () => {
  it('coerces a Date to a full ISO 8601 string', () => {
    const d = new Date('2026-05-08T13:30:45.500Z');
    expect(toIsoTimestamp(d)).toBe('2026-05-08T13:30:45.500Z');
  });

  it('passes through a string by stringifying', () => {
    expect(toIsoTimestamp('2026-05-08T13:30:00Z')).toBe('2026-05-08T13:30:00Z');
  });
});

// ============================================================
// fetchPeriscopeAnalysisById
// ============================================================

describe('fetchPeriscopeAnalysisById', () => {
  it('returns null when the row does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const out = await fetchPeriscopeAnalysisById(42);
    expect(out).toBeNull();
  });

  it('maps a populated row into the parent-read shape with structured fields', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: '101', // Neon BIGSERIAL as string
        mode: 'pre_trade',
        trading_date: new Date('2026-05-08T00:00:00Z'),
        prose_text: 'pre-trade plan',
        spot: 5800,
        cone_lower: '5750', // string-typed numeric
        cone_upper: 5850,
        long_trigger: 5810,
        short_trigger: 5790,
        regime_tag: 'pin',
        bias: 'fade-only',
        trade_types_recommended: ['iron_condor', 'butterfly'],
        trade_types_avoided: '["naked_long"]', // JSONB string
        key_levels: {
          gamma_floor: 5780,
          gamma_ceiling: 5820,
          magnet: 5800,
          charm_zero: 5810,
        },
        expected_dealer_behavior: 'pin-suppression',
        confidence: 'high',
        confidence_basis: 'twin gamma walls',
        futures_plan: 'WAIT: in cone',
      },
    ]);
    const out = await fetchPeriscopeAnalysisById(101);
    expect(out).not.toBeNull();
    expect(out!.id).toBe(101);
    expect(out!.mode).toBe('pre_trade');
    expect(out!.tradingDate).toBe('2026-05-08');
    expect(out!.proseText).toBe('pre-trade plan');
    expect(out!.structured.spot).toBe(5800);
    expect(out!.structured.cone_lower).toBe(5750);
    expect(out!.structured.cone_upper).toBe(5850);
    expect(out!.structured.bias).toBe('fade-only');
    expect(out!.structured.trade_types_recommended).toEqual([
      'iron_condor',
      'butterfly',
    ]);
    // JSONB string parses cleanly through parseJsonb.
    expect(out!.structured.trade_types_avoided).toEqual(['naked_long']);
    expect(out!.structured.key_levels).toEqual({
      gamma_floor: 5780,
      gamma_ceiling: 5820,
      magnet: 5800,
      charm_zero: 5810,
    });
    expect(out!.structured.confidence).toBe('high');
    expect(out!.structured.futures_plan).toBe('WAIT: in cone');
  });

  it('rejects unknown bias / confidence values (sets to null)', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 5,
        mode: 'intraday',
        trading_date: '2026-05-08',
        prose_text: '',
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: 'wild-guess', // not in enum
        trade_types_recommended: null,
        trade_types_avoided: null,
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: 'extreme', // not in enum
        confidence_basis: null,
        futures_plan: null,
      },
    ]);
    const out = await fetchPeriscopeAnalysisById(5);
    expect(out!.structured.bias).toBeNull();
    expect(out!.structured.confidence).toBeNull();
    expect(out!.structured.trade_types_recommended).toEqual([]);
    expect(out!.structured.trade_types_avoided).toEqual([]);
    expect(out!.structured.key_levels).toBeNull();
  });

  it('rejects invalid key_levels JSON and returns null', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 5,
        mode: 'intraday',
        trading_date: '2026-05-08',
        prose_text: '',
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: 'not-valid-json{', // falls through parseJsonb fallback
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
        futures_plan: null,
      },
    ]);
    const out = await fetchPeriscopeAnalysisById(5);
    expect(out!.structured.key_levels).toBeNull();
  });

  it('coerces non-finite numeric values to null', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 5,
        mode: 'intraday',
        trading_date: '2026-05-08',
        prose_text: 'a',
        spot: 'not-a-number',
        cone_lower: Number.NaN,
        cone_upper: Number.POSITIVE_INFINITY,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
        bias: null,
        trade_types_recommended: [],
        trade_types_avoided: [],
        key_levels: null,
        expected_dealer_behavior: null,
        confidence: null,
        confidence_basis: null,
        futures_plan: null,
      },
    ]);
    const out = await fetchPeriscopeAnalysisById(5);
    expect(out!.structured.spot).toBeNull();
    expect(out!.structured.cone_lower).toBeNull();
    expect(out!.structured.cone_upper).toBeNull();
  });

  it('returns null and Sentry-captures when the query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const out = await fetchPeriscopeAnalysisById(99);
    expect(out).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

// ============================================================
// fetchParentChain
// ============================================================

describe('fetchParentChain', () => {
  it('maps recursive chain rows into oldest-first ParentChainRow[]', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        mode: 'pre_trade',
        regime_tag: 'pin',
        bias: 'fade-only',
        prose_text: 'root open read text',
        spot: 5800,
        cone_lower: '5750',
        cone_upper: 5850,
        long_trigger: 5810,
        short_trigger: 5790,
      },
      {
        id: 2,
        mode: 'intraday',
        regime_tag: null,
        bias: null,
        prose_text: 'mid-day update',
        spot: 5805,
        cone_lower: 5755,
        cone_upper: 5855,
        long_trigger: null,
        short_trigger: null,
      },
    ]);
    const chain = await fetchParentChain(2);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.id).toBe(1);
    expect(chain[0]!.mode).toBe('pre_trade');
    expect(chain[0]!.regime_tag).toBe('pin');
    expect(chain[0]!.bias).toBe('fade-only');
    expect(chain[0]!.structured.spot).toBe(5800);
    expect(chain[0]!.structured.cone_lower).toBe(5750);
    expect(chain[1]!.regime_tag).toBeNull();
    expect(chain[1]!.bias).toBeNull();
  });

  it('truncates a long prose excerpt with an ellipsis', async () => {
    const longProse = 'X'.repeat(1000);
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        mode: 'pre_trade',
        regime_tag: null,
        bias: null,
        prose_text: longProse,
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
      },
    ]);
    const chain = await fetchParentChain(1);
    expect(chain[0]!.prose_excerpt.endsWith('…')).toBe(true);
    // 400 chars + ellipsis
    expect(chain[0]!.prose_excerpt.length).toBe(401);
  });

  it('collapses whitespace in the prose excerpt', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        mode: 'pre_trade',
        regime_tag: null,
        bias: null,
        prose_text: 'one\n\ntwo\t\tthree   four',
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
      },
    ]);
    const chain = await fetchParentChain(1);
    expect(chain[0]!.prose_excerpt).toBe('one two three four');
  });

  it('handles missing prose_text gracefully', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 1,
        mode: 'pre_trade',
        regime_tag: null,
        bias: null,
        prose_text: null,
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
      },
    ]);
    const chain = await fetchParentChain(1);
    expect(chain[0]!.prose_excerpt).toBe('');
  });

  it('returns [] and Sentry-captures when the query throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('boom'));
    const out = await fetchParentChain(7);
    expect(out).toEqual([]);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

// ============================================================
// savePeriscopeAnalysis
// ============================================================

describe('savePeriscopeAnalysis', () => {
  it('returns the new id on a successful insert', async () => {
    mockSql.mockResolvedValueOnce([{ id: '777' }]);
    const id = await savePeriscopeAnalysis(saveInput());
    expect(id).toBe(777);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('serializes a non-empty embedding into a vector literal', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    const embedding = [0.1, 0.2, 0.3];
    await savePeriscopeAnalysis(saveInput({ embedding }));
    // The first call's last interpolated value before INSERT depends on
    // template ordering. We check that *some* string '[0.1,0.2,0.3]' was
    // bound — Neon templates pass parameters as positional binds in the
    // mock signature.
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(params.some((p) => p === '[0.1,0.2,0.3]')).toBe(true);
  });

  it('binds null vector when embedding is null', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    await savePeriscopeAnalysis(saveInput({ embedding: null }));
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    // No vector literal that looks like '[0.x,...]' should be bound.
    const vectorBind = params.find(
      (p) => typeof p === 'string' && /^\[\d/.test(p),
    );
    expect(vectorBind).toBeUndefined();
    // And a literal `null` must appear as a bind for the vectorLiteral.
    expect(params.some((p) => p === null)).toBe(true);
  });

  it('binds null vector when embedding is an empty array', async () => {
    mockSql.mockResolvedValueOnce([{ id: 2 }]);
    await savePeriscopeAnalysis(saveInput({ embedding: [] }));
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const vectorBind = params.find(
      (p) => typeof p === 'string' && /^\[\d/.test(p),
    );
    expect(vectorBind).toBeUndefined();
  });

  it('serializes image URLs into an array of {kind,url} objects', async () => {
    mockSql.mockResolvedValueOnce([{ id: 3 }]);
    await savePeriscopeAnalysis(
      saveInput({
        imageUrls: {
          chart: 'https://blob/chart.png',
          gex: 'https://blob/gex.png',
        },
      }),
    );
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const imageJson = params.find(
      (p) => typeof p === 'string' && p.includes('"kind":"chart"'),
    ) as string | undefined;
    expect(imageJson).toBeDefined();
    expect(JSON.parse(imageJson!)).toEqual([
      { kind: 'chart', url: 'https://blob/chart.png' },
      { kind: 'gex', url: 'https://blob/gex.png' },
    ]);
  });

  it('binds key_levels JSON when present and null when absent', async () => {
    mockSql.mockResolvedValueOnce([{ id: 4 }]);
    await savePeriscopeAnalysis(
      saveInput({
        structured: emptyStructured({
          key_levels: {
            gamma_floor: 5780,
            gamma_ceiling: 5820,
            magnet: 5800,
            charm_zero: 5810,
          },
        }),
      }),
    );
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const keyLevelsBind = params.find(
      (p) => typeof p === 'string' && p.includes('"gamma_floor":5780'),
    );
    expect(keyLevelsBind).toBeDefined();
  });

  it('returns null and Sentry-captures when the insert throws', async () => {
    mockSql.mockRejectedValueOnce(new Error('unique violation'));
    const id = await savePeriscopeAnalysis(saveInput());
    expect(id).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns null when RETURNING gives no row', async () => {
    mockSql.mockResolvedValueOnce([]);
    const id = await savePeriscopeAnalysis(saveInput());
    expect(id).toBeNull();
  });

  it('returns null when the returned id is not a finite number', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'not-a-number' }]);
    const id = await savePeriscopeAnalysis(saveInput());
    expect(id).toBeNull();
  });

  it('handles empty trade_types arrays without throwing', async () => {
    mockSql.mockResolvedValueOnce([{ id: 9 }]);
    const id = await savePeriscopeAnalysis(
      saveInput({
        structured: emptyStructured({
          trade_types_recommended: [],
          trade_types_avoided: [],
        }),
      }),
    );
    expect(id).toBe(9);
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    const emptyArrJson = params.filter((p) => p === '[]');
    // trade_types_recommended + trade_types_avoided both stringify as '[]'
    expect(emptyArrJson.length).toBeGreaterThanOrEqual(2);
  });

  // Auto-playbook lifecycle field defaults (migration #142). Manual chat
  // callers omit these fields entirely — verify the defaults match what the
  // DB CHECK + DEFAULT constraints expect so existing rows stay valid.
  it('defaults auto_generated=false, status=complete, slot/failure/payload=null', async () => {
    mockSql.mockResolvedValueOnce([{ id: 10 }]);
    await savePeriscopeAnalysis(saveInput());
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(params).toContain(false); // auto_generated
    expect(params).toContain('complete'); // status
    // slot_captured_at, failure_reason, panel_payload all bound as null
    expect(params.filter((p) => p === null).length).toBeGreaterThanOrEqual(3);
  });

  it('binds auto-playbook fields when provided', async () => {
    mockSql.mockResolvedValueOnce([{ id: 11 }]);
    await savePeriscopeAnalysis(
      saveInput({
        autoGenerated: true,
        slotCapturedAt: '2026-05-12T13:30:00.000Z',
        status: 'in_progress',
        failureReason: null,
        panelPayload: { spot: 5800, regime: 'drift-and-cap' },
      }),
    );
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(params).toContain(true); // auto_generated
    expect(params).toContain('2026-05-12T13:30:00.000Z'); // slot_captured_at
    expect(params).toContain('in_progress'); // status
    const panelBind = params.find(
      (p) => typeof p === 'string' && p.includes('"regime":"drift-and-cap"'),
    );
    expect(panelBind).toBeDefined();
  });

  it('serializes status=truncated with a failure_reason', async () => {
    mockSql.mockResolvedValueOnce([{ id: 12 }]);
    await savePeriscopeAnalysis(
      saveInput({
        autoGenerated: true,
        status: 'truncated',
        failureReason: 'stop_reason=max_tokens at 64000',
        panelPayload: null,
      }),
    );
    const params = mockSql.mock.calls[0]!.slice(1) as unknown[];
    expect(params).toContain('truncated');
    expect(params).toContain('stop_reason=max_tokens at 64000');
  });
});
