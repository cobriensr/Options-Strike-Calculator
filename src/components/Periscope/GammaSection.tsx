/**
 * Gamma Topology section of the Periscope panel.
 *
 * Shows the +γ ceiling and floor inside ±100 pts of spot plus the top
 * three −γ acceleration strikes. Each ranked cell highlights the strike,
 * value, and signed pts-from-spot.
 */

import { theme } from '../../themes';
import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';
import { RankedCell, Row, SectionHeader } from './shared';

export function GammaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Gamma Topology</SectionHeader>
      <Row
        label="+γ ceiling"
        value={
          view.gamma.ceiling ? (
            <RankedCell row={view.gamma.ceiling} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="+γ floor"
        value={
          view.gamma.floor ? (
            <RankedCell row={view.gamma.floor} />
          ) : (
            <span style={{ color: theme.textMuted }}>none ±100</span>
          )
        }
      />
      <Row
        label="−γ accel (top 3)"
        value={
          view.gamma.accelTop.length > 0 ? (
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.gamma.accelTop.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          ) : (
            <span style={{ color: theme.textMuted }}>none</span>
          )
        }
      />
    </div>
  );
}
