/**
 * FuturesPanel — Main container for the futures data section.
 *
 * Fetches snapshot data via useFuturesData, shows loading skeleton
 * while fetching, empty state if no data, and renders FuturesGrid
 * + VixTermStructure. Owner-gated at the App.tsx level, not here.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { useFuturesData } from '../../hooks/useFuturesData';
import { SectionBox } from '../ui';
import FuturesGrid from './FuturesGrid';
import VixTermStructure from './VixTermStructure';

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

export default function FuturesPanel() {
  const {
    snapshots,
    vxTermSpread,
    vxTermStructure,
    esSpxBasis,
    updatedAt,
    loading,
    error,
    refetch,
  } = useFuturesData();

  const timeLabel = formatUpdatedAt(updatedAt);

  return (
    <SectionBox
      label="Futures"
      badge={timeLabel}
      headerRight={
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
      </div>
    </SectionBox>
  );
}
