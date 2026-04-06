/**
 * MLInsights — Main container for the ML pipeline insights section.
 *
 * Fetches plot data via useMLInsights, shows loading skeleton while
 * fetching, empty state if no plots, and renders FindingsSummary
 * at top with PlotCarousel below.
 */

import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { useMLInsights } from '../../hooks/useMLInsights';
import { SectionBox } from '../ui';
import FindingsSummary from './FindingsSummary';
import PlotCarousel from './PlotCarousel';

export default function MLInsights() {
  const { plots, findings, pipelineDate, loading, error, refetch } =
    useMLInsights();

  const analyzedCount = plots.filter((p) => p.analysis != null).length;

  return (
    <SectionBox
      label="ML Insights"
      badge={pipelineDate}
      collapsible
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
          aria-label="Refresh ML insights"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      }
    >
      <div className="font-sans text-[11px] leading-relaxed">
        {/* Loading skeleton */}
        {loading && plots.length === 0 && (
          <div aria-busy="true" className="grid gap-3">
            <div className="bg-surface-alt h-16 animate-pulse rounded-lg" />
            <div className="bg-surface-alt h-8 w-3/4 animate-pulse rounded-lg" />
            <div className="bg-surface-alt h-48 animate-pulse rounded-lg" />
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
        {!loading && !error && plots.length === 0 && (
          <div
            className="border-edge rounded-lg border px-4 py-8 text-center"
            style={{ backgroundColor: tint(theme.surfaceAlt, '80') }}
          >
            <div className="text-muted mb-1 font-sans text-[12px] font-semibold">
              Pipeline has not run yet
            </div>
            <div className="text-muted font-sans text-[10px]">
              ML plots and analyses will appear here after the nightly pipeline
              completes.
            </div>
          </div>
        )}

        {/* Content */}
        {plots.length > 0 && (
          <div className="grid gap-4">
            <FindingsSummary
              findings={findings}
              pipelineDate={pipelineDate}
              plotCount={plots.length}
              analyzedCount={analyzedCount}
            />
            <PlotCarousel plots={plots} />
          </div>
        )}
      </div>
    </SectionBox>
  );
}
