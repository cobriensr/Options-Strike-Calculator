/**
 * Vanna Pressure section of the Periscope panel.
 *
 * Shows the top |vanna| ranked cells. Caller guards rendering on
 * `view.vanna.topByAbs.length > 0`.
 */

import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';
import { RankedCell, Row, SectionHeader } from './shared';

export function VannaSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Vanna Pressure</SectionHeader>
      <Row
        label="Top |vanna|"
        value={
          <span className="flex flex-wrap justify-end gap-x-3">
            {view.vanna.topByAbs.map((r) => (
              <RankedCell key={r.strike} row={r} />
            ))}
          </span>
        }
      />
    </div>
  );
}
