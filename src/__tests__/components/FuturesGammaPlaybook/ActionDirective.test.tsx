/**
 * ActionDirective tests — the four derivation branches + transitions.
 *
 * 1. STAND_ASIDE verdict overrides everything.
 * 2. Any ACTIVE rule → "🎯 ACTIVE: …"
 * 3. Any ARMED rule (no ACTIVE) → "⏱ ARMED: …"
 * 4. Otherwise nearest non-INVALIDATED rule → "⏸ WAIT: …"
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionDirective } from '../../../components/FuturesGammaPlaybook/ActionDirective';
import type { PlaybookRule } from '../../../components/FuturesGammaPlaybook/types';

function makeRule(overrides: Partial<PlaybookRule> = {}): PlaybookRule {
  return {
    id: 'pos-fade-call-wall',
    condition: 'Fade rallies into call wall at 5820.00',
    direction: 'SHORT',
    entryEs: 5820,
    targetEs: 5805,
    stopEs: 5820.25,
    sizingNote: 'Tight stops.',
    distanceEsPoints: 0,
    status: 'DISTANT',
    ...overrides,
  };
}

describe('ActionDirective', () => {
  it('renders STAND ASIDE when verdict is STAND_ASIDE regardless of rules', () => {
    render(
      <ActionDirective
        verdict="STAND_ASIDE"
        rules={[makeRule({ status: 'ACTIVE' })]}
        esPrice={5820}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/STAND ASIDE/i);
    expect(screen.getByRole('status')).toHaveTextContent(
      /Regime ambiguous/i,
    );
  });

  it('renders ACTIVE directive when any rule is ACTIVE', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[
          makeRule({
            id: 'pos-fade-call-wall',
            direction: 'SHORT',
            entryEs: 5820,
            distanceEsPoints: 0,
            status: 'ACTIVE',
          }),
          makeRule({
            id: 'pos-lift-put-wall',
            direction: 'LONG',
            entryEs: 5780,
            distanceEsPoints: -40,
            status: 'DISTANT',
          }),
        ]}
        esPrice={5820}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/ACTIVE:/);
    expect(status).toHaveTextContent(/SHORT/);
    expect(status).toHaveTextContent(/fade call wall/);
    expect(status).toHaveTextContent(/5820/);
  });

  it('renders ARMED directive with signed distance when no ACTIVE but ARMED present', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[
          makeRule({
            id: 'pos-fade-call-wall',
            direction: 'SHORT',
            entryEs: 5820,
            distanceEsPoints: 10,
            status: 'ARMED',
          }),
        ]}
        esPrice={5810}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/ARMED:/);
    expect(status).toHaveTextContent(/\+10 pts/);
    expect(status).toHaveTextContent(/fade call wall/);
  });

  it('renders WAIT directive when no ACTIVE and no ARMED rules', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[
          makeRule({
            id: 'pos-fade-call-wall',
            direction: 'SHORT',
            entryEs: 5820,
            distanceEsPoints: 120,
            status: 'DISTANT',
          }),
          makeRule({
            id: 'pos-lift-put-wall',
            direction: 'LONG',
            entryEs: 5780,
            distanceEsPoints: 80,
            status: 'DISTANT',
          }),
        ]}
        esPrice={5700}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/WAIT:/);
    expect(status).toHaveTextContent(/Nearest setup/);
    // 80 is smaller than 120 → lift-put-wall should be nearest.
    expect(status).toHaveTextContent(/LONG/);
    expect(status).toHaveTextContent(/\+80 pts/);
  });

  it('picks the CLOSEST ACTIVE rule when multiple are ACTIVE', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[
          makeRule({
            id: 'pos-fade-call-wall',
            direction: 'SHORT',
            entryEs: 5820,
            distanceEsPoints: 4,
            status: 'ACTIVE',
          }),
          makeRule({
            id: 'pos-lift-put-wall',
            direction: 'LONG',
            entryEs: 5780,
            distanceEsPoints: 1,
            status: 'ACTIVE',
          }),
        ]}
        esPrice={5779}
      />,
    );
    const status = screen.getByRole('status');
    // lift-put-wall has the smaller |distance|, should win.
    expect(status).toHaveTextContent(/LONG/);
    expect(status).toHaveTextContent(/lift put wall/);
  });

  it('ignores INVALIDATED rules when computing nearest WAIT candidate', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[
          // INVALIDATED with tiny distance — must be skipped.
          makeRule({
            id: 'pos-fade-call-wall',
            direction: 'SHORT',
            entryEs: 5820,
            distanceEsPoints: -1,
            status: 'INVALIDATED',
          }),
          makeRule({
            id: 'pos-lift-put-wall',
            direction: 'LONG',
            entryEs: 5780,
            distanceEsPoints: 30,
            status: 'DISTANT',
          }),
        ]}
        esPrice={5821}
      />,
    );
    const status = screen.getByRole('status');
    // lift-put-wall wins despite being farther away.
    expect(status).toHaveTextContent(/LONG/);
  });

  it('renders the WAIT fallback message when rules array is empty', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[]}
        esPrice={5820}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/WAIT:/);
    expect(screen.getByRole('status')).toHaveTextContent(/levels unavailable/i);
  });

  it('uses aria-live=polite for accessibility', () => {
    render(
      <ActionDirective
        verdict="MEAN_REVERT"
        rules={[]}
        esPrice={null}
      />,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});
