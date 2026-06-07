import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockUseFlowRegime = vi.fn();
vi.mock('../../hooks/useFlowRegime', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useFlowRegime')
  >('../../hooks/useFlowRegime');
  return { ...actual, useFlowRegime: () => mockUseFlowRegime() };
});

import FlowRegimeBadge from '../../components/FlowRegimeBadge';
import {
  slotToEtLabel,
  describeRegime,
} from '../../components/FlowRegimeBadge/classify';
import type { FlowRegimeSnapshot } from '../../hooks/useFlowRegime';

const REFRESH = vi.fn();

function makeSnapshot(
  overrides: Partial<FlowRegimeSnapshot> = {},
): FlowRegimeSnapshot {
  return {
    date: '2026-06-06',
    slot: 2, // 10:30 ET
    computedAt: '2026-06-06T14:35:00Z',
    ndTilt: -0.42,
    idx0dtePutShare: 0.61,
    ndPercentile: 8,
    idxputPercentile: 94,
    regime: 'bearish',
    color: 'red',
    nTrades: 1200,
    baselineVersion: 1,
    ...overrides,
  };
}

function mockHook(
  latest: FlowRegimeSnapshot | null,
  overrides: Partial<{ loading: boolean; error: string | null }> = {},
) {
  mockUseFlowRegime.mockReturnValue({
    latest,
    date: latest?.date ?? null,
    loading: overrides.loading ?? false,
    error: overrides.error ?? null,
    refresh: REFRESH,
  });
}

beforeEach(() => {
  REFRESH.mockReset();
  mockUseFlowRegime.mockReset();
});

describe('slotToEtLabel', () => {
  it('maps slot indices to ET clock labels', () => {
    expect(slotToEtLabel(0)).toBe('09:30 ET');
    expect(slotToEtLabel(2)).toBe('10:30 ET');
    expect(slotToEtLabel(12)).toBe('15:30 ET');
  });
});

describe('describeRegime', () => {
  it('leads with put-share when it is the abnormal-high metric', () => {
    expect(describeRegime(makeSnapshot())).toMatch(
      /0DTE-index put flow at the 94th pct for 10:30 ET/,
    );
  });

  it('states the raw metric without a percentile claim when suppressed (low confidence)', () => {
    // After the evaluator-owns-the-floor fix, BOTH percentiles are null
    // whenever the read is suppressed (thin live bucket OR thin baseline), so
    // describeRegime keys off the null-percentile state and uses neutral copy
    // accurate for both reasons.
    const txt = describeRegime(
      makeSnapshot({
        ndPercentile: null,
        idxputPercentile: null,
        idx0dtePutShare: 0.4,
      }),
    );
    expect(txt).toMatch(/not enough data yet to read this slot/i);
    expect(txt).not.toMatch(/pct/);
  });
});

describe('FlowRegimeBadge', () => {
  // ── Loading ──────────────────────────────────────────────────
  it('renders a loading state with no data', () => {
    mockHook(null, { loading: true });
    render(<FlowRegimeBadge marketOpen={true} />);
    expect(screen.getByTestId('flow-regime-loading')).toHaveTextContent(
      /Loading/i,
    );
  });

  // ── Error ────────────────────────────────────────────────────
  it('renders an alert when fetch errors with no data', () => {
    mockHook(null, { error: 'HTTP 500' });
    render(<FlowRegimeBadge marketOpen={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });

  // ── Empty / pre-open ─────────────────────────────────────────
  it('renders the no-data message when latest is null', () => {
    mockHook(null);
    render(<FlowRegimeBadge marketOpen={false} />);
    expect(screen.getByTestId('flow-regime-empty')).toHaveTextContent(
      /No flow regime read yet/i,
    );
  });

  // ── Bearish / red ────────────────────────────────────────────
  it('renders the bearish regime with a non-predictive label + detail', () => {
    mockHook(makeSnapshot());
    render(<FlowRegimeBadge marketOpen={true} />);
    const badge = screen.getByRole('status');
    expect(screen.getByTestId('flow-regime-pill')).toHaveTextContent(
      'ABNORMAL BEARISH',
    );
    expect(screen.getByTestId('flow-regime-detail')).toHaveTextContent(
      /94th pct for 10:30 ET/,
    );
    // Recognition-not-forecast framing is exposed to AT + carries text
    // meaning independent of color.
    expect(badge).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/recognition, not a forecast/i),
    );
    expect(badge).toHaveAttribute(
      'title',
      expect.stringMatching(/does not predict direction/i),
    );
  });

  // ── Normal / gray (muted) ────────────────────────────────────
  it('renders the normal regime as a muted NORMAL pill', () => {
    mockHook(
      makeSnapshot({
        regime: 'normal',
        color: 'gray',
        ndPercentile: 50,
        idxputPercentile: 50,
      }),
    );
    render(<FlowRegimeBadge marketOpen={true} />);
    expect(screen.getByTestId('flow-regime-pill')).toHaveTextContent('NORMAL');
    expect(screen.getByTestId('flow-regime-detail')).toHaveTextContent(
      /tracking near its usual range/i,
    );
  });

  // ── Insufficient baseline (null percentiles) ─────────────────
  it('shows the metric without a percentile claim when baseline is thin', () => {
    mockHook(
      makeSnapshot({
        regime: 'normal',
        color: 'gray',
        ndPercentile: null,
        idxputPercentile: null,
        idx0dtePutShare: 0.4,
      }),
    );
    render(<FlowRegimeBadge marketOpen={true} />);
    const detail = screen.getByTestId('flow-regime-detail');
    expect(detail).toHaveTextContent(/not enough data yet to read this slot/i);
    expect(detail).not.toHaveTextContent(/pct\b/);
  });

  // ── A11y: role=status + aria-label present in every populated state ──
  it('exposes a role=status region with an aria-label', () => {
    mockHook(makeSnapshot());
    render(<FlowRegimeBadge marketOpen={true} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-label');
    expect(region.getAttribute('aria-label')).toMatch(/abnormal bearish/i);
  });
});
