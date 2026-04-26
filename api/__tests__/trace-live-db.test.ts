// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Neon client at the module boundary, same shape as db.test.ts.
const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
  transaction: ReturnType<typeof vi.fn>;
};
mockSql.transaction = vi.fn().mockResolvedValue([]);
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => mockSql),
}));

vi.mock('../_lib/logger.js', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn() },
  metrics: { dbSave: vi.fn(), increment: vi.fn() },
}));

import {
  buildTraceLiveSummary,
  saveTraceLiveAnalysis,
} from '../_lib/trace-live-db.js';
import { _resetDb } from '../_lib/db.js';
import type { TraceAnalysis } from '../_lib/trace-live-types.js';

const baseAnalysis: TraceAnalysis = {
  timestamp: '2026-04-23T19:30:00Z',
  spot: 6005,
  stabilityPct: 67,
  regime: 'range_bound_positive_gamma',
  charm: {
    predominantColor: 'red',
    direction: 'short',
    junctionStrike: 6010,
    flipFlopDetected: false,
    rejectionWicksAtRed: true,
    notes: 'red dominant',
  },
  gamma: {
    signAtSpot: 'positive_strong',
    dominantNodeStrike: 6005,
    dominantNodeMagnitudeB: 5.5,
    dominantNodeRatio: 12.3,
    floorStrike: 5990,
    ceilingStrike: 6020,
    overrideFires: true,
    notes: 'override',
  },
  delta: {
    blueBelowStrike: 5995,
    redAboveStrike: 6030,
    corridorWidth: 35,
    zoneBehavior: 'support_resistance',
    notes: 'support/resistance',
  },
  synthesis: {
    predictedClose: 6005,
    confidence: 'high',
    crossChartAgreement: 'all_agree',
    overrideApplied: true,
    trade: {
      type: 'iron_fly',
      centerStrike: 6005,
      wingWidth: 15,
      size: 'full',
    },
    headline: 'Pin at 6005, override fires',
    warnings: [],
  },
};

describe('buildTraceLiveSummary', () => {
  it('emits the load-bearing topology fields in pipe-delimited order', () => {
    const out = buildTraceLiveSummary({
      capturedAt: '2026-04-23T19:30:00Z',
      spot: 6005,
      stabilityPct: 67,
      analysis: baseAnalysis,
    });
    expect(out).toContain('ts:2026-04-23T19:30:00Z');
    expect(out).toContain('spot:6005.00');
    expect(out).toContain('stab:67.0');
    expect(out).toContain('regime:range_bound_positive_gamma');
    expect(out).toContain('gamma:positive_strong');
    expect(out).toContain('dom:6005@5.50B/12.3x');
    expect(out).toContain('override:true');
    expect(out).toContain('charm:red/short');
    expect(out).toContain('zone:support_resistance');
    expect(out).toContain('predict:6005.00');
    expect(out).toContain('trade:iron_fly/full');
  });

  it('omits stab segment when stabilityPct is null', () => {
    const out = buildTraceLiveSummary({
      capturedAt: 't',
      spot: 6000,
      stabilityPct: null,
      analysis: baseAnalysis,
    });
    expect(out).not.toContain('stab:');
  });

  it('encodes flip-flop and rejection-wicks markers when set', () => {
    const a: TraceAnalysis = {
      ...baseAnalysis,
      charm: {
        ...baseAnalysis.charm,
        flipFlopDetected: true,
        rejectionWicksAtRed: true,
      },
    };
    const out = buildTraceLiveSummary({
      capturedAt: 't',
      spot: 6000,
      stabilityPct: null,
      analysis: a,
    });
    expect(out).toContain('flipflop:true');
    expect(out).toContain('wicks:true');
  });

  it('encodes infinite ratio as "inf" when no neighbor exists', () => {
    const a: TraceAnalysis = {
      ...baseAnalysis,
      gamma: {
        ...baseAnalysis.gamma,
        dominantNodeRatio: null,
      },
    };
    const out = buildTraceLiveSummary({
      capturedAt: 't',
      spot: 6000,
      stabilityPct: null,
      analysis: a,
    });
    expect(out).toContain('@5.50B/inf');
  });

  it('omits dominant-node section when strike or magnitude is null', () => {
    const a: TraceAnalysis = {
      ...baseAnalysis,
      gamma: {
        ...baseAnalysis.gamma,
        dominantNodeStrike: null,
        dominantNodeMagnitudeB: null,
        dominantNodeRatio: null,
      },
    };
    const out = buildTraceLiveSummary({
      capturedAt: 't',
      spot: 6000,
      stabilityPct: null,
      analysis: a,
    });
    expect(out).not.toContain('dom:');
  });
});

