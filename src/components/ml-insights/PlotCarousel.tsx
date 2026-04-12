/**
 * PlotCarousel — Tab-based plot viewer with grouped navigation.
 *
 * Two-level tab navigation:
 *   - Group tabs (top row): Overview, Regime, Flow & Pool, etc.
 *   - Plot tabs (second row): individual plots within the group
 *
 * Active plot image displayed full-width. Images lazy-load (only
 * fetched when the tab becomes active). Click to open full-screen.
 * Left/Right keyboard navigation within a group.
 */

import { useState, useCallback, useEffect, memo } from 'react';
import type { MLPlot } from '../../hooks/useMLInsights';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import PlotAnalysis from './PlotAnalysis';
import TracePinForm from './TracePinForm';

interface PlotGroup {
  label: string;
  plots: string[];
}

const PLOT_GROUPS: PlotGroup[] = [
  { label: 'Overview', plots: ['timeline', 'stationarity', 'correlations'] },
  {
    label: 'Regime',
    plots: ['range_by_regime', 'gex_vs_range', 'day_of_week'],
  },
  {
    label: 'Flow & Pool',
    plots: ['flow_reliability', 'dark_pool_vs_range'],
  },
  {
    label: 'Performance',
    plots: [
      'structure_confidence',
      'confidence_over_time',
      'backtest_equity',
      'failure_heatmap',
    ],
  },
  {
    label: 'Clustering',
    plots: [
      'clusters_pca',
      'clusters_heatmap',
      'feature_importance_comparison',
    ],
  },
  {
    label: 'Pin Risk',
    plots: ['pin_settlement', 'pin_time_decay', 'pin_composite'],
  },
  {
    label: 'Transitions',
    plots: ['prev_day_transition', 'cone_consumption'],
  },
  {
    label: 'TRACE Pin',
    plots: [
      'trace_error_distribution',
      'trace_predicted_vs_actual',
      'trace_accuracy_by_confidence',
      'trace_accuracy_by_vix_regime',
    ],
  },
];

/** Format plot name for display: snake_case -> Title Case */
function formatPlotName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface Props {
  readonly plots: MLPlot[];
}

