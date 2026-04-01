import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import DirectionalOpportunity from '../../components/ChartAnalysis/DirectionalOpportunity';

// ============================================================
// FACTORY
// ============================================================

function makeDirectional(
  overrides: Partial<{
    direction: 'LONG CALL' | 'LONG PUT';
    confidence: string;
    reasoning: string;
    entryTiming: string;
    stopLoss: string;
    profitTarget: string;
    keyLevels: {
      support: string | null;
      resistance: string | null;
      vwap: string | null;
    };
    signals: string[];
  }> = {},
) {
  return {
    direction: 'LONG CALL' as const,
    confidence: 'HIGH',
    reasoning: 'Strong bullish momentum with expanding volume',
    entryTiming: 'Wait for pullback to 5680 VWAP level',
    stopLoss: 'Close below 5660 (-0.7%)',
    profitTarget: 'Target 5750 (+0.9%)',
    keyLevels: {
      support: '5680 (VWAP)',
      resistance: '5750 (prior high)',
      vwap: '5685',
    },
    signals: ['Bullish flow confirmation', 'GEX supportive'],
    ...overrides,
  };
}

// ============================================================
// TESTS
// ============================================================

describe('DirectionalOpportunity', () => {
  it('renders the Directional Opportunity title', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(
      screen.getByText('Directional Opportunity'),
    ).toBeInTheDocument();
  });

  it('shows the LONG CALL direction badge', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('LONG CALL')).toBeInTheDocument();
  });

  it('shows LONG PUT direction when direction is LONG PUT', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional({
          direction: 'LONG PUT',
        })}
      />,
    );
    expect(screen.getByText('LONG PUT')).toBeInTheDocument();
  });

  it('shows the confidence badge', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });

  it('shows the 14 DTE ATM label', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('14 DTE ATM')).toBeInTheDocument();
  });

  it('shows the reasoning text', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(
      screen.getByText(
        'Strong bullish momentum with expanding volume',
      ),
    ).toBeInTheDocument();
  });

  it('shows the Entry field with timing text', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('Entry:')).toBeInTheDocument();
    expect(
      screen.getByText('Wait for pullback to 5680 VWAP level'),
    ).toBeInTheDocument();
  });

  it('shows the Stop field with stop loss text', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('Stop:')).toBeInTheDocument();
    expect(
      screen.getByText('Close below 5660 (-0.7%)'),
    ).toBeInTheDocument();
  });

  it('shows the Target field with profit target text', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('Target:')).toBeInTheDocument();
    expect(
      screen.getByText('Target 5750 (+0.9%)'),
    ).toBeInTheDocument();
  });

  it('shows the Key Levels section when at least one level is set', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional({
          keyLevels: {
            support: '5680 (VWAP)',
            resistance: null,
            vwap: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Key Levels')).toBeInTheDocument();
  });

  it('shows the support level', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('Support:')).toBeInTheDocument();
    expect(screen.getByText('5680 (VWAP)')).toBeInTheDocument();
  });

  it('shows the resistance level', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('Resistance:')).toBeInTheDocument();
    expect(
      screen.getByText('5750 (prior high)'),
    ).toBeInTheDocument();
  });

  it('shows the VWAP level', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(screen.getByText('VWAP:')).toBeInTheDocument();
    expect(screen.getByText('5685')).toBeInTheDocument();
  });

  it('hides Key Levels section when all keyLevels are null', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional({
          keyLevels: {
            support: null,
            resistance: null,
            vwap: null,
          },
        })}
      />,
    );
    expect(screen.queryByText('Key Levels')).not.toBeInTheDocument();
  });

  it('shows confirming signals when signals array has items', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(
      screen.getByText('Bullish flow confirmation'),
    ).toBeInTheDocument();
    expect(screen.getByText('GEX supportive')).toBeInTheDocument();
  });

  it('hides confirming signals when signals array is empty', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional({ signals: [] })}
      />,
    );
    expect(
      screen.queryByText('Confirming Signals'),
    ).not.toBeInTheDocument();
  });

  it('shows the Confirming Signals heading', () => {
    render(
      <DirectionalOpportunity
        directionalOpportunity={makeDirectional()}
      />,
    );
    expect(
      screen.getByText('Confirming Signals'),
    ).toBeInTheDocument();
  });
});
