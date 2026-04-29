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
import { DateInput } from '../ui/DateInput';
import { useGammaSqueezes } from '../../hooks/useGammaSqueezes';
import { SqueezeRow } from './SqueezeRow';

const SCRUB_DATE_TIP = (
  <>
    <strong>Replay any past trading day.</strong> Picking a past date freezes
    polling and shows the squeezes that were active at that day's session close
    (15:00 CT) — scrub backward from there.
  </>
);

const SCRUB_PREV_TIP = (
  <>
    <strong>Step the scrubber back 5 minutes.</strong> Times are CT,
    08:30–15:00.
  </>
);

const SCRUB_NEXT_TIP = <strong>Step the scrubber forward 5 minutes.</strong>;

const SCRUB_TIME_TIP = (
  <>
    <strong>Replay timestamp (CT).</strong> <code>live</code> = polling
    real-time; <code>close</code> = past-day session close; <code>HH:MM</code> =
    scrubbed to that 5-min slot.
  </>
);

const SCRUB_LIVE_TIP = (
  <>
    <strong>Resume real-time polling.</strong> Clears the replay timestamp and
    snaps the date back to today.
  </>
);

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
  const {
    active,
    loading,
    error,
    selectedDate,
    setSelectedDate,
    scrubTime,
    isLive,
    isScrubbed,
    canScrubPrev,
    canScrubNext,
    scrubPrev,
    scrubNext,
    scrubLive,
  } = useGammaSqueezes({ marketOpen });

  return (
    <SectionBox label="Gamma Squeezes (velocity)" collapsible>
      <div className="flex flex-col gap-2">
        {/*
          Replay scrubber — mirrors IV Anomalies. Live mode (today + no
          scrub) polls every 30s; scrubbed shows the active board at the
          5-min slot via /api/gamma-squeezes?at=. Past-day no-scrub defaults
          to that day's session close.
        */}
        <div
          className="flex flex-wrap items-center gap-2 text-[11px]"
          role="toolbar"
          aria-label="Replay date and time controls"
        >
          <Tooltip content={SCRUB_DATE_TIP}>
            <span className="text-muted flex cursor-help items-center gap-1.5 font-mono">
              date
              <DateInput
                label="Replay date"
                labelVisible={false}
                value={selectedDate}
                onChange={setSelectedDate}
                className="border-edge bg-surface-alt text-primary rounded-md border px-2 py-0.5 font-mono text-[11px]"
              />
            </span>
          </Tooltip>
          <Tooltip content={SCRUB_PREV_TIP}>
            <button
              type="button"
              onClick={scrubPrev}
              disabled={!canScrubPrev}
              className="border-edge bg-surface-alt text-muted hover:text-primary rounded-md border px-2 py-0.5 font-mono disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Step scrubber back 5 minutes"
            >
              ◀
            </button>
          </Tooltip>
          <Tooltip content={SCRUB_TIME_TIP}>
            <span
              className={`min-w-[60px] cursor-help text-center font-mono ${
                isScrubbed ? 'text-amber-300' : 'text-muted'
              }`}
            >
              {scrubTime ?? (isLive ? 'live' : 'close')}
            </span>
          </Tooltip>
          <Tooltip content={SCRUB_NEXT_TIP}>
            <button
              type="button"
              onClick={scrubNext}
              disabled={!canScrubNext}
              className="border-edge bg-surface-alt text-muted hover:text-primary rounded-md border px-2 py-0.5 font-mono disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Step scrubber forward 5 minutes"
            >
              ▶
            </button>
          </Tooltip>
          <Tooltip content={SCRUB_LIVE_TIP}>
            <button
              type="button"
              onClick={scrubLive}
              disabled={isLive}
              className={`rounded-md border px-2 py-0.5 font-mono transition-colors ${
                isLive
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300/80'
                  : 'border-edge bg-surface-alt text-muted hover:text-primary'
              }`}
              aria-label="Return to live"
            >
              Live
            </button>
          </Tooltip>
          {isScrubbed && (
            <span className="text-muted ml-1 italic">
              showing squeezes active at {scrubTime} CT on {selectedDate}
            </span>
          )}
          {!isLive && !isScrubbed && (
            <span className="text-muted ml-1 italic">
              showing squeezes active at session close ({selectedDate})
            </span>
          )}
        </div>

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
