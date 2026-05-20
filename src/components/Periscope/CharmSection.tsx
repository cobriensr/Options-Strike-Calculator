/**
 * Charm Flow section of the Periscope panel.
 *
 * Renders the tally rows, top-by-|charm| cells, the charm-zero strike,
 * and the three-line charm-drift read computed by `computeCharmDriftRead`
 * (extracted to src/utils/periscope-charm-drift).
 */

import { theme } from '../../themes';
import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';
import { colorForValue, fmtSigned } from '../../utils/periscope-formatting';
// `CharmDriftRead` is the util's data-shape interface; the local
// presenter component below is named `CharmDriftReadDisplay`. Aliasing
// the imported type to `CharmDriftReadType` avoids the name collision
// that existed in the pre-3A monolith.
import {
  computeCharmDriftRead,
  type CharmDriftRead as CharmDriftReadType,
} from '../../utils/periscope-charm-drift';
import { RankedCell, Row, SectionHeader } from './shared';

function CharmDriftReadDisplay({ read }: { read: CharmDriftReadType }) {
  return (
    <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
      <div style={{ color: read.position.color }}>{read.position.text}</div>
      <div style={{ color: read.drift.color }}>{read.drift.text}</div>
      <div style={{ color: read.weight.color }}>{read.weight.text}</div>
    </div>
  );
}

export function CharmSection({ view }: { view: PeriscopeView }) {
  const driftRead =
    view.charm.charmZeroStrike != null
      ? computeCharmDriftRead({
          spot: view.spot,
          charmZeroStrike: view.charm.charmZeroStrike,
          tallyWide100: view.charm.tallyWide100,
          capturedAt: view.capturedAt,
        })
      : null;

  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Charm Flow</SectionHeader>
      <Row
        label="Net tally ±50"
        value={
          <span style={{ color: colorForValue(view.charm.tallyNear50) }}>
            {fmtSigned(view.charm.tallyNear50)}
          </span>
        }
      />
      <Row
        label="Net tally ±100"
        value={
          <span style={{ color: colorForValue(view.charm.tallyWide100) }}>
            {fmtSigned(view.charm.tallyWide100)}
          </span>
        }
      />
      {view.charm.topByAbs.length > 0 && (
        <Row
          label="Top |charm|"
          value={
            <span className="flex flex-wrap justify-end gap-x-3">
              {view.charm.topByAbs.map((r) => (
                <RankedCell key={r.strike} row={r} />
              ))}
            </span>
          }
        />
      )}
      {view.charm.charmZeroStrike != null && (
        <Row
          label="Charm-zero strike"
          value={
            <span style={{ color: theme.text }}>
              {view.charm.charmZeroStrike}
            </span>
          }
        />
      )}
      {driftRead && <CharmDriftReadDisplay read={driftRead} />}
    </div>
  );
}
