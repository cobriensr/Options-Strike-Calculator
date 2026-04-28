/**
 * EsLevelsPanel tests — presentation only.
 *
 * The level math lives in `basis.ts` / `useFuturesGammaPlaybook.ts` and is
 * exercised in their own suites. These tests assert the panel renders
 * the correct labels, badges, and copy given a deterministic EsLevel[].
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EsLevelsPanel } from '../../../components/FuturesGammaPlaybook/EsLevelsPanel';
import type { EsLevel } from '../../../utils/futures-gamma/types';

function makeLevel(overrides: Partial<EsLevel> = {}): EsLevel {
  return {
    kind: 'CALL_WALL',
    spxStrike: 5820,
    esPrice: 5832,
    distanceEsPoints: 20,
    status: 'IDLE',
    ...overrides,
  };
}

describe('EsLevelsPanel', () => {
  it('renders the empty state when levels is empty', () => {
    render(<EsLevelsPanel levels={[]} />);
    expect(screen.getByText(/ES levels unavailable/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Awaiting basis and ES price data/i),
    ).toBeInTheDocument();
  });

  it('renders a CALL_WALL row with SPX, ES, and distance', () => {
    render(
      <EsLevelsPanel
        levels={[
          makeLevel({
            kind: 'CALL_WALL',
            spxStrike: 5820,
            esPrice: 5832.25,
            distanceEsPoints: 12.5,
            status: 'APPROACHING',
          }),
        ]}
      />,
    );
    expect(screen.getByText('CALL WALL')).toBeInTheDocument();
    expect(screen.getByLabelText('SPX strike 5820')).toBeInTheDocument();
    expect(screen.getByLabelText('ES price 5832.25')).toBeInTheDocument();
    // Signed distance as points + ticks (12.5 pts / 50 ticks).
    expect(screen.getByText(/\+12\.50/)).toBeInTheDocument();
    expect(screen.getByText(/\/ \+50t/)).toBeInTheDocument();
  });

  it('renders a negative distance with a minus sign and negative ticks', () => {
    render(
      <EsLevelsPanel
        levels={[
          makeLevel({
            kind: 'PUT_WALL',
            spxStrike: 5780,
            esPrice: 5792,
            distanceEsPoints: -3.25,
            status: 'REJECTED',
          }),
        ]}
      />,
    );
    expect(screen.getByText(/−3\.25|-3\.25/)).toBeInTheDocument();
    expect(screen.getByText(/\/ -13t/)).toBeInTheDocument();
  });

  it('renders all four level kinds with their correct badges', () => {
    render(
      <EsLevelsPanel
        levels={[
          makeLevel({ kind: 'CALL_WALL', spxStrike: 5820, esPrice: 5832 }),
          makeLevel({ kind: 'PUT_WALL', spxStrike: 5780, esPrice: 5792 }),
          makeLevel({ kind: 'ZERO_GAMMA', spxStrike: 5805, esPrice: 5817 }),
          makeLevel({ kind: 'MAX_PAIN', spxStrike: 5800, esPrice: 5812 }),
        ]}
      />,
    );
    expect(screen.getByText('CALL WALL')).toBeInTheDocument();
    expect(screen.getByText('PUT WALL')).toBeInTheDocument();
    expect(screen.getByText('ZERO-GAMMA')).toBeInTheDocument();
    expect(screen.getByText('MAX PAIN')).toBeInTheDocument();
  });

  it('renders each status badge correctly', () => {
    render(
      <EsLevelsPanel
        levels={[
          makeLevel({ kind: 'CALL_WALL', status: 'APPROACHING' }),
          makeLevel({ kind: 'PUT_WALL', status: 'REJECTED' }),
          makeLevel({ kind: 'ZERO_GAMMA', status: 'BROKEN' }),
          makeLevel({ kind: 'MAX_PAIN', status: 'IDLE' }),
        ]}
      />,
    );
    expect(screen.getByText('APPROACHING')).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    expect(screen.getByText('BROKEN')).toBeInTheDocument();
    expect(screen.getByText('IDLE')).toBeInTheDocument();
  });
});
