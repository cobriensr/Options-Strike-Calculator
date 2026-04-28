/**
 * TriggersPanel tests — presentation only.
 *
 * Classification logic is covered in `triggers.test.ts`; these tests
 * assert the panel renders the correct rows, status badges, distance
 * column, level prices, and BLOCKED affordances (strike-through +
 * reason tooltip) given a deterministic input set. The panel's own
 * render calls `evaluateTriggers` internally, so the tests feed inputs
 * that produce known outputs rather than mocking the evaluator.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TriggersPanel } from '../../../components/FuturesGammaPlaybook/TriggersPanel';
import type { EsLevel } from '../../../utils/futures-gamma/types';

function makeLevel(
  kind: EsLevel['kind'],
  esPrice: number,
  distanceEsPoints: number,
): EsLevel {
  return {
    kind,
    spxStrike: Math.round(esPrice - 12),
    esPrice,
    distanceEsPoints,
    status: 'IDLE',
  };
}

describe('TriggersPanel', () => {
  it('renders the empty state when levels is empty', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[]}
      />,
    );
    expect(screen.getByText(/Triggers unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Awaiting ES levels/i)).toBeInTheDocument();
  });

  it('renders all five trigger rows by name', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[
          makeLevel('CALL_WALL', 5822, 2),
          makeLevel('PUT_WALL', 5817, -3),
          makeLevel('MAX_PAIN', 5815, -5),
        ]}
      />,
    );
    expect(screen.getByText('Fade call wall')).toBeInTheDocument();
    expect(screen.getByText('Lift put wall')).toBeInTheDocument();
    expect(screen.getByText('Break call wall')).toBeInTheDocument();
    expect(screen.getByText('Break put wall')).toBeInTheDocument();
    expect(screen.getByText('Charm drift to pin')).toBeInTheDocument();
  });

  it('shows ACTIVE badge for an active trigger and BLOCKED for wrong-regime triggers', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[makeLevel('CALL_WALL', 5822, 2)]}
      />,
    );
    // fade-call-wall is ACTIVE; the other four triggers are BLOCKED:
    // - lift-put-wall: wall missing
    // - break-call-wall: regime POSITIVE (needs NEGATIVE)
    // - break-put-wall: regime POSITIVE + wall missing
    // - charm-drift: phase MORNING (needs AFTERNOON/POWER)
    const activeBadges = screen.getAllByLabelText('Status ACTIVE');
    expect(activeBadges).toHaveLength(1);
    const blockedBadges = screen.getAllByLabelText('Status BLOCKED');
    expect(blockedBadges).toHaveLength(4);
  });

  it('renders signed distance on fireable rows', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[
          makeLevel('CALL_WALL', 5830, 10), // ARMED, distance +10
        ]}
      />,
    );
    expect(screen.getByLabelText('Distance +10 pts')).toBeInTheDocument();
  });

  it('renders em-dash for BLOCKED rows in the distance column', () => {
    render(
      <TriggersPanel
        regime="NEGATIVE" // fade and lift become BLOCKED
        phase="MORNING"
        esPrice={5820}
        levels={[makeLevel('CALL_WALL', 5822, 2)]}
      />,
    );
    // At least the four BLOCKED rows show "Distance unavailable" aria.
    const unavailable = screen.getAllByLabelText('Distance unavailable');
    expect(unavailable.length).toBeGreaterThanOrEqual(4);
  });

  it('floats the single actionable row to the top when all others are BLOCKED', () => {
    // Only fade-call-wall is actionable (regime +GEX, wall known).
    // Others are BLOCKED (missing walls / wrong regime / wrong phase).
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[makeLevel('CALL_WALL', 5822, 2)]}
      />,
    );
    const setupCells = screen.getAllByText(
      /Fade call wall|Lift put wall|Break call wall|Break put wall|Charm drift to pin/,
    );
    // Hoisted fade should be first.
    expect(setupCells[0]?.textContent).toBe('Fade call wall');
  });

  it('renders the keyed level price when present', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="AFTERNOON"
        esPrice={5820}
        levels={[makeLevel('CALL_WALL', 5822.25, 2.25)]}
        esGammaPin={5815.5}
      />,
    );
    // Call-wall rows: `fade-call-wall` is actionable in POSITIVE regime
    // → aria-label "Call wall at 5822.25". `break-call-wall` is BLOCKED
    // (wrong regime) → aria-label "Call wall reference at 5822.25" so
    // screen-readers distinguish live triggers from stored references.
    expect(screen.getByLabelText('Call wall at 5822.25')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Call wall reference at 5822.25'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Gamma pin at 5815.50')).toBeInTheDocument();
  });

  it('prefixes BLOCKED row labels with "Ref:" to disambiguate from live triggers', () => {
    render(
      <TriggersPanel
        regime="NEGATIVE"
        phase="POWER"
        esPrice={5820}
        levels={[
          makeLevel('CALL_WALL', 5822, 2),
          makeLevel('PUT_WALL', 5818, -2),
        ]}
      />,
    );
    // Both fade-call-wall and lift-put-wall are BLOCKED in NEGATIVE
    // regime. Their rows should prefix "Ref:" rather than a bare
    // "Call wall:" / "Put wall:" which reads like live data.
    const refPrefixes = screen.getAllByText('Ref:');
    expect(refPrefixes.length).toBeGreaterThanOrEqual(2);
  });
});
