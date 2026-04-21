/**
 * RegimeTimeline tests — presentation only.
 *
 * Focus on the SVG shell: empty state, regime band counts, zero-gamma
 * crossing counts, and the scrubbed-indicator visibility toggle. The
 * time-to-x math is simple linear interpolation — no separate unit test.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegimeTimeline } from '../../../components/FuturesGammaPlaybook/RegimeTimeline';
import type {
  RegimeTimelinePoint,
  SessionPhaseBoundariesCt,
} from '../../../components/FuturesGammaPlaybook/types';

const BOUNDARIES: SessionPhaseBoundariesCt = {
  open: '2026-04-20T09:30:00-04:00',
  lunch: '2026-04-20T12:30:00-04:00',
  power: '2026-04-20T15:30:00-04:00',
  close: '2026-04-20T16:30:00-04:00',
};

function makePoint(
  ts: string,
  regime: RegimeTimelinePoint['regime'],
  spot = 5800,
  netGex = 0,
): RegimeTimelinePoint {
  return { ts, regime, spot, netGex };
}

describe('RegimeTimeline', () => {
  it('renders the empty state when timeline is empty', () => {
    render(
      <RegimeTimeline
        timeline={[]}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed={false}
        scrubbedTimestamp={null}
      />,
    );
    expect(screen.getByText(/Regime timeline loading/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Waiting for session history/i),
    ).toBeInTheDocument();
  });

  it('renders one regime band per contiguous regime run', () => {
    const timeline = [
      makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
      makePoint('2026-04-20T13:35:00Z', 'POSITIVE'),
      makePoint('2026-04-20T13:40:00Z', 'NEGATIVE'),
      makePoint('2026-04-20T13:45:00Z', 'NEGATIVE'),
      makePoint('2026-04-20T13:50:00Z', 'TRANSITIONING'),
    ];
    const { container } = render(
      <RegimeTimeline
        timeline={timeline}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed={false}
        scrubbedTimestamp={null}
      />,
    );
    // 3 contiguous regime runs: POSITIVE → NEGATIVE → TRANSITIONING.
    const bands = container.querySelectorAll(
      '[data-testid="regime-bands"] rect',
    );
    expect(bands).toHaveLength(3);
  });

  it('renders a zero-gamma crossing line for each regime change', () => {
    const timeline = [
      makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
      makePoint('2026-04-20T13:35:00Z', 'NEGATIVE'),
      makePoint('2026-04-20T13:40:00Z', 'POSITIVE'),
    ];
    const { container } = render(
      <RegimeTimeline
        timeline={timeline}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed={false}
        scrubbedTimestamp={null}
      />,
    );
    // 2 regime changes → 2 crossings.
    const crossings = container.querySelectorAll('[data-testid="zg-crossing"]');
    expect(crossings).toHaveLength(2);
  });

  it('does not render a scrub indicator when isScrubbed is false', () => {
    const timeline = [makePoint('2026-04-20T13:30:00Z', 'POSITIVE')];
    const { container } = render(
      <RegimeTimeline
        timeline={timeline}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed={false}
        scrubbedTimestamp="2026-04-20T13:30:00Z"
      />,
    );
    expect(
      container.querySelector('[data-testid="scrub-indicator"]'),
    ).toBeNull();
  });

  it('renders a scrub indicator when isScrubbed is true with a timestamp', () => {
    const timeline = [
      makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
      makePoint('2026-04-20T13:35:00Z', 'POSITIVE'),
    ];
    const { container } = render(
      <RegimeTimeline
        timeline={timeline}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed
        scrubbedTimestamp="2026-04-20T13:35:00Z"
      />,
    );
    expect(
      container.querySelector('[data-testid="scrub-indicator"]'),
    ).not.toBeNull();
  });

  it('renders phase boundary labels on the x-axis', () => {
    const timeline = [
      makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
      makePoint('2026-04-20T20:30:00Z', 'POSITIVE'),
    ];
    render(
      <RegimeTimeline
        timeline={timeline}
        sessionPhaseBoundaries={BOUNDARIES}
        isScrubbed={false}
        scrubbedTimestamp={null}
      />,
    );
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('LUNCH')).toBeInTheDocument();
    expect(screen.getByText('POWER')).toBeInTheDocument();
    expect(screen.getByText('CLOSE')).toBeInTheDocument();
  });
});
