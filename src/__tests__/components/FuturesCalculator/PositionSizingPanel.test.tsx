import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PositionSizingPanel } from '../../../components/FuturesCalculator/PositionSizingPanel';
import type { PositionSize } from '../../../components/FuturesCalculator/useFuturesCalc';

function defaultProps(
  overrides: Partial<Parameters<typeof PositionSizingPanel>[0]> = {},
) {
  const positionSize: PositionSize = {
    contracts: 3,
    riskPerContract: 250,
    maxRisk: 1000,
  };
  return {
    positionSize,
    account: 50_000,
    riskPct: 2,
    ...overrides,
  };
}

describe('PositionSizingPanel — static labels', () => {
  it('renders the "Position Sizing" section heading', () => {
    render(<PositionSizingPanel {...defaultProps()} />);
    expect(screen.getByText('Position Sizing')).toBeInTheDocument();
  });

  it('renders the budget row with riskPct and account interpolated into the label', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({ account: 50_000, riskPct: 2 })}
      />,
    );
    expect(
      screen.getByText('Budget (2.00% of $50,000.00)'),
    ).toBeInTheDocument();
  });

  it('renders the risk-per-contract row label', () => {
    render(<PositionSizingPanel {...defaultProps()} />);
    expect(
      screen.getByText('Risk per contract (stop loss + fees)'),
    ).toBeInTheDocument();
  });

  it('renders the Max contracts row label', () => {
    render(<PositionSizingPanel {...defaultProps()} />);
    expect(screen.getByText('Max contracts')).toBeInTheDocument();
  });
});

describe('PositionSizingPanel — values formatting', () => {
  it('formats the maxRisk budget value as dollars', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 2,
            riskPerContract: 500,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
  });

  it('formats the riskPerContract value as dollars', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 2,
            riskPerContract: 425.5,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(screen.getByText('$425.50')).toBeInTheDocument();
  });
});

describe('PositionSizingPanel — contracts > 0 branch', () => {
  it('shows plural "contracts" when positionSize.contracts > 1', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 5,
            riskPerContract: 200,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(screen.getByText('5 contracts')).toBeInTheDocument();
  });

  it('shows singular "contract" when positionSize.contracts === 1', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 1,
            riskPerContract: 1000,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(screen.getByText('1 contract')).toBeInTheDocument();
  });
});

describe('PositionSizingPanel — budget too small branch', () => {
  it('shows budget-too-small message when contracts is 0', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 0,
            riskPerContract: 5000,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(
      screen.getByText('budget too small for 1 contract'),
    ).toBeInTheDocument();
  });

  it('does not show any "X contracts" text when contracts is 0', () => {
    render(
      <PositionSizingPanel
        {...defaultProps({
          positionSize: {
            contracts: 0,
            riskPerContract: 5000,
            maxRisk: 1000,
          },
        })}
      />,
    );
    expect(screen.queryByText(/^\d+ contract/)).not.toBeInTheDocument();
  });
});
