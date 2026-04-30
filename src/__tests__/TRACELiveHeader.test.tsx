import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TRACELiveHeader from '../components/TRACELive/TRACELiveHeader';
import type { TraceLiveDetail } from '../components/TRACELive/types';
import type { UseTraceLiveCountdownReturn } from '../components/TRACELive/hooks/useTraceLiveCountdown';

function makeDetail(overrides: Partial<TraceLiveDetail> = {}): TraceLiveDetail {
  return {
    id: 1,
    capturedAt: '2026-04-27T18:00:00Z',
    spot: 5800,
    stabilityPct: null,
    regime: 'range_bound_positive_gamma',
    predictedClose: 5810,
    confidence: 'high',
    overrideApplied: false,
    headline: 'Tight neutral session, pin 5800',
    imageUrls: {},
    analysis: null,
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

const idleCountdown: UseTraceLiveCountdownReturn = {
  label: null,
  secondsRemaining: null,
  isOverdue: false,
  nextExpectedAt: null,
};

describe('TRACELiveHeader', () => {
  it('renders the headline when a detail is provided', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Tight neutral session, pin 5800'),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" placeholder when detail is null and loading is true', () => {
    render(
      <TRACELiveHeader
        detail={null}
        isLive
        countdown={idleCountdown}
        loading
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders "No captures yet" when detail is null and not loading', () => {
    render(
      <TRACELiveHeader
        detail={null}
        isLive={false}
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('No captures yet')).toBeInTheDocument();
  });

  it('shows the confidence pill with the underscore-replaced label', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({ confidence: 'no_trade' })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('no trade')).toBeInTheDocument();
  });

  it('shows the OVERRIDE badge when overrideApplied is true', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({ overrideApplied: true })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('OVERRIDE')).toBeInTheDocument();
  });

  it('shows the NOVEL badge when noveltyScore exceeds the 0.45 threshold', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({ noveltyScore: 0.5 })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/NOVEL/)).toBeInTheDocument();
  });

  it('hides the NOVEL badge when noveltyScore is at or below 0.45', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({ noveltyScore: 0.45 })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText(/NOVEL/)).not.toBeInTheDocument();
  });

  it('shows LIVE badge when isLive is true and HISTORICAL otherwise', () => {
    const { rerender } = render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/LIVE/)).toBeInTheDocument();
    rerender(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive={false}
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('HISTORICAL')).toBeInTheDocument();
  });

  it('renders the spot, predicted, and updated stats when present', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({ spot: 5800.42, predictedClose: 5810.18 })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('5800.42')).toBeInTheDocument();
    expect(screen.getByText('5810.18')).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it('de-emphasizes predicted close when confidence is low (rounded int + ~ prefix)', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({
          confidence: 'low',
          spot: 7120.12,
          predictedClose: 7125.18,
        })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    // Rounded to int + ~ prefix.
    expect(screen.getByText('~7125')).toBeInTheDocument();
    // Full-precision number from high-confidence rendering MUST NOT appear.
    expect(screen.queryByText('7125.18')).not.toBeInTheDocument();
    // Tooltip explains the de-emphasis. The tooltip lives on the
    // outer span — verify by querying the element with the title attribute.
    expect(
      document.querySelector('[title*="Confidence is LOW"]'),
    ).not.toBeNull();
  });

  it('also de-emphasizes predicted close when confidence is no_trade', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail({
          confidence: 'no_trade',
          spot: 7120,
          predictedClose: 7150,
        })}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('~7150')).toBeInTheDocument();
    expect(screen.queryByText('7150.00')).not.toBeInTheDocument();
  });

  it('renders the p25–p75 band when predictedCloseRange is present', () => {
    // A range overrides both the high-precision point AND the low-conf "~int".
    const detail: TraceLiveDetail = {
      ...makeDetail({
        confidence: 'low',
        spot: 7130.65,
        predictedClose: 7131,
      }),
      analysis: {
        timestamp: '14:52 CT',
        spot: 7130.65,
        stabilityPct: 23.83,
        regime: 'trending_negative_gamma',
        charm: {
          predominantColor: 'red',
          direction: 'short',
          junctionStrike: 7140,
          flipFlopDetected: false,
          rejectionWicksAtRed: true,
          notes: '',
        },
        gamma: {
          signAtSpot: 'negative_strong',
          dominantNodeStrike: 7140,
          dominantNodeMagnitudeB: 0.6,
          dominantNodeRatio: 3.4,
          floorStrike: null,
          ceilingStrike: 7140,
          overrideFires: false,
          notes: '',
        },
        delta: {
          blueBelowStrike: null,
          redAboveStrike: null,
          corridorWidth: null,
          zoneBehavior: 'acceleration',
          notes: '',
        },
        synthesis: {
          predictedClose: 7131,
          predictedCloseRange: { p25: 7115, p50: 7131, p75: 7150 },
          confidence: 'low',
          crossChartAgreement: 'mostly_agree',
          overrideApplied: false,
          trade: {
            type: 'flat',
            centerStrike: null,
            wingWidth: null,
            size: 'none',
          },
          headline: '−γ trending −2.76B',
          warnings: [],
        },
      },
    };
    render(
      <TRACELiveHeader
        detail={detail}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText('7115–7150')).toBeInTheDocument();
    expect(screen.getByText(/p50 7131/)).toBeInTheDocument();
    // Low-confidence "~" rendering is replaced by the range — verify it's gone.
    expect(screen.queryByText('~7131')).not.toBeInTheDocument();
  });

  it('renders the next-capture countdown when isLive AND countdown.label is set', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive
        countdown={{
          label: '8:32',
          secondsRemaining: 8 * 60 + 32,
          isOverdue: false,
          nextExpectedAt: null,
        }}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/Next/)).toBeInTheDocument();
    expect(screen.getByText('8:32')).toBeInTheDocument();
  });

  it('shows "Overdue" when the countdown is overdue', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive
        countdown={{
          label: '0:42',
          secondsRemaining: -42,
          isOverdue: true,
          nextExpectedAt: null,
        }}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });

  it('hides the countdown when not in live mode (historical replay)', () => {
    render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive={false}
        countdown={{
          label: '8:32',
          secondsRemaining: 512,
          isOverdue: false,
          nextExpectedAt: null,
        }}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByText('8:32')).not.toBeInTheDocument();
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(
      <TRACELiveHeader
        detail={makeDetail()}
        isLive
        countdown={idleCountdown}
        loading={false}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh TRACE Live' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
