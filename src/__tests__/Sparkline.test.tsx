import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline } from '../components/Gexbot/Sparkline';

describe('<Sparkline>', () => {
  it('renders the dashed fallback line when values is empty', () => {
    const { container } = render(<Sparkline values={[]} />);
    const line = container.querySelector('line[stroke-dasharray]');
    expect(line).not.toBeNull();
    // Empty case: no path element rendered.
    expect(container.querySelector('path')).toBeNull();
  });

  it('renders the dashed fallback line for a single-value series', () => {
    const { container } = render(<Sparkline values={[1.2]} />);
    expect(container.querySelector('line[stroke-dasharray]')).not.toBeNull();
    expect(container.querySelector('path')).toBeNull();
  });

  it('renders an SVG path for a series with ≥2 values', () => {
    const { container } = render(<Sparkline values={[1.0, 1.1, 1.2]} />);
    const path = container.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('d')).toMatch(/^M.*L.*L/);
  });

  it('survives a constant series (range=0) without dividing by zero', () => {
    const { container } = render(<Sparkline values={[1.0, 1.0, 1.0, 1.0]} />);
    const path = container.querySelector('path');
    expect(path).not.toBeNull();
    // All points clamp to the same y; the path d-string should contain
    // no NaN tokens.
    expect(path?.getAttribute('d')).not.toMatch(/NaN/);
  });

  it('applies the strokeClass to the svg element', () => {
    const { container } = render(
      <Sparkline values={[1.0, 1.1, 1.2]} strokeClass="text-emerald-300" />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/text-emerald-300/);
  });

  it('respects custom width/height props', () => {
    const { container } = render(
      <Sparkline values={[1, 2, 3]} width={120} height={40} />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('120');
    expect(svg?.getAttribute('height')).toBe('40');
  });
});
