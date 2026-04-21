/**
 * RegimeFlipStrip tests — dot count, color by regime, empty state, and
 * tail-trimming behavior.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegimeFlipStrip } from '../../../components/FuturesGammaPlaybook/RegimeFlipStrip';
import type { RegimeTimelinePoint } from '../../../components/FuturesGammaPlaybook/types';

function makePoint(
  ts: string,
  regime: RegimeTimelinePoint['regime'],
): RegimeTimelinePoint {
  return { ts, regime, netGex: 0, spot: 5800 };
}

describe('RegimeFlipStrip', () => {
  it('renders a placeholder when the timeline is empty', () => {
    render(<RegimeFlipStrip timeline={[]} />);
    const group = screen.getByRole('group', { name: /regime flip history/i });
    expect(group).toBeInTheDocument();
    expect(group).toHaveTextContent(/no intraday history yet/i);
  });

  it('renders one dot per timeline point when count is not exceeded', () => {
    const tl = [
      makePoint('2026-04-21T14:00:00Z', 'POSITIVE'),
      makePoint('2026-04-21T14:05:00Z', 'TRANSITIONING'),
      makePoint('2026-04-21T14:10:00Z', 'NEGATIVE'),
    ];
    render(<RegimeFlipStrip timeline={tl} count={12} />);
    const dots = screen.getAllByLabelText(/(POSITIVE|NEGATIVE|TRANSITIONING)/i);
    expect(dots).toHaveLength(3);
  });

  it('limits rendered dots to the trailing `count` points', () => {
    const tl: RegimeTimelinePoint[] = Array.from({ length: 20 }, (_, i) =>
      makePoint(
        `2026-04-21T14:${String(i).padStart(2, '0')}:00Z`,
        i % 2 === 0 ? 'POSITIVE' : 'TRANSITIONING',
      ),
    );
    render(<RegimeFlipStrip timeline={tl} count={5} />);
    const dots = screen.getAllByLabelText(/(POSITIVE|NEGATIVE|TRANSITIONING)/i);
    expect(dots).toHaveLength(5);
  });

  it('defaults to 12 trailing dots when count is not provided', () => {
    const tl: RegimeTimelinePoint[] = Array.from({ length: 30 }, (_, i) =>
      makePoint(`2026-04-21T14:${String(i).padStart(2, '0')}:00Z`, 'POSITIVE'),
    );
    render(<RegimeFlipStrip timeline={tl} />);
    const dots = screen.getAllByLabelText(/POSITIVE/i);
    expect(dots).toHaveLength(12);
  });

  it('applies regime-specific dot colors', () => {
    const tl = [
      makePoint('2026-04-21T14:00:00Z', 'POSITIVE'),
      makePoint('2026-04-21T14:05:00Z', 'NEGATIVE'),
      makePoint('2026-04-21T14:10:00Z', 'TRANSITIONING'),
    ];
    render(<RegimeFlipStrip timeline={tl} />);
    const [pos] = screen.getAllByLabelText(/POSITIVE/i);
    const [neg] = screen.getAllByLabelText(/NEGATIVE/i);
    const [trans] = screen.getAllByLabelText(/TRANSITIONING/i);
    expect(pos?.className).toMatch(/emerald/);
    expect(neg?.className).toMatch(/amber/);
    expect(trans?.className).toMatch(/white\/20/);
  });
});
