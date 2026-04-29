/**
 * Standalone section showing active gamma-squeeze setups across the
 * watchlist. Sibling of `IVAnomaliesSection` — different signal source,
 * different mental model (reflexive momentum vs informed flow), so we
 * render them side by side rather than mixing.
 *
 * One row per active compound key (`ticker:strike:side:expiry`). Sorted
 * by phase (active → forming → exhausted), then by recency.
 */

import { SectionBox, Tooltip } from '../ui';
import { useGammaSqueezes } from '../../hooks/useGammaSqueezes';
import { SqueezeRow } from './SqueezeRow';

const VELOCITY_TIP = (
  <>
    <strong>Acceleration filter.</strong> A single 65× ratio isn't a squeeze —
    what matters is how fast it's growing. ≥5× added per 15-min window means
    dealers are getting forced to hedge into a moving spot.
  </>
);

const ACCELERATING_TIP = (
  <>
    <strong>2nd derivative is positive.</strong> The velocity itself is growing
    — not just elevated. This is the &quot;reflexive&quot; component the section
    name calls out.
  </>
);

const TRENDING_TIP = (
  <>
    <strong>Distance to strike is shrinking monotonically.</strong> Filters out
    false positives where vol/OI is high but spot is drifting away.
  </>
);

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
          0DTE/1DTE strikes where{' '}
          <Tooltip content={VELOCITY_TIP}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              vol/OI velocity ≥ 5×/15-min
            </span>
          </Tooltip>
          ,{' '}
          <Tooltip content={ACCELERATING_TIP}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              accelerating
            </span>
          </Tooltip>
          , and{' '}
          <Tooltip content={TRENDING_TIP}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              spot is trending into the strike
            </span>
          </Tooltip>
          . Companion to IV Anomalies — this catches the reflexive
          (dealer-hedged) momentum, not informed flow. Polls every 30s during
          market hours.
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
