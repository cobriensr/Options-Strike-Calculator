import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ResultsSection from '../components/ResultsSection';
import { lightTheme } from '../themes';
import type { CalculationResults, DeltaRow } from '../types';

const th = lightTheme;

function makeDeltaRow(delta: 5 | 8 | 10 | 12 | 15 | 20 = 10): DeltaRow {
  return {
    delta,
    z: 1.28,
    putStrike: 5630.5,
    callStrike: 5769.5,
    putSnapped: 5630,
    callSnapped: 5770,
    putSpySnapped: 563,
    callSpySnapped: 577,
    spyPut: '563',
    spyCall: '577',
    putDistance: 69.5,
    callDistance: 69.5,
    putPct: '1.22%',
    callPct: '1.22%',
    putPremium: 1.85,
    callPremium: 1.72,
    putSigma: 0.2,
    callSigma: 0.18,
    basePutSigma: 0.19,
    baseCallSigma: 0.17,
    putActualDelta: 0.098,
    callActualDelta: 0.095,
    putGamma: 0.0012,
    callGamma: 0.0011,
    putTheta: -1500,
    callTheta: -1400,
    ivAccelMult: 1,
  };
}

function makeResults(): CalculationResults {
  return {
    allDeltas: [makeDeltaRow(5), makeDeltaRow(10)],
    sigma: 0.23,
    T: 0.003,
    hoursRemaining: 4.87,
    spot: 5700,
  };
}

describe('ResultsSection', () => {
  it('shows placeholder when no results', () => {
    render(
      <ResultsSection
        th={th}
        results={null}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(
      screen.getByText(/Enter SPY spot price, time, and IV/),
    ).toBeInTheDocument();
  });

  it('shows results section when results exist', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.getByText('All Delta Strikes')).toBeInTheDocument();
  });

  it('renders parameter summary', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.getByText('SPY Spot')).toBeInTheDocument();
    expect(screen.getByText('σ (IV)')).toBeInTheDocument();
  });

  it('renders delta strikes table', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(
      screen.getByRole('table', { name: 'Strike prices by delta' }),
    ).toBeInTheDocument();
  });

  it('does not show IC section when showIC is false', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.queryByText(/Iron Condor/)).not.toBeInTheDocument();
  });

  it('shows IC section when showIC is true', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={true}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.getByText(/Iron Condor \(10-pt wings\)/)).toBeInTheDocument();
  });

  it('shows skew disclaimer when skewPct > 0', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={3}
      />,
    );
    expect(screen.getByText(/Put skew: \+3%/)).toBeInTheDocument();
  });

  it('does not show skew disclaimer when skewPct is 0', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10}
        spxDirectActive={false}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.queryByText(/Put skew:/)).not.toBeInTheDocument();
  });

  it('shows derived label when spxDirectActive', () => {
    render(
      <ResultsSection
        th={th}
        results={makeResults()}
        effectiveRatio={10.0134}
        spxDirectActive={true}
        showIC={false}
        wingWidth={10}
        contracts={1}
        skewPct={0}
      />,
    );
    expect(screen.getByText(/derived/)).toBeInTheDocument();
  });
});
