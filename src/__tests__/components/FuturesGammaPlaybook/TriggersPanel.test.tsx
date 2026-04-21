/**
 * TriggersPanel tests — presentation only.
 *
 * Classification logic is covered in `triggers.test.ts`; these tests
 * assert the panel renders the correct rows, status badges, condition
 * copy, and level prices given a deterministic input set. The panel's
 * own render calls `evaluateTriggers` internally, so the tests feed
 * inputs that produce known outputs rather than mocking the evaluator.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TriggersPanel } from '../../../components/FuturesGammaPlaybook/TriggersPanel';
import type { EsLevel } from '../../../components/FuturesGammaPlaybook/types';

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
    expect(
      screen.getByText(/Awaiting ES levels/i),
    ).toBeInTheDocument();
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

  it('shows ACTIVE badge for an active trigger and IDLE for a dormant one', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[makeLevel('CALL_WALL', 5822, 2)]}
      />,
    );
    // fade-call-wall is ACTIVE; the other four triggers are IDLE (their
    // required levels are missing or regime doesn't match).
    const activeBadges = screen.getAllByLabelText('Status ACTIVE');
    expect(activeBadges).toHaveLength(1);
    const idleBadges = screen.getAllByLabelText('Status IDLE');
    expect(idleBadges).toHaveLength(4);
  });

  it('renders plain-English condition copy on each row', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="AFTERNOON"
        esPrice={5820}
        levels={[makeLevel('MAX_PAIN', 5815, -5)]}
      />,
    );
    expect(
      screen.getByText(/Positive-gamma regime and ES within 5 pts of the call wall/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/max-pain known — pin drift/i),
    ).toBeInTheDocument();
  });

  it('renders the keyed level price when present', () => {
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="AFTERNOON"
        esPrice={5820}
        levels={[
          makeLevel('CALL_WALL', 5822.25, 2.25),
          makeLevel('MAX_PAIN', 5815.5, -4.5),
        ]}
      />,
    );
    // Call-wall rows (fade-call-wall + break-call-wall) share an aria-label.
    const callWallPrices = screen.getAllByLabelText('Call wall at 5822.25');
    expect(callWallPrices).toHaveLength(2);
    expect(
      screen.getByLabelText('Max pain at 5815.50'),
    ).toBeInTheDocument();
  });

  it('shows an em-dash for trigger rows whose keyed level is missing', () => {
    // Only put wall supplied — the three call-wall + max-pain dependent
    // rows should render with a "—" in the level column.
    render(
      <TriggersPanel
        regime="POSITIVE"
        phase="MORNING"
        esPrice={5820}
        levels={[makeLevel('PUT_WALL', 5817, -3)]}
      />,
    );
    // Three trigger rows lack their keyed level (fade-call, break-call,
    // charm-drift). Each renders a "—" in the level column.
    const emDashes = screen.getAllByText('—');
    expect(emDashes.length).toBeGreaterThanOrEqual(3);
  });
});
