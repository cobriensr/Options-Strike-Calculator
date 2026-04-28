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
