import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TRACELiveTabPanel from '../components/TRACELive/TRACELiveTabPanel';
import type {
  TraceLiveDetail,
  TraceAnalysis,
} from '../components/TRACELive/types';

function makeAnalysis(overrides: Partial<TraceAnalysis> = {}): TraceAnalysis {
  return {
    timestamp: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: 88,
    regime: 'range_bound_positive_gamma',
    charm: {
      predominantColor: 'red',
      direction: 'short',
      junctionStrike: 5810,
      flipFlopDetected: false,
      rejectionWicksAtRed: false,
      notes: '',
    },
    gamma: {
      signAtSpot: 'positive_strong',
      dominantNodeStrike: 5800,
      dominantNodeMagnitudeB: 12.4,
      dominantNodeRatio: 1.6,
      floorStrike: 5780,
      ceilingStrike: 5820,
      overrideFires: false,
      notes: '',
    },
    delta: {
      blueBelowStrike: 5790,
      redAboveStrike: 5810,
      corridorWidth: 20,
      zoneBehavior: 'support_resistance',
      notes: '',
    },
    synthesis: {
      predictedClose: 5810,
      confidence: 'high',
      crossChartAgreement: 'all_agree',
      overrideApplied: false,
      trade: {
        type: 'iron_condor',
        centerStrike: 5800,
        wingWidth: 20,
        size: 'half',
      },
      headline: '',
      warnings: [],
    },
    ...overrides,
  };
}

function makeDetail(
  overrides: Partial<TraceLiveDetail> = {},
): TraceLiveDetail {
  return {
    id: 1,
    capturedAt: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: 88,
    regime: 'range_bound_positive_gamma',
    predictedClose: 5810,
    confidence: 'high',
    overrideApplied: false,
    headline: 'Tight neutral',
    imageUrls: { gamma: 'blob:abc', charm: 'blob:def', delta: 'blob:ghi' },
    analysis: makeAnalysis(),
    noveltyScore: null,
    actualClose: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    durationMs: null,
    createdAt: '2026-04-27T18:00:00Z',
    ...overrides,
  };
}

describe('TRACELiveTabPanel', () => {
  it('renders the gamma chart title and routes the image through the proxy endpoint', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/Gamma Heatmap/)).toBeInTheDocument();
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('/api/trace-live-image?id=1&chart=gamma');
  });

  it('renders the charm chart title for chart=charm', () => {
    render(
      <TRACELiveTabPanel
        chart="charm"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/Charm Pressure Heatmap/)).toBeInTheDocument();
  });

  it('renders the delta chart title for chart=delta', () => {
    render(
      <TRACELiveTabPanel
        chart="delta"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/Delta Pressure Heatmap/)).toBeInTheDocument();
  });

  it('renders the loading placeholder when no image is stored AND loading is true', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={null}
        loading
        error={null}
      />,
    );
    expect(screen.getByText('Loading capture…')).toBeInTheDocument();
  });

  it('renders the error message when no image AND error is set', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={null}
        loading={false}
        error="connection refused"
      />,
    );
    expect(screen.getByText('connection refused')).toBeInTheDocument();
  });

  it('renders the no-image fallback when detail is set but imageUrls is empty', () => {
    const detail = makeDetail({ imageUrls: {} });
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={detail}
        loading={false}
        error={null}
      />,
    );
    expect(
      screen.getByText('No image stored for this capture.'),
    ).toBeInTheDocument();
  });

  it('renders the pick-a-capture hint when detail is null and no error/loading', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={null}
        loading={false}
        error={null}
      />,
    );
    expect(
      screen.getByText('Pick a capture from the timestamp dropdown.'),
    ).toBeInTheDocument();
  });

  it('renders gamma read rows with the dominant node ratio formatted as Nx', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/1\.6×/)).toBeInTheDocument();
    expect(screen.getByText(/positive strong/)).toBeInTheDocument();
  });

  it('renders gamma read row with infinity symbol when ratio is Infinity', () => {
    const detail = makeDetail({
      analysis: makeAnalysis({
        gamma: {
          ...makeAnalysis().gamma,
          dominantNodeRatio: Infinity,
        },
      }),
    });
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={detail}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/∞/)).toBeInTheDocument();
  });

  it('renders charm read rows with flip-flop warning when flipFlopDetected is true', () => {
    const detail = makeDetail({
      analysis: makeAnalysis({
        charm: {
          ...makeAnalysis().charm,
          flipFlopDetected: true,
        },
      }),
    });
    render(
      <TRACELiveTabPanel
        chart="charm"
        detail={detail}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText(/⚠ yes/)).toBeInTheDocument();
  });

  it('renders delta read rows with corridor width and zone behavior', () => {
    render(
      <TRACELiveTabPanel
        chart="delta"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText(/support resistance/)).toBeInTheDocument();
  });

  it('renders the Notes collapsible only when notes are non-empty', () => {
    const detailWithNotes = makeDetail({
      analysis: makeAnalysis({
        gamma: { ...makeAnalysis().gamma, notes: '- noted point' },
      }),
    });
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={detailWithNotes}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('Notes')).toBeInTheDocument();
    // Notes Collapsible is collapsed by default — click to expand before
    // asserting on bullet contents.
    fireEvent.click(screen.getByText('Notes'));
    expect(screen.getByText('noted point')).toBeInTheDocument();
  });

  it('hides Notes when notes string is empty', () => {
    render(
      <TRACELiveTabPanel
        chart="gamma"
        detail={makeDetail()}
        loading={false}
        error={null}
      />,
    );
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
  });
});
