/**
 * GreekHeatmapSection unit tests — covers the section header (price +
 * regime chips), ticker chip-grid interaction, loading/error/empty
 * states, and the wired-up sub-components (NetFlowRow + Table).
 *
 * The data hook is mocked so tests never touch fetch; sub-components
 * render with their real markup so the integration is meaningful.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type {
  GreekHeatmapResponse,
  GreekHeatmapTopStrike,
} from '../hooks/useGreekHeatmap';

const { mockUseGreekHeatmap, mockRefetch } = vi.hoisted(() => ({
  mockUseGreekHeatmap: vi.fn(),
  mockRefetch: vi.fn(),
}));

vi.mock('../hooks/useGreekHeatmap', () => ({
  useGreekHeatmap: mockUseGreekHeatmap,
}));

import { GreekHeatmapSection } from '../components/GreekHeatmap/GreekHeatmapSection';

function makeStrike(
  strike: number,
  netGamma: number,
  netCharm: number,
  netVanna: number,
): GreekHeatmapTopStrike {
  return {
    strike,
    callGammaOi: netGamma > 0 ? netGamma : 0,
    putGammaOi: netGamma < 0 ? netGamma : 0,
    netGamma,
    callCharmOi: netCharm,
    putCharmOi: 0,
    netCharm,
    callVannaOi: netVanna,
    putVannaOi: 0,
    netVanna,
  };
}

function makeData(
  overrides: Partial<GreekHeatmapResponse> = {},
): GreekHeatmapResponse {
  return {
    ticker: 'SPY',
    date: '2026-05-15',
    asOf: '2026-05-15T16:30:00Z',
    underlyingPrice: 562.5,
    atmStrike: 562.5,
    regime: 'Long Γ',
    netGexK: 1591.2,
    topStrikes: [
      makeStrike(560, 200_000, 5_000, 800),
      makeStrike(562.5, 100_000, 2_500, 400),
      makeStrike(565, 150_000, 3_000, 500),
      makeStrike(570, -50_000, -1_000, -200),
      makeStrike(555, 80_000, 1_500, 300),
    ],
    netFlow: {
      cumulativeCallPrem: 1716,
      cumulativeCallVol: 6,
      cumulativePutPrem: 1990,
      cumulativePutVol: 17,
      asOf: '2026-05-15T16:30:01Z',
    },
    ...overrides,
  };
}

describe('GreekHeatmapSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockUseGreekHeatmap.mockReturnValue({
      data: makeData(),
      loading: false,
      error: null,
      refetch: mockRefetch,
    });
  });

  it('renders the section title', () => {
    render(<GreekHeatmapSection marketOpen={false} />);
    expect(
      screen.getByRole('heading', { name: /0dte greek heatmap/i }),
    ).toBeInTheDocument();
  });

  it('shows the underlying price chip in the header', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    // Price chip is in the headerRight slot and renders even when
    // collapsed. Format is "SPY $562.50".
    expect(screen.getByText('$562.50')).toBeInTheDocument();
  });

  it('shows the Long Γ regime chip with magnitude', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText('Long Γ')).toBeInTheDocument();
    expect(screen.getByText('+1591.2k')).toBeInTheDocument();
  });

  it('renders the ticker chip grid with default SPY active when expanded', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const spyChip = screen.getByRole('radio', { name: 'SPY' });
    expect(spyChip).toHaveAttribute('aria-checked', 'true');
    const tslaChip = screen.getByRole('radio', { name: 'TSLA' });
    expect(tslaChip).toHaveAttribute('aria-checked', 'false');
  });

  it('switches the active ticker when a different chip is clicked', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const tslaChip = screen.getByRole('radio', { name: 'TSLA' });
    fireEvent.click(tslaChip);
    expect(tslaChip).toHaveAttribute('aria-checked', 'true');
    // Hook re-invoked with the new ticker on the next render pass.
    const lastCall = mockUseGreekHeatmap.mock.calls.at(-1)?.[0] as
      | { ticker: string }
      | undefined;
    expect(lastCall?.ticker).toBe('TSLA');
  });

  it('renders top-5 strikes and highlights the ATM row', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    // Each strike renders as a tabular row; the ATM badge is text "ATM".
    expect(screen.getByText('ATM')).toBeInTheDocument();
    expect(screen.getByText('562.5')).toBeInTheDocument();
    expect(screen.getByText('560')).toBeInTheDocument();
  });

  it('renders the net-flow row with NCP / NPP / Total labels', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText('NCP')).toBeInTheDocument();
    expect(screen.getByText('NPP')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('shows a loading message when data is null and loading is true', () => {
    mockUseGreekHeatmap.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refetch: mockRefetch,
    });
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(
      screen.getByText(/loading spy 0dte greek snapshot/i),
    ).toBeInTheDocument();
  });

  it('shows an error message and retry button when the hook errors', () => {
    mockUseGreekHeatmap.mockReturnValue({
      data: null,
      loading: false,
      error: 'HTTP 500',
      refetch: mockRefetch,
    });
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText(/failed to load heatmap/i)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-state hint when topStrikes is empty and asOf is null', () => {
    mockUseGreekHeatmap.mockReturnValue({
      data: makeData({ topStrikes: [], asOf: null, atmStrike: null }),
      loading: false,
      error: null,
      refetch: mockRefetch,
    });
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(
      screen.getByText(/no 0dte expiry data for spy today/i),
    ).toBeInTheDocument();
  });

  it('gates polling on marketOpen passed through to the hook', () => {
    render(<GreekHeatmapSection marketOpen={false} />);
    // Hook should have been invoked with enabled=false.
    const firstCall = mockUseGreekHeatmap.mock.calls[0]?.[0] as
      | { enabled: boolean }
      | undefined;
    expect(firstCall?.enabled).toBe(false);
  });
});
