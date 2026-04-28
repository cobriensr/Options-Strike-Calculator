/**
 * MLInsights — Main container for the ML pipeline insights section.
 *
 * Fetches plot data via useMLInsights, shows loading skeleton while
 * fetching, empty state if no plots, and renders FindingsSummary
 * at top with PlotCarousel below.
 */

import React from 'react';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils';
import { useMLInsights, type MLPlot } from '../../hooks/useMLInsights';
import { SectionBox } from '../ui';
import FindingsSummary from './FindingsSummary';
import PlotCarousel from './PlotCarousel';

const VEGA_PREFIX = 'vega-spike-';
type PlotTab = 'pipeline' | 'vega';

function isVegaPlot(p: MLPlot): boolean {
  return p.name.startsWith(VEGA_PREFIX);
}

interface PlotTabsProps {
  active: PlotTab;
  onChange: (next: PlotTab) => void;
  pipelineCount: number;
  vegaCount: number;
}

function PlotTabs({
  active,
  onChange,
  pipelineCount,
  vegaCount,
}: PlotTabsProps) {
  const tabs: Array<{ value: PlotTab; label: string }> = [
    { value: 'pipeline', label: `Pipeline (n=${pipelineCount})` },
  ];
  if (vegaCount > 0) {
    tabs.push({ value: 'vega', label: `Vega (n=${vegaCount})` });
  }
  if (tabs.length === 1) return null;
  return (
    <div
      className="border-edge inline-flex items-center gap-0.5 rounded-md border p-0.5"
      role="group"
      aria-label="ML plot category"
    >
      {tabs.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={isActive}
            data-testid={`ml-plot-tab-${opt.value}`}
            className={[
              'focus-visible:ring-accent cursor-pointer rounded-sm px-2.5 py-1 font-sans text-[10px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
              isActive
                ? 'bg-accent-bg text-accent'
                : 'text-tertiary hover:text-primary',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function MLInsights() {
  const { plots, findings, pipelineDate, loading, error, refetch } =
    useMLInsights();
  const [analyzeState, setAnalyzeState] = React.useState<
    'idle' | 'running' | 'done' | 'error'
  >('idle');
  const [activeTab, setActiveTab] = React.useState<PlotTab>('pipeline');

  const analyzedCount = plots.filter((p) => p.analysis != null).length;
  const pipelinePlots = React.useMemo(
    () => plots.filter((p) => !isVegaPlot(p)),
    [plots],
  );
  const vegaPlots = React.useMemo(
    () => plots.filter((p) => isVegaPlot(p)),
    [plots],
  );
  const visiblePlots = activeTab === 'vega' ? vegaPlots : pipelinePlots;

  async function triggerAnalyze() {
    setAnalyzeState('running');
    try {
      const r = await fetch('/api/ml/trigger-analyze', { method: 'POST' });
      setAnalyzeState(r.ok ? 'done' : 'error');
    } catch {
      setAnalyzeState('error');
    }
    setTimeout(() => setAnalyzeState('idle'), 3000);
  }

  return (
    <SectionBox
      label="ML Insights"
      badge={pipelineDate}
      collapsible
      headerRight={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void triggerAnalyze()}
            disabled={analyzeState === 'running'}
            className="cursor-pointer rounded-md px-2.5 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              backgroundColor: tint(theme.caution, '12'),
              color:
                analyzeState === 'done'
                  ? theme.green
                  : analyzeState === 'error'
                    ? theme.red
                    : theme.caution,
              border: `1px solid ${tint(theme.caution, '25')}`,
            }}
            aria-label="Run Claude plot analysis"
          >
            {analyzeState === 'running'
              ? 'Starting...'
              : analyzeState === 'done'
                ? 'Started ✓'
                : analyzeState === 'error'
                  ? 'Failed'
                  : 'Analyze'}
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
            aria-label="Refresh ML insights"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
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
            <PlotTabs
              active={activeTab}
              onChange={setActiveTab}
              pipelineCount={pipelinePlots.length}
              vegaCount={vegaPlots.length}
            />
            {activeTab === 'vega' && vegaPlots.length === 0 ? (
              <div className="text-muted px-3 py-6 text-center font-sans text-[11px] italic">
                No vega plots yet — runs nightly via the ML pipeline.
              </div>
            ) : (
              <PlotCarousel plots={visiblePlots} />
            )}
          </div>
        )}
      </div>
    </SectionBox>
  );
}
