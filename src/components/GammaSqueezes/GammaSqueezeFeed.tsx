/**
 * Standalone section showing active gamma-squeeze setups across the
 * watchlist. Sibling of `IVAnomaliesSection` — different signal source,
 * different mental model (reflexive momentum vs informed flow), so we
 * render them side by side rather than mixing.
 *
 * One row per active compound key (`ticker:strike:side:expiry`). Sorted
 * by phase (active → forming → exhausted), then by recency.
 */

import { SectionBox } from '../ui';
import { useGammaSqueezes } from '../../hooks/useGammaSqueezes';
import { SqueezeRow } from './SqueezeRow';

export function GammaSqueezeFeed({
  marketOpen,
}: {
  readonly marketOpen: boolean;
}) {
  const { active, loading, error } = useGammaSqueezes({ marketOpen });

  return (
    <SectionBox label="Gamma Squeezes (velocity)" collapsible>
      <div className="flex flex-col gap-2">
        <div className="text-muted text-[11px]">
          0DTE/1DTE strikes where vol/OI velocity ≥ 5×/15-min, accelerating, and
          spot is trending into the strike. Companion to IV Anomalies — this
          catches the reflexive (dealer-hedged) momentum, not informed flow.
          Polls every 30s during market hours.
        </div>

        {error && (
          <div className="text-xs text-rose-300" data-testid="squeeze-error">
            error: {error}
          </div>
        )}

        {loading && active.length === 0 && (
          <div className="text-muted text-xs">loading…</div>
        )}

        {!loading && active.length === 0 && (
          <div
            className="text-muted text-xs italic"
            data-testid="squeeze-empty"
          >
            No active gamma squeezes. Watch this space when spot starts trending
            into a high-OI strike on a single name.
          </div>
        )}

        {active.length > 0 && (
          <div className="flex flex-col gap-1">
            {active.map((squeeze) => (
              <SqueezeRow key={squeeze.compoundKey} squeeze={squeeze} />
            ))}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
