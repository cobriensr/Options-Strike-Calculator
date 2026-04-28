/**
 * ActionDirective tests — the five derivation branches + transitions.
 *
 * 1. STAND_ASIDE verdict + incomplete data → red "sit out" banner.
 * 2. STAND_ASIDE verdict + complete levels → amber WATCHING banner with
 *    walls + transition-band context.
 * 3. Any ACTIVE rule → "🎯 ACTIVE: …"
 * 4. Any ARMED rule (no ACTIVE) → "⏱ ARMED: …"
 * 5. Otherwise nearest non-INVALIDATED rule → "⏸ WAIT: …"
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionDirective } from '../../../components/FuturesGammaPlaybook/ActionDirective';
import type { PlaybookRule } from '../../../utils/futures-gamma/types';

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
    conviction: 'standard',
    ...overrides,
  };
}

describe('ActionDirective', () => {
  it('renders STAND ASIDE red banner when verdict=STAND_ASIDE and structural levels are missing', () => {
    render(
      <ActionDirective
        verdict="STAND_ASIDE"
        rules={[makeRule({ status: 'ACTIVE' })]}
        esPrice={5820}
        esZeroGamma={null}
        esCallWall={null}
        esPutWall={null}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/STAND ASIDE/i);
    expect(status).toHaveTextContent(/Regime ambiguous/i);
    expect(status.className).toMatch(/border-red-500/);
  });

  it('promotes to WATCHING when verdict=STAND_ASIDE but walls + zero-gamma are all known', () => {
    render(
      <ActionDirective
        verdict="STAND_ASIDE"
        rules={[]}
        esPrice={5812}
        esZeroGamma={5810}
        esCallWall={5830}
        esPutWall={5790}
      />,
    );
    const status = screen.getByRole('status');
    // Amber container class (the WATCHING palette).
    expect(status.className).toMatch(/border-amber-500/);
    expect(status).toHaveTextContent(/WATCHING/);
    // Contains both wall prices and zero-gamma.
    expect(status).toHaveTextContent(/5830/);
    expect(status).toHaveTextContent(/5790/);
    expect(status).toHaveTextContent(/5810/);
    // Contains the transition band disclosure and arm-zone hint.
    expect(status).toHaveTextContent(/band/i);
    expect(status).toHaveTextContent(/Arm zone/i);
  });

  it('WATCHING shows signed distance from ES to each wall', () => {
    render(
      <ActionDirective
        verdict="STAND_ASIDE"
        rules={[]}
        esPrice={5812}
        esZeroGamma={5810}
        esCallWall={5830}
        esPutWall={5790}
      />,
    );
    const status = screen.getByRole('status');
    // Call wall is +18 above ES; put wall is -22 below.
    expect(status).toHaveTextContent(/\+18 pts/);
    expect(status).toHaveTextContent(/-22 pts/);
  });

  it('falls back to red STAND ASIDE when ES price is unknown even with walls present', () => {
    render(
      <ActionDirective
        verdict="STAND_ASIDE"
        rules={[]}
        esPrice={null}
        esZeroGamma={5810}
        esCallWall={5830}
        esPutWall={5790}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/STAND ASIDE/i);
    expect(status.className).toMatch(/border-red-500/);
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
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
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
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
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
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
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
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
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
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
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
        esZeroGamma={null}
        esCallWall={null}
        esPutWall={null}
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
        esZeroGamma={null}
        esCallWall={null}
        esPutWall={null}
      />,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  // ── Backtest / scrub-mode indicator ──────────────────────────

  it('renders a BACKTEST prefix and sets aria-live="off" when isLive is false', () => {
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
        ]}
        esPrice={5820}
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
        isLive={false}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'off');
    expect(status).toHaveAttribute('aria-label', 'Action directive (backtest)');
    expect(screen.getByText('Backtest')).toBeInTheDocument();
  });

  it('defaults to live behavior when isLive is omitted (back-compat)', () => {
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
        ]}
        esPrice={5820}
        esZeroGamma={5800}
        esCallWall={5820}
        esPutWall={5780}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Backtest')).toBeNull();
  });
});
