import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MLPlot } from '../../hooks/useMLInsights';
import PlotCarousel from '../../components/ml-insights/PlotCarousel';
import FindingsSummary from '../../components/ml-insights/FindingsSummary';
import PlotAnalysis from '../../components/ml-insights/PlotAnalysis';

// ============================================================
// HELPERS
// ============================================================

function makePlot(overrides: Partial<MLPlot> = {}): MLPlot {
  return {
    name: 'timeline',
    imageUrl: '/plots/timeline.png',
    analysis: {
      what_it_means: 'Shows trend over time',
      how_to_apply: 'Use for timing entries',
      watch_out_for: 'Regime changes',
    },
    model: 'claude-sonnet-4-20250514',
    pipelineDate: '2026-04-03',
    updatedAt: '2026-04-03T06:00:00Z',
    ...overrides,
  };
}

/** Build a set of plots matching known groups */
function makeGroupPlots(): MLPlot[] {
  return [
    makePlot({ name: 'timeline', imageUrl: '/plots/timeline.png' }),
    makePlot({ name: 'stationarity', imageUrl: '/plots/stationarity.png' }),
    makePlot({ name: 'correlations', imageUrl: '/plots/correlations.png' }),
    makePlot({
      name: 'range_by_regime',
      imageUrl: '/plots/range_by_regime.png',
    }),
    makePlot({ name: 'gex_vs_range', imageUrl: '/plots/gex_vs_range.png' }),
    makePlot({
      name: 'flow_reliability',
      imageUrl: '/plots/flow_reliability.png',
    }),
  ];
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// PlotCarousel: RENDERING
// ============================================================

describe('PlotCarousel: rendering', () => {
  it('renders carousel section with accessible label', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    expect(
      screen.getByRole('toolbar', { name: /ml plot carousel/i }),
    ).toBeInTheDocument();
  });

  it('shows "No plots available" when no plots match groups', () => {
    render(<PlotCarousel plots={[makePlot({ name: 'unknown_plot' })]} />);
    expect(screen.getByText('No plots available')).toBeInTheDocument();
  });

  it('shows empty state for empty plots array', () => {
    render(<PlotCarousel plots={[]} />);
    expect(screen.getByText('No plots available')).toBeInTheDocument();
  });

  it('renders group tabs for available groups', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    // Overview group (timeline, stationarity, correlations)
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    // Regime group (range_by_regime, gex_vs_range)
    expect(screen.getByRole('tab', { name: 'Regime' })).toBeInTheDocument();
    // Flow & Pool group (flow_reliability)
    expect(
      screen.getByRole('tab', { name: 'Flow & Pool' }),
    ).toBeInTheDocument();
  });

  it('does not render group tabs for groups with no matching plots', () => {
    const plots = [makePlot({ name: 'timeline' })];
    render(<PlotCarousel plots={plots} />);
    // Only Overview should show
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'Regime' }),
    ).not.toBeInTheDocument();
  });

  it('renders plot tabs within the active group', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    // Default group is Overview, should show plot tabs for timeline, stationarity, correlations
    expect(screen.getByRole('tab', { name: 'Timeline' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Stationarity' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Correlations' }),
    ).toBeInTheDocument();
  });

  it('renders the active plot image', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    const img = screen.getByAltText(/ml pipeline plot: timeline/i);
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/plots/timeline.png');
  });

  it('shows keyboard navigation hint', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    expect(screen.getByText(/arrow keys to navigate/i)).toBeInTheDocument();
  });

  it('shows plot metadata bar with name and date', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);
    // Date appears alongside model in same span, so use substring match
    expect(screen.getByText(/2026-04-03/)).toBeInTheDocument();
  });

  it('shows model in metadata when present', () => {
    render(
      <PlotCarousel
        plots={[makePlot({ name: 'timeline', model: 'gpt-4o' })]}
      />,
    );
    expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
  });
});

// ============================================================
// PlotCarousel: GROUP NAVIGATION
// ============================================================

