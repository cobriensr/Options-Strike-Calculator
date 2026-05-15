/**
 * GreekHeatmapSection unit tests — covers the rebuilt layout: ticker
 * dropdown, date picker, top-5 callout chips (with scroll-to-strike),
 * full-chain heatmap table with color-coded cells, and the
 * loading / error / empty states. The data hook is mocked so tests
 * never touch fetch; the rest of the sub-tree renders with real markup
 * so the integration stays meaningful.
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
  const topStrikes = [
    makeStrike(560, 200_000, 5_000, 800),
    makeStrike(562.5, 100_000, 2_500, 400),
    makeStrike(565, 150_000, 3_000, 500),
    makeStrike(570, -50_000, -1_000, -200),
    makeStrike(555, 80_000, 1_500, 300),
  ];
  return {
    ticker: 'SPY',
    date: '2026-05-15',
    at: null,
    asOf: '2026-05-15T16:30:00Z',
    underlyingPrice: 562.5,
    atmStrike: 562.5,
    regime: 'Long Γ',
    netGexK: 1591.2,
    chainStrikes: topStrikes,
    topStrikes,
    intradayRange: {
      min: '2026-05-15T13:30:00Z',
      max: '2026-05-15T16:30:00Z',
      count: 181,
    },
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

  it('shows the underlying price chip', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText('$562.50')).toBeInTheDocument();
  });

  it('shows the Long Γ regime chip with magnitude scaled to M/B', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText('Long Γ')).toBeInTheDocument();
    // netGexK = 1591.2 (thousands of dollars = $1.59M) renders as $1.6M.
    expect(screen.getByText('+$1.6M')).toBeInTheDocument();
  });

  it('renders the ticker dropdown with SPY selected by default', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const select = screen.getByLabelText(
      /heatmap ticker/i,
    ) as HTMLSelectElement;
    expect(select.value).toBe('SPY');
    // A few representative options should be present.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(
      expect.arrayContaining(['SPY', 'TSLA', 'NVDA']),
    );
  });

  it('switches the active ticker via the dropdown', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const select = screen.getByLabelText(
      /heatmap ticker/i,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'TSLA' } });
    expect(select.value).toBe('TSLA');
    const lastCall = mockUseGreekHeatmap.mock.calls.at(-1)?.[0] as
      | { ticker: string }
      | undefined;
    expect(lastCall?.ticker).toBe('TSLA');
  });

  it('renders the date picker bounded to the last 90 days', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const dateInput = screen.getByLabelText(
      /heatmap expiry date/i,
    ) as HTMLInputElement;
    expect(dateInput.type).toBe('date');
    expect(dateInput.min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dateInput.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('passes a historical date to the hook when the user picks one', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const dateInput = screen.getByLabelText(
      /heatmap expiry date/i,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-04-01' } });
    const lastCall = mockUseGreekHeatmap.mock.calls.at(-1)?.[0] as
      | { date?: string; enabled: boolean }
      | undefined;
    expect(lastCall?.date).toBe('2026-04-01');
    // Polling disabled when viewing a historical date.
    expect(lastCall?.enabled).toBe(false);
  });

  it('shows a Historical badge when not viewing today', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const dateInput = screen.getByLabelText(
      /heatmap expiry date/i,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-04-01' } });
    expect(screen.getByText(/historical/i)).toBeInTheDocument();
  });

  it('renders top-5 callout chips above the heatmap', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText(/top gex/i)).toBeInTheDocument();
    // Each chip has the strike value as a button label.
    expect(
      screen.getByRole('button', { name: /jump to strike 560/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /jump to strike 565/i }),
    ).toBeInTheDocument();
  });

  it('clicking a top-strikes chip highlights the corresponding heatmap row', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const chip = screen.getByRole('button', { name: /jump to strike 565/i });
    fireEvent.click(chip);
    const row = document.getElementById('heatmap-strike-565');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('ring-amber-400');
  });

  it('renders the full-chain heatmap rows with strike values', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    // ATM badge only appears in the heatmap table.
    expect(screen.getByText('ATM')).toBeInTheDocument();
    // Strike values appear in BOTH the callout chips AND the heatmap
    // rows — assert by row id to avoid ambiguity. Non-integer strikes
    // (e.g. 562.5) use `_` instead of `.` so the id is selector-safe.
    expect(document.getElementById('heatmap-strike-562_5')).not.toBeNull();
    expect(document.getElementById('heatmap-strike-560')).not.toBeNull();
    expect(document.getElementById('heatmap-strike-570')).not.toBeNull();
  });

  it('renders the net-flow row labels', () => {
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
      screen.getByText(/loading spy .* greek snapshot/i),
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
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('renders an empty-state hint when chainStrikes is empty and asOf is null', () => {
    mockUseGreekHeatmap.mockReturnValue({
      data: makeData({
        chainStrikes: [],
        topStrikes: [],
        asOf: null,
        atmStrike: null,
      }),
      loading: false,
      error: null,
      refetch: mockRefetch,
    });
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText(/no greek data for spy/i)).toBeInTheDocument();
  });

  it('gates polling on marketOpen + viewing-today', () => {
    render(<GreekHeatmapSection marketOpen={false} />);
    const firstCall = mockUseGreekHeatmap.mock.calls[0]?.[0] as
      | { enabled: boolean }
      | undefined;
    expect(firstCall?.enabled).toBe(false);
  });

  it('renders the minute scrubber in LIVE mode by default', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(
      screen.getByLabelText(/scrub to a past minute/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^live$/i)).toBeInTheDocument();
  });

  it('disables the scrubber when intradayRange.count <= 1', () => {
    mockUseGreekHeatmap.mockReturnValue({
      data: makeData({
        intradayRange: {
          min: '2026-05-15T20:00:00Z',
          max: '2026-05-15T20:00:00Z',
          count: 1,
        },
      }),
      loading: false,
      error: null,
      refetch: mockRefetch,
    });
    render(<GreekHeatmapSection marketOpen={true} />);
    expect(screen.getByText(/no intraday data/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/scrub to a past minute/i),
    ).not.toBeInTheDocument();
  });

  it('scrubbing to a past minute disables polling and passes `at` to the hook', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const slider = screen.getByLabelText(
      /scrub to a past minute/i,
    ) as HTMLInputElement;
    // Drag to the minimum (start of intraday range).
    fireEvent.change(slider, { target: { value: slider.min } });
    const lastCall = mockUseGreekHeatmap.mock.calls.at(-1)?.[0] as
      | { at?: string; enabled: boolean }
      | undefined;
    expect(lastCall?.at).toBe('2026-05-15T13:30:00.000Z');
    expect(lastCall?.enabled).toBe(false);
  });

  it('Jump to live button resets scrubbedAt to null', () => {
    render(<GreekHeatmapSection marketOpen={true} />);
    const slider = screen.getByLabelText(
      /scrub to a past minute/i,
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: slider.min } });
    const jumpBtn = screen.getByRole('button', { name: /jump to live/i });
    fireEvent.click(jumpBtn);
    const lastCall = mockUseGreekHeatmap.mock.calls.at(-1)?.[0] as
      | { at?: string }
      | undefined;
    expect(lastCall?.at).toBeUndefined();
  });
});