describe('saveTraceLiveAnalysis', () => {
  beforeEach(() => {
    _resetDb();
    process.env.DATABASE_URL = 'postgresql://test';
    mockSql.mockReset();
    mockSql.transaction = vi.fn().mockResolvedValue([]);
  });

  const baseInput = {
    capturedAt: '2026-04-23T19:30:00Z',
    spot: 6005,
    stabilityPct: 67,
    analysis: baseAnalysis,
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 14_000,
    cacheWriteTokens: 0,
    durationMs: 4500,
  };

  it('inserts and returns the new row id with a non-null embedding', async () => {
    mockSql.mockResolvedValueOnce([{ id: 42 }]);
    const id = await saveTraceLiveAnalysis({
      ...baseInput,
      embedding: [0.1, 0.2, 0.3],
    });
    expect(id).toBe(42);
    // Verify the SQL call shape — the parameters arg is the second slot
    // of a tagged template call (mockSql receives strings + values).
    expect(mockSql).toHaveBeenCalledTimes(1);
    const callArgs = mockSql.mock.calls[0]!;
    // Tagged-template call shape: [TemplateStringsArray, ...values]
    const values = callArgs.slice(1);
    // The vector literal is one of the parameters, formatted as "[v1,v2,...]"
    expect(values).toContain('[0.1,0.2,0.3]');
  });

  it('passes null vector literal when embedding is null', async () => {
    mockSql.mockResolvedValueOnce([{ id: 43 }]);
    const id = await saveTraceLiveAnalysis({
      ...baseInput,
      embedding: null,
    });
    expect(id).toBe(43);
    const values = mockSql.mock.calls[0]!.slice(1);
    // Null embedding should pass through as JS null, which the
    // ${vectorLiteral}::vector expression renders as NULL::vector.
    expect(values).toContain(null);
  });

  it('passes null when embedding is an empty array', async () => {
    mockSql.mockResolvedValueOnce([{ id: 44 }]);
    await saveTraceLiveAnalysis({ ...baseInput, embedding: [] });
    const values = mockSql.mock.calls[0]!.slice(1);
    expect(values).toContain(null);
  });

  it('returns null on DB error and does not throw', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection lost'));
    const id = await saveTraceLiveAnalysis({
      ...baseInput,
      embedding: [0.1, 0.2],
    });
    expect(id).toBeNull();
  });

  it('returns null when INSERT returns no rows', async () => {
    mockSql.mockResolvedValueOnce([]);
    const id = await saveTraceLiveAnalysis({
      ...baseInput,
      embedding: null,
    });
    expect(id).toBeNull();
  });

  it('serializes the analysis as a JSON string for the jsonb cast', async () => {
    mockSql.mockResolvedValueOnce([{ id: 1 }]);
    await saveTraceLiveAnalysis({ ...baseInput, embedding: null });
    const values = mockSql.mock.calls[0]!.slice(1);
    const jsonStringValue = values.find(
      (v) => typeof v === 'string' && v.startsWith('{') && v.includes('regime'),
    );
    expect(jsonStringValue).toBeDefined();
    // round-trip: the serialized payload must parse back to the analysis
    expect(JSON.parse(jsonStringValue as string).regime).toBe(
      'range_bound_positive_gamma',
    );
  });
});
