/**
 * TRACELiveTabPanel — renders one chart's image + per-chart "read at a
 * glance" rows + notes for the active tab.
 *
 * Each chart has different read fields:
 *   - Gamma: signAtSpot, dominantNode + ratio, override, floor/ceiling
 *   - Charm: predominantColor, direction, junction, flipFlop, wicks
 *   - Delta: blueBelowStrike, redAboveStrike, corridorWidth, zoneBehavior
 *
 * The `Collapsible` primitive from ChartAnalysis is reused so visual
 * vocabulary stays consistent across the dashboard.
 */

import { memo } from 'react';
import { theme } from '../../themes';
import Collapsible from '../ChartAnalysis/Collapsible';
import type { TraceChart, TraceLiveDetail } from './types';

interface Props {
  readonly chart: TraceChart;
  readonly detail: TraceLiveDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function chartTitle(chart: TraceChart): string {
  return chart === 'gamma'
    ? 'Gamma Heatmap'
    : chart === 'charm'
      ? 'Charm Pressure Heatmap'
      : 'Delta Pressure Heatmap';
}

function StatRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-[11px] leading-relaxed">
      <span className="text-muted">{label}</span>
      <span
        className="text-secondary font-mono font-semibold"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function GammaReadRows({ detail }: { detail: TraceLiveDetail }) {
  const a = detail.analysis?.gamma;
  if (!a) return null;
  const ratioStr =
    a.dominantNodeRatio == null
      ? '—'
      : a.dominantNodeRatio === Infinity
        ? '∞'
        : `${a.dominantNodeRatio.toFixed(1)}×`;
  return (
    <div className="grid gap-1.5">
      <StatRow label="Sign at spot" value={a.signAtSpot.replace('_', ' ')} />
      <StatRow
        label="Dominant node"
        value={
          a.dominantNodeStrike == null
            ? '—'
            : `${a.dominantNodeStrike} @ ${a.dominantNodeMagnitudeB?.toFixed(2) ?? '?'}B (${ratioStr})`
        }
      />
      <StatRow
        label="Override fires"
        value={a.overrideFires ? '✓ yes' : '— no'}
        accent={a.overrideFires ? theme.green : undefined}
      />
      <StatRow label="Floor" value={a.floorStrike ?? '—'} />
      <StatRow label="Ceiling" value={a.ceilingStrike ?? '—'} />
    </div>
  );
}

function CharmReadRows({ detail }: { detail: TraceLiveDetail }) {
  const a = detail.analysis?.charm;
  if (!a) return null;
  return (
    <div className="grid gap-1.5">
      <StatRow label="Predominant color" value={a.predominantColor} />
      <StatRow label="Direction" value={a.direction} />
      <StatRow label="Junction strike" value={a.junctionStrike ?? '—'} />
      <StatRow
        label="Flip-flop detected"
        value={a.flipFlopDetected ? '⚠ yes' : '— no'}
        accent={a.flipFlopDetected ? theme.red : undefined}
      />
      <StatRow
        label="Rejection wicks at red"
        value={a.rejectionWicksAtRed ? '✓ yes' : '— no'}
      />
    </div>
  );
}

function DeltaReadRows({ detail }: { detail: TraceLiveDetail }) {
  const a = detail.analysis?.delta;
  if (!a) return null;
  return (
    <div className="grid gap-1.5">
      <StatRow label="Blue below" value={a.blueBelowStrike ?? '—'} />
      <StatRow label="Red above" value={a.redAboveStrike ?? '—'} />
      <StatRow label="Corridor width" value={a.corridorWidth ?? '—'} />
      <StatRow label="Zone behavior" value={a.zoneBehavior.replace('_', ' ')} />
    </div>
  );
}

function getNotes(
  chart: TraceChart,
  detail: TraceLiveDetail | null,
): string | null {
  const a = detail?.analysis;
  if (!a) return null;
  if (chart === 'gamma') return a.gamma.notes || null;
  if (chart === 'charm') return a.charm.notes || null;
  return a.delta.notes || null;
}

function TRACELiveTabPanel({ chart, detail, loading, error }: Readonly<Props>) {
  // The blob URLs in detail.imageUrls are private-store URLs the browser
  // can't fetch directly (no auth token). Route through the server-side
  // proxy at /api/trace-live-image, which authenticates with the
  // BLOB_READ_WRITE_TOKEN and streams the bytes back. Fall back to null
  // (showing the empty state) only when no image is stored at all.
  const hasImage = !!detail?.imageUrls[chart];
  const url =
    hasImage && detail
      ? `/api/trace-live-image?id=${detail.id}&chart=${chart}`
      : null;
  const notes = getNotes(chart, detail);

  return (
    <div
      className="mt-3"
      role="tabpanel"
      id={`trace-live-tab-${chart}`}
      aria-labelledby={`trace-live-tab-${chart}-btn`}
    >
      {/* Image */}
      <div className="border-edge bg-surface-alt overflow-hidden rounded-lg border">
        <div className="text-muted border-edge border-b px-3 py-1.5 font-sans text-[10px] font-bold tracking-wider uppercase">
          {chartTitle(chart)}
          {detail?.spot != null && (
            <span className="ml-2 font-mono lowercase">
              spot {detail.spot.toFixed(2)}
            </span>
          )}
        </div>
        {url ? (
          <img
            src={url}
            alt={`${chartTitle(chart)} captured at ${detail?.capturedAt ?? 'unknown time'}`}
            className="block w-full"
            loading="lazy"
          />
        ) : (
          <div className="text-muted flex items-center justify-center px-4 py-8 text-[11px]">
            {loading
              ? 'Loading capture…'
              : error
                ? error
                : detail
                  ? 'No image stored for this capture.'
                  : 'Pick a capture from the timestamp dropdown.'}
          </div>
        )}
      </div>

      {/* Read at a glance — always open */}
      {detail && (
        <div className="mt-3">
          <Collapsible
            title="Read at a glance"
            color={theme.accent}
            defaultOpen
          >
            {chart === 'gamma' && <GammaReadRows detail={detail} />}
            {chart === 'charm' && <CharmReadRows detail={detail} />}
            {chart === 'delta' && <DeltaReadRows detail={detail} />}
          </Collapsible>
        </div>
      )}

      {/* Notes */}
      {notes && (
        <div className="mt-2">
          <Collapsible title="Notes" color={theme.textMuted}>
            <div className="text-secondary text-[11px] leading-relaxed">
              {notes}
            </div>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

export default memo(TRACELiveTabPanel);