describe('PlotCarousel: group navigation', () => {
  it('switches group tabs and resets plot index', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Click on Regime group tab
    fireEvent.click(screen.getByRole('tab', { name: 'Regime' }));

    // Should now show plot tabs for Regime group
    expect(
      screen.getByRole('tab', { name: 'Range By Regime' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Gex Vs Range' }),
    ).toBeInTheDocument();

    // Overview plot tabs should no longer be present
    expect(
      screen.queryByRole('tab', { name: 'Timeline' }),
    ).not.toBeInTheDocument();
  });

  it('marks active group tab with aria-selected', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    const regimeTab = screen.getByRole('tab', { name: 'Regime' });

    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    expect(regimeTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(regimeTab);

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Regime' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

// ============================================================
// PlotCarousel: PLOT NAVIGATION
// ============================================================

describe('PlotCarousel: plot navigation', () => {
  it('switches active plot when plot tab clicked', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Correlations' }));

    const img = screen.getByAltText(/ml pipeline plot: correlations/i);
    expect(img).toHaveAttribute('src', '/plots/correlations.png');
  });

  it('marks active plot tab with aria-selected', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
    expect(timelineTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Stationarity' }));
    expect(timelineTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Stationarity' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

// ============================================================
// PlotCarousel: KEYBOARD NAVIGATION
// ============================================================

describe('PlotCarousel: keyboard navigation', () => {
  it('ArrowRight advances to next plot', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const section = screen.getByRole('toolbar', {
      name: /ml plot carousel/i,
    });

    fireEvent.keyDown(section, { key: 'ArrowRight' });

    // Should advance from timeline (idx 0) to stationarity (idx 1)
    expect(
      screen.getByAltText(/ml pipeline plot: stationarity/i),
    ).toBeInTheDocument();
  });

  it('ArrowLeft goes to previous plot', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const section = screen.getByRole('toolbar', {
      name: /ml plot carousel/i,
    });

    // Move to stationarity first
    fireEvent.keyDown(section, { key: 'ArrowRight' });
    // Then back to timeline
    fireEvent.keyDown(section, { key: 'ArrowLeft' });

    expect(
      screen.getByAltText(/ml pipeline plot: timeline/i),
    ).toBeInTheDocument();
  });

  it('ArrowRight wraps to first plot from last', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const section = screen.getByRole('toolbar', {
      name: /ml plot carousel/i,
    });

    // Go through all 3 Overview plots: timeline -> stationarity -> correlations -> wrap to timeline
    fireEvent.keyDown(section, { key: 'ArrowRight' });
    fireEvent.keyDown(section, { key: 'ArrowRight' });
    fireEvent.keyDown(section, { key: 'ArrowRight' });

    expect(
      screen.getByAltText(/ml pipeline plot: timeline/i),
    ).toBeInTheDocument();
  });

  it('ArrowLeft wraps to last plot from first', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    const section = screen.getByRole('toolbar', {
      name: /ml plot carousel/i,
    });

    fireEvent.keyDown(section, { key: 'ArrowLeft' });

    // Should wrap to correlations (last in Overview)
    expect(
      screen.getByAltText(/ml pipeline plot: correlations/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// PlotCarousel: LIGHTBOX
// ============================================================

describe('PlotCarousel: lightbox', () => {
  it('opens lightbox on plot click', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Click the plot image button
    fireEvent.click(
      screen.getByRole('button', {
        name: /view timeline full size/i,
      }),
    );

    // Lightbox close button should be visible
    expect(
      screen.getByRole('button', { name: /close full-size view/i }),
    ).toBeInTheDocument();

    // Full-size image should be rendered
    expect(
      screen.getByAltText(/full-size ml pipeline plot: timeline/i),
    ).toBeInTheDocument();
  });

  it('closes lightbox via close button', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Open lightbox
    fireEvent.click(
      screen.getByRole('button', {
        name: /view timeline full size/i,
      }),
    );

    // Close it
    fireEvent.click(
      screen.getByRole('button', { name: /close full-size view/i }),
    );

    expect(
      screen.queryByAltText(/full-size ml pipeline plot/i),
    ).not.toBeInTheDocument();
  });

  it('closes lightbox via backdrop click', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Open lightbox
    fireEvent.click(
      screen.getByRole('button', {
        name: /view timeline full size/i,
      }),
    );

    // Click backdrop
    fireEvent.click(screen.getByRole('button', { name: /close lightbox/i }));

    expect(
      screen.queryByAltText(/full-size ml pipeline plot/i),
    ).not.toBeInTheDocument();
  });

  it('closes lightbox on Escape key', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Open lightbox
    fireEvent.click(
      screen.getByRole('button', {
        name: /view timeline full size/i,
      }),
    );

    // Press Escape on the section element
    const section = screen.getByRole('toolbar', {
      name: /ml plot carousel/i,
    });
    fireEvent.keyDown(section, { key: 'Escape' });

    expect(
      screen.queryByAltText(/full-size ml pipeline plot/i),
    ).not.toBeInTheDocument();
  });

  it('closes lightbox on global Escape key', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    // Open lightbox
    fireEvent.click(
      screen.getByRole('button', {
        name: /view timeline full size/i,
      }),
    );

    // Press Escape on document level
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(
      screen.queryByAltText(/full-size ml pipeline plot/i),
    ).not.toBeInTheDocument();
  });
});

// ============================================================
// PlotCarousel: ANALYSIS
// ============================================================

describe('PlotCarousel: plot analysis', () => {
  it('shows analysis sections when plot has analysis', () => {
    render(<PlotCarousel plots={makeGroupPlots()} />);

    expect(screen.getByText('What the Data Means')).toBeInTheDocument();
    expect(screen.getByText('How to Apply')).toBeInTheDocument();
    expect(screen.getByText('Watch Out For')).toBeInTheDocument();
    expect(screen.getByText('Shows trend over time')).toBeInTheDocument();
  });

  it('shows pending message when plot has no analysis', () => {
    const plots = [
      makePlot({
        name: 'timeline',
        analysis: null,
      }),
    ];
    render(<PlotCarousel plots={plots} />);

    expect(
      screen.getByText(/analysis pending for timeline/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// FindingsSummary: RENDERING
// ============================================================

describe('FindingsSummary: rendering', () => {
  it('renders all five metric labels', () => {
    render(
      <FindingsSummary
        findings={null}
        pipelineDate={null}
        plotCount={0}
        analyzedCount={0}
      />,
    );
    expect(screen.getByText('Pipeline Date')).toBeInTheDocument();
    expect(screen.getByText('Dataset')).toBeInTheDocument();
    expect(screen.getByText('Accuracy')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('Plots')).toBeInTheDocument();
  });

  it('shows N/A when no data provided', () => {
    render(
      <FindingsSummary
        findings={null}
        pipelineDate={null}
        plotCount={0}
        analyzedCount={0}
      />,
    );
    // Multiple N/A: pipeline date, dataset, accuracy, health
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(4);
  });

  it('displays pipeline date when provided', () => {
    render(
      <FindingsSummary
        findings={null}
        pipelineDate="2026-04-03"
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('2026-04-03')).toBeInTheDocument();
  });

  it('displays dataset stats from findings', () => {
    render(
      <FindingsSummary
        findings={{
          dataset: { total_days: 120, labeled_days: 95 },
        }}
        pipelineDate="2026-04-03"
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('120 days')).toBeInTheDocument();
    expect(screen.getByText('(95 labeled)')).toBeInTheDocument();
  });

  it('displays accuracy from eda.overall_accuracy', () => {
    render(
      <FindingsSummary
        findings={{
          eda: { overall_accuracy: 0.723 },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('72.3%')).toBeInTheDocument();
  });

  it('falls back to dataset.overall_accuracy', () => {
    render(
      <FindingsSummary
        findings={{
          dataset: { overall_accuracy: 0.65 },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('65.0%')).toBeInTheDocument();
  });

  it('displays healthy status in green', () => {
    render(
      <FindingsSummary
        findings={{
          health: { status: 'healthy' },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('HEALTHY')).toBeInTheDocument();
  });

  it('displays stale status', () => {
    render(
      <FindingsSummary
        findings={{
          health: { status: 'stale' },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('STALE')).toBeInTheDocument();
  });

  it('displays unknown health status', () => {
    render(
      <FindingsSummary
        findings={{
          health: { status: 'degraded' },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={3}
      />,
    );
    expect(screen.getByText('DEGRADED')).toBeInTheDocument();
  });

  it('displays plot count fraction', () => {
    render(
      <FindingsSummary
        findings={null}
        pipelineDate={null}
        plotCount={10}
        analyzedCount={7}
      />,
    );
    expect(screen.getByText('7/10 analyzed')).toBeInTheDocument();
  });
});

// ============================================================
// PlotAnalysis: RENDERING
// ============================================================

describe('PlotAnalysis: rendering', () => {
  it('shows pending message when analysis is null', () => {
    render(<PlotAnalysis analysis={null} plotName="gex_vs_range" />);
    expect(
      screen.getByText(/analysis pending for gex vs range/i),
    ).toBeInTheDocument();
  });

  it('replaces underscores with spaces in pending message', () => {
    render(<PlotAnalysis analysis={null} plotName="dark_pool_vs_range" />);
    expect(
      screen.getByText(/analysis pending for dark pool vs range/i),
    ).toBeInTheDocument();
  });

  it('renders all three sections when analysis provided', () => {
    render(
      <PlotAnalysis
        analysis={{
          what_it_means: 'Meaning text',
          how_to_apply: 'Application text',
          watch_out_for: 'Warning text',
        }}
        plotName="timeline"
      />,
    );
    expect(screen.getByText('What the Data Means')).toBeInTheDocument();
    expect(screen.getByText('How to Apply')).toBeInTheDocument();
    expect(screen.getByText('Watch Out For')).toBeInTheDocument();
    expect(screen.getByText('Meaning text')).toBeInTheDocument();
    expect(screen.getByText('Application text')).toBeInTheDocument();
    expect(screen.getByText('Warning text')).toBeInTheDocument();
  });
});

// ============================================================
// FindingsSummary: EDGE CASES
// ============================================================

describe('FindingsSummary: edge cases', () => {
  it('handles findings with missing nested keys', () => {
    render(
      <FindingsSummary
        findings={{}}
        pipelineDate={null}
        plotCount={0}
        analyzedCount={0}
      />,
    );
    // Should show N/A for dataset, accuracy, and health
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThanOrEqual(3);
  });

  it('handles dataset with total_days but no labeled_days', () => {
    render(
      <FindingsSummary
        findings={{
          dataset: { total_days: 100 },
        }}
        pipelineDate={null}
        plotCount={5}
        analyzedCount={2}
      />,
    );
    expect(screen.getByText('100 days')).toBeInTheDocument();
    // No labeled span
    expect(screen.queryByText(/labeled/)).not.toBeInTheDocument();
  });
});
