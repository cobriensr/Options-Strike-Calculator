/**
 * FuturesPanel — Main container for the futures data section.
 *
 * Fetches snapshot data via useFuturesData, shows loading skeleton
 * while fetching, empty state if no data, and renders FuturesGrid
 * + VixTermStructure. Owner-gated at the App.tsx level, not here.
 *
 * Includes a datetime-local picker that lets the user inspect the
 * futures snapshot at an arbitrary past moment. Default (empty picker)
 * is live mode. Picking a value re-fetches with `?at=<UTC-ISO>`.
 */

import { useMemo, useState } from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { useFuturesData } from '../../hooks/useFuturesData';
import {
  ctWallClockToUtcIso,
  getCTDateStr,
  getCTTime,
} from '../../utils/timezone';
import { SectionBox, StatusBadge } from '../ui';
import FuturesGrid from './FuturesGrid';
import VixTermStructure from './VixTermStructure';
import FuturesCalculator from '.';

function formatUpdatedAt(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    });
  } catch {
    return null;
  }
}

const DATETIME_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/**
 * Format an ISO string as a `datetime-local` input value (YYYY-MM-DDTHH:mm)
 * anchored to **Central Time** (matching the rest of the app's TZ
 * convention). Returns null on invalid input.
 */
function isoToCtInputValue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dateStr = getCTDateStr(d);
  const { hour, minute } = getCTTime(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dateStr}T${pad(hour)}:${pad(minute)}`;
}

/**
 * Convert a `datetime-local` input value into a UTC ISO string, treating
 * the value as **Central Time** wall-clock. Required because the native
 * `datetime-local` input has no timezone metadata, and the rest of this
 * app labels and reasons about times in CT regardless of host TZ.
 *
 * Returns null for empty or malformed input.
 */
function ctInputToIso(value: string): string | null {
  if (!value) return null;
  const match = value.match(DATETIME_LOCAL_RE);
  if (!match) return null;
  const dateStr = match[1]!;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return ctWallClockToUtcIso(dateStr, hour * 60 + minute);
}

export default function FuturesPanel() {
  // Raw `datetime-local` input value, interpreted as Central Time.
  // Empty = live.
  const [pickerValue, setPickerValue] = useState('');

  // Derived UTC ISO that gets passed to the hook. Memoized so a render
  // that doesn't change `pickerValue` doesn't re-trigger the hook's effect.
  const at = useMemo(
    () => ctInputToIso(pickerValue) ?? undefined,
    [pickerValue],
  );

  const {
    snapshots,
    vxTermSpread,
    vxTermStructure,
    esSpxBasis,
    updatedAt,
    oldestTs,
    loading,
    error,
    refetch,
  } = useFuturesData(at);

  const timeLabel = formatUpdatedAt(updatedAt);
  const isHistorical = pickerValue !== '';

  // `max` = now. Computed each render (not memoized) so a dashboard left
  // open for hours / across midnight doesn't freeze the upper bound at
  // mount time. `new Date()` is cheap and React diffs primitive DOM props,
  // so this is effectively free. Both bounds are anchored to CT so they
  // line up with the picker's CT-labeled value space.
  const maxLocal = isoToCtInputValue(new Date().toISOString());
  const minLocal = useMemo(() => isoToCtInputValue(oldestTs), [oldestTs]);

  return (
    <SectionBox
      label="Futures"
      badge={timeLabel}
      collapsible
      headerRight={
        <div className="flex items-center gap-2">
          {isHistorical && (
            <span role="status">
              <StatusBadge
                label="VIEWING HISTORICAL"
                color={theme.caution}
                title="Showing a historical snapshot — click Now to return to live data"
              />
            </span>
          )}
          <label htmlFor="futures-historical-picker" className="sr-only">
            Historical futures timestamp
          </label>
          <input
            id="futures-historical-picker"
            type="datetime-local"
            value={pickerValue}
            onChange={(e) => setPickerValue(e.target.value)}
            min={minLocal ?? undefined}
            max={maxLocal ?? undefined}
            step="60"
            className="text-secondary border-edge rounded border bg-transparent px-1.5 py-0.5 font-mono text-[10px]"
          />
          <button
            type="button"
            onClick={() => setPickerValue('')}
            disabled={!isHistorical}
            className="cursor-pointer rounded-md px-2.5 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: tint(theme.accent, '12'),
              color: theme.accent,
              border: `1px solid ${tint(theme.accent, '25')}`,
            }}
            aria-label="Reset to live data"
          >
            Now
          </button>
          <button
            type="button"
            onClick={refetch}
            disabled={loading}
            className="cursor-pointer rounded-md px-2.5 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: tint(theme.accent, '12'),
              color: theme.accent,
              border: `1px solid ${tint(theme.accent, '25')}`,
            }}
            aria-label="Refresh futures data"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      }
    >
      <div className="font-sans text-[11px] leading-relaxed">
        {/* Loading skeleton */}
        {loading && snapshots.length === 0 && (
          <div aria-busy="true" className="grid gap-3">
            <div className="bg-surface-alt h-24 animate-pulse rounded-lg" />
            <div className="bg-surface-alt h-16 animate-pulse rounded-lg" />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div
            className="rounded-lg px-3 py-2 text-[11px]"
            style={{
              backgroundColor: tint(theme.red, '12'),
              color: theme.red,
            }}
          >
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && snapshots.length === 0 && (
          <div
            className="border-edge rounded-lg border px-4 py-8 text-center"
            style={{
              backgroundColor: tint(theme.surfaceAlt, '80'),
            }}
          >
            <div className="text-muted mb-1 font-sans text-[12px] font-semibold">
              No futures data yet
            </div>
            <div className="text-muted font-sans text-[10px]">
              Futures snapshots will appear here once the sidecar is streaming
              data and the snapshot cron has run.
            </div>
          </div>
        )}

        {/* Content */}
        {snapshots.length > 0 && (
          <div className="grid gap-3">
            <VixTermStructure
              snapshots={snapshots}
              vxTermSpread={vxTermSpread}
              vxTermStructure={vxTermStructure}
            />
            <FuturesGrid snapshots={snapshots} esSpxBasis={esSpxBasis} />
          </div>
        )}

        {/* P&L Calculator — always shown, no data dependency */}
        <span id="sec-futures-calc" className="block scroll-mt-28" />
        <FuturesCalculator />
      </div>
    </SectionBox>
  );
}
