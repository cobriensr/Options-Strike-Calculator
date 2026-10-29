/**
 * Banner for a panel whose rules were tuned on UW Periscope data while the
 * live data is GEXBot (owner decision D1 revised, 2026-10-29). Stored
 * history stays visible under it.
 */

import { uwTunedPauseMessage } from '../../utils/uw-tuned-pause.js';

interface UwTunedPausedBannerProps {
  /** What the panel produces: 'setups' or 'alerts'. */
  noun: 'setups' | 'alerts';
  /** Accessible name, e.g. 'Gamma setups paused'. */
  label: string;
}

export function UwTunedPausedBanner({
  noun,
  label,
}: Readonly<UwTunedPausedBannerProps>): React.ReactElement {
  return (
    <div
      role="status"
      aria-label={label}
      className="border-caution/40 bg-caution/10 text-caution mb-2 rounded-md border px-3 py-2 font-sans text-xs"
    >
      {uwTunedPauseMessage(noun)}
    </div>
  );
}