const PlotCarousel = memo(function PlotCarousel({ plots }: Props) {
  const [activeGroupIdx, setActiveGroupIdx] = useState(0);
  const [activePlotIdx, setActivePlotIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [loadedUrls, setLoadedUrls] = useState<Set<string>>(new Set());

  const plotMap = new Map(plots.map((p) => [p.name, p]));

  // Filter groups to only those with available plots, but always include TRACE Pin
  // (it hosts the manual prediction form even when no accuracy plots exist yet).
  const availableGroups = PLOT_GROUPS.map((group) => ({
    ...group,
    plots: group.plots.filter((name) => plotMap.has(name)),
  })).filter((group) => group.plots.length > 0 || group.label === 'TRACE Pin');

  const activeGroup = availableGroups[activeGroupIdx];
  const activePlotName = activeGroup?.plots[activePlotIdx];
  const activePlot = activePlotName ? plotMap.get(activePlotName) : undefined;

  // Mark active plot URL as loaded for lazy-loading
  useEffect(() => {
    if (activePlot && !loadedUrls.has(activePlot.imageUrl)) {
      setLoadedUrls((prev) => new Set(prev).add(activePlot.imageUrl));
    }
  }, [activePlot, loadedUrls]);

  const handleGroupChange = useCallback((idx: number) => {
    setActiveGroupIdx(idx);
    setActivePlotIdx(0);
  }, []);

  const handlePlotChange = useCallback((idx: number) => {
    setActivePlotIdx(idx);
  }, []);

  // Number of plots in active group — used by keyboard handler
  const activeGroupLength = activeGroup?.plots.length ?? 0;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (activeGroupLength === 0) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setActivePlotIdx((prev) => (prev < activeGroupLength - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setActivePlotIdx((prev) => (prev > 0 ? prev - 1 : activeGroupLength - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setLightboxOpen(false);
    }
  }

  // Close lightbox on Escape (global handler)
  useEffect(() => {
    if (!lightboxOpen) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lightboxOpen]);

  if (availableGroups.length === 0) {
    return (
      <div
        className="border-edge rounded-lg border px-4 py-6 text-center"
        style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
      >
        <div className="text-muted font-sans text-[11px] italic">
          No plots available
        </div>
      </div>
    );
  }

  return (
    <div
      role="toolbar"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-label="ML plot carousel"
      className="outline-none"
    >
      {/* Group tabs (top row) */}
      <div
        className="scrollbar-hide mb-2 flex gap-1 overflow-x-auto"
        role="tablist"
        aria-label="Plot groups"
      >
        {availableGroups.map((group, idx) => {
          const isActive = idx === activeGroupIdx;
          return (
            <button
              key={group.label}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`plot-group-${idx}`}
              onClick={() => handleGroupChange(idx)}
              className="shrink-0 cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-all"
              style={{
                backgroundColor: isActive
                  ? tint(theme.accent, '18')
                  : theme.surfaceAlt,
                color: isActive ? theme.accent : theme.textMuted,
                border: `1px solid ${isActive ? tint(theme.accent, '40') : 'transparent'}`,
              }}
            >
              {group.label}
            </button>
          );
        })}
      </div>

      {/* Plot tabs (second row) */}
      {activeGroup && (
        <div
          id={`plot-group-${activeGroupIdx}`}
          role="tabpanel"
          className="scrollbar-hide mb-3 flex gap-1 overflow-x-auto"
        >
          {activeGroup.plots.map((plotName, idx) => {
            const isActive = idx === activePlotIdx;
            return (
              <button
                key={plotName}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handlePlotChange(idx)}
                className="shrink-0 cursor-pointer rounded-md px-2.5 py-1 font-sans text-[10px] transition-all"
                style={{
                  backgroundColor: isActive
                    ? tint(theme.chartPurple, '15')
                    : 'transparent',
                  color: isActive ? theme.chartPurple : theme.textMuted,
                  border: `1px solid ${isActive ? tint(theme.chartPurple, '35') : theme.border}`,
                }}
              >
                {formatPlotName(plotName)}
              </button>
            );
          })}
        </div>
      )}

      {/* Active plot image */}
      {activePlot && (
        <div className="border-edge overflow-hidden rounded-lg border">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block w-full cursor-zoom-in"
            aria-label={`View ${formatPlotName(activePlot.name)} full size`}
            style={{ backgroundColor: theme.surfaceAlt }}
          >
            {loadedUrls.has(activePlot.imageUrl) ? (
              <img
                src={activePlot.imageUrl}
                alt={`ML pipeline plot: ${formatPlotName(activePlot.name)}`}
                className="h-auto w-full"
                loading="lazy"
              />
            ) : (
              <div className="flex h-48 items-center justify-center">
                <div className="text-muted animate-pulse font-sans text-[11px]">
                  Loading plot...
                </div>
              </div>
            )}
          </button>

          {/* Plot metadata bar */}
          <div
            className="border-edge flex items-center justify-between border-t px-3 py-1.5"
            style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
          >
            <span className="text-muted font-sans text-[10px]">
              {formatPlotName(activePlot.name)}
            </span>
            <span className="text-muted font-mono text-[9px]">
              {activePlot.pipelineDate}
              {activePlot.model && ` \u00B7 ${activePlot.model}`}
            </span>
          </div>
        </div>
      )}

      {/* Analysis text below the plot */}
      {activePlot && (
        <div className="mt-3">
          <PlotAnalysis
            analysis={activePlot.analysis}
            plotName={activePlot.name}
          />
        </div>
      )}

      {/* TRACE Pin manual prediction entry */}
      {availableGroups[activeGroupIdx]?.label === 'TRACE Pin' && (
        <TracePinForm />
      )}

      {/* Keyboard hint */}
      <div className="text-muted mt-2 text-center font-sans text-[9px]">
        Use {'\u2190'} {'\u2192'} arrow keys to navigate plots
      </div>

      {/* Full-screen lightbox overlay */}
      {lightboxOpen && activePlot && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85">
          {/* Backdrop dismiss button (covers full area) */}
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            className="absolute inset-0 cursor-pointer"
            aria-label="Close lightbox"
          />
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-[201] cursor-pointer rounded-full bg-white/10 px-3 py-1.5 font-sans text-[12px] font-semibold text-white transition-opacity hover:bg-white/20"
            aria-label="Close full-size view"
          >
            {'\u00D7'} Close
          </button>
          <img
            src={activePlot.imageUrl}
            alt={`Full-size ML pipeline plot: ${formatPlotName(activePlot.name)}`}
            className="relative z-[200] max-h-[90vh] max-w-[95vw] rounded-lg object-contain"
          />
        </div>
      )}
    </div>
  );
});

export default PlotCarousel;
