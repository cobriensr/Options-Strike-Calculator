/**
 * RegimeTimeline tests — presentation only.
 *
 * Focus on the SVG shell: empty state, regime band counts, zero-gamma
 * crossing counts, and the scrubbed-indicator visibility toggle. The
 * time-to-x math is simple linear interpolation — no separate unit test.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegimeTimeline } from '../../../components/FuturesGammaPlaybook/RegimeTimeline';
import type {
  RegimeTimelinePoint,
  SessionPhaseBoundariesCt,
} from '../../../utils/futures-gamma/types';

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

  describe('hover crosshair', () => {
    // jsdom returns zero-size rects; the snap-finder needs a real width so
    // the mouseSvgX math can resolve to a valid viewBox x. Stubbing only the
    // SVG's rect keeps the stub local to hover-specific tests.
    function mockSvgRect(width = 600, left = 0): () => void {
      const spy = vi
        .spyOn(SVGElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          width,
          height: 160,
          left,
          top: 0,
          right: left + width,
          bottom: 160,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);
      return () => spy.mockRestore();
    }

    it('snaps to the nearest data point on mouse-move and renders the crosshair + card', () => {
      const restore = mockSvgRect(600, 0);
      // Three points spread across the 13:30 → 20:30 session. Session open
      // is 13:30 UTC (BOUNDARIES.open = 09:30-04:00). Mouse at clientX=60
      // maps to mouseSvgX=60 — near the first point.
      const timeline = [
        makePoint('2026-04-20T13:30:00Z', 'POSITIVE', 5800.12, 1_250_000_000),
        makePoint('2026-04-20T17:00:00Z', 'NEGATIVE', 5810.5, -2_500_000_000),
        makePoint('2026-04-20T20:30:00Z', 'TRANSITIONING', 5805.25, 500_000),
      ];
      const { container } = render(
        <RegimeTimeline
          timeline={timeline}
          sessionPhaseBoundaries={BOUNDARIES}
          isScrubbed={false}
          scrubbedTimestamp={null}
        />,
      );
      const svg = container.querySelector(
        '[data-testid="regime-timeline-svg"]',
      );
      expect(svg).not.toBeNull();

      // Hover near the left edge → first point (POSITIVE).
      fireEvent.mouseMove(svg!, { clientX: 10, clientY: 50 });
      expect(
        container.querySelector('[data-testid="hover-crosshair"]'),
      ).not.toBeNull();
      const card = container.querySelector('[data-testid="hover-readout"]');
      expect(card).not.toBeNull();
      expect(card!.textContent).toMatch(/POSITIVE/);
      expect(card!.textContent).toMatch(/5800\.12/);
      // netGex 1.25B formats with the signed B suffix.
      expect(card!.textContent).toMatch(/1\.\dB/);
      restore();
    });

    it('clears the crosshair and card on mouse-leave', () => {
      const restore = mockSvgRect(600, 0);
      const timeline = [
        makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
        makePoint('2026-04-20T20:30:00Z', 'NEGATIVE'),
      ];
      const { container } = render(
        <RegimeTimeline
          timeline={timeline}
          sessionPhaseBoundaries={BOUNDARIES}
          isScrubbed={false}
          scrubbedTimestamp={null}
        />,
      );
      const svg = container.querySelector(
        '[data-testid="regime-timeline-svg"]',
      )!;
      fireEvent.mouseMove(svg, { clientX: 10, clientY: 50 });
      expect(
        container.querySelector('[data-testid="hover-crosshair"]'),
      ).not.toBeNull();
      fireEvent.mouseLeave(svg);
      expect(
        container.querySelector('[data-testid="hover-crosshair"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="hover-readout"]'),
      ).toBeNull();
      restore();
    });

    it('does not render a crosshair for an empty timeline (empty-state branch is inert)', () => {
      // When timeline is empty, the component renders the empty-state
      // shell at a DIFFERENT DOM position (no SVG with that testid). The
      // hover handlers are only attached to the main render branch, so
      // there's no svg to mousemove on.
      const { container } = render(
        <RegimeTimeline
          timeline={[]}
          sessionPhaseBoundaries={BOUNDARIES}
          isScrubbed={false}
          scrubbedTimestamp={null}
        />,
      );
      expect(
        container.querySelector('[data-testid="regime-timeline-svg"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="hover-crosshair"]'),
      ).toBeNull();
    });

    it('flips the card from right-of-crosshair to left-of-crosshair past the midpoint', () => {
      const restore = mockSvgRect(600, 0);
      const timeline = [
        makePoint('2026-04-20T13:30:00Z', 'POSITIVE'),
        makePoint('2026-04-20T17:00:00Z', 'POSITIVE'),
        makePoint('2026-04-20T20:30:00Z', 'POSITIVE'),
      ];
      const { container } = render(
        <RegimeTimeline
          timeline={timeline}
          sessionPhaseBoundaries={BOUNDARIES}
          isScrubbed={false}
          scrubbedTimestamp={null}
        />,
      );
      const svg = container.querySelector(
        '[data-testid="regime-timeline-svg"]',
      )!;

      // Hover near left edge → card positioned on the right of the snap.
      fireEvent.mouseMove(svg, { clientX: 20, clientY: 50 });
      let card = container.querySelector(
        '[data-testid="hover-readout"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(card!.style.left).not.toBe('');
      expect(card!.style.right).toBe('');

      // Hover near right edge → card flips to the left of the snap.
      fireEvent.mouseMove(svg, { clientX: 580, clientY: 50 });
      card = container.querySelector(
        '[data-testid="hover-readout"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(card!.style.right).not.toBe('');
      expect(card!.style.left).toBe('');
      restore();
    });
  });
});
