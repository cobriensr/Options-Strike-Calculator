import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SkeletonSection from '../../components/SkeletonSection';

// ============================================================
// RENDERING — DEFAULT PROPS
// ============================================================

describe('SkeletonSection: renders with default props', () => {
  it('container has aria-busy="true"', () => {
    const { container } = render(<SkeletonSection />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('aria-busy', 'true');
  });

  it('renders 4 content bars + 1 header bar', () => {
    const { container } = render(<SkeletonSection />);
    const barContainer = container.querySelector('.flex.flex-col');
    expect(barContainer?.children).toHaveLength(4);

    // Header bar is a sibling (the rounded-full pill)
    const header = container.querySelector('.rounded-full');
    expect(header).toBeInTheDocument();
  });
});

// ============================================================
// RENDERING — CUSTOM LINE COUNT
// ============================================================

describe('SkeletonSection: renders custom line count', () => {
  it('lines={6} renders 6 content bars', () => {
    const { container } = render(<SkeletonSection lines={6} />);
    const barContainer = container.querySelector('.flex.flex-col');
    expect(barContainer?.children).toHaveLength(6);
  });
});

// ============================================================
// RENDERING — TALL PROP
// ============================================================

describe('SkeletonSection: tall prop adds extra bars', () => {
  it('tall={true} with default lines renders 8 bars (4 + 4)', () => {
    const { container } = render(<SkeletonSection tall />);
    const barContainer = container.querySelector('.flex.flex-col');
    expect(barContainer?.children).toHaveLength(8);
  });
});

// ============================================================
// RENDERING — TALL WITH CUSTOM LINES
// ============================================================

describe('SkeletonSection: tall with custom lines', () => {
  it('lines={3} tall={true} renders 7 bars (3 + 4)', () => {
    const { container } = render(<SkeletonSection lines={3} tall />);
    const barContainer = container.querySelector('.flex.flex-col');
    expect(barContainer?.children).toHaveLength(7);
  });
});

// ============================================================
// ANIMATION — PULSE CLASS
// ============================================================

describe('SkeletonSection: bars have animate-pulse', () => {
  it('all skeleton bars have the animate-pulse class', () => {
    const { container } = render(<SkeletonSection />);

    // Header bar
    const header = container.querySelector('.rounded-full');
    expect(header).toHaveClass('animate-pulse');

    // Content bars
    const barContainer = container.querySelector('.flex.flex-col');
    const bars = barContainer?.children ?? [];
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar).toHaveClass('animate-pulse');
    }
  });
});

// ============================================================
// ANIMATION — STAGGERED DELAYS
// ============================================================

describe('SkeletonSection: bars have staggered delays', () => {
  it('animation delays are sequential (0ms, 80ms, 160ms, 240ms)', () => {
    const { container } = render(<SkeletonSection />);
    const barContainer = container.querySelector('.flex.flex-col');
    const bars = barContainer?.children ?? [];

    expect(bars[0]).toHaveStyle({ animationDelay: '0ms' });
    expect(bars[1]).toHaveStyle({ animationDelay: '80ms' });
    expect(bars[2]).toHaveStyle({ animationDelay: '160ms' });
    expect(bars[3]).toHaveStyle({ animationDelay: '240ms' });
  });

  it('stagger continues for tall sections', () => {
    const { container } = render(<SkeletonSection tall />);
    const barContainer = container.querySelector('.flex.flex-col');
    const bars = barContainer?.children ?? [];

    // Spot-check first and last bars
    expect(bars[0]).toHaveStyle({ animationDelay: '0ms' });
    expect(bars[7]).toHaveStyle({ animationDelay: '560ms' });
  });
});
