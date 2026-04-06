import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import VvixCard from '../../components/VIXTermStructure/VvixCard';
import { theme } from '../../themes';
import type { VvixResult } from '../../components/VIXTermStructure/classifiers';

function makeResult(overrides: Partial<VvixResult> = {}): VvixResult {
  return {
    value: 95,
    signal: 'normal',
    label: 'NORMAL',
    color: theme.accent,
    advice: 'Standard VIX volatility. No additional signal.',
    ...overrides,
  };
}

// ============================================================
// RENDERING
// ============================================================

describe('VvixCard: rendering', () => {
  it('renders the VVIX value formatted to one decimal', () => {
    render(<VvixCard result={makeResult({ value: 95.37 })} />);
    expect(screen.getByText('95.4')).toBeInTheDocument();
  });

  it('renders the signal label badge', () => {
    render(<VvixCard result={makeResult({ label: 'UNSTABLE' })} />);
    expect(screen.getByText('UNSTABLE')).toBeInTheDocument();
  });

  it('renders the advice text', () => {
    render(
      <VvixCard
        result={makeResult({
          advice: 'VIX could spike mid-session. Tighten deltas or reduce size.',
        })}
      />,
    );
    expect(screen.getByText(/VIX could spike mid-session/)).toBeInTheDocument();
  });

  it('renders the VVIX title and subtitle', () => {
    render(<VvixCard result={makeResult()} />);
    expect(screen.getByText('VVIX')).toBeInTheDocument();
    expect(screen.getByText('Volatility of VIX')).toBeInTheDocument();
  });

  it('renders the scale labels (60 through 140)', () => {
    render(<VvixCard result={makeResult()} />);
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('140')).toBeInTheDocument();
  });
});

// ============================================================
// BAR WIDTH
// ============================================================

describe('VvixCard: bar visualization', () => {
  it('clamps bar at 0% for values at or below 60', () => {
    const { container } = render(
      <VvixCard result={makeResult({ value: 50 })} />,
    );
    const bar = container.querySelector(
      '[style*="width"]',
    ) as HTMLElement | null;
    expect(bar?.style.width).toBe('0%');
  });

  it('clamps bar at 100% for values at or above 140', () => {
    const { container } = render(
      <VvixCard result={makeResult({ value: 160 })} />,
    );
    const bar = container.querySelector(
      '[style*="width"]',
    ) as HTMLElement | null;
    expect(bar?.style.width).toBe('100%');
  });

  it('calculates correct bar width for value 100 (50%)', () => {
    const { container } = render(
      <VvixCard result={makeResult({ value: 100 })} />,
    );
    const bar = container.querySelector(
      '[style*="width"]',
    ) as HTMLElement | null;
    expect(bar?.style.width).toBe('50%');
  });
});

// ============================================================
// SIGNAL VARIANTS
// ============================================================

describe('VvixCard: signal variants', () => {
  it('renders calm/stable state', () => {
    render(
      <VvixCard
        result={makeResult({
          value: 72,
          signal: 'calm',
          label: 'STABLE',
          color: theme.green,
        })}
      />,
    );
    expect(screen.getByText('STABLE')).toBeInTheDocument();
    expect(screen.getByText('72.0')).toBeInTheDocument();
  });

  it('renders extreme/danger state', () => {
    render(
      <VvixCard
        result={makeResult({
          value: 135,
          signal: 'extreme',
          label: 'DANGER',
          color: theme.red,
        })}
      />,
    );
    expect(screen.getByText('DANGER')).toBeInTheDocument();
    expect(screen.getByText('135.0')).toBeInTheDocument();
  });
});
