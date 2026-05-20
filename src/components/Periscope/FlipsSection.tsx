/**
 * Sign-Flips section of the Periscope panel.
 *
 * Renders strikes whose gamma exposure flipped sign since the prior
 * 10-min slice — the table-bottom equivalent of UW's orange-bar
 * regime-flip cell. Caller guards rendering on
 * `view.signFlips.length > 0`.
 */

import { theme } from '../../themes';
import type { PeriscopeView } from '../../hooks/usePeriscopeExposure';
import { colorForValue, fmtSigned } from '../../utils/periscope-formatting';
import { SectionHeader } from './shared';

export function FlipsSection({ view }: { view: PeriscopeView }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionHeader>Sign Flips Since Prior Slice</SectionHeader>
      {view.signFlips.map((f) => (
        <div
          key={f.strike}
          className="flex items-baseline justify-between font-mono text-[11px]"
        >
          <span style={{ color: theme.textSecondary }}>{f.strike}</span>
          <span>
            <span style={{ color: colorForValue(f.from) }}>
              {fmtSigned(f.from)}
            </span>
            <span style={{ color: theme.textMuted }}> → </span>
            <span style={{ color: colorForValue(f.to) }}>
              {fmtSigned(f.to)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
