import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TRACELiveSynthesisPanel from '../components/TRACELive/TRACELiveSynthesisPanel';
import type {
  TraceLiveDetail,
  TraceAnalysis,
  TraceSynthesis,
} from '../components/TRACELive/types';

function makeSynth(overrides: Partial<TraceSynthesis> = {}): TraceSynthesis {
  return {
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
    headline: 'Tight neutral session',
    warnings: [],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<TraceAnalysis> = {}): TraceAnalysis {
  return {
    timestamp: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: 88,
    regime: 'range_bound_positive_gamma',
    charm: {
      predominantColor: 'mixed',
      direction: 'no_call',
      junctionStrike: null,
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
    synthesis: makeSynth(),
    ...overrides,
  };
}

function makeDetail(
  analysisOverrides?: Partial<TraceAnalysis>,
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
    headline: 'Tight neutral session',
    imageUrls: {},
    analysis: analysisOverrides
      ? makeAnalysis(analysisOverrides)
      : makeAnalysis(),
    noveltyScore: null,
    actualClose: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    durationMs: null,
    createdAt: '2026-04-27T18:00:00Z',
  };
}

describe('TRACELiveSynthesisPanel', () => {
  it('renders nothing when detail is null', () => {
    const { container } = render(<TRACELiveSynthesisPanel detail={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when analysis.synthesis is missing', () => {
    const detail = makeDetail();
    detail.analysis = null;
    const { container } = render(<TRACELiveSynthesisPanel detail={detail} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the trade type with underscores replaced by spaces', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({
            trade: {
              type: 'tight_credit_spread',
              centerStrike: 5800,
              wingWidth: 10,
              size: 'half',
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/tight credit spread/)).toBeInTheDocument();
  });

  it('renders the size pill with underscores replaced by spaces', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({
            trade: {
              type: 'iron_fly',
              centerStrike: 5800,
              wingWidth: 0,
              size: 'three_quarter',
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/size three quarter/)).toBeInTheDocument();
  });

  it('shows centerStrike and wingWidth values when set', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({
            trade: {
              type: 'iron_condor',
              centerStrike: 5800,
              wingWidth: 25,
              size: 'half',
            },
          }),
        })}
      />,
    );
    expect(screen.getByText('5800')).toBeInTheDocument();
    expect(screen.getByText('±25')).toBeInTheDocument();
  });

  it('omits centerStrike / wingWidth lines when null', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({
            trade: {
              type: 'flat',
              centerStrike: null,
              wingWidth: null,
              size: 'none',
            },
          }),
        })}
      />,
    );
    expect(screen.queryByText('center')).not.toBeInTheDocument();
    expect(screen.queryByText('wing')).not.toBeInTheDocument();
  });

  it('renders the cross-chart agreement label with underscores replaced', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({ crossChartAgreement: 'mostly_agree' }),
        })}
      />,
    );
    // The Cross-Chart Agreement Collapsible is NOT defaultOpen — click its
    // title to expand the body before asserting on the agreement label.
    fireEvent.click(screen.getByText('Cross-Chart Agreement'));
    expect(screen.getByText(/mostly agree/i)).toBeInTheDocument();
  });

  it('renders warnings as a bullet list when present', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          synthesis: makeSynth({
            warnings: ['Stability below threshold', 'Override stale'],
          }),
        })}
      />,
    );
    expect(screen.getByText(/Stability below threshold/)).toBeInTheDocument();
    expect(screen.getByText(/Override stale/)).toBeInTheDocument();
  });

  it('hides the Warnings section when the warnings array is empty', () => {
    render(<TRACELiveSynthesisPanel detail={makeDetail()} />);
    // "Warnings" appears in the title only if rendered.
    expect(screen.queryByText('Warnings')).not.toBeInTheDocument();
  });

  it('renders three steps when reasoningSummary contains STEP 1/2/3 markers', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          reasoningSummary:
            'STEP 1 — GAMMA\n- gamma point\nSTEP 2 — CHARM\n- charm point\nSTEP 3 — DELTA\n- delta point\nOVERRIDE: none',
        })}
      />,
    );
    expect(screen.getByText('Step 1 — Gamma')).toBeInTheDocument();
    expect(screen.getByText('Step 2 — Charm')).toBeInTheDocument();
    expect(screen.getByText('Step 3 — Delta + Synthesis')).toBeInTheDocument();
  });

  it('falls back to a single Reasoning Summary block when STEP markers are missing', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          reasoningSummary:
            'Free-form prose without the canonical step markers.',
        })}
      />,
    );
    expect(screen.getByText('Reasoning Summary')).toBeInTheDocument();
    expect(screen.queryByText(/Step 1 — Gamma/)).not.toBeInTheDocument();
  });

  it('falls back to a single block when STEP markers appear out of order', () => {
    render(
      <TRACELiveSynthesisPanel
        detail={makeDetail({
          reasoningSummary:
            'STEP 2 — out of order first\nSTEP 1 — out of order\nSTEP 3 — last',
        })}
      />,
    );
    expect(screen.getByText('Reasoning Summary')).toBeInTheDocument();
  });
});
