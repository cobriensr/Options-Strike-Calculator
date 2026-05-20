/**
 * Straddle Cone section of the Periscope panel.
 *
 * Renders the cone bounds, asymmetry, and breach status. The view's
 * `cone` field is assumed non-null at this point — the caller guards
 * with `view.cone && <ConeSection .../>`.
 */

import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { asymmetryLabel, fmtSigned } from '../../utils/periscope-formatting';
import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';
import { Row, SectionHeader } from './shared';

export function ConeSection({ view }: { view: PeriscopeView }) {
  const cone = view.cone!;
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Straddle Cone</SectionHeader>
      <Row
        label="Bounds"
        value={
          <span style={{ color: theme.text }}>
            {cone.coneLower.toFixed(1)} — {cone.coneUpper.toFixed(1)} (
            {cone.coneWidth.toFixed(0)} pts)
          </span>
        }
      />
      <Row
        label="Asymmetry"
        value={
          <span style={{ color: theme.text }}>
            {fmtSigned(cone.asymmetryPts)} pts ·{' '}
            <span style={{ color: theme.textMuted }}>
              {asymmetryLabel(cone.asymmetryPts)}
            </span>
          </span>
        }
      />
      {view.breaches.length === 0 ? (
        <Row
          label="Breach"
          value={
            <span style={{ color: theme.textSecondary }}>
              none — {(cone.coneUpper - view.spot).toFixed(0)} pts to upper,{' '}
              {(view.spot - cone.coneLower).toFixed(0)} pts to lower
            </span>
          }
        />
      ) : (
        view.breaches.map((b) => (
          <Row
            key={`${b.direction}-${b.breachTime}`}
            label={`${b.direction.toUpperCase()} breach`}
            value={
              <span style={{ color: theme.caution }}>
                {formatTimeCT(b.breachTime)} CT · spot{' '}
                {b.spotAtBreach.toFixed(2)} ({fmtSigned(b.ptsPastBound)} pts
                past)
              </span>
            }
          />
        ))
      )}
    </div>
  );
}
