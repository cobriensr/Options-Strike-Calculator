import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseAndValidateTraceAnalysis } from '../_lib/trace-live-parse.js';
import type { TraceAnalysis } from '../_lib/trace-live-types.js';

vi.mock('../_lib/logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const minimal: TraceAnalysis = {
  timestamp: '2026-04-23T19:30:00Z',
  spot: 6005,
  stabilityPct: 67,
  regime: 'range_bound_positive_gamma',
  charm: {
    predominantColor: 'blue',
    direction: 'long',
    junctionStrike: 6000,
    flipFlopDetected: false,
    rejectionWicksAtRed: false,
    notes: 'stable blue dominant',
  },
  gamma: {
    signAtSpot: 'positive_strong',
    dominantNodeStrike: 6005,
    dominantNodeMagnitudeB: 5.5,
    dominantNodeRatio: 12.3,
    floorStrike: 5990,
    ceilingStrike: 6020,
    overrideFires: true,
    notes: 'override fires at 6005',
  },
  delta: {
    blueBelowStrike: 5990,
    redAboveStrike: 6020,
    corridorWidth: 30,
    zoneBehavior: 'support_resistance',
    notes: '+γ corridor',
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
    headline: 'Pin at 6005, gamma override fires',
    warnings: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseAndValidateTraceAnalysis', () => {
  it('returns null for empty input', () => {
    expect(parseAndValidateTraceAnalysis('')).toBeNull();
  });

  it('parses raw JSON without fences', () => {
    const text = JSON.stringify(minimal);
    const result = parseAndValidateTraceAnalysis(text);
    expect(result).not.toBeNull();
    expect(result!.regime).toBe('range_bound_positive_gamma');
    expect(result!.synthesis.trade.type).toBe('iron_fly');
  });

  it('strips ```json fences before parsing', () => {
    const text = '```json\n' + JSON.stringify(minimal) + '\n```';
    const result = parseAndValidateTraceAnalysis(text);
    expect(result).not.toBeNull();
    expect(result!.spot).toBe(6005);
  });

  it('strips bare ``` fences', () => {
    const text = '```\n' + JSON.stringify(minimal) + '\n```';
    expect(parseAndValidateTraceAnalysis(text)).not.toBeNull();
  });

  it('tolerates leading and trailing whitespace', () => {
    const text = '   \n  ' + JSON.stringify(minimal) + '\n\n  ';
    expect(parseAndValidateTraceAnalysis(text)).not.toBeNull();
  });

  it('returns null on invalid JSON syntax', () => {
    expect(parseAndValidateTraceAnalysis('{not valid json')).toBeNull();
  });

  it('returns null when JSON parses but fails Zod schema (missing required field)', () => {
    const broken: Partial<TraceAnalysis> = { ...minimal };
    delete (broken as Record<string, unknown>).synthesis;
    expect(parseAndValidateTraceAnalysis(JSON.stringify(broken))).toBeNull();
  });

  it('returns null when an enum field has an unknown value', () => {
    const bad = {
      ...minimal,
      synthesis: { ...minimal.synthesis, confidence: 'bogus_level' },
    };
    expect(parseAndValidateTraceAnalysis(JSON.stringify(bad))).toBeNull();
  });
});
