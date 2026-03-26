import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeltaStrikesTable from '../../components/DeltaStrikesTable';
import type { DeltaRow, DeltaRowError } from '../../types';


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

describe('DeltaStrikesTable', () => {
  it('renders the table with aria-label', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(
      screen.getByRole('table', { name: 'Strike prices by delta' }),
    ).toBeInTheDocument();
  });

  it('renders column headers', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(screen.getByText('Delta')).toBeInTheDocument();
    expect(screen.getByText(/Put \(SPX\)/)).toBeInTheDocument();
    expect(screen.getByText(/Call \(SPX\)/)).toBeInTheDocument();
    expect(screen.getByText('Width')).toBeInTheDocument();
  });

  it('renders a data row with strike values', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(screen.getByText('5630')).toBeInTheDocument();
    expect(screen.getByText('5770')).toBeInTheDocument();
    expect(screen.getByText('563')).toBeInTheDocument();
    expect(screen.getByText('577')).toBeInTheDocument();
  });

  it('renders delta label with delta symbol', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow(10)]} spot={5700} />,
    );
    expect(screen.getByText(/10\u0394/)).toBeInTheDocument();
  });

  it('renders premium values', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(screen.getByText('1.85')).toBeInTheDocument();
    expect(screen.getByText('1.72')).toBeInTheDocument();
  });

  it('renders width with percentage', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(screen.getByText('139')).toBeInTheDocument(); // callStrike - putStrike
  });

  it('skips error rows', () => {
    const errorRow: DeltaRowError = { delta: 5, error: 'Too far OTM' };
    render(
      <DeltaStrikesTable
        allDeltas={[errorRow, makeDeltaRow(10)]}
        spot={5700}
      />,
    );
    // Should only render the valid row
    expect(screen.getByText(/10\u0394/)).toBeInTheDocument();
    expect(screen.queryByText(/5\u0394/)).not.toBeInTheDocument();
  });

  it('renders multiple rows', () => {
    render(
      <DeltaStrikesTable
        allDeltas={[makeDeltaRow(5), makeDeltaRow(10), makeDeltaRow(15)]}
        spot={5700}
      />,
    );
    expect(screen.getByText(/^5\u0394$/)).toBeInTheDocument();
    expect(screen.getByText(/^10\u0394$/)).toBeInTheDocument();
    expect(screen.getByText(/^15\u0394$/)).toBeInTheDocument();
  });

  it('renders empty table when no deltas', () => {
    render(<DeltaStrikesTable allDeltas={[]} spot={5700} />);
    expect(
      screen.getByRole('table', { name: 'Strike prices by delta' }),
    ).toBeInTheDocument();
  });

  // ── IV acceleration indicator ─────────────────────────────

  it('does not show IV acceleration indicator when ivAccelMult is 1.0', () => {
    render(
      <DeltaStrikesTable allDeltas={[makeDeltaRow()]} spot={5700} />,
    );
    expect(screen.queryByText(/IV acceleration/)).not.toBeInTheDocument();
  });

  it('does not show IV acceleration indicator when ivAccelMult is barely above 1', () => {
    const row = { ...makeDeltaRow(), ivAccelMult: 1.005 };
    render(<DeltaStrikesTable allDeltas={[row]} spot={5700} />);
    expect(screen.queryByText(/IV acceleration/)).not.toBeInTheDocument();
  });

  it('shows IV acceleration indicator for mild acceleration (1.01 < mult <= 1.08)', () => {
    const row = { ...makeDeltaRow(), ivAccelMult: 1.05 };
    render(<DeltaStrikesTable allDeltas={[row]} spot={5700} />);
    expect(screen.getByText(/IV acceleration/)).toBeInTheDocument();
    expect(screen.getByText(/1\.05/)).toBeInTheDocument();
  });

  it('shows IV acceleration indicator for moderate acceleration (1.08 < mult <= 1.2)', () => {
    const row = { ...makeDeltaRow(), ivAccelMult: 1.15 };
    render(<DeltaStrikesTable allDeltas={[row]} spot={5700} />);
    expect(screen.getByText(/IV acceleration/)).toBeInTheDocument();
    expect(screen.getByText(/1\.15/)).toBeInTheDocument();
  });

  it('shows late session warning for high acceleration (mult > 1.2)', () => {
    const row = { ...makeDeltaRow(), ivAccelMult: 1.45 };
    render(<DeltaStrikesTable allDeltas={[row]} spot={5700} />);
    expect(screen.getByText(/IV acceleration/)).toBeInTheDocument();
    expect(screen.getByText(/Late session/)).toBeInTheDocument();
    expect(screen.getByText(/1\.45/)).toBeInTheDocument();
  });

  it('does not show late session text for moderate acceleration', () => {
    const row = { ...makeDeltaRow(), ivAccelMult: 1.1 };
    render(<DeltaStrikesTable allDeltas={[row]} spot={5700} />);
    expect(screen.getByText(/IV acceleration/)).toBeInTheDocument();
    expect(screen.queryByText(/Late session/)).not.toBeInTheDocument();
  });
});
