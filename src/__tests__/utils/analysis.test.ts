import { describe, it, expect } from 'vitest';
import { buildPreviousRecommendation } from '../../utils/analysis';
import type { AnalysisResult } from '../../components/ChartAnalysis/types';

/** Helper to build a minimal valid AnalysisResult for testing */
function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    mode: 'entry',
    structure: 'Iron Condor',
    confidence: 'high',
    suggestedDelta: 10,
    reasoning: 'Low VIX environment with range-bound price action',
    observations: [],
    risks: [],
    structureRationale: 'Standard IC',
    ...overrides,
  };
}

describe('buildPreviousRecommendation', () => {
  it('includes structure, delta, confidence, and reasoning for a basic result', () => {
    const result = makeResult();
    const output = buildPreviousRecommendation(result);

    expect(output).toContain('Structure: Iron Condor');
    expect(output).toContain('Delta: 10');
    expect(output).toContain('Confidence: high');
    expect(output).toContain(
      'Reasoning: Low VIX environment with range-bound price action',
    );
  });

  it('includes all fields when fully populated', () => {
    const result = makeResult({
      entryPlan: {
        entry1: {
          structure: 'IC',
          delta: 8,
          timing: '10:15 AM',
          sizePercent: 50,
          note: 'first tranche',
        },
      },
      hedge: {
        recommendation: 'Buy 2-delta put',
        description: '1x SPX 5700P',
        rationale: 'tail risk protection',
        estimatedCost: '$1.20',
      },
      managementRules: {
        profitTarget: '50% of max credit',
        stopConditions: ['VIX spikes above 20', 'SPX breaches short strike'],
      },
    });

    const output = buildPreviousRecommendation(result);

    expect(output).toContain('Entry 1: IC 8');
    expect(output).toContain('at 10:15 AM');
    expect(output).toContain('Hedge: Buy 2-delta put');
    expect(output).toContain('1x SPX 5700P');
    expect(output).toContain('Profit target: 50% of max credit');
    expect(output).toContain(
      'Stop conditions: VIX spikes above 20; SPX breaches short strike',
    );
  });

  it('omits entry plan section when entryPlan is missing', () => {
    const result = makeResult({ entryPlan: undefined });
    const output = buildPreviousRecommendation(result);

    expect(output).not.toContain('Entry 1:');
  });

  it('omits hedge section when hedge is null', () => {
    const result = makeResult({ hedge: null });
    const output = buildPreviousRecommendation(result);

    expect(output).not.toContain('Hedge:');
  });

  it('omits management rules when managementRules is null', () => {
    const result = makeResult({ managementRules: null });
    const output = buildPreviousRecommendation(result);

    expect(output).not.toContain('Profit target');
    expect(output).not.toContain('Stop conditions');
  });

  it('omits entry plan section when entryPlan.entry1 is undefined', () => {
    const result = makeResult({ entryPlan: {} });
    const output = buildPreviousRecommendation(result);

    expect(output).not.toContain('Entry 1:');
  });

  it('uses condition field when timing is absent on entry1', () => {
    const result = makeResult({
      entryPlan: {
        entry1: {
          structure: 'IC',
          delta: 12,
          condition: 'after opening range confirms',
          sizePercent: 33,
          note: '',
        },
      },
    });

    const output = buildPreviousRecommendation(result);

    expect(output).toContain('Entry 1: IC 12');
    expect(output).toContain('at after opening range confirms');
  });

  it('prefers timing over condition when both are present', () => {
    const result = makeResult({
      entryPlan: {
        entry1: {
          structure: 'IC',
          delta: 10,
          timing: '10:30 AM',
          condition: 'should not appear',
          sizePercent: 50,
          note: '',
        },
      },
    });

    const output = buildPreviousRecommendation(result);

    expect(output).toContain('at 10:30 AM');
    expect(output).not.toContain('should not appear');
  });

  it('joins all parts with period-space separator', () => {
    const result = makeResult();
    const output = buildPreviousRecommendation(result);
    const parts = output.split('. ');

    // At minimum: structure line + reasoning line
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('includes profitTarget but not stopConditions when only profitTarget is set', () => {
    const result = makeResult({
      managementRules: {
        profitTarget: '40% credit',
      },
    });

    const output = buildPreviousRecommendation(result);

    expect(output).toContain('Profit target: 40% credit');
    expect(output).not.toContain('Stop conditions');
  });

  it('includes stopConditions but not profitTarget when only stopConditions is set', () => {
    const result = makeResult({
      managementRules: {
        stopConditions: ['Delta exceeds 30'],
      },
    });

    const output = buildPreviousRecommendation(result);

    expect(output).not.toContain('Profit target');
    expect(output).toContain('Stop conditions: Delta exceeds 30');
  });
});
